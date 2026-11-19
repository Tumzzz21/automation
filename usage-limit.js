// usage-limit.js — Free plan: 20 saved results per day (server-counted per installation, all engines); Pro and
// Discord Pro are unlimited (owner 2026-10-16). The queue asks before each prompt and reports every saved result.
// A small line in the Run card shows "Free · N of 20 left today · Upgrade". Upgrade opens the Pro order page.
// When the cloud connection is missing or the server cannot be reached, generation is allowed (never blocks work
// because of a network problem); the server stays the place that counts.
let usageState = null, usageFetchedAt = 0, usageWarnedOffline = false;

async function usageConnection() {
  try {
    const c = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    return c.remoteRepairToken && c.remoteRepairUrl ? c : null;
  } catch { return null; }
}

async function usageRefresh(force = false) {
  if (!force && usageState && Date.now() - usageFetchedAt < 60000) return usageState;
  const c = await usageConnection();
  if (!c || typeof remoteRepairRequest !== 'function') return null;
  try {
    const r = await remoteRepairRequest(c, '/usage/generations');
    if (r.status === 200 && r.body && typeof r.body.used === 'number') { usageState = r.body; usageFetchedAt = Date.now(); renderUsageLine(); }
    return usageState;
  } catch { return null; }
}

// Before each prompt. No daily limit — always allowed.
async function usageAllowsNext(inFlight = 0) {
  return {ok: true};  // Free plan: unlimited generations, no daily cap
}

// After a prompt saved its results: 1 per saved file, so Flow's Outputs x2-x4 count every extra file (_2/_3/_4) too.
async function usageRecordSaved(item) {
  if (!item || item.usageCounted) return;
  item.usageCounted = true;
  const c = await usageConnection();
  if (!c || typeof remoteRepairRequest !== 'function') return;
  try {
    const r = await remoteRepairRequest(c, '/usage/generations', {count: Math.min(4, 1 + (Array.isArray(item.extraOutputs) ? item.extraOutputs.length : 0)), source: item.builderProjectId ? 'builder' : 'queue', platform: settings?.platform || 'flow'});
    if (r.status === 200 && r.body) { usageState = r.body; usageFetchedAt = Date.now(); renderUsageLine(); }
  } catch {}
}

