// update-notice.js — "update ready" banner and Settings → Check for updates.
// Chrome installs Web Store updates by itself, but only once the extension is idle (panel closed). background.js listens
// for chrome.runtime.onUpdateAvailable: with no panel open it installs at once; with a panel open it stores
// `pendingUpdate`, and this banner lets the user install it (chrome.runtime.reload) when no queue is running, instead of
// waiting until the panel is closed or Chrome restarts. No network request and no extra permission.

function updateNoticeVersion() { return (globalThis.chrome?.runtime?.getManifest?.().version) || ''; }
// 1.13.33 > 1.13.32 (numeric, part by part).
function updateNoticeNewer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

function renderUpdateNotice(state) {
  const box = document.getElementById('updateBanner');
  if (!box) return;
  const current = updateNoticeVersion();
  const pending = state.pendingUpdate && updateNoticeNewer(state.pendingUpdate.version, current) ? state.pendingUpdate : null;
  // Header update icon: small download badge + "New version available vX" tooltip while an update waits.
  const icon = document.getElementById('headerUpdateBtn');
  if (icon) {
    icon.classList.toggle('has-update', !!pending);
    const tip = pending ? `New version available v${pending.version}` : 'Update extension';
    icon.dataset.tip = tip; icon.setAttribute('aria-label', tip);
  }
  box.replaceChildren();
  box.hidden = !pending;
  box.classList.toggle('update-ready', !!pending);
  if (pending) {
    const busy = typeof running !== 'undefined' && running;
    const text = document.createElement('span');
    text.textContent = `Version ${pending.version} is ready to install.`;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'primary'; button.id = 'updateReloadBtn';
    button.disabled = busy;
    button.textContent = busy ? 'Reload after the queue finishes' : 'Reload to update';
    button.title = 'Reloads the extension and closes this panel; open it again from the toolbar. The prompt list is not kept.';
    button.addEventListener('click', async () => {
      if (typeof running !== 'undefined' && running) return;
      button.disabled = true; button.textContent = 'Updating…';
      try { if (typeof persistState === 'function') await persistState(); } catch {}
      chrome.runtime.reload();
    });
    box.append(text, button);
  }
}

let updateNoticeState = {};
async function refreshUpdateNotice() {
  try { updateNoticeState = await chrome.storage.local.get(['pendingUpdate']); } catch { updateNoticeState = {}; }
  renderUpdateNotice(updateNoticeState);
}

async function checkForUpdates() {
  const status = document.getElementById('updateCheckStatus');
  if (status) status.textContent = 'Checking…';
  try {
    const result = await chrome.runtime.requestUpdateCheck();
    const text = result.status === 'update_available' ? `Version ${result.version} found. Chrome is downloading it; a banner appears at the top when it is ready.`
      : result.status === 'throttled' ? 'Checked recently. Chrome allows a new check in a few minutes.'
      : `You have the latest version (v${updateNoticeVersion()}).`;
    if (status) status.textContent = text;
  } catch (error) {
    // Unpacked test copies have no Web Store update URL.
    if (status) status.textContent = `Update check is not available here (${error?.message || error}). Store installs update automatically.`;
  }
}

if (typeof document !== 'undefined' && globalThis.chrome?.runtime?.id) {
  // Lets background.js see that a panel is open, and apply a waiting update once the last panel closes.
  // Chrome stops an idle background worker, which drops this port: reconnect so the background still sees the panel.
  const connectPanelPort = () => { try { chrome.runtime.connect({name: 'flow-studio-panel'}).onDisconnect.addListener(() => { void chrome.runtime.lastError; setTimeout(connectPanelPort, 1000); }); } catch {} };
  connectPanelPort();
  refreshUpdateNotice();
  chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.pendingUpdate) refreshUpdateNotice(); });
  // The Reload button follows the queue: disabled while it runs, enabled when it ends.
  let lastBusy = null;
  setInterval(() => { const busy = typeof running !== 'undefined' && running; if (busy !== lastBusy) { lastBusy = busy; renderUpdateNotice(updateNoticeState); } }, 1500);
  document.getElementById('checkUpdateBtn')?.addEventListener('click', checkForUpdates);
}


