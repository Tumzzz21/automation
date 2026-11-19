// Gemini video and image adapter (gemini.google.com/videos with Veo,
// gemini.google.com/images with Nano Banana). Drives the signed-in web
// app like the Flow and ChatGPT adapters: no API keys or private endpoints.
// Page structure verified live (Oct 2026): the Videos page composer is a Quill
// editor ("Describe your video") with a "Videos" tool chip ("Deselect Videos"),
// an "Aspect ratio, …" button; attached images render as uploader-file-preview
// chips with an img.gem-attachment-style-img thumbnail; a finished answer is
// model-response > generated-video > video-player > <video src=
// "https://contribution.usercontent.google.com/download?…"> with "Download video".
// Images page (verified live Oct 2026): "Describe your image" composer with an
// "Images" chip ("Deselect Images"); the aspect button reads "Aspect ratio" until
// a ratio is picked ("Aspect ratio, 9:16"), its menu items are menuitemradio
// "1:1", "9:16", "3:4", "4:3", "16:9"; a first visit shows a "Create images"
// card with "Try it". A finished answer is model-response single-image.
// generated-image img.image (a blob: preview) with "Download full-sized image".
// Upload, quota and refusal handling follow the DramaFactory Gemini automator
// (gemini-automatorv2 3.2.5), which has run these steps at scale.
const GEMINI_VIDEOS_URL = 'https://gemini.google.com/videos';
const GEMINI_IMAGES_URL = 'https://gemini.google.com/images';
const GEMINI_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
// Image to Image runs on the Images page like Text to Image, with the references pasted into the composer first.
function geminiIsImageMode() { return settings.mode === 'text-to-image' || settings.mode === 'image-to-image'; }
// Error wording: Frame to Video attaches a start frame; Image to Image and Ingredients attach reference images.
function geminiAttachError(detail) { return Error(`Gemini ${settings.mode === 'frame-to-video' ? 'frame' : 'reference'} attachment failed: ${detail}`); }
// Gemini's own wording when another video is still being made in the account.
const GEMINI_CONCURRENCY_PHRASE = 'maximum i can do at one time';
function isGeminiTab(tab) { return /^https:\/\/gemini\.google\.com(?:\/|$)/i.test(tab?.url || ''); }

// Signed-in account of a Gemini tab: gemini.google.com/u/1/app (or ?authuser=1) is the second account. A plain
// gemini.google.com/videos always opens the FIRST account, so every page we open keeps the user's /u/N/
// (user report 2026-10-18: "Gemini automatically switches to the old account").
let geminiAccountIndex = null;
function geminiAccountOf(url) {
  const value = String(url || '');
  const match = value.match(/^https:\/\/gemini\.google\.com\/u\/(\d+)(?:\/|$|\?)/i) || (isGeminiTab({url: value}) && value.match(/[?&]authuser=(\d+)/i));
  return match ? match[1] : null;
}
// No /u/N/ in the tab's address means the first account, so that resets it too.
function rememberGeminiAccount(tab) { if (isGeminiTab(tab)) geminiAccountIndex = geminiAccountOf(tab.url); return geminiAccountIndex; }
function geminiPageUrl(image) {
  const page = image ? GEMINI_IMAGES_URL : GEMINI_VIDEOS_URL;
  return geminiAccountIndex === null ? page : page.replace('gemini.google.com/', `gemini.google.com/u/${geminiAccountIndex}/`);
}

async function getGeminiTab(slot) {
  const known = slotTabs.get(slot);
  if (known != null) {
    const tab = await chrome.tabs.get(known).catch(() => null);
    if (tab && isGeminiTab(tab)) { rememberGeminiAccount(tab); return tab; }
  }
  const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (isGeminiTab(active)) rememberGeminiAccount(active);
  const tab = isGeminiTab(active) ? active : await chrome.tabs.create({url: geminiPageUrl(geminiIsImageMode()), active: !!settings.openTabWhileGenerating});
  slotTabs.set(slot, tab.id);
  return tab;
}

// Gemini's answer, classified from its reply only (never from the page text,
// which contains the prompt itself).
function geminiQuotaText(text) {
  return false;  // No quota gate: always allow
}
function geminiAnswerKind(text) {
  const t = String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  if (!t) return null;
  if (geminiQuotaText(t)) return 'limit';
  if (t.includes(GEMINI_CONCURRENCY_PHRASE)) return 'busy';
  if (['try a different prompt', 'request may violate', 'violates our policies', 'due to safety', "can't help with that", 'cannot help with that',
    "i can't assist with", "can't make videos of real people", 'cannot make videos of real people', "can't create videos of real people",
    'videos of real people in situations like that', "can't make images of real people", 'cannot make images of real people',
    "can't create images of real people", 'images of real people in situations like that', "can't depict some public figures", 'cannot depict some public figures', 'depict some public figures']
    .some(phrase => t.includes(phrase))) return 'refused';
  if (["i couldn't generate", 'unable to generate the video', 'unable to create this video', 'video generation failed',
    'unable to generate the image', 'unable to create this image', 'image generation failed', 'something went wrong while generating',
    'i seem to be encountering an error', 'i encountered an error', 'i ran into an error', 'can i try something else for you', 'sorry, something went wrong',
    'something went wrong. try again', "i'm having a hard time fulfilling your request", 'having a hard time fulfilling',
    'can i help you with something else']
    .some(phrase => t.includes(phrase))) return 'failed';
  return 'text';
}

