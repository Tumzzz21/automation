// Settings tab (owner 2026-10-31; Download folder moved to Storage 2026-11-01; Pro and Discord Pro): the Flow accounts dashboard (every device, its queue and
// what Flow last showed for each Flow account) and the Telegram alerts connection. Queue reports come from our server; numeric credit snapshots stay in this browser.
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const ago = t => { const ms = Date.now() - t; return ms < 90000 ? 'just now' : ms < 3600000 ? Math.round(ms / 60000) + ' min ago' : ms < 172800000 ? Math.round(ms / 3600000) + ' h ago' : Math.round(ms / 86400000) + ' d ago'; };
  const CREDIT = {ok: ['✓ credits OK', 'ok'], low: ['⚠ running low', 'low'], out: ['✕ used up', 'out'], unknown: ['· not checked yet', 'unknown']};
  async function server(path, body) {
    const c = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    if (!c.remoteRepairUrl || !c.remoteRepairToken) throw Object.assign(Error('Connect cloud access in the Auto-Fix tab first.'), {code: 'NO_SERVER'});
    // A read that hits a dropped connection (common right after the extension reloads) is tried once more; these cards
    // never show the repair-job timeout text.
    let r;
    try { r = await remoteRepairRequest(c, path, body); }
    catch (e) {
      if (!e.remoteTransportError) throw e;
      try { if (body !== undefined) throw e; r = await remoteRepairRequest(c, path, body); }
      catch { throw Error('Could not reach the 0xFlow server. Check your connection, then press Refresh.'); }
    }
    if (r.status !== 200) throw Object.assign(Error(r.body?.error || 'The server could not do this (' + r.status + ').'), {status: r.status, code: r.body?.code});
    return r.body;
  }
  const locked = code => code === 'PRO_ONLY' ? 'For Pro and Discord Pro.' : code === 'SIGN_IN' ? 'Sign in to 0xFlow first.' : '';

  let view = 0;
  async function loadAccounts() {
    const run = ++view, list = $('flowAccountsList'), status = $('flowAccountsStatus');
    $('refreshFlowAccounts').disabled = true;
    try {
      const r = await server('/flow-status?device=' + encodeURIComponent((await chrome.storage.local.get('flowStatusDevice')).flowStatusDevice || ''));
      if (run !== view) return;
      list.replaceChildren();
      if(run!==view)return;
      if (!r.available) { status.textContent = locked(r.code) + ' See every Chrome profile, its queue and which Flow accounts still have credits.'; return; }
      if(!r.devices.some(d=>d.current))r.devices.unshift({name:'This browser',current:true,updated:Date.now(),queue:{state:'idle'},accounts:[]});
      status.textContent = r.devices.length + ' device' + (r.devices.length === 1 ? '' : 's') + ' · balance checks stay in this browser; other devices show generation status.';
      for (const d of r.devices) {
        if(d.current){const accounts=new Map(d.accounts.map(a=>[a.n,a]));for(const key of ['0']){const n=Number(key);if(Number.isInteger(n)&&n>=0&&n<5&&!accounts.has(n))accounts.set(n,{n,label:['Main','2nd','3rd','4th','5th'][n],credit:'unknown',at:Date.now(),saved:0});}d.accounts=[...accounts.values()].sort((a,b)=>a.n-b.n);}
        const q = d.queue, card = el('div', undefined, 'fa-device'), head = el('div', undefined, 'fa-head');
        const name = el('strong', d.name); if (d.current) name.append(el('span', 'THIS DEVICE', 'badge'));
        const line = d.stale ? 'no report since ' + ago(d.updated) + ' (browser closed?)' : q.state === 'running' ? 'running ' + q.done + '/' + q.total
          : q.state === 'quota' ? 'paused: Flow credits ran out' : q.state === 'stopped' ? 'stopped' + (q.reason ? ' · ' + q.reason : '') : q.state === 'done' ? 'finished ' + q.done + '/' + q.total : 'idle';
        head.append(name, el('small', line + ' · ' + ago(d.updated), 'fa-queue fa-' + (d.stale ? 'stale' : q.state)));
        const accounts = el('div', undefined, 'fa-accounts');
        if (!d.accounts.length) accounts.append(el('small', 'No Flow account used yet.', 'muted'));
        for (const a of d.accounts) {
          const [text, cls] = CREDIT[a.credit] || CREDIT.unknown, chip = el('div', undefined, 'fa-acc fa-' + cls);
          chip.title = (a.detail ? a.detail + ' · ' : '') + 'checked ' + ago(a.at);
          chip.append(el('b', (a.n === q.account ? '▶ ' : '') + a.label), el('span', text), el('small', a.saved ? a.saved + ' saved today' : ago(a.at)));
          accounts.append(chip);
        }
        card.append(head, accounts); list.append(card);
      }
    } catch (e) { if (run === view) { list.replaceChildren(); status.textContent = locked(e.code) || e.message; } }
    finally { if (run === view) $('refreshFlowAccounts').disabled = false; }
  }

  let waitTimer = 0;
  async function loadTelegram() {
    const status = $('telegramStatus'), connect = $('telegramConnect'), disconnect = $('telegramDisconnect');
    try {
      const r = await server('/telegram');
      const gate = !r.signedIn ? 'SIGN_IN' : !r.pro ? 'PRO_ONLY' : '';
      upsell('tgUpsell', gate);
      disconnect.hidden = !r.linked; connect.hidden = r.linked || !!gate; connect.disabled = !r.available || !!gate;
      if (gate) { status.textContent = ''; return r; }
      status.textContent = !r.signedIn ? 'Sign in to 0xFlow first.' : !r.pro ? 'Telegram alerts are for Pro and Discord Pro.'
        : !r.available ? 'Telegram alerts are not set up on this server yet.' : r.linked ? 'Connected' + (r.chatName ? ' to ' + r.chatName : '') + ' ✓ Send /status to @' + r.botName + ' any time.'
        : 'Not connected. Connect opens @' + r.botName + ' in Telegram; press Start there.';
      return r;
    } catch (e) { connect.disabled = true; if (upsell('tgUpsell', e.code)) { connect.hidden = true; status.textContent = ''; } else status.textContent = e.message; return null; }
  }
  async function connectTelegram() {
    const status = $('telegramStatus');
    try {
      const {url} = await server('/telegram/link', {});
      await chrome.tabs.create({url});
      status.textContent = 'Telegram opened. Press Start in the bot; this card updates when it is connected (link valid 15 minutes).';
      clearInterval(waitTimer); const until = Date.now() + 120000;
      waitTimer = setInterval(async () => { const r = await loadTelegram(); if (r?.linked || Date.now() > until) clearInterval(waitTimer); }, 3000);
    } catch (e) { status.textContent = locked(e.code) || e.message; }
  }
  async function disconnectTelegram() {
    if (!confirm('Stop Telegram alerts for this 0xFlow account?')) return;
    try { await server('/telegram/unlink', {}); } catch (e) { $('telegramStatus').textContent = e.message; }
    await loadTelegram();
  }
  // AI assistant (MCP, owner 2026-10-31): one scoped key per device, shown once. The local MCP program uses only this key.
  let mcpKey = '';
  async function loadMcp() {
    const status = $('mcpStatus'), create = $('mcpCreate'), revoke = $('mcpRevoke');
    try {
      const device = (await chrome.storage.local.get('flowStatusDevice')).flowStatusDevice || '';
      const r = await server('/mcp/key?device=' + encodeURIComponent(device));
      // Free and signed-out users see the upgrade card instead of the key buttons (owner 2026-11-01).
      upsell('mcpUpsell', r.available ? '' : r.code || 'PRO_ONLY');
      create.hidden = !r.available; create.disabled = !r.available; revoke.hidden = !r.hasKey; create.textContent = r.hasKey ? 'New key' : 'Create key';
      if (r.available) await chrome.storage.local.set({mcpBridgeOn: !!r.hasKey});
      // The connector address is not secret: always shown, so Claude can be connected again later.
      $('mcpConnect').hidden = !r.available;
      if (r.available) $('mcpUrl').textContent = String((await chrome.storage.local.get('remoteRepairUrl')).remoteRepairUrl || '').replace(/\/+$/, '') + '/mcp';
      status.textContent = !r.available ? ''
        : r.hasKey ? 'On ✓ Key created ' + ago(r.created) + (r.used ? ' · last used ' + ago(r.used) : ' · not used yet') + '. Keep this panel open for commands to run. Lost the key? Press New key and connect again.'
        : 'Off. Create a key to connect your AI app.';
    } catch (e) { create.disabled = true; if (upsell('mcpUpsell', e.code)) { create.hidden = true; status.textContent = ''; } else status.textContent = e.message; }
  }
  // Upgrade card: Pro for free accounts, sign-in first for signed-out ones. Returns true when the card is shown.
  function upsell(id, code) {
    const box = $(id), show = code === 'PRO_ONLY' || code === 'SIGN_IN';
    box.hidden = !show; $(id === 'mcpUpsell' ? 'mcpCard' : 'telegramCard').hidden = show;   // the controls are no use until then
    if (!show) return false;
    const go = box.querySelector('[data-upsell-go]');
    go.textContent = code === 'SIGN_IN' ? 'Sign in to 0xFlow' : '♛ Upgrade to Pro';
    go.onclick = code === 'SIGN_IN' ? () => document.querySelector('[data-tab="general"]')?.click() : () => upgrade(box);
    box.querySelector('[data-upsell-status]').textContent = code === 'SIGN_IN' ? 'Sign in first (Settings tab → Account), then upgrade.' : '';
    return true;
  }
  async function upgrade(box) {
    const go = box.querySelector('[data-upsell-go]'), status = box.querySelector('[data-upsell-status]');
    go.disabled = true; status.textContent = 'Opening Upgrade…';
    try {
      const r = await server('/billing/order', {});
      if (!r.url) throw Error('Upgrade is not available right now. Try again later.');
      await chrome.tabs.create({url: r.url});
      status.textContent = 'Your reference code: ' + r.code;
    } catch (e) { status.textContent = e.status === 403 ? 'Sign in first (Settings tab → Account), then upgrade.' : e.message; }
    finally { go.disabled = false; }
  }
  async function createMcp() {
    if ($('mcpRevoke').hidden === false && !confirm('Make a new key? The old key stops working and Claude disconnects until you connect again with the new key.')) return;
    try {
      const c = await chrome.storage.local.get(['remoteRepairUrl', 'flowStatusDevice']);
      let device = c.flowStatusDevice;
      if (!device) { device = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''); await chrome.storage.local.set({flowStatusDevice: device}); }
      mcpKey = (await server('/mcp/key', {device: {id: device}})).key;
      $('mcpConfig').textContent = JSON.stringify({mcpServers: {'0xflow': {command: 'node', args: ['SAVE-MCP-PROGRAM-FIRST/0xflow-mcp.cjs'],
        env: {OXFLOW_SERVER: String(c.remoteRepairUrl || '').replace(/\/+$/, ''), OXFLOW_MCP_KEY: mcpKey}}}}, null, 2);
      $('mcpUrl').textContent = String(c.remoteRepairUrl || '').replace(/\/+$/, '') + '/mcp'; $('mcpKey').textContent = mcpKey;
      $('mcpSetup').hidden = false;
    } catch (e) { $('mcpStatus').textContent = locked(e.code) || e.message; }
    await loadMcp();
  }
  async function revokeMcp() {
    if (!confirm('Turn off the AI assistant connection? Its key stops working at once.')) return;
    try { await server('/mcp/key/revoke', {device: {id: (await chrome.storage.local.get('flowStatusDevice')).flowStatusDevice || ''}}); } catch (e) { $('mcpStatus').textContent = e.message; }
    mcpKey = ''; $('mcpSetup').hidden = true; $('mcpConfig').textContent = $('mcpKey').textContent = '';
    await loadMcp();
  }
  $('mcpCreate').onclick = createMcp;
  $('mcpRevoke').onclick = revokeMcp;
  const copy = (id, button, label) => async () => { await navigator.clipboard.writeText($(id).textContent); $(button).textContent = 'Copied ✓'; setTimeout(() => { $(button).textContent = label; }, 2000); };
  $('mcpCopyUrl').onclick = copy('mcpUrl', 'mcpCopyUrl', 'Copy URL');
  $('mcpCopyKey').onclick = copy('mcpKey', 'mcpCopyKey', 'Copy key');
  $('mcpCopy').onclick = async () => { await navigator.clipboard.writeText($('mcpConfig').textContent); $('mcpCopy').textContent = 'Copied ✓'; setTimeout(() => { $('mcpCopy').textContent = 'Copy settings'; }, 2000); };
  // After saving, the settings text points at the file where it was really saved.
  $('mcpSave').onclick = async () => {
    const id = await chrome.downloads.download({url: chrome.runtime.getURL('mcp/0xflow-mcp.cjs'), filename: '0xflow-mcp.cjs', saveAs: true});
    const done = async d => {
      if (d.id !== id || d.state?.current !== 'complete') return;
      chrome.downloads.onChanged.removeListener(done);
      const [item] = await chrome.downloads.search({id});
      if (!item?.filename || !$('mcpConfig').textContent) return;
      const config = JSON.parse($('mcpConfig').textContent); config.mcpServers['0xflow'].args = [item.filename];
      $('mcpConfig').textContent = JSON.stringify(config, null, 2);
    };
    chrome.downloads.onChanged.addListener(done);
  };
  function load() { void loadAccounts(); void loadTelegram(); void loadMcp(); }
  $('refreshFlowAccounts').onclick = loadAccounts;
  $('telegramConnect').onclick = connectTelegram;
  $('telegramDisconnect').onclick = disconnectTelegram;
  // The cards sit in the Settings tab (owner 2026-10-31); load when that tab is shown.
  // MCP tab (owner 2026-11-01): sub-tabs MCP / Telegram; the Flow accounts card stays in the Settings tab.
  for (const b of document.querySelectorAll('[data-mcp-sub]')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('[data-mcp-sub]')) { x.setAttribute('aria-pressed', String(x === b)); $(x.dataset.mcpSub).hidden = x !== b; }
  });
  const homes = [...new Set(['flowAccountsCard', 'telegramCard', 'mcpCard'].map(id => $(id).closest('section')))];
  for (const home of homes) document.querySelector('[data-tab="' + home.id + '"]')?.addEventListener('click', load);
  if (homes.some(h => !h.hidden)) load();
  // The MCP chip in the control tab asks for this tab (owner 2026-11-01); works when Settings opens and when it is focused.
  async function openRequestedTab() {
    const want = (await chrome.storage.local.get('studioSettingsOpenTab')).studioSettingsOpenTab;
    if (!want) return;
    await chrome.storage.local.remove('studioSettingsOpenTab');
    document.querySelector('[data-tab="' + want + '"]')?.click();
  }
  chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.studioSettingsOpenTab?.newValue) void openRequestedTab();  });
  void openRequestedTab();
  window.studioFlowAccounts = {load, upsell};
})();
