// Repair is opt-in and never changes source project files.
// v1.8.0: the repair companion is a Chrome NATIVE MESSAGING host - Chrome starts it by itself when a prompt is refused and closes
// it afterwards (no terminal, no background process, no pairing token). Install it once per PC with "Install Repair.cmd".
// The old local helper (127.0.0.1:8766 + pairing token) still works as a developer fallback.
const REPAIR_HOST = 'com.flowstudio.repair_helper';
const REPAIR_PROTOCOL = 4;
const REPAIR_RECOMMENDED_VERSION = '1.10.11';
let repairUpdateInfo = null;
function companionUpdateInfo(info) {
  const version = typeof info?.version === 'string' ? info.version : '';
  const parts = /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : null;
  const target = REPAIR_RECOMMENDED_VERSION.split('.').map(Number);
  const older = parts && (parts[0] < target[0] || (parts[0] === target[0] && (parts[1] < target[1] || (parts[1] === target[1] && parts[2] < target[2]))));
  return {installed:version || 'Unknown', recommended:REPAIR_RECOMMENDED_VERSION, required:info?.protocol !== REPAIR_PROTOCOL, available:!!older || info?.protocol !== REPAIR_PROTOCOL};
}
function observeCompanionVersion(info) {
  repairUpdateInfo = companionUpdateInfo(info);
  if (typeof document === 'undefined') return;
  const box = document.getElementById('repairUpdateNotice');
  if (!box) return;
  box.classList.toggle('hidden', !repairUpdateInfo.available);
  document.getElementById('repairUpdateTitle').textContent = repairUpdateInfo.required ? 'Repair companion update required' : 'Repair companion update available';
  document.getElementById('repairUpdateVersions').textContent = 'Installed: ' + repairUpdateInfo.installed + ' · Recommended: v' + REPAIR_RECOMMENDED_VERSION;
  document.getElementById('repairUpdateCompatibility').textContent = repairUpdateInfo.required ? 'Repair is unavailable until a compatible companion is installed. Normal generation remains available.' : 'Your companion can still run repairs, but newer fixes are available.';
}
const sleepRepair = (ms) => new Promise((r) => setTimeout(r, ms));
let repairActivity = 0;
let repairLightState = 'off';
let repairLightReason = 'Turn on Auto-Fix in the Auto-Fix tab';
function showRepairLight(state, reason) {
  if (state) { repairLightState = state; repairLightReason = reason || ''; }
  if (typeof document === 'undefined') return;
  let el = document.getElementById('repairIndicator');
  if (!el) {
    // The status line sits under Background Mode in the Run card (2026-10-15); older pages put it under the title.
    const parent = document.getElementById('repairStatusBar') || document.querySelector('.brand-copy');
    if (!parent) return;
    el = document.createElement('span'); el.id = 'repairIndicator'; el.className = 'repair-indicator';
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.setAttribute('aria-atomic', 'true');
    const light = document.createElement('span'); light.className = 'repair-light-strip'; light.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 7; i++) { const dot = document.createElement('span'); dot.className = 'repair-light'; light.append(dot); }
    const label = document.createElement('span'); label.className = 'repair-light-label';
    // ☁ Cloud Repair Connected ●●●●●●● — cloud icon, words, then the dot wave (owner's pick, 2026-10-15).
    const icon = document.createElement('span'); icon.className = 'repair-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>';
    el.append(icon, label, light); parent.append(el);
  }
  const visible = repairActivity > 0 ? 'active' : repairLightState === 'connected' && repairUpdateInfo?.available ? 'update' : repairLightState;
  el.dataset.state = visible;
  const kind = document.getElementById('repairTransport')?.value === 'local' ? 'Local Auto-Fix' : 'Cloud Auto-Fix';
  const text = ({update:'Auto-Fix update available',active:'0x is Auto-Fixing',connected:`${kind} Connected`,checking:'Checking Auto-Fix…',unavailable:'Auto-Fix not ready',off:`${kind} Off`})[visible];
  el.querySelector('.repair-light-label').textContent = text;
  el.title = visible === 'update' ? 'Open the Auto-Fix tab to update your companion' : repairActivity > 0 ? 'Repairing or waiting for the companion' : repairLightReason;
  // Same state as a small coloured dot on the Repair tab (hover shows the words).
  const tab = document.getElementById('repairTabBtn');
  if (tab) {
    let dot = tab.querySelector('.tab-status-dot');
    if (!dot) { dot = document.createElement('span'); dot.className = 'tab-status-dot'; dot.setAttribute('aria-hidden', 'true'); tab.append(dot); }
    dot.dataset.state = visible;
    tab.title = text;
  }
}
// Serialize repairs from parallel generation workers; the VPS allows one active
// repair per account. A cancelled waiter must not let later repairs skip the owner.
let repairQueueTail = Promise.resolve();
let repairQueueSize = 0;
async function repairFailedPrompt(item, error, token) {
  const text = item.text;
  const previous = repairQueueTail;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  repairQueueTail = previous.then(() => gate);
  const waiting = repairQueueSize++ > 0;
  const cancelled = () => {
    if (token === runToken && !stopRequested && item.text === text) return false;
    if (item.text === text) { item.repairPendingError = error; item.repairPendingText = text; }
    return true;
  };
  try {
    if (waiting) {
      item.detail = 'Waiting for another repair to finish'; renderQueue();
      log(`${item.id}: waiting for another repair to finish; refused prompt will not be resent.`);
      let ready = false;
      previous.then(() => { ready = true; });
      while (!ready) {
        if (cancelled()) return false;
        await Promise.race([previous, sleepRepair(250)]);
      }
    } else await previous;
    if (cancelled()) return false;
    return await repairFailedPromptCore(item, error, token);
  } finally {
    release(); repairQueueSize--;
    if (item._repairLightActive) { delete item._repairLightActive; repairActivity = Math.max(0, repairActivity - 1); }
    showRepairLight();
  }
}

