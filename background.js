// background.js — service worker
// Android Flow queues run independently of hidden panels; desktop keeps its existing worker.
if (/Android/i.test(globalThis.navigator?.userAgent || '') || /MOBILE WORKER/.test(chrome.runtime.getManifest().version_name || '')) {
  importScripts('mobile-worker-flow-adapters.js', 'frame-readiness.js', 'lib/faceless-builder.js', 'story-shape.js', 'mobile-story-store.js', 'mobile-flow-worker.js');
}
// Domain move (owner 2026-11-15): the 0xFlow server is now api.0xflow.app. A saved connection to the old address
// (same server, same token) moves over once; a member's own custom server is never touched. The old address keeps working.
const OLD_REPAIR_ORIGIN = 'https://repair.corethea.com', NEW_REPAIR_ORIGIN = 'https://api.0xflow.app';
function movedRepairUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.origin !== OLD_REPAIR_ORIGIN || url.search || url.hash) return '';
    return NEW_REPAIR_ORIGIN + url.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}
async function moveRepairDomain() {
  const {remoteRepairUrl} = await chrome.storage.local.get('remoteRepairUrl');
  const moved = movedRepairUrl(remoteRepairUrl);
  if (moved) await chrome.storage.local.set({remoteRepairUrl: moved});
}
moveRepairDomain().catch(() => {});
// Our product always uses OUR local server. Clear any stale connection to the developer's server so the
// client re-registers against http://127.0.0.1:8787 on next use.
const OUR_SERVER = 'http://127.0.0.1:8787';
async function useOurLocalServer() {
  const c = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
  if (String(c.remoteRepairUrl || '') !== OUR_SERVER || !c.remoteRepairToken) {
    await chrome.storage.local.set({remoteRepairUrl: OUR_SERVER, remoteRepairToken: '', cloudAccessToken: ''});
  }
}
useOurLocalServer().catch(() => {});
// English AI sites (owner 2026-11-17): members whose Chrome is in Thai, Spanish and other languages got Flow, Gemini and
// the other AI sites in that language, and the automation (it finds those sites' English button names) stopped. The
// sites choose their language from the browser's Accept-Language header, so the extension asks only these sites for
// English. The panel itself still follows the member's Chrome language. declarativeNetRequestWithHostAccess has no
// install warning: the rule only works on sites the extension already has access to (Grok, Higgsfield and Muse once
// the member allowed them).
const ENGLISH_SITE_RULE_IDS = [9101, 9102];
const ENGLISH_SITE_DOMAINS = ['labs.google', 'flow.google', 'flow.google.com', 'gemini.google.com', 'grok.com', 'chatgpt.com', 'higgsfield.ai', 'muse.ai'];
function englishSiteRules() {
  const action = {type: 'modifyHeaders', requestHeaders: [{header: 'accept-language', operation: 'set', value: 'en-US,en;q=0.9'}]};
  const resourceTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
  return [
    {id: ENGLISH_SITE_RULE_IDS[0], priority: 1, action, condition: {requestDomains: ENGLISH_SITE_DOMAINS, resourceTypes}},
    // Google Vids only: the rest of docs.google.com (the member's Docs, Sheets, Slides) keeps its language.
    {id: ENGLISH_SITE_RULE_IDS[1], priority: 1, action, condition: {urlFilter: '||docs.google.com/videos/', resourceTypes}}
  ];
}
async function askSitesForEnglish() {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;
  await dnr.updateDynamicRules({removeRuleIds: ENGLISH_SITE_RULE_IDS, addRules: englishSiteRules()});
}
askSitesForEnglish().catch(() => {});
// UI launch and update/notification helpers.
//  1) Open the side panel, or a regular tab when the browser has no side-panel API.
//  2) Forward notification requests from the side panel.

function studioNeedsTabPanel() {
  const n = globalThis.navigator;
  return /iPhone|iPad|iPod/i.test(n?.userAgent || '') || (n?.platform === 'MacIntel' && n?.maxTouchPoints > 1);
}
async function initSidePanel() {
  if (studioNeedsTabPanel() || !chrome.sidePanel?.setPanelBehavior || !chrome.sidePanel?.setOptions) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({ path: 'control.html', enabled: true });
  } catch (e) {
    console.warn('side panel init failed', e);
  }
}
chrome.runtime.onInstalled.addListener(initSidePanel);
chrome.runtime.onStartup.addListener(initSidePanel);
initSidePanel();

