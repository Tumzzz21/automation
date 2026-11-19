// Manual Flow queues: switch to the next chosen Flow account when credits run out (owner 2026-10-28).
// Paid Pro uses up to 10 accounts (owner 2026-11-13, was 5); Discord Pro the Main and 2nd, the other chips locked with an upgrade note (owner 2026-10-29), opt-in with a paid-plan confirmation. AI Story and Factory runs are left alone (the
// Factory has its own switching). Flow keeps the Google account in the path: main = flow.google.com/, 2nd = /u/1/.
(() => {
  const KEY = 'manualAccountSwitch', PAUSE_MS = 30000, NAMES = ['Main', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  let state = {on: false, accounts: [0, 1], confirmedPaid: false}, switching = false, opening = false, revision = 0, preparedTab = null;
  const F = () => import('./lib/factory.mjs');
  // The sign-in state, or the Control plan counter when the sign-in has not loaded yet.
  const plan = () => { const p = window.FlowGoogleSignIn?.current?.()?.plan; return p || (typeof usageState !== 'undefined' && usageState?.unlimited ? usageState.plan : ''); };
  const isPro = () => ['pro', 'community'].includes(plan());
  const PRO_ACCOUNTS = 10, DISCORD_ACCOUNTS = 2;
  const maxAccounts = () => plan() === 'pro' ? PRO_ACCOUNTS : DISCORD_ACCOUNTS;
  const locked = n => n >= maxAccounts();   // Discord Pro: 3rd-10th need paid Pro
  const save = () => { revision++; return chrome.storage.local.set({[KEY]: state}).catch(() => {}); };

  function render() {
    const box = document.getElementById('manualSwitch');
    if (!box) return;
    box.hidden = (settings.platform || 'flow') !== 'flow';
    const pro = isPro(), on = !!state.on && pro;
    box.querySelector('#manualSwitchOn').checked = on;
    box.querySelector('#manualSwitchOn').disabled = typeof running !== 'undefined' && running;
    box.querySelector('.ms-pro').hidden = pro;
    box.querySelector('.ms-panel').hidden = !on;
    box.querySelector('.ms-head').textContent = '▸ FLOW ACCOUNTS · MAX ' + maxAccounts() + ' · USED IN ORDER';
    for (const chip of box.querySelectorAll('.ms-acc')) {
      const n = Number(chip.value), lock = locked(n), label = chip.nextElementSibling;
      chip.checked = !lock && state.accounts.includes(n);
      chip.disabled = lock; label.classList.toggle('ms-locked', lock);
      label.textContent = (lock ? '🔒 ' : '') + NAMES[n];
      label.title = lock ? 'Upgrade to paid Pro to switch between up to ' + PRO_ACCOUNTS + ' Flow accounts' : n ? 'The ' + NAMES[n] + ' account in Flow\'s account menu' : 'Your main Google account in Flow';
    }
    box.querySelector('#manualSwitchPaid').checked = !!state.confirmedPaid;
    paintStoryRows();
  }

  // Compact copy for the AI Story page (owner 2026-11-01): the same setting as Control, so a story's Auto run shows whether
  // it will switch. Change opens Control at the full panel to pick accounts and confirm the paid plans.
  const storyRows = new Set();
  function paintStoryRows(only = null) {
    const pro = isPro(), on = !!state.on && pro, chosen = [...new Set(state.accounts)].filter(n => !locked(n)).slice(0, maxAccounts());
    for (const row of only ? [only] : storyRows) {
      // A new row is painted before AI Story puts it on the page; drop rows only after they have been shown and removed.
      if (!only && !row.isConnected) { if (row.dataset.shown) storyRows.delete(row); continue; }
      if (row.isConnected) row.dataset.shown = '1';
      const input = row.querySelector('input');
      input.checked = on; input.disabled = typeof running !== 'undefined' && running;
      row.querySelector('.ms-pro').hidden = pro;
      row.querySelector('.ms-story-text').textContent = !pro ? 'Pro and Discord Pro'
        : !on ? 'Off · this story stops when Flow credits run out'
        : chosen.length < 2 ? 'Choose at least two accounts'
        : chosen.map(n => NAMES[n]).join(' → ') + (state.confirmedPaid ? ' · each with its own paid Flow plan' : ' · confirm each has its own paid Flow plan');
      row.classList.toggle('ms-story-warn', on && (chosen.length < 2 || !state.confirmedPaid));
    }
  }
  function storyRow() {
    build();
    const row = document.createElement('div'); row.className = 'ms-story';
    row.innerHTML = '<label class="ms-row"><input type="checkbox" role="switch"><span>⇄ Switch Flow account when credits run out</span><b class="ms-pro">PRO</b></label>'
      + '<div class="ms-story-sub"><small class="ms-story-text"></small><button type="button" class="ms-story-change">Change</button></div>';
    row.querySelector('input').addEventListener('change', e => {
      if (e.target.checked && !isPro()) {
        e.target.checked = false;
        if (typeof upgradeNudge === 'function') upgradeNudge('Switching Flow accounts when credits run out is for Pro and Discord Pro.', 'switch');
        return;
      }
      state.on = e.target.checked; save(); render();
    });
    row.querySelector('.ms-story-change').addEventListener('click', () => {
      document.getElementById('controlTabBtn')?.click();
      setTimeout(() => { const box = document.getElementById('manualSwitch'); box?.scrollIntoView({block: 'center', behavior: 'smooth'}); box?.querySelector('#manualSwitchOn')?.focus(); }, 150);
    });
    storyRows.add(row); paintStoryRows(row);
    return row;
  }

  function build() {
    const anchor = document.querySelector('.run-tools-row');
    if (!anchor || document.getElementById('manualSwitch')) return;
    const box = document.createElement('div'); box.id = 'manualSwitch'; box.className = 'ms-box';
    box.innerHTML = '<label class="ms-row" for="manualSwitchOn"><input id="manualSwitchOn" type="checkbox" role="switch"><span>Switch Flow account when credits run out</span><b class="ms-pro">PRO</b></label>'
      + '<div class="ms-panel"><div class="ms-head">▸ FLOW ACCOUNTS · MAX 3 · USED IN ORDER</div><div class="ms-grid">'
      + NAMES.map((name, n) => `<input type="checkbox" class="ms-acc" id="msAcc${n}" value="${n}"><label for="msAcc${n}" title="${n ? 'The ' + name + ' account in Flow\'s account menu' : 'Your main Google account in Flow'}">${name}</label>`).join('')
      + '</div><label class="ms-row ms-paid" for="manualSwitchPaid"><input id="manualSwitchPaid" type="checkbox"><span>Each chosen account has its own paid Flow plan</span></label>'
      + '<small class="ms-own">Use only accounts you own, each with its own Flow plan.</small>'
      + '<small>Order of Flow\'s account menu · sign in to each in Chrome first · ~30 s pause, then the queue continues on the next account · unusual activity stops all.</small></div>';
    anchor.after(box);
    const style = document.createElement('style');
    style.textContent = '.ms-box{margin:6px 0 0;display:grid;gap:6px}.ms-box[hidden],.ms-panel[hidden],.ms-pro[hidden]{display:none!important}'
      + '.ms-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#cbd3df;cursor:pointer}.ms-row span{line-height:20px}'
      + '.ms-pro{font:700 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;color:#ff2bd6;border:1px solid #ff2bd666;border-radius:4px;padding:3px 5px;margin-left:auto}'
      + '.ms-panel{display:grid;gap:7px;padding:9px 10px;border:1px solid #00e5ff40;border-radius:8px;background:linear-gradient(135deg,#0a0714,#140b26);box-shadow:inset 0 0 14px #00e5ff14}'
      + '.ms-head{font:600 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#00e5ff;text-shadow:0 0 6px #00e5ff88}'
      + '.ms-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}.ms-grid input.ms-acc[type=checkbox]{position:absolute!important;opacity:0!important;width:1px!important;height:1px!important;min-height:0!important;pointer-events:none}'
      + '.ms-grid label{display:block;padding:6px 0;text-align:center;border:1px solid #3b2f57;border-radius:6px;font:600 11px/1 ui-monospace,Consolas,monospace;color:#8f82b3;background:#120c1f;cursor:pointer}'
      + '.ms-acc:checked+label{border-color:#00e5ff;color:#eafdff;background:#00e5ff14;box-shadow:0 0 8px #00e5ff66}.ms-acc:focus-visible+label{outline:2px solid #ff2bd6;outline-offset:2px}'
      + '.ms-grid label.ms-locked{opacity:.55;border-style:dashed;color:#ff2bd6;font-size:10px}'
      + '.ms-paid{border-top:1px dashed #ff2bd640;padding-top:7px}.ms-panel small{font-size:10.5px;line-height:1.35;color:#8a7dab}.ms-panel small.ms-own{color:#f0c674}'
      + '.ms-story{display:grid;gap:3px;margin:8px 0 2px;padding:8px 10px;border:1px solid #3b2f57;border-radius:8px;background:#120c1f}.ms-story .ms-pro[hidden]{display:none}'
      + '.ms-story-sub{display:flex;align-items:center;gap:8px;padding-left:2px}.ms-story-text{flex:1;min-width:0;font-size:10.5px;line-height:1.35;color:#8a7dab}'
      + '.ms-story-warn .ms-story-text{color:#f0c674}.ms-story-change{flex:none;padding:3px 9px;font-size:10.5px;border-radius:6px}';
    document.head.append(style);
    box.querySelector('#manualSwitchOn').addEventListener('change', e => {
      if (e.target.checked && !isPro()) {
        e.target.checked = false;
        if (typeof upgradeNudge === 'function') upgradeNudge('Switching Flow accounts when credits run out is for Pro and Discord Pro.', 'switch');
        return;
      }
      state.on = e.target.checked; save(); render();
    });
    for (const chip of box.querySelectorAll('.ms-acc')) chip.addEventListener('change', () => {
      const picked = [...box.querySelectorAll('.ms-acc')].filter(c => c.checked).map(c => Number(c.value));
      if (picked.length > maxAccounts()) { chip.checked = false; if (typeof log === 'function') log('Account switching uses at most ' + maxAccounts() + ' Flow accounts on your plan.'); return; }
      state.accounts = picked; save(); paintStoryRows();
    });
    // A locked chip (Discord Pro) opens the upgrade note instead of doing nothing.
    box.querySelector('.ms-grid').addEventListener('click', e => {
      const label = e.target.closest('label.ms-locked');
      if (!label) return;
      e.preventDefault();
      if (typeof upgradeNudge === 'function') upgradeNudge('Discord Pro switches between 2 Flow accounts. Upgrade to paid Pro for up to ' + PRO_ACCOUNTS + '.', 'switch');
    });
    box.querySelector('#manualSwitchPaid').addEventListener('change', e => { state.confirmedPaid = e.target.checked; save(); paintStoryRows(); });
    document.getElementById('platformSelect')?.addEventListener('change', () => setTimeout(render, 0));
    // Sign-in finishes after this panel loads: show the PRO lock or the switch once the plan is known.
    chrome.storage.onChanged.addListener(changes => { if (changes.googleAccountRevision || changes.studioAccountRevision) setTimeout(render, 500); });
    render();
  }

  const isFlow = tab => /^https:\/\/(?:flow\.google(?:\.com)?(?:\/|$)|labs\.google\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$))/i.test(tab?.url||'');
  async function exactTab(id){return (await chrome.tabs.query({})).find(t=>t.id===id)||null;}
  async function taskTab(){
    const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    const captured=typeof getBackgroundFlowTabId==='function'?getBackgroundFlowTabId():null;
    if(isFlow(active))return active;
    if(captured!=null){const tab=await exactTab(captured);if(!isFlow(tab))throw Error('The selected Flow task tab was closed or changed.');return tab;}
    const open=(await chrome.tabs.query({url:['https://flow.google.com/*','https://flow.google/*','https://labs.google/fx/*']})).filter(isFlow);
    if(open.length>1)throw Error('Several Flow tabs are open. Activate the intended project before Start.');
    return open[0]||null;
  }
  async function useAccount(n,original,valid=()=>true){
    const M=await F(),url=M.flowAccountUrl(n);
    if(!valid())throw Error('Account switch cancelled.');
    if(original){const current=await exactTab(original.id);if(!current||current.url!==original.url)throw Error('The queue Flow tab changed; no account was switched.');}
    if(!valid())throw Error('Account switch cancelled.');
    const tab=original?await chrome.tabs.update(original.id,{url,active:true}):await chrome.tabs.create({url,active:true});
    for(let i=0;i<45;i++){
      await new Promise(r=>setTimeout(r,1000));if(!valid())throw Error('Account switch cancelled.');
      const t=await exactTab(tab.id);if(!t)throw Error('the Flow tab was closed');
      if(t.status==='complete'&&isFlow(t)&&M.flowAccountOf(t.url)===Number(n))return t;
    }
    throw Error('Flow did not open on that account');
  }

  // Owner 2026-11-01 ("i only turn on 2, 3 and 4 but when i start it uses the main"): with the switch on, Start opens the
  // first chosen account when the Flow tab is on an account that was not chosen, instead of running there first.
  async function beforeStart(items) {
    if(!switching)preparedTab=null;
    if (switching || !state.on || !state.confirmedPaid || !isPro() || (settings.platform || 'flow') !== 'flow') return;
    if (!(items || []).some(item => item.status === 'pending' && !item.groupParent)) return;
    for (const pid of new Set((items || []).map(item => item.builderProjectId).filter(Boolean)))
      if (await window.FlowBuilderUI?.factoryOwns?.(pid)) return;
    const chosen = [...new Set(state.accounts)].filter(n => !locked(n)).slice(0, maxAccounts());
    if (!chosen.length) return;
    const M = await F();
    let tab;try{tab=await taskTab();}catch(e){log(e.message);return false;}
    if(tab&&chosen.includes(M.flowAccountOf(tab.url))){preparedTab=tab;return;}
    if (opening) return false;
    opening = true;
    log(`${tab ? M.flowAccountLabel(M.flowAccountOf(tab.url)) + ' is not one of your chosen accounts' : 'No Flow tab is open'}; opening ${M.flowAccountLabel(chosen[0])} first.`);
    const rev=revision,valid=()=>revision===rev&&state.on&&state.confirmedPaid&&isPro()&&(settings.platform||'flow')==='flow';
    try { preparedTab=await useAccount(chosen[0],tab,valid); log(`Starting on ${M.flowAccountLabel(chosen[0])}.`); }
    catch (e) { log('Could not open ' + M.flowAccountLabel(chosen[0]) + ': ' + (e.message || e) + '. Sign in to that account in Chrome, or open it in Flow, then press Start.'); return false; }
    finally { opening = false; }
  }

  // Called by control.js when a queue ends. Only a manual Flow queue that stopped on credits switches.
  async function queueEnded(info, items) {
    if (switching || !info?.quota) return;
    if(/unusual activity/i.test(info.reason||''))return;
    // Owner 2026-10-29 ("autoswitch it didnt works"): say why a credits stop did not switch instead of staying silent.
    const skip = why => log('Account switching skipped: ' + why);
    if (!state.on) return isPro() ? skip('the switch is off.') : undefined;
    if (!state.confirmedPaid) return skip('tick "Each chosen account has its own paid Flow plan".');
    if (!isPro()) return skip('your plan is not showing as Pro or Discord Pro yet; press ↻ on the plan card, then Start.');
    if ((settings.platform || 'flow') !== 'flow') return skip('it only works on Flow.');
    // An AI Story project sent to Control is a manual run too (owner 2026-10-29); only the Factory switches on its own.
    for (const pid of new Set((items || []).map(item => item.builderProjectId).filter(Boolean)))
      if (await window.FlowBuilderUI?.factoryOwns?.(pid)) return skip('the Factory uses its own account switching.');
    if (!(items || []).some(item => item.status === 'pending')) return skip('no prompts are left to run.');
    const chosen = [...new Set(state.accounts)].filter(n => !locked(n)).slice(0, maxAccounts());
    if (chosen.length < 2) return log('Account switching needs at least two chosen Flow accounts.');
    const M = await F();
    const boundId=info.tabId??(typeof slotTabs!=='undefined'?slotTabs.get(0):null);
    const tab=boundId!=null?await exactTab(boundId):null;
    const root=url=>String(url||'').split(/[?#]/)[0].split('/edit/')[0];
    // Start may have opened this account's home before Flow created its project.
    // Query strings and a media editor inside the same project are not a handoff.
    const same=()=>!info.projectUrl||(/\/project\//.test(info.projectUrl)?root(tab.url)===root(info.projectUrl):M.flowAccountOf(tab.url)===M.flowAccountOf(info.projectUrl));
    if(!isFlow(tab)||!same())return skip('the queue Flow tab changed or is unavailable.');
    const current=M.flowAccountOf(tab.url),index=chosen.indexOf(current);
    if(index<0)return skip('the queue Flow account is not selected.');
    const next=chosen[index+1];
    if(next===undefined)return log('Flow credits ran out on every chosen account; the queue stays paused.');
    const rev=revision,ownedItems=items,token=typeof runToken!=='undefined'?runToken:null;
    const valid=()=>revision===rev&&state.on&&state.confirmedPaid&&isPro()&&(settings.platform||'flow')==='flow'&&!(typeof running!=='undefined'&&running)&&(typeof queue==='undefined'||queue===ownedItems)&&(typeof runToken==='undefined'||runToken===token)&&chosen.join(',')===[...new Set(state.accounts)].filter(n=>!locked(n)).slice(0,maxAccounts()).join(',');
    switching = true;
    try {
      log(`Flow credits ran out. Switching to ${M.flowAccountLabel(next)} in about 30 seconds, then the remaining prompts continue.`);
      const until = Date.now() + PAUSE_MS;
      while (Date.now() < until) { await new Promise(r => setTimeout(r, 1000)); if (!valid()) return log('Account switch cancelled; the queue stays paused.'); }
      preparedTab=await useAccount(next,tab,valid);
      if(!valid())return log('Account switch cancelled; the queue stays paused.');
      log(`Now on ${M.flowAccountLabel(next)}; continuing the queue.`);
      try { window.flowStatusReport?.switched(next); } catch {}
      await startQueue();
    } catch (e) { log('Could not switch Flow account: ' + (e.message || e) + '. Sign in to that account in Chrome, then press Start.'); }
    finally { switching = false; }
  }

  chrome.storage.local.get([KEY]).then(r => { if (r[KEY]) state = {...state, ...r[KEY]}; build(); render(); }).catch(build);
  window.manualAccountSwitch = {queueEnded, beforeStart, render, storyRow, cancelPending:()=>{revision++;}, takeStartTab:()=>{const tab=preparedTab;preparedTab=null;return tab;}};
})();
