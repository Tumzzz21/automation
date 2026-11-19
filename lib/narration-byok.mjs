// Story Workspace → 🎙 Narration with the member's OWN voice API key (owner 2026-11-11, Pro only): Google AI Studio
// (Gemini speech) or ElevenLabs. The key is kept in chrome.storage.local on this computer and sent only to that
// provider, straight from the extension; our server never sees it and pays nothing. Only the reviewed narration text
// is sent. Same panel contract as story-narration-generate.mjs ({opened, render, stop, available}).
import * as N from './story-narration.mjs';
import {generationRequest, estimateSeconds, speechSeconds} from './story-narration-generate.mjs';
import {inspectNarration} from './story-render.mjs';

export const KEYS = 'narrationApiKeys';          // {google: {key, model}, elevenlabs: {key, model}}
export const MAX_TAKE_SECONDS = 300, MAX_TEXT = 15000;
export const PROVIDERS = {
  google: {label: 'Google AI Studio', keyUrl: 'https://aistudio.google.com/apikey'},
  elevenlabs: {label: 'ElevenLabs', keyUrl: 'https://elevenlabs.io/app/settings/api-keys', origins: ['https://api.elevenlabs.io/*']}};
// Gemini's prebuilt voices, the same picks as the server pilot (owner auditioned them on TEST, 2026-10-31).
export const GOOGLE_VOICES = [
  {id: 'calm-male', label: 'Calm male', voice: 'Charon'}, {id: 'warm-female', label: 'Warm female', voice: 'Kore'},
  {id: 'bright-male', label: 'Bright male', voice: 'Puck'}, {id: 'soft-female', label: 'Soft female', voice: 'Aoede'},
  {id: 'grizzled-detective', label: 'Grizzled Detective · low, gravelly', voice: 'Algenib'}, {id: 'meditation-guide', label: 'Meditation Guide · airy, soothing', voice: 'Enceladus'},
  {id: 'hype-announcer', label: 'Hype Announcer · big energy', voice: 'Fenrir'}, {id: 'regal-monarch', label: 'Regal Monarch · poised, commanding', voice: 'Gacrux'},
  {id: 'late-night-dj', label: 'Late-Night DJ · smooth, velvety', voice: 'Algieba'}, {id: 'cheeky-sidekick', label: 'Cheeky Sidekick · bright, playful', voice: 'Sadachbia'}];
export const ELEVEN_MODELS = [{id: 'eleven_multilingual_v2', label: 'Multilingual v2'}, {id: 'eleven_v3', label: 'v3 · expressive'}, {id: 'eleven_flash_v2_5', label: 'Flash v2.5 · cheaper'}];
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/', ELEVEN = 'https://api.elevenlabs.io/v1/';

// Scenes as paragraphs, like the server pilot (only scenes with a line).
export const storyText = body => body.scenes.filter(s => s.text).map(s => s.text).join('\n\n');

export function wavFromPcm(pcm, sampleRate) {
  const header = new ArrayBuffer(44), v = new DataView(header), text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); text(8, 'WAVE'); text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, pcm.length, true);
  return new Blob([header, pcm], {type: 'audio/wav'});
}
const bytesOf = b64 => { const s = atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

// The newest Flash speech model this key can use (Pro speech models cost more); null when the key has none.
export function pickGoogleModel(models) {
  const tts = (models || []).filter(m => /tts/i.test(m.name || '') && (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
  const version = n => (/(\d+(?:\.\d+)?)/.exec(n)?.[1] || '0') * 1;
  return tts.sort((a, b) => (/flash/i.test(b) - /flash/i.test(a)) || (version(b) - version(a)) || a.localeCompare(b))[0] || null;
}

// Plain words for what the provider said (never the key, never the raw body).
export function providerError(provider, status, body) {
  const who = PROVIDERS[provider].label, detail = String(body?.error?.message || body?.detail?.message || body?.detail?.status || (typeof body?.detail === 'string' ? body.detail : '') || '');
  if (provider === 'elevenlabs' && /quota|credit|limit/i.test(detail + ' ' + (body?.detail?.status || ''))) return 'Not enough ElevenLabs credits for this narration. Add credits in ElevenLabs or shorten the lines.';
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid/i.test(detail)) return 'The ' + who + ' key is not valid. Check it and save it again.';
  if (status === 403) return provider === 'google' ? 'This Google key cannot use speech. Make a new key in Google AI Studio.' : 'This ElevenLabs key has no Text to Speech permission. Turn it on for the key in ElevenLabs.';
  if (status === 429) return provider === 'google' ? 'Google\'s limit for this key was reached (free keys have a small daily limit). Try later, or turn on billing in Google AI Studio.' : 'ElevenLabs is busy or your plan\'s limit was reached. Try again in a minute.';
  if (status === 402) return 'Your ' + who + ' account needs payment or credits for this.';
  if (status >= 500) return who + ' had a problem. The voice may not have been made; try again in a minute.';
  return who + ' refused the request' + (detail ? ': ' + detail.slice(0, 160) : '.');
}
async function call(fetchImpl, provider, url, init, timeoutMs = 30000) {
  let r;
  try { r = await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeoutMs)}); }
  catch { throw Object.assign(Error('No answer from ' + PROVIDERS[provider].label + '. If you pressed Generate, the voice may still have been made and charged: check your usage there before trying again.'), {transport: true}); }
  if (!r.ok) throw Object.assign(Error(providerError(provider, r.status, await r.json().catch(() => null))), {status: r.status});
  return r;
}

