// Gemini queues: switch to the next chosen Gemini account when Gemini's daily video or image limit is reached
// (owner 2026-11-13, members with Google AI plans on several accounts). A Gemini queue always stays on Gemini: it never
// moves to Flow (different videos, settings and costs). Paid Pro uses up to 10 accounts, Discord Pro the Main and 2nd.
// Gemini keeps the Google account in the path: gemini.google.com/u/0/videos, /u/1/videos, /u/2/videos (owner's browser).
// Built like manual-account-switch.js (Flow), which stays as it is.
(() => {
  const KEY = 'geminiAccountSwitch', PAUSE_MS = 30000, PRO_ACCOUNTS = 10, DISCORD_ACCOUNTS = 2;
  const NAMES = ['Main', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  let state = {on: false, accounts: [0, 1]}, switching = false, opening = false, revision = 0, preparedTab = null;
  const plan = () => { const p = window.FlowGoogleSignIn?.current?.()?.plan; return p || (typeof usageState !== 'undefined' && usageState?.unlimited ? usageState.plan : ''); };
  const isPro = () => ['pro', 'community'].includes(plan());
  const maxAccounts = () => plan() === 'pro' ? PRO_ACCOUNTS : DISCORD_ACCOUNTS;
  const locked = n => n >= maxAccounts();
  const chosenList = () => [...new Set(state.accounts)].filter(n => !locked(n)).slice(0, maxAccounts());
  const onGemini = () => typeof settings !== 'undefined' && settings.platform === 'gemini';
  const save = () => { revision++; return chrome.storage.local.set({[KEY]: state}).catch(() => {}); };
  const say = text => { if (typeof log === 'function') log(text); };

  const isGemini = tab => /^https:\/\/gemini\.google\.com(?:\/|$)/i.test(tab?.url || '');
  // No /u/N/ (and no ?authuser=N) in the address is the first account.
  function accountOf(url) {
    const value = String(url || '');
    const m = value.match(/^https:\/\/gemini\.google\.com\/u\/(\d+)(?:\/|$|\?)/i) || (isGemini({url: value}) && value.match(/[?&]authuser=(\d+)/i));
    return m ? Number(m[1]) : 0;
  }
  const imageMode = () => typeof settings !== 'undefined' && (settings.mode === 'text-to-image' || settings.mode === 'image-to-image');
  const accountUrl = n => 'https://gemini.google.com/u/' + Number(n) + '/' + (imageMode() ? 'images' : 'videos');
  const label = n => Number(n) > 0 ? 'your ' + (NAMES[Number(n)] || (Number(n) + 1) + 'th') + ' Gemini account' : 'your main Gemini account';
  // Gemini's own limit stop (gemini-engine.js: queueStopReason "Gemini video limit reached" / "Gemini image limit reached").
  const limitStop = info => /^Gemini (?:video|image) limit reached/i.test(String(info?.reason || ''));

  // Compact copy for the AI Story page (owner 2026-11-14: a story on Gemini showed the Flow switch). Same setting as
  // Control; Change opens Control at the full box to pick the accounts.
  const storyRows = new Set();
  function paintStoryRows(only = null) {
    const pro = isPro(), on = !!state.on && pro, chosen = chosenList();
    for (const row of only ? [only] : storyRows) {
      if (!only && !row.isConnected) { if (row.dataset.shown) storyRows.delete(row); continue; }
      if (row.isConnected) row.dataset.shown = '1';
      const input = row.querySelector('input');
      if (input) { input.checked = on; input.disabled = typeof running !== 'undefined' && running; }
      const badge = row.querySelector('.ms-pro'); if (badge) badge.hidden = pro;
      const txt = row.querySelector('.ms-story-text');
      if (txt) txt.textContent = !pro ? 'Pro and Discord Pro'
        : !on ? 'Off · this story stops when Gemini\'s daily limit is reached'
        : chosen.length < 2 ? 'Choose at least two accounts'
        : chosen.map(n => NAMES[n]).join(' → ') + ' · sign in to each in Chrome';
      row.classList.toggle('ms-story-warn', on && chosen.length < 2);
    }
  }
  function storyRow() {
    build();
    const row = document.createElement('div'); row.className = 'ms-story';
    row.innerHTML = '<label class="ms-row"><input type="checkbox" role="switch"><span>⇄ Switch Gemini account when the daily limit is reached</span><b class="ms-pro">PRO</b></label>'
      + '<div class="ms-story-sub"><small class="ms-story-text"></small><button type="button" class="ms-story-change">Change</button></div>';
    row.querySelector('input').addEventListener('change', e => {
      if (e.target.checked && !isPro()) {
        e.target.checked = false;
        if (typeof upgradeNudge === 'function') upgradeNudge('Switching Gemini accounts when the daily limit is reached is for Pro and Discord Pro.', 'switch');
        return;
      }
      state.on = e.target.checked; save(); render();
    });
    row.querySelector('.ms-story-change').addEventListener('click', () => {
      document.getElementById('controlTabBtn')?.click();
      setTimeout(() => {
        const box = document.getElementById('geminiSwitch');
        if (box) { box.hidden = false; const panel = box.querySelector('.ms-panel'); if (panel) panel.hidden = !(state.on && isPro()); }   // shown here even when Control is on another engine
        box?.scrollIntoView({block: 'center', behavior: 'smooth'}); box?.querySelector('#geminiSwitchOn')?.focus();
      }, 150);
    });
    storyRows.add(row); paintStoryRows(row);
    return row;
  }

  function render() {
    paintStoryRows();
    const box = document.getElementById('geminiSwitch');
    if (!box) return;
    box.hidden = !onGemini();
    const pro = isPro(), on = !!state.on && pro;
    const toggle = box.querySelector('#geminiSwitchOn'); if (toggle) { toggle.checked = on; toggle.disabled = typeof running !== 'undefined' && running; }
    const badge = box.querySelector('.ms-pro'); if (badge) badge.hidden = pro;
    const panel = box.querySelector('.ms-panel'); if (panel) panel.hidden = !on;
    const head = box.querySelector('.ms-head'); if (head) head.textContent = '▸ GEMINI ACCOUNTS · MAX ' + maxAccounts() + ' · USED IN ORDER';
    for (const chip of box.querySelectorAll('.ms-acc')) {
      const n = Number(chip.value), lock = locked(n), text = chip.nextElementSibling;
      chip.checked = !lock && state.accounts.includes(n);
      chip.disabled = lock; text.classList.toggle('ms-locked', lock);
      text.textContent = (lock ? '🔒 ' : '') + NAMES[n];
      text.title = lock ? 'Upgrade to paid Pro to switch between up to ' + PRO_ACCOUNTS + ' Gemini accounts' : 'gemini.google.com/u/' + n + '/ · ' + (n ? 'the ' + NAMES[n] + ' account' : 'your main Google account');
    }
  }

  function build() {
    const anchor = document.getElementById('manualSwitch') || document.querySelector('.run-tools-row');
    if (!anchor || document.getElementById('geminiSwitch')) return;
    const box = document.createElement('div'); box.id = 'geminiSwitch'; box.className = 'ms-box';
    box.innerHTML = '<label class="ms-row" for="geminiSwitchOn"><input id="geminiSwitchOn" type="checkbox" role="switch"><span>Switch Gemini account when the daily limit is reached</span><b class="ms-pro">PRO</b></label>'
      + '<div class="ms-panel"><div class="ms-head">▸ GEMINI ACCOUNTS · USED IN ORDER</div><div class="ms-grid">'
      + NAMES.map((name, n) => `<input type="checkbox" class="ms-acc" id="gsAcc${n}" value="${n}"><label for="gsAcc${n}">${name}</label>`).join('')
      + '</div><small class="ms-own">Use only accounts you own.</small>'
      + '<small>Main = gemini.google.com/u/0/, 2nd = /u/1/ … · sign in to each in Chrome first · ~30 s pause, then the queue continues on the next account · the queue always stays on Gemini.</small></div>';
    anchor.after(box);
    box.querySelector('#geminiSwitchOn').addEventListener('change', e => {
      if (e.target.checked && !isPro()) {
        e.target.checked = false;
        if (typeof upgradeNudge === 'function') upgradeNudge('Switching Gemini accounts when the daily limit is reached is for Pro and Discord Pro.', 'switch');
        return;
      }
      state.on = e.target.checked; save(); render();
    });
    for (const chip of box.querySelectorAll('.ms-acc')) chip.addEventListener('change', () => {
      const picked = [...box.querySelectorAll('.ms-acc')].filter(c => c.checked).map(c => Number(c.value));
      if (picked.length > maxAccounts()) { chip.checked = false; say('Account switching uses at most ' + maxAccounts() + ' Gemini accounts on your plan.'); return; }
      state.accounts = picked; save(); paintStoryRows();
    });
    box.querySelector('.ms-grid').addEventListener('click', e => {
      if (!e.target.closest('label.ms-locked')) return;
      e.preventDefault();
      if (typeof upgradeNudge === 'function') upgradeNudge('Discord Pro switches between 2 Gemini accounts. Upgrade to paid Pro for up to ' + PRO_ACCOUNTS + '.', 'switch');
    });
    document.getElementById('platformSelect')?.addEventListener('change', () => setTimeout(render, 0));
    chrome.storage.onChanged.addListener(changes => { if (changes.googleAccountRevision || changes.studioAccountRevision) setTimeout(render, 500); });
    render();
  }

  async function exactTab(id) { return (await chrome.tabs.query({})).find(t => t.id === id) || null; }
  async function taskTab() {
    const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    if (isGemini(active)) return active;
    const open = (await chrome.tabs.query({url: ['https://gemini.google.com/*']})).filter(isGemini);
    if (open.length > 1) throw Error('Several Gemini tabs are open. Open the Gemini tab you want to use before Start.');
    return open[0] || null;
  }
  async function useAccount(n, original, valid = () => true) {
    const url = accountUrl(n);
    if (!valid()) throw Error('Account switch cancelled.');
    if (original) { const current = await exactTab(original.id); if (!current || current.url !== original.url) throw Error('The queue Gemini tab changed; no account was switched.'); }
    const tab = original ? await chrome.tabs.update(original.id, {url, active: true}) : await chrome.tabs.create({url, active: true});
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 1000)); if (!valid()) throw Error('Account switch cancelled.');
      const t = await exactTab(tab.id); if (!t) throw Error('the Gemini tab was closed');
      // Not signed in to that account: Google sends the tab to its sign-in page or back to another account.
      if (t.status === 'complete' && isGemini(t) && accountOf(t.url) === Number(n)) return t;
    }
    throw Error('Gemini did not open on that account');
  }

  // With the switch on, Start opens the first chosen account when the Gemini tab is on an account that was not chosen.
  async function beforeStart(items) {
    if (!switching) preparedTab = null;
    if (switching || !state.on || !isPro() || !onGemini()) return;
    if (!(items || []).some(item => item.status === 'pending' && !item.groupParent)) return;
    const chosen = chosenList();
    if (!chosen.length) return;
    let tab; try { tab = await taskTab(); } catch (e) { say(e.message); return false; }
    if (tab && chosen.includes(accountOf(tab.url))) { preparedTab = tab; return; }
    if (opening) return false;
    opening = true;
    say(`${tab ? label(accountOf(tab.url)) + ' is not one of your chosen Gemini accounts' : 'No Gemini tab is open'}; opening ${label(chosen[0])} first.`);
    const rev = revision, valid = () => revision === rev && state.on && isPro() && onGemini();
    try { preparedTab = await useAccount(chosen[0], tab, valid); say(`Starting on ${label(chosen[0])}.`); }
    catch (e) { say('Could not open ' + label(chosen[0]) + ': ' + (e.message || e) + '. Sign in to that account in Chrome, or open it in Gemini, then press Start.'); return false; }
    finally { opening = false; }
  }

  // Called by control.js when a queue ends. Only a Gemini queue that stopped on Gemini's daily limit switches.
  async function queueEnded(info, items) {
    if (switching || !limitStop(info)) return;
    const skip = why => say('Gemini account switching skipped: ' + why);
    if (!state.on) return isPro() ? skip('the switch is off.') : undefined;
    if (!isPro()) return skip('your plan is not showing as Pro or Discord Pro yet; press ↻ on the plan card, then Start.');
    if (!onGemini()) return skip('it only works on Gemini.');
    if (!(items || []).some(item => item.status === 'pending')) return skip('no prompts are left to run.');
    const chosen = chosenList();
    if (chosen.length < 2) return say('Gemini account switching needs at least two chosen accounts.');
    const tab = info.tabId != null ? await exactTab(info.tabId) : null;
    if (!isGemini(tab)) return skip('the queue Gemini tab was closed or changed.');
    const current = accountOf(tab.url), index = chosen.indexOf(current);
    if (index < 0) return skip('the queue Gemini account is not selected.');
    const next = chosen[index + 1];
    if (next === undefined) return say('Gemini\'s daily limit is reached on every chosen account; the queue stays paused until the limit resets.');
    const rev = revision, ownedItems = items, token = typeof runToken !== 'undefined' ? runToken : null, picked = chosen.join(',');
    const valid = () => revision === rev && state.on && isPro() && onGemini() && !(typeof running !== 'undefined' && running)
      && (typeof queue === 'undefined' || queue === ownedItems) && (typeof runToken === 'undefined' || runToken === token) && chosenList().join(',') === picked;
    switching = true;
    try {
      say(`Gemini's daily limit is reached on ${label(current)}. Switching to ${label(next)} in about 30 seconds, then the remaining prompts continue.`);
      const until = Date.now() + PAUSE_MS;
      while (Date.now() < until) { await new Promise(r => setTimeout(r, 1000)); if (!valid()) return say('Gemini account switch cancelled; the queue stays paused.'); }
      preparedTab = await useAccount(next, tab, valid);
      if (!valid()) return say('Gemini account switch cancelled; the queue stays paused.');
      say(`Now on ${label(next)}; continuing the queue.`);
      await startQueue();
    } catch (e) { say('Could not switch Gemini account: ' + (e.message || e) + '. Sign in to that account in Chrome, then press Start.'); }
    finally { switching = false; }
  }

  chrome.storage.local.get([KEY]).then(r => { if (r[KEY]) state = {...state, ...r[KEY]}; build(); render(); }).catch(build);
  // The Flow switch builds its box after its own storage read; build again once it is there so Gemini's sits below it.
  setTimeout(() => { build(); render(); }, 1500);
  window.geminiAccountSwitch = {queueEnded, beforeStart, render, storyRow, accountOf, accountUrl, cancelPending: () => { revision++; }, takeStartTab: () => { const tab = preparedTab; preparedTab = null; return tab; }};
})();