// Everything the runner needs from the page in one read.
function pg_geminiState() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const label = e => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim();
  const editor = Array.from(document.querySelectorAll('div.ql-editor[contenteditable="true"]')).find(visible) || null;
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const send = buttons.find(b => (/^send message$/i.test(b.getAttribute('aria-label') || '') || b.classList.contains('send-button')) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  const stop = buttons.find(b => /^stop( response| generating)?$/i.test(b.getAttribute('aria-label') || ''));
  // The Images page's aspect button has no aria-label until a ratio is picked.
  const aspect = buttons.find(b => /^aspect ratio/i.test(label(b)));
  // A narrow window (Gemini's mobile layout, owner test 2026-10-23) labels the same chip button "close Images".
  const videoTool = buttons.some(b => /^(?:deselect|close) videos?$/i.test(b.getAttribute('aria-label') || ''));
  const imageTool = buttons.some(b => /^(?:deselect|close) images?$/i.test(b.getAttribute('aria-label') || ''));
  const discovery = Array.from(document.querySelectorAll('.discovery-card-container button')).find(b => visible(b) && /^try it$/i.test(label(b)));
  // Attachments: count one element type only (nested wrappers double-count).
  // A chip is ready when its thumbnail has loaded and it shows no progress UI.
  const busySelector = 'mat-spinner,mat-progress-spinner,mat-progress-bar,[role="progressbar"],[aria-busy="true"],[aria-label*="uploading" i],[class*="spinner"],[class*="progress"],[class*="loading"],[class*="loader"]';
  const chips = Array.from(document.querySelectorAll('uploader-file-preview')).filter(chip => !chip.closest('user-query, model-response'));
  let ready = 0, busy = 0;
  for (const chip of chips) {
    const chipBusy = Array.from(chip.querySelectorAll(busySelector)).some(e => e.getClientRects().length > 0) || /uploading|processing|preparing|\b\d{1,3}\s*%/i.test(chip.innerText || '');
    const img = chip.querySelector('img.gem-attachment-style-img');
    if (chipBusy) busy++;
    if (img && img.complete && img.naturalWidth > 0 && !chipBusy) ready++;
  }
  const users = Array.from(document.querySelectorAll('user-query'));
  const models = Array.from(document.querySelectorAll('model-response'));
  const lastUser = users.at(-1), lastModel = models.at(-1);
  const answerAfterUser = !!(lastUser && lastModel && (lastUser.compareDocumentPosition(lastModel) & Node.DOCUMENT_POSITION_FOLLOWING));
  const video = answerAfterUser ? lastModel.querySelector('generated-video video, video-player video') : null;
  const download = answerAfterUser ? Array.from(lastModel.querySelectorAll('button')).find(b => visible(b) && /^download video$/i.test(b.getAttribute('aria-label') || '')) : null;
  const image = answerAfterUser ? Array.from(lastModel.querySelectorAll('single-image.generated-image img, generated-image img')).find(i => i.complete && i.naturalWidth >= 256) : null;
  const imageDownload = answerAfterUser ? Array.from(lastModel.querySelectorAll('button')).find(b => visible(b) && /^download full.?sized? image$/i.test(b.getAttribute('aria-label') || '')) : null;
  const main = document.querySelector('main') || document.body;
  const point = e => { if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; };
  const sendPoint=point(send),hit=sendPoint?document.elementFromPoint(sendPoint.x,sendPoint.y):null;
  // Click a spot of the composer that is really on top: in a narrow window (mobile layout) the attachment thumbnails
  // cover the middle of the editor, so a centre click hit a thumbnail and the prompt was typed nowhere (owner test 2026-10-23).
  const editorPoint=(()=>{
    if(!editor)return null;
    const r=editor.getBoundingClientRect(),own=p=>{const h=document.elementFromPoint(p.x,p.y);return !!h&&(h===editor||editor.contains(h));};
    const tries=[[0.5,0.5],[0.15,0.5],[0.15,0.85],[0.5,0.85],[0.85,0.85],[0.15,0.15],[0.5,0.15]].map(([fx,fy])=>({x:r.left+r.width*fx,y:r.top+r.height*fy}));
    return tries.find(own)||point(editor);
  })();
  // The mini host becomes click-through in flowCdpClick; other overlays must clear first.
  const sendBlocked=!!(sendPoint&&(!hit||!(hit===send||send.contains(hit)||hit.closest?.('#oxflow-mini-host'))));
  const toolMenuOpen=buttons.some(b=>/^upload (?:&|and) tools$/i.test(b.getAttribute('aria-label')||'')&&b.getAttribute('aria-expanded')==='true');
  return {
    url: location.href,
    editor: !!editor, editorText: editor ? editor.innerText.replace(/\s+/g, ' ').trim() : '', editorPoint,
    videoTool, imageTool, discoveryPoint: point(discovery), aspect: aspect ? label(aspect) : '', aspectPoint: point(aspect),
    send: sendPoint, sendBlocked, toolMenuOpen,
    busy: !!stop, chips: chips.length, chipsReady: ready, chipsBusy: busy,
    userCount: users.length, latestUserText: lastUser ? lastUser.innerText.replace(/\s+/g, ' ').trim() : '',
    answerAfterUser, answer: answerAfterUser ? lastModel.innerText.replace(/\s+/g, ' ').trim().slice(-1500) : '',
    videoSrc: video ? (video.currentSrc || video.src || '') : '', downloadPoint: point(download),
    imageSrc: image ? image.src : '', imageSize: image ? `${image.naturalWidth}x${image.naturalHeight}` : '', imageDownloadPoint: point(imageDownload),
    // Banner text (quota) is read only when there is no answer to this prompt yet.
    pageText: answerAfterUser ? '' : String(main.innerText || '').replace(/\s+/g, ' ').slice(0, 4000),
  };
}

function pg_geminiAspectOption(wanted, image) {
  const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const ratio = wanted === 'landscape' ? /\b16\s*:\s*9\b/ : wanted === 'square' ? /\b1\s*:\s*1\b/ : /\b9\s*:\s*16\b/;
  const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).filter(visible);
  const options = menus.flatMap(menu=>Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"], li, button')));
  const option = options.find(e=>visible(e) && !e.disabled && e.getAttribute('aria-disabled')!=='true' &&
    ratio.test((e.getAttribute('aria-label') || '')+' '+(e.textContent || '')) && !/^aspect ratio/i.test(e.getAttribute('aria-label') || ''));
  if (!option) return null;
  const r=option.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
  // Mobile bottom sheets slide in from below the viewport. Never click their pre-animation coordinates.
  if(x<0||y<0||x>=innerWidth||y>=innerHeight)return null;
  const hit=document.elementFromPoint(x,y);
  return hit&&(hit===option||option.contains(hit))?{x,y}:null;
}
// Background tabs can ignore the first trusted pointer event. Only recover
// the aspect menu, never Send, and never toggle a menu that is already open.
function pg_geminiOpenAspectMenu() {
  const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const menus=Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).filter(shown);
  if(menus.some(m=>Array.from(m.querySelectorAll('[role="menuitemradio"], [role="radio"], [role="option"], [role="menuitem"], button')).some(e=>/\b(?:9\s*:\s*16|16\s*:\s*9|1\s*:\s*1)\b/.test((e.getAttribute('aria-label')||'')+' '+(e.textContent||'')))))return {ok:true,alreadyOpen:true};
  const button=Array.from(document.querySelectorAll('button')).find(e=>shown(e)&&!e.disabled&&/^aspect ratio/i.test(e.getAttribute('aria-label')||e.innerText||''));
  if(!button)return {ok:false};
  button.click();return {ok:true};
}

// The generated image as PNG from the rendered preview (the blob: URL itself is
// revoked once shown, so it cannot be fetched). Fallback when the full-size
// download does not arrive.
function pg_geminiCaptureImage() {
  const models = Array.from(document.querySelectorAll('model-response'));
  const img = models.length ? Array.from(models.at(-1).querySelectorAll('single-image.generated-image img, generated-image img')).find(i => i.complete && i.naturalWidth >= 256) : null;
  if (!img) return {ok: false, error: 'generated image not found'};
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return {ok: true, base64: canvas.toDataURL('image/png').split(',')[1], size: `${img.naturalWidth}x${img.naturalHeight}`};
  } catch (error) { return {ok: false, error: String(error?.message || error)}; }
}

// Pastes the images into the composer exactly once, all together. Gemini keeps
// the paste order (Image 1, 2, 3 …). Its upload menu items do not render for
// programmatic clicks, and a second paste is rejected as "already uploaded" or
// duplicates attachments, so readiness is waited for by the caller.
function pg_geminiPasteImages(files) {
  // The visible composer, same as pg_geminiState: Gemini can keep a hidden second editor in the page.
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const editor = Array.from(document.querySelectorAll('div.ql-editor[contenteditable="true"]')).find(shown) || null;
  if (!editor) return {ok: false, error: 'Gemini composer not found for the images'};
  const transfer = new DataTransfer();
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, {type: file.type || 'image/png'}));
  }
  editor.focus();
  editor.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: transfer}));
  return {ok: true};
}

// The prompt is sent exactly as written. Users map references in their own
// style ("REFERENCE ROLE MAPPING", "Image 1 — NAME", @tags …); the images are
// attached in the same order the prompt's references resolve to.
function geminiPromptText(item) {
  const text=String(item.generationText || item.text || '').trim();
  return item.builderSceneId&&[8,10].includes(Number(item.builderDurationSeconds))
    ? 'Generate exactly '+Number(item.builderDurationSeconds)+' seconds of video. Preserve the full scene timeline and do not shorten it.\n'+text : text;
}