export function googleProvider({key, model, fetchImpl = globalThis.fetch}) {
  const headers = {'x-goog-api-key': key, 'Content-Type': 'application/json'};
  return {
    id: 'google',
    async test() {
      const list = await (await call(fetchImpl, 'google', GOOGLE + 'models?pageSize=1000', {headers})).json();
      const picked = pickGoogleModel(list.models);
      if (!picked) throw Error('This Google key has no speech (TTS) model. Make a key in Google AI Studio.');
      return {model: picked};
    },
    async voices() { return GOOGLE_VOICES.map(v => ({id: v.id, label: v.label})); },
    async synthesize({text, voiceId}) {
      const voice = GOOGLE_VOICES.find(v => v.id === voiceId) || GOOGLE_VOICES[0];
      // Current speech models read ALL text aloud (TEST 2026-10-31), so no style line is added.
      const r = await call(fetchImpl, 'google', GOOGLE + 'models/' + encodeURIComponent(model) + ':generateContent', {method: 'POST', headers,
        body: JSON.stringify({contents: [{parts: [{text}]}], generationConfig: {responseModalities: ['AUDIO'], speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: voice.voice}}}}})}, 240000);
      const body = await r.json().catch(() => null), part = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
      if (!part) throw Error('Google returned no audio. Try again, or shorten the lines.');
      const mime = String(part.inlineData.mimeType || ''), raw = bytesOf(part.inlineData.data);
      if (/^audio\/(wav|x-wav)/i.test(mime)) return new Blob([raw], {type: 'audio/wav'});
      const rate = Number(/rate=(\d+)/.exec(mime)?.[1] || 24000);
      if (!/^audio\/(L16|pcm)/i.test(mime) || rate < 8000 || rate > 48000 || !raw.length || raw.length % 2) throw Error('Google returned audio in an unexpected format.');
      return wavFromPcm(raw, rate);
    }};
}

export function elevenLabsProvider({key, model = ELEVEN_MODELS[0].id, fetchImpl = globalThis.fetch}) {
  const headers = {'xi-api-key': key, 'Content-Type': 'application/json'};
  const list = async () => ((await (await call(fetchImpl, 'elevenlabs', ELEVEN + 'voices', {headers})).json()).voices || []);
  return {
    id: 'elevenlabs',
    async test() { await list(); return {model: ELEVEN_MODELS.some(m => m.id === model) ? model : ELEVEN_MODELS[0].id}; },
    // The member's own voice list (premade, library and cloned voices).
    async voices() {
      return (await list()).slice(0, 200).map(v => {
        const l = v.labels || {}, about = [l.gender, l.accent, l.age].filter(Boolean).join(', ');
        return {id: String(v.voice_id), label: String(v.name || 'Voice').slice(0, 60) + (v.category === 'cloned' || v.category === 'professional' ? ' · your voice' : about ? ' · ' + about : '')};
      }).filter(v => /^[A-Za-z0-9]{8,40}$/.test(v.id));
    },
    async synthesize({text, voiceId}) {
      if (!/^[A-Za-z0-9]{8,40}$/.test(String(voiceId || ''))) throw Error('Choose an ElevenLabs voice.');
      const r = await call(fetchImpl, 'elevenlabs', ELEVEN + 'text-to-speech/' + voiceId + '?output_format=mp3_44100_128', {method: 'POST', headers, body: JSON.stringify({text, model_id: model})}, 240000);
      const blob = await r.blob();
      if (!blob.size) throw Error('ElevenLabs returned no audio. Try again.');
      return new Blob([blob], {type: 'audio/mpeg'});
    }};
}
export const providerFor = (id, saved, fetchImpl) => id === 'elevenlabs' ? elevenLabsProvider({key: saved.key, model: saved.model, fetchImpl}) : googleProvider({key: saved.key, model: saved.model, fetchImpl});

