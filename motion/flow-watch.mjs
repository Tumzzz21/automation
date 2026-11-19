// Listen-only view of Flow's own replies (owner 2026-11-12, "build it").
// Flow's page talks to Google through batchexecute calls: Generate (YhhmEf) answers with the new video's record, Flow
// itself polls that record every 5 s (jwpduf), and Download asks for it again (as29s). The finished record carries the
// signed flow-content.google/video link and the poster image. We READ those replies through the Chrome debugger Network
// domain that Motion already attaches for its clicks; nothing is sent to Google and nothing in the page changes.
// Learned from our own Flow traffic only (Anna profile recording, 2026-11-12), never from another product's code.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VIDEO_URL = /^https:\/\/flow-content\.google\/video\/[0-9a-f-]{36}(?:[?#]|$)/i;
export const POSTER_URL = /^https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/image\/[0-9a-f-]{36}/i;
// Recorded names (an image-reference Generate); every batchexecute reply is read, since other calls carry the same record.
export const WATCHED_RPCS = ['YhhmEf', 'jwpduf', 'as29s'];

// batchexecute reply text -> [{rpc, data}] (each "wrb.fr" frame; data is the decoded inner JSON).
export function rpcFrames(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('[')) continue;
    let items;
    try { items = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!Array.isArray(item) || item[0] !== 'wrb.fr' || typeof item[2] !== 'string') continue;
      try { out.push({rpc: item[1], data: JSON.parse(item[2])}); } catch {}
    }
  }
  return out;
}

const strings = (value, found = [], depth = 0) => {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value) && depth < 24) for (const v of value) strings(v, found, depth + 1);
  return found;
};

// A media record is [mediaId, uuid, uuid, null, null, [details…], …] (same shape in all three replies).
export function mediaRecords(data) {
  const out = [], seen = new Set();
  const walk = (v, depth) => {
    if (!Array.isArray(v) || depth > 20) return;
    if (UUID.test(v[0]) && UUID.test(v[1]) && UUID.test(v[2]) && v[3] == null && v[4] == null && Array.isArray(v[5])) {
      if (!seen.has(v[0])) {
        seen.add(v[0]);
        const all = strings(v);
        out.push({id: v[0], video: all.find(s => VIDEO_URL.test(s)) || null, poster: all.find(s => POSTER_URL.test(s)) || null});
      }
      return;
    }
    for (const x of v) walk(x, depth + 1);
  };
  walk(data, 0);
  return out;
}

const rpcsOf = url => { try { return (new URL(url).searchParams.get('rpcids') || '').split(','); } catch { return []; } };

