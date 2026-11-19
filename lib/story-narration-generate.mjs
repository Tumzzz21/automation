// Story Workspace → 🎙 Narration → Generate (AI narration plan, owner 2026-10-31, Phase 3). Asks our server for one
// narration take of the reviewed text; the server alone talks to Google and enforces allowance and budget. Pilot only:
// story-workspace.js passes this generator in when chrome.storage.local narrationPilot === true, and the section stays
// hidden whenever the server says narration is unavailable (the default: narrationEnabled is off).
import * as N from './story-narration.mjs';
import * as F from './story-finish.mjs';
import {inspectNarration} from './story-render.mjs';

export const jobKey = projectId => 'narrationJob:' + projectId;
const DELIVERY_LABELS = {calm: 'Calm', warm: 'Warm', curious: 'Curious', serious: 'Serious'};

// The request body for POST /narration/jobs: only the reviewed narration text per scene (in story order) and the choices.
export function generationRequest(draft, order, {voiceId, language, delivery}, requestId) {
  return {requestId, voiceId, language, delivery, revision: draft.draft.revision || 1,
    scenes: order.map(id => ({id, text: F.spokenText(draft.draft.sceneTexts[id] || '').replace(/\s+/g, ' ').trim()}))};
}
// Same estimate as the server (a slow narrator plus pauses), so the number shown before confirming matches the charge.
export function estimateSeconds(body) {
  const words = body.scenes.reduce((n, s) => n + (s.text ? s.text.split(' ').length : 0), 0);
  return words ? Math.ceil(words / 2.2 * 1.15) + 1 : 0;
}

// How long each voice really speaks (owner 2026-10-31: text that fit with Hype Announcer ran over with Grizzled
// Detective). Measured on TEST: Hype Announcer reads about 2.4 words a second with pauses; the others relative to it from
// one shared sample sentence. Voices not measured yet count as a little slow. An estimate only: takes vary.
export const VOICE_PACE = {'hype-announcer': 1, 'meditation-guide': 0.98, 'grizzled-detective': 1.1, 'cheeky-sidekick': 1.15, 'late-night-dj': 1.16, 'regal-monarch': 1.25};
export function speechSeconds(body, voiceId) {
  const words = body.scenes.reduce((n, s) => n + (s.text ? s.text.split(' ').length : 0), 0);
  return Math.round(words / 2.4 * (VOICE_PACE[voiceId] || 1.1) * 10) / 10;
}
const paceWord = id => (VOICE_PACE[id] || 1.1) >= 1.15 ? ' · slow' : (VOICE_PACE[id] || 1.1) <= 1 ? ' · brisk' : '';

function base(value) {
  const url = new URL(String(value || '').trim()), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw Error('The server address is not valid.');
  return url.href.replace(/\/+$/, '');
}
// Our server only (the Auto-Fix connection). Never a Google key in the extension.
export function serverClient(storage = globalThis.chrome?.storage?.local, fetchImpl = globalThis.fetch) {
  async function call(path, body, raw = false) {
    const c = await storage.get(['remoteRepairUrl', 'remoteRepairToken']);
    if (!c.remoteRepairUrl || !c.remoteRepairToken) throw Object.assign(Error('Connect cloud repair in the Auto-Fix tab first.'), {code: 'NO_SERVER'});
    const root = base(c.remoteRepairUrl);let r;
    try { r = await fetchImpl(root + path, {method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: {Authorization: 'Bearer ' + c.remoteRepairToken, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)}); }
    catch { throw Object.assign(Error('Could not reach the server. Your request may still be running; open Narration again to check.'), {transport: true}); }
    if (raw && r.ok) return r.blob();
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(j.error || 'The server could not do this (' + r.status + ').'), {status: r.status, code: j.code});
    return j;
  }
  // request: other features on the same connection (Flow accounts dashboard, Telegram alerts).
  return {request: (path, body) => call(path, body), capabilities: () => call('/narration/capabilities'), create: body => call('/narration/jobs', body), job: id => call('/narration/jobs/' + id),
    audio: id => call('/narration/jobs/' + id + '/audio', undefined, true), cancel: id => call('/narration/jobs/' + id + '/cancel', {})};
}

