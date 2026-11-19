// Private cloud learning uses server-owned job IDs and extension-observed outcomes.
// The feedback outbox contains hashes and warning text, never access tokens or prompts.
let memoryWrite = Promise.resolve(), memoryFlush = null;
// Entries for another server or installation are only flushed while that
// connection is active; drop them after the server's job memory would expire.
const MEMORY_OUTBOX_MAX_AGE_MS = 14 * 86400000, MEMORY_OUTBOX_LIMIT = 100;
function pruneRepairMemoryOutbox(queue, now = Date.now()) {
  const fresh = queue.filter(entry => Number.isFinite(entry.at) && now - entry.at < MEMORY_OUTBOX_MAX_AGE_MS);
  return fresh.slice(-MEMORY_OUTBOX_LIMIT);
}
async function queueRepairFeedback(config, owner, body) {
  memoryWrite = memoryWrite.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(['repairMemoryOutbox']);
    const key = body.jobId + ':' + body.generationId;
    let queue = pruneRepairMemoryOutbox(stored.repairMemoryOutbox || []);
    if (!queue.some(entry => entry.key === key)) {
      // Oldest feedback is dropped first; a full outbox never blocks new outcomes.
      queue = pruneRepairMemoryOutbox([...queue, {key, base: remoteRepairBase(config.remoteRepairUrl), owner, body, at: Date.now()}]);
    }
    await chrome.storage.local.set({repairMemoryOutbox: queue});
  });
  await memoryWrite;
  void flushRepairMemory();
}
async function flushRepairMemory() {
  if (memoryFlush) return memoryFlush;
  memoryFlush = (async () => {
    const config = await chrome.storage.local.get(['repairTransport', 'remoteRepairUrl', 'remoteRepairToken', 'repairMemoryOutbox']);
    if (config.repairTransport !== 'remote' || !config.remoteRepairToken || !config.repairMemoryOutbox?.length) return;
    const account = await remoteRepairRequest(config, '/account');
    if (account.status !== 200) return;
    const owner = account.body.private ? 'private-owner' : account.body.installationId;
    const base = remoteRepairBase(config.remoteRepairUrl);
    for (let attempt = 0; attempt < 100; attempt++) {
      await memoryWrite;
      const stored = await chrome.storage.local.get(['repairMemoryOutbox']);
      const next = (stored.repairMemoryOutbox || []).find(entry => sameRepairServer(entry.base) === sameRepairServer(base) && entry.owner === owner);
      if (!next) break;
      const response = await remoteRepairRequest(config, '/outcome', next.body);
      if (response.status !== 200 && ![400, 404, 409].includes(response.status)) break;
      memoryWrite = memoryWrite.catch(() => {}).then(async () => {
        const latest = await chrome.storage.local.get(['repairMemoryOutbox']);
        await chrome.storage.local.set({repairMemoryOutbox: (latest.repairMemoryOutbox || []).filter(entry => entry.key !== next.key || entry.base !== next.base || entry.owner !== next.owner)});
      });
      await memoryWrite;
      if (response.status === 200) log(`Private repair memory: ${next.body.outcome === 'generated' ? 'Flow generated the revised prompt — confirmed fix remembered' : 'Flow rejected this revision — failed attempt remembered'}.`);
      else log(`Private repair memory feedback skipped: ${response.body?.error || 'result could not be matched'}.`);
    }
  })().catch(e => { log(`Private repair memory feedback retained for retry: ${e.message}.`); });
  try { return await memoryFlush; } finally { memoryFlush = null; }
}
async function reportCloudRepairOutcome(item, {passed = true, warning = ''} = {}) {
  try {
    const trace = {...item?._cloudRepairMemory};
    if (!trace?.jobId || !trace.generationId || trace.revised !== item.text || trace.revised !== item.generationText) return;
    // runPrompt reports success when Flow confirms the result and again after saving;
    // send each generation's outcome once.
    const reportKey = `${trace.jobId}:${trace.generationId}:${passed ? 'generated' : 'policy_rejected'}`;
    if (item._cloudRepairMemory.reported === reportKey) return;
    item._cloudRepairMemory.reported = reportKey;
    const config = await chrome.storage.local.get(['repairTransport', 'remoteRepairUrl', 'remoteRepairToken']);
    if (config.repairTransport !== 'remote' || sameRepairServer(remoteRepairBase(config.remoteRepairUrl)) !== sameRepairServer(trace.base)) return;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(trace.revised));
    const revisionHash = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    await queueRepairFeedback(config, trace.owner, {jobId: trace.jobId, generationId: trace.generationId, revisionHash,
      outcome: passed ? 'generated' : 'policy_rejected', warning: passed ? '' : String(warning).slice(0, 2000)});
  } catch (e) { log(`Private repair memory feedback could not be saved: ${e.message}.`); }
}
// Pending feedback retries when the panel opens, independently of any diagnostics UI.
if (typeof document !== 'undefined') void flushRepairMemory();