// runGeminiPrompt holds one debugger session for the whole prompt: attaching shows
// Chrome's debugging banner, which shifts the page, so every point is measured
// while that session (and banner) is already in place.
async function geminiTrustedClick(tabId, point) {
  if (typeof mobileOverlayDevice === 'function' && mobileOverlayDevice()) {
    const target={tabId};
    if(typeof cdpHideMini==='function')await cdpHideMini((method,params)=>chrome.debugger.sendCommand(target,method,params));
    await chrome.debugger.sendCommand(target,'Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
    await chrome.debugger.sendCommand(target,'Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    return;
  }
  await flowCdpClick(tabId, point.x, point.y, true);
}
// Typing goes to the focused element: make sure that is the composer, caret at the end (a click can land on a thumbnail).
function pg_geminiFocusEditor() {
  const editor = Array.from(document.querySelectorAll('div.ql-editor[contenteditable="true"]')).find(e => e.getBoundingClientRect().width > 0) || null;
  if (!editor) return false;
  if (!editor.contains(document.activeElement)) editor.focus();
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return editor.contains(document.activeElement) || document.activeElement === editor;
}

// Gemini's mode picker (owner request 2026-10-23): one menu holds the models (3.5 Flash-Lite, 3.8 Flash, 3.1 Pro, 4 Argon;
// data-test-id "bard-mode-option-<id>", ids differ per account) and the thinking levels (Low / Medium / High). The selected
// entries carry the class "selected"; the menu closes after every choice and only opens on a trusted click.
function pg_geminiModePicker() {
  const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const center = e => { const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; };
  // The narrow (mobile) layout moves the picker to the top bar without its data-test-id.
  const button = [...document.querySelectorAll('[data-test-id="bard-mode-menu-button"]')].find(visible)
    || [...document.querySelectorAll('button')].find(b => visible(b) && /^open mode picker\b/i.test(b.getAttribute('aria-label') || ''));
  const menu = [...document.querySelectorAll('gem-menu[data-test-id="gem-mode-menu"]')].find(visible);
  const items = menu ? [...menu.querySelectorAll('gem-menu-item,[role="menuitem"]')].filter(visible).map(e => ({
    kind: /^bard-mode-option-/.test(e.getAttribute('data-test-id') || '') ? 'model' : 'level',
    label: (e.querySelector('.label')?.textContent || e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    selected: e.classList.contains('selected') || e.getAttribute('aria-checked') === 'true',
    disabled: e.getAttribute('aria-disabled') === 'true',
    point: center(e)
  })) : [];
  return {button: button ? center(button) : null, current: button?.getAttribute('aria-label') || '', open: !!menu, items};
}
function geminiModeMatches(kind, want, label) {
  const l = String(label || '').toLowerCase();
  if (kind === 'level') return l === want;
  return want === 'flash-lite' ? /flash[\s-]*lite/.test(l) : want === 'flash' ? /\bflash\b/.test(l) && !/lite/.test(l) : new RegExp('\\b' + want + '\\b').test(l);
}
const GEMINI_MODE_NAMES = {'flash-lite': 'Flash-Lite', flash: 'Flash', pro: 'Pro', argon: 'Argon', low: 'Low', medium: 'Medium', high: 'High'};
// Picks the chosen model, then the thinking level. Never fails the prompt: an option the account lacks is logged and skipped.
async function geminiSetMode(tabId, item, token) {
  const wants = [['model', settings.geminiModel], ['level', settings.geminiThinking]].filter(([, want]) => want);
  if (!wants.length) return;
  item.detail = 'setting the Gemini model'; renderQueue();
  const read = () => exec(tabId, pg_geminiModePicker, [], 'MAIN');
  const openMenu = async () => {
    let state = await read();
    if (state.open) return state;
    if (!state.button) return null;
    await geminiTrustedClick(tabId, state.button);
    for (let i = 0; i < 10; i++) { await sleep(300); assertRunActive(token); state = await read(); if (state.open && state.items.length) return state; }
    return null;
  };
  const closeMenu = async state => { if (state?.open && state.button) { await geminiTrustedClick(tabId, state.button); await sleep(400); } };
  for (const [kind, want] of wants) {
    const name = GEMINI_MODE_NAMES[want];
    const state = await openMenu();
    if (!state) { log(`${item.id}: Gemini mode picker not found; keeping the current ${kind === 'model' ? 'model' : 'thinking level'}.`); return; }
    const target = state.items.find(x => x.kind === kind && geminiModeMatches(kind, want, x.label));
    if (!target || target.disabled) { log(`${item.id}: Gemini ${kind === 'model' ? 'model' : 'thinking level'} "${name}" is not offered here; keeping the current one.`); await closeMenu(state); continue; }
    if (target.selected) { await closeMenu(state); continue; }
    await geminiTrustedClick(tabId, target.point);
    await sleep(700); assertRunActive(token);
    const after = await read(); if (after.open) await closeMenu(after);
  }
  // Check what Gemini now shows, then close the menu again.
  const check = await openMenu();
  if (check) {
    const chosen = check.items.filter(x => x.selected).map(x => x.label);
    const missed = wants.filter(([kind, want]) => !check.items.some(x => x.kind === kind && x.selected && geminiModeMatches(kind, want, x.label)));
    log(`${item.id}: Gemini mode: ${chosen.join(' · ') || 'unknown'}${missed.length ? ` (could not select ${missed.map(([, want]) => GEMINI_MODE_NAMES[want]).join(', ')})` : ''}.`);
    await closeMenu(check);
  }
}

// "Upload & tools" menu: the button that opens it and the "Create image" / "Create video" entry inside it.
function pg_geminiToolMenu(image) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const point = e => { if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; };
  const want = image ? /^create images?$/i : /^create videos?$/i;
  const entry = Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]'))
    .find(e => visible(e) && want.test((e.innerText || '').replace(/\s+/g, ' ').trim()));
  const tools = Array.from(document.querySelectorAll('button'))
    .find(b => visible(b) && /^upload (?:&|and) tools$/i.test(b.getAttribute('aria-label') || ''));
  return {entry: entry&&!entry.disabled&&entry.getAttribute('aria-disabled')!=='true'?point(entry):null, checked:entry?.getAttribute('aria-checked')==='true', tools:point(tools), open:tools?.getAttribute('aria-expanded')==='true'};
}

// The Images/Videos tool chip is sometimes missing: Gemini opens the page without it, or drops it while an image
// uploads (turning it off also moves the page from /images to /app). Turn it back on from "Upload & tools" →
// "Create image" / "Create video" (owner report 2026-10-18: a whole queue failed "tool is not active" 3x per prompt).
// Returns the page state; the tool is on when state.imageTool / state.videoTool is true.
async function geminiDismissToolMenu(tabId,state){
  if(!state.toolMenuOpen)return;
  for(const type of ['keyDown','keyUp'])await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
}
async function geminiEnsureTool(tabId, item, image, token) {
  const on=s=>image?s.imageTool:s.videoTool,started=Date.now();
  let state=await exec(tabId,pg_geminiState,[],'MAIN'),openAttempts=0,selections=0,nextAction=0,discoveryAttempts=0;
  while(Date.now()-started<30000){
    assertRunActive(token);
    if(state.discoveryPoint&&discoveryAttempts<2){
      await geminiTrustedClick(tabId,state.discoveryPoint);discoveryAttempts++;await sleep(1000);
      state=await exec(tabId,pg_geminiState,[],'MAIN');continue;
    }
    if(on(state)){await geminiDismissToolMenu(tabId,state);await sleep(250);state=await exec(tabId,pg_geminiState,[],'MAIN');if(on(state)){if(selections)log(`${item.id}: Gemini ${image?'Images':'Videos'} tool was off; turned it on again (Upload & tools → Create ${image?'image':'video'}).`);return state;}continue;}
    const menu=await exec(tabId,pg_geminiToolMenu,[image],'MAIN');
    // Re-read after the menu hydrates. Clicking an already-selected entry toggles the tool OFF.
    state=await exec(tabId,pg_geminiState,[],'MAIN');
    if(on(state))continue;
    if(Date.now()>=nextAction){
      if(menu.entry&&!menu.checked&&selections<2){
        await geminiTrustedClick(tabId,menu.entry);selections++;nextAction=Date.now()+3000;
        log(`${item.id}: activating Gemini ${image?'Images':'Videos'} tool (Upload & tools → Create ${image?'image':'video'}).`);
      }else if(!menu.entry&&!menu.open&&openAttempts<3&&menu.tools){
        await geminiTrustedClick(tabId,menu.tools);openAttempts++;nextAction=Date.now()+3000;
      }
    }
    await sleep(500);state=await exec(tabId,pg_geminiState,[],'MAIN');
  }
  await geminiDismissToolMenu(tabId,state);
  return await exec(tabId,pg_geminiState,[],'MAIN');
}
function geminiToolMissingError(image) {
  const kind=image?'image':'video',Kind=image?'Images':'Videos';
  return Object.assign(Error(`Gemini setup failed: the ${Kind} tool could not be confirmed after waiting and trying to activate it (Upload & tools → Create ${kind}). Check the Gemini page for a loading, sign-in or tool-availability message; this alone does not establish an account limit`),{geminiToolMissing:true});
}
// On phones the soft keyboard can push Send below the visual viewport even though its layout rect exists.
// Blur only an obstructed composer, then let the normal hit-test and stable-position checks run again.
function pg_geminiRevealSend() {
  if (!(!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''))) return false;
  const send = Array.from(document.querySelectorAll('button')).find(b => /^send(?: message)?$/i.test(b.getAttribute('aria-label') || '') && !b.disabled && b.getBoundingClientRect().width > 0);
  if (!send) return false;
  const r = send.getBoundingClientRect(), height = Math.min(innerHeight, visualViewport?.height || innerHeight);
  if (r.top >= 0 && r.bottom <= height) return false;
  document.querySelector('div.ql-editor[contenteditable="true"]')?.blur();
  send.scrollIntoView({block:'nearest'});
  return true;
}
// Re-measure only after overlays close and composer/upload layout stops moving.
async function geminiSendPoint(tabId,token,prompt,wantChips,image,accepted=null){
  let previous=null,state=null,discoveryAttempts=0;
  const started=Date.now();
  while(Date.now()-started<12000){
    assertRunActive(token);state=await exec(tabId,pg_geminiState,[],'MAIN');
    if(accepted?.(state))return state;
    if(state.discoveryPoint&&discoveryAttempts<2){await geminiTrustedClick(tabId,state.discoveryPoint);discoveryAttempts++;previous=null;await sleep(1000);continue;}
    if(state.sendBlocked && await exec(tabId,pg_geminiRevealSend,[],'MAIN')) { previous=null; await sleep(350); continue; }
    await geminiDismissToolMenu(tabId,state);
    const compact=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
    const intact=state.editor&&compact(state.editorText).includes(compact(prompt).slice(0,200));
    const ready=(image?state.imageTool:state.videoTool)&&(!wantChips||(state.chips===wantChips&&state.chipsReady===wantChips&&state.chipsBusy===0));
    if(intact&&ready&&state.send&&!state.sendBlocked&&!state.toolMenuOpen&&!state.busy){
      if(previous&&Math.abs(previous.x-state.send.x)<1&&Math.abs(previous.y-state.send.y)<1)return state;
      previous=state.send;
    }else previous=null;
    await sleep(350);
  }
  throw Error('Gemini Send is not ready or is covered by an overlay; not sent');
}