// Storyboard allowances: signed-in Free accounts get 5 sheets per month; Discord Pro gets 20 sheets
// and 1 Factory trial run per month. Paid Pro is unlimited. All trials are counted per account on the server.
// Pro keeps its offline fallback; Free trials need sign-in and a readable allowance.
let featureState = null, featureFetchedAt = 0, usageNudge = '';
async function featureAllowance(force = false) {
  if (!force && featureState && Date.now() - featureFetchedAt < 30000) return featureState;
  const c = await usageConnection();
  if (!c || typeof remoteRepairRequest !== 'function') return null;
  try {
    const r = await remoteRepairRequest(c, '/usage/features');
    if (r.status === 200 && r.body?.sheets) { featureState = r.body; featureFetchedAt = Date.now(); renderUsageLine(); }
    return r.status === 200 ? featureState : null;
  } catch { return null; }
}
async function featureRecord(feature, count = 1) {
  const c = await usageConnection();
  if (!c || typeof remoteRepairRequest !== 'function') return;
  try {
    const r = await remoteRepairRequest(c, '/usage/features', {feature, count});
    if (r.status === 200 && r.body?.sheets) { featureState = r.body; featureFetchedAt = Date.now(); renderUsageLine(); }
  } catch {}
  // The run's last free sheet was just cut: now the Upgrade popup (sheetsLimitReached held it back).
  if (feature === 'sheets' && sheetsPopupPending && featureState?.sheets?.included && !featureState.sheets.unlimited && featureState.sheets.remaining < 1) {
    sheetsPopupPending = false; upgradeNudge(sheetsNudge(0));
  }
}
// One try of a daily per-run feature ('reverse' or 'motion', owner 2026-11-12): Free and Discord Free Pro get 1 a day,
// paid Pro is unlimited; the server counts each run id once. {ok:true} | {ok:false, limit, signIn, message}.
async function featureTake(feature, run) {
  return {ok: true};  // Free plan: all features always allowed, no sign-in needed
}
// A run wants more sheets than are left this month (`left` = sheets it may still make). With 0 left the popup shows now;
// otherwise only after the last free sheet worked (owner 2026-10-25: the popup appeared while that sheet was still running).
let sheetsPopupPending = false;
function sheetsLimitReached(left, text = sheetsNudge(left)) {
  if (!left) { sheetsPopupPending = false; upgradeNudge(text); return; }
  sheetsPopupPending = true;
  if (typeof log === 'function') log(text);
}
// How many of `wanted` storyboard sheets may be made now. Free plan: unlimited.
async function sheetsAllowed(wanted) {
  return wanted;  // No sheet limit — all storyboard sheets allowed
}
const PRO_PITCH = 'Pro: unlimited storyboard sheets, AI upscale and the Overnight Factory.';
// `left` = sheets still allowed for this run (0 when the month's sheets are used). Log line only: Discord Pro users are
// not told about the allowance before they reach it (owner 2026-10-25); the popup below does the selling.
function sheetsNudge(left) {
  const limit = featureState?.sheets?.limit ?? 20;
  const label = featureState?.plan === 'free' ? 'Free trial' : 'Discord Pro';
  return (left ? `${label}: ${left} storyboard sheet${left === 1 ? '' : 's'} left this month; the other prompts run as single images.`
    : `${label}: this month's ${limit} storyboard sheets are used, so these prompts run as single images.`) + ' ' + PRO_PITCH;
}
// A limit was reached: the log line, and an Upgrade popup (`kind` 'sheets' or 'factory'; each at most once per 30 min).
const UPGRADE_POPUPS = {
  sheets: {title: 'Unlock unlimited storyboard sheets', text: "You've used this month's free storyboard sheets, so the rest is made as normal images. Go Pro to keep every scene in sheets."},
  factory: {title: 'Unlock the Overnight Factory', text: 'Your free Factory run this month is done. Go Pro to run up to 5 stories every night while you sleep.'},
  series: {title: 'Unlock long series', text: 'Long series tell one story in 3 or 4 parts of up to 18 scenes each, planned from start to finish. They are part of paid Pro.'},
  reverse: {title: 'Unlimited Video → Story', text: "You've used today's free Video → Story try. Go Pro to turn any video into a story as often as you like, or try again tomorrow."},
  motion: {title: 'Unlimited Motion Studio', text: "You've used today's free Motion Studio try. Go Pro to make as many motion videos as you like, or try again tomorrow."},
  repairs: {title: 'Keep Auto-Fix going today', text: "You've used today's Auto-Fix repairs, so refused prompts are not fixed until midnight Philippine time. Go Pro for 50 Auto-Fix repairs a day."}
};
const upgradePopupShown = {};
// Daily Auto-Fix cap for Free and Discord Pro (server codes FREE_/COMMUNITY_REPAIR_LIMIT, owner 2026-10-31): popup once,
// then the plan card keeps an Upgrade button and a note until midnight Philippine time.
let repairLimitUntil = 0;
function repairLimitReached(message) {
  repairLimitUntil = (Math.floor((Date.now() + 8 * 3600000) / 86400000) + 1) * 86400000 - 8 * 3600000;
  upgradeNudge(message, 'repairs');
  renderUsageLine();
}
function upgradeNudge(text, kind = 'sheets') {
  usageNudge = text;
  if (typeof log === 'function') log(text);
  if (Date.now() - (upgradePopupShown[kind] || 0) < 30 * 60000) return;
  upgradePopupShown[kind] = Date.now();
  showUpgradePopup(UPGRADE_POPUPS[kind] || UPGRADE_POPUPS.sheets);
}
// Same look as the sign-in popup, with its own styles (the sign-in styles only exist once that popup was shown).
const UPGRADE_POPUP_CSS = '.up-popup{box-sizing:border-box;width:min(392px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid #645378;border-radius:20px;background:radial-gradient(ellipse at top left,#33244266,transparent 65%),#14111f;color:#eee;box-shadow:0 24px 80px #0008;font-family:Segoe UI,system-ui,sans-serif;animation:up-in .32s cubic-bezier(.2,.8,.2,1) both}'
  + '.up-popup::backdrop{background:#05030cb8;backdrop-filter:blur(2px)}@keyframes up-in{from{opacity:0;transform:translateY(10px) scale(.98)}}'
  + '.up-heading{display:flex;align-items:center;gap:12px;margin-bottom:14px}.up-emblem{display:grid;place-items:center;width:34px;height:34px;flex-shrink:0;border:1px solid #b59ce75c;border-radius:10px;background:linear-gradient(145deg,#65508355,#315a6555);color:#c9b5ff;font-size:18px;box-shadow:0 0 18px #9f7cff55}'
  + '.up-eyebrow{display:block;font-size:9px;font-weight:700;letter-spacing:1.6px;color:#bba5df}.up-popup h3{margin:3px 0 0;font-size:17px;line-height:1.25;color:#fff}'
  + '.up-popup p{margin:0;color:#aaa3bb;font-size:13px;line-height:1.6}.up-benefits{display:grid;gap:9px;padding:14px 0;margin:12px 0 16px;border-top:1px solid #a892c22b;border-bottom:1px solid #a892c22b}'
  + '.up-benefits div{display:flex;justify-content:space-between;gap:12px;font-size:12.5px}.up-benefits strong{color:#e8e0ff;font-weight:600}.up-benefits span{color:#aaa3bb;text-align:right}'
  + '.up-go{display:block;width:100%;min-height:44px;border:0;border-radius:11px;background:linear-gradient(90deg,#b49cff,#7ee6ef);color:#120d27;font:700 13px/1.4 Segoe UI,system-ui,sans-serif;cursor:pointer}.up-go:hover:not(:disabled){filter:brightness(1.06)}'
  + '.up-later{display:block;margin:12px auto 0;padding:7px 18px;border:0;background:transparent;color:#b2a8c1;font:500 12px Segoe UI,system-ui,sans-serif;cursor:pointer}';
