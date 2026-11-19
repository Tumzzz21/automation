// Grok adapter (grok.com/imagine): Text to Image, Image to Image, Text to Video, Frame to Video, Ingredients to Video.
// Drives the signed-in web app like the Flow, ChatGPT and Gemini adapters: no API keys or private endpoints.
// Page structure verified live (Oct 2026): the Imagine composer is a ProseMirror editor (div.tiptap.ProseMirror,
// aria "Ask Grok anything", placeholder "Type to imagine"); Image / Video / Agent are role=radio buttons; in Video mode
// 480p / 720p (/ 1080p) and 6s / 10s (/ 15s) are role=radio buttons; "Aspect Ratio" opens a menu of menuitemradio
// (Auto, 2:3, 3:2, 1:1, 9:16, 16:9). The composer form holds a hidden multiple <input type=file>; attached images show
// as thumbnails with a "Remove image" button. One attached image = start frame; two or more = reference images.
// In Image mode an attached picture is the source for an edit (Image to Image): Speed / Quality / Image Count hide,
// Aspect Ratio stays, and the placeholder reads "Type to imagine, @ to reference images".
// A video prompt navigates to /imagine/post/<id>; the result is a <video> whose src is
// https://assets.grok.com/users/<uid>/generated/<id>/generated_video.mp4. An image prompt stays on /imagine and shows
// cards (class media-post-masonry-card) with a link /imagine/post/<id>; the picture is a data: URL or
// https://assets.grok.com/users/<uid>/generated/<id>/image.jpg.
const GROK_URL = 'https://grok.com/imagine';
const GROK_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
const GROK_ORIGINS = ['https://grok.com/*', 'https://*.grok.com/*'];
function isGrokTab(tab) { return /^https:\/\/(?:[a-z0-9-]+\.)?grok\.com(?:\/|$)/i.test(tab?.url || ''); }
function grokIsVideoMode() { return /video/.test(settings.mode); }

// Grok is an optional site permission (asked once, when the user picks Grok), so the extension update that adds
// it does not disable the extension for existing users. Must be called from a user gesture.
async function ensureGrokAccess() {
  try {
    if (await chrome.permissions.contains({origins: GROK_ORIGINS})) return true;
    return await chrome.permissions.request({origins: GROK_ORIGINS});
  } catch (error) { return false; }
}

// 50% for this tab only (like Flow and ChatGPT): the whole Imagine layout fits, including the Regenerate / Extend / Upscale buttons that
// Grok folds into a "Post actions" dialog in a narrow window. restoreTabZoom puts the tab back to 100% when the whole queue finishes.
// A page load resets a per-tab zoom, so this runs after every navigation and while waiting.
async function zoomGrokTab(tabId) {
  if (typeof chrome.tabs.setZoom !== 'function') return;
  try {
    const zoom = await chrome.tabs.getZoomSettings(tabId);
    const before = await chrome.tabs.getZoom(tabId);
    if (zoom?.scope !== 'per-tab') await chrome.tabs.setZoomSettings(tabId, {mode: 'automatic', scope: 'per-tab'});
    if (Math.abs((await chrome.tabs.getZoom(tabId)) - 0.5) > 0.01) {
      await chrome.tabs.setZoom(tabId, 0.5); await sleep(600);
      const now = await chrome.tabs.getZoom(tabId);
      if (typeof log === 'function') log(Math.abs(now - 0.5) <= 0.01 ? `Grok tab zoom set to 50% (was ${Math.round(before * 100)}%).` : `Grok tab zoom is ${Math.round(now * 100)}% after setting 50%.`);
    }
  } catch (e) { if (typeof log === 'function') log(`Grok zoom could not be set: ${e.message || e}`); }
}

async function getGrokTab(slot) {
  const known = slotTabs.get(slot);
  if (known != null) {
    const tab = await chrome.tabs.get(known).catch(() => null);
    if (tab && isGrokTab(tab)) return tab;
  }
  const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  const tab = isGrokTab(active) ? active : await chrome.tabs.create({url: GROK_URL, active: !!settings.openTabWhileGenerating});
  slotTabs.set(slot, tab.id);
  await zoomGrokTab(tab.id);
  return tab;
}