// Paid Pro only (owner 2026-11-11), as the server reports the plan; the key and its charges stay the member's own.
export async function proAccount(client) { try { return (await client.request('/auth/me'))?.plan === 'pro'; } catch { return false; } }

export function createByokGenerator({storage = globalThis.chrome?.storage?.local, fetchImpl = (...a) => globalThis.fetch(...a), permissions = globalThis.chrome?.permissions, inspect = inspectNarration, confirmFn = q => confirm(q)} = {}) {
  const $ = id => document.getElementById(id), node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  let api = null, keys = {}, provider = 'google', voices = {}, voicesError = '', choice = {}, editing = false, working = '', run = 0;

  async function opened(a) {
    api = a; const mine = ++run;
    keys = (await storage.get(KEYS))[KEYS] || {};
    if (mine !== run) return;
    if (!keys[provider]?.key) provider = Object.keys(PROVIDERS).find(p => keys[p]?.key) || provider;
    editing = false; render(); loadVoices();
  }
  function stop() { run++; }
  async function loadVoices(force = false) {
    const p = provider, saved = keys[p]; if (!saved?.key || (voices[p] && !force)) return;
    voicesError = '';
    try { voices[p] = await providerFor(p, saved, fetchImpl).voices(); } catch (e) { voicesError = e.message; }
    if (!choice[p] || !voices[p]?.some(v => v.id === choice[p])) choice[p] = voices[p]?.[0]?.id;
    render();
  }
  const label = () => PROVIDERS[provider].label;

  function render(a = api) {
    const box = $('narrGenerate'); if (!box || !a?.draft()) return;
    box.hidden = false; box.replaceChildren();
    const head = node('div', undefined, 'narr-gen-row'), service = node('label', 'Voice service'), pick = node('select');
    for (const [id, p] of Object.entries(PROVIDERS)) { const o = node('option', p.label + (keys[id]?.key ? '' : ' · add key')); o.value = id; pick.append(o); }
    pick.value = provider; pick.disabled = !!working; pick.onchange = () => { provider = pick.value; editing = false; render(); loadVoices(); };
    service.append(pick); head.append(service); box.append(head);
    if (working) { box.append(node('p', working, 'narr-gen-state')); return; }
    if (!keys[provider]?.key || editing) return keyForm(box);
    const list = voices[provider], row = node('div', undefined, 'narr-gen-row');
    if (!list) box.append(node('p', voicesError || 'Loading your voices…', 'narr-gen-state' + (voicesError ? ' error' : '')));
    else {
      const v = node('label', 'Voice'), s = node('select');
      for (const x of list) { const o = node('option', x.label); o.value = x.id; s.append(o); }
      s.value = choice[provider] || ''; s.onchange = () => { choice[provider] = s.value; render(); }; v.append(s); row.append(v);
      if (provider === 'elevenlabs') {
        const m = node('label', 'Model'), ms = node('select');
        for (const x of ELEVEN_MODELS) { const o = node('option', x.label); o.value = x.id; ms.append(o); }
        ms.value = keys.elevenlabs.model || ELEVEN_MODELS[0].id; ms.onchange = async () => { keys.elevenlabs = {...keys.elevenlabs, model: ms.value}; await storage.set({[KEYS]: keys}); };
        m.append(ms); row.append(m);
      }
      const body = generationRequest(a.draft(), a.order(), {voiceId: choice[provider]}, 'byok'), est = estimateSeconds(body), text = storyText(body);
      const go = node('button', 'Generate', 'primary'); go.type = 'button'; go.disabled = !est || !choice[provider] || est > MAX_TAKE_SECONDS || text.length > MAX_TEXT;
      go.onclick = () => generate().catch(e => { working = ''; api.info(e.message, true); render(); });
      row.append(go); box.append(row);
      // Will it fit the clips? Measured for Google's voices; other voices count as a little slow (takes vary).
      const clips = a.clipSeconds?.() || 0, speak = speechSeconds(body, provider === 'google' ? choice.google : '');
      if (clips && est) box.append(node('small', speak > clips ? 'This narration will run about ' + speak + ' s, longer than the ' + Math.round(clips) + ' s of clips. Shorten the lines first.' : speak < clips * 0.8 ? 'About ' + speak + ' s of narration for ' + Math.round(clips) + ' s of clips: there will be quiet stretches. Add a few words to the lines.' : 'About ' + speak + ' s of narration, a good fit for the ' + Math.round(clips) + ' s of clips.', 'trim-note' + (speak > clips ? ' narr-issue' : '')));
      if (est > MAX_TAKE_SECONDS || text.length > MAX_TEXT) box.append(node('small', 'One take can be up to ' + MAX_TAKE_SECONDS + ' s. Shorten the lines.', 'trim-note narr-issue'));
    }
    const foot = node('small', 'Charged to your ' + label() + ' account, not your 0xFlow plan' + (provider === 'google' && keys.google?.model ? ' · model ' + keys.google.model : '') + '. Only the narration text is sent. ', 'trim-note');
    const change = node('button', 'Change key', 'link-button'), remove = node('button', 'Remove key', 'link-button'); change.type = remove.type = 'button';
    change.onclick = () => { editing = true; render(); };
    remove.onclick = async () => { if (!confirmFn('Remove your ' + label() + ' key from this computer?')) return; delete keys[provider]; delete voices[provider]; await storage.set({[KEYS]: keys}); render(); };
    foot.append(change, ' · ', remove); box.append(foot);
  }
  function keyForm(box) {
    const p = PROVIDERS[provider], form = node('div', undefined, 'narr-gen-row narr-key-row'), input = node('input');
    input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = p.label + ' API key'; input.setAttribute('aria-label', p.label + ' API key');
    const save = node('button', 'Save key', 'primary'); save.type = 'button';
    save.onclick = () => saveKey(input.value).catch(e => { working = ''; render(); api.info(e.message, true); });
    form.append(input, save);
    if (editing) { const cancel = node('button', 'Cancel'); cancel.type = 'button'; cancel.onclick = () => { editing = false; render(); }; form.append(cancel); }
    const get = node('a', 'Get a key'); get.href = p.keyUrl; get.target = '_blank'; get.rel = 'noopener';
    const note = node('small', 'Use your own ' + p.label + ' key: the voice is charged to your ' + p.label + ' account. The key is saved only on this computer and sent only to ' + p.label + '. ', 'trim-note');
    note.append(get); box.append(form, note);
  }
  async function saveKey(value) {
    const key = String(value || '').trim();
    if (!/^[\x21-\x7e]{20,200}$/.test(key)) throw Error('Paste the whole API key.');
    // Chrome asks once to allow api.elevenlabs.io (an optional site permission; asked here, on the click).
    const origins = PROVIDERS[provider].origins;
    if (origins && permissions && !(await permissions.request({origins}).catch(() => false))) throw Error('Allow 0xFlow to reach ' + label() + ' to use this key.');
    working = 'Checking the key with ' + label() + '…'; render();
    const checked = await providerFor(provider, {key, model: keys[provider]?.model}, fetchImpl).test();
    keys = {...keys, [provider]: {key, model: checked.model}}; await storage.set({[KEYS]: keys});
    working = ''; editing = false; delete voices[provider]; render(); api.info('Key saved. Choose a voice and press Generate.');
    await loadVoices(true);
  }

  async function generate() {
    const a = api, order = a.order(), draft = a.draft(), p = provider, saved = keys[p], voiceId = choice[p];
    const body = generationRequest(draft, order, {voiceId}, 'byok'), est = estimateSeconds(body), text = storyText(body);
    const voice = voices[p]?.find(v => v.id === voiceId)?.label || voiceId;
    if (!confirmFn('Make an AI narration with ' + PROVIDERS[p].label + '?\n\n' + voice + ' · about ' + est + ' s · ' + text.length + ' characters.\nThis is charged to your ' + PROVIDERS[p].label + ' account. Only the narration text is sent.')) return;
    const mine = ++run; working = 'Making the voice with ' + PROVIDERS[p].label + '… keep this window open.'; render();
    const blob = await providerFor(p, saved, fetchImpl).synthesize({text, voiceId});
    const meta = await inspect(blob);
    const take = {id: N.newTakeId(), source: p, voiceId, model: saved.model || '', name: (voice + ' · ' + PROVIDERS[p].label).slice(0, 120), mimeType: blob.type, durationSeconds: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, bytes: blob.size, scriptHash: N.scriptHash(draft.draft, order), createdAt: Date.now()};
    working = '';
    if (mine !== run || !a.draft()) return;   // the window was closed: nothing to attach to
    await a.addTake(take, blob); render();
  }
  return {opened, render, stop, available: () => true};
}
