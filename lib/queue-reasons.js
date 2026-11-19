'use strict';
// Stable reason codes for queue prompts (owner 2026-11-11, "do this" after the state-machine review).
// A prompt's `status` is unchanged (pending / running / done / error / skipped / combined). A waiting or failed prompt
// now also carries a short code, so Flow Buddy, the AI assistant and tests read the code instead of the English
// `detail` sentence (which is reworded and translated). `detail` stays, for people only.
// Add-only: nothing stored before this change needs it; an item without a code gets one worked out from its flags.
(function (root) {
  const WAITING = Object.freeze({
    waiting: 'waiting to start',
    requeued: 'sent back to the queue by Retry',
    retry_scheduled: 'retry scheduled',
    stopped_resumable: 'stopped; ready to resume',
    quota_wait: 'waiting for credits or a usage limit to reset',
    solo_retry: 'retrying alone once the other videos finish',
    repair_pending: 'will be repaired before it is sent again',
    unusual_activity: 'Flow reported unusual activity; queue paused',
    model_unavailable: 'the chosen Flow model is unavailable; queue paused',
    duration_unavailable: 'the chosen video length is not offered; queue paused',
    tab_changed: 'the Flow tab changed or needs attention; queue paused',
  });
  const FAILED = Object.freeze({
    refused_twice: 'the same prompt was refused twice',
    sheet_refused: 'the storyboard sheet was refused; single images follow',
    signed_out: 'signed out or the session expired',
    usage_limit: 'usage limit or credits',
    policy_refused: 'refused by the platform\'s content rules',
    needs_edit: 'needs a manual prompt edit',
    upload_failed: 'an image upload failed',
    timed_out: 'the wait timed out',
    generation_failed: 'the platform could not finish it',
    save_failed: 'made, but the file could not be saved',
    page_not_ready: 'the page was not ready',
    failed: 'failed',
  });
  const OTHER = Object.freeze({skipped: 'skipped', combined: 'combined with another prompt'});
  const REASONS = Object.freeze({...WAITING, ...FAILED, ...OTHER});
  const TRACKED = ['pending', 'error', 'skipped', 'combined'];
  const keyOf = item => String(item.status) + ':' + (Number(item.attempts) || 0);

  // The one place an error sentence is turned into a code (engines report English text; this runs once, at the source).
  function classifyQueueError(text) {
    const t = String(text || '');
    if (/needs prompt edit|repair limit/i.test(t)) return 'needs_edit';   // before "limit reached" (a repair limit is not a usage limit)
    if (/sign in|signed in|log ?in|session/i.test(t)) return 'signed_out';
    if (/quota|usage limit|credit|limit reached/i.test(t)) return 'usage_limit';
    if (/unusual activity/i.test(t)) return 'unusual_activity';
    if (/flagged|policy|refused|violat/i.test(t)) return 'policy_refused';
    if (/upload/i.test(t) && /fail|could not|did not|rejected/i.test(t)) return 'upload_failed';
    if (/timed out/i.test(t)) return 'timed_out';
    if (/generation failed|error on my side/i.test(t)) return 'generation_failed';
    if (/save failed|could not be saved|download (?:wait expired|failed)|background download failed/i.test(t)) return 'save_failed';
    if (/not found|disappeared|not ready/i.test(t)) return 'page_not_ready';
    return 'failed';
  }

  // Set where the queue decides; the code is tied to this status and attempt, so a later change made elsewhere
  // (another engine, a Retry) never keeps a stale code.
  function setQueueReason(item, code) {
    if (!item) return item;
    if (!Object.prototype.hasOwnProperty.call(REASONS, code)) throw Error('Unknown queue reason: ' + code);
    item.reason = code; item.reasonKey = keyOf(item);
    return item;
  }

  // The code for a prompt now, or null while it is running or done.
  function queueReason(item) {
    if (!item || !TRACKED.includes(item.status)) return null;
    if (item.reason && item.reasonKey === keyOf(item) && REASONS[item.reason]) return item.reason;
    if (item.status === 'skipped' || item.status === 'combined') return item.status;
    if (item.status === 'error') return item.refusedUnchanged ? 'refused_twice' : classifyQueueError(item.detail);
    if (item.repairPendingError) return 'repair_pending';
    if (item.quotaSoloRetry && !item.retryAt) return 'solo_retry';
    if (item.retryAt) return 'retry_scheduled';
    return 'waiting';
  }

  // {code: count} for the waiting and failed prompts (the AI assistant's status).
  function queueReasonCounts(items) {
    const out = {};
    for (const item of items || []) { const code = queueReason(item); if (code) out[code] = (out[code] || 0) + 1; }
    return out;
  }

  const api = {REASONS, WAITING, FAILED, classifyQueueError, setQueueReason, queueReason, queueReasonCounts};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QueueReasons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