async function geminiWaitForComposer(tabId,token){
  let state=null;
  for(const started=Date.now();Date.now()-started<30000;){
    assertRunActive(token);state=await exec(tabId,pg_geminiState,[],'MAIN');
    if(state.editor||state.discoveryPoint||geminiQuotaText(state.pageText))return state;
    await sleep(500);
  }
  return state;
}
async function geminiSetAspect(tabId, token) {
  const image = geminiIsImageMode();
  const wanted = ['landscape', 'portrait'].includes(settings.aspectRatio) || (image && settings.aspectRatio === 'square') ? settings.aspectRatio : null;
  let state = await exec(tabId, pg_geminiState, [], 'MAIN');
  if (!wanted) { log('Gemini videos support Portrait or Landscape only; keeping Gemini\'s current aspect ratio for Square.'); return; }
  const ok = s => (wanted === 'landscape' ? /landscape|16\s*:\s*9/i : wanted === 'square' ? /1\s*:\s*1/ : /portrait|9\s*:\s*16/i).test(s.aspect);
  if (ok(state)) return;
  for(const start=Date.now();!state.aspectPoint&&Date.now()-start<10000;){await sleep(400);assertRunActive(token);state=await exec(tabId,pg_geminiState,[],'MAIN');if(ok(state))return;}
  if (!state.aspectPoint) throw Object.assign(Error(`Gemini setup failed: aspect ratio control not found on the ${image ? 'Images' : 'Videos'} page`),{geminiAspectSetup:true});
  await geminiTrustedClick(tabId, state.aspectPoint); await sleep(600); assertRunActive(token);
  let option=null,previous=null,recovered=false;
  for(const start=Date.now();Date.now()-start<10000&&!option;){
    assertRunActive(token);const candidate=await exec(tabId,pg_geminiAspectOption,[wanted,image],'MAIN');
    if(candidate&&previous&&Math.abs(candidate.x-previous.x)<1&&Math.abs(candidate.y-previous.y)<1){option=candidate;break;}
    previous=candidate;
    if(!option && !recovered && Date.now()-start>=1600){
      state=await exec(tabId,pg_geminiState,[],'MAIN');if(ok(state))return;
      await exec(tabId,pg_geminiOpenAspectMenu,[],'MAIN');recovered=true;
      log('Gemini aspect menu did not expose the requested ratio; retrying menu activation without changing tabs.');
    }
    if(!option)await sleep(350);
  }
  if (!option) throw Object.assign(Error(`Gemini setup failed: ${wanted} aspect option not found`),{geminiAspectSetup:true});
  await geminiTrustedClick(tabId, option); await sleep(600);
  state = await exec(tabId, pg_geminiState, [], 'MAIN');
  for(const start=Date.now();!ok(state)&&Date.now()-start<8000;){await sleep(400);assertRunActive(token);state=await exec(tabId,pg_geminiState,[],'MAIN');}
  if (!ok(state)) throw Object.assign(Error(`Gemini setup failed: aspect ratio did not change to ${wanted} (shows "${state.aspect}")`),{geminiAspectSetup:true});
}

// Waits until exactly `want` attachment chips are loaded, show no progress, and
// stay that way for `stableMs`. Never re-pastes; a duplicate is an error.
async function geminiWaitForAttachments(tabId, item, want, stableMs, timeoutMs, token, label) {
  let since = null, state = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertRunActive(token);
    state = await exec(tabId, pg_geminiState, [], 'MAIN');
    if (state.chips > want) throw geminiAttachError(`${state.chips} attachments for ${want} image(s) (duplicate upload)`);
    const ready = state.chips === want && state.chipsReady === want && state.chipsBusy === 0;
    if (ready) { since = since ?? Date.now(); if (Date.now() - since >= stableMs) return state; }
    else since = null;
    item.detail = ready ? `${label} (${Math.floor((Date.now() - since) / 1000)}/${Math.round(stableMs / 1000)}s stable)`
      : `uploading ${want === 1 ? 'image' : 'images'} (${state.chipsReady}/${want} ready${state.chipsBusy ? `, ${state.chipsBusy} uploading` : ''})`;
    renderQueue();
    await sleep(500);
  }
  throw geminiAttachError(`${state?.chipsReady || 0}/${want} ready, ${state?.chips || 0} attachment(s), ${state?.chipsBusy || 0} still uploading`);
}

