// Optional, user-selected tab capture. No recorder, audio capture, or network sender.
let backgroundCapture = null;
let backgroundCaptureEpoch = 0;
let backgroundCapturePending = false;
let backgroundFlowTab = null;
let backgroundCapturePlatform = 'flow';
// Background mode works for every platform's task tab: Flow project, ChatGPT or Gemini.
const BACKGROUND_TARGETS = {
  muse: {name:'Muse',tab:'Muse chat',re:/^https:\/\/(?:[a-z0-9-]+\.)?muse\.ai(?:\/|$)/i},
  higgsfield: {name:'Higgsfield',tab:'Higgsfield',re:/^https:\/\/(?:[a-z0-9-]+\.)?higgsfield\.ai(?:\/|$)/i},
  // Same pattern as control.js (any account: flow.google.com/u/4/project/…); the copy is for tests that load this file alone.
  flow: {name: 'Flow', tab: 'Flow project', re: typeof FLOW_PROJECT_URL_RE !== 'undefined' ? FLOW_PROJECT_URL_RE
    : /^https:\/\/(?:flow\.google(?:\.com)?\/(?:u\/\d+\/)?project\/|labs\.google\/fx\/(?:[a-z]{2,3}(?:-[a-z0-9]+)?\/)?(?:u\/\d+\/)?tools\/flow\/(?:u\/\d+\/)?project\/)/i},
  chatgpt: {name: 'ChatGPT', tab: 'ChatGPT', re: /^https:\/\/chatgpt\.com(?:\/|$)/i},
  gemini: {name: 'Gemini', tab: 'Gemini', re: /^https:\/\/gemini\.google\.com(?:\/|$)/i},
  grok: {name: 'Grok', tab: 'Grok', re: /^https:\/\/grok\.com(?:\/|$)/i},
  // Google Vids (owner 2026-11-14): an open Vids video (editor), not the Vids home page.
  vids: {name: 'Google Vids', tab: 'Google Vids video', re: /^https:\/\/docs\.google\.com\/videos\/(?:u\/\d+\/)?d\/[\w-]+\/edit(?:[/?#]|$)/i},
};
function backgroundPlatform() { return (typeof settings !== 'undefined' && settings?.platform) || 'flow'; }
function backgroundTarget(platform = backgroundPlatform()) { return BACKGROUND_TARGETS[platform] || BACKGROUND_TARGETS.flow; }
function renderBackgroundTargetText() {
  const target = backgroundTarget();
  const title = document.getElementById('backgroundModeTitle'); if (title) title.textContent = `Run ${target.name} in the background`;
  const choose = document.getElementById('chooseFlowTabBtn'); if (choose) choose.textContent = `Choose ${target.name} tab`;
  for (const el of document.querySelectorAll?.('[data-bg-platform]') || []) el.textContent = target.tab;
  // Step 1 names the same button ("Click Choose ChatGPT tab"), not a fixed "Choose Flow tab" (owner screenshot 2026-10-15).
  for (const el of document.querySelectorAll?.('[data-bg-choose]') || []) el.textContent = `Choose ${target.name} tab`;
}
// A tab title can be a whole prompt (ChatGPT names each chat after the prompt): show one short line only.
function shortTabTitle(title, max = 60) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
function backgroundModeActiveFor(tabId) {
  return !!backgroundCapture && backgroundFlowTab?.id === tabId;
}
// Owner report 2026-11-06: users with Background mode on said nothing happened once another tab was on top. With the
// mode on, the queue neither brings the task tab forward nor wakes it, trusting the shared tab to be that tab, but Chrome
// never says which tab was picked. Capture Handle checks it: the task tab labels itself, and the shared video track
// reports the label of the tab it really shows. Picked another tab (or the label never arrives) → sharing stops and the
// normal tab waking takes over again. Where Chrome cannot tell, the mode keeps working as before.
// Owner 2026-11-08: runs in the extension's isolated world (same tab label, nothing added to the page's own scripts).
function bgLabelCaptureTab(handle) {
  try {
    if (typeof navigator.mediaDevices?.setCaptureHandleConfig !== 'function') return 'unsupported';
    navigator.mediaDevices.setCaptureHandleConfig({handle, exposeOrigin: false, permittedOrigins: ['*']});
    return 'ok';
  } catch (e) { return 'error'; }
}
async function confirmBackgroundTab(tabId) {
  if (!backgroundModeActiveFor(tabId)) return false;
  const stream = backgroundCapture, track = stream.getVideoTracks?.()[0];
  if (typeof track?.getCaptureHandle !== 'function' || typeof chrome.scripting?.executeScript !== 'function') return true;
  const handle = '0xflow-' + Math.random().toString(36).slice(2, 12);
  let labelled;
  try { [{result: labelled} = {}] = await chrome.scripting.executeScript({target: {tabId}, func: bgLabelCaptureTab, args: [handle]}); }
  catch { return true; }
  if (labelled !== 'ok') return true;
  for (let waited = 0; waited < 3000; waited += 150) {
    if (track.getCaptureHandle?.()?.handle === handle) return true;
    if (backgroundCapture !== stream) return false;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (backgroundCapture !== stream) return false;
  const name = backgroundTarget(backgroundCapturePlatform).name;
  stopBackgroundMode(`The shared tab is not your ${name} tab · sharing stopped. Turn Background mode on again and pick the ${name} tab itself in Chrome’s list.`);
  if (typeof log === 'function') log(`Background mode: the shared tab is not the ${name} tab, so sharing was stopped and the ${name} tab is woken the normal way.`);
  return false;
}
function getBackgroundFlowTabId() { return backgroundCapture && backgroundCapturePlatform === backgroundPlatform() ? backgroundFlowTab?.id ?? null : null; }
function renderBackgroundMode(message) {
  const button = document.getElementById('backgroundModeBtn');
  const status = document.getElementById('backgroundModeStatus');
  if (button) { button.disabled = backgroundCapturePending; button.setAttribute?.('aria-label', backgroundCapture ? 'Stop Background Mode' : 'Enable Background Mode'); button.classList.toggle('background-active', !!backgroundCapture); button.setAttribute?.('aria-pressed', String(!!backgroundCapture)); }
  if (status) { status.textContent = message || ''; status.hidden = !status.textContent; }
  const choose = document.getElementById('chooseFlowTabBtn');
  if (choose) choose.disabled = backgroundCapturePending || !backgroundFlowTab;
}
function stopBackgroundMode(reason = 'Background mode stopped') {
  backgroundCaptureEpoch++;
  backgroundCapturePending = false;
  const stream = backgroundCapture; backgroundCapture = null;
  if (stream) for (const track of stream.getTracks()) track.stop();
  const video = document.getElementById('backgroundCaptureVideo');
  if (video) video.srcObject = null;
  renderBackgroundMode(reason);
}
async function openBackgroundModeDialog() {
  if (backgroundCapturePending) return;
  if (backgroundCapture) { stopBackgroundMode(); return; }
  const target = backgroundTarget();
  renderBackgroundTargetText();
  const [active] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  const slotId = typeof slotTabs !== 'undefined' ? slotTabs.get(0) : null;
  const activeIsTarget = target.re.test(active?.url || '');
  const candidate = activeIsTarget ? active : slotId != null ? await chrome.tabs.get(slotId).catch(()=>null) : active;
  backgroundFlowTab = target.re.test(candidate?.url || '') ? candidate : null;
  backgroundCapturePlatform = backgroundPlatform();
  const name = document.getElementById('backgroundTargetName');
  name.textContent = backgroundFlowTab ? `Choose the ${target.name} tab: “${shortTabTitle(backgroundFlowTab.title) || target.name}”` : `Open your ${target.tab} tab first, then enable this mode.`;
  renderBackgroundMode();
  const dialog = document.getElementById('backgroundModeDialog');
  if (!dialog.open) dialog.showModal();
}
async function chooseBackgroundFlowTab() {
  if (backgroundCapturePending || !backgroundFlowTab) return;
  const epoch = ++backgroundCaptureEpoch;
  backgroundCapturePending = true;
  renderBackgroundMode(`Choose your ${backgroundTarget(backgroundCapturePlatform).name} tab in Chrome’s sharing dialog`);
  let stream;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw Error('Tab sharing is unavailable in this panel. Use an up-to-date Chrome browser.');
    // Must run directly from the Choose button's user gesture, before any await.
    stream = await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser',frameRate:{ideal:1,max:1}},audio:false,monitorTypeSurfaces:'exclude',surfaceSwitching:'exclude',selfBrowserSurface:'exclude'});
    if (epoch !== backgroundCaptureEpoch) { stream.getTracks().forEach(track=>track.stop()); return; }
    const track = stream.getVideoTracks()[0];
    if (!track || track.getSettings().displaySurface !== 'browser') {
      stream.getTracks().forEach(track=>track.stop());
      throw Error(`Select only the ${backgroundTarget(backgroundCapturePlatform).name} tab, not a window or entire screen.`);
    }
    // Chrome does not expose the selected tab ID here. The user must choose the
    // Flow tab named in the dialog. Do not claim this choice was verified.
    backgroundCapture = stream;
    track.addEventListener('ended',()=>{ if (backgroundCapture === stream) stopBackgroundMode('Sharing stopped · normal tab-wake behavior restored'); });
    const video = document.getElementById('backgroundCaptureVideo');
    video.srcObject = stream;
    await video.play().catch(()=>{});
    if (epoch !== backgroundCaptureEpoch || backgroundCapture !== stream) { stream.getTracks().forEach(track=>track.stop()); return; }
    // Check right away that the picked tab is the task tab; on a wrong pick the dialog stays open with the reason.
    if (!await confirmBackgroundTab(backgroundFlowTab.id)) return;
    document.getElementById('backgroundModeDialog').close();
    renderBackgroundMode();
    if (typeof log === 'function') log('Background mode enabled. Selected tab capture stays local; nothing is recorded or uploaded.');
  } catch (error) {
    if (stream && backgroundCapture !== stream) stream.getTracks().forEach(track=>track.stop());
    if (epoch === backgroundCaptureEpoch) renderBackgroundMode(error.name === 'NotAllowedError' ? 'Sharing cancelled or denied · normal mode continues' : `Background mode unavailable: ${error.message}`);
  } finally {
    if (epoch === backgroundCaptureEpoch) { backgroundCapturePending = false; renderBackgroundMode(document.getElementById('backgroundModeStatus').textContent); }
  }
}
if (typeof document !== 'undefined') {
  document.getElementById('backgroundModeBtn').addEventListener('click',()=>{openBackgroundModeDialog().catch(error=>renderBackgroundMode(error.message));});
  document.getElementById('chooseFlowTabBtn').addEventListener('click',chooseBackgroundFlowTab);
  document.getElementById('cancelBackgroundModeBtn').addEventListener('click',()=>{stopBackgroundMode();document.getElementById('backgroundModeDialog').close();});
  document.getElementById('backgroundModeDialog').addEventListener('cancel',()=>stopBackgroundMode());
  window.addEventListener('pagehide',()=>stopBackgroundMode());
  chrome.tabs.onUpdated?.addListener((tabId, change)=>{
    if (backgroundCapture && tabId === backgroundFlowTab?.id && change.url && !backgroundTarget(backgroundCapturePlatform).re.test(change.url)) stopBackgroundMode(`${backgroundTarget(backgroundCapturePlatform).name} tab navigated away · sharing stopped`);
  });
  renderBackgroundTargetText();
  renderBackgroundMode();
}
