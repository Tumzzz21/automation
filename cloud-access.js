const CLOUD_REPAIR_URL = 'http://127.0.0.1:8787';  // our own local server
function cloudRandomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
let cloudConnectionPending;
async function connectCloudRepair() {
  if (cloudConnectionPending) return cloudConnectionPending;
  cloudConnectionPending = (async () => {
    const stored = await chrome.storage.local.get(['cloudInstallationSecret']);
    const installationSecret = stored.cloudInstallationSecret || cloudRandomKey();
    // Keep the installation identity even if the first connection loses its reply.
    await chrome.storage.local.set({cloudInstallationSecret: installationSecret});
    const response = await repairFetch(CLOUD_REPAIR_URL + '/access/register', {method: 'POST', redirect: 'error',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({installationSecret}), signal: AbortSignal.timeout(20000)});
    // A proxy or maintenance page answers with HTML: report the HTTP status instead of a JSON parse error.
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || `Cloud repair connection failed (HTTP ${response.status}). Try again in a few minutes.`);
    if (typeof result.token !== 'string' || result.token.length < 32 || !result.account) throw Error('Invalid cloud repair connection');
    await chrome.storage.local.set({remoteRepairUrl: CLOUD_REPAIR_URL, remoteRepairToken: result.token,
      repairTransport: 'remote', cloudAccessToken: result.token, cloudAccessExpires: result.expires});
    return result;
  })();
  try { return await cloudConnectionPending; } finally { cloudConnectionPending = null; }
}
async function renewCloudRepair(config) {
  const stored = await chrome.storage.local.get(['cloudAccessToken', 'cloudInstallationSecret']);
  // The old address is the same server (domain move 2026-11-15); renewing saves the new one.
  if (sameRepairServer(remoteRepairBase(config.remoteRepairUrl)) !== sameRepairServer(CLOUD_REPAIR_URL) || !stored.cloudInstallationSecret || stored.cloudAccessToken !== config.remoteRepairToken) return false;
  const previous = config.remoteRepairToken;
  const result = await connectCloudRepair(); config.remoteRepairToken = result.token;
  if (typeof document !== 'undefined' && $('remoteRepairToken')?.value === previous) $('remoteRepairToken').value = result.token;
  return true;
}
async function refreshCloudAllowance() {
  if (typeof document === 'undefined' || !$('cloudRepairAllowance')) return;
  try {
    const config = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    if (!config.remoteRepairToken) {
      $('cloudRepairAllowance').textContent = 'Connect once to receive your free daily repair allowance. No login required.';
      if ($('cloudRepairMemory')) $('cloudRepairMemory').hidden = true;
      return;
    }
    const response = await remoteRepairRequest(config, '/account');
    if (response.status !== 200) throw Error(response.body.error || 'Cloud repair connection needs attention');
    const a = response.body;
    $('cloudRepairAllowance').textContent = a.private ? 'Private test connection active.'
      : `${a.remaining} of ${a.limit} repair rounds remaining today. Resets at ${new Date(a.resetsAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}. Limits apply to this installation.`;
    await refreshRepairMemoryStats(config);
  } catch (e) { $('cloudRepairAllowance').textContent = e.message; }
}
// What the repair server has learned for this installation.
function formatRepairMemoryStats(s) {
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return `Repair memory: ${plural(s.confirmedFixes || 0, 'confirmed fix', 'confirmed fixes')} · ${plural(s.learnedSwaps || 0, 'learned word swap', 'learned word swaps')} · ${plural(s.remembered || 0, 'repair', 'repairs')} remembered`
    + ((s.rejected || 0) ? ` · ${plural(s.rejected, 'revision', 'revisions')} Flow still refused` : '') + '.';
}
async function refreshRepairMemoryStats(config) {
  const out = $('cloudRepairMemory');
  if (!out) return;
  try {
    const response = await remoteRepairRequest(config, '/memory');
    // Servers without repair memory answer 404: show nothing rather than an error.
    if (response.status !== 200 || !response.body?.enabled) { out.hidden = true; return; }
    out.textContent = formatRepairMemoryStats(response.body);
    out.hidden = false;
  } catch { out.hidden = true; }
}
if (typeof document !== 'undefined' && document.getElementById('connectCloudRepairBtn')) {
  $('connectCloudRepairBtn').addEventListener('click', async () => {
    const button = $('connectCloudRepairBtn'); button.disabled = true;
    $('repairStatus').textContent = 'Connecting cloud repair…';
    try {
      const result = await connectCloudRepair();
      $('remoteRepairUrl').value = CLOUD_REPAIR_URL; $('remoteRepairToken').value = result.token;
      $('repairTransport').value = 'remote'; $('repairEnabled').checked = true;
      $('repairTransport').dispatchEvent(new Event('change'));
      await chrome.storage.local.set({repairEnabled: true});
      $('repairStatus').textContent = 'Cloud repair connected. No login needed.';
      await testRepairConnection(); await refreshCloudAllowance();
      if (typeof flushRepairMemory === 'function') void flushRepairMemory();
    } catch (e) { $('repairStatus').textContent = e.message; }
    finally { button.disabled = false; }
  });
  $('disconnectCloudRepairBtn').addEventListener('click', async () => {
    try {
      const config = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
      if (config.remoteRepairToken) {
        const response = await remoteRepairRequest(config, '/account/sign-out', {});
        if (response.status !== 200) throw Error(response.body.error || 'Could not disconnect');
      }
      await chrome.storage.local.set({remoteRepairToken: '', cloudAccessToken: '', repairEnabled: false});
      $('remoteRepairToken').value = ''; $('repairEnabled').checked = false; showRepairLight('off');
      $('repairStatus').textContent = 'Cloud repair disconnected. Your daily usage is retained.';
      await refreshCloudAllowance();
    } catch (e) { $('repairStatus').textContent = e.message; }
  });
  $('refreshCloudAllowanceBtn').addEventListener('click', refreshCloudAllowance);
  refreshCloudAllowance();
}