// Re-measure the exact latest result after scrolling. Cached points can be
// outside the viewport when Gemini expands image-edit replies or chat history.
function pg_geminiDownloadPoint(image, expectedSource) {
  const response = Array.from(document.querySelectorAll('model-response')).at(-1);
  if (!response) return {ok:false, error:'Gemini result is not mounted'};
  const media = Array.from(response.querySelectorAll(image ? 'single-image.generated-image img, generated-image img' : 'generated-video video, video-player video'))
    .find(m => (m.currentSrc || m.src || '') === expectedSource);
  if (!media) return {ok:false, error:'Gemini result changed before download'};
  const pattern = image ? /^download full.?sized? image$/i : /^download video$/i;
  const button = Array.from(response.querySelectorAll('button')).find(b => pattern.test(b.getAttribute('aria-label') || '') && !b.disabled);
  if (!button) return {ok:false, error:'Gemini download button is not ready'};
  button.scrollIntoView({block:'center',inline:'nearest'});
  const r = button.getBoundingClientRect(), x = r.left+r.width/2, y = r.top+r.height/2;
  const hit = document.elementFromPoint(x,y);
  if (!r.width || !r.height || !hit || !(hit === button || button.contains(hit))) return {ok:false, error:'Gemini download button is covered'};
  return {ok:true,point:{x,y}};
}