function showUpgradePopup({title, text}) {
  if (typeof document === 'undefined' || document.querySelector('dialog.up-popup, dialog.gs-popup')) return;
  if (!document.getElementById('upgradePopupStyle')) { const st = document.createElement('style'); st.id = 'upgradePopupStyle'; st.textContent = UPGRADE_POPUP_CSS; document.head.append(st); }
  const make = (tag, content, cls) => { const e = document.createElement(tag); if (content) e.textContent = content; if (cls) e.className = cls; return e; };
  const dialog = make('dialog', '', 'up-popup');
  dialog.setAttribute('aria-labelledby', 'upgradePopupTitle');
  const heading = make('div', '', 'up-heading'), emblem = make('span', '✦', 'up-emblem'), words = make('div');
  emblem.setAttribute('aria-hidden', 'true');
  const h = make('h3', title); h.id = 'upgradePopupTitle';
  words.append(make('span', 'UPGRADE TO PRO', 'up-eyebrow'), h); heading.append(emblem, words);
  const benefits = make('div', '', 'up-benefits');
  for (const [label, detail] of [['Storyboard sheets', 'Unlimited, with AI upscale'], ['Overnight Factory', 'Up to 5 stories every night'], ['Generations', 'Unlimited on every platform']]) {
    const row = make('div'); row.append(make('strong', label), make('span', detail)); benefits.append(row);
  }
  const go = make('button', 'Upgrade to Pro', 'up-go'); go.type = 'button';
  go.onclick = async () => { await usageUpgrade(go); dialog.close(); };
  const later = make('button', 'Not now', 'up-later'); later.type = 'button'; later.onclick = () => dialog.close();
  dialog.append(heading, make('p', text), benefits, go, later);
  dialog.addEventListener('close', () => dialog.remove(), {once: true});
  document.body.append(dialog); dialog.showModal();
}

let usageUpgradePending = false;
async function usageUpgrade(button) {
  if (usageUpgradePending) return;
  usageUpgradePending = true;
  const status = document.getElementById('usageLineStatus');
  if (button) button.disabled = true;
  try {
    let c = await usageConnection();
    if (!c) {
      if (status) status.textContent = 'Connecting your extension…';
      if (typeof connectCloudRepair !== 'function') throw Error('Account connection is unavailable. Reopen the extension and try again.');
      await connectCloudRepair();
      c = await usageConnection();
      if (!c) throw Error('Account connection could not finish. Please try again.');
    }
    if (status) status.textContent = '';
    let r = await remoteRepairRequest(c, '/billing/order', {});
    // Not signed in: ask right here (same popup as AI Story), then continue to the order page.
    if (r.status === 403 && globalThis.FlowGoogleSignIn?.showSignInPopup) {
      if (status) status.textContent = '';
      const ok = await FlowGoogleSignIn.showSignInPopup({eyebrow: 'UPGRADE TO PRO', title: 'Sign in to upgrade',
        text: 'Pro is added to your account, so it works after a reinstall or on another computer.',
        benefits: [['Pro', 'No daily limit (your own Flow, ChatGPT, Gemini and Grok accounts)']]});
      if (!ok) { if (status) status.textContent = 'Sign in to continue to Upgrade.'; return; }
      c = await usageConnection();
      if (!c) throw Error('Account connection was lost. Please try again.');
      r = await remoteRepairRequest(c, '/billing/order', {});
    }
    if (r.status === 200 && r.body?.url) {
      chrome.tabs.create({url: r.body.url});
      if (status) status.textContent = `Your reference code: ${r.body.code}`;
    } else if (status) status.textContent = r.body?.error || 'Upgrade is not available right now. Try again later.';
  } catch (e) { if (status) status.textContent = 'Upgrade could not open: ' + (e.message || e); }
  finally { usageUpgradePending = false; if (button) button.disabled = false; }
}

