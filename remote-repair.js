// VPS transport. The server token is a service credential, not an AI API key.
// Domain move (owner 2026-11-15): api.0xflow.app is the 0xFlow server; repair.corethea.com is the same server under
// its old address and keeps answering (the extension still has its host permission).
const REPAIR_NEW_ORIGIN = 'http://127.0.0.1:8787';  // our own local server
const REPAIR_OLD_ORIGIN = '';  // no fallback to the developer's server
function onRepairOrigin(url, origin) { const s = String(url || ''); return s === origin || s.startsWith(origin + '/'); }
// One name for both addresses, so work saved under the old address still matches the new one.
function sameRepairServer(base) {
  const s = String(base || '');
  return onRepairOrigin(s, REPAIR_OLD_ORIGIN) ? REPAIR_NEW_ORIGIN + s.slice(REPAIR_OLD_ORIGIN.length) : s;
}
// fetch with a backup: when the new address cannot be reached at all (blocked new domain, DNS, or an nginx error page
// without CORS headers), the same request goes once to the old address. HTTP answers and timeouts are never retried,
// so a request the server may already be working on is not sent twice.
async function repairFetch(url, init) {
  try { return await fetch(url, init); }
  catch (e) {
    if (!onRepairOrigin(url, REPAIR_NEW_ORIGIN) || /TimeoutError|AbortError/.test(e?.name || '') || init?.signal?.aborted) throw e;
    return fetch(REPAIR_OLD_ORIGIN + String(url).slice(REPAIR_NEW_ORIGIN.length), init);
  }
}
function remoteRepairBase(value) {
  const url = new URL(String(value || '').trim());
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Use an HTTPS server URL; HTTP is allowed only for local testing');
  }
  return url.href.replace(/\/+$/, '');
}
async function remoteRepairRequest(config, path, body) {
  const base = remoteRepairBase(config.remoteRepairUrl);
  if (!config.remoteRepairToken) throw new Error('Enter your VPS repair access token');
  const request = async () => {
    try { return await repairFetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: {Authorization: 'Bearer ' + config.remoteRepairToken, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    }); } catch (e) {
      const timedOut = /TimeoutError|AbortError/.test(e.name || '') || /signal timed out/i.test(e.message || '');
      throw Object.assign(new Error(timedOut
        ? 'Cloud repair connection timed out; the existing VPS job may still be running'
        : 'Cloud repair connection interrupted; the existing VPS job can be recovered'), {remoteTransportError:true, cause:e});
    }
  };
  let response = await request();
  if (response.status === 401 && typeof renewCloudRepair === 'function' && await renewCloudRepair(config)) response = await request();
  let result;
  try { result = await response.json(); }
  catch (e) { throw Object.assign(new Error('Cloud repair returned an unreadable response; retrying the existing job may recover it'), {remoteTransportError:true,cause:e}); }
  return {status: response.status, body: result};
}
async function remoteRepairCall(config, payload, token) {
  const id = payload.requestId || crypto.randomUUID();
  let result = await remoteRepairRequest(config, '/repair', {...payload, requestId: id});
  if (result.status !== 202) return result;
  const jobId = result.body.jobId;
  if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(jobId)) throw new Error('Invalid VPS repair job ID');
  const deadline = Date.now() + 12 * 60000;
  let connectionFailures = 0;
  while (Date.now() < deadline) {
    if (token !== runToken || stopRequested) throw new Error('Repair cancelled');
    await sleepRepair(1500);
    if (token !== runToken || stopRequested) throw new Error('Repair cancelled');
    try {
      result = await remoteRepairRequest(config, '/jobs/' + jobId);
      if (connectionFailures && typeof log === 'function') log('Cloud repair connection restored; continuing the same VPS repair job.');
      connectionFailures = 0;
    } catch (e) {
      if (token !== runToken || stopRequested) throw new Error('Repair cancelled');
      if (!e.remoteTransportError) throw e;
      connectionFailures += 1;
      if (connectionFailures === 1 && typeof log === 'function') log('Cloud repair connection interrupted; reconnecting to the same VPS job without starting another repair round.');
      if (connectionFailures >= 6) throw new Error('Cloud repair connection remained unavailable. Press Retry to recover the same VPS job; your original prompt is retained.');
      await sleepRepair(Math.min(10000, connectionFailures * 2000));
      continue;
    }
    if (token !== runToken || stopRequested) throw new Error('Repair cancelled');
    if (result.status !== 202) return result;
  }
  throw new Error('Waiting for the VPS repair exceeded 12 minutes. Press Retry to recover the existing job.');
}