// Only accept a recent download attributable to Gemini, never an unrelated image/video download.
function geminiOwnDownload(d,startedAt,image){
  if(!(Date.parse(d.startTime||'')>=startedAt-1000))return false;
  if(d.referrer&&!isGeminiTab({url:d.referrer}))return false;
  const ownName=image?/(?:^|[\\/])Gemini_Generated_Image_[\w-]+\.(?:png|jpe?g|webp)$/i.test(String(d.filename||'')):false;
  if(ownName)return true;   // Gemini's own image file name, started after the click
  if(d.mime&&!/^(?:application\/octet-stream|binary\/octet-stream)$/i.test(d.mime)&&!(image?/^image\//i:/^video\/mp4/i).test(d.mime))return false;
  const src=String(d.finalUrl||d.url||'');
  // Owner test 2026-10-23: full-size images now arrive from other Google content hosts (and without a referrer), so the
  // download was never claimed: it kept Gemini's name, skipped the Flow Automation folder and the queue waited on it.
  const origin=/^(?:blob:)?https:\/\/(?:gemini\.google\.com|(?:[a-z0-9-]+\.)*googleusercontent\.com|(?:[a-z0-9-]+\.)*usercontent\.google\.com|lh\d+\.google\.com)(?:\/|$)/i.test(src)||/^data:image\//i.test(src);
  return origin||!!(d.referrer&&isGeminiTab({url:d.referrer})&&(image?/^image\//i:/^video\/mp4/i).test(d.mime||''));
}
function geminiResultMatches(item,state){
  const compact=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
  const wanted=compact(geminiPromptText(item)).slice(0,120);return !!wanted&&!!state.answerAfterUser&&compact(state.latestUserText).includes(wanted);
}
async function geminiLocalImage(tabId,item,placed=null){
  if(stopRequested)throw Error('cancelled by user');
  if(placed?.sourceUrl){
    try{
      const buf=await downloadMediaBuffer(tabId,{src:placed.sourceUrl,host:'Gemini full-size image'},item.id);
      if(stopRequested)throw Error('cancelled by user');
      if(!P().bufferHasImageSignature(buf))throw Error('downloaded data is not an image');
      return {buf,ext:typeof guessImageExt==='function'?guessImageExt(buf,''):new Uint8Array(buf)[0]===0xff?'jpg':'png'};
    }catch(e){if(stopRequested)throw e;log(`${item.id}: full-size image bytes unavailable for local storage; using the rendered preview.`);}
  }
  const captured=await exec(tabId,pg_geminiCaptureImage,[],'MAIN');
  if(stopRequested)throw Error('cancelled by user');
  if(!captured?.ok)throw Error(`Gemini download failed: ${captured?.error||'image capture failed'}. The image is kept in the Gemini chat.`);
  const buf=base64ToBuffer(captured.base64);
  if(!P().bufferHasImageSignature(buf))throw Error('Gemini download failed: captured data is not an image');
  log(`${item.id}: captured Gemini preview image (${captured.size}) for local storage.`);
  return {buf,ext:'png'};
}

// Mobile Gemini passes its original image Blob through a same-origin broker to a sandboxed download frame.
// Capture only that exact, short-lived handoff. Quetta otherwise reports it as an unattributable blob:null download.
// Unknown messages still follow the native path; every hook is restored on capture, timeout, Stop or error.
async function pg_geminiOriginalBridge(action, source, key) {
  const slot='__oxflowGeminiOriginalDownload', current=()=>{
    const model=Array.from(document.querySelectorAll('model-response')).at(-1);
    return model&&Array.from(model.querySelectorAll('single-image.generated-image img, generated-image img')).find(i=>i.complete&&i.naturalWidth>=256);
  };
  const matches=()=>current()?.src===source;
  if(action==='arm'){
    if(location.hostname!=='gemini.google.com'||!source||!key||!matches())return {ok:false};
    if(window[slot])return {ok:false};
    const state={key,source,url:location.href,blob:null,restore:[],expired:false};
    const unhook=()=>{for(const restore of state.restore.splice(0))restore();clearTimeout(state.timer);};
    state.unhook=unhook;window[slot]=state;
    const realms=[window];
    for(const frame of document.querySelectorAll('iframe'))try{if(frame.contentDocument&&frame.contentWindow)realms.push(frame.contentWindow);}catch{}
    for(const realm of new Set(realms)){
      const proto=realm.MessagePort?.prototype;if(!proto)continue;
      const original=proto.postMessage;
      const hook=function(data,...rest){
        const blob=data?.values?.[0],filename=data?.values?.[1],reply=Array.isArray(rest[0])&&rest[0].length===1?rest[0][0]:null;
        const own=window[slot]===state&&!state.blob&&!state.expired&&location.href===state.url&&matches()
          &&Array.isArray(data?.paramNames)&&data.paramNames.join(',')==='blob,filename'&&Array.isArray(data.values)&&data.values.length===2
          &&typeof data.code==='string'&&data.code.includes('URL.createObjectURL(blob)')&&data.code.includes('a.download=filename')&&data.code.includes('a.click()')
          &&Object.prototype.toString.call(blob)==='[object Blob]'&&/^(?:image\/(?:png|jpeg|webp))$/i.test(blob.type)&&blob.size>=10240&&blob.size<=32*1024*1024
          &&typeof filename==='string'&&/^Gemini_Generated_Image_[\w-]+(?:\.(?:png|jpe?g|webp))?$/i.test(filename)&&typeof reply?.postMessage==='function';
        if(own)try{
          // Complete the app's own request without opening its opaque download. saveOutput will save these bytes once.
          reply.postMessage({result:undefined});state.blob=blob;state.filename=filename;unhook();return;
        }catch{}
        return original.call(this,data,...rest);
      };
      proto.postMessage=hook;
      state.restore.push(()=>{if(proto.postMessage===hook)proto.postMessage=original;});
    }
    state.timer=setTimeout(()=>{state.expired=true;unhook();if(window[slot]===state&&!state.blob)delete window[slot];},30000);
    return {ok:true};
  }
  const state=window[slot];if(!state||state.key!==key)return {ready:false};
  if(action==='cleanup'){state.unhook();state.blob=null;delete window[slot];return {ok:true};}
  if(action!=='take'||!state.blob)return {ready:false};
  if(location.href!==state.url||!matches())throw Error('Gemini result changed before download');
  const blob=state.blob;
  const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(Error('Gemini original image could not be read'));r.readAsDataURL(blob);});
  return {ready:true,base64:data.slice(data.indexOf(',')+1),bytes:blob.size,mime:blob.type,filename:state.filename};
}

// Saves via Gemini's own download button: "Download video" when the direct fetch
// is refused; for images "Download full-sized image" first, which keeps the full
// resolution and Gemini's own file type.
async function geminiDownloadViaButton(tabId, item, point, image = false, token=runToken, expectedSource=item.geminiResult?.src) {
  // "Auto change file name" (control.js outputFileName); plain numbered name where that helper is not loaded.
  const fileName = (it, ext, own) => typeof outputFileName === 'function' ? outputFileName(it, ext, typeof platformFileName === 'function' ? platformFileName(own) : '') : outputNameForItem(it, ext);
  let name = fileName(item, image ? 'png' : 'mp4');
  let downloadId = null, result = '', bridgeKey = '';
  const done = state => { result = result || state; };
  const startedAt = Date.now();
  const mine = d => downloadId != null ? d.id === downloadId : geminiOwnDownload(d,startedAt,image);
  const naming = (d, suggest) => {
    if (!mine(d)) { suggest(); return; }
    downloadId = d.id;
    // "Auto change file name" off keeps Gemini's own name (d.filename is the name Gemini proposed).
    if (image) {
      const ext = String(d.filename || '').match(/\.(png|jpe?g|webp)$/i)?.[1] || (/jpe?g/i.test(d.mime || '') ? 'jpg' : /webp/i.test(d.mime || '') ? 'webp' : 'png');
      name = fileName(item, ext.toLowerCase(), d.filename);
    } else name = fileName(item, 'mp4', d.filename);
    suggest({filename: `${downloadFolder()}/${name}`, conflictAction: 'uniquify'});
  };
  const created = d => { if (mine(d)) downloadId = d.id; };
  const changed = delta => { if (delta.id === downloadId && delta.state && ['complete', 'interrupted'].includes(delta.state.current)) done(delta.state.current); };
  chrome.downloads.onDeterminingFilename.addListener(naming);
  chrome.downloads.onCreated?.addListener(created);
  chrome.downloads.onChanged.addListener(changed);
  try {
    assertRunActive(token);
    if (expectedSource) {
      let refreshed;
      for (let attempt = 0; attempt < 10; attempt++) {
        assertRunActive(token);
        if (typeof stopRequested !== 'undefined' && stopRequested) throw Error('cancelled by user');
        refreshed = await exec(tabId,pg_geminiDownloadPoint,[image,expectedSource],'MAIN');
        if (refreshed?.ok) break;
        if (/changed before download/.test(refreshed?.error || '')) break;
        if (attempt < 9) await sleep(500);
      }
      if (!refreshed?.ok) throw Error(refreshed?.error || 'Gemini download button unavailable');
      point = refreshed.point;
    }
    if(image&&expectedSource&&typeof mobileOverlayDevice==='function'&&mobileOverlayDevice()){
      const key=crypto.randomUUID();
      const bridge=await exec(tabId,pg_geminiOriginalBridge,['arm',expectedSource,key],'MAIN');
      if(bridge?.ok)bridgeKey=key;
    }
    await geminiTrustedClick(tabId, point);

    // Poll instead of a bare timer: Stop ends the wait at once, and nothing is left running after it.
    const limit = (image ? 2 : 5) * 60000;
    while (!result && Date.now() - startedAt < limit) {
      assertRunActive(token);
      if (typeof stopRequested !== 'undefined' && stopRequested) throw Error('stopped while waiting for the Gemini download');
      if(bridgeKey){
        const captured=await exec(tabId,pg_geminiOriginalBridge,['take',expectedSource,bridgeKey],'MAIN');
        if(captured?.ready){
          const buf=base64ToBuffer(captured.base64);
          if(buf.byteLength!==captured.bytes||!P().bufferHasImageSignature(buf))throw Error('Gemini original download is not a valid image');
          const ext=/jpeg/i.test(captured.mime)?'jpg':/webp/i.test(captured.mime)?'webp':'png';
          return {name:fileName(item,ext,captured.filename),bytes:buf.byteLength,buf,ext};
        }
      }
      // Chrome may create/finish the download before naming captures its ID,
      // or omit a filename event. Reconcile records instead of waiting out the
      // full timeout and saving a duplicate lower-resolution preview.
      const records = await chrome.downloads.search(downloadId != null
        ? {id:downloadId} : {startedAfter:new Date(startedAt - 1000).toISOString()}).catch(() => []);
      const candidates = records.filter(mine);
      if (candidates.length > 1) throw Error('Gemini download is ambiguous: multiple recent matching downloads. The generated result is retained in its chat.');
      const record = candidates[0];
      if (record) {
        downloadId = record.id;
        if (['complete', 'interrupted'].includes(record.state)) done(record.state);
      }
      if (!result) await sleep(500);

    }
    const state = result || 'timeout';
    if (state !== 'complete') throw Error(`Gemini download did not finish (${state})`);
    const [record] = await chrome.downloads.search({id: downloadId});
    if (!record || (record.fileSize || 0) < (image ? 10 : 100) * 1024) throw Error(`Gemini download is too small to be ${image ? 'an image' : 'a video'}`);
    return {name: `${downloadFolder()}/${String(record.filename || name).split(/[\\/]/).pop()}`, bytes: record.fileSize,sourceUrl:record.finalUrl||record.url||''};
  } finally {
    if(bridgeKey)await exec(tabId,pg_geminiOriginalBridge,['cleanup',expectedSource,bridgeKey],'MAIN').catch(()=>{});
    chrome.downloads.onDeterminingFilename.removeListener(naming);
    chrome.downloads.onCreated?.removeListener(created);
    chrome.downloads.onChanged.removeListener(changed);
  }
}

// Images: Gemini's "Download full-sized image" first (full resolution); if that
// download never arrives, the rendered preview is saved as PNG instead.
async function geminiSaveImage(tabId, item, token=runToken) {
  const current=await chrome.tabs.get(tabId);
  if(current.url!==item.geminiResult.url){await chrome.tabs.update(tabId,{url:item.geminiResult.url});await waitForTabComplete(tabId);await sleep(3000);}
  let state=null;
  for(let i=0;i<20;i++){
    assertRunActive(token);if(stopRequested)throw Error('cancelled by user');
    state=await exec(tabId,pg_geminiState,[],'MAIN');
    if(state.imageSrc&&geminiResultMatches(item,state))break;
    await sleep(1000);
  }
  if(!state?.imageSrc||!geminiResultMatches(item,state))throw Error('Gemini download failed: the image does not match this prompt. Return to its original Gemini chat before retrying.');
  let placed=null;
  if(state.imageDownloadPoint){
    try{placed=await geminiDownloadViaButton(tabId,item,state.imageDownloadPoint,true,token,state.imageSrc);log(`${item.id}: Gemini full-size image downloaded (${Math.round(placed.bytes/1024)} KB).`);}
    catch(error){if(stopRequested||token!==runToken||/cancelled by user|result changed before download|download is ambiguous/i.test(error.message))throw error;log(`${item.id}: Gemini full-size download failed (${error.message}); saving the preview instead.`);}
  }
  if(placed?.buf)return saveOutput(item,placed.buf,placed.ext);
  const folder=typeof outputDir!=='undefined'&&outputDir;
  // A native browser download bypasses saveOutput: Builder/cover still need their own local image copy.
  if(placed&&!folder&&!item.builderProjectId&&!item.manualProjectId)return {name:placed.name,where:'Chrome Downloads'};
  const local=await geminiLocalImage(tabId,item,placed);assertRunActive(token);
  if(placed&&!folder){
    if(typeof window==='undefined'||!window.FlowBuilderUI?.captureImage)throw Error('Gemini download failed: Builder image storage is unavailable. Keep the panel open and retry saving.');
    if(stopRequested)throw Error('cancelled by user');
    await window.FlowBuilderUI.captureImage(item,local.buf,local.ext);
    return {name:placed.name,where:'Chrome Downloads + Builder'};
  }
  return saveOutput(item,local.buf,local.ext);
}

async function runGeminiPrompt(item, slot, token) {
  item.platform = 'gemini';
  item.attempts = (item.attempts || 0) + 1; item.retryAt = null;
  const image = geminiIsImageMode(), kind = image ? 'image' : 'video', Kind = image ? 'Images' : 'Videos';
  item.status = 'running'; item.progressPercent = null; item.detail = `opening Gemini ${Kind}`; renderQueue();
  let tab = null, debuggerTarget = null, ownsDebugger = false;
  try {
    assertRunActive(token);
    tab = await getGeminiTab(slot);
    debuggerTarget = {tabId: tab.id};
    try { await chrome.debugger.attach(debuggerTarget, '1.3'); ownsDebugger = true; }
    catch (error) { if (!/another debugger|already attached/i.test(String(error?.message || error))) throw error; }
    if(item.geminiResult&&((item.geminiResult.mode&&item.geminiResult.mode!==settings.mode)||(item.geminiResult.prompt&&item.geminiResult.prompt!==geminiPromptText(item))))item.geminiResult=null;
    if (!item.geminiResult) {
      // One fresh chat per prompt keeps each answer bound to its own prompt.
      const background = typeof confirmBackgroundTab === 'function' && await confirmBackgroundTab(tab.id);
      await chrome.tabs.update(tab.id, {url: geminiPageUrl(image), ...(settings.openTabWhileGenerating && !background ? {active: true} : {})});
      await waitForTabComplete(tab.id); await sleep(2500); assertRunActive(token);
      let state=await geminiWaitForComposer(tab.id,token);
      // A first visit to the Images page shows a "Create images" card over the composer.
      if (state.discoveryPoint) { await geminiTrustedClick(tab.id, state.discoveryPoint); await sleep(1000); state=await geminiWaitForComposer(tab.id,token); }
      // Quota banner check before any upload or send.
      if (geminiQuotaText(state.pageText)) throw Object.assign(Error(`Gemini ${kind} limit reached: ${state.pageText.match(image ? /[^.]*out of images[^.]*\.?[^.]*/i : /[^.]*out of videos[^.]*\.?[^.]*/i)?.[0] || `out of ${kind}s`}`), {geminiLimit: true});
      if (!state.editor) throw Error(`Gemini setup failed: ${Kind} composer did not load. Sign in to Gemini in this browser, then retry.`);
      // Model first: switching the model drops the Images/Videos tool (and its aspect button), owner test 2026-10-23.
      await geminiSetMode(tab.id, item, token);
      state = await exec(tab.id, pg_geminiState, [], 'MAIN');
      if (!(image ? state.imageTool : state.videoTool)) state = await geminiEnsureTool(tab.id, item, image, token);
      if (!(image ? state.imageTool : state.videoTool)) throw geminiToolMissingError(image);
      if (state.busy) throw Error('Gemini is already generating. Wait for it to finish before starting this queue.');
      item.detail = 'setting Gemini aspect ratio'; renderQueue();
      await geminiSetAspect(tab.id, token);
      const stableMs = Math.max(5000, settings.uploadSettleSeconds * 1000);
      let wantChips = 0, references = [];
      if (settings.mode === 'frame-to-video' || settings.mode === 'ingredients-to-video' || settings.mode === 'image-to-image') {
        references = settings.mode === 'frame-to-video' ? imagesForItem(item).slice(0, 1) : imagesForItem(item);
        if (!references.length) throw geminiAttachError(`no ${settings.mode === 'frame-to-video' ? 'start image' : 'reference images'} assigned to this prompt`);
        if ((await exec(tab.id, pg_geminiState, [], 'MAIN')).chips) throw geminiAttachError('the composer already holds an attachment');
        const files = references.map(image => { const {b64, type} = dataUrlToB64(image.dataUrl); return {name: image.name, base64: b64, type}; });
        item.detail = `uploading ${files.length} image(s): ${files.map(f => f.name).join(', ')}`; renderQueue();
        const pasted = await exec(tab.id, pg_geminiPasteImages, [files], 'MAIN');
        if (!pasted?.ok) throw geminiAttachError(pasted?.error || 'paste not accepted');
        wantChips = files.length;
        await geminiWaitForAttachments(tab.id, item, wantChips, stableMs, 210000, token, wantChips === 1 ? 'verifying start image' : 'verifying reference images');
        log(`${item.id}: Gemini ${wantChips === 1 && settings.mode === 'frame-to-video' ? 'start image' : `${wantChips} reference image(s)`} uploaded and stable: ${files.map(f => f.name).join(', ')}.`);
      }
      item.detail = 'typing the prompt into Gemini'; renderQueue();
      const prompt = geminiPromptText(item);
      state = await exec(tab.id, pg_geminiState, [], 'MAIN');
      await geminiTrustedClick(tab.id, state.editorPoint);
      await Promise.resolve().then(() => exec(tab.id, pg_geminiFocusEditor, [], 'MAIN')).catch(() => false);
      await chrome.debugger.sendCommand(debuggerTarget, 'Input.insertText', {text: prompt});
      await sleep(800); assertRunActive(token);
      const compact = s => String(s || '').replace(/\s+/g, '').toLowerCase();
      // Final barrier right before Send: the image stays ready for another 5s,
      // the prompt is intact, and the Videos/Images tool is still selected.
      if (wantChips) await geminiWaitForAttachments(tab.id, item, wantChips, 5000, 120000, token, 'final start-image check');
      state = await exec(tab.id, pg_geminiState, [], 'MAIN');
      if (!compact(state.editorText).includes(compact(prompt).slice(0, 200))) throw Error('Gemini prompt could not be entered (composer text does not match); not sent');
      if (!(image ? state.imageTool : state.videoTool)) {
        // Dropped while the image uploaded: turn it back on, then re-check the attachments and the prompt text.
        state = await geminiEnsureTool(tab.id, item, image, token);
        if (!(image ? state.imageTool : state.videoTool)) throw geminiToolMissingError(image);
        if (wantChips) await geminiWaitForAttachments(tab.id, item, wantChips, 3000, 60000, token, 'final start-image check');
        state = await exec(tab.id, pg_geminiState, [], 'MAIN');
        if (!compact(state.editorText).includes(compact(prompt).slice(0, 200))) throw Error('Gemini prompt was lost while turning the tool back on; not sent');
      }
      state=await geminiSendPoint(tab.id,token,prompt,wantChips,image);
      const baselineUsers = state.userCount;
      await geminiTrustedClick(tab.id, state.send);
      // Confirm Gemini took the prompt (a new user turn, or the composer emptied). A missed click is clicked once more;
      // if it still was not taken, fail fast instead of waiting the whole generation time on a prompt that was never sent.
      const accepted = s => (s.userCount > baselineUsers && compact(s.latestUserText).includes(compact(prompt).slice(0,120))) || (s.editor && s.busy && !compact(s.editorText).includes(compact(prompt).slice(0,120)));
      for (let round = 0; round < 2; round++) {
        let taken = false;
        for (const waitStart = Date.now(); Date.now() - waitStart < 20000;) {
          await sleep(2000); assertRunActive(token);
          state = await exec(tab.id, pg_geminiState, [], 'MAIN');
          if (accepted(state)) { taken = true; break; }
        }
        if (taken) break;
        if (round === 1 || !state.send) throw Error('Gemini did not accept the Send click (the prompt is still in the box); not sent');
        log(`${item.id}: Gemini did not take the prompt yet; clicking Send again.`);
        state=await geminiSendPoint(tab.id,token,prompt,wantChips,image,accepted);
        if(!accepted(state))await geminiTrustedClick(tab.id,state.send);
      }
      log(`${item.id}: Gemini ${kind} request submitted.`);
      const started = Date.now(); let answerSince = 0, lastAnswer = '';
      while (Date.now() - started < settings.maxWaitMinutes * 60000) {
        await sleep(3000); assertRunActive(token);
        state = await exec(tab.id, pg_geminiState, [], 'MAIN');
        const mine = state.userCount > baselineUsers && compact(state.latestUserText).includes(compact(prompt).slice(0, 120));
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (mine && !image && state.videoSrc) { item.geminiResult = {url: state.url, src: state.videoSrc,mode:settings.mode,prompt}; break; }
        if (mine && image && state.imageSrc && !state.busy) { item.geminiResult = {url: state.url, image: true, size: state.imageSize,mode:settings.mode,prompt}; break; }
        if (mine && state.answerAfterUser && !state.busy && state.answer) {
          const answerKind = geminiAnswerKind(state.answer);
          if (answerKind !== 'text') log(`${item.id}: Gemini answered: ${state.answer.slice(0, 400)}`);
          if (answerKind === 'limit') throw Object.assign(Error(`Gemini ${kind} limit reached: ${state.answer.slice(0, 200)}`), {geminiLimit: true});
          if (answerKind === 'busy') throw Object.assign(Error(`Gemini concurrency limit: ${state.answer.slice(0, 160)}`), {geminiBusy: true});
          if (answerKind === 'refused') throw Error(`Gemini policy rejection: ${state.answer.slice(0, 300)}`);
          if (answerKind === 'failed') throw Error(`Gemini generation failed: ${state.answer.slice(0, 200)}`);
          // An unrecognised text answer may still be a progress note; give it time.
          if (state.answer !== lastAnswer) { lastAnswer = state.answer; answerSince = Date.now(); }
          else if (Date.now() - answerSince > 90000) {
            log(`${item.id}: Gemini answered with text instead of ${image ? 'an image' : 'a video'}: ${state.answer.slice(0, 400)}`);
            throw Error(`Gemini generation failed: answered with text instead of ${image ? 'an image' : 'a video'}`);
          }
        }
        item.detail = `generating ${kind} in Gemini (${Math.floor(elapsed / 60)}m ${elapsed % 60}s)`; renderQueue();
      }
      if (!item.geminiResult) throw Error(`Timed out waiting for the Gemini ${kind}`);
      log(`${item.id}: Gemini ${kind} ready${image && item.geminiResult.size ? ` (preview ${item.geminiResult.size})` : ''}.`);
    }
    // --- save (a stored result is downloaded again on Retry instead of regenerating) ---
    // Auto download off (Settings → Output): the result stays in the Gemini chat.
    if (typeof autoDownloadOff === 'function' && autoDownloadOff(item.geminiResult.image ? 'image' : 'video', item)) {
      finishWithoutDownload(item, 'Gemini', item.geminiResult.image ? 'image' : 'video'); return;
    }
    item.detail = `saving the Gemini ${kind}`; renderQueue();
    let saved;
    if (item.geminiResult.image) saved = await geminiSaveImage(tab.id, item,token);
    else try {
      const buf = await downloadMediaBuffer(tab.id, {src: item.geminiResult.src, host: 'Gemini'}, item.id);
      assertRunActive(token);
      if (buf.byteLength < 100 * 1024 || !P().bufferHasMp4Signature(buf)) throw Error('downloaded data is not an MP4 video');
      saved = await saveOutput(item, buf, 'mp4', typeof platformFileName === 'function' ? platformFileName(item.geminiResult.src) : '');
    } catch (error) {
      if(stopRequested||token!==runToken||/cancelled by user/i.test(error.message))throw error;
      log(`${item.id}: direct Gemini download failed (${error.message}); using Gemini's Download button.`);
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== item.geminiResult.url) { await chrome.tabs.update(tab.id, {url: item.geminiResult.url}); await waitForTabComplete(tab.id); await sleep(3000); }
      const state = await exec(tab.id, pg_geminiState, [], 'MAIN');
      if(!geminiResultMatches(item,state))throw Error('Gemini download failed: the visible video belongs to another prompt; return to the original Gemini chat.');
      if (!state.downloadPoint) throw Error('Gemini download failed: Download video button not found. The video is kept in the Gemini chat.');
      const placed = await geminiDownloadViaButton(tab.id,item,state.downloadPoint,false,token,state.videoSrc);
      const needsWorkspace=(item.builderProjectId&&item.builderSceneId||item.manualProjectId&&item.manualSceneId)&&typeof window!=='undefined'&&window.FlowBuilderUI?.captureVideo;
      if((typeof outputDir!=='undefined'&&outputDir)||needsWorkspace){
        try{
          const bytes=await downloadMediaBuffer(tab.id,{src:placed.sourceUrl||item.geminiResult.src,host:'Gemini native video'},item.id);
          assertRunActive(token);
          if(!P().bufferHasMp4Signature(bytes))throw Error('not an MP4 video');
          if(typeof outputDir!=='undefined'&&outputDir)saved=await saveOutput(item,bytes,'mp4');
          else await (item.manualProjectId?window.FlowBuilderUI.captureManualVideo:window.FlowBuilderUI.captureVideo)(item,bytes,'mp4');
        }catch(localError){
          if(stopRequested||token!==runToken||/cancelled by user/i.test(localError.message))throw localError;
          if(typeof outputDir!=='undefined'&&outputDir)throw Error('Gemini download failed: selected-folder copy failed; Chrome copy is kept. '+localError.message);
          log(`${item.id}: video downloaded; Workspace copy unavailable (${localError.message}). Import the downloaded MP4 into Story Workspace.`);
        }
      }
      saved ||= {name:placed.name,where:'Chrome Downloads'};
    }
    item.status = 'done'; item.outputName = saved.name; item.progressPercent = 100;
    item.detail = `saved ${saved.name} → ${saved.where}`;
    if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);
    log(`${item.id}: done - ${item.detail}`);
  } catch (e) {
    const errorText = String(e?.message || e);
    if (stopRequested || token !== runToken || /cancelled by user/i.test(errorText)) {
      item.status = 'pending'; item.retryAt = null; item.detail = 'cancelled - ready to resume';
    } else if (e.geminiLimit) {
      stopRequested = true; queueStopReason = `Gemini ${kind} limit reached`;
      item.status = 'pending'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: ${errorText}. Queue paused; resume when the limit resets.`);
    } else if (e.geminiAspectSetup) {
      stopRequested = true; queueStopReason = 'Gemini aspect ratio setup needs attention';
      item.status = 'pending'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: ${errorText}. Queue paused; open Gemini's aspect menu, then resume. Remaining prompts are preserved.`);
    } else if (e.geminiToolMissing) {
      // Tool activation is unresolved; pause without labeling it an account quota or failing every prompt.
      stopRequested = true; queueStopReason = `Gemini ${image ? 'Images' : 'Videos'} tool could not be activated`;
      item.status = 'pending'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: ${errorText}. Queue paused; check Gemini’s tool or loading message, then resume.`);
    } else if (/^Gemini policy rejection/.test(errorText) && running && typeof repairFailedPrompt === 'function' && await repairFailedPrompt(item, errorText, token)) {
      if (typeof flashQueueRejection === 'function') flashQueueRejection();
    } else if (/^Gemini policy rejection/.test(errorText)) {
      // Never resend a refused prompt unchanged: it needs a repair or an edit.
      item.status = 'error'; item.retryAt = null; item.detail = `Needs prompt edit: ${errorText}`;
      log(`${item.id}: ${errorText}. Not resent unchanged.`);
    } else if (running && !/^Gemini download failed/.test(errorText) && (item.technicalFailures = (item.technicalFailures || 0) + 1) < settings.maxAttempts) {
      // Soft failures, concurrency limits, setup and upload problems: retry this prompt later.
      item.status = 'pending'; item.retryAt = Date.now() + settings.retryDelaySeconds * 1000 * (e.geminiBusy ? 6 : 1);
      item.detail = `retry ${item.technicalFailures + 1}/${settings.maxAttempts} scheduled — ${errorText.slice(0, 120)}`;
      log(`${item.id}: Gemini attempt failed (${item.technicalFailures}/${settings.maxAttempts}): ${errorText}`);
    } else {
      item.status = 'error'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: Gemini ${errorText}`);
    }
  } finally {
    if (ownsDebugger) await chrome.debugger.detach(debuggerTarget).catch(() => {});
    renderQueue(); schedulePersist();
  }
}