// Account menu: use the same settings, billing and authentication paths as the panel.
if (typeof document !== 'undefined') (() => {
  const trigger=document.getElementById('headerSettingsBtn'),menu=document.getElementById('headerAccountMenu');
  if(!trigger||!menu)return;
  const status=document.getElementById('headerMenuStatus'),logout=menu.querySelector('[data-header-action="logout"]'),affiliates=menu.querySelector('[data-header-action="affiliates"]');
  let affiliateCheckVersion=0;
  async function refreshAffiliateItem(){
    if(!affiliates)return;
    const version=++affiliateCheckVersion;
    // Reserve the row while the startup check runs, so enabled services never pop it into an open menu.
    affiliates.hidden=false;affiliates.disabled=true;affiliates.title='Checking affiliate availability…';
    let enabled=false;
    try{enabled=(await window.FlowGoogleSignIn?.affiliateAvailable?.())===true;}catch{/* Older/offline services stay unavailable. */}
    if(version!==affiliateCheckVersion)return;
    affiliates.hidden=!enabled;affiliates.disabled=!enabled;affiliates.title='';
  }
  // Preload once; menu opening only reveals the already prepared items.
  void refreshAffiliateItem();
  globalThis.chrome?.storage?.onChanged?.addListener((changes,area)=>{
    if(area==='local'&&(changes.remoteRepairUrl||changes.remoteRepairToken))void refreshAffiliateItem();
  });
  const busy=()=>typeof running!=='undefined'&&running;
  const items=()=>[...menu.querySelectorAll('[role="menuitem"]')].filter(button=>!button.disabled);
  const close=(focus=false)=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();};
  function open(){
    const signed=!!window.FlowGoogleSignIn?.current()?.signedIn;
    logout.hidden=!signed;logout.disabled=!signed||busy();

    logout.title=busy()?'Stop the running queue before logging out.':'';
    status.textContent=busy()?'Stop the running queue before logging out.':'';status.hidden=!busy();
    menu.hidden=false;trigger.setAttribute('aria-expanded','true');
    const rect=trigger.getBoundingClientRect();menu.style.top=Math.max(8,rect.bottom+8)+'px';
    menu.style.right=Math.max(12,window.innerWidth-rect.right)+'px';
    items().find(button=>!button.hidden)?.focus();
  }
  trigger.addEventListener('click',()=>menu.hidden?open():close(true));
  trigger.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();open();}});
  document.addEventListener('click',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!trigger.contains(event.target))close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden){event.preventDefault();close(true);}});
  window.addEventListener('resize',()=>close());
  menu.addEventListener('keydown',event=>{
    if(event.key==='Tab'){close();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const buttons=items().filter(button=>!button.hidden),index=buttons.indexOf(document.activeElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  });
  const tour=document.getElementById('quickTourDialog');let step=0;
  const steps=[
    ['Choose your platform','In Control, choose Flow, ChatGPT, Gemini or Grok, then select a generation mode. Open the platform and sign in to the account you want to use.'],
    ['Add your prompts and images','Paste or import your prompts. For image-based modes, add the reference images and check their order or @names before starting.'],
    ['Let AI Story prepare a project','Open AI Story to choose a template and build a scene package. Review your references and scene images before generating videos.'],
    ['Run and follow progress','Press Start generation in Control. Follow the queue and Debug log. If credits run out or login is needed, resolve that on the platform before resuming unfinished work.'],
    ['Finish in Story Workspace','Open an AI Story project—or a saved manual video project—to review clips, add subtitles in Finish and export your story. Settings and Contact Support are always in this menu.']
  ];
  function drawTour(){
    document.getElementById('quickTourCount').textContent='Step '+(step+1)+' of '+steps.length;
    document.getElementById('quickTourHeading').textContent=steps[step][0];document.getElementById('quickTourText').textContent=steps[step][1];
    document.getElementById('quickTourBack').disabled=step===0;document.getElementById('quickTourNext').textContent=step===steps.length-1?'Done':'Next';
    document.getElementById('quickTourDots').replaceChildren(...steps.map((_,i)=>{const dot=document.createElement('span');dot.className=i===step?'active':'';return dot;}));
  }
  document.getElementById('quickTourBack').addEventListener('click',()=>{if(step>0){step--;drawTour();}});
  document.getElementById('quickTourNext').addEventListener('click',()=>{if(step===steps.length-1)tour.close();else{step++;drawTour();}});
  document.getElementById('quickTourClose').addEventListener('click',()=>tour.close());
  tour.addEventListener('close',()=>trigger.focus());
  menu.addEventListener('click',async event=>{
    const button=event.target.closest?.('[data-header-action]');if(!button||button.disabled)return;
    const action=button.dataset.headerAction;close();
    try{
      if(action==='settings'){
        try{const reply=await chrome.runtime.sendMessage({type:'studio-open-settings'});if(reply?.ok===false)throw Error(reply.error||'Settings could not open.');}
        catch(error){const fallback=document.getElementById('settingsTabBtn');if(fallback)fallback.click();else throw error;}
      }else if(action==='support'){
        const url='https://discord.gg/D2RBEuGg5t';if(globalThis.chrome?.tabs?.create)await chrome.tabs.create({url});else window.open(url,'_blank','noopener');
      }else if(action==='affiliates'){
        if(!window.FlowGoogleSignIn?.openAffiliates)throw Error('Affiliates is not available. Reload the extension and try again.');
        await window.FlowGoogleSignIn.openAffiliates();
      }else if(action==='tour'){step=0;drawTour();if(!tour.open)tour.showModal();}
      else if(action==='upgrade'){
        if(typeof usageUpgrade!=='function')throw Error('Upgrade is not available. Reopen the extension and try again.');
        await usageUpgrade(button);
        const text=document.getElementById('usageLineStatus')?.textContent||'';
        if(/connect cloud|could not|not available/i.test(text))throw Error(text);
      }else if(action==='logout'){
        if(busy())throw Error('Stop the running queue before logging out.');
        if(!window.FlowGoogleSignIn?.current()?.signedIn)return;
        await window.FlowGoogleSignIn.signOut();await chrome.storage.local.set({studioAccountRevision:Date.now()});
      }
    }catch(error){open();status.hidden=false;status.textContent=error.message||String(error);}
  });
})();