// Grok's own wording, classified from the result area only (never from the composer, which holds the prompt).
function grokLimitText(text) {
  return false;  // Free plan: no limit detection — always allow
}
function grokAnswerKind(text) {
  const t = String(text || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  if (!t) return null;
  if (grokLimitText(t)) return 'limit';
  if (/content moderated|moderated|violates (?:our|the) (?:content )?polic|against (?:our|the) (?:content )?polic|can't (?:generate|create|make) (?:this|that|an image|a video|images|videos)|i'?m sorry,? i can'?t (?:help|assist)|can'?t help with that|cannot help with that|unable to (?:generate|create) (?:this|that)|not allowed|try a different (?:prompt|idea)|(?:image|video|content) (?:was )?(?:blocked|rejected)/.test(t)) return 'refused';
  if (/something went wrong|failed to generate|couldn't generate|could not generate|generation failed|try again later|an error occurred|network error/.test(t)) return 'failed';
  return 'text';
}

// Everything the runner needs from the page in one read.
function pg_grokState() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const label = e => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim();
  const editor = Array.from(document.querySelectorAll('div.tiptap.ProseMirror, [contenteditable="true"][aria-label*="Ask Grok" i]')).find(visible) || null;
  const form = editor ? (editor.closest('form') || editor.parentElement?.parentElement?.parentElement) : null;
  const scope = form || document;
  const buttons = Array.from(scope.querySelectorAll('button, [role="radio"]')).filter(visible);
  const radios = buttons.filter(b => b.getAttribute('role') === 'radio');
  const checked = b => b.getAttribute('aria-checked') === 'true';
  // Mode: role=radio (old) or the "Generation mode" buttons with aria-pressed (Grok 2026-11-11).
  const mode = radios.find(b => checked(b) && /^(image|video|agent)$/i.test(label(b)))
    || Array.from(document.querySelectorAll('button[aria-pressed="true"]')).find(b => visible(b) && /^(image|video|agent)$/i.test(b.getAttribute('aria-label') || ''));
  const res = radios.filter(b => /^\d{3,4}p$/i.test(label(b))), dur = radios.filter(b => /^\d{1,2}s$/i.test(label(b)));
  const aspect = buttons.find(b => /^aspect ratio$/i.test(b.getAttribute('aria-label') || ''));
  const submit = buttons.find(b => /^submit$/i.test(b.getAttribute('aria-label') || ''));
  // Attachment thumbnails only: an @mention chip inside the editor shows the same blob picture (verified live Oct 2026).
  const thumbs = form ? Array.from(form.querySelectorAll('img')).filter(i => i.getBoundingClientRect().width > 0 && /^blob:/.test(i.src) && !editor.contains(i)) : [];
  const removes = buttons.filter(b => /^remove image$/i.test(b.getAttribute('aria-label') || ''));
  const busyTray = form ? Array.from(form.querySelectorAll('[role="progressbar"], [class*="spinner" i], [class*="animate-spin"], [aria-busy="true"]')).some(e => e.getClientRects().length > 0) : false;
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
  const postId = (location.pathname.match(/^\/imagine\/post\/([0-9a-f-]{36})/i) || [])[1] || '';
  const videos = Array.from(document.querySelectorAll('video')).map(v => ({src: v.currentSrc || v.src || '', dur: v.duration || 0, w: v.videoWidth || 0, h: v.videoHeight || 0, big: v.getBoundingClientRect().width > 150}));
  const myVideo = postId ? videos.find(v => v.src.includes(`/generated/${postId}/`) && /generated_video/.test(v.src)) : null;
  const cards = Array.from(document.querySelectorAll('[class*="media-post-masonry-card"]')).map(card => {
    const img = card.querySelector('img'), a = card.querySelector('a[href*="/imagine/post/"]');
    return {href: a ? a.getAttribute('href') : '', placeholder: !a || /placeholder/.test(a.getAttribute('href') || ''), src: img ? (img.src.startsWith('data:') ? 'data:' : img.src) : '', ready: !!(img && img.complete && img.naturalWidth >= 256), w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0};
  });
  // Image to Image opens the edit's own post page: the big picture there is generated/<postId>/image.jpg (the source sits in a small thumbnail strip).
  const postImg = postId ? Array.from(document.querySelectorAll('img')).find(i => i.src.includes(`/generated/${postId}/`) && /\/image\./.test(i.src) && i.getBoundingClientRect().width > 150) : null;
  const generating = String(document.body.innerText || '').match(/Generating\s+(\d{1,3})%/);
  const percent = generating ? [generating[1] + '%'] : [];
  const main = document.querySelector('main') || document.body;
  const point = e => { if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; };
  return {
    url: location.href, path: location.pathname, postId,
    editor: !!editor, editorText: editor ? editor.innerText.replace(/\s+/g, ' ').trim() : '',
    signedOut: !editor && Array.from(document.querySelectorAll('a,button')).some(e => /^(sign in|log in|sign up)$/i.test((e.innerText || '').trim())),
    mode: mode ? label(mode).toLowerCase() : '', resolutions: res.map(b => ({t: label(b), on: checked(b)})), durations: dur.map(b => ({t: label(b), on: checked(b)})),
    aspect: aspect ? label(aspect) + ' ' + (aspect.innerText || '').trim() : '', hasAspect: !!aspect,
    attachments: removes.length, thumbs: thumbs.length, thumbsReady: thumbs.filter(i => i.complete && i.naturalWidth > 0).length, busyTray,
    submit: !!(submit && !submit.disabled && submit.getAttribute('aria-disabled') !== 'true'), submitPoint: point(submit),
    dialogText: dialog ? String(dialog.innerText || '').replace(/\s+/g, ' ').slice(0, 600) : '',
    videoSrc: myVideo && myVideo.dur > 0 ? myVideo.src : '', videoDims: myVideo ? [myVideo.w, myVideo.h, myVideo.dur] : null,
    hdVideoSrc: (videos.find(v => postId && v.src.includes(`/generated/${postId}/`) && /generated_video_hd/.test(v.src) && (v.dur > 0 || v.w > 0)) || {}).src || '',
    upscaling: /\bUpscaling\b/.test(String(document.body.innerText || '')),
    resNow: (() => { const on = res.find(checked); const txt = on ? label(on) : (buttons.find(b => /^video resolution$/i.test(b.getAttribute('aria-label') || '')) || {}).innerText; return Number(((txt || '').match(/(\d{3,4})p/i) || [])[1]) || 0; })(),
    postImage: postImg ? {src: postImg.src, w: postImg.naturalWidth, h: postImg.naturalHeight, ready: !!(postImg.complete && postImg.naturalWidth >= 256)} : null,
    cards, percent, notes: Array.isArray(window.__grokNotes) ? window.__grokNotes.slice(-12) : [], pageText: String(main.innerText || '').replace(/\s+/g, ' ').slice(0, 5000),
  };
}

// Grok shows refusals and errors as short-lived messages ("I'm sorry, I can't help with that request."). A page observer records
// every such message the moment it appears, so a toast that vanishes between two polls is not missed.
function pg_grokInstallWatcher() {
  if (window.__grokObserver) { window.__grokNotes = []; return {ok: true, reused: true}; }
  window.__grokNotes = [];
  const wanted = /sorry|can'?t help|cannot (?:help|assist|create|generate)|moderat|not allowed|violat|unable to|went wrong|failed|try again|limit|too many|blocked|rejected|polic/i;
  const note = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); if (t.length > 3 && t.length < 300 && wanted.test(t) && !window.__grokNotes.includes(t)) window.__grokNotes.push(t); };
  window.__grokObserver = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) { if (node.nodeType === 3) note(node.textContent); else if (node.nodeType === 1) note(node.innerText || node.textContent); }
      if (record.type === 'characterData') note(record.target.textContent);
    }
  });
  window.__grokObserver.observe(document.body, {childList: true, subtree: true, characterData: true});
  return {ok: true};
}
// Image mode only: "Speed" or "Quality 2.0" (role=radio). Grok hides them once a picture is attached, so this runs before attaching.
async function pg_grokSetImageQuality(want) {      // want: 'speed' | 'quality'
  const label = b => (b.getAttribute('aria-label') || b.innerText || '').trim();
  // Old layout: role=radio + aria-checked. Since 2026-11-11 Grok uses plain buttons with aria-pressed.
  const on = b => (b.getAttribute('aria-checked') || b.getAttribute('aria-pressed')) === 'true';
  const radio = Array.from(document.querySelectorAll('[role="radio"], button[aria-pressed]')).find(b => b.getBoundingClientRect().width > 0 && (want === 'quality' ? /^quality\b/i : /^speed$/i).test(label(b)));
  if (!radio) return {ok: false, error: `${want === 'quality' ? 'Quality' : 'Speed'} option not found`};
  if (!on(radio)) { radio.click(); await new Promise(r => setTimeout(r, 500)); }
  return {ok: on(radio), label: label(radio)};
}
// Image to Image with @mentions (verified live Oct 2026): typing "@" in the composer opens a menu that starts with
// "Image 1", "Image 2"... (the attached pictures, in attach order) followed by Grok's saved characters; picking one inserts a
// chip (span.node-mention > [data-mention-type="attachment"]) that shows "Image N". segments: {type:'text', text} | {type:'photo', label}.
async function pg_grokTypeWithMentions(segments) {
  const editor = document.querySelector('div.tiptap.ProseMirror');
  if (!editor) return {ok: false, error: 'Grok composer not found'};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const chips = () => editor.querySelectorAll('[data-mention-type="attachment"]').length;
  editor.focus();
  document.execCommand('selectAll', false); document.execCommand('delete', false);
  for (const segment of segments) {
    if (segment.type === 'text') { if (segment.text) document.execCommand('insertText', false, segment.text); continue; }
    const before = chips();
    // The mention menu only opens after a space or at the start of a line.
    const text = editor.innerText;      // JS \s also matches the no-break space ProseMirror leaves after a chip
    if (text.trim() && !/\s$/.test(text)) document.execCommand('insertText', false, ' ');
    document.execCommand('insertText', false, '@');
    let pick = null;
    for (let i = 0; i < 20 && !pick; i++) {
      await wait(150);
      pick = Array.from(document.querySelectorAll('button')).find(b => b.getBoundingClientRect().width > 0 && !editor.contains(b) && (b.innerText || '').trim() === segment.label);
    }
    if (!pick) return {ok: false, error: `Grok's @ menu did not offer ${segment.label}`};
    pick.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); pick.click();
    for (let i = 0; i < 20 && chips() <= before; i++) await wait(100);
    if (chips() <= before) return {ok: false, error: `Grok did not insert the ${segment.label} chip`};
    editor.focus();
  }
  await wait(400);
  return {ok: true, chips: chips(), text: editor.innerText.replace(/\s+/g, ' ').trim()};
}
async function pg_grokSetMode(want) {      // want: 'image' | 'video'
  // Old layout: role=radio + aria-checked. Since 2026-11-11 (owner: "video switch not found") Grok's "Generation mode"
  // group holds plain buttons Image / Video / Agent with aria-label and aria-pressed.
  const on = b => (b.getAttribute('aria-checked') || b.getAttribute('aria-pressed')) === 'true';
  const shown = b => b.getBoundingClientRect().width > 0;
  const named = b => (b.getAttribute('aria-label') || b.innerText || '').trim().toLowerCase() === want;
  const radio = Array.from(document.querySelectorAll('[role="radio"]')).find(b => named(b) && shown(b))
    || Array.from(document.querySelectorAll('[role="group"][aria-label="Generation mode"] button, button[aria-pressed]')).find(b => named(b) && shown(b))
    || Array.from(document.querySelectorAll('[role="radio"]')).find(named);
  if (!radio) return {ok: false, error: `${want} switch not found`};
  if (!on(radio)) { radio.click(); await new Promise(r => setTimeout(r, 700)); }
  return {ok: on(radio)};
}
async function pg_grokPickRadio(kind, wanted) {   // kind 'res' | 'dur'; wanted: number (480/720/1080 or 6/10/15)
  const re = kind === 'res' ? /^(\d{3,4})p$/i : /^(\d{1,2})s$/i;
  const shown = b => b.getBoundingClientRect().width > 0;
  const unit = kind === 'res' ? 'p' : 's';
  // Two layouts: inline role=radio buttons (free accounts) or a "Video resolution" / "Video duration" dropdown (paid accounts).
  let radios = Array.from(document.querySelectorAll('[role="radio"]')).filter(b => re.test((b.innerText || '').trim()) && shown(b));
  let opener = null;
  if (!radios.length) {
    opener = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === (kind === 'res' ? 'Video resolution' : 'Video duration') && shown(b));
    if (!opener) return {ok: false, options: []};
    opener.click(); await new Promise(r => setTimeout(r, 600));
    radios = Array.from(document.querySelectorAll('[role="menuitemradio"]')).filter(b => re.test((b.innerText || '').trim()) && shown(b));
  }
  const options = radios.map(b => ({n: Number(re.exec((b.innerText || '').trim())[1]), b}));
  if (!options.length) { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return {ok: false, options: []}; }
  let pick = options.find(o => o.n === wanted);
  if (!pick) {      // closest available (resolution: the highest not above the request, else the lowest)
    const below = options.filter(o => o.n <= wanted).sort((a, b) => b.n - a.n)[0];
    pick = kind === 'res' ? (below || options.sort((a, b) => a.n - b.n)[0]) : options.sort((a, b) => Math.abs(a.n - wanted) - Math.abs(b.n - wanted) || b.n - a.n)[0];
  }
  const optionList = options.map(o => o.n);
  if (pick.b.getAttribute('aria-checked') !== 'true') { pick.b.click(); await new Promise(r => setTimeout(r, 500)); }
  // Already chosen: click it again, which closes the menu (Grok 2026-11-11 ignores a synthetic Escape; verified live).
  else if (opener) {
    pick.b.click(); await new Promise(r => setTimeout(r, 500));
    if (opener.getAttribute('aria-expanded') === 'true') document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  }
  const nowOn = opener ? (opener.innerText || '').trim().toLowerCase() === `${pick.n}${unit}` : pick.b.getAttribute('aria-checked') === 'true';
  return {ok: nowOn, chosen: pick.n, exact: pick.n === wanted, options: optionList};
}
async function pg_grokSetAspect(ratio) {          // '9:16' | '16:9' | '1:1'
  const button = Array.from(document.querySelectorAll('button')).find(b => /^aspect ratio$/i.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0);
  if (!button) return {ok: false, error: 'no aspect ratio button'};
  if ((button.innerText || '').trim() === ratio) return {ok: true};
  button.click(); await new Promise(r => setTimeout(r, 700));
  const item = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(e => (e.innerText || '').trim().startsWith(ratio));
  if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return {ok: false, error: `${ratio} not offered`}; }
  item.click(); await new Promise(r => setTimeout(r, 600));
  return {ok: (button.innerText || '').trim() === ratio};
}
// Attaches the images in one go through the composer's own file input (no clipboard, no file dialog).
async function pg_grokAttach(files) {
  const editor = document.querySelector('div.tiptap.ProseMirror');
  const form = editor && (editor.closest('form') || editor.parentElement?.parentElement?.parentElement);
  const input = form && (Array.from(form.querySelectorAll('input[type="file"]')).find(i => i.multiple) || form.querySelector('input[type="file"]'));
  if (!input) return {ok: false, error: 'Grok upload input not found'};
  const transfer = new DataTransfer();
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, {type: file.type || 'image/png'}));
  }
  const count = transfer.files.length;
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return {ok: count > 0, count};
}
async function pg_grokClearAttachments() {
  for (let i = 0; i < 12; i++) {
    const remove = Array.from(document.querySelectorAll('button')).find(b => /^remove image$/i.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0);
    if (!remove) break;
    remove.click(); await new Promise(r => setTimeout(r, 250));
  }
  return {ok: true};
}
async function pg_grokType(text) {
  const editor = document.querySelector('div.tiptap.ProseMirror');
  if (!editor) return {ok: false, error: 'Grok composer not found'};
  editor.focus();
  document.execCommand('selectAll', false); document.execCommand('delete', false);
  document.execCommand('insertText', false, text);
  await new Promise(r => setTimeout(r, 400));
  return {ok: true, text: editor.innerText.replace(/\s+/g, ' ').trim()};
}
// Fallback only. A script .click() on Grok's Send makes Grok start TWO generations (two POST /rest/app-chat/conversations/new,
// two pictures in two conversations; verified live Oct 2026 with the request blocked); a real mouse click starts one.
function pg_grokSubmit() {
  const submit = Array.from(document.querySelectorAll('button')).find(b => /^submit$/i.test(b.getAttribute('aria-label') || '') && b.getBoundingClientRect().width > 0);
  if (!submit || submit.disabled) return {ok: false};
  submit.click(); return {ok: true};
}
async function pg_grokCloseDialog() {
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => d.getBoundingClientRect().width > 0);
  if (!dialog) return {ok: true};
  const close = Array.from(dialog.querySelectorAll('button')).find(b => /^close$/i.test(b.getAttribute('aria-label') || b.innerText || ''));
  if (close) close.click(); else document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await new Promise(r => setTimeout(r, 400));
  return {ok: true};
}
// On a finished video's post page: Upscale > "Upscale to 720p" / "Upscale to 1080p" (1080p needs the top Grok plan).
async function pg_grokUpscale(target) {
  const shown = e => e.getBoundingClientRect().width > 0;
  const find = () => Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Upscale' && shown(b));
  let button = find();
  if (!button) {      // narrow windows fold Regenerate / Extend / Upscale into a "Post actions" dialog
    const actions = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === 'Post actions' && shown(b));
    if (actions) { actions.click(); await new Promise(r => setTimeout(r, 900)); button = find(); }
  }
  if (!button) return {ok: false, error: 'no Upscale button on this page'};
  button.click(); await new Promise(r => setTimeout(r, 700));
  const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).filter(shown);
  const offered = items.map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => /^upscale to/i.test(t));
  const item = items.find(e => (e.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase() === `upscale to ${target}p`);
  if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); return {ok: false, error: `Upscale to ${target}p is not offered`, offered}; }
  item.click(); await new Promise(r => setTimeout(r, 1200));
  const paywall = Array.from(document.querySelectorAll('[role="dialog"]')).some(d => shown(d) && /upgrade|supergrok/i.test(d.innerText || ''));
  return {ok: !paywall, paywall, offered};
}
// The first result card's picture: its data: URL (returned as text) or its https asset URL.
function pg_grokFirstImage(href) {
  const cards = Array.from(document.querySelectorAll('[class*="media-post-masonry-card"]'));
  const card = href ? cards.find(c => Array.from(c.querySelectorAll('a[href*="/imagine/post/"]')).some(a => a.getAttribute('href') === href)) : cards[0];
  const img = card && card.querySelector('img');
  if (!img || !img.complete || img.naturalWidth < 256) return {ok: false};
  const a = card.querySelector('a[href*="/imagine/post/"]');
  return {ok: true, src: img.src, w: img.naturalWidth, h: img.naturalHeight, href: a ? a.getAttribute('href') : ''};
}
// On a post page: the full-size picture.
function pg_grokPostImage() {
  const img = Array.from(document.querySelectorAll('img')).find(i => /assets\.grok\.com\/.+\/generated\/.+\/image\./.test(i.src) && i.getBoundingClientRect().width > 150);
  return img ? {ok: true, src: img.src, w: img.naturalWidth, h: img.naturalHeight} : {ok: false};
}

