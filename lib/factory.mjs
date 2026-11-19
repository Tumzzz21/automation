// Overnight Auto-Factory (owner 2026-10-23/24, docs/AUTO-FACTORY-PLAN.md): up to five AI Stories in a row, each one
// built, generated with Auto and exported, while the user sleeps. This module only decides; the panel carries it out.
// Rules: paid Pro (Discord Pro: 1 trial run per month); credits out -> finish what was sent, then switch to the next chosen account (opt-in)
// or stop for the night; "unusual activity" stops everything; a story that cannot finish is skipped, the next one runs.

export const MAX_STORIES = 5;
export const MAX_ACCOUNTS = 10;   // owner 2026-10-28: "make it at least 5"; 2026-11-13: 10 slots for paid Pro (Discord Pro 2)
export const SWITCH_PAUSE_MS = 150000;
export const SERIES_PARTS = [2, 3];   // owner 2026-10-28: Series mode, normal parts only (no long series yet)

// Paid Pro on a Google or Discord account: the full Factory. Discord Pro: a trial (1 run of up to 5 stories per month, counted by the
// server; the panel checks it). Free: not included. (Owner 2026-10-23: Gmail Pro only; 2026-10-25: paid Pro on any
// account, and a monthly trial for Discord Pro so they can see it work before upgrading.)
export function factoryAllowed(account) {
  if (!account?.signedIn) return {ok: false, reason: 'Sign in to use the Factory.'};
  if (account.plan === 'pro') return {ok: true};
  if (account.plan === 'community') return {ok: true, trial: true};
  return {ok: false, reason: 'The Factory is a Pro feature. Upgrade to Pro to run stories overnight.'};
}

export function topicsFromText(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map(t => t.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(t => t.length >= 3))].slice(0, MAX_STORIES);
}

// A new Factory run. `accounts` = Flow account numbers (/u/N/) the user chose for auto-switch, first = current one.
// series: dramas in 2-3 parts, made in order; Part 2+ continue from the previous part (owner 2026-10-28).
// seriesCount: several series in one run, each with its own topic and cast, one after another (owner 2026-10-29).
export function createFactory({templateId, answers, target = null, count, topicMode = 'auto', topics = [], storyboard = false, switchAccounts = false, accounts = [], confirmedPaid = false, series = false, parts = 2, seriesCount = 1, now = Date.now()}) {
  if (series && !SERIES_PARTS.includes(Number(parts))) throw Error('A series has 2 or 3 parts.');
  const n = series ? Number(parts) : Math.max(1, Math.min(MAX_STORIES, Number(count) || 1));
  const groups = series ? Math.max(1, Math.min(MAX_STORIES, Number(seriesCount) || 1)) : 1;
  const list = topicMode === 'list' ? topicsFromText(Array.isArray(topics) ? topics.join('\n') : topics) : [];
  if (topicMode === 'list' && !list.length) throw Error('Type at least one topic, one per line.');
  const chosen = [...new Set((accounts || []).map(Number).filter(a => Number.isInteger(a) && a >= 0))].slice(0, MAX_ACCOUNTS);
  if (switchAccounts && !confirmedPaid) throw Error('Confirm that each account has its own paid plan, or switch account switching off.');
  if (switchAccounts && chosen.length < 2) throw Error('Choose at least two accounts for account switching.');
  return {
    id: 'factory-' + now, templateId, answers: {...answers}, target, storyboard: !!storyboard, topicMode,
    series: !!series, parts: series ? n : 1,
    stories: series
      ? Array.from({length: topicMode === 'list' ? Math.min(groups, list.length) : groups}, (_, g) => Array.from({length: n}, (_, i) =>
          ({topic: i ? 'Part ' + (i + 1) : list[g] || '', group: g, part: i + 1, status: 'waiting', projectId: null, account: null, reason: ''}))).flat()
      : Array.from({length: topicMode === 'list' ? Math.min(n, list.length) : n}, (_, i) => ({topic: list[i] || '', status: 'waiting', projectId: null, account: null, reason: ''})),
    switching: switchAccounts ? {accounts: chosen, index: 0, switches: []} : null,
    status: 'running', stopReason: '', startedAt: now, endedAt: null,
  };
}

const active = s => ['building', 'running', 'exporting'].includes(s.status);

// What the panel should do next.
export function nextStep(f, now = Date.now()) {
  if (f.status !== 'running') return {kind: 'idle'};
  if(f.retryAt>now)return {kind:'cooldown',ms:f.retryAt-now,retryAt:f.retryAt};
  if(f.retryAt){delete f.retryAt;delete f.retryReason;}
  if (f.topicMode === 'auto' && f.stories.some(s => s.status === 'waiting' && !s.topic)) return {kind: 'suggest-topics', count: f.stories.filter(s => !s.topic).length};
  const current = f.stories.findIndex(active);
  if (current >= 0) return {kind: 'wait', index: current};
  const next = f.stories.findIndex(s => s.status === 'waiting' || s.status === 'paused');
  if (next < 0) return {kind: 'finish'};
  if (f.stories[next].projectId) return {kind: 'resume', index: next};
  // Series: Part 2+ is written from the finished previous part, never from scratch.
  return {kind: f.series && partOf(f, next) > 1 ? 'continue' : 'build', index: next};
}