// What the Voice step says when the monthly allowance cannot cover a take (owner 2026-10-31: Pro gets 300 s a month).
export function allowanceText(allowance, est) {
  const back = allowance.resetsAt ? new Date(allowance.resetsAt).toLocaleDateString(undefined, {month: 'long', day: 'numeric'}) : 'next month';
  if (!(allowance.limitSeconds > 0)) return 'AI narration is included with Pro. You can still import your own narration.';
  return allowance.remainingSeconds < 1
    ? 'You have used all ' + Math.round(allowance.limitSeconds) + ' s of AI narration for this month. It comes back on ' + back + '. You can still import your own narration.'
    : 'This narration needs about ' + est + ' s, but only ' + Math.floor(allowance.remainingSeconds) + ' s are left this month (back to ' + Math.round(allowance.limitSeconds) + ' s on ' + back + '). Shorten the lines or import your own narration.';
}

export function createNarrationGenerator({client = serverClient(), storage = globalThis.chrome?.storage?.local, inspect = inspectNarration, pollMs = 2500, confirmFn = q => confirm(q)} = {}) {
  const $ = id => document.getElementById(id), node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  let caps = null, capsError = '', loading = false, job = null, timer = 0, api = null, choice = {}, run = 0;

  async function opened(a) {
    api = a; const mine = ++run; caps = null; capsError = ''; loading = true; job = null; clearTimeout(timer); render(a);
    try { caps = await client.capabilities(); } catch (e) { capsError = e.message; }
    if (mine !== run) return;
    loading = false;
    choice = {voiceId: choice.voiceId || caps?.voices?.[0]?.id, language: choice.language || (caps?.languages?.includes(a.language?.()) ? a.language() : caps?.languages?.[0]), delivery: choice.delivery || caps?.deliveries?.[0]};
    // A request made from another panel (or before a reload) for this story: show it and keep checking it.
    const pending = (await storage.get(jobKey(a.projectId())))[jobKey(a.projectId())];
    if (pending?.jobId && caps) { job = {id: pending.jobId, state: 'queued', detail: 'Checking…'}; poll(mine, pending); }
    render(a); a.redrawTakes?.();
  }
  function stop() { run++; clearTimeout(timer); }

  function render(a = api) {
    const box = $('narrGenerate'); if (!box || !a?.draft()) return;
    // Unavailable (the default): hide the whole section; importing your own narration still works.
    box.hidden = !loading && !caps?.available && !job;
    box.replaceChildren(); if (box.hidden) return;
    if (loading) { box.append(node('p', 'Checking AI voices…', 'trim-note')); return; }
    if (job) {
      box.append(node('p', jobText(job), 'narr-gen-state' + (['failed', 'invalid', 'unknown'].includes(job.state) ? ' error' : '')));
      if (['queued'].includes(job.state)) { const c = node('button', 'Cancel request'); c.type = 'button'; c.onclick = () => cancel().catch(e => a.info(e.message, true)); box.append(c); }
      if (['failed', 'invalid', 'cancelled', 'unknown'].includes(job.state)) { const d = node('button', 'Dismiss'); d.type = 'button'; d.onclick = () => forget().then(() => render()); box.append(d); }
      return;
    }
    const row = node('div', undefined, 'narr-gen-row');
    const pick = (title, key, list, labelOf) => { const f = node('label', title), s = node('select'); for (const v of list || []) { const o = node('option', labelOf(v)); o.value = typeof v === 'object' ? v.id : v; s.append(o); } s.value = choice[key] || ''; s.onchange = () => { choice[key] = s.value; render(); }; f.append(s); return f; };
    row.append(pick('Voice', 'voiceId', caps.voices, v => v.label + paceWord(v.id)), ...(caps.deliveries?.length ? [pick('Delivery', 'delivery', caps.deliveries, v => DELIVERY_LABELS[v] || v)] : []), pick('Language', 'language', caps.languages, v => v));
    const body = generationRequest(a.draft(), a.order(), choice, 'preview'), est = estimateSeconds(body), allowance = caps.allowance;
    const go = node('button', 'Generate', 'primary'); go.type = 'button'; // Monthly allowance (owner 2026-10-31, Pro 300 s): when it is used up, Generate is off until it resets; importing still works.
    const usedUp = !!allowance && allowance.remainingSeconds < 1, short = !!allowance && !usedUp && est > allowance.remainingSeconds;
    go.disabled = !est || est > caps.maxStorySeconds || usedUp || short;
    go.onclick = () => generate().catch(e => { a.info(e.message, true); render(); });
    // Will this voice fit the clips? Said before any money is spent; it does not block (takes vary).
    const clips = a.clipSeconds?.() || 0, speak = speechSeconds(body, choice.voiceId), fit = !clips || !est ? null
      : speak > clips ? node('small', 'With this voice the narration will run about ' + speak + ' s, longer than the ' + Math.round(clips) + ' s of clips. Choose a faster voice or shorten the lines first.', 'trim-note narr-issue')
      : speak < clips * 0.8 ? node('small', 'With this voice the narration will run about ' + speak + ' s for ' + Math.round(clips) + ' s of clips, so there will be quiet stretches. Add a few words to the lines, or choose a slower voice.', 'trim-note')
      : node('small', 'With this voice the narration will run about ' + speak + ' s, a good fit for the ' + Math.round(clips) + ' s of clips.', 'trim-note');
    row.append(go);
    if (usedUp || short) { box.append(row, node('small', allowanceText(allowance, est), 'trim-note narr-issue'), node('small', caps.privacy, 'trim-note')); return; }
    box.append(row, ...(fit ? [fit] : []), node('small', 'Uses up to ' + est + ' s of your monthly AI narration' + (allowance ? ' · ' + Math.floor(allowance.remainingSeconds) + ' s left this month' : '') + (est > caps.maxStorySeconds ? ' · the limit is ' + caps.maxStorySeconds + ' s per story' : ''), 'trim-note'), node('small', caps.privacy, 'trim-note'));
  }
  function jobText(j) {
    if (j.state === 'succeeded') return 'Ready. Saving the take…';
    if (j.state === 'unknown') return (j.detail || 'Still checking') + '. It is not sent again; contact support if it does not appear.';
    if (j.state === 'invalid') return (j.detail || 'The audio could not be used') + '. You can import your own narration instead.';
    if (j.state === 'failed') return (j.detail || 'Not made') + ' Your monthly narration time was not used.';
    return j.detail || j.state;
  }

  async function generate() {
    const a = api, order = a.order(), draft = a.draft(), requestId = 'narr_' + crypto.randomUUID().replace(/-/g, ''), body = generationRequest(draft, order, choice, requestId);
    const est = estimateSeconds(body), voice = caps.voices.find(v => v.id === choice.voiceId)?.label || choice.voiceId;
    if (!confirmFn('Make an AI narration of this text?\n\n' + voice + ' · ' + choice.language + ' · about ' + est + ' s.\nIt uses about ' + est + ' s of your monthly AI narration. Only the narration text is sent.')) return;
    const pending = {requestId, body, scriptHash: N.scriptHash(draft.draft, order), voiceId: choice.voiceId, at: Date.now()};
    // Saved before sending: a second panel or a reload rejoins this request (same requestId) instead of paying twice.
    await storage.set({[jobKey(a.projectId())]: pending});
    const mine = ++run, j = await client.create(body);
    pending.jobId = j.id; await storage.set({[jobKey(a.projectId())]: pending});
    job = j; render(); poll(mine, pending);
  }
  function poll(mine, pending) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (mine !== run) return;
      try { job = await client.job(pending.jobId); } catch (e) { if (e.status === 404) { await forget(); api.info('That narration request is no longer on the server.', true); render(); return; } }
      if (mine !== run) return;
      if (job?.ready) { await collect(job, pending).catch(e => api.info(e.message, true)); return; }
      render();
      if (['queued', 'submitting'].includes(job?.state) || !job) poll(mine, pending);
    }, pollMs);
  }
  async function collect(j, pending) {
    const blob = await client.audio(j.id), meta = await inspect(blob);
    const take = {id: N.newTakeId(), source: 'google', jobId: j.id, voiceId: j.voiceId || pending.voiceId, model: j.model || '', name: caps?.voices?.find(v => v.id === (j.voiceId || pending.voiceId))?.label || '', mimeType: blob.type || 'audio/wav', durationSeconds: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, bytes: blob.size, scriptHash: pending.scriptHash, createdAt: Date.now()};
    // The take belongs to the text it was made from; if the text changed since, narrationState() asks for a new take.
    if (api.draft()?.takes?.some(t => t.jobId === j.id)) { await forget(); render(); return; }
    await api.addTake(take, blob); await forget(); job = null;
    render();   // addTake placed the scenes and reported how they fit.
  }
  async function cancel() { if (!job?.id) return; job = await client.cancel(job.id); if (job.state === 'cancelled') await forget(); render(); }
  async function forget() { job = null; clearTimeout(timer); if (api) await storage.remove(jobKey(api.projectId())); }

  return {opened, render, stop, available: () => !!caps?.available};
}