// Static provider artwork; account text is always assigned with textContent.
const usageGoogleIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.3h5.4a4.6 4.6 0 0 1-2 3v2.8h3.3c1.9-1.8 2.9-4.4 2.9-7.9Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.6c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3v2.7A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.8a6 6 0 0 1 0-3.6V7.5H3a10 10 0 0 0 0 9l3.4-2.7Z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.7C7.2 7.8 9.4 6 12 6Z"/></svg>';
const usageDiscordIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#5865F2" d="M20.3 4.5a20 20 0 0 0-4.9-1.5l-.6 1.2a18 18 0 0 0-5.6 0L8.6 3a20 20 0 0 0-4.9 1.5C.6 9.1-.2 13.6.2 18a20 20 0 0 0 6 3l1.2-2a13 13 0 0 1-1.9-.9l.5-.4a14 14 0 0 0 12 0l.5.4-1.9.9 1.2 2a20 20 0 0 0 6-3c.5-5.1-.9-9.5-3.5-13.5ZM8 15.4c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.1 1.1 2.1 2.4-.9 2.4-2.1 2.4Zm8 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.1 1.1 2.1 2.4-.9 2.4-2.1 2.4Z"/></svg>';
let usageAccountBusy = false;
function renderUsageAccount() {
  const host = document.getElementById('usageAccount');
  if (!host) return;
  const auth = globalThis.FlowGoogleSignIn, account = auth?.current?.();
  host.replaceChildren();
  const button = (label, icon, method) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'usage-icon'; b.title = label;
    b.setAttribute('aria-label', label); b.innerHTML = icon;
    b.disabled = usageAccountBusy || !auth;
    b.onclick = async () => {
      usageAccountBusy = true; renderUsageAccount();
      const status = document.getElementById('usageLineStatus');
      if (status) status.textContent = '';
      let failed = false;
      try {
        await auth[method]();
        // A notification failure must not report a successful login/logout as failed.
        try { await globalThis.chrome?.storage?.local?.set?.({studioAccountRevision: Date.now()}); } catch {}
        await usageRefresh(true);
      }
      catch { failed = true; }
      finally {
        usageAccountBusy = false; renderUsageAccount();
        // Keep the card compact; put retry feedback on the action that failed.
        if (failed) {
          const retry = [...host.children].find(child => child.title === label);
          if (retry) retry.title = label + ' could not finish. Please try again.';
        }
      }
    };
    host.append(b);
  };
  if (account?.signedIn) {
    const provider = document.createElement('span'); provider.className = 'usage-provider';
    provider.innerHTML = account.via === 'discord' ? usageDiscordIcon : usageGoogleIcon;
    provider.title = account.via === 'discord' ? 'Signed in with Discord' : 'Signed in with Google';
    const name = document.createElement('span'); name.className = 'usage-identity';
    name.textContent = account.email ? String(account.email).replace(/^([^@])[^@]*@/, '$1•••@') : (account.name || 'Signed in');
    provider.append(name); host.append(provider);
    button('Sign out', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 4H4v16h5M13 7l5 5-5 5M8 12h12"/></svg>', 'signOut');
  } else {
    button('Sign in with Google', usageGoogleIcon, 'signIn');
    button('Sign in with Discord', usageDiscordIcon, 'signInWithDiscord');
  }
}