let studioPanelTabOpening = null;
async function openStudioPanel(tab) {
  if (!studioNeedsTabPanel() && chrome.sidePanel?.open && tab?.id != null) {
    try { await chrome.sidePanel.open({tabId:tab.id}); return {ok:true,mode:'side-panel'}; }
    catch { /* A partial/stub side-panel implementation needs the tab fallback too. */ }
  }
  if (studioPanelTabOpening) return studioPanelTabOpening;
  studioPanelTabOpening = (async () => {
    const url = chrome.runtime.getURL('control.html');
    // Computers whose Chrome has no side panel (Chrome 109 on Windows 7, user report 2026-11-09): a narrow window docked
    // to the right edge of the browser instead of a full tab. Phones and iPads keep the tab.
    if (!studioNeedsTabPanel() && !/Android/i.test(globalThis.navigator?.userAgent || '') && chrome.windows?.create) {
      try { return await openStudioPanelWindow(url, tab); } catch (e) { console.warn('0xFlow panel window failed; opening a tab', e); }
    }
    const tabs = await chrome.tabs.query({url}).catch(() => []);
    const existing = tabs.find(t => t.url === url);
    if (existing) await chrome.tabs.update(existing.id, {active:true});
    else await chrome.tabs.create({url,active:true});
    return {ok:true,mode:'tab'};
  })();
  try { return await studioPanelTabOpening; } finally { studioPanelTabOpening = null; }
}
let studioPanelWindowId = null;
async function openStudioPanelWindow(url, tab) {
  // An open panel window (found by its address, so a restarted service worker still finds it) is brought forward;
  // a panel tab left over from older versions is closed, the window replaces it.
  const open = (await chrome.tabs.query({url}).catch(() => [])).filter(t => t.url === url);
  for (const t of open) {
    const w = await chrome.windows.get(t.windowId).catch(() => null);
    if (w?.type === 'popup' && (studioPanelWindowId == null || studioPanelWindowId === w.id)) { studioPanelWindowId = w.id; await chrome.windows.update(w.id, {focused: true, state: 'normal'}); return {ok: true, mode: 'window'}; }
  }
  for (const t of open) await chrome.tabs.remove(t.id).catch(() => {});
  const host = await (tab?.windowId != null ? chrome.windows.get(tab.windowId) : chrome.windows.getLastFocused()).catch(() => null);
  const width = 480, height = Math.max(500, host?.height || 800), top = host?.top ?? 0;
  const left = host?.width ? Math.max(0, (host.left || 0) + host.width - width) : undefined;
  const w = await chrome.windows.create({url, type: 'popup', width, height, top, ...(left != null ? {left} : {}), focused: true});
  studioPanelWindowId = w.id;
  return {ok: true, mode: 'window'};
}
chrome.windows?.onRemoved?.addListener(id => { if (id === studioPanelWindowId) studioPanelWindowId = null; });
// Orion iOS can install the extension but has no sidePanel API. It dispatches the action click instead.
(chrome.action?.onClicked || chrome.browserAction?.onClicked)?.addListener(tab => {
  return openStudioPanel(tab).catch(e => console.warn('0xFlow could not open', e));
});

// --- Web Store updates ---
// Chrome installs a downloaded update only once the extension is idle (an open side panel counts as in use), and fires
// onUpdateAvailable while it waits. chrome.runtime.reload() installs it at once (documented for this case; works for Web
// Store installs). Here: no panel open → reload now; panel open → the panel shows "Version X is ready" (update-notice.js).
async function panelOpen() {
  try { return (await chrome.runtime.getContexts({contextTypes: ['SIDE_PANEL', 'TAB']})).length > 0; }
  catch { return panelPorts.size > 0; }
}
async function applyWaitingUpdate() {
  const {pendingUpdate} = await chrome.storage.local.get('pendingUpdate');
  if (pendingUpdate && pendingUpdate.version !== chrome.runtime.getManifest().version && !(await panelOpen())) chrome.runtime.reload();
}
chrome.runtime.onUpdateAvailable?.addListener(async (details) => {
  await chrome.storage.local.set({pendingUpdate: {version: details.version, at: Date.now()}});
  await applyWaitingUpdate();
});
chrome.runtime.onInstalled.addListener((details) => {
  // The waiting update is now installed (justUpdated: left over from a test build's "Updated to" note, now removed).
  if (details.reason === 'update') chrome.storage.local.remove(['pendingUpdate', 'justUpdated']);
});
// Each open panel holds a port; when the last one closes, a waiting update is applied.
const panelPorts = new Set();
chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'flow-studio-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => { panelPorts.delete(port); setTimeout(() => applyWaitingUpdate().catch(() => {}), 1000); });
});
// The worker also starts for other reasons (e.g. a notification): apply an update still waiting from earlier.
applyWaitingUpdate().catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: String(msg.title || '0xtnp Flow Studio'),
      message: String(msg.message || ''),
    }, (notificationId) => {
      // Reading lastError keeps a failure (e.g. notifications blocked) out of the console as "Unchecked runtime.lastError".
      const error = chrome.runtime.lastError;
      sendResponse(error ? { ok: false, error: error.message } : { ok: true, notificationId });
    });
    return true;
  }
  return false;
});



let studioSettingsWindowId=null;
async function openStudioSettings(){
 if(studioSettingsWindowId!==null){try{await chrome.windows.update(studioSettingsWindowId,{focused:true});return}catch{studioSettingsWindowId=null}}
 const existing=await chrome.tabs.query({url:chrome.runtime.getURL('studio-settings.html')});if(existing[0]){studioSettingsWindowId=existing[0].windowId;await chrome.windows.update(studioSettingsWindowId,{focused:true});return}
 const w=await chrome.windows.create({url:chrome.runtime.getURL('studio-settings.html'),type:'popup',width:570,height:790});studioSettingsWindowId=w.id;
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(msg?.type==='studio-open-settings'){openStudioSettings().then(()=>reply({ok:true})).catch(e=>reply({ok:false,error:e.message}));return true}
 if(msg?.type==='studio-open-panel'&&sender.tab){openStudioPanel(sender.tab).then(reply).catch(e=>reply({ok:false,error:e.message}));return true}
});