// Native call. Resolves {status, body}; rejects with e.nativeMissing = not_installed | not_allowed | crashed | unavailable | other.
function nativeRepairCall(type, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rt = globalThis.chrome && chrome.runtime;
    if (!rt || typeof rt.sendNativeMessage !== 'function') return reject(Object.assign(Error('native messaging unavailable'), {nativeMissing: 'unavailable'}));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(Error('Repair timed out')); } }, timeoutMs);
    try {
      rt.sendNativeMessage(REPAIR_HOST, {type, body}, (reply) => {
        // Consume runtime.lastError even for a callback arriving after timeout.
        const err = rt.lastError;
        if (done) return; done = true; clearTimeout(timer);
        if (err) {
          const m = String(err.message || err);
          const kind = /not found/i.test(m) ? 'not_installed' : /forbidden/i.test(m) ? 'not_allowed' : /exited|failed to start|error when communicating/i.test(m) ? 'crashed' : 'other';
          return reject(Object.assign(Error(m), {nativeMissing: kind}));
        }
        resolve(reply && typeof reply === 'object' ? reply : {status: 500, body: {error: 'empty reply from the repair companion'}});
      });
    } catch (e) { done = true; clearTimeout(timer); reject(Object.assign(e, {nativeMissing: 'unavailable'})); }
  });
}
async function httpRepairCall(route, repairToken, body, timeoutMs) {
  const r = await fetch('http://127.0.0.1:8766' + route, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Repair-Token': repairToken},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs)});
  let j = {}; try { j = await r.json(); } catch {}
  return {status: r.status ?? (r.ok ? 200 : 500), body: j};
}

const REPAIR_MSG = {
  not_installed: 'auto-repair is not installed on this PC. Run "Install Repair.cmd" from the repair companion folder once (see the Auto-Fix tab), then retry this prompt',
  not_allowed: `the installed repair companion does not allow this extension (ID ${globalThis.chrome && chrome.runtime && chrome.runtime.id || '?'}). Run "Install Repair.cmd" again, or add this ID to native-host\\allowed-origins.json first`,
  crashed: 'the repair companion could not start (is Node.js installed?). Run "Install Repair.cmd" again and check native-host\\host.log',
  old_companion: 'the installed repair companion is an older version. Run "Install Repair.cmd" from the new companion folder',
  helper_down: 'the repair companion is not installed and the developer helper is not running. Run "Install Repair.cmd" once (recommended), or start "Start Repair Helper.cmd"',
  bad_token: 'the developer helper pairing token is wrong. Copy the token shown in the helper window into the Auto-Fix tab and save',
};

// Which way to reach the companion right now: {transport:'native'|'http'} or {stop: message}.
async function pickRepairTransport(config) {
  if (config.repairTransport === 'remote') {
    repairUpdateInfo = null;
    if (typeof document !== 'undefined') document.getElementById('repairUpdateNotice')?.classList.add('hidden');
    try {
      const health = await remoteRepairRequest(config, '/health');
      if (health.status !== 200) return {stop: health.body.error || 'VPS repair service unavailable'};
      if (health.body.protocol !== REPAIR_PROTOCOL) return {stop: 'VPS repair protocol is incompatible'};
      return {transport: 'remote', info: health.body};
    } catch (e) { return {stop: 'VPS connection failed: ' + String(e.message || e)}; }
  }
  let nativeProblem = 'not_installed';
  try {
    const h = await nativeRepairCall('health', null, 15000);
    if (h.status === 200 && h.body) observeCompanionVersion(h.body);
    if (h.status === 200 && h.body && h.body.protocol === REPAIR_PROTOCOL) return {transport: 'native', info: h.body};
    nativeProblem = 'old_companion';
  } catch (e) { nativeProblem = e.nativeMissing || 'crashed'; }
  if (nativeProblem === 'not_allowed' || nativeProblem === 'crashed' || nativeProblem === 'old_companion') return {stop: REPAIR_MSG[nativeProblem]};
  if (!config.repairToken) return {stop: REPAIR_MSG.not_installed};
  let h;
  try { h = await httpRepairCall('/health', config.repairToken, null, 5000); } catch { return {stop: REPAIR_MSG.helper_down}; }
  if (h.status === 200 && h.body) observeCompanionVersion(h.body);
  if (h.status === 401) return {stop: REPAIR_MSG.bad_token};
  if (h.status !== 200 || !h.body || h.body.protocol !== REPAIR_PROTOCOL) return {stop: REPAIR_MSG.old_companion};
  return {transport: 'http', info: h.body};
}

// Repair AI timeouts (server AGY turn or the extension's wait for the job), not
// connection problems or validation failures.
function isRepairTimeout(message) {
  return /repair ai timed out|exceeded 12 minutes|^repair timed out/i.test(String(message || ''));
}

const IMAGE_SUSPECT_ROUNDS = 3;
function blameStartImage(item, why) {
  const platformName = item.platform === 'vids' ? 'Google Vids' : item.platform === 'gemini' ? 'Gemini' : item.platform === 'grok' ? 'Grok' : 'Flow';
  item.status = 'error'; item.retryAt = null; item.imageSuspect = true;
  item.detail = `Start image likely blocked: ${platformName} ${why}. Regenerate the scene image (or its character pictures), then Retry`;
  log(`${item.id}: ${item.detail}.`); renderQueue(); return true;
}
async function repairFailedPromptCore(item, error, token) {
  const config = await chrome.storage.local.get(['repairEnabled', 'repairToken', 'repairMaxRounds', 'repairTransport', 'remoteRepairUrl', 'remoteRepairToken']);
  if (!config.repairEnabled || item.groupMemberIds?.length > 1) return false;
  if (!/policy rejection|flagged|restricted|unsafe|violat.*policy/i.test(error)) return false;
  // Cancellation must retain this prompt's refusal for repair-first resume.
  // Never apply that refusal or a late response to a manually edited prompt.
  const repairInputText = item.text;
  const cancelled = () => {
    if (token === runToken && !stopRequested && item.text === repairInputText) return false;
    if (item.text === repairInputText) {
      item.repairPendingError = error; item.repairPendingText = repairInputText;
    }
    return true;
  };
  if (cancelled()) return false;
  // only a stop for a repair PROBLEM sets this again (stopHere); limit reached / manual edit / success leave it cleared
  item.repairPendingError = null; item.repairPendingText = null;
  const maxRounds = Math.max(1, Math.min(10, Number(config.repairMaxRounds) || 10));
  if ((item.repairCount || 0) >= maxRounds) {
    item.status = 'error'; item.retryAt = null; item.detail = `Repair limit reached (${maxRounds} rounds) — edit prompt or references`;
    log(`${item.id}: ${item.detail}. No unchanged policy retry.`); renderQueue(); return true;
  }
  // Frame to Video still refused after 3 prompt repairs: the start image is the likely cause (owner 2026-10-24: a scene
  // passed with its ORIGINAL prompt once the image was regenerated; 10 text rounds could never fix it). Stop repairing
  // text; a Builder project with Auto makes a new scene image (faceless-builder-ui queueEnded).
  // Flow's "prominent people" refusal judges faces in the start image too: one prompt repair, then the image (owner log
  // 2026-10-24: two rounds only removed harmless words; the scene passed with its original prompt and a new image).
  const frameItem = settings.mode === 'frame-to-video' && (item.builderSceneId || (typeof images !== 'undefined' && images.length));
  const imageRounds = /prominent people/i.test(error) ? 1 : IMAGE_SUSPECT_ROUNDS;
  if (frameItem && (item.repairCount || 0) >= imageRounds) return blameStartImage(item, `refused this scene again after ${item.repairCount} prompt repair${item.repairCount > 1 ? 's' : ''}`);
  // A policy-refused prompt is never resent unchanged because of a repair problem: the card says what to do.
  // v1.10.1: the stop remembers the refusal (item.repairPendingError), so Retry REPAIRS FIRST instead of resubmitting the
  // refused prompt to Flow (runPrompt checks the flag before generating).
  const stopHere = (why) => {
    if (cancelled()) return false;
    item.status = 'error'; item.retryAt = null;
    showRepairLight('unavailable', why);
    item.repairPendingError = error; item.repairPendingText = item.text;
    const platformName = item.platform === 'vids' ? 'Google Vids' : item.platform === 'gemini' ? 'Gemini' : item.platform === 'grok' ? 'Grok' : item.platform === 'chatgpt' ? 'ChatGPT' : 'Flow';
    item.detail = `${platformName} refused this prompt — ${why}`;
    log(`${item.id}: ${item.detail}. The refused prompt was NOT resent unchanged; Retry repairs it before generating.`);
    renderQueue(); return true;
  };
  item.detail = 'repairing dialogue and staging — preserving references and timing';
  if (!item._repairLightActive) { item._repairLightActive = true; repairActivity += 1; }
  showRepairLight();
  log(`${item.id}: policy rejection detected; requesting ${config.repairTransport === 'remote' ? 'VPS' : 'local'} prompt repair.`);
  renderQueue();
  const route = await pickRepairTransport(config);
  if (route.stop) return stopHere(route.stop);
  // The cloud server only accepts prompts of 40+ characters; say so instead of "Invalid repair request".
  if (route.transport === 'remote' && String(item.text || '').trim().length < 40) return stopHere('the prompt is too short to repair automatically (under 40 characters). Add scene detail or edit it, then press Retry');
  showRepairLight('connected', route.transport === 'remote' ? 'VPS responded successfully' : 'Companion responded successfully');
  if (cancelled()) return false;
  item.repairCount = (item.repairCount || 0) + 1;
  item.detail = `Repair round ${item.repairCount}/${maxRounds}: diagnosing dialogue and staging`; renderQueue();
  const payload = {id: item.id, text: item.text, original: item.originalText || item.text, error, round: item.repairCount, history: item.repairHistory || []};
  if (route.transport === 'remote' && route.info.memoryEnabled) payload.context = {mode: settings.mode || 'unknown'};
  if (route.transport === 'remote') {
    const key = JSON.stringify(payload);
    if (item._remoteRepairRequest?.key !== key) item._remoteRepairRequest = {key, id: crypto.randomUUID()};
    payload.requestId = item._remoteRepairRequest.id;
  }
  try {
    let response;
    const deadline = Date.now() + (route.transport === 'remote' ? 15 : 10) * 60000;
    for (;;) {   // another repair on this PC holds the companion: wait (the worker is occupied by this repair anyway)
      response = route.transport === 'remote' ? await remoteRepairCall(config, payload, token)
        : route.transport === 'native' ? await nativeRepairCall('repair', payload, 720000) : await httpRepairCall('/repair', config.repairToken, payload, 620000);
      // Keep the request ID only when transport failed or a cancelled job may
      // still finish. A completed failure must allow Retry to run a new job.
      const busy = route.transport === 'remote'
        ? [409, 429].includes(response.status) && /(?:already have an active repair|another repair.*(?:running|finish)|repair.*(?:busy|in progress))/i.test(response.body?.error || '')
        : response.status === 409;
      if (route.transport === 'remote' && response.status !== 200 && !busy) delete item._remoteRepairRequest;
      if (!busy || Date.now() > deadline || cancelled()) break;
      item.detail = route.transport === 'remote'
        ? 'Waiting for another repair to finish on your account'
        : `Repair round ${item.repairCount}/${maxRounds}: waiting for another repair on this PC to finish`;
      renderQueue();
      await sleepRepair(15000);
      if (cancelled()) break;   // Stop or manual edit during the wait: never contact the companion again
    }
    if (cancelled()) { item.repairCount -= 1; return false; }
    const result = response.body || {};
    if (result.upgrade && /_REPAIR_LIMIT$/.test(result.code || '') && typeof repairLimitReached === 'function') repairLimitReached(result.error);
    if (response.status !== 200) throw Error(result.error || 'Repair unavailable');
    item.originalText = item.originalText || item.text;
    item.repairHistory = [...(item.repairHistory || []), {round: item.repairCount, before: item.text, after: result.text, failure: error, diagnosis: result.diagnosis || ''}];
    item.text = result.text;
    item.generationText = result.text;
    if (route.transport === 'remote' && result.jobId && result.memoryOwner) {
      item._cloudRepairMemory = {jobId: result.jobId, owner: result.memoryOwner, revised: result.text, base: remoteRepairBase(config.remoteRepairUrl)};
      log(`${item.id}: repair context supplied ${result.memoryLessonsUsed || 0} private confirmed fix(es), ${result.learnedSwapsUsed || 0} learned word swap(s) and ${result.seedLessonsUsed || 0} DramaFactory starter suggestion(s).`);
    } else delete item._cloudRepairMemory;
    if (route.transport === 'remote') delete item._remoteRepairRequest;
    item.status = 'pending'; item.retryAt = Date.now() + settings.retryDelaySeconds * 1000;
    item.detail = `Repair ${item.repairCount}/${maxRounds} validated — revised prompt retry scheduled`;
    log(`${item.id}: ${item.detail}. ${result.diagnosis || ''} Original preserved in this prompt's repair history.`);
    // Last-resort dialogue swap (Builder prompts, round 2+): the project's speech and subtitles follow when the video saves.
    for (const c of Array.isArray(result.dialogueChanges) ? result.dialogueChanges.slice(0, 8) : []) log(`${item.id}: repair changed dialogue (last resort): "${String(c.before || '').slice(0, 160)}" → "${String(c.after || '').slice(0, 160)}"`);
    renderQueue(); return true;
  } catch (e) {
    log(`${item.id}: repair failed: ${e.message}. Original prompt retained.`);
    if (cancelled()) { item.repairCount -= 1; return false; }
    // The repair AI's own refusal (explicit answer or Google's safety filter on its
    // output) needs a human edit; retrying repeats the block and spends allowance.
    if (/manual revision required|blocked by (?:google )?safety filters|manually revise the scene/i.test(e.message)) {
      // Frame to Video: the repair AI giving up (it blamed a name the owner later kept) usually means the picture.
      if (frameItem) { log(`${item.id}: repair AI asked for a manual edit (${String(e.message).slice(0, 200)}).`); return blameStartImage(item, 'refused this scene and a prompt repair cannot fix it'); }
      item.status = 'error'; item.retryAt = null; item.detail = `Needs prompt edit: ${e.message}`;
      renderQueue(); return true; // Do not resubmit an unchanged rejected prompt.
    }
    item.repairCount -= 1;   // a round that produced nothing does not use up the repair budget; Retry repairs again
    // A repair AI timeout is usually temporary: try once more automatically.
    // A client-side wait expiry keeps the request ID, so it rejoins the same
    // server job; a server-reported timeout starts one new job.
    if (isRepairTimeout(e.message) && !item._repairTimeoutRetried) {
      item._repairTimeoutRetried = true;
      log(`${item.id}: repair timed out; retrying the repair once automatically.`);
      item.detail = 'repair timed out — retrying the repair once'; renderQueue();
      try { return await repairFailedPromptCore(item, error, token); }
      finally { delete item._repairTimeoutRetried; }
    }
    return stopHere(`repair could not finish (${String(e.message).slice(0, 160)}). Press Retry to repair again`);
  } finally {
    if (route.transport === 'remote' && typeof refreshCloudAllowance === 'function') void refreshCloudAllowance();
  }
}

// LEARNING (v1.10.0): when a REPAIRED prompt then generates, tell the companion. Only these confirmed fixes are shown to the
// model as "past fixes" on later refusals - so the repair learns from what Flow actually accepted on this PC. Fire and forget.
async function reportRepairOutcome(item, outcome) {
  try {
    if (item?._cloudRepairMemory && typeof reportCloudRepairOutcome === 'function') return reportCloudRepairOutcome(item, outcome);
    if (outcome?.passed === false) return;
    if (!item || !item.repairCount || typeof item.originalText !== 'string' || item.originalText === item.text) return;
    // runPrompt reports a success when generation is confirmed and again after saving.
    const reportKey = item.originalText + '\u0000' + item.text;
    if (item._localOutcomeReported === reportKey) return;
    item._localOutcomeReported = reportKey;
    const config = await chrome.storage.local.get(['repairEnabled', 'repairToken', 'repairTransport']);
    if (!config.repairEnabled) return;
    if (config.repairTransport === 'remote') return; // Test server does not pool users' learning records.
    const body = {id: item.id, original: item.originalText, revised: item.text, round: item.repairCount, passed: true};
    try { const r = await nativeRepairCall('outcome', body, 15000); if (r && r.status === 200) { log(`${item.id}: repaired prompt generated - remembered as a working fix on this PC.`); return; } }
    catch (e) { if (!config.repairToken) return; }
    if (config.repairToken) await httpRepairCall('/outcome', config.repairToken, body, 5000);
  } catch {}
}

// ---------------------------------------------------------------- Repair tab
async function testRepairConnection() {
  const config = await chrome.storage.local.get(['repairToken', 'repairEnabled', 'repairTransport', 'remoteRepairUrl', 'remoteRepairToken']);
  const out = $('repairConnection');
  if (out) out.textContent = 'Checking...';
  showRepairLight('checking');
  const route = await pickRepairTransport(config);
  showRepairLight(!config.repairEnabled ? 'off' : route.stop || route.info.agyInstalled === false ? 'unavailable' : 'connected', route.stop || (route.info.agyInstalled === false ? 'Repair engine needs setup' : route.transport === 'remote' ? 'VPS connection verified' : 'Connection verified; companion starts on demand'));
  const msg = route.stop ? `Not ready: ${route.stop}.` : route.transport === 'remote'
    ? (route.info.agyInstalled === false ? 'VPS connected — the server repair engine needs setup.' : 'Ready: cloud repair connected. AI access is verified during repair.')
    : `Ready: repair companion v${route.info.version} via ${route.transport === 'native' ? 'Chrome (nothing needs to stay open)' : 'the developer helper window'}${route.info.agyInstalled === false ? ' - but AGY was not found: install it and sign in' : ', AGY found'}.`;
  if (out) out.textContent = msg;
  if (typeof refreshCloudAllowance === 'function') await refreshCloudAllowance();
  return msg;
}
if (typeof document !== 'undefined' && document.getElementById('repairEnabled')) {
  const describeRepairMode = () => {
    $('repairModeDescription').textContent = $('repairTransport').value === 'remote'
      ? 'Sends prompt text, platform warnings and repair history to the repair server and its AI provider. Images and videos stay on the platform.'
      : 'Uses your local companion and signed-in AI account. Project files stay intact. Setup is under Advanced below.';
  };
  $('repairTransport').addEventListener('change', describeRepairMode);
  $('importRemoteRepairBtn').addEventListener('click', () => $('importRemoteRepairFile').click());
  $('importRemoteRepairFile').addEventListener('change', async () => {
    try {
      const file = $('importRemoteRepairFile').files[0];
      if (!file) return;
      const connection = JSON.parse(await file.text());
      $('remoteRepairUrl').value = remoteRepairBase(connection.remoteRepairUrl);
      if (typeof connection.remoteRepairToken !== 'string' || connection.remoteRepairToken.length < 32) throw new Error('Invalid connection access token');
      $('remoteRepairToken').value = connection.remoteRepairToken;
      $('repairTransport').value = 'remote';
      describeRepairMode();
      $('repairStatus').textContent = 'Test connection loaded. Enable repair and save preferences.';
    } catch (e) { $('repairStatus').textContent = e.message; }
    $('importRemoteRepairFile').value = '';
  });
  chrome.storage.local.get(['repairEnabled', 'repairToken', 'repairMaxRounds', 'repairTransport', 'remoteRepairUrl', 'remoteRepairToken']).then((c) => {
    $('repairEnabled').checked = !!c.repairEnabled; if($('repairToken'))$('repairToken').value = c.repairToken || '';
    $('repairMaxRounds').value = c.repairMaxRounds || 10;
    $('repairTransport').value = c.repairTransport || 'remote';
    $('remoteRepairUrl').value = c.remoteRepairUrl || (typeof CLOUD_REPAIR_URL !== 'undefined' ? CLOUD_REPAIR_URL : '');
    $('remoteRepairToken').value = c.remoteRepairToken || '';
    describeRepairMode();
    showRepairLight('off');
    if (c.repairEnabled) testRepairConnection();
  });
  $('saveRepairBtn').addEventListener('click', async () => {
    try {
      const transport = $('repairTransport').value;
      const base = transport === 'remote' ? remoteRepairBase($('remoteRepairUrl').value) : $('remoteRepairUrl').value.trim();
      if (transport === 'remote') {
        if (!$('remoteRepairToken').value.trim()) throw new Error('Click Connect cloud repair first, or enter your private server token');
        const serverUrl = new URL(base);
        const origin = serverUrl.protocol + '//' + serverUrl.hostname + '/*';
        if (!await chrome.permissions.request({origins: [origin]})) throw new Error('VPS connection permission was declined');
      }
      await chrome.storage.local.set({repairEnabled: $('repairEnabled').checked, repairToken: $('repairToken')?$('repairToken').value.trim():(await chrome.storage.local.get('repairToken')).repairToken||'',
        repairTransport: transport, remoteRepairUrl: base, remoteRepairToken: $('remoteRepairToken').value.trim(),
        repairMaxRounds: Math.max(1, Math.min(10, Number($('repairMaxRounds').value) || 10))});
    } catch (e) { $('repairStatus').textContent = e.message; return; }
    $('repairStatus').textContent = 'Repair preferences saved';
    if ($('repairEnabled').checked) testRepairConnection(); else showRepairLight('off');
  });
  if (document.getElementById('checkRepairUpdateBtn')) $('checkRepairUpdateBtn').addEventListener('click', () => { testRepairConnection(); });
  if (document.getElementById('testRepairBtn')) $('testRepairBtn').addEventListener('click', () => { testRepairConnection(); });
  if (document.getElementById('repairExtensionId')) $('repairExtensionId').textContent = (chrome.runtime && chrome.runtime.id) || '';
}
