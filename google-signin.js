// Google / Discord account controls and sign-in popup; signed-in status is shown in AI Story. The plan is decided by the server
// (/auth/me); the extension only displays it. Uses chrome.identity.launchWebAuthFlow (works in Chrome and Edge).
(() => {
  const GOOGLE_CLIENT_ID = '333806946363-m08l2tm2hcmesr34silun5nf982560sd.apps.googleusercontent.com';
  const PLAN_LABEL = {free: 'Free plan', pro: 'Pro', community: 'Discord Pro'};
  let state = null, bar = null, tabPending = false;
  let deviceSync=null,lastDeviceSync=0,deviceSnapshot=null;
  async function syncDevice(force=true) {
    if(!state?.signedIn){lastDeviceSync=0;deviceSnapshot=null;return null;}
    if(deviceSync)return deviceSync;
    if(!force&&Date.now()-lastDeviceSync<300000)return deviceSnapshot;
    const accountKey=()=>state?.signedIn?[state.via,state.email,state.name].join('|'):null,expected=accountKey();
    deviceSync=(async()=>{
      const c=await connection(),local=await chrome.storage.local.get('studioDeviceName'),ua=typeof navigator==='undefined'?'':navigator.userAgent||'';
      const browser=/Edg(?:A|iOS)?\//.test(ua)?'Microsoft Edge':/OPR\//.test(ua)?'Opera':/Chrome|CriOS/.test(ua)?'Google Chrome':'Browser';
      const os=/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Windows/.test(ua)?'Windows':/Macintosh|Mac OS/.test(ua)?'macOS':/Linux/.test(ua)?'Linux':'';
      const result=await remoteRepairRequest(c,'/auth/devices',{name:local.studioDeviceName||'',browser,os,version:chrome.runtime?.getManifest?.().version||''});
      if(result.status===404)throw Error('Device management needs the updated 0xFlow server. Try again later.');
      if(result.status>=400)throw Error(result.body?.error||'Device registration could not connect.');
      if(accountKey()!==expected)return null;
      deviceSnapshot=result.body;lastDeviceSync=Date.now();return deviceSnapshot;
    })();
    try{return await deviceSync;}finally{deviceSync=null;}
  }
  async function removeDevice(id) {
    const result=await remoteRepairRequest(await connection(),'/auth/devices/remove',{id});
    if(result.status>=400)throw Error(result.body?.error||'Device could not be removed.');
    lastDeviceSync=0;deviceSnapshot=null;return result.body;
  }

  async function affiliateAvailable() {
    try {
      const c=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);
      if(!c.remoteRepairUrl||!c.remoteRepairToken)return false;
      const r=await remoteRepairRequest(c,'/billing/affiliate');
      return r.status===200&&r.body?.enabled===true;
    } catch { return false; }
  }
  async function openAffiliates() {
    let c=await connection(),r=await remoteRepairRequest(c,'/billing/affiliate',{});
    if(r.status===403){
      const ok=await showSignInPopup({eyebrow:'AFFILIATES',title:'Sign in to Affiliates',text:'Your affiliate application and earnings belong to your 0xFlow account.',benefits:[['Referral code','Share after owner approval'],['Earnings','Track commissions and payout history']]});
      if(!ok)return;
      c=await connection();r=await remoteRepairRequest(c,'/billing/affiliate',{});
    }
    if(r.status!==200||!r.body?.url)throw Error(r.body?.error||'Affiliate pilot is not available on this service.');
    const target=new URL(r.body.url),base=new URL(c.remoteRepairUrl);
    if(target.protocol!=='https:'||target.origin!==base.origin||target.pathname!==base.pathname.replace(/\/+$/,'')+'/affiliate')throw Error('Affiliate link did not match the connected service.');
    await chrome.tabs.create({url:target.href});
  }
  const randomNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function connection() {
    let c = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    // Sign-in is linked to this installation's cloud account; connect it once if needed (no login, no data beyond a random key).
    if (!c.remoteRepairToken && typeof connectCloudRepair === 'function') { await connectCloudRepair(); c = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']); }
    if (!c.remoteRepairToken || !c.remoteRepairUrl) throw Error('Connect cloud repair in the Auto-Fix tab first.');
    return c;
  }
  async function api(path, body) {
    const result = await remoteRepairRequest(await connection(), path, body);
    if (result.status === 404) throw Error('Google sign-in is not available on this server yet.');
    if (result.status >= 400) throw Error(result.body?.error || 'Sign-in failed. Try again.');
    return result.body;
  }
  // Chrome allows one sign-in window at a time ("Only one web auth flow is allowed at a time"): say so plainly.
  function authWindowError(e, cancelled, failed) {
    const message = String(e?.message || e || '');
    if (/only one web auth flow/i.test(message)) return 'A sign-in window is already open. Finish or close it, then try again.';
    return /did not approve|canceled|cancelled|closed/i.test(message) ? cancelled : failed + message;
  }
  // Mobile browsers with extensions (Lemur, Kiwi, Edge Android) have no working sign-in window (owner 2026-10-24):
  // they sign in on a server page in a normal tab, and the panel waits until the account shows up.
  const mobile = () => !!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
  const windowMissing = () => !chrome.identity?.launchWebAuthFlow;
  async function tabSignIn(onNote = () => {}) {
    if (tabPending) throw Error('A sign-in tab is already open. Finish it there.');
    const s = await api('/auth/tab/start', {});
    tabPending = true;
    try {
    onNote(`Finish signing in in the new tab. It shows the number ${s.confirm}.`);
    await chrome.tabs.create({url: s.url, active: true});
    while (Date.now() < s.expiresAt) {
      await new Promise(r => setTimeout(r, 2000));
      const me = await api('/auth/me').catch(() => null);
      if (me?.signedIn) return me;
    }
    throw Error('Sign-in in the tab was not finished within 10 minutes. Press Sign in again.');
    } finally { tabPending = false; }
  }
  async function signIn(onNote) {
    if (mobile() || windowMissing()) return tabSignIn(onNote);
    const nonce = randomNonce(), url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({client_id: GOOGLE_CLIENT_ID, response_type: 'id_token', redirect_uri: chrome.identity.getRedirectURL(),
      scope: 'openid email profile', nonce, prompt: 'select_account'})) url.searchParams.set(k, v);
    let redirect;
    try { redirect = await chrome.identity.launchWebAuthFlow({url: url.href, interactive: true}); }
    catch (e) { throw Error(authWindowError(e, 'Sign-in was cancelled.', 'Google sign-in window failed: ')); }
    const params = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (params.get('error')) throw Error('Google sign-in: ' + params.get('error'));
    if (!params.get('id_token')) throw Error('Google did not return a sign-in token.');
    return api('/auth/google', {idToken: params.get('id_token'), nonce});
  }

  // Sign in with Discord: members of the owner's Discord server get Discord Pro (server-verified, re-checked daily).
  // (Linking Discord to a Google account was removed 2026-10-15: Google or Discord, one account each.)
  async function signInWithDiscord(onNote) {
    const clientId = state?.discord?.clientId;
    if (!clientId) throw Error('Sign in with Discord is not available yet.');
    if (mobile() || windowMissing()) return tabSignIn(onNote);   // the page offers Discord too
    const nonce = randomNonce(), redirectUri = chrome.identity.getRedirectURL('discord'), url = new URL('https://discord.com/oauth2/authorize');
    for (const [k, v] of Object.entries({client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'identify guilds.members.read', state: nonce, prompt: 'consent'})) url.searchParams.set(k, v);
    let redirect;
    try { redirect = await chrome.identity.launchWebAuthFlow({url: url.href, interactive: true}); }
    catch (e) { throw Error(authWindowError(e, 'Discord sign-in was cancelled.', 'Discord window failed: ')); }
    const params = new URL(redirect).searchParams;
    if (params.get('error')) throw Error(params.get('error') === 'access_denied' ? 'Discord sign-in was cancelled.' : 'Discord: ' + params.get('error'));
    if (params.get('state') !== nonce || !params.get('code')) throw Error('Discord sign-in did not match this request. Try again.');
    return api('/auth/discord', {code: params.get('code'), redirectUri});
  }
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  async function signOut() {
    const discord=state?.discord, signedOut=await api('/auth/sign-out', {});
    // Preserve provider availability on older servers, never account details.
    state={...signedOut,...(!signedOut.discord&&discord?.available?{discord:{available:true,clientId:discord.clientId}}:{})};
    render();
    return state;
  }
  const supportOpenedAt = Date.now(), supportHistoryKey = 'communitySupportScheduleV2';
  let supportTimer = null, supportShownUntil = 0;
  function renderCommunitySupport() {
    const banner = document.getElementById('communitySupportBanner');
    if (!banner) return;
    const now = Date.now(), date = new Date(now);
    const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
    let history;
    try { history = JSON.parse(localStorage.getItem(supportHistoryKey) || 'null'); }
    catch { banner.hidden = true; return; } // No repeated reminders if storage is unavailable.
    if (history?.day !== day) history = {day, count:0, lastShown:0, dismissed:false};
    const eligible = state?.signedIn && (state.plan === 'free' || (state.plan === 'community' && state.via === 'discord'));
    const queueRunning = typeof running !== 'undefined' && running;
    if (!eligible || queueRunning || document.visibilityState === 'hidden' || history.dismissed) {
      banner.hidden = true; supportShownUntil = 0;
    } else if (supportShownUntil > now) {
      banner.hidden = false;
    } else {
      banner.hidden = true; supportShownUntil = 0;
      if (now - supportOpenedAt >= 30000 && Number(history.count || 0) < 2 && (!history.lastShown || now - history.lastShown >= 30 * 60000)) {
        history = {...history, count:Number(history.count || 0) + 1, lastShown:now};
        try { localStorage.setItem(supportHistoryKey, JSON.stringify(history)); }
        catch { return; }
        supportShownUntil = now + 15000; banner.hidden = false;
      }
    }
    const close = document.getElementById('communitySupportClose');
    if (close) close.onclick = () => {
      banner.hidden = true; supportShownUntil = 0;
      try { localStorage.setItem(supportHistoryKey, JSON.stringify({...history, dismissed:true})); }
      catch { /* Hide for this panel even if storage becomes unavailable. */ }
    };
    if (!supportTimer && eligible) supportTimer = setInterval(renderCommunitySupport, 1000);
  }
  function render(note = '', calm = false) {
    renderCommunitySupport();
    if(!state?.signedIn){lastDeviceSync=0;deviceSnapshot=null;}
    else if(typeof navigator!=='undefined')void syncDevice(false).catch(()=>{});
    const badge = document.getElementById('accountPlanBadge');
    if (badge) {
      const plan = !state?.signedIn ? '' : state.plan === 'free' ? 'free' : ['pro','community'].includes(state.plan) ? 'pro' : '';
      badge.hidden = !plan;
      badge.textContent = plan ? plan.toUpperCase() : '';
      badge.dataset.plan = plan || '';
      badge.title = plan ? `${PLAN_LABEL[state.plan]} account` : '';
      badge.setAttribute('aria-label', badge.title);
    }
    if (typeof renderUsageLine === 'function') renderUsageLine();
    if (!bar) return;
    bar.replaceChildren();
    // Control owns signed-out account buttons; AI Story keeps its gated sign-in popup.
    // Owner 2026-11-11: no "Signed in with Google · Sign out" bar any more (sign-out lives in Control and Settings);
    // the bar only appears to show a sign-in error.
    bar.hidden = !note;
    if (bar.hidden) return;
    if (note) { bar.append(el('p', note, calm ? 'gs-note gs-note-info' : 'gs-note')); return; }
    const info = el('div', undefined, 'gs-info'), actions = el('div', undefined, 'gs-actions');
    if (state?.signedIn) {
      const u = state.builder, quota = !u ? '' : state.plan === 'free'
        ? ` · ${u.remaining} of ${u.limit} free stories left today`
        : ' · all templates';
      const who = state.via === 'discord' ? 'Signed in with Discord' : 'Signed in with Google';
      info.append(el('strong', who), el('span', `${PLAN_LABEL[state.plan] || state.plan}${quota}`, 'gs-muted'));
      const out = el('button', 'Sign out'); out.type = 'button';
      out.onclick = () => run(out, signOut);
      actions.append(out);
      // Signed in with Discord: show the server-membership result (Discord Pro needs membership, re-checked daily).
      const d = state.discord;
      if (state.via === 'discord' && d?.linked && !d.member && state.plan !== 'pro') {
        const row = el('div', undefined, 'gs-discord');
        row.append(el('span', 'Discord Pro requires eligible server membership and any required role. You can keep using the Free plan.', 'gs-muted'));
        bar.append(info, actions, row);
        if (note) bar.append(el('p', note, 'gs-note'));
        return;
      }
    }
    if (tabPending) for (const b of actions.querySelectorAll('button')) b.disabled = true;
    if(state?.signedIn)bar.append(info);
    bar.append(actions);
    if (note) bar.append(el('p', note, calm ? 'gs-note gs-note-info' : 'gs-note'));
  }
  // Small modal asking to sign in before a story can be created (or before Upgrade: opts change the wording).
  // Resolves true once signed in, false when closed without signing in.
  function showSignInPopup(opts = {}) {
    if (document.querySelector('dialog.gs-popup')) return Promise.resolve(false);
    let done; const result = new Promise(r => { done = r; });
    const dialog = el('dialog', undefined, 'gs-popup'), close = () => dialog.close();
    dialog.setAttribute('aria-labelledby', 'gsPopupTitle');
    dialog.setAttribute('aria-describedby', 'gsPopupDescription');
    const heading = el('div', undefined, 'gs-popup-heading');
    const emblem = el('span', undefined, 'gs-popup-emblem'); emblem.setAttribute('aria-hidden', 'true');
    const filmSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filmSvg.setAttribute('viewBox', '0 0 24 24'); filmSvg.setAttribute('width', '18'); filmSvg.setAttribute('height', '18'); filmSvg.setAttribute('fill', 'none'); filmSvg.setAttribute('stroke', 'currentColor'); filmSvg.setAttribute('stroke-width', '1.6'); filmSvg.setAttribute('stroke-linecap', 'round'); filmSvg.setAttribute('stroke-linejoin', 'round');
    const filmPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    filmPath.setAttribute('d', 'M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4'); filmSvg.append(filmPath); emblem.append(filmSvg);
    const headingText = el('div'); headingText.append(el('span', opts.eyebrow || 'STORY BUILDER', 'gs-popup-eyebrow'));
    const title = el('h3', opts.title || 'Sign in to create stories'); title.id = 'gsPopupTitle';
    headingText.append(title); heading.append(emblem, headingText);
    const text = el('p', opts.text || 'Choose an account to start creating your next story.'); text.id = 'gsPopupDescription';
    const benefits = el('div', undefined, 'gs-popup-benefits');
    for (const [label, detail] of opts.benefits || [['Free', '2 stories per day'], ['Pro', 'All templates']]) {
      const item = el('div'); item.append(el('strong', label), el('span', detail)); benefits.append(item);
    }
    const note = el('p', '', 'gs-popup-note');
    note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    const go = el('button', 'Sign in with Google', 'gs-google'); go.type = 'button';
    const googleIcon = el('span', 'G', 'gs-provider-icon'); googleIcon.setAttribute('aria-hidden', 'true'); go.prepend(googleIcon);
    const later = el('button', 'Not now', 'gs-popup-later'); later.type = 'button'; later.onclick = close;
    const actions = el('div', undefined, 'gs-popup-actions'); actions.append(go);
    let signedIn = false;
    const busy = value => { for (const button of [...actions.querySelectorAll('button'), later]) button.disabled = value; };
    go.onclick = async () => {
      busy(true); note.textContent = 'Opening Google sign-in…';
      try { state = await signIn(t => { note.textContent = t; }); render(); signedIn = true; close(); }
      catch (e) { note.textContent = e.message || String(e); busy(false); }
    };
    if (state?.discord?.available) {
      const dGo = el('button', 'Sign in with Discord', 'gs-discord-btn'); dGo.type = 'button';
      const discordIcon = el('span', undefined, 'gs-provider-icon'); discordIcon.setAttribute('aria-hidden', 'true');
      const discordSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      discordSvg.setAttribute('viewBox', '0 0 24 24'); discordSvg.setAttribute('width', '20'); discordSvg.setAttribute('height', '20'); discordSvg.setAttribute('fill', 'currentColor');
      const discordPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      discordPath.setAttribute('d', 'M19.7 5.2a18 18 0 0 0-4.5-1.4l-.5 1a16.4 16.4 0 0 0-5.4 0l-.5-1a18 18 0 0 0-4.5 1.4C1.5 9.4.7 13.5 1.1 17.5a18 18 0 0 0 5.5 2.8l1.1-1.8-1.7-.8.4-.3a13.8 13.8 0 0 0 11.2 0l.4.3-1.7.8 1.1 1.8a18 18 0 0 0 5.5-2.8c.5-4.6-.8-8.7-3.2-12.3ZM8.5 14.8c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z');
      discordSvg.append(discordPath); discordIcon.append(discordSvg); dGo.prepend(discordIcon);
      dGo.onclick = async () => {
        busy(true); note.textContent = 'Opening Discord…';
        try { state = await signInWithDiscord(t => { note.textContent = t; }); render(); signedIn = true; close(); }
        catch (e) { note.textContent = e.message || String(e); busy(false); }
      };
      actions.append(dGo);
    }
    if (!mobile() && !windowMissing()) {
      const tab = el('button', 'Sign-in window not working? Sign in in a tab', 'gs-tab-link'); tab.type = 'button';
      tab.onclick = async () => {
        busy(true);
        try { state = await tabSignIn(t => { note.textContent = t; }); render(); signedIn = true; close(); }
        catch (e) { note.textContent = e.message || String(e); busy(false); }
      };
      actions.append(tab);
    }
    dialog.append(heading, text, benefits, actions, note, later);
    dialog.addEventListener('close', () => { dialog.remove(); if (signedIn) chrome.storage.local.set({studioAccountRevision: Date.now()}).catch(() => {}); done(signedIn); }, {once: true});
    document.body.append(dialog); dialog.showModal(); go.focus();
    return result;
  }
  async function run(button, task) {
    button.disabled = true;
    try { await task(); render(); await chrome.storage.local.set({studioAccountRevision:Date.now()}); } catch (e) { render(e.message || String(e)); }
  }
  async function refresh() {
    // A plan change (e.g. upgraded to Pro) also updates the Control counter right away, not at its 5-minute check (owner 2026-10-29).
    try { const before = state?.plan; state = await api('/auth/me'); render(); if (before !== state?.plan && typeof usageRefresh === 'function') usageRefresh(true); } catch (e) { state = null; render(e.message || String(e)); }
  }
  function mount() {
    const panel = document.getElementById('builderTabPanel');
    if (!panel || bar) return !!bar;
    const style = el('style');
    style.textContent = '.gs-bar[hidden]{display:none}.gs-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 10px;padding:10px 12px;border:1px solid #b798ff2e;border-radius:14px;background:#ffffff06}'
      + '.gs-info{display:flex;flex-direction:column;flex:1;min-width:0}.gs-info strong{font-size:13px}.gs-muted{color:#a79fbb;font-size:11px;overflow-wrap:anywhere}'
      + '.gs-actions button{min-height:32px;padding:6px 12px;border-radius:10px}.gs-google{background:#fff;color:#1f1f1f;font-weight:600;border:1px solid #dadce0}'
      + '.gs-note{flex-basis:100%;margin:0;color:#f3b8b8;font-size:12px}.gs-note-info{color:#9ef0df}'
      + '.gs-tab-link{flex-basis:100%;background:none!important;border:0!important;color:#9ef0df!important;text-decoration:underline;font-size:11px!important;min-height:auto!important;padding:2px 0!important;text-align:left;cursor:pointer}'
      + '.gs-discord{flex-basis:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid #b798ff1f}.gs-discord button{min-height:28px;padding:4px 10px;border-radius:9px;font-size:12px}.gs-discord-btn{background:#5865f2;color:#fff;border:0;font-weight:600}.gs-actions{display:flex;flex-wrap:wrap;gap:6px}.gs-popup-actions{flex-wrap:wrap}.gs-ok{color:#9ef0df;font-size:12px}'
      + '.gs-popup{box-sizing:border-box;width:min(392px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid #645378;border-radius:20px;background:radial-gradient(ellipse at top left,#33244266,transparent 65%),#14111f;color:#eee;box-shadow:0 24px 80px #0008;font-family:Segoe UI,system-ui,sans-serif}.gs-popup::backdrop{background:#070611b8;backdrop-filter:blur(5px)}'
      + '.gs-popup-heading{display:flex;align-items:center;gap:12px;margin-bottom:15px}.gs-popup-emblem{display:grid;place-items:center;width:32px;height:32px;flex-shrink:0;border:1px solid #b59ce75c;border-radius:9px;background:linear-gradient(145deg,#65508355,#315a6555);color:#c9b5ff;font-size:27px}.gs-popup-eyebrow{font-size:9px;font-weight:700;letter-spacing:1.6px;color:#bba5df}.gs-popup h3{margin:4px 0 0;font-size:18px;line-height:1.3;letter-spacing:-.3px}.gs-popup p{margin:0;color:#aaa3bb;font-size:13px;line-height:1.6}.gs-popup-benefits{display:grid;gap:9px;padding:14px 0;margin:8px 0 14px;border-bottom:1px solid #a892c22b}.gs-popup-benefits>div{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11px}.gs-popup-benefits strong{color:#d8cee7;font-weight:600}.gs-popup-benefits span{color:#9fddd3;text-align:right}.gs-popup-note:empty{display:none}.gs-popup .gs-popup-note{margin-top:12px;padding:10px;border-radius:8px;background:#ffffff08;color:#d1bedf!important;overflow-wrap:anywhere}'
      + '.gs-popup-actions{display:grid;grid-template-columns:1fr;gap:10px;margin:0}.gs-popup-actions button{display:flex;align-items:center;justify-content:center;position:relative;gap:10px;width:100%;min-height:44px;padding:11px 38px;border-radius:11px;font:600 13px/1.4 Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:none}.gs-popup-actions .gs-google{background:#f5f3fa;color:#242032;border:1px solid #ffffff99}.gs-popup-actions .gs-discord-btn{background:#5865ed;color:#fff;border:1px solid #8490ff66}.gs-provider-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:17px;font-weight:750}.gs-google .gs-provider-icon{color:#4285f4}.gs-popup .gs-popup-later{display:block;margin:15px auto 0;padding:7px 18px;min-height:32px;border:0;background:transparent;color:#b2a8c1;font:500 12px Segoe UI,system-ui,sans-serif;box-shadow:none;cursor:pointer}.gs-popup button:focus-visible{outline:2px solid #a3e7dd;outline-offset:3px}.gs-popup button:disabled{opacity:.55;cursor:wait}.gs-popup-actions button:hover:not(:disabled){filter:brightness(1.06)}@media(max-width:360px){.gs-popup{padding:18px}.gs-popup h3{font-size:16px}.gs-popup-benefits>div{font-size:10px}}'
      + '@keyframes gs-flash{0%,100%{box-shadow:none}50%{box-shadow:0 0 0 3px #c5a6ff}}.gs-flash{animation:gs-flash .6s 2}@media(prefers-reduced-motion:reduce){.gs-flash{animation:none}}';
    style.textContent += '.gs-popup{animation:gs-popup-enter .32s cubic-bezier(.2,.8,.2,1) both}.gs-popup::backdrop{animation:gs-backdrop-enter .25s ease-out both}.gs-popup-emblem{animation:gs-emblem-glow 3.5s ease-in-out infinite}.gs-popup-actions button{transition:transform .18s ease,filter .18s ease}.gs-popup-actions button:hover:not(:disabled){transform:translateY(-1px)}.gs-popup-actions button:active:not(:disabled){transform:translateY(0)}@keyframes gs-popup-enter{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes gs-backdrop-enter{from{opacity:0}to{opacity:1}}@keyframes gs-emblem-glow{0%,100%{box-shadow:0 0 0 0 #b99aff00}50%{box-shadow:0 0 20px 2px #b99aff26}}@media(prefers-reduced-motion:reduce){.gs-popup,.gs-popup::backdrop,.gs-popup-emblem{animation:none}.gs-popup-actions button{transition:none}.gs-popup-actions button:hover:not(:disabled){transform:none}}';
    bar = el('div', undefined, 'gs-bar'); bar.setAttribute('aria-live', 'polite');
    // Owner 2026-11-08: the account line sits under the panel's tip line (all tabs), not inside AI Story.
    const hint = document.getElementById('keepOpenHint'), head = hint ? null : panel.querySelector('.fb-builder-head');
    if (hint) hint.after(style, bar); else if (head) head.after(style, bar); else panel.prepend(style, bar);
    render(); refresh();
    document.getElementById('builderTabBtn')?.addEventListener('click', refresh);
    // Not signed in: templates can be browsed, but steps that start writing a story ask for sign-in first
    // (the server refuses them anyway; this just says so before the user fills everything in).
    panel.addEventListener('click', event => {
      return;  // Free version: no sign-in gate — let the user create stories without signing in
      if (state?.signedIn) return;
      const button = event.target.closest?.('button');
      // Opening any template (or the full wizard) asks to sign in first; so do the steps that start writing a story.
      // Parenthesised: a click outside any button (button = null) must not read its text.
      const gated = !!button && (button.classList.contains('fb-template') || /^(Customize everything|Resume setup|Continue|Suggest 5 topics|Create|Build|Try again|Continue to Part)/i.test(button.textContent.trim()));
      if (!button || bar.contains(button) || !gated) return;
      event.preventDefault(); event.stopImmediatePropagation();
      showSignInPopup();
    }, true);
    return true;
  }
  window.FlowGoogleSignIn = {refresh, current: () => state, showSignInPopup, syncDevice, removeDevice,
    signIn:async()=>{state=await signIn();render();return state;},
    signInWithDiscord:async()=>{state=await signInWithDiscord();render();return state;},
    signOut, renderCommunitySupport, affiliateAvailable, openAffiliates};
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.studioAccountRevision||changes.googleAccountRevision))refresh();});
  // Keep the Control plan card current while the user stays on this tab.
  setInterval(() => { if (state?.signedIn && document.visibilityState !== 'hidden' && (document.getElementById('usageLine') || (bar && document.getElementById('builderTabPanel')?.open))) refresh(); }, 60000);
  // The Builder panel is created asynchronously by faceless-builder-ui.js.
  const start = () => { if(document.body?.dataset.studioSettings==='true')return;if (mount()) return; const obs = new MutationObserver(() => { if (mount()) obs.disconnect(); }); obs.observe(document.body, {childList: true, subtree: true}); };
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start(); }
})();