export function hourlyRetryDelay(reason='') {
  const match=String(reason).match(/try again\s+in\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if(!match)return 10*60000;
  const unit=/^h/i.test(match[2])?3600000:/^m/i.test(match[2])?60000:1000;
  return Math.min(3600000,Math.max(1000,Number(match[1])*unit+5000));
}
// Owner 2026-11-08 (member report: "the drama Factory stops when an image fails"): a Flow image or video can fail for a
// moment (Flow error, slow page, a busy server). Before a story is skipped (or a series stopped), the Factory waits a few
// minutes and resumes the same story, which makes only the missing images and videos again. Twice per story at most.
export const MEDIA_RETRIES = 2, MEDIA_RETRY_MS = 3 * 60000;
export function scheduleMediaRetry(f, index, reason = '', now = Date.now()) {
  const s = f.stories[index];
  if (!s || !s.projectId || (s.mediaRetries || 0) >= MEDIA_RETRIES) return null;
  s.mediaRetries = (s.mediaRetries || 0) + 1;
  f.retryAt = now + MEDIA_RETRY_MS; f.retryReason = 'media';
  s.status = 'paused'; s.retryAt = f.retryAt;
  s.reason = 'Some images or videos failed' + (reason ? ' (' + String(reason).slice(0, 80) + ')' : '') + '; retrying the missing ones (' + s.mediaRetries + ' of ' + MEDIA_RETRIES + ')';
  return {action: 'wait', ms: MEDIA_RETRY_MS};
}
export function scheduleHourlyRetry(f,index,reason='',now=Date.now()) {
  const ms=hourlyRetryDelay(reason);f.retryAt=now+ms;f.retryReason=reason||'AI Story hourly limit';
  const story=f.stories[index];if(story){story.status='paused';story.retryAt=f.retryAt;story.reason='Hourly limit: retry scheduled automatically';}
  return {action:'wait',ms};
}
// Maintenance (owner 2026-11-11): the server refuses new stories while the owner's maintenance switch is on. The Factory
// waits and asks again every 10 minutes, so an overnight run carries on by itself when maintenance ends.
export const MAINTENANCE_RETRY_MS = 10 * 60000;
export function scheduleMaintenanceRetry(f,index,reason='',now=Date.now()) {
  f.retryAt=now+MAINTENANCE_RETRY_MS;f.retryReason=reason||'System maintenance';
  const story=f.stories[index];if(story){story.status='paused';story.retryAt=f.retryAt;story.reason='System maintenance: retrying automatically';}
  return {action:'wait',ms:MAINTENANCE_RETRY_MS};
}
export function canContinueWrittenPart(p) {
  return !!p?.project?.scenes?.length&&p.imagesReviewed===true&&!p.libraryCastReview&&['images_reviewed','video_ready','videos_finished'].includes(p.state)&&(p.project.assets||[]).every(a=>!(p.redoIds||[]).includes(a.id)&&p.media?.[a.id]?.blob?.size>0&&/^[a-f0-9]{64}$/.test(p.media[a.id].sha256||''));
}

export function fillTopics(f, topics) {
  const fresh = topics.map(t => String(t || '').trim()).filter(Boolean);
  for (const s of f.stories) if (!s.topic && fresh.length) s.topic = fresh.shift();
  // Fewer ideas than stories: the empty ones are dropped, never built with an empty topic.
  if (!f.series) f.stories = f.stories.filter(s => s.topic);
  else f.stories = f.stories.filter(s => f.stories.find(x => groupOf(x) === groupOf(s) && x.part === 1)?.topic);
  if (!f.stories.length) { f.status = 'stopped'; f.stopReason = 'No topics came back from AI Story.'; }
  return f;
}

// How a run of one story ended. kind: finished | exported | credits | unusual | failed | stopped | daily-limit | hourly-limit
export function storyEnded(f, index, kind, reason = '', now = Date.now()) {
  const s = f.stories[index];
  if (!s) return {action: 'none'};
  const stopAll = why => { f.status = 'stopped'; f.stopReason = why; f.endedAt = now; return {action: 'stop', reason: why}; };
  switch (kind) {
    case 'finished': s.status = 'exporting'; return {action: 'export', index};
    case 'exported': s.status = 'done'; s.reason = ''; return {action: 'next'};
    case 'media-incomplete': s.status='incomplete';s.reason=reason||'Some scenes need attention; saved clips are kept';return {action:'next'};
    case 'failed': s.status = 'skipped'; s.reason = reason || 'a scene could not be made';
      // A later part would continue from a part that does not exist: that series stops, finished parts are kept.
      // Several series: its remaining parts are skipped and the next series starts.
      if (f.series) {
        const g = groupOf(s), why = 'Series stopped: Part ' + partOf(f, index) + ' could not be finished. Earlier parts are kept.';
        if (!f.stories.some(x => groupOf(x) !== g && x.status === 'waiting')) return stopAll(why);
        for (const x of f.stories) if (groupOf(x) === g && x.status === 'waiting') { x.status = 'skipped'; x.reason = 'Part ' + partOf(f, index) + ' could not be finished'; }
        return {action: 'next'};
      }
      return {action: 'next'};
    case 'hourly-limit': return scheduleHourlyRetry(f,index,reason,now);
    case 'daily-limit': s.status = 'paused'; s.reason = reason || 'AI Story daily limit reached'; return stopAll(s.reason);
    case 'unusual': s.status = 'paused'; s.reason = 'Flow reported unusual activity'; return stopAll('Flow reported unusual activity. The Factory stopped on every account to protect them.');
    case 'stopped': s.status = 'paused'; s.reason = reason || 'stopped'; return stopAll(reason || 'Stopped by you.');
    case 'credits': {
      s.status = 'paused'; s.reason = 'Flow credits ran out' + (s.account != null ? ' (account ' + s.account + ')' : '');
      const sw = f.switching;
      if (sw && sw.index + 1 < sw.accounts.length) {
        sw.index++; sw.switches.push({at: now, to: sw.accounts[sw.index], storyIndex: index});
        return {action: 'switch', account: sw.accounts[sw.index], pauseMs: SWITCH_PAUSE_MS};
      }
      return stopAll(sw ? 'Flow credits ran out on every chosen account.' : 'Flow credits ran out.');
    }
    default: return {action: 'none'};
  }
}

// Flow keeps the Google account in the path (owner 2026-10-28): main = flow.google.com/, 2nd = /u/1/, 3rd = /u/2/.
export function flowAccountUrl(n) { return Number(n) > 0 ? 'https://flow.google.com/u/' + Number(n) + '/' : 'https://flow.google.com/'; }
export function flowAccountOf(url) { const m = String(url || '').match(/^https:\/\/(?:flow\.google(?:\.com)?|labs\.google\/fx(?:\/[a-z-]+)?\/tools\/flow)\/u\/(\d+)(?:\/|$|\?)/i); return m ? Number(m[1]) : 0; }
export function flowAccountLabel(n) { return Number(n) > 0 ? 'your ' + (['', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'][Number(n)] || (Number(n) + 1) + 'th') + ' Flow account' : 'your main Flow account'; }

// The account the Factory works on now (null = whatever Flow tab is open).
export function currentAccount(f) { return f.switching ? f.switching.accounts[f.switching.index] : null; }

// Older runs (one series) have no group; their part number is the position.
export const groupOf = s => s.group ?? 0;
export const partOf = (f, i) => f.stories[i]?.part ?? i + 1;
export const seriesTotal = f => f.series ? new Set(f.stories.map(groupOf)).size : 0;
// "Part 2" for one series, "Series 2 · Part 1" for several.
export function storyLabel(f, i) {
  if (!f.series) return 'Story ' + (i + 1);
  return (seriesTotal(f) > 1 ? 'Series ' + (groupOf(f.stories[i]) + 1) + ' · ' : '') + 'Part ' + partOf(f, i);
}

export function finish(f, now = Date.now()) { if (f.status === 'running') { f.status = 'done'; f.endedAt = now; } return f; }

// Morning report lines.
export function report(f) {
  const done = f.stories.filter(s => s.status === 'done').length;
  const lines = [`${done} of ${f.stories.length} finished`];
  f.stories.forEach((s, i) => {
    if (s.status === 'done') return;
    lines.push(`${storyLabel(f, i)}${s.topic && !(f.series && partOf(f, i) > 1) ? ' (' + s.topic.slice(0, 40) + ')' : ''}: ${s.status === 'waiting' ? 'not started' : s.status === 'skipped' ? 'skipped, ' + s.reason : s.status==='incomplete'?'needs attention, '+s.reason:s.reason || s.status}`);
  });
  if (f.status === 'stopped' && f.stopReason) lines.push('Stopped: ' + f.stopReason);
  return lines;
}

// Classify how a queue ended (control.js passes {clean, quota, stopped, reason, errors}).
export function classifyQueueEnd(info = {}) {
  if (info.clean) return 'clean';
  const reason = String(info.reason || '');
  if (/unusual activity/i.test(reason)) return 'unusual';
  if (/hourly limit/i.test(reason)) return 'hourly-limit';
  if (info.quota || /credits|usage limit|limit reached|out of (?:images|videos)/i.test(reason)) return 'credits';
  if (/stopped by user/i.test(reason)) return 'stopped';
  if (info.errors) return 'failed';
  return info.stopped ? 'stopped' : 'failed';
}
