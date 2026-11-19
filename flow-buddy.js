// Flow Buddy: a small mascot that reports what the queue is really doing.
// It only observes: control.js calls flowBuddy.queueChanged() from renderQueue() and
// flowBuddy.event(...) at a few real moments (images added, queue start, queue end).
// It never changes the queue, prompts, retries or tabs. Everything runs in this panel,
// so no extension messaging, polling loop, network call or permission is needed.
'use strict';

// ---------- brain: queue snapshots in, messages out (no DOM; unit-tested) ----------
const BUDDY_PLATFORM_NAMES = {flow: 'Flow', chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok'};

// Stage of a running prompt, read from the item.detail text the engines already show on its card.
function buddyStageOf(detail) {
  const text = String(detail || '').toLowerCase();
  if (!text) return 'start';
  if (/repair|needs prompt edit/.test(text)) return 'repair';
  if (/^(downloading|saving|upscaling)/.test(text)) return 'save';
  if (/^generating|confirming before download|image finished/.test(text)) return 'generate';
  if (/submitting|typing the prompt|submit button|checking the submitted prompt/.test(text)) return 'send';
  if (/upload|attach|reference|start frame|ingredient|media to prompt|restoring flow settings/.test(text)) return 'references';
  if (/^opening|creating flow project|setting up|switching flow|returning to flow|confirming flow composer|setting gemini|setting grok|waking/.test(text)) return 'open';
  return 'other';
}

// Friendly wording only where the real error supports it; otherwise point to Debug Logs.
// The prompt's reason code (lib/queue-reasons.js) comes first; the detail text is only read for an item without one.
const BUDDY_REASON_TEXT = {
  signed_out: () => 'Your session may have expired. Please sign in again!',
  usage_limit: name => `${name} reached a usage limit. Let's try again later.`,
  unusual_activity: name => `${name} reported unusual activity. Please check it manually.`,
  policy_refused: name => `${name} flagged this prompt. It needs a gentler wording.`,
  refused_twice: name => `${name} refused this exact prompt twice. It needs a gentler wording.`,
  sheet_refused: name => `${name} flagged the storyboard sheet, so I'm making single images instead.`,
  needs_edit: () => 'This prompt needs a manual edit before it can pass.',
  upload_failed: () => "An image upload didn't go through.",
  timed_out: name => `${name} took too long and the wait timed out.`,
  generation_failed: name => `${name} couldn't finish this one. Retry should help!`,
  save_failed: () => "It was made, but I couldn't save the file. Check your download folder, then Retry.",
  page_not_ready: name => `${name}'s page wasn't ready when I looked for it.`,
};
const BUDDY_TECHNICAL_REASONS = ['timed_out', 'page_not_ready', 'generation_failed', 'upload_failed'];
const BUDDY_REFUSED_REASONS = ['policy_refused', 'refused_twice', 'sheet_refused', 'needs_edit'];
function buddyExplainError(detail, platform, reason = null) {
  const text = String(detail || '');
  const name = BUDDY_PLATFORM_NAMES[platform] || 'The page';
  if (reason) return BUDDY_REASON_TEXT[reason] ? BUDDY_REASON_TEXT[reason](name) : null;
  if (/sign in|signed in|log ?in|session/i.test(text)) return 'Your session may have expired. Please sign in again!';
  if (/quota|usage limit|credit|limit reached/i.test(text)) return `${name} reached a usage limit. Let's try again later.`;
  if (/unusual activity/i.test(text)) return `${name} reported unusual activity. Please check it manually.`;
  if (/flagged|policy|refused|violat/i.test(text)) return `${name} flagged this prompt. It needs a gentler wording.`;
  if (/needs prompt edit|repair limit/i.test(text)) return 'This prompt needs a manual edit before it can pass.';
  if (/upload/i.test(text) && /fail|could not|did not|rejected/i.test(text)) return "An image upload didn't go through.";
  if (/timed out/i.test(text)) return `${name} took too long and the wait timed out.`;
  if (/generation failed|error on my side/i.test(text)) return `${name} couldn't finish this one. Retry should help!`;
  if (/not found|disappeared|not ready/i.test(text)) return `${name}'s page wasn't ready when I looked for it.`;
  return null;
}

// Rotating line for an activity that is still going (upload, generation or repair).
// Progress is quoted only when the prompt's own detail text contains it: "(2/5)" uploads, "42%" generation.
function buddyActivityLine(kind, tick, elapsedMs, detail, noun = 'image') {
  const text = String(detail || '');
  if (kind === 'repair') {
    const round = text.match(/repair (?:round )?(\d+)\s*\/\s*(\d+)/i);
    const suffix = round ? ` (round ${round[1]} of ${round[2]})` : '';
    const lines = ["I'm repairing your prompt... 🔧",
      'Still waiting for the repair response. 💜',
      'Your queue will continue when a valid revision is ready. 🤖',
      elapsedMs >= 60000 ? "Repair is taking a little longer. I'm still here. 💜" : "Repair is still running. I'll let you know when it finishes. 💜"];
    return lines[tick % lines.length] + suffix;
  }
  if (kind === 'upload') {
    const m = text.match(/\((\d+)\s*\/\s*(\d+)/);
    const done = m ? Number(m[1]) : null, total = m ? Number(m[2]) : null;
    const progress = total ? ` (${done} of ${total} ready)` : '';
    if (total > 1 && done === total - 1) return `Almost ready! ${done} of ${total} images uploaded 💜`;
    const lines = ['Your images are still uploading... 💜',
      elapsedMs >= 45000 ? "Taking a little longer, but I'm still here! 🤖" : 'Still uploading, hang tight! 📸'];
    return lines[tick % lines.length] + progress;
  }
  if (kind === 'generate') {
    const m = text.match(/(\d{1,3})\s*%/);
    const pct = m ? Number(m[1]) : null;
    if (pct !== null && pct >= 90 && pct < 100) return `Almost done! ✨ (${pct}%)`;
    const lines = [`Still generating your ${noun}! ✨`,
      elapsedMs >= 60000 ? "This one's taking a little longer! 💜" : 'Creating your masterpiece! 🎨',
      `I'm still watching your ${noun} generation! 🤖`];
    return lines[tick % lines.length] + (pct !== null && pct > 0 && pct < 100 ? ` (${pct}%)` : '');
  }
  return '';
}

function createBuddyBrain() {
  let items = new Map();         // id -> {status, stage, retryAt, repaired}
  let queueRef = null;
  let running = false;
  let lastIdleAt = 0;
  let openedThisRun = false;
  let repairNudgedThisRun = false;   // the refusal nudge: once per run
  let repairNudgedThisSession = false;   // the start nudge: once per panel session

  const counts = (snapshot) => {
    const c = {total: snapshot.items.length, done: 0, error: 0, running: 0, pending: 0, other: 0};
    for (const item of snapshot.items) {
      if (item.status === 'done') c.done++;
      else if (item.status === 'error') c.error++;
      else if (item.status === 'running') c.running++;
      else if (item.status === 'pending') c.pending++;
      else c.other++;           // skipped / combined: finished without own output
    }
    c.remaining = c.pending + c.running;
    return c;
  };

  const status = (snapshot) => {
    const c = counts(snapshot);
    const active = snapshot.items.filter(item => item.status === 'running');
    return {...c, platform: snapshot.platform, platformName: BUDDY_PLATFORM_NAMES[snapshot.platform] || 'Flow',
      noun: snapshot.noun, modeLabel: snapshot.modeLabel, running: snapshot.running,
      current: active.map(item => item.index), stage: active.length === 1 ? buddyStageOf(active[0].detail) : (active.length ? 'many' : null),
      stageText: active.length === 1 ? String(active[0].detail || '') : ''};
  };

  // Returns messages: {text, mood, priority (1 info, 2 milestone, 3 error), important}
  function observe(snapshot, now = Date.now()) {
    const out = [];
    const say = (text, mood, priority = 1, important = false, extra = {}) => out.push({text, mood, priority, important, ...extra});
    const c = counts(snapshot);
    const noun = snapshot.noun || 'image';
    const Noun = noun[0].toUpperCase() + noun.slice(1);

    // A new prompt list (array replaced while idle) restarts tracking; nothing stale carries over.
    if (snapshot.queueRef !== queueRef) {
      const fresh = queueRef !== null;
      queueRef = snapshot.queueRef;
      items = new Map(snapshot.items.map(item => [item.id, {status: item.status, stage: buddyStageOf(item.detail), retryAt: item.retryAt, repaired: buddyStageOf(item.detail) === 'repair'}]));
      if (fresh && !snapshot.running && c.total) say(`Got your ${c.total} prompt${c.total === 1 ? '' : 's'}! Let's make some magic! ✨`, 'success', 1);
      running = snapshot.running;
      return out;
    }

    if (snapshot.running && !running) { openedThisRun = false; repairNudgedThisRun = false; }   // a new run (Start or resume)
    for (const item of snapshot.items) {
      const before = items.get(item.id);
      const stage = item.status === 'running' ? buddyStageOf(item.detail) : null;
      const repaired = !!before?.repaired || stage === 'repair' || /repair \d+\/\d+ validated/i.test(item.detail || '');
      items.set(item.id, {status: item.status, stage, retryAt: item.retryAt, repaired});
      if (!before) continue;
      const label = `${noun} ${item.index} of ${c.total}`;
      if (item.status === 'done' && before.status !== 'done') {
        const left = c.remaining;
        // A little personality on long queues, folded into the same message so nothing extra pops up.
        const cheer = c.total >= 4 && left === 1 ? ' Almost there! 🎨'
          : c.total >= 6 && c.done === Math.ceil(c.total / 2) ? " Halfway there, you're doing great! 💜" : '';
        const opener = c.done > 1 && c.done % 3 === 2 ? `Yay! Another one finished! 🎉 ${Noun} ${item.index} is saved.` : `Woohoo! ${Noun} ${item.index} is done! 🎉`;
        say(`${opener}${left && !cheer ? ` ${left} left!` : ''}${cheer}`, repaired ? 'relieved' : 'success', 2);
      } else if (item.status === 'error' && before.status !== 'error') {
        const why = buddyExplainError(item.detail, snapshot.platform, item.reason);
        const technicalTrouble = item.reason ? BUDDY_TECHNICAL_REASONS.includes(item.reason)
          : /timed out|timeout|connection|not ready|not found|disappeared|error on my side|generation failed|upload.*(?:fail|did not|could not)/i.test(item.detail || '')
            && !/quota|usage limit|credit|policy|violat/i.test(item.detail || '');
        // A refusal while auto repair is off: say once per run that repair could fix it.
        const refused = item.reason ? BUDDY_REFUSED_REASONS.includes(item.reason)
          : !technicalTrouble && /policy rejection|needs prompt edit|flagged|refus|violat|safety filter|content polic/i.test(item.detail || '');
        const nudge = snapshot.repairEnabled === false && snapshot.remind !== false && refused && !repairNudgedThisRun;
        if (nudge) repairNudgedThisRun = true;
        say(`Oops! Prompt ${item.index} needs attention ⚠️${why ? ` ${why}` : ' Check the Debug tab for details.'}${nudge ? ' Auto-Fix is off — turn it on in the Auto-Fix tab, then press Retry and I will fix the wording for you. 🔧' : ''}`, technicalTrouble ? 'confused' : 'error', 3, true);
      } else if (item.status === 'pending' && before.status === 'running' && snapshot.running && !snapshot.stopRequested) {
        // Back to pending during a run = a retry or a repair was scheduled by the existing retry logic.
        if (/repair \d+\/\d+ validated/i.test(item.detail || '')) say(`Prompt ${item.index} repaired! Trying it again 🔧`, 'working', 2, true);
        else say(`Tiny hiccup on prompt ${item.index}! Trying again! 🔧`, 'concerned', 2, true);
      } else if (item.status === 'running' && before.status !== 'running') {
        // Said once per run, for the first prompt only (a retried prompt restarting is not "opening" again).
        if (!openedThisRun && c.running === 1 && !snapshot.items.some(other => other.status === 'done' || other.status === 'error')
          && snapshot.platform !== 'flow') { openedThisRun = true; say(`Opening ${BUDDY_PLATFORM_NAMES[snapshot.platform]} now! 🤖`, 'working', 1); }
        else say(`Starting ${label}! 🚀`, 'working', 1);
      } else if (item.status === 'running' && stage !== before.stage) {
        // Upload and generation messages stay up while that stage lasts (activity) and are refreshed by the UI.
        // "Images are ready" is said only when the engine moves past the reference stage, i.e. it confirmed them.
        const ready = before.stage === 'references' ? 'Yay! Your images are ready! ✨ ' : '';
        if (stage === 'references') say(/upload/i.test(item.detail || '') ? `Uploading your images for prompt ${item.index}! 📸` : `Matching your characters and locations for prompt ${item.index}! 🖼️`, 'uploading', 1, false, {activity: 'upload'});
        else if (stage === 'send') say(`${ready}Sending prompt ${item.index} of ${c.total}!`, ready ? 'success' : 'working', 1);
        else if (stage === 'generate') say(c.running > 1 ? `Creating ${c.running} ${noun}s at once... 🎨 ${c.done} of ${c.total} done.`
          // Reaching "generating" means the prompt was sent (ChatGPT and Gemini have no separate send step on the card).
          : before.stage === 'send' ? `Working on ${label}! Creating your masterpiece... 🎨` : `${ready}Prompt ${item.index} of ${c.total} sent! Creating your masterpiece... 🎨`, 'working', 1, false, {activity: 'generate'});
        else if (stage === 'repair') say(`Prompt ${item.index} was refused. Repairing the wording... 🔧`, 'thinking', 2, true, {activity: 'repair'});
        else if (stage === 'save') say(`Saving ${noun} ${item.index}! 💾`, 'working', 1);
      }
    }
    if (snapshot.running) running = true;
    if (!snapshot.running && running) { running = false; lastIdleAt = now; }
    return out;
  }

  function event(name, data = {}, snapshot = null) {
    const noun = snapshot?.noun || 'image';
    const plural = n => `${n} ${noun}${n === 1 ? '' : 's'}`;
    if (name === 'opened') return [{text: 'Hey! Ready to create something amazing? ✨', mood: 'idle', priority: 1, important: false}];
    if (name === 'images-added') return [{text: data.added === 1 ? 'Yay! Your reference image is ready! 📸' : `Yay! ${data.added} reference images are ready! 📸`, mood: 'uploading', priority: 1, important: false}];
    if (name === 'queue-start') {
      const c = snapshot ? counts(snapshot) : null;
      const platformName = BUDDY_PLATFORM_NAMES[data.platform] || 'Flow';
      const start = c && c.done > 0 && c.pending > 0
        ? {text: `Back to work! Resuming on ${platformName} with ${c.pending} left 💪`, mood: 'working', priority: 2, important: true}
        : {text: `Let's gooo! Starting your queue of ${data.total} prompt${data.total === 1 ? '' : 's'} on ${platformName}! 🚀`, mood: 'working', priority: 2, important: true};
      // Friendly reminder (once per panel session) when auto repair is off, so a refused prompt is not a surprise.
      if (data.repairEnabled === false && data.remind !== false && !repairNudgedThisSession) {
        repairNudgedThisSession = true;
        return [start, {text: 'Heads up! Auto-Fix is off 🔧 If a prompt gets refused, turn it on in the Auto-Fix tab and I will fix the wording for you.', mood: 'confused', priority: 2, important: true}];
      }
      return [start];
    }
    if (name === 'queue-end') {
      if (data.quota || /usage|quota|credit|limit/i.test(data.reason || '')) return [{text: `${data.reason && !data.quota ? `${data.reason}.` : 'Usage limit reached.'} I paused the queue. ${data.done} of ${data.total} done. ⚠️`, mood: 'error', priority: 3, important: true}];
      if (data.stopped) return [{text: `Taking a little break! ☕ ${data.done} of ${data.total} done.${data.reason ? ` ${data.reason}.` : ''}`, mood: 'paused', priority: 2, important: true}];
      if (data.total && data.done === data.total) return [{text: `We did it! All ${plural(data.total)} are done! 🎊`, mood: 'finished', priority: 2, important: true}];
      if (data.errors) return [{text: `Queue finished: ${data.done} done, ${data.errors} need${data.errors === 1 ? 's' : ''} attention. Check the cards or the Debug tab. ⚠️`, mood: 'error', priority: 3, important: true}];
      return [{text: `Queue finished: ${data.done} of ${data.total} done.`, mood: 'idle', priority: 2, important: true}];
    }
    return [];
  }

  return {observe, event, status, counts, get lastIdleAt() { return lastIdleAt; }};
}

if (typeof self !== 'undefined') self.FlowBuddyBrain = {createBuddyBrain, buddyStageOf, buddyExplainError, buddyActivityLine, buddySpriteFor, buddyAmbientAction};

// Quiet gestures never override a reaction, an open status card, or a paused queue.
function buddyAmbientAction(state, tick) {
  if (state.stopRequested || state.paused || state.moodHeld || state.cardOpen || state.action) return null;
  if (state.pose !== 'stand') return null;
  if (state.running) return state.stage === 'repair' ? 'ponder' : null;
  return tick % 2 ? 'stretch' : 'look';
}

// ---------- UI ----------
function buddyMobileDevice() {
  return typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
}
function buddyPrefsForDevice(stored) {
  return buddyMobileDevice() && !stored?.mobileOverlayDefaultsApplied
    ? {...stored, enabled:false, mobileOverlayDefaultsApplied:true} : stored || {};
}
const BUDDY_PREFS_KEY = 'flowBuddyPrefs';
const BUDDY_DEFAULT_PREFS = Object.freeze({enabled: !buddyMobileDevice(), bubbles: true, motion: 'normal', frequency: 'all', repairReminder: true});
const BUDDY_POSE_ORDER = ['stand', 'sit', 'lie', 'sleep'];
// One place for every timing (the preview shrinks these to check the sequence quickly).
// Activity messages are refreshed every activityMin..activityMin+activitySpread while the stage lasts;
// long uploads/generations sit, retry cooldowns lie down, a paused queue sits → lies → sleeps.
const BUDDY_TIMING = {activityMin: 15000, activitySpread: 15000, longUpload: 45000, longGenerate: 60000,
  retryLie: 20000, pauseLie: 30000, pauseSleep: 75000};

// Flow Buddy artwork: the Cute Cat Robot, one transparent sprite per drawing (assets/flow-buddy/*.webp,
// cut from the sticker sheet, plus three matching reaction sprites). All fifteen sit stacked in the mascot button; the one that matches the real
// situation fades in. Heights are relative to the tallest drawing so every pose keeps one shared scale.
const BUDDY_SPRITES = {idle: 180, sit: 173, lie: 155, sleep: 141, jump: 168, stretch: 167, look: 168, dance: 168,
  working: 155, uploading: 180, waiting: 128, error: 151, thinking: 180, confused: 180, relieved: 180};
const BUDDY_ACTION_SPRITES = ['jump', 'stretch', 'look', 'dance'];
const BUDDY_ART = `<span class="fb-aura" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></span><span class="fb-stage" aria-hidden="true">${Object.entries(BUDDY_SPRITES).map(([name, height]) =>
  `<img class="fb-sp" data-sprite="${name}" style="height:${(height / 180 * 100).toFixed(1)}%" src="assets/flow-buddy/${name}.webp" alt="" draggable="false">`).join('')}<span class="fb-idle-film"></span><span class="fb-working-film"></span><span class="fb-look-film"></span><span class="fb-sit-film"></span><span class="fb-sleep-film"></span><span class="fb-lie-film"></span><span class="fb-thinking-film"></span></span>`;

// Which drawing shows: a one-shot action wins, then the expression for an error/success, then the resting
// posture, then what the queue is doing. (Pure function of the root's mood/pose/action attributes.)
function buddySpriteFor(mood, pose, action) {
  if (action === 'ponder' && mood === 'thinking') return 'thinking';
  if (BUDDY_ACTION_SPRITES.includes(action)) return action;
  if (mood === 'error') return 'error';
  if (mood === 'confused' || mood === 'concerned') return 'confused';
  if (mood === 'thinking') return 'thinking';
  if (mood === 'relieved') return 'relieved';
  if (mood === 'success') return 'jump';
  if (mood === 'finished') return 'dance';
  if (pose === 'sit' || pose === 'lie' || pose === 'sleep') return pose;
  if (mood === 'uploading' || mood === 'working' || mood === 'waiting') return mood;
  return mood === 'paused' ? 'sit' : 'idle';
}

function initFlowBuddy() {
  if (typeof document === 'undefined' || !document.body || document.getElementById('flowBuddy')) return null;
  const brain = createBuddyBrain();
  let prefs = {...BUDDY_DEFAULT_PREFS};
  let latest = null;            // latest message shown (or suppressed while hidden)
  let latestImportant = null;   // latest error / milestone, reopened by a click
  let shownAt = 0, shownPriority = 0, hideTimer = null, typingTimer = null, moodTimer = null;
  let deferred = null, deferTimer = null;
  let activity = {key: '', kind: null, since: 0, tick: 0}, activityTimer = null, stickyShown = false, minimizedKey = '';
  let pose = 'stand', poseTarget = 'stand', poseTimer = null, poseQuick = false, actionTimer = null, bodyTimer = null;
  let pausedAt = 0, retryWaitSince = 0;
  let ambientTimer = null, ambientTick = 0;
  let recent = new Map();       // text -> time, to avoid repeats
  let baseMood = 'idle';
  let cardOpen = false;
  let dodgeFrame = 0;
  let repairOn = null;          // auto repair switch from storage (null = not known yet: no reminders)

  const root = document.createElement('div');
  root.hidden = !prefs.enabled;
  root.id = 'flowBuddy';
  root.dataset.mood = 'idle';
  root.dataset.pose = 'stand';
  root.innerHTML = `
    <div class="fb-bubble" role="status" aria-live="polite" hidden>
      <div class="fb-bubble-text"></div>
      <div class="fb-typing" aria-hidden="true"><i></i><i></i><i></i></div>
      <button type="button" class="fb-close" aria-label="Hide Flow Buddy message" title="Hide message">×</button>
    </div>
    <div class="fb-card" role="dialog" aria-label="Flow Buddy queue status" hidden></div>
    <button type="button" class="fb-mascot" aria-label="Flow Buddy: show status" title="Flow Buddy">${buddyMobileDevice() ? '' : BUDDY_ART}</button>`;
  document.body.append(root);
  // Mobile defaults hide Buddy: do not fetch/decode its artwork until the owner enables it.
  let artLoaded = !buddyMobileDevice(), framesLoaded = false;
  function loadBuddyArt() {
    if (!artLoaded) { root.querySelector('.fb-mascot').innerHTML = BUDDY_ART; artLoaded = true; }
    if (framesLoaded || (buddyMobileDevice() && prefs.motion !== 'normal')) return;
    framesLoaded = true;
    // Keep the static idle sprite until the local animation sheet has loaded successfully.
    for (const name of ['idle', 'working', 'look', 'sit', 'sleep', 'lie', 'thinking']) {
      const frames = new Image();
      frames.onload = () => root.classList.add(`fb-${name}-ready`);
      frames.src = `assets/flow-buddy/${name}-frames.webp`;
    }
  }
  if (!buddyMobileDevice()) loadBuddyArt();
  const syncSprite = () => { const next = buddySpriteFor(root.dataset.mood, root.dataset.pose, root.dataset.action); if (root.dataset.sprite !== next) root.dataset.sprite = next; };
  new MutationObserver(syncSprite).observe(root, {attributes: true, attributeFilter: ['data-mood', 'data-pose', 'data-action']});
  syncSprite();
  const bubble = root.querySelector('.fb-bubble'), bubbleText = root.querySelector('.fb-bubble-text');
  const card = root.querySelector('.fb-card'), mascot = root.querySelector('.fb-mascot');

  const snapshot = () => {
    const mode = typeof MODES !== 'undefined' && typeof settings !== 'undefined' ? MODES[settings.mode] : null;
    return {queueRef: typeof queue !== 'undefined' ? queue : [], running: typeof running !== 'undefined' && running,
      stopRequested: typeof stopRequested !== 'undefined' && stopRequested,
      platform: (typeof settings !== 'undefined' && settings.platform) || 'flow', repairEnabled: repairOn, remind: prefs.repairReminder,
      noun: mode?.resultKind === 'video' ? 'video' : 'image', modeLabel: mode?.label || '',
      items: (typeof queue !== 'undefined' ? queue : []).map(item => ({id: item.id, index: item.index, status: item.status, detail: item.detail, retryAt: item.retryAt,
        reason: globalThis.QueueReasons?.queueReason(item) || null}))};
  };

  let moodHeld = false;
  function setMood(mood, holdMs = 0) {
    clearTimeout(moodTimer);
    root.dataset.mood = mood;
    moodHeld = holdMs > 0;
    if (holdMs) moodTimer = setTimeout(() => { moodHeld = false; settleBody(); }, holdMs);
  }
  // ---------- body: posture (stand/sit/lie/sleep) and one-shot actions (jump/stretch/look/dance) ----------
  // Postures change one step at a time (stand → sit → lie → sleep and back) so it never snaps; CSS eases each step.
  function stepPose() {
    clearTimeout(poseTimer); poseTimer = null;
    if (pose === poseTarget) return;
    const from = BUDDY_POSE_ORDER.indexOf(pose), to = BUDDY_POSE_ORDER.indexOf(poseTarget);
    pose = BUDDY_POSE_ORDER[from + Math.sign(to - from)];
    root.dataset.pose = pose;
    if (pose !== poseTarget) poseTimer = setTimeout(stepPose, prefs.motion === 'off' ? 0 : poseQuick ? 260 : 700);
  }
  function setPose(target, {quick = false} = {}) {
    poseTarget = target; poseQuick = quick;
    if (quick || !poseTimer) stepPose();
  }
  function stepsToStand() { return BUDDY_POSE_ORDER.indexOf(pose); }
  function playAction(name, ms, {standFirst = false} = {}) {
    if (prefs.motion === 'off') return;
    const start = () => {
      clearTimeout(actionTimer);
      delete root.dataset.action; void root.offsetWidth;    // restart the animation if it is already playing
      root.dataset.action = name;
      actionTimer = setTimeout(() => { delete root.dataset.action; }, ms);
    };
    if (standFirst && pose !== 'stand') { const steps = stepsToStand(); setPose('stand', {quick: true}); setTimeout(start, steps * 260 + 120); }
    else start();
  }

  function scheduleAmbient(delay = 18000 + Math.random() * 14000) {
    clearTimeout(ambientTimer); ambientTimer = null;
    if (!prefs.enabled || prefs.motion !== 'normal' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ambientTimer = setTimeout(() => {
      if (!document.hidden) {
        const snap = snapshot();
        const action = buddyAmbientAction({running: snap.running, stopRequested: snap.stopRequested,
          stage: brain.status(snap).stage, pose, paused: !!pausedAt, moodHeld, cardOpen, action: root.dataset.action}, ambientTick);
        if (action) {
          ambientTick++; playAction(action, action === 'ponder' ? 3600 : action === 'stretch' ? 2000 : 2400);
        }
      }
      scheduleAmbient();
    }, delay);
  }

  // Posture and base expression from the real situation (queue state, current stage, how long it has lasted).
  function situation(now = Date.now()) {
    const snap = snapshot();
    const s = brain.status(snap);
    if (!snap.running) {
      if (pausedAt) { const t = now - pausedAt; return {pose: t >= BUDDY_TIMING.pauseSleep ? 'sleep' : t >= BUDDY_TIMING.pauseLie ? 'lie' : 'sit', mood: 'paused'}; }
      return {pose: 'stand', mood: 'idle'};
    }
    if (!s.current.length) {
      // Between prompts during a run: a retry cooldown set by the existing retry logic.
      const waiting = snap.items.some(item => item.status === 'pending' && Number.isFinite(item.retryAt) && item.retryAt > now);
      if (waiting) { retryWaitSince ||= now; return {pose: now - retryWaitSince >= BUDDY_TIMING.retryLie ? 'lie' : 'sit', mood: 'waiting'}; }
      retryWaitSince = 0;
      return {pose: 'stand', mood: 'working'};
    }
    retryWaitSince = 0;
    if (activity.kind === 'upload') return now - activity.since >= BUDDY_TIMING.longUpload ? {pose: 'sit', mood: 'idle'} : {pose: 'stand', mood: 'uploading'};
    if (activity.kind === 'generate') return {pose: now - activity.since >= BUDDY_TIMING.longGenerate ? 'sit' : 'stand', mood: 'working'};
    return {pose: 'stand', mood: s.stage === 'repair' ? 'thinking' : 'working'};
  }
  // The next moment the posture could change (pause → lie → sleep, long stage → sit): one timer, no polling.
  function nextBodyCheck(now = Date.now()) {
    const at = [];
    if (!snapshot().running && pausedAt) at.push(pausedAt + BUDDY_TIMING.pauseLie, pausedAt + BUDDY_TIMING.pauseSleep);
    if (retryWaitSince) at.push(retryWaitSince + BUDDY_TIMING.retryLie);
    if (activity.kind === 'upload') at.push(activity.since + BUDDY_TIMING.longUpload);
    if (activity.kind === 'generate') at.push(activity.since + BUDDY_TIMING.longGenerate);
    const future = at.filter(t => t > now);
    return future.length ? Math.min(...future) - now + 60 : 0;
  }
  function settleBody() {
    const look = situation();
    baseMood = look.mood;
    // A short reaction (bounce, shake, jump) plays out before the base expression returns.
    if (!moodHeld) root.dataset.mood = baseMood;
    // Getting back to work (a prompt is running again) stands up quickly; resting postures settle slowly.
    if (!moodHeld) setPose(look.pose, {quick: look.pose === 'stand' && brain.status(snapshot()).current.length > 0});
    clearTimeout(bodyTimer);
    const wait = nextBodyCheck();
    if (wait) bodyTimer = setTimeout(settleBody, wait);
  }

  // ---------- activity messages: stay up while the real stage lasts, refreshed every 15–30 s ----------
  function currentActivity() {
    const snap = snapshot();
    const s = brain.status(snap);
    const kind = !snap.running || snap.stopRequested ? null : s.stage === 'repair' ? 'repair' : s.stage === 'references' ? 'upload' : (s.stage === 'generate' || s.stage === 'many') ? 'generate' : null;
    return {kind, key: kind ? `${s.current.join(',')}:${kind}` : '', s};
  }
  function trackActivity() {
    const now = currentActivity();
    if (now.key === activity.key) return;
    if (root.dataset.action === 'ponder') { clearTimeout(actionTimer); delete root.dataset.action; }
    clearTimeout(activityTimer);
    activity = {key: now.key, kind: now.kind, since: Date.now(), tick: 0};
    // The stage ended (finished, failed, cancelled or moved on): its standing message goes too.
    if (stickyShown) { stickyShown = false; clearTimeout(hideTimer); hideTimer = setTimeout(hideBubble, 1500); }
    if (now.kind) activityTimer = setTimeout(activityTick, BUDDY_TIMING.activityMin + Math.random() * BUDDY_TIMING.activitySpread);
  }
  function activityTick() {
    const now = currentActivity();
    if (!now.kind || now.key !== activity.key) { trackActivity(); return; }
    const line = buddyActivityLine(activity.kind, activity.tick++, Date.now() - activity.since, now.s.stageText, now.s.noun);
    const text = now.s.stage === 'many' ? `${line} ${now.s.done} of ${now.s.total} done.` : line;
    if (minimizedKey !== activity.key) deliver([{text, priority: 1, important: false, activity: activity.kind}]);
    // A little life while waiting: look around, and stretch now and then once sitting.
    if (activity.kind !== 'repair') {
      if (pose === 'sit') playAction(activity.tick % 2 ? 'stretch' : 'look', activity.tick % 2 ? 1700 : 2500);
      else playAction('look', 2500);
    }
    settleBody();
    activityTimer = setTimeout(activityTick, BUDDY_TIMING.activityMin + Math.random() * BUDDY_TIMING.activitySpread);
  }

  function hideBubble() {
    clearTimeout(hideTimer); clearTimeout(typingTimer);
    bubble.classList.remove('fb-show');
    hideTimer = setTimeout(() => { bubble.hidden = true; }, 220);
    shownPriority = 0;
  }
  function showText(message, {typing = true} = {}) {
    if (!prefs.enabled) return;
    clearTimeout(hideTimer); clearTimeout(typingTimer);
    card.hidden = true; cardOpen = false;
    if (!prefs.bubbles) return;
    bubble.hidden = false;
    bubble.dataset.kind = message.priority >= 3 ? 'error' : ['finished', 'success', 'relieved'].includes(message.mood) ? 'success' : 'info';
    requestAnimationFrame(() => bubble.classList.add('fb-show'));
    shownAt = Date.now(); shownPriority = message.priority;   // holds its place while the typing dots show
    const messageActivityKey = activity.key;
    const reveal = () => {
      if (message.activity && currentActivity().key !== messageActivityKey) { hideBubble(); return; }
      bubble.classList.remove('fb-typing-on');
      bubbleText.textContent = message.text;
      shownAt = Date.now();
      // An activity message stays while that upload/generation is still running; trackActivity() removes it.
      stickyShown = !!message.activity && !!activity.kind;
      if (!stickyShown) hideTimer = setTimeout(hideBubble, message.priority >= 3 ? 9000 : 5200);
      scheduleDodge();
    };
    if (typing && prefs.motion !== 'off' && message.priority < 3) {
      bubble.classList.add('fb-typing-on'); bubbleText.textContent = '';
      typingTimer = setTimeout(reveal, 450);
    } else reveal();
  }

  // Important moments interrupt any resting posture at once (the message is never delayed by an animation).
  function reactWithBody(message) {
    if (message.priority >= 2) { clearTimeout(actionTimer); delete root.dataset.action; }
    if (message.mood === 'finished') { setPose('stand', {quick: true}); playAction('dance', 3200, {standFirst: true}); return; }
    if (['error', 'concerned', 'confused', 'thinking', 'relieved'].includes(message.mood)) { setPose('stand', {quick: true}); return; }
    if (message.mood === 'success' && message.priority >= 2) { setPose('stand', {quick: true}); playAction('jump', 950, {standFirst: true}); return; }
    if (message.priority >= 2 && message.mood !== 'paused') setPose('stand', {quick: true});
  }

  function deliver(messages) {
    for (const message of messages) {
      if (message.priority >= 2) latestImportant = message;
      if (!message.deferredOnce) latest = message;
      if (!message.deferredOnce) reactWithBody(message);
      if (message.mood && !message.deferredOnce) setMood(message.mood, ['success', 'relieved', 'confused', 'error', 'finished', 'concerned', 'paused', 'uploading'].includes(message.mood) ? (message.mood === 'finished' ? 3200 : message.mood === 'paused' ? 0 : 2400) : 0);
      if (message.mood === 'paused') baseMood = 'paused';
      if (prefs.frequency === 'important' && !message.important) continue;
      const now = Date.now();
      if (now - (recent.get(message.text) || 0) < 20000) continue;   // never the same line twice in a row
      // Errors stay up; an ordinary update waits (only the newest one is kept) instead of covering them.
      // Every message stays readable for a moment; errors and milestones stay longer.
      const holdLeft = (shownPriority >= 3 ? 9000 : shownPriority >= 2 ? 2500 : 1600) - (now - shownAt);
      if (!bubble.hidden && shownPriority >= message.priority && message.priority < 3 && holdLeft > 0) {
        // Keep the most important waiting message; a routine update never pushes out a milestone.
        if (deferred && deferred.priority > message.priority) continue;
        deferred = {...message, waitedFor: activity.key};
        clearTimeout(deferTimer);
        deferTimer = setTimeout(() => {
          const next = deferred; deferred = null;
          // A waiting stage message is dropped if that stage already ended or Stop was pressed meanwhile.
          const snap = snapshot();
          if (!next || snap.stopRequested || (next.activity && next.waitedFor !== currentActivity().key)) return;
          deliver([{...next, deferredOnce: true}]);
        }, holdLeft + 50);
        continue;
      }
      recent.set(message.text, now);
      if (recent.size > 60) recent = new Map([...recent].slice(-30));
      showText(message);
    }
  }

  function renderCard() {
    const snap = snapshot();
    const s = brain.status(snap);
    const stageNames = {start: 'Starting', open: `Opening ${s.platformName}`, references: 'Adding references', send: 'Sending the prompt',
      generate: `Generating in ${s.platformName}`, repair: 'Repairing a refused prompt', save: 'Saving the result', many: `${s.current.length} prompts in progress`, other: 'Working'};
    const pct = s.total ? Math.round((s.done + s.error + s.other) / s.total * 100) : 0;
    const rows = [
      ['Platform', s.platformName],
      ['Mode', s.modeLabel || '—'],
      ['Progress', s.total ? `${s.done} of ${s.total} done · ${pct}%` : 'No prompts loaded'],
      ['Now', snap.running ? (s.current.length ? `Prompt ${s.current.join(', ')} · ${stageNames[s.stage] || 'Working'}` : 'Waiting for the next prompt') : 'Idle'],
      ['Remaining', String(s.remaining)],
      ['Failed', String(s.error)],
    ];
    card.textContent = '';
    const head = document.createElement('div'); head.className = 'fb-card-head';
    head.textContent = snap.running ? 'Queue status' : latest ? 'Latest from Flow Buddy' : 'Flow Buddy';
    card.append(head);
    if (!snap.running && latest) { const p = document.createElement('p'); p.className = 'fb-card-msg'; p.textContent = (latestImportant || latest).text; card.append(p); }
    const list = document.createElement('dl');
    for (const [label, value] of rows) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value; list.append(dt, dd); }
    card.append(list);
    if (snap.running && s.stageText) { const p = document.createElement('p'); p.className = 'fb-card-detail'; p.textContent = s.stageText.slice(0, 140); card.append(p); }
    const bar = document.createElement('div'); bar.className = 'fb-card-bar'; bar.innerHTML = '<i></i>'; bar.firstChild.style.width = `${pct}%`;
    card.append(bar);
  }

  mascot.addEventListener('click', () => {
    if (cardOpen) { card.hidden = true; cardOpen = false; return; }
    hideBubble();
    renderCard();
    card.hidden = false; cardOpen = true;
    setMood(root.dataset.mood === 'error' ? 'error' : 'success', 900);
    scheduleDodge();
  });
  // Minimizing hides the bubble; refreshes of the same activity stay quiet until the next real change.
  bubble.querySelector('.fb-close').addEventListener('click', () => { if (stickyShown) minimizedKey = activity.key; stickyShown = false; hideBubble(); });
  const onKey = event => { if (event.key === 'Escape' && cardOpen) { card.hidden = true; cardOpen = false; } };
  document.addEventListener('keydown', onKey);

  // Keep clear of controls: if a button or field sits under the mascot, move to the other corner,
  // and if both corners are busy, fade out and let clicks pass through. Runs on scroll/resize only.
  const interactive = 'button,input,select,textarea,a[href],summary,[role="button"],[role="tab"],label';
  function blockedAt(side) {
    const rect = mascot.getBoundingClientRect();
    if (!rect.width) return false;
    const width = rect.width, left = side === 'left' ? 10 : window.innerWidth - 10 - width;
    for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.55], [0.35, 0.8], [0.65, 0.8]]) {
      const hits = document.elementsFromPoint(left + width * fx, rect.top + rect.height * fy);
      if (hits.some(el => !root.contains(el) && el.closest?.(interactive))) return true;
    }
    return false;
  }
  function dodge() {
    dodgeFrame = 0;
    if (!prefs.enabled) return;
    root.classList.remove('fb-faded');
    const preferRight = !blockedAt('right');
    if (preferRight) { root.classList.remove('fb-left'); return; }
    if (!blockedAt('left')) { root.classList.add('fb-left'); return; }
    root.classList.remove('fb-left');
    if (!cardOpen) root.classList.add('fb-faded');
  }
  function scheduleDodge() { if (!dodgeFrame) dodgeFrame = requestAnimationFrame(dodge); }
  window.addEventListener('scroll', scheduleDodge, {passive: true});
  window.addEventListener('resize', scheduleDodge, {passive: true});
  document.addEventListener('click', scheduleDodge, true);

  function applyPrefs() {
    if (prefs.enabled) loadBuddyArt();
    root.hidden = !prefs.enabled;
    document.body.classList.toggle('fb-on', !!prefs.enabled);
    root.dataset.motion = prefs.motion;
    scheduleAmbient();
    if (prefs.motion !== 'normal') { clearTimeout(actionTimer); delete root.dataset.action; }
    if (!prefs.bubbles) hideBubble();
    for (const [id, value] of [['buddyEnabled', prefs.enabled], ['buddyBubbles', prefs.bubbles], ['buddyRepairReminder', prefs.repairReminder]]) { const el = document.getElementById(id); if (el) el.checked = !!value; }
    for (const [id, value] of [['buddyMotion', prefs.motion], ['buddyFrequency', prefs.frequency]]) { const el = document.getElementById(id); if (el) el.value = value; }
    scheduleDodge();
  }
  async function savePrefs() {
    try { await chrome.storage.local.set({[BUDDY_PREFS_KEY]: prefs}); } catch {}
    const status = document.getElementById('buddySaveStatus');
    if (status) { status.textContent = 'Saved'; setTimeout(() => { status.textContent = ''; }, 1500); }
  }
  const sanitize = value => ({
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : BUDDY_DEFAULT_PREFS.enabled, bubbles: value?.bubbles !== false,
    ...((value?.mobileOverlayDefaultsApplied || prefs.mobileOverlayDefaultsApplied) ? {mobileOverlayDefaultsApplied:true} : {}),
    motion: ['normal', 'low', 'off'].includes(value?.motion) ? value.motion : 'normal',
    frequency: ['important', 'all'].includes(value?.frequency) ? value.frequency : 'all', repairReminder: value?.repairReminder !== false});
  const controls = ['buddyEnabled', 'buddyBubbles', 'buddyRepairReminder', 'buddyMotion', 'buddyFrequency'].map(id => document.getElementById(id)).filter(Boolean);
  for (const control of controls) control.addEventListener('change', () => {
    prefs = sanitize({enabled: document.getElementById('buddyEnabled')?.checked, bubbles: document.getElementById('buddyBubbles')?.checked, repairReminder: document.getElementById('buddyRepairReminder')?.checked,
      motion: document.getElementById('buddyMotion')?.value, frequency: document.getElementById('buddyFrequency')?.value});
    applyPrefs(); savePrefs();
    if (prefs.enabled) deliver([{text: 'Flow Buddy settings saved! 💜', mood: 'success', priority: 1, important: true}]);
  });
  // renderQueue() disables every Settings control during a run; the buddy's own switches stay usable.
  const keepControlsEnabled = () => { for (const control of controls) control.disabled = false; };

  const api = {
    queueChanged() {
      if (!prefs.enabled) { brain.observe(snapshot()); return; }
      if (snapshot().stopRequested) { deferred = null; clearTimeout(deferTimer); }   // nothing stale after Stop
      trackActivity();                       // first, so a new stage's message becomes the standing one
      deliver(brain.observe(snapshot()));
      settleBody();
      if (cardOpen) renderCard();
      queueMicrotask(keepControlsEnabled);
    },
    event(name, data = {}) {
      const snap = snapshot();
      // A start or end summary replaces anything still waiting, so it is never followed by an older update.
      if (name === 'queue-start' || name === 'queue-end') { deferred = null; clearTimeout(deferTimer); }
      if (name === 'queue-end') { pausedAt = data.stopped ? Date.now() : 0; trackActivity(); }
      if (name === 'queue-start') {
        const wasResting = pose !== 'stand';
        pausedAt = 0; minimizedKey = '';
        // Resume: wake up, stand, stretch, back to work.
        if (wasResting) playAction('stretch', 1700, {standFirst: true});
      }
      if (prefs.enabled) deliver(brain.event(name, {...data, repairEnabled: repairOn, remind: prefs.repairReminder}, snap));
      settleBody();
      if (cardOpen) renderCard();
    },
    status: () => brain.status(snapshot()),
  };

  const cleanup = () => {
    clearTimeout(hideTimer); clearTimeout(typingTimer); clearTimeout(moodTimer); clearTimeout(deferTimer);
    clearTimeout(activityTimer); clearTimeout(poseTimer); clearTimeout(actionTimer); clearTimeout(bodyTimer);
    clearTimeout(ambientTimer);
    if (dodgeFrame) cancelAnimationFrame(dodgeFrame);
    window.removeEventListener('scroll', scheduleDodge); window.removeEventListener('resize', scheduleDodge);
    document.removeEventListener('click', scheduleDodge, true); document.removeEventListener('keydown', onKey);
  };
  window.addEventListener('pagehide', cleanup, {once: true});

  (async () => {
    try {
      const stored = (await chrome.storage.local.get(BUDDY_PREFS_KEY))[BUDDY_PREFS_KEY];
      prefs = sanitize(buddyPrefsForDevice(stored));
      if (buddyMobileDevice() && !stored?.mobileOverlayDefaultsApplied) await chrome.storage.local.set({[BUDDY_PREFS_KEY]:prefs});
    } catch {}

    try {
      repairOn = !!(await chrome.storage.local.get('repairEnabled')).repairEnabled;
      chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.repairEnabled) repairOn = !!changes.repairEnabled.newValue; });
    } catch {}
    applyPrefs();
    brain.observe(snapshot());   // baseline: the panel opens with a fresh session, never a previous queue
    if (prefs.enabled) setTimeout(() => deliver(brain.event('opened')), 600);
  })();
  return api;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') window.flowBuddy = initFlowBuddy();
