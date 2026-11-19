// Flow accounts dashboard + Telegram alerts (owner 2026-10-31, Pro and Discord Pro). This panel reports its queue and what
// Flow last showed for each Flow account it uses (Main, 2nd... as in the account switcher) to our server, and asks the
// server to send the user's Telegram alerts. Only Flow's own messages are used (fine / running low / used up): Flow shows
// no balance the extension can read reliably. No Google login, cookie or email is read or sent. The server answers
// 401/403 for signed-out or free accounts; then this stays quiet for 10 minutes.
(() => {
  const KEY = 'flowAccountStatus', NAMES = ['Main', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'], QUIET_MS = 10 * 60000;
  let accounts = {}, current = null, ended = {state: 'idle', reason: ''}, quietUntil = 0, timer = 0, beat = 0, device = {id: '', name: ''};
  const today = () => new Date().toLocaleDateString('en-CA');
  // Flow keeps the Google account in the path (/u/1/ = 2nd); a Flow URL without it is the main account.
  function accountOf(url) {
    const m = String(url || '').match(/^https:\/\/(?:flow\.google(?:\.com)?|labs\.google\/fx(?:\/[a-z-]+)?\/tools\/flow)(?:\/u\/(\d+))?(?:[/?#]|$)/i);
    if (!m) return null;
    const n = Number(m[1] || 0);
    return n < NAMES.length ? n : null;
  }
  function account(n) {
    const a = accounts[n] ||= {credit: 'unknown', detail: '', at: 0, day: today(), saved: 0};
    if (a.day !== today()) { a.day = today(); a.saved = 0; }
    return a;
  }
  const save = () => chrome.storage.local.set({[KEY]: {accounts, current}}).catch(() => {});
  async function call(path, body) {
    if (Date.now() < quietUntil) return null;
    try { return await (window.flowStatusClient || (await import('./lib/story-narration-generate.mjs')).serverClient()).request(path, body); }   // flowStatusClient: tests
    catch (e) { if ([401, 403, 404, 503].includes(e.status) || e.code === 'NO_SERVER') quietUntil = Date.now() + QUIET_MS; return null; }
  }
  function counts() {
    const q = typeof queue !== 'undefined' && Array.isArray(queue) ? queue : [];
    return {done: q.filter(i => i.status === 'done').length, errors: q.filter(i => i.status === 'error').length, total: q.length};
  }
  function noun() {
    const kind = typeof MODES !== 'undefined' && typeof settings !== 'undefined' ? MODES[settings.mode]?.resultKind : '';
    return kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'prompts';
  }
  function report() {
    clearTimeout(timer); timer = 0;
    const isRunning = typeof running !== 'undefined' && running, c = counts();
    return call('/flow-status/report', {
      device, queue: {state: isRunning ? 'running' : ended.state, ...c, reason: isRunning ? '' : ended.reason, account: current},
      accounts: Object.entries(accounts).map(([n, a]) => ({n: Number(n), credit: a.credit, detail: a.detail, saved: a.saved, at: a.at}))});
  }
  const schedule = (ms = 2000) => { if (!timer) timer = setTimeout(report, ms); };
  function event(kind, data = {}) { return call('/telegram/event', {device, id: kind + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, ...data}); }

  function credit(url, state, detail = '') {
    const n = accountOf(url); if (n === null) return;
    current = n; const a = account(n), was = a.credit;
    a.credit = state; a.detail = String(detail || '').slice(0, 120); a.at = Date.now(); save(); schedule();
    // "Running low" is said once per account per day.
    if (state === 'low' && was !== 'low' && a.lowAlert !== today()) { a.lowAlert = today(); save(); void event('credits-low', {account: NAMES[n]}); }
  }
  function saved(url) {
    const n = accountOf(url); if (n === null) return;
    current = n; const a = account(n);
    a.saved++; if (a.credit !== 'low') a.credit = 'ok'; a.detail = ''; a.at = Date.now(); save(); schedule(10000);
  }
  function queueStart() { ended = {state: 'running', reason: ''}; clearInterval(beat); beat = setInterval(report, 60000); schedule(0); }
  // Called by control.js at every queue end, before the account switcher decides what happens next.
  function queueEnd(info) {
    clearInterval(beat); beat = 0;
    const c = counts(), label = current === null ? '' : NAMES[current];
    ended = {state: info.quota ? 'quota' : info.stopped || info.errors ? 'stopped' : 'done', reason: info.reason || (info.errors ? info.errors + ' failed' : '')};
    if (info.quota && current !== null) { const a = account(current); a.credit = 'out'; a.detail = 'Flow credits ran out'; a.at = Date.now(); save(); }
    void report();
    if (info.quota) void event('credits-out', {account: label, detail: 'The queue paused at ' + c.done + '/' + c.total + '.'});
    else if (info.stopped && !info.reason) return;   // the user pressed Stop: no alert
    else if (info.stopped || info.errors) void event('queue-stopped', {done: c.done, total: c.total, detail: info.reason || info.errors + ' prompt' + (info.errors === 1 ? '' : 's') + ' failed'});
    else if (c.total) void event('queue-done', {done: c.done, noun: noun()});
  }
  function switched(n) { current = n; save(); void event('account-switched', {account: NAMES[n] || ''}); schedule(0); }

  // A random id per Chrome profile (owner connections are shared by all profiles) and the name from Settings → Devices (Rename).
  chrome.storage.local.get([KEY, 'flowStatusDevice', 'studioDeviceName']).then(r => {
    accounts = r[KEY]?.accounts || {}; current = r[KEY]?.current ?? null;
    device = {id: r.flowStatusDevice || Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''), name: String(r.studioDeviceName || '').slice(0, 60)};
    if (!r.flowStatusDevice) chrome.storage.local.set({flowStatusDevice: device.id}).catch(() => {});
  }).catch(() => {}).finally(() => schedule(5000));
  window.flowStatusReport = {credit, saved, queueStart, queueEnd, switched, accountOf, report};
})();
