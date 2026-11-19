// Higgsfield engine (owner 2026-11-09). Original 0xFlow code, written from the live higgsfield.ai pages (see
// ../0xflow-higgsfield-lab/README.md); no code or private config from other extensions.
// Text/Image to Image (/ai/image) and Text/Frame/Ingredients to Video (/ai/video); photos go in as References. Real debugger clicks and keys; the prompt is typed with
// Input.insertText. Each request is tied to the new card id (data-asset-id) that appears after Generate, and the id is
// saved before anything is downloaded: Retry waits for that card again and never sends the prompt twice.
const HIGGS_ORIGINS = ['https://higgsfield.ai/*', 'https://*.higgsfield.ai/*'];
const HIGGS_JOB_STORE = 'oxHiggsfieldPendingV1';
const HIGGS_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
const HIGGS_RATIOS = {portrait: '9:16', landscape: '16:9', square: '1:1'};
function isHiggsTab(tab) { try { const u = new URL(tab?.url || ''); return u.protocol === 'https:' && (u.hostname === 'higgsfield.ai' || u.hostname.endsWith('.higgsfield.ai')); } catch { return false; } }
async function ensureHiggsAccess() { if (await chrome.permissions.contains({origins: HIGGS_ORIGINS})) return true; return chrome.permissions.request({origins: HIGGS_ORIGINS}); }
// The page for a mode; a model slug from Settings goes in the address (?model=seedance_2_5_draft), otherwise the
// model already chosen on the page is kept.
function higgsPageUrl(mode, s = settings) {
  const video = /video/.test(mode), slug = String((video ? s.higgsVideoModel : s.higgsImageModel) || '').trim();
  return 'https://higgsfield.ai/ai/' + (video ? 'video' : 'image') + (/^[a-z0-9_.-]{2,60}$/.test(slug) ? '?model=' + slug : '');
}
// Length for one video: an AI Story scene's own length first, then the Higgsfield setting; 0 keeps the page's length.
function higgsSeconds(item, s = settings) { const n = Math.round(Number(item?.builderSceneId ? item.builderDurationSeconds : 0) || Number(s?.higgsDuration) || 0); return n >= 1 && n <= 30 ? n : 0; }
function higgsOnPage(url, mode) { try { const u = new URL(url); return isHiggsTab({url}) && u.pathname.replace(/\/+$/, '') === '/ai/' + (/video/.test(mode) ? 'video' : 'image'); } catch { return false; } }
// "Generate 80", "Generate draft 15", image "GENERATE 8.5 6.5" (full price, then the discounted one that is charged).
function higgsCost(text) { const n = String(text || '').match(/\d+(?:\.\d+)?/g); return n ? Number(n[n.length - 1]) : null; }
// Full-size original from a card: the video src, or the original file inside the image proxy (?url=…&w=640).
function higgsMediaUrl(src) {
  try { const u = new URL(src); const inner = u.searchParams.get('url'); if (inner && /^https:\/\//.test(inner)) return inner; } catch {}
  return /^https:\/\//.test(src || '') ? src : '';
}
async function getHiggsTab(slot, mode) {
  const known = slotTabs.get(slot); let tab = known != null ? await chrome.tabs.get(known).catch(() => null) : null;
  if (!isHiggsTab(tab) && !isHiggsTab({url: tab?.pendingUrl})) {
    const [active] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    const tabs = isHiggsTab(active) ? [active] : (await chrome.tabs.query({url: HIGGS_ORIGINS})).filter(isHiggsTab).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    tab = tabs[0] || await chrome.tabs.create({url: higgsPageUrl(mode), active: settings.openTabWhileGenerating !== false});
  }
  slotTabs.set(slot, tab.id);
  return tab;
}
// Picking Higgsfield or one of its modes opens the matching page (video or image) right away, always in the same tab.
async function higgsOpenPage(mode = settings.mode) {
  if (settings.platform !== 'higgsfield' || !HIGGS_MODES.includes(mode) || !await chrome.permissions.contains({origins: HIGGS_ORIGINS})) return;
  let tab = await getHiggsTab(0, mode), slug = /video/.test(mode) ? settings.higgsVideoModel : settings.higgsImageModel;
  if (!higgsOnPage(tab.url || tab.pendingUrl, mode) || (slug && !new URL(tab.url || tab.pendingUrl).search.includes('model=' + slug))) tab = await chrome.tabs.update(tab.id, {url: higgsPageUrl(mode), active: true});
  else if (!tab.active) await chrome.tabs.update(tab.id, {active: true});
}
// Self-contained page function: reads the composer and the result cards; it never clicks.
function pg_higgs(action, options = {}) {
  const visible = e => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const point = e => { if (!visible(e)) return null; e.scrollIntoView({block: 'center', inline: 'center'}); const r = e.getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; };
  const compact = s => String(s || '').replace(/\s+/g, ' ').trim();
  if (action === 'assets') {
    const out = new Map();
    for (const e of document.querySelectorAll('[data-asset-id]')) {
      const id = e.getAttribute('data-asset-id'); if (!id) continue;
      const v = e.querySelector('video'), img = [...e.querySelectorAll('img')].find(i => /cloudfront|higgs\.ai\/\?|cdn\.higgsfield/.test(i.currentSrc || i.src));
      const status = e.getAttribute('data-job-status') || e.getAttribute('data-asset-status') || '';
      const prev = out.get(id), row = {id, status, kind: e.getAttribute('data-tour-asset-kind') || (v ? 'video' : img ? 'image' : ''), video: v ? (v.currentSrc || v.src || v.getAttribute('src') || '') : '', image: img ? (img.currentSrc || img.src) : '',
        failed: /fail|error|cancel|reject|ip_detected|nsfw|moderat|block|violat/i.test(status) || /credits refunded|failed|rejected due to/i.test(compact(e.innerText).slice(0, 200)), text: compact(e.innerText).slice(0, 160)};
      if (!prev || (!prev.video && row.video) || (!prev.image && row.image) || (prev.status !== 'completed' && row.status === 'completed')) out.set(id, prev ? {...prev, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v))} : row);
    }
    return {ok: true, assets: [...out.values()]};
  }
  if (action === 'menu-item') {
    const menu = [...document.querySelectorAll('[role="menu"]')].filter(visible).pop();
    const item = menu && [...menu.querySelectorAll('[role^="menuitem"]')].find(i => compact(i.innerText) === options.value);
    if (!item) return {ok: false, error: 'option ' + options.value + ' not offered'};
    return {ok: true, checked: item.getAttribute('aria-checked') === 'true', ...point(item)};
  }
  if (action === 'slider') {
    const s = [...document.querySelectorAll('[role="slider"]')].find(visible);
    if (!s) return {ok: false, error: 'duration slider not found'};
    return {ok: true, now: Number(s.getAttribute('aria-valuenow')), min: Number(s.getAttribute('aria-valuemin')), max: Number(s.getAttribute('aria-valuemax')), focused: s === document.activeElement, ...point(s)};
  }
  // Photo picker (owner check 2026-11-09). Video page: section[data-assets-picker-frame], an "Upload file" tile and cards
  // img[data-loaded-media-id]. Image page: [data-assets-picker-v2], button "Upload media" and cards
  // [data-assets-picker-selectable-card][aria-label=<id>][aria-pressed]. An upload is NOT selected by itself.
  if (action === 'picker') {
    const v2 = [...document.querySelectorAll('[data-assets-picker-v2]')].find(visible), v1 = [...document.querySelectorAll('section[data-assets-picker-frame]')].find(visible);
    const root = options.video ? v1 : v2 || v1;
    if (!root) return {ok: true, open: false};
    const scope = root.closest('[data-assets-picker-v2]') || root.parentElement?.parentElement || document;
    let tile = [...scope.querySelectorAll('button[aria-label="Upload media"]')].find(visible);
    if (!tile) { tile = [...scope.querySelectorAll('div')].filter(e => compact(e.innerText) === 'Upload file' && visible(e)).pop(); while (tile && tile.getBoundingClientRect().width < 60) tile = tile.parentElement; }
    const ids = v2 && !options.video ? [...v2.querySelectorAll('[data-assets-picker-selectable-card][aria-label]')].map(c => ({id: c.getAttribute('aria-label'), selected: c.getAttribute('aria-pressed') === 'true'}))
      : [...scope.querySelectorAll('[data-assets-picker-media-card]')].map(c => ({id: c.querySelector('img[data-loaded-media-id]')?.getAttribute('data-loaded-media-id') || (c.querySelector('button[aria-label^="Select "]')?.getAttribute('aria-label') || '').slice(7), selected: false})).filter(x => x.id);
    const close = [...document.querySelectorAll('button[aria-label="Close assets picker"]')].find(visible);
    return {ok: true, open: true, ids, uploading: /Uploading/i.test(scope.innerText || ''), uploadPoint: point(tile), closePoint: point(close)};
  }
  if (action === 'pick-point') {
    const card = [...document.querySelectorAll('[data-assets-picker-selectable-card]')].find(c => c.getAttribute('aria-label') === options.id && visible(c))
      || [...document.querySelectorAll('[data-assets-picker-media-card]')].find(c => c.querySelector(`img[data-loaded-media-id="${CSS.escape(options.id)}"],button[aria-label="Select ${CSS.escape(options.id)}"]`));
    if (!card) return {ok: false, error: 'uploaded photo not found in the picker'};
    return {ok: true, ...point(card)};
  }
  const form = options.video ? document.querySelector('form[data-tour-anchor="tour-video-form"]') : document.querySelector('form#image-form') || document.querySelector('form[data-slot="composer-root"]');
  if (!form) return {ok: false, error: 'Higgsfield composer not found. Sign in and open the ' + (options.video ? 'Video' : 'Image') + ' page.'};
  const box = form.querySelector('[role="textbox"][contenteditable="true"]'), submit = form.querySelector('button[type="submit"]');
  const button = label => [...form.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label').toLowerCase() === label.toLowerCase());
  if (action === 'state') {
    const ratio = button('Ratio') || button('Aspect ratio');
    return {ok: !!box && !!submit, error: !box ? 'Higgsfield prompt box not found.' : !submit ? 'Higgsfield Generate button not found.' : '',
      text: compact(box?.innerText), focused: !!box && (box === document.activeElement || box.contains(document.activeElement)),
      submitText: compact(submit?.innerText), submitDisabled: !!submit?.disabled || submit?.getAttribute('aria-disabled') === 'true', busy: submit?.getAttribute('aria-busy') === 'true',
      ratio: compact(ratio?.innerText).replace(/^aspect ratio\s*/i, ''), model: compact(form.querySelector('[data-model-select-trigger]')?.innerText).replace(/^model\s*/i, ''),
      boxPoint: point(box), submitPoint: point(submit), ratioPoint: point(ratio), durationPoint: point(button('Duration'))};
  }
  // Photos already attached to the composer, with a point to remove the first one and the button that opens the picker.
  if (action === 'refs') {
    const area = options.video ? document.querySelector('[data-tour-anchor="tour-video-reference"]') : form;
    const tiles = options.video ? [...(area?.querySelectorAll('[data-slot="composer-media-field"] figure') || [])] : [...form.querySelectorAll('[data-slot="composer-media-tile"]')];
    const ids = tiles.map(t => ((t.querySelector('img')?.src || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [''])[0]);
    const remove = [...(area || form).querySelectorAll('button[aria-label="Remove media"],button[aria-label="Remove attachment"]')].find(visible);
    const add = options.video ? [...(area || form).querySelectorAll('button[aria-label="Add references"],button[aria-label="Add media"]')].find(visible) : button('References');
    const ready = options.video ? tiles.every(t => t.querySelector('img')?.complete) : tiles.every(t => t.getAttribute('data-status') === 'ready');
    return {ok: true, count: tiles.length, ids, ready, removePoint: point(remove), addPoint: point(add)};
  }
  return {ok: false, error: 'Unknown Higgsfield action'};
}
// Uploads the photos through Higgsfield's own picker: real click on the upload tile, Chrome's file window answered by the
// debugger with temporary copies (the same path as Flow's real upload), then each new photo is selected with a real click.
async function higgsAttach(tabId, send, files, video, token, itemId) {
  const refs = () => exec(tabId, pg_higgs, ['refs', {video}], 'MAIN');
  for (let i = 0; i < 12; i++) { const r = await refs(); if (!r?.count) break; if (!r.removePoint) throw Error('Higgsfield already has photos attached and they could not be removed; nothing was sent.'); await flowCdpMouseMove(tabId, r.removePoint.x, r.removePoint.y, true); await flowCdpClick(tabId, r.removePoint.x, r.removePoint.y, true); await sleep(500); }
  let r = await refs(); if (r?.count) throw Error('Higgsfield kept earlier photos attached; nothing was sent.');
  if (!r?.addPoint) throw Error('Higgsfield photo button not found; nothing was sent.');
  await flowCdpClick(tabId, r.addPoint.x, r.addPoint.y, true);
  let picker = null; for (let i = 0; i < 20; i++) { await sleep(300); picker = await exec(tabId, pg_higgs, ['picker', {video}], 'MAIN'); if (picker?.open && picker.uploadPoint) break; }
  if (!picker?.open || !picker.uploadPoint) throw Error('Higgsfield photo picker did not open; nothing was sent.');
  const baseline = new Set(picker.ids.map(x => x.id)), busy = {};
  flowUploadBusy.set(busy, tabId);
  let paths, chooser = null, wake = null;
  const onEvent = (source, method, params) => { if (source?.tabId === tabId && !source.sessionId && method === 'Page.fileChooserOpened') { chooser = params; wake?.(); } };
  try {
    paths = await flowUploadTempSave(files);
    chrome.debugger.onEvent.addListener(onEvent);
    await send('Page.enable'); await send('Page.setInterceptFileChooserDialog', {enabled: true});
    for (let sent = 0, round = 0; sent < paths.length && round < paths.length; round++) {
      if (round) { picker = await exec(tabId, pg_higgs, ['picker', {video}], 'MAIN'); if (!picker?.uploadPoint) break; }
      chooser = null; await flowCdpClick(tabId, picker.uploadPoint.x, picker.uploadPoint.y, true);
      if (!chooser) await new Promise(res => { wake = res; setTimeout(res, 5000); }); wake = null;
      if (!chooser?.backendNodeId) throw Error('Chrome\'s file window did not open from Higgsfield\'s upload tile; nothing was sent.');
      const take = chooser.mode === 'selectMultiple' ? paths.slice(sent) : paths.slice(sent, sent + 1);
      await send('DOM.setFileInputFiles', {files: take, backendNodeId: chooser.backendNodeId}); sent += take.length; await sleep(800);
    }
    // Wait for the uploads to show as new cards (newest first), then select them in the order the files were given.
    let fresh = [];
    for (let i = 0; i < 120; i++) { assertRunActive(token); await sleep(500); picker = await exec(tabId, pg_higgs, ['picker', {video}], 'MAIN'); fresh = (picker?.ids || []).filter(x => !baseline.has(x.id)); if (fresh.length >= files.length && !picker.uploading) break; }
    if (fresh.length < files.length) throw Error(`Higgsfield upload not confirmed (${fresh.length} of ${files.length} photos); nothing was sent.`);
    const order = fresh.slice(0, files.length).reverse();
    for (const card of order) {
      if (card.selected) continue;
      const at = await exec(tabId, pg_higgs, ['pick-point', {id: card.id}], 'MAIN'); if (!at?.ok) throw Error(at?.error || 'uploaded photo not found');
      await flowCdpClick(tabId, at.x, at.y, true); await sleep(500);
    }
    picker = await exec(tabId, pg_higgs, ['picker', {video}], 'MAIN');
    if (picker?.open && picker.closePoint) { await flowCdpClick(tabId, picker.closePoint.x, picker.closePoint.y, true); await sleep(500); }
    for (let i = 0; i < 40; i++) { r = await refs(); if (r?.count === files.length && r.ready) break; await sleep(500); }
    if (r?.count !== files.length) throw Error(`Higgsfield shows ${r?.count || 0} attached photos instead of ${files.length}; nothing was sent.`);
    const want = new Set(order.map(x => x.id));
    if (r.ids.some(x => x && !want.has(x))) throw Error('Higgsfield attached a different photo than the one uploaded; nothing was sent.');
    log(`${itemId}: ${files.length} photo${files.length > 1 ? 's' : ''} attached in Higgsfield (real upload).`);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await send('Page.setInterceptFileChooserDialog', {enabled: false}).catch(() => {});
    flowUploadBusy.delete(busy); await flowUploadTempCleanup().catch(() => {});
  }
}
async function higgsKey(send, key, code, keyCode, modifiers = 0) {
  await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers});
}
async function higgsJournal(id, value) { const all = (await chrome.storage.local.get(HIGGS_JOB_STORE))[HIGGS_JOB_STORE] || {}; if (value === null) delete all[id]; else { if (!all[id] && Object.keys(all).length >= 50) throw Error('Higgsfield has 50 pending requests. Resolve them before submitting more.'); all[id] = value; } await chrome.storage.local.set({[HIGGS_JOB_STORE]: all}); }
async function higgsFingerprint(item, mode, references = []) {
  const raw = JSON.stringify([item.builderProjectId || item.manualProjectId || 'manual', item.index, mode, item.text, references.map(r => [r.name, String(r.dataUrl || '').length, String(r.dataUrl || '').slice(-64)])]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// The one card this request made: new since Generate, never a card that was there before.
function higgsOwnedCard(assets, job) {
  if (job.assetId) return assets.find(a => a.id === job.assetId) || null;
  const fresh = assets.filter(a => !job.baselineIds.includes(a.id));
  return fresh.length ? {...fresh[0], extra: fresh.length - 1} : null;
}
async function waitHiggsPage(tabId, video, token, ms = 45000) {
  const start = Date.now(); let last;
  while (Date.now() - start < ms) { assertRunActive(token); last = await exec(tabId, pg_higgs, ['state', {video}], 'MAIN').catch(() => null); if (last?.ok && last.boxPoint && last.submitPoint) return last; await sleep(700); }
  throw Error(last?.error || 'Higgsfield page did not finish loading. Sign in at higgsfield.ai first.');
}
async function runHiggsPrompt(item, slot, token) {
  item.platform = 'higgsfield'; item.status = 'running'; item.retryAt = null; item.attempts = (item.attempts || 0) + 1; renderQueue();
  let job, id, pauseMessage = '';
  try {
    assertRunActive(token);
    if (!HIGGS_MODES.includes(settings.mode)) throw Error('Higgsfield setup: this mode is not supported.');
    if (!await chrome.permissions.contains({origins: HIGGS_ORIGINS})) throw Error('Higgsfield setup: select Higgsfield and allow site access before starting.');
    const video = MODES[settings.mode].resultKind === 'video', kind = video ? 'video' : 'image';
    let tab = await getHiggsTab(slot, settings.mode);
    // Same as Flow: the Higgsfield tab comes to the front (owner test 11-09: in a background tab the prompt box never took the cursor).
    if (settings.openTabWhileGenerating !== false && !tab.active) { await chrome.tabs.update(tab.id, {active: true}).catch(() => {}); await sleep(600); tab = await chrome.tabs.get(tab.id); }
    const references = MODES[settings.mode].needsImages ? imagesForItem(item) : [];
    if (MODES[settings.mode].needsImages && !references.length) throw Error('Higgsfield setup: assign a reference image first.');
    const maxRefs = settings.mode === 'frame-to-video' ? 1 : 6;
    if (references.length > maxRefs) throw Error(`Higgsfield: ${settings.mode === 'frame-to-video' ? 'Frame to Video takes one start frame' : 'up to 6 photos per prompt'}; this prompt has ${references.length}.`);
    if (references.some(r => !/^data:image\/(png|jpe?g|webp)/i.test(r.dataUrl || ''))) throw Error('Higgsfield accepts PNG, JPG or WebP photos only.');
    id = await higgsFingerprint(item, settings.mode, references);
    job = (await chrome.storage.local.get(HIGGS_JOB_STORE))[HIGGS_JOB_STORE]?.[id] || null;
    if (!job && (!higgsOnPage(tab.url, settings.mode) || (video ? settings.higgsVideoModel : settings.higgsImageModel) && !new URL(tab.url).search.includes('model=' + (video ? settings.higgsVideoModel : settings.higgsImageModel)))) {
      await chrome.tabs.update(tab.id, {url: higgsPageUrl(settings.mode)}); await sleep(2500); tab = await chrome.tabs.get(tab.id);
    }
    if (job && !higgsOnPage(tab.url, settings.mode)) { await chrome.tabs.update(tab.id, {url: higgsPageUrl(settings.mode)}); await sleep(2500); }
    if (!job) {
      const target = {tabId: tab.id}; let owns = false;
      try {
        try { await chrome.debugger.attach(target, '1.3'); owns = true; } catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
        const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
        // Lets the page take the cursor even when its window is not the focused one (the panel window has focus).
        await send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
        let state = await waitHiggsPage(tab.id, video, token);
        // Photos: removed from the last prompt, then uploaded and selected for this one (all before any text).
        if (references.length) {
          const files = references.map(r => { const v = dataUrlToB64(r.dataUrl); return {name: r.name, base64: v.b64, type: v.type}; });
          await higgsAttach(tab.id, send, files, video, token, item.id);
          state = await waitHiggsPage(tab.id, video, token);
        } else {
          const r = await exec(tab.id, pg_higgs, ['refs', {video}], 'MAIN');
          for (let i = 0; i < 12 && r?.count && r.removePoint; i++) { const q = await exec(tab.id, pg_higgs, ['refs', {video}], 'MAIN'); if (!q?.count || !q.removePoint) break; await flowCdpMouseMove(tab.id, q.removePoint.x, q.removePoint.y, true); await flowCdpClick(tab.id, q.removePoint.x, q.removePoint.y, true); await sleep(500); }
          if ((await exec(tab.id, pg_higgs, ['refs', {video}], 'MAIN'))?.count) throw Error('Higgsfield still has photos attached from an earlier prompt; nothing was sent.');
          state = await waitHiggsPage(tab.id, video, token);
        }
        // Aspect ratio from the panel setting (Higgsfield's "Auto" made a "wide" banner square in the owner's test).
        const ratio = HIGGS_RATIOS[settings.aspectRatio] || '9:16';
        if (state.ratioPoint && state.ratio !== ratio) {
          await flowCdpClick(tab.id, state.ratioPoint.x, state.ratioPoint.y, true); await sleep(500);
          const opt = await exec(tab.id, pg_higgs, ['menu-item', {value: ratio}], 'MAIN');
          if (opt?.ok && !opt.checked) await flowCdpClick(tab.id, opt.x, opt.y, true); else await higgsKey(send, 'Escape', 'Escape', 27);
          await sleep(400);
          state = await waitHiggsPage(tab.id, video, token);
          if (state.ratio !== ratio) log(`${item.id}: Higgsfield kept ratio ${state.ratio || 'unknown'} (${ratio} not offered by this model).`);
        }
        // Video length: the Duration slider moves one second per arrow key. An AI Story scene keeps its own length
        // (owner 2026-11-17); the model's slider range decides the nearest allowed length.
        const seconds = higgsSeconds(item, settings);
        if (video && seconds && state.durationPoint) {
          await flowCdpClick(tab.id, state.durationPoint.x, state.durationPoint.y, true); await sleep(500);
          let s = await exec(tab.id, pg_higgs, ['slider'], 'MAIN');
          if (s?.ok) {
            const want = Math.min(s.max, Math.max(s.min, seconds));
            await flowCdpClick(tab.id, s.x, s.y, true); await sleep(200);
            s = await exec(tab.id, pg_higgs, ['slider'], 'MAIN');
            for (let i = 0; i < 40 && s?.ok && s.now !== want; i++) { await higgsKey(send, s.now < want ? 'ArrowRight' : 'ArrowLeft', s.now < want ? 'ArrowRight' : 'ArrowLeft', s.now < want ? 39 : 37); s = await exec(tab.id, pg_higgs, ['slider'], 'MAIN'); }
            if (s?.now !== want) log(`${item.id}: Higgsfield length stayed ${s?.now ?? '?'}s (wanted ${want}s).`);
            if (want !== seconds) log(`${item.id}: Higgsfield model allows ${s.min}-${s.max}s; using ${want}s.`);
          }
          await higgsKey(send, 'Escape', 'Escape', 27); await sleep(300);
          state = await waitHiggsPage(tab.id, video, token);
        }
        // Prompt: real click into the box, clear only inside the box, then real text input.
        const prompt = String(item.generationText || item.text || '').trim();
        for (let i = 0; i < 3; i++) {
          if (i) state = await waitHiggsPage(tab.id, video, token);
          await flowCdpClick(tab.id, state.boxPoint.x, state.boxPoint.y, true); await sleep(250 + i * 300);
          state = await exec(tab.id, pg_higgs, ['state', {video}], 'MAIN');
          if (state?.focused) break;
        }
        if (!state?.focused) throw Error('Higgsfield prompt box did not take the cursor; nothing was sent.');
        if (state.text) { await higgsKey(send, 'a', 'KeyA', 65, 2); await higgsKey(send, 'Backspace', 'Backspace', 8); await sleep(150); }
        await send('Input.insertText', {text: prompt}); await sleep(500); assertRunActive(token);
        state = await exec(tab.id, pg_higgs, ['state', {video}], 'MAIN');
        const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
        if (norm(state?.text) !== norm(prompt)) throw Error('Higgsfield prompt did not land exactly; nothing was sent.');
        if (state.submitDisabled || state.busy) throw Error('Higgsfield Generate is not available (check credits or the page); nothing was sent.');
        const cost = higgsCost(state.submitText);  // No credit limit — all prompts always sent
        // if (limit && cost != null && cost > limit) { stopRequested = true; queueStopReason = 'Higgsfield cost above your limit'; pauseMessage = `This prompt costs ${cost} credits on Higgsfield, above your limit of ${limit}. Nothing was sent.`; throw Error(pauseMessage); }
        const before = await exec(tab.id, pg_higgs, ['assets'], 'MAIN');
        // Saved BEFORE the click: if the click is uncertain, Retry only looks for the card; it never pays twice.
        job = {location: higgsPageUrl(settings.mode), tabId: tab.id, kind, baselineIds: (before?.assets || []).map(a => a.id), cost, armedAt: Date.now()};
        await higgsJournal(id, job); assertRunActive(token);
        await flowCdpClick(tab.id, state.submitPoint.x, state.submitPoint.y, true);
        log(`${item.id}: Higgsfield ${kind} request sent${cost != null ? ` (${cost} credits)` : ''}${state.model ? ` · ${state.model}` : ''}; waiting for its card.`);
      } finally {
        await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
        if (owns) await chrome.debugger.detach(target).catch(() => {});
      }
    } else log(`${item.id}: resuming the existing Higgsfield request; prompt will not be sent again.`);
    const started = Date.now(); let card = null;
    while (Date.now() - started < settings.maxWaitMinutes * 60000) {
      assertRunActive(token);
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (!isHiggsTab(now)) throw Error('The Higgsfield tab was closed or left; open higgsfield.ai again and Retry (nothing is resent).');
      const list = await exec(tab.id, pg_higgs, ['assets'], 'MAIN').catch(() => null);
      const own = list?.ok ? higgsOwnedCard(list.assets, job) : null;
      if (own && !job.assetId) { job.assetId = own.id; await higgsJournal(id, job); if (own.extra) log(`${item.id}: Higgsfield made ${own.extra + 1} results; the first is saved.`); }
      if (!own && !job.assetId && Date.now() - started > 90000) throw Error('Higgsfield did not show a new card for this request. Check the page; Retry waits for it and does not resend.');
      if (own?.failed) { await higgsJournal(id, null); const why = (own.text || '').replace(/\s*(Learn why|Recreate|Retry|View more|Delete)\b.*$/i, '').slice(0, 120).replace(/[.\s]+$/, '') || own.status; pauseMessage = `Higgsfield did not make this request: ${why}. Retry sends it again; change the prompt or photo if it keeps happening.`; throw Error(pauseMessage); }
      if (own && own.status === 'completed' && (job.kind === 'video' ? own.video : own.image)) { card = own; break; }
      item.detail = job.assetId ? 'Higgsfield is generating this request…' : 'Waiting for Higgsfield to show this request…'; renderQueue(); await sleep(3000);
    }
    if (!card) throw Error('Higgsfield result not ready in time. Retry waits for the same card without resending.');
    item.higgsResult = {assetId: card.id, kind: job.kind};
    if (autoDownloadOff(job.kind, item)) item.detail = 'generated in Higgsfield; automatic download is off';
    else {
      const src = higgsMediaUrl(job.kind === 'video' ? card.video : card.image);
      if (!src) throw Error('Higgsfield result address not found; download it from the page.');
      item.detail = 'downloading the Higgsfield result'; renderQueue();
      const bytes = await downloadMediaBuffer(tab.id, {src, host: 'Higgsfield'}, item.id); assertRunActive(token);
      if (job.kind === 'video' ? !P().bufferHasMp4Signature(bytes) : !P().bufferHasImageSignature(bytes)) throw Error('Higgsfield download returned invalid media; the result stays on Higgsfield.');
      const ext = job.kind === 'video' ? 'mp4' : guessImageExt(bytes, src);
      const saved = await saveOutput(item, bytes, ext); item.outputName = saved.name; item.detail = `saved ${saved.name} → ${saved.where}`;
    }
    await higgsJournal(id, null); item.status = 'done'; item.progressPercent = 100; log(`${item.id}: done - ${item.detail}`);
  } catch (e) {
    const cancelled = stopRequested || token !== runToken;
    item.status = cancelled && !pauseMessage ? 'pending' : 'error'; item.retryAt = null;
    item.detail = pauseMessage || (cancelled ? 'Paused; the Higgsfield request will be resumed, not resent.' : String(e?.message || e));
    log(`${item.id}: Higgsfield ${item.detail}`);
  } finally { renderQueue(); schedulePersist(); }
}
if (typeof module !== 'undefined') module.exports = {higgsCost, higgsMediaUrl, higgsPageUrl, higgsOwnedCard, higgsOnPage, higgsSeconds, pg_higgs, isHiggsTab};