// tabId: the Flow tab Motion already has the debugger attached to.
export function createFlowWatch({tabId, debuggerApi = globalThis.chrome?.debugger, now = Date.now} = {}) {
  const target = {tabId}, pending = new Map(), media = new Map(), before = new Set(), fresh = new Set(), seenRpcs = new Map();
  let armedAt = 0, candidates = null, ambiguous = false, listening = false, notes = [];
  const note = text => { notes.push(text); if (notes.length > 20) notes.shift(); };
  const remember = record => { const old = media.get(record.id) || {}; media.set(record.id, {id: record.id, video: record.video || old.video || null, poster: record.poster || old.poster || null}); };
  async function read(requestId, rpcs) {
    let reply;
    try { reply = await debuggerApi.sendCommand(target, 'Network.getResponseBody', {requestId}); } catch (e) { note('reply not readable: ' + (e?.message || e)); return; }
    const text = reply?.base64Encoded ? atob(reply.body || '') : reply?.body;
    for (const frame of rpcFrames(text)) {
      const records = mediaRecords(frame.data);
      records.forEach(remember);
      if (armedAt) { const k = frame.rpc + ':' + records.length; seenRpcs.set(k, (seenRpcs.get(k) || 0) + 1); }
      if (!armedAt) { records.forEach(r => before.add(r.id)); continue; }
      // The Generate reply that follows our own click names our video.
      if (frame.rpc === 'YhhmEf' && !candidates) {
        if (records.length === 1) candidates = [records[0].id];
        else if (records.length) { ambiguous = true; candidates = records.map(r => r.id); note('Generate reply had ' + records.length + ' videos'); }
      }
      // Motion's Generate (a reference video) may use another call (live test 2026-11-12): the one video that appears
      // for the first time after our click, without a finished link yet, is ours.
      for (const r of records) if (!before.has(r.id) && !media.get(r.id)?.video) fresh.add(r.id);
    }
  }
  // Our video: named by the Generate reply, else the single new video since our click.
  const ours = () => candidates || (fresh.size === 1 ? [...fresh] : null);
  function onEvent(source, method, params) {
    if (source?.tabId !== tabId) return;
    if (method === 'Network.responseReceived') {
      const url = params?.response?.url || '';
      if (!/\/batchexecute\b/.test(url)) return;
      const rpcs = rpcsOf(url);
      if (rpcs.length) pending.set(params.requestId, rpcs);
    } else if (method === 'Network.loadingFinished' && pending.has(params?.requestId)) {
      const rpcs = pending.get(params.requestId); pending.delete(params.requestId);
      read(params.requestId, rpcs);
    } else if (method === 'Network.loadingFailed') pending.delete(params?.requestId);
  }
  return {
    async start() {
      if (listening || !debuggerApi?.onEvent) return false;
      debuggerApi.onEvent.addListener(onEvent); listening = true;
      try { await debuggerApi.sendCommand(target, 'Network.enable', {}); return true; }
      catch (e) { debuggerApi.onEvent.removeListener(onEvent); listening = false; note('Network.enable failed: ' + (e?.message || e)); return false; }
    },
    async stop() {
      if (!listening) return;
      debuggerApi.onEvent.removeListener(onEvent); listening = false;
      await debuggerApi.sendCommand(target, 'Network.disable', {}).catch(() => {});
    },
    // Called right before Motion presses Generate. Network is enabled again: the main engine's Download-menu routine
    // (the fallback) turns it off when it finishes, which would leave the next piece unheard.
    async arm() {
      if (armedAt) for (const id of media.keys()) before.add(id);
      armedAt = now(); candidates = null; ambiguous = false; fresh.clear(); seenRpcs.clear();
      if (listening) await debuggerApi.sendCommand(target, 'Network.enable', {}).catch(e => note('Network.enable failed: ' + (e?.message || e)));
    },
    // {id, video, poster} of our video, or null while unknown. ambiguous: Flow answered with more than one video.
    result() {
      if (ambiguous) return {ambiguous: true};
      if (fresh.size > 1 && !candidates) return {ambiguous: true};
      const c = ours(); if (!c) return null;
      const m = media.get(c[0]);
      return m ? {...m} : {id: c[0], video: null, poster: null};
    },
    // True only when Flow's own Generate reply named our video. The "one new video since our click" guess is not trusted
    // alone (owner run 2026-11-12: after ↻ on piece 1, a new watch had not seen piece 1's video, took it as new and
    // piece 2 got piece 1's video): the runner then needs the page's tile to show the same picture.
    named() { return !ambiguous && !!candidates; },
    get listening() { return listening; },
    notes: () => notes.slice(),
    // One line for the Debug log while Motion waits.
    summary() {
      const r = this.result();
      return 'Flow replies since Generate: ' + ([...seenRpcs].map(([k, n]) => k + 'x' + n).join(' ') || 'none')
        + '; our video: ' + (r?.ambiguous ? 'unclear (' + fresh.size + ' new)' : r?.id ? (r.video ? 'ready' : 'named, not ready') : 'not named yet')
        + (notes.length ? '; ' + notes.slice(-3).join('; ') : '');
    },
  };
}