let sheetAllowanceRetryAt = 0;
// Free sheet trials require sign-in and a server-confirmed monthly allowance.
function renderManualSheetAllowance() {
  if (typeof document === 'undefined') return;
  const toggle = document.getElementById('manualSheets'), note = document.getElementById('manualSheetsAllowance');
  if (!toggle) return;
  const f = featureState?.sheets, signedIn = !!globalThis.FlowGoogleSignIn?.current?.()?.signedIn;
  const allowed = (f ? !!f.included : !!usageState?.unlimited) && (featureState?.plan !== 'free' || signedIn);
  toggle.disabled = !allowed || (typeof running !== 'undefined' && running);
  toggle.checked = allowed && typeof settings !== 'undefined' && !!settings.manualSheets;
  // An AI Story run with storyboard sheets shows the switch on (display only; the saved Control setting is unchanged).
  const story = globalThis.aiStorySheetsRun, storyRun = !!story && typeof queue !== 'undefined' && queue.some(x => x.builderProjectId === story);
  if (storyRun) { toggle.checked = true; toggle.disabled = true; toggle.dataset.aiStory = '1'; } else delete toggle.dataset.aiStory;
  const upscale = document.getElementById('sheetUpscale');
  if (upscale) upscale.disabled = toggle.disabled;
  // Owner 2026-10-30: a PRO badge shows Free and Discord Pro users that sheets are a Pro feature; the badge and the greyed-out
  // switch open the Upgrade popup. A missing allowance is fetched again instead of staying on "Connect to check".
  const chip = document.getElementById('manualSheetsPro'), paid = !!usageState?.unlimited && usageState?.plan !== 'community';
  if (chip) chip.hidden = paid || !!f?.unlimited;
  if (!f && signedIn && Date.now() - sheetAllowanceRetryAt > 30000) { sheetAllowanceRetryAt = Date.now(); featureAllowance(true); }
  if (note) note.textContent = storyRun
    ? 'On for this AI Story run (its Scene images choice): reference cards are single images, scenes are grouped 4 per sheet.' + (f?.included && !f?.unlimited ? ` ${f.remaining} of ${f.limit} sheets left this month.` : '')
    : !signedIn && !usageState?.unlimited
    ? 'Sign in with Google or Discord for 5 free storyboard sheets per month. Unlimited with Pro.' : f?.unlimited ? 'Unlimited storyboard sheets.' : f?.included
    ? `${f.remaining} of ${f.limit} sheets left this month (unlimited with Pro). Then scenes run as single images.`
    : f ? 'Storyboard sheets are a Pro feature. Tap PRO to upgrade.'
    : signedIn ? 'Checking your storyboard sheet allowance…' : 'Sign in to check your storyboard sheet allowance.';
}
function openSheetsUpgrade(event) {
  if (typeof running !== 'undefined' && running) return;
  event?.preventDefault?.();
  if (typeof showUpgradePopup === 'function') showUpgradePopup(UPGRADE_POPUPS.sheets);
}