// Image to Image: which words of the prompt become Grok "Image N" chips (N = attach order). "@char_01" is replaced by the
// chip (an @name with no picture is an error). A bare picture name like "char_01" keeps its text and gets the chip right
// after it ("char_01 [Image 1]"), on its first use only. Bare names count only when they look like file names (contain _,
// - or a digit), so a picture called "man.png" never turns the word "man" into a chip. null = nothing names a picture.
function grokMentionSegments(prompt, names) {
  const source = String(prompt || '');
  const bases = names.map(n => String(n).replace(/\.[^.]+$/, '')).filter(b => /[_\-\d]/.test(b));
  const escape = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bare = bases.sort((a, b) => b.length - a.length).map(escape).join('|');
  const ext = '(?:\\.(?:png|jpe?g|webp))?';
  const re = new RegExp(`@([\\p{L}\\p{N}_-]+)${ext}` + (bare ? `|(?<![\\p{L}\\p{N}_@-])(${bare})${ext}(?![\\p{L}\\p{N}_-])` : ''), 'giu');
  const segments = [], used = new Set();
  let offset = 0;
  for (const match of source.matchAll(re)) {
    const index = P().matchImageByName(match[1] ?? match[2], names);
    if (match[1] != null) {
      if (index == null || index < 0) throw Error(`Missing image for ${match[0]}`);
      if (match.index > offset) segments.push({type: 'text', text: source.slice(offset, match.index)});
    } else {
      if (index == null || index < 0 || used.has(index)) continue;
      segments.push({type: 'text', text: source.slice(offset, match.index + match[0].length)});
    }
    used.add(index);
    segments.push({type: 'photo', label: `Image ${index + 1}`});
    offset = match.index + match[0].length;
  }
  if (!used.size) return null;
  if (offset < source.length) segments.push({type: 'text', text: source.slice(offset)});
  return segments;
}
function grokPromptText(item) { return String(item.generationText || item.text || '').trim(); }
function grokDataUrlToBuffer(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
const GROK_RATIOS = {portrait: '9:16', landscape: '16:9', square: '1:1'};

// Waits until `want` images are attached, loaded, show no progress and stay that way for stableMs.
async function grokWaitForAttachments(tabId, item, want, stableMs, timeoutMs, token, label) {
  let since = null, state = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertRunActive(token);
    state = await exec(tabId, pg_grokState, [], 'MAIN');
    if (state.attachments > want) throw Error(`Grok image attachment failed: ${state.attachments} attachments for ${want} image(s) (duplicate upload)`);
    const ready = state.attachments === want && state.thumbsReady === want && !state.busyTray;
    if (ready) { since = since ?? Date.now(); if (Date.now() - since >= stableMs) return state; } else since = null;
    item.detail = ready ? `${label} (${Math.floor((Date.now() - since) / 1000)}/${Math.round(stableMs / 1000)}s stable)`
      : `uploading ${want === 1 ? 'image' : 'images'} (${state.thumbsReady}/${want} ready)`;
    renderQueue();
    await sleep(500);
  }
  throw Error(`Grok image attachment failed: ${state?.thumbsReady || 0}/${want} ready, ${state?.attachments || 0} attachment(s)`);
}