// Compact header utilities. Update installation still uses the existing safe banner.
if (typeof document !== 'undefined') {
  const dialog = document.getElementById('headerUtilityDialog');
  const title = document.getElementById('utilityTitle');
  const body = document.getElementById('utilityBody');
  const openUtility = (heading) => { if (!dialog) return false; title.textContent = heading; body.replaceChildren(); if (!dialog.open) dialog.showModal(); return true; };
  const paragraph = (text) => { const p = document.createElement('p'); p.textContent = text; body.append(p); return p; };
  document.getElementById('utilityClose')?.addEventListener('click', () => dialog.close());
  // The settings gear opens the account menu below; Settings remains one menu action.
  // User Guide: header ? icon (owner 2026-10-15; was a link at the bottom of the panel).
  document.getElementById('guideIconBtn')?.addEventListener('click', () => {
    const url = 'https://0xflow.app/guide';
    if (globalThis.chrome?.tabs?.create) chrome.tabs.create({url}); else window.open(url, '_blank', 'noopener');
  });
  // Buy me a coffee: the owner's support page (Binance Pay, GoTyme, Maya), hosted next to the repair service.
  document.getElementById('coffeeIconBtn')?.addEventListener('click', () => {
    const url = 'https://0xflow.app/coffee';
    if (globalThis.chrome?.tabs?.create) chrome.tabs.create({url}); else window.open(url, '_blank', 'noopener');
  });
  // What's new in this version (keep it short; update it with every release).
  const WHATS_NEW_ITEMS = [
    ['Fixed', "AI Story: after Flow fixed a scene's spoken lines, the next part could stop with \"prompts must not contain @ mentions\". Stories that already show it are repaired when you open them."],
    ['Fixed', "AI Story: \"Continue the story\" works again for stories made with Direct scene frames (it said \"Approved reusable asset images are missing\")."],
    ['Fixed', "Chrome in another language (Thai, Spanish and others): the AI sites now open in English, so the automation no longer stops. The panel keeps your language."],
    ['New', "AI Story: 15-second scenes, and Higgsfield can make your story videos (each scene up to 30 seconds there). It asks before using your credits."],
    ['New', "Send to support: in Debug logs, send your logs and settings to 0xFlow support. You get an answer right away, and when a setting is the cause, Apply fix changes it for you."],
    ['Better', "0xFlow has its own address now: 0xflow.app. The extension connects to the new server address by itself."],
    ['New', "Google Vids: a new platform tab for videos and images, also for AI Story videos (one prompt at a time)."],
    ['Better', "Pro does not renew by itself: in the last 7 days the plan card says when your Pro ends, with a Renew Pro button. Renewing adds the new days on top."],
    ['Better', "Saved characters keep their own face, hair and outfit in every scene."],
    ['New', "Connect your AI app: your AI chat can read and change panel settings and give each prompt its own video length."],
    ['New', "AI narration with your own voice key (Pro), used for the narrator in the Story Workspace. The key stays in your browser."],
  ];
  document.getElementById('newsIconBtn')?.addEventListener('click', () => {
    if (!openUtility("What's new")) return;
    paragraph(`Version ${updateNoticeVersion()}`).className = 'whats-new-version';
    const list = document.createElement('ul'); list.className = 'whats-new-list';
    for (const [kind, text] of WHATS_NEW_ITEMS) {
      const item = document.createElement('li');
      const tag = document.createElement('span'); tag.className = 'whats-new-tag ' + kind.toLowerCase(); tag.textContent = kind;
      item.append(tag, document.createTextNode(text));
      list.append(item);
    }
    body.append(list);
  });
  document.getElementById('headerUpdateBtn')?.addEventListener('click', async () => {
    if (!openUtility('Update Extension')) return;
    paragraph(`Installed: v${updateNoticeVersion()}`);
    const pending = updateNoticeState?.pendingUpdate;
    if (pending && updateNoticeNewer(pending.version, updateNoticeVersion())) paragraph(`Version ${pending.version} is ready. Close this dialog and use Reload to update in the header banner. Updates are blocked while your queue runs.`);
    else paragraph('Chrome installs Web Store updates automatically. Check here for an available update. Unpacked copies need their files updated manually, then Reload on the extensions page.');
    const steps = document.createElement('ol'); steps.className = 'update-manual-steps';
    const openStep = document.createElement('li'); openStep.textContent = 'Open the extensions page:';
    const link = document.createElement('a'); link.href = 'chrome://extensions/'; link.className = 'extensions-step-link'; link.textContent = '↓  chrome://extensions/';
    link.addEventListener('click', (event) => { event.preventDefault(); chrome.tabs.create({url:'chrome://extensions/'}); });
    openStep.append(link);
    const developerStep = document.createElement('li');
    const toggleIcon = document.createElement('span'); toggleIcon.className = 'developer-mode-illustration'; toggleIcon.setAttribute('aria-hidden','true');
    developerStep.append(toggleIcon, document.createTextNode('Enable Developer mode in the top-right corner.'));
    const updateStep = document.createElement('li'); updateStep.textContent = 'Click Update to update your Web Store extensions.';
    steps.append(openStep, developerStep, updateStep);
    body.append(steps);
    const status = paragraph(''); status.setAttribute('role','status');
    const actions = document.createElement('div'); actions.className = 'utility-actions';
    const extensions = document.createElement('button'); extensions.type='button'; extensions.textContent='Extensions page';
    extensions.addEventListener('click', () => chrome.tabs.create({url:'chrome://extensions/'}));
    const check = document.createElement('button'); check.type='button'; check.className='primary'; check.textContent='Check for updates';
    check.addEventListener('click', async () => { check.disabled=true; status.textContent='Checking…'; await checkForUpdates(); status.textContent=document.getElementById('updateCheckStatus')?.textContent || 'Check finished.'; await refreshUpdateNotice(); check.disabled=false; });
    actions.append(extensions,check);body.append(actions);
  });
}