function renderUsageLine() {
  if (typeof document === 'undefined') return;
  renderManualSheetAllowance();
  const box = document.getElementById('usageLine');
  if (!box) return;
  renderUsageAccount();
  const s = usageState;
  if (!s) { box.hidden = true; return; }
  box.hidden = false;
  const text = document.getElementById('usageLineText'), btn = document.getElementById('usageUpgradeBtn'), plan = document.getElementById('usagePlan'), fill = document.getElementById('usageMeterFill');
  const planLabel = plan?.querySelector?.('.usage-plan-label') || plan;
  const paid = !!s.unlimited && ['pro', 'community'].includes(s.plan);
  const proIcon = document.getElementById('usageProIcon');
  // SVG elements do not reflect the HTML .hidden property; toggle the attribute.
  if (proIcon) proIcon.toggleAttribute('hidden', !paid);
  if (plan) plan.classList.toggle('is-paid', paid);
  if (s.unlimited) {
    text.textContent = 'Unlimited';
    if (planLabel) planLabel.textContent = s.plan === 'community' ? 'Discord Pro' : s.plan === 'owner' ? '✦ Owner' : 'Pro';
    box.classList.remove('is-low', 'is-out'); box.classList.add('is-unlimited');
    const capped = s.plan === 'community' && Date.now() < repairLimitUntil;
    const renew = s.plan === 'pro' ? proRenewal(globalThis.FlowGoogleSignIn?.current?.()) : null;
    if (renew) text.textContent = renew.text;
    renewButton(btn, !!renew);
    box.classList.toggle('is-renew', !!renew); // Pro hides the button row; the Renew button needs it back
    if (btn) btn.hidden = !capped && !renew;
    repairLimitNote(capped);
    return;
  }
  renewButton(btn, false);
  box.classList.remove('is-renew');
  text.textContent = globalThis.matchMedia?.('(max-width:379px)').matches ? `${s.remaining}/${s.limit}` : `${s.remaining} / ${s.limit} today`;
  if (planLabel) planLabel.textContent = '⚡ Free plan';
  if (fill) fill.style.width = (s.limit ? Math.max(0, Math.min(100, 100 * s.remaining / s.limit)) : 0) + '%';
  box.classList.remove('is-unlimited');
  box.classList.toggle('is-low', s.remaining > 0 && s.remaining <= 5);
  box.classList.toggle('is-out', s.remaining === 0);
  if (btn) btn.hidden = false;
  repairLimitNote(Date.now() < repairLimitUntil);
}
// Paid Pro does not renew by itself (owner 2026-11-14): from 7 days before it ends the card says when, and the Upgrade
// button becomes Renew (same checkout; renewing adds the days on top). Discord Pro has no end date, so it never shows.
const RENEW_SHOW_DAYS = 7;
function proRenewal(account, now = Date.now()) {
  const until = Number(account?.proUntil);
  if (!account?.signedIn || account.plan !== 'pro' || !Number.isFinite(until) || until <= now) return null;
  // Calendar days in the member's own time zone, so 15 hours left at 6 pm reads "tomorrow", not "today".
  const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((midnight(until) - midnight(now)) / 86400000);
  if (days > RENEW_SHOW_DAYS) return null;
  return {days, text: days <= 0 ? 'Pro ends today' : days === 1 ? 'Pro ends tomorrow' : `Pro ends in ${days} days`};
}
function renewButton(btn, on) {
  const label = btn?.querySelector?.('span');
  if (!label) return;
  if (!btn.dataset.upgradeLabel) { btn.dataset.upgradeLabel = label.textContent; btn.dataset.upgradeTitle = btn.title || ''; }
  label.textContent = on ? 'Renew Pro' : btn.dataset.upgradeLabel;
  btn.title = on ? 'Pro does not renew by itself. Renewing adds the new days on top of the days you still have.' : btn.dataset.upgradeTitle;
  btn.classList.toggle('is-renew', on);
}
function repairLimitNote(capped) {
  const status = document.getElementById('usageLineStatus');
  if (status && capped) status.textContent = "Today's Auto-Fix repairs are used. Pro gives 50 a day.";
  else if (status && /Auto-Fix repairs are used/.test(status.textContent)) status.textContent = '';
}

if (typeof document !== 'undefined' && globalThis.chrome?.storage) {
  document.getElementById('usageUpgradeBtn')?.addEventListener('click', event => usageUpgrade(event.currentTarget));
  // Refresh plan: right after paying, Pro shows without reopening the panel.
  document.getElementById('usageRefreshBtn')?.addEventListener('click', async event => { const b = event.currentTarget; b.classList.add('spin'); b.disabled = true; try { await usageRefresh(true); } finally { b.classList.remove('spin'); b.disabled = false; } });
  globalThis.addEventListener?.('resize', renderUsageLine);
  // PRO badge, and taps on the greyed-out sheets switch, open the Upgrade popup.
  const sheetsChip = document.getElementById('manualSheetsPro');
  sheetsChip?.addEventListener('click', openSheetsUpgrade);
  sheetsChip?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') openSheetsUpgrade(e); });
  document.querySelector('#manualSheetsRow .sheet-toggle')?.addEventListener('click', e => { if (document.getElementById('manualSheets')?.disabled && e.target?.id !== 'manualSheetsPro') openSheetsUpgrade(e); });
  usageRefresh(true);
  featureAllowance(true);
  // Plan changes (sign-in, Pro approved) and a new day show up without reopening the panel.
  setInterval(() => { if (document.visibilityState === 'visible' && !(typeof running !== 'undefined' && running)) usageRefresh(true); }, 5 * 60000);
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && (changes.remoteRepairToken || changes.googleAccountRevision || changes.studioAccountRevision)) {
      featureState = null; featureFetchedAt = 0;
      renderManualSheetAllowance(); usageRefresh(true); featureAllowance(true);
    }
  });
}

if (typeof module !== 'undefined') module.exports = {usageAllowsNext, usageRecordSaved, renderUsageLine, _set: s => { usageState = s; usageFetchedAt = Date.now(); }};