// Options a free Grok account cannot select (they open the upgrade dialog): remembered for the run so each prompt does not retry them.
let grokPaywall = {};
// Send with a trusted mouse click through the debugger (like ChatGPT and Gemini). The point is read after attaching,
// because the "is debugging this browser" bar can move the page.
async function grokTrustedSubmit(tabId) {
  if (typeof flowCdpClick !== 'function' || !chrome.debugger) return exec(tabId, pg_grokSubmit, [], 'MAIN');
  const target = {tabId}; let attached = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); attached = true; }
    catch (error) { if (!/another debugger|already attached/i.test(String(error?.message || error))) throw error; }
    if (attached) await sleep(800);
    const s = await exec(tabId, pg_grokState, [], 'MAIN');
    if (!s.submit || !s.submitPoint) return {ok: false};
    await flowCdpClick(tabId, s.submitPoint.x, s.submitPoint.y, true);
    return {ok: true, trusted: true};
  } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
}
async function runGrokPrompt(item, slot, token) {
  if (grokPaywall.token !== token) grokPaywall = {token};
  item.platform = 'grok';
  item.attempts = (item.attempts || 0) + 1; item.retryAt = null;
  const video = grokIsVideoMode(), kind = video ? 'video' : 'image';
  item.status = 'running'; item.progressPercent = null; item.detail = 'opening Grok Imagine'; renderQueue();
  let tab = null;
  try {
    assertRunActive(token);
    // Save-only retries belong to the exact prompt/mode that produced this result.
    const cached = item.grokResult;
    if (cached && ((cached.prompt !== undefined && cached.prompt !== grokPromptText(item)) || (cached.mode !== undefined && cached.mode !== settings.mode))) {
      delete item.grokResult;
      log(`${item.id}: prompt or mode changed; previous grok result will not be reused.`);
    }
    if (!await ensureGrokAccess()) throw Error('Grok setup failed: allow Grok access (Chrome asks once when you pick Grok as the platform), then press Retry.');
    tab = await getGrokTab(slot);
    if (!item.grokResult) {
      // A fresh Imagine page per prompt keeps each result bound to its own prompt.
      const background = typeof confirmBackgroundTab === 'function' && await confirmBackgroundTab(tab.id);
      await chrome.tabs.update(tab.id, {url: GROK_URL, ...(settings.openTabWhileGenerating && !background ? {active: true} : {})});
      await waitForTabComplete(tab.id); await sleep(2500); assertRunActive(token); await zoomGrokTab(tab.id);
      let state = await exec(tab.id, pg_grokState, [], 'MAIN');
      for (let i = 0; i < 6 && !state.editor && !state.signedOut; i++) { await sleep(1000); state = await exec(tab.id, pg_grokState, [], 'MAIN'); }
      if (state.signedOut) throw Error('Grok setup failed: sign in to Grok in this browser, then press Retry.');
      if (!state.editor) throw Error('Grok setup failed: the Imagine composer did not load. Sign in to Grok in this browser, then retry.');
      if (state.dialogText) { if (grokLimitText(state.dialogText) || /upgrade|supergrok/i.test(state.dialogText)) await exec(tab.id, pg_grokCloseDialog, [], 'MAIN'); }
      // Mode, then (video) resolution and duration, then aspect ratio, then images.
      item.detail = `setting Grok ${kind} options`; renderQueue();
      const modeSet = await exec(tab.id, pg_grokSetMode, [kind], 'MAIN');
      if (!modeSet?.ok) throw Error(`Grok setup failed: could not switch to ${kind} mode (${modeSet?.error || 'not selected'})`);
      if ((await exec(tab.id, pg_grokState, [], 'MAIN')).attachments) await exec(tab.id, pg_grokClearAttachments, [], 'MAIN');
      if (!video) {      // Speed is the default; Quality 2.0 is a setting
        const want = settings.grokImageQuality === 'quality' ? 'quality' : 'speed';
        const q = await exec(tab.id, pg_grokSetImageQuality, [want], 'MAIN');
        if (!q?.ok) log(`${item.id}: Grok ${want === 'quality' ? 'Quality 2.0' : 'Speed'} could not be selected (${q?.error || 'not applied'}); using Grok's current setting.`);
      }
      if (video) {
        const wantRes = {'480p': 480, '720p': 720, '1080p': 1080, '2k': 1080, '4k': 1080}[String(settings.videoGenerationResolution)] || 0;
        if (wantRes && !grokPaywall.res) {
          const r = await exec(tab.id, pg_grokPickRadio, ['res', wantRes], 'MAIN');
          // A premium choice on a free account opens Grok's upgrade dialog and is not selected: close it and keep going.
          if (r && !r.ok) { grokPaywall.res = true; await exec(tab.id, pg_grokCloseDialog, [], 'MAIN'); log(`${item.id}: Grok ${r.chosen}p is not available on this account (it needs a paid Grok plan); keeping Grok's current resolution.`); }
          else if (r?.ok && !r.exact) log(`${item.id}: Grok offers ${r.options.map(n => n + 'p').join('/')} on this account; using ${r.chosen}p.`);
        }
        const d = grokPaywall.dur ? null : await exec(tab.id, pg_grokPickRadio, ['dur', Number(item.generationDuration) || Number.parseInt(item.videoMode,10) || Number(settings.flowDurationSeconds) || 6], 'MAIN');
        if(item.builderProjectId&&(!d?.ok||!d.exact||Number(d.chosen)!==Number(item.builderDurationSeconds||settings.flowDurationSeconds)))throw Error('Grok cannot use this Builder scene duration on the current account. Choose Flow or Gemini, or enable the matching Grok duration before retrying.');
        if (d && !d.ok) { grokPaywall.dur = true; await exec(tab.id, pg_grokCloseDialog, [], 'MAIN'); log(`${item.id}: Grok ${d.chosen}s is not available on this account (it needs a paid Grok plan); keeping Grok's current duration.`); }
        else if (d?.ok && !d.exact) log(`${item.id}: Grok offers ${d.options.map(n => n + 's').join('/')} on this account; using ${d.chosen}s.`);
      }
      const ratio = GROK_RATIOS[settings.aspectRatio] || '9:16';
      const references = settings.mode === 'frame-to-video' ? imagesForItem(item).slice(0, 1) : settings.mode === 'ingredients-to-video' || settings.mode === 'image-to-image' ? imagesForItem(item) : [];
      // AI Story loads a whole image batch in Image to Image when it has character pictures; a scene with no people in it
      // has no references and is sent as a plain text-to-image prompt (owner 2026-11-01). Manual queues still need one.
      if (settings.mode === 'image-to-image' && !references.length && !item.builderProjectId) throw Error('Grok Image to Image needs at least 1 reference image assigned to this prompt; not sent');
      const prompt = grokPromptText(item);
      // Image to Image and Ingredients to Video: picture names in the prompt ("@char_01" or plain "char_01") become Grok's
      // own "Image N" chips (the @ menu works the same in Video mode; verified live Oct 2026).
      let mentionSegments = null;
      if (references.length && (settings.mode === 'image-to-image' || settings.mode === 'ingredients-to-video')) {
        const modeName = settings.mode === 'image-to-image' ? 'Image to Image' : 'Ingredients to Video';
        try { mentionSegments = grokMentionSegments(prompt, references.map(image => image.name)); }
        catch (error) { throw Error(`Grok ${modeName}: ${error.message} (no attached picture has that name); not sent`); }
      }
      if (!references.length) {
        const a = await exec(tab.id, pg_grokSetAspect, [ratio], 'MAIN');
        if (!a?.ok) throw Error(`Grok setup failed: aspect ratio ${ratio} could not be set (${a?.error || 'not applied'})`);
      }
      const stableMs = Math.max(3000, (settings.uploadSettleSeconds || 3) * 1000);
      let wantImages = 0;
      if (references.length) {
        if (settings.mode === 'frame-to-video' && !references.length) throw Error('Grok frame attachment failed: no start image assigned to this prompt');
        if (settings.mode === 'ingredients-to-video' && references.length < 2) throw Error('Grok needs at least 2 reference images for Ingredients to Video (one image is a start frame: use Frame to Video).');
        const files = references.map(image => { const {b64, type} = dataUrlToB64(image.dataUrl); return {name: image.name, base64: b64, type}; });
        item.detail = `uploading ${files.length} image(s): ${files.map(f => f.name).join(', ')}`; renderQueue();
        const pasted = await exec(tab.id, pg_grokAttach, [files], 'MAIN');
        if (!pasted?.ok) throw Error(`Grok image attachment failed: ${pasted?.error || 'upload not accepted'}`);
        wantImages = files.length;
        await grokWaitForAttachments(tab.id, item, wantImages, stableMs, 180000, token, wantImages === 1 ? 'verifying start image' : 'verifying reference images');
        log(`${item.id}: Grok ${wantImages} image(s) uploaded and stable: ${files.map(f => f.name).join(', ')}.`);
        if (wantImages >= 2 || settings.mode === 'image-to-image') {      // references / image edit: the aspect ratio button is there; set it now
          const a = await exec(tab.id, pg_grokSetAspect, [ratio], 'MAIN');
          if (!a?.ok) log(`${item.id}: Grok aspect ratio ${ratio} could not be confirmed (${a?.error || 'not applied'}); using Grok's current setting.`);
        }
      }
      item.detail = 'typing the prompt into Grok'; renderQueue();
      // What the composer shows: the prompt, with each @mention shown as its chip label ("Image 1").
      const shownPrompt = mentionSegments ? mentionSegments.map(s => s.type === 'photo' ? ` ${s.label} ` : s.text).join('') : prompt;
      const typed = await exec(tab.id, mentionSegments ? pg_grokTypeWithMentions : pg_grokType, [mentionSegments || prompt], 'MAIN');
      const compact = s => String(s || '').replace(/\s+/g, '').toLowerCase();
      if (mentionSegments && !typed?.ok) throw Error(`Grok prompt could not be entered: ${typed?.error || 'mention not inserted'}; not sent`);
      if (mentionSegments && typed.chips !== mentionSegments.filter(s => s.type === 'photo').length) throw Error(`Grok prompt could not be entered: ${typed.chips} image chip(s) for ${mentionSegments.filter(s => s.type === 'photo').length} mention(s); not sent`);
      if (!typed?.ok || !compact(typed.text).includes(compact(shownPrompt).slice(0, 200))) throw Error('Grok prompt could not be entered (composer text does not match); not sent');
      if (mentionSegments) log(`${item.id}: Grok mentions inserted as ${mentionSegments.filter(s => s.type === 'photo').map(s => s.label).join(', ')}.`);
      // Barrier right before Send: images still attached and stable, prompt intact, Send enabled.
      if (wantImages) await grokWaitForAttachments(tab.id, item, wantImages, 3000, 120000, token, 'final image check');
      state = await exec(tab.id, pg_grokState, [], 'MAIN');
      if (!compact(state.editorText).includes(compact(shownPrompt).slice(0, 200))) throw Error('Grok prompt was cleared before sending; not sent');
      if (!state.submit) throw Error('Grok Send is not ready; not sent');
      const genResNow = state.resNow || 0;      // the resolution Grok is set to right now (the post page does not show it later)
      await exec(tab.id, pg_grokInstallWatcher, [], 'MAIN');
      const submitted = await grokTrustedSubmit(tab.id);
      if (!submitted?.ok) throw Error('Grok Send could not be clicked; not sent');
      // Confirm Grok took the prompt: a video opens its post page, and the composer empties. A missed click is tried once
      // more; if it still was not taken, fail fast instead of waiting the whole generation time.
      const head = compact(shownPrompt).slice(0, 60);
      const taken = s => !!s.postId || !compact(s.editorText).includes(head);
      for (let round = 0; round < 2; round++) {
        let ok = false;
        for (const waitStart = Date.now(); Date.now() - waitStart < 15000;) {
          await sleep(1500); assertRunActive(token);
          state = await exec(tab.id, pg_grokState, [], 'MAIN');
          if (taken(state)) { ok = true; break; }
        }
        if (ok) break;
        if (round === 1) throw Error('Grok did not accept the Send click (the prompt is still in the box); not sent');
        log(`${item.id}: Grok did not take the prompt yet; clicking Send again.`);
        await grokTrustedSubmit(tab.id);
      }
      log(`${item.id}: Grok ${kind} request submitted.`);
      let upsellClosed = false;
      const started = Date.now(); let stableSince = 0, lastKey = '', answerSince = 0, lastAnswer = '';
      while (Date.now() - started < settings.maxWaitMinutes * 60000) {
        await sleep(2500); assertRunActive(token); await zoomGrokTab(tab.id);
        state = await exec(tab.id, pg_grokState, [], 'MAIN');
        const elapsed = Math.round((Date.now() - started) / 1000);
        // This prompt's results: a video's post page, or the prompt shown as the results heading (not merely still in the composer).
        const mine = !!state.postId || (compact(state.pageText).includes(head) && !compact(state.editorText).includes(head));
        // Messages Grok shows (not the prompt itself, which also appears on the page).
        const promptCompact = compact(shownPrompt);
        // Drop notes that are part of the prompt, and notes that contain the prompt (the results heading echoes it), so a
        // prompt mentioning e.g. "sorry" or "blocked" is never read as a refusal.
        const resultText = (state.notes || []).filter(n => !promptCompact.includes(compact(n)) && !compact(n).includes(head)).join(' ');
        // A dialog that says the limit is reached, with no result yet, pauses the queue. A plain upgrade advert (free
        // accounts see one now and then) is only closed; it does not stop anything.
        if (state.dialogText) {
          if (grokLimitText(state.dialogText) && !(video ? state.videoSrc : state.cards.some(c => c.ready))) {
            await exec(tab.id, pg_grokCloseDialog, [], 'MAIN');
            throw Object.assign(Error(`Grok ${kind} limit reached: ${state.dialogText.slice(0, 160)}`), {grokLimit: true});
          }
          if (/upgrade|supergrok/i.test(state.dialogText)) {
            await exec(tab.id, pg_grokCloseDialog, [], 'MAIN');
            if (!upsellClosed) { upsellClosed = true; log(`${item.id}: closed a Grok upgrade dialog while waiting (not a limit message).`); }
          }
        }
        if (video && state.videoSrc && !state.percent.length) {
          if (lastKey !== state.videoSrc) { lastKey = state.videoSrc; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 2500) { item.grokResult = {kind, url: state.url.split('?')[0], src: state.videoSrc, postId: state.postId}; break; }
        } else if (!video && state.postId && state.postImage?.ready) {
          // Image to Image (verified live Oct 2026): Grok opens /imagine/post/<id> of the edited picture. The id can change once while it
          // settles, so the picture is saved when the same full-size result has stayed for 3 seconds.
          const key = state.postImage.src;
          if (lastKey !== key) { lastKey = key; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 3000) {
            item.grokResult = {kind, image: true, src: state.postImage.src, dataUrl: '', postHref: `/imagine/post/${state.postId}`, size: `${state.postImage.w}x${state.postImage.h}`, count: 1};
            break;
          }
        } else if (!video && mine && state.path === '/imagine' && state.cards.length && state.cards[0].ready) {
          // Grok shows noise placeholders (144 px wide) and then the real pictures (720 px+); the first card is saved once it is real and steady.
          const key = `${state.cards[0].href}|${state.cards[0].w}`;
          if (lastKey !== key) { lastKey = key; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 3000) {
            // Read the same card that was checked above (by its post link), not whatever card is first by now.
            const first = await exec(tab.id, pg_grokFirstImage, [state.cards[0].href || ''], 'MAIN');
            if (!first?.ok) { lastKey = ''; stableSince = 0; continue; }
            item.grokResult = {kind, image: true, src: first.src.startsWith('data:') ? '' : first.src, dataUrl: first.src.startsWith('data:') ? first.src : '', postHref: first.href, size: `${first.w}x${first.h}`, count: state.cards.length};
            break;
          }
        } else { lastKey = ''; stableSince = 0; }
        if (!video && mine && state.cards.length && !state.cards.some(c => c.ready) && Date.now() - started > 150000)
          throw Error('Grok policy rejection: Grok never produced a picture for this prompt (only blank placeholders after 2.5 minutes); it is probably moderated.');
        if (mine) {
          const answerKind = grokAnswerKind(resultText.slice(-1500));
          if (answerKind === 'limit' && !(video ? state.videoSrc : state.cards.length)) throw Object.assign(Error(`Grok ${kind} limit reached: ${resultText.slice(-200)}`), {grokLimit: true});
          if (answerKind === 'refused') throw Error(`Grok policy rejection: ${resultText.slice(-300)}`);
          if (answerKind === 'failed') throw Error(`Grok generation failed: ${resultText.slice(-200)}`);
        }
        item.progressPercent = state.percent.length ? Math.min(95, Number(state.percent[0].replace('%', '')) || null) : item.progressPercent;
        item.detail = `generating ${kind} in Grok (${Math.floor(elapsed / 60)}m ${elapsed % 60}s)${state.percent.length ? ` ${state.percent[0]}` : ''}`; renderQueue();
      }
      if (!item.grokResult) throw Error(`Timed out waiting for the Grok ${kind}`);
      item.grokResult.prompt = grokPromptText(item); item.grokResult.mode = settings.mode;
      if (video) {
        const dims = (state.videoDims || []).slice(0, 2).filter(Boolean);
        const short = dims.length ? Math.min(...dims) : 0;      // Math.min() of nothing is Infinity
        item.grokResult.genRes = genResNow || (short ? (short <= 480 ? 480 : short <= 760 ? 720 : 1080) : 0);
      }
      log(`${item.id}: Grok ${kind} ready${item.grokResult.count > 1 ? ` (${item.grokResult.count} images; saving the first)` : ''}.`);
    }
    // --- upscale first when the download quality is higher than the generated one ("480p (Upscale)"), then save ---
    const result = item.grokResult;
    // Auto download off (Settings → Output): the result stays in Grok (no upscale either).
    if (typeof autoDownloadOff === 'function' && autoDownloadOff(result.image ? 'image' : 'video', item)) {
      finishWithoutDownload(item, 'Grok', result.image ? 'image' : 'video'); return;
    }
    const wantDownload = {'720p': 720, '1080p': 1080, '2k': 1080, '4k': 1080}[String(settings.videoResolution)] || 0;
    if (!result.image && wantDownload && !result.upscaled && !result.genRes) log(`${item.id}: Grok upscale to ${wantDownload}p skipped: the generated resolution could not be read; saving the video as generated.`);
    if (!result.image && wantDownload && !result.upscaled && result.genRes && wantDownload > result.genRes) {
      item.detail = `upscaling the Grok video to ${wantDownload}p`; renderQueue();
      const page = await chrome.tabs.get(tab.id);
      if (!String(page.url).includes(result.postId || '#')) { await chrome.tabs.update(tab.id, {url: result.url}); await waitForTabComplete(tab.id); await sleep(3000); }
      await zoomGrokTab(tab.id);
      let up = null;
      for (let attempt = 0; attempt < 6; attempt++) {      // the action buttons can appear a moment after the video
        up = await exec(tab.id, pg_grokUpscale, [wantDownload], 'MAIN');
        if (up?.ok || !/no Upscale button/.test(up?.error || '')) break;
        await sleep(3000); assertRunActive(token);
      }
      if (!up?.ok) {
        await exec(tab.id, pg_grokCloseDialog, [], 'MAIN');
        log(`${item.id}: Grok upscale to ${wantDownload}p is not available (${up?.paywall ? 'it needs a higher Grok plan' : up?.error || 'not offered'}); saving the ${result.genRes}p video instead.`);
        result.upscaled = 'skipped';
      } else {
        const upStarted = Date.now(); let hd = '';
        while (Date.now() - upStarted < 5 * 60000) {
          await sleep(3000); assertRunActive(token);
          const s2 = await exec(tab.id, pg_grokState, [], 'MAIN');
          if (s2.hdVideoSrc && !s2.upscaling) { hd = s2.hdVideoSrc; break; }
          item.detail = `upscaling the Grok video to ${wantDownload}p (${Math.round((Date.now() - upStarted) / 1000)}s)`; renderQueue();
        }
        if (hd) { result.src = hd; result.upscaled = wantDownload; log(`${item.id}: Grok video upscaled to ${wantDownload}p.`); }
        else { log(`${item.id}: Grok upscale did not finish in 5 minutes; saving the ${result.genRes}p video instead.`); result.upscaled = 'skipped'; }
      }
    }
    // --- save (a stored result is downloaded again on Retry instead of regenerating) ---
    item.detail = `saving the Grok ${kind}`; renderQueue();
    let src = result.src;
    if (result.image && !src && !result.dataUrl) {      // Retry: open the post and read the full-size picture
      await chrome.tabs.update(tab.id, {url: `https://grok.com${result.postHref}`}); await waitForTabComplete(tab.id); await sleep(2500);
      const full = await exec(tab.id, pg_grokPostImage, [], 'MAIN');
      if (!full?.ok) throw Error('Grok download failed: the image is not on the post page. It is kept in your Grok library.');
      src = full.src;
    }
    let saved;
    if (result.image) {
      const buf = result.dataUrl ? grokDataUrlToBuffer(result.dataUrl) : await downloadMediaBuffer(tab.id, {src, host: 'Grok'}, item.id);
      if (!P().bufferHasImageSignature(buf)) throw Error('Grok download failed: the data is not an image');
      saved = await saveOutput(item, buf, guessImageExt(buf, src || result.dataUrl), typeof platformFileName === 'function' ? platformFileName(src) : '');
      result.dataUrl = '';      // do not keep megabytes in the queue state
    } else {
      const buf = await downloadMediaBuffer(tab.id, {src, host: 'Grok'}, item.id);
      if (buf.byteLength < 100 * 1024 || !P().bufferHasMp4Signature(buf)) throw Error('Grok download failed: the data is not an MP4 video');
      saved = await saveOutput(item, buf, 'mp4', typeof platformFileName === 'function' ? platformFileName(src) : '');
    }
    item.status = 'done'; item.outputName = saved.name; item.progressPercent = 100;
    item.detail = `saved ${saved.name} → ${saved.where}`;
    if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);
    log(`${item.id}: done - ${item.detail}`);
  } catch (e) {
    const errorText = String(e?.message || e);
    if (stopRequested || token !== runToken || /cancelled by user/i.test(errorText)) {
      item.status = 'pending'; item.retryAt = null; item.detail = 'cancelled - ready to resume';
    } else if (e.grokLimit) {
      stopRequested = true; queueStopReason = `Grok ${kind} limit reached`;
      item.status = 'pending'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: ${errorText}. Queue paused; resume when the limit resets.`);
    } else if (/^Grok policy rejection/.test(errorText) && running && typeof repairFailedPrompt === 'function' && await repairFailedPrompt(item, errorText, token)) {
      if (typeof flashQueueRejection === 'function') flashQueueRejection();
    } else if (/^Grok policy rejection/.test(errorText)) {
      item.status = 'error'; item.retryAt = null; item.detail = `Needs prompt edit: ${errorText}`;
      log(`${item.id}: ${errorText}. Not resent unchanged.`);
    } else if (running && !/^Grok download failed|^Grok setup failed: (?:sign in|allow Grok)/.test(errorText) && (item.technicalFailures = (item.technicalFailures || 0) + 1) < settings.maxAttempts) {
      item.status = 'pending'; item.retryAt = Date.now() + settings.retryDelaySeconds * 1000;
      item.detail = `retry ${item.technicalFailures + 1}/${settings.maxAttempts} scheduled — ${errorText.slice(0, 120)}`;
      log(`${item.id}: Grok attempt failed (${item.technicalFailures}/${settings.maxAttempts}): ${errorText}`);
    } else {
      item.status = 'error'; item.retryAt = null; item.detail = errorText;
      log(`${item.id}: Grok ${errorText}`);
    }
  } finally {
    renderQueue(); schedulePersist();
  }
}
