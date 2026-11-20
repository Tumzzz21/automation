// builder-brain.js — AI Story tasks (ideas, hooks, scene prompts) driven by a real browser tab.
//
// Instead of calling a server LLM, this drives the chosen AI website (Gemini / ChatGPT / Grok) the same way
// the queue engines do: find a tab, type one prompt with chrome.debugger Input.insertText, click Send with a
// trusted CDP click, poll the page for the finished answer text, and return it. The tab is LEFT OPEN.
// All engine helpers (exec, getGeminiTab, pg_*, flowCdpClick, ...) are classic-script globals from control.js
// and the *-engine.js files, so they are reachable here by name at call time.
'use strict';
(() => {
  const PLATFORMS = [
    { id: 'gemini', label: 'Gemini' },
    { id: 'chatgpt', label: 'ChatGPT' },
    { id: 'grok', label: 'Grok' },
    { id: 'meta', label: 'Meta AI' },
  ];
  const STORAGE_KEY = 'builderBrainPlatform';
  const SLOT = 99; // dedicated slot so builder tabs never clobber the queue's slotTabs 0..N
  let platform = 'gemini';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (t) => { if (typeof log === 'function') log('[Builder Brain] ' + t); };

  async function loadPlatform() {
    try { const s = await chrome.storage.local.get(STORAGE_KEY); if (PLATFORMS.some((p) => p.id === s[STORAGE_KEY])) platform = s[STORAGE_KEY]; } catch {}
    return platform;
  }
  function getPlatform() { return platform; }
  async function setPlatform(p) {
    if (!PLATFORMS.some((x) => x.id === p)) return;
    platform = p;
    try { await chrome.storage.local.set({ [STORAGE_KEY]: p }); } catch {}
  }

  // Picker shown only inside the AI Story builder header.
  function mountPicker(head) {
    if (!head || head.querySelector('.bb-picker')) return;
    const wrap = document.createElement('div'); wrap.className = 'bb-picker';
    const lbl = document.createElement('label'); lbl.textContent = 'Build with ';
    const sel = document.createElement('select'); sel.setAttribute('aria-label', 'AI site for builder tasks');
    for (const p of PLATFORMS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.append(o); }
    sel.value = platform;
    sel.onchange = () => { setPlatform(sel.value); say('Builder tasks now use ' + sel.value + '.'); };
    lbl.append(sel); wrap.append(lbl);
    const controlBtn = head.querySelector('button');
    if (controlBtn) head.insertBefore(wrap, controlBtn); else head.append(wrap);
    const style = document.createElement('style');
    style.textContent = '.bb-picker{display:flex;align-items:center;gap:5px;font-size:11px;color:#b7adc9;margin-left:auto}'
      + '.bb-picker select{background:#191724;color:#eae1ff;border:1px solid #594b76;border-radius:7px;padding:3px 7px;font:inherit;cursor:pointer}';
    document.head.append(style);
  }

  // ---------- page adapters (self-contained: serialized by exec) ----------

  // Grok chat state. Several selectors are tried because Grok's chat DOM differs from its Imagine page.
  function pg_bb_grokChat() {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (s) => String(s || '').replace(/\r/g, '').trim();
    const main = document.querySelector('main') || document.body;
    const messageSelectors = ['[data-message-author-role="assistant"]', '[data-role="assistant"]',
      '.assistant-message', '[class*="assistant-message"]', '[class*="AssistantMessage"]'];
    let msgs = [];
    for (const s of messageSelectors) { const f = Array.from(document.querySelectorAll(s)).filter(vis); if (f.length) { msgs = f; break; } }
    if (!msgs.length) msgs = Array.from(document.querySelectorAll('.markdown')).filter(vis);
    const text = msgs.length ? clean((msgs[msgs.length - 1].innerText || msgs[msgs.length - 1].textContent)) : '';
    const busy = !!document.querySelector('[aria-label*="Stop" i], [aria-label*="stop generating" i], [class*="stop-button"]');
    const userCount = Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-role="user"]')).filter(vis).length;
    const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], .tiptap.ProseMirror')).filter(vis)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const editor = editors[0] || null;
    const send = Array.from(document.querySelectorAll('button')).filter(vis)
      .find((b) => /^(send|submit)$/i.test(b.getAttribute('aria-label') || '') && !b.disabled);
    const sr = send ? send.getBoundingClientRect() : null;
    return { text, busy, userCount, editorText: editor ? String(editor.innerText || editor.value || '') : '',
      sendPoint: sr ? { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 } : null,
      pageText: clean(main.innerText || '').slice(-3000) };
  }
  async function pg_bb_grokType(text) {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const editor = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], .tiptap.ProseMirror')).filter(vis)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!editor) return { ok: false, error: 'Grok composer not found' };
    editor.focus();
    if (editor.tagName === 'TEXTAREA') { editor.value = text; editor.dispatchEvent(new Event('input', { bubbles: true })); }
    else { document.execCommand('selectAll', false); document.execCommand('insertText', false, text); }
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, text: String(editor.innerText || editor.value || '').replace(/\s+/g, ' ') };
  }

  // Read ONLY the assistant's reply to the question whose probe we just sent. The analyser prompt itself contains
  // "END OF RECORD", so a naive text search matches our own prompt and fires the next step before any reply exists.
  // Find the user bubble holding the probe, then read substantial text that appears AFTER it, excluding our prompt.
  function pg_bb_metaAnswer(probe) {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (s) => String(s || '').replace(/\r/g, '').trim();
    const main = document.querySelector('main') || document.body;
    const order = Array.from(main.querySelectorAll('div, p, pre, article, section')).filter(vis);
    // Our sent prompt bubble = the smallest visible element whose text contains the probe.
    let userEl = null;
    for (const el of order) {
      const t = clean(el.innerText || el.textContent || '');
      if (probe && t.replace(/\s+/g, ' ').includes(probe)) {
        if (!userEl || t.length < clean(userEl.innerText || userEl.textContent || '').length) userEl = el;
      }
    }
    const start = userEl ? order.indexOf(userEl) : -1;
    // Candidate reply elements: after our prompt, substantial text, NOT containing our probe.
    let body = null;
    for (let i = start + 1; i < order.length; i++) {
      const el = order[i];
      const t = clean(el.innerText || el.textContent || '');
      if (t.length < 60) continue;
      if (probe && t.replace(/\s+/g, ' ').includes(probe)) continue;
      const marker = /END OF RECORD/i.test(t) || /"scenes"/.test(t) || /```/.test(t);
      if (marker) {
        // Prefer the deepest (smallest) element holding the marker — the message body, not its wrappers.
        if (!body || t.length < clean(body.innerText || body.textContent || '').length) body = el;
      }
    }
    // No marker yet — take the last substantial non-prompt block (streaming reply in progress).
    if (!body) for (let i = order.length - 1; i > start; i--) {
      const el = order[i], t = clean(el.innerText || el.textContent || '');
      if (t.length >= 60 && !(probe && t.replace(/\s+/g, ' ').includes(probe))) { body = el; break; }
    }
    const text = body ? clean(body.innerText || body.textContent) : '';
    let codes = body ? Array.from(body.querySelectorAll('pre code, code, pre')).map(c => c.innerText).filter(t => t && t.length > 20) : [];
    if (/```(?:json)?[\s\S]*?```/i.test(text)) codes.push(text.match(/```(?:json)?\s*([\s\S]*?)```/i)[1]);
    const fb = text.indexOf('{'), lb = text.lastIndexOf('}');
    if (fb >= 0 && lb > fb) codes.push(text.slice(fb, lb + 1));
    return { text, codes: codes.filter(Boolean), hasUserMsg: !!userEl };
  }

  // Click the Copy button on the assistant reply that answers `probe`. Meta renders replies with a copy control
  // (aria-label/title "Copy", or an icon button in the message action row). Returns true if a copy button was clicked.
  function pg_bb_metaClickCopy(probe) {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const main = document.querySelector('main') || document.body;
    const order = Array.from(main.querySelectorAll('div, p, pre, article, section')).filter(vis);
    let userEl = null;
    for (const el of order) {
      const t = clean(el.innerText || el.textContent || '');
      if (probe && t.includes(probe) && (!userEl || t.length < clean(userEl.innerText || userEl.textContent || '').length)) userEl = el;
    }
    const start = userEl ? order.indexOf(userEl) : -1;
    // Search the assistant reply region (after our prompt) for a Copy button.
    for (let i = start + 1; i < order.length; i++) {
      const el = order[i];
      const btns = Array.from(el.querySelectorAll('button, [role="button"]')).filter(vis);
      for (const b of btns) {
        const label = clean(b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('data-testid') || '');
        if (/copy/i.test(label) || /copy/i.test(clean(b.innerText || ''))) { b.click(); return { ok: true, label }; }
      }
    }
    // Fallback: any visible Copy button on the page.
    const any = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis)
      .find(b => /copy/i.test(clean(b.getAttribute('aria-label') || b.getAttribute('title') || '')));
    if (any) { any.click(); return { ok: true, label: 'fallback' }; }
    return { ok: false };
  }

  // Read the assistant reply: click Meta's Copy button, read the clipboard (extension has clipboardRead), and prefer that
  // text. Falls back to DOM extraction if the clipboard read fails or yields nothing useful.
  async function metaReplyText(tab, probe) {
    let dom = await exec(tab.id, pg_bb_metaAnswer, [probe], 'MAIN').catch(() => ({ text: '', codes: [] }));
    // Only copy when the DOM answer looks finished — avoids copying a mid-stream partial reply.
    const looksDone = dom.text && dom.text.length >= 200 &&
      (/END OF RECORD/i.test(dom.text) || /^DONE\s*:/im.test(dom.text) || /^SCENE\s+1/im.test(dom.text) || /"scenes"/.test(dom.text) || /```/i.test(dom.text));
    if (!looksDone) return dom;
    try {
      const clicked = await exec(tab.id, pg_bb_metaClickCopy, [probe], 'MAIN').catch(() => ({ ok: false }));
      if (clicked.ok) {
        await sleep(300);
        const clip = await navigator.clipboard.readText();
        if (clip && clip.trim().length > 40) {
          const t = String(clip).trim();
          const fm = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
          const fb = t.indexOf('{'), lb = t.lastIndexOf('}');
          const codes = fm ? [fm[1]] : (fb >= 0 && lb > fb ? [t.slice(fb, lb + 1)] : (dom.codes || []));
          return { text: t, codes, viaClipboard: true };
        }
      }
    } catch {}
    return dom;
  }

  // Return the visible composer's center point for a real CDP click (focuses React properly before typing).
  function pg_bb_metaComposerPoint() {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sel = 'input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]';
    const el = Array.from(document.querySelectorAll(sel)).find(vis);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  // Find the Meta AI composer with several strategies: known selectors, then the editable element nearest the Send button.
  function pg_bb_metaFindComposer() {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sel = 'input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], [contenteditable="true"][data-placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]';
    // Only VISIBLE matches — Meta keeps old/hidden composers in the DOM from previous chats.
    let el = Array.from(document.querySelectorAll(sel)).find(vis);
    if (el) return el;
    const send = Array.from(document.querySelectorAll('button')).filter(vis).find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label') || ''));
    if (send) {
      const form = send.closest('form') || send.parentElement?.parentElement || document.body;
      el = Array.from(form.querySelectorAll('input[type="text"], textarea, div[contenteditable="true"]')).find(vis);
      if (el) return el;
    }
    el = Array.from(document.querySelectorAll('input[type="text"], textarea, div[contenteditable="true"]')).filter(vis)
      .find(e => /ask meta|message|prompt/i.test((e.getAttribute('placeholder')||'') + (e.getAttribute('aria-label')||'') + (e.getAttribute('data-placeholder')||'')));
    return el || null;
  }

  // Meta.ai chat state. Composer found by pg_bb_metaFindComposer (logged-in and logged-out layouts differ).
  function pg_bb_metaChat() {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (s) => String(s || '').replace(/\r/g, '').trim();
    const main = document.querySelector('main') || document.body;
    const messageSelectors = ['[data-testid*="assistant" i]', '[data-testid*="message" i][data-role="assistant"]',
      '[class*="assistant-message" i]', '[class*="AssistantMessage" i]', '[data-message-author-role="assistant"]',
      '[class*="markdown" i]'];
    let msgs = [];
    for (const s of messageSelectors) { const f = Array.from(document.querySelectorAll(s)).filter(vis); if (f.length) { msgs = f; break; } }
    if (!msgs.length) msgs = Array.from(document.querySelectorAll('[data-testid*="message" i]')).filter(vis);
    const text = msgs.length ? clean(msgs[msgs.length - 1].innerText || msgs[msgs.length - 1].textContent) : '';
    const busy = !!document.querySelector('[aria-label*="Stop" i], [aria-label*="stop generating" i], [data-testid*="stop" i], [class*="stop-button" i]');
    const userCount = Array.from(document.querySelectorAll('[data-testid*="user-message" i], [data-message-author-role="user"], [class*="user-message" i]')).filter(vis).length
      || (window.__bbMetaUsers || 0);
    const cSel = 'input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]';
    let input = Array.from(document.querySelectorAll(cSel)).find(vis);
    if (!input) { const sb = Array.from(document.querySelectorAll('button')).filter(vis).find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label')||'')); if (sb) input = Array.from((sb.closest('form')||sb.parentElement?.parentElement||document.body).querySelectorAll('input[type="text"], textarea, div[contenteditable="true"]')).find(vis); }
    const send = Array.from(document.querySelectorAll('button')).filter(vis)
      .find((b) => /^(send|submit)$/i.test(b.getAttribute('aria-label') || '') && !b.disabled);
    const sr = send ? send.getBoundingClientRect() : null;
    return { text, busy, userCount, editorText: input ? String(input.value || input.innerText || '') : '',
      sendPoint: sr ? { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 } : null,
      pageText: clean(main.innerText || '').slice(-3000) };
  }
  // Type into the composer using the native value setter + input event — the React-compatible way that was verified
  // to make the prompt visibly appear in Meta's composer (CDP Input.insertText did not work on this field).
  function pg_bb_metaType(text) {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cSel = 'input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]';
    let el = Array.from(document.querySelectorAll(cSel)).find(vis);
    if (!el) { const sb = Array.from(document.querySelectorAll('button')).filter(vis).find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label')||'')); if (sb) el = Array.from((sb.closest('form')||sb.parentElement?.parentElement||document.body).querySelectorAll('input[type="text"], textarea, div[contenteditable="true"]')).find(vis); }
    if (!el) return { ok: false, error: 'Meta AI composer not found' };
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, tag: el.tagName, text: String(el.value || el.innerText || '') };
  }

  // Robustly type into the visible Meta composer: real CDP click to focus, native-setter text, then verify; falls back to
  // CDP Input.insertText if the native setter did not stick. `exec`/`flowCdpClick`/debugger are provided by the caller.
  // Returns the visible editor text after typing.
  async function metaTypeVerified(tab, target, typedFn, text, sleepFn, execFn) {
    const point = await execFn(tab.id, pg_bb_metaComposerPoint, [], 'MAIN').catch(() => null);
    if (point && point.x != null) {
      // A real mouse click focuses the React composer properly (element.focus() alone sometimes doesn't).
      if (typeof flowCdpClick === 'function') await flowCdpClick(tab.id, point.x, point.y, true).catch(() => {});
    }
    await typedFn(tab.id, text);
    await sleepFn(800);
    let state = await execFn(tab.id, pg_bb_metaReverseState, [], 'MAIN').catch(() => ({}));
    let editor = String(state.editorText || '');
    if (!editor.trim()) {
      // Fallback: real keyboard input.
      if (point && point.x != null && typeof flowCdpClick === 'function') await flowCdpClick(tab.id, point.x, point.y, true).catch(() => {});
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
      await sleepFn(800);
      state = await execFn(tab.id, pg_bb_metaReverseState, [], 'MAIN').catch(() => ({}));
      editor = String(state.editorText || '');
    }
    return editor;
  }

  // Click Meta's Send button with a real page-level click sequence (React responds to pointer/mouse/click events).
  // This avoids CDP coordinate clicks, which miss when the debugger banner or the long-prompt preview shifts the layout.
  function pg_bb_metaSend() {
    const btns = Array.from(document.querySelectorAll('button'));
    const send = btns.find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label') || '') && !b.disabled)
      || btns.find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label') || ''));
    if (!send) return { ok: false, error: 'no Send button' };
    if (send.disabled) return { ok: false, error: 'Send button disabled' };
    const fire = (type, Ctor) => { try { send.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window })); } catch {} };
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent);
    fire('pointerup', PointerEvent); fire('mouseup', MouseEvent);
    send.click();
    return { ok: true };
  }

  // Meta AI video attachment. The file input appears only after opening the "+" / attachment menu.
  async function pg_bb_metaAttach(f) {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
    const findInput = () => Array.from(document.querySelectorAll('input[type=file]')).find(i => /video|file|upload/i.test((i.accept || '') + ' ' + (i.getAttribute('data-testid') || ''))) || document.querySelector('input[type=file]');
    const waitInput = async ms => { for (const until = Date.now() + ms; Date.now() < until;) { const i = findInput(); if (i) return i; await new Promise(r => setTimeout(r, 250)); } return null; };
    let input = await waitInput(600);
    if (!input) {
      const plus = document.querySelector('[data-testid="composer-add-attachment-button"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /add attachment|attach/i.test(b.getAttribute('aria-label') || ''));
      if (plus) { plus.click(); input = await waitInput(5000); }
    }
    if (!input) {
      const item = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], label')).find(b => /upload (file|video)|from (device|computer)|add (file|video)/i.test((b.innerText || b.textContent || '')));
      if (item) { item.click(); input = await waitInput(5000); }
    }
    if (!input) return { ok: false, error: 'no file input' };
    try {
      const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
      const file = new File([bytes], f.name || 'video.mp4', { type: f.type || 'video/mp4' });
      const dt = new DataTransfer(); dt.items.add(file);
      input.value = '';
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (desc?.set) desc.set.call(input, dt.files); else input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
  // Reads chat state for the reverse flow. Uploaded video thumbnails use blob:/data: URLs — a strong, reliable signal.
  function pg_bb_metaReverseState() {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
    const clean = (s) => String(s || '').replace(/\r/g, '').trim();
    const cSel = 'input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]';
    let composer = Array.from(document.querySelectorAll(cSel)).find(vis);  // visible only (old hidden composers stay in DOM)
    if (!composer) { const sb = Array.from(document.querySelectorAll('button')).filter(vis).find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label')||'')); if (sb) composer = Array.from((sb.closest('form')||sb.parentElement?.parentElement||document.body).querySelectorAll('input[type="text"], textarea, div[contenteditable="true"]')).find(vis); }
    // An attached file preview is an <img>/<video> with a blob:/data: src anywhere in the document.
    const blobMedia = Array.from(document.querySelectorAll('img[src^="blob:"], img[src^="data:"], video[src^="blob:"], video[src^="data:"]')).filter(vis);
    // Also count attachment chips that contain a thumbnail image.
    const chipMedia = Array.from(document.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i], [data-testid*="file" i]')).filter(vis)
      .filter(c => c.querySelector('img, video') || /video|\.mp4/i.test(c.innerText || ''));
    // Fallback: a visible thumbnail-like image inside the composer's area (Meta renders the video preview as an <img>).
    const area = composer ? (composer.closest('form') || composer.parentElement?.parentElement || document.body) : document.body;
    const thumbMedia = Array.from(area.querySelectorAll('img')).filter(e => {
      if (!vis(e)) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 30 && r.height >= 30 && r.width <= 400 && r.height <= 400 && Math.abs(r.width - r.height) < 80;
    });
    const ready = Math.max(blobMedia.length, chipMedia.length, thumbMedia.length);
    const uploading = Array.from(document.querySelectorAll('[class*="upload" i], [class*="progress" i], [aria-label*="upload" i]')).filter(vis)
      .filter(c => /uploading|processing|preparing|\d+\s*%/i.test(c.innerText || '')).length;
    // Composer text (for send verification).
    const editorText = composer ? String(composer.value || composer.innerText || '') : '';
    // User messages (for send verification).
    const userMsgs = Array.from(document.querySelectorAll('[data-testid*="user-message" i], [class*="user-message" i], [data-message-author-role="user"]')).filter(vis)
      .map(m => clean(m.innerText || m.textContent));
    // Latest assistant reply. Take the LAST top-level message block in the chat (Meta renders messages in DOM order),
    // not the historic analyser answer. Prefer a block whose text has a fenced JSON block or END OF RECORD.
    const main = document.querySelector('main') || document.body;
    // Candidate message blocks: direct children of the chat's scroll area that hold substantial text.
    let container = null;
    const allDivs = Array.from(main.querySelectorAll('div')).filter(vis);
    for (const d of allDivs) {
      const kids = Array.from(d.children).filter(vis);
      if (kids.length >= 2 && kids.filter(k => (k.innerText || '').trim().length > 40).length >= 2) { container = d; }
    }
    const blocks = container ? Array.from(container.children).filter(vis).filter(b => (b.innerText || '').trim().length > 10) : [];
    // Walk blocks from the end; the last one with a completion marker (or just the last block) is the answer.
    let body = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = clean(blocks[i].innerText || blocks[i].textContent || '');
      if (/```(?:json)?[\s\S]*?```/i.test(t) || /END OF RECORD/i.test(t) || /"scenes"/.test(t)) { body = blocks[i]; break; }
    }
    if (!body && blocks.length) body = blocks[blocks.length - 1];
    // Fallback to the marker/largest search if the structured walk found nothing.
    if (!body) {
      const candidates = allDivs.filter(d => /END OF RECORD/i.test(d.innerText || '') || (/"scenes"/.test(d.innerText || '') && /```/i.test(d.innerText || '')));
      body = candidates.length ? candidates.reduce((a, b) => ((b.innerText || '').length > (a.innerText || '').length ? b : a), candidates[0]) : null;
    }
    const text = body ? clean(body.innerText || body.textContent) : '';
    let codes = body ? Array.from(body.querySelectorAll('pre code, code, pre')).map(c => c.innerText).filter(t => t && t.length > 20) : [];
    // Meta renders JSON in a special widget (Tree/Raw tabs), not a fenced code block. Grab the JSON from the answer text.
    if (/```(?:json)?[\s\S]*?```/i.test(text)) codes.push(text.match(/```(?:json)?\s*([\s\S]*?)```/i)[1]);
    const firstBrace = text.indexOf('{'), lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) codes.push(text.slice(firstBrace, lastBrace + 1));
    // Also scan any element in the answer that looks like a JSON document (the widget's raw container).
    if (body) for (const el of Array.from(body.querySelectorAll('div, pre, span')).filter(vis)) {
      const t = clean(el.innerText || el.textContent || '');
      if (t.startsWith('{') && /"scenes"/.test(t) && t.length > 100) { codes.push(t); break; }
    }
    codes = codes.filter(Boolean);
    const busy = !!document.querySelector('[aria-label*="Stop" i], [data-testid*="stop" i], [class*="stop-button" i]');
    const send = Array.from(document.querySelectorAll('button')).filter(vis).find(b => /^(send|submit)$/i.test(b.getAttribute('aria-label') || '') && !b.disabled);
    const sr = send ? send.getBoundingClientRect() : null;
    return { chipsReady: ready, chipsBusy: uploading, busy, answered: !!text, text, codes, editorText, userMsgs,
      sendPoint: sr ? { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 } : null };
  }

  // ---------- one prompt to one platform, answer text back ----------

  async function askGemini(prompt, opts) {
    if (typeof window.VideoReverse?.pg_reverseState !== 'function' || typeof pg_geminiFocusEditor !== 'function')
      throw Error('The Gemini engine is not loaded on this page.');
    let tab = await getGeminiTab(SLOT);
    const idx = geminiAccountOf(tab.url);
    const url = idx != null ? 'https://gemini.google.com/u/' + idx + '/app' : 'https://gemini.google.com/app';
    if (!/gemini\.google\.com/i.test(tab.url) || /\/(videos|images)/.test(tab.url)) {
      await chrome.tabs.update(tab.id, { url, active: true });
      await waitForTabComplete(tab.id, 60000).catch(() => {});
      await sleep(1500);
    } else if (!/\/app/.test(tab.url)) {
      await chrome.tabs.update(tab.id, { url, active: true });
      await waitForTabComplete(tab.id, 60000).catch(() => {});
      await sleep(1500);
    }
    const target = { tabId: tab.id }; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      await exec(tab.id, pg_geminiFocusEditor, [], 'MAIN');
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: prompt });
      await sleep(900);
      const before = await exec(tab.id, window.VideoReverse.pg_reverseState, [], 'MAIN');
      const probe = prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!String(before.editorText || '').replace(/\s+/g, ' ').includes(probe)) throw Error('The prompt could not be typed into Gemini; nothing was sent.');
      if (!(await exec(tab.id, window.VideoReverse.pg_reverseSend, [], 'MAIN'))?.ok) throw Error('Gemini Send was not found; nothing was sent.');
      let accepted = false;
      for (const until = Date.now() + 45000; Date.now() < until;) {
        await sleep(1200); opts.shouldStop?.();
        await exec(tab.id, window.VideoReverse.pg_reverseDismissReminder, [], 'MAIN');
        const s = await exec(tab.id, window.VideoReverse.pg_reverseState, [], 'MAIN');
        if (s.userCount > before.userCount || s.busy) { accepted = true; break; }
      }
      if (!accepted) throw Error('Gemini did not accept the prompt.');
      let stable = 0, last = -1;
      for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
        await sleep(3500); opts.shouldStop?.();
        await exec(tab.id, window.VideoReverse.pg_reverseDismissReminder, [], 'MAIN');
        const s = await exec(tab.id, window.VideoReverse.pg_reverseState, [], 'MAIN');
        if (s.answered && !s.busy && String(s.text || '').trim()) {
          stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
          if (stable >= 1) return String(s.text);
        }
        opts.onStatus?.('Gemini is writing… ' + Math.round((Date.now() - (opts.started || Date.now())) / 1000) + 's');
      }
      throw Error('Gemini did not finish in time.');
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  async function askChatgpt(prompt, opts) {
    if (typeof pg_chatgptSnapshot !== 'function' || typeof chatgptSubmitPrompt !== 'function')
      throw Error('The ChatGPT engine is not loaded on this page.');
    chatgptStartFreshChat();
    const tab = await getChatgptTaskTab(SLOT);
    await chrome.tabs.update(tab.id, { active: true });
    const target = { tabId: tab.id }; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      await sleep(600);
      const before = await exec(tab.id, pg_chatgptSnapshot, [], 'MAIN');
      await exec(tab.id, pg_chatgptFocusForTyping, [prompt], 'MAIN');
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text: prompt });
      await sleep(900);
      const typed = await exec(tab.id, pg_chatgptSnapshot, [], 'MAIN');
      if (!String(typed.editorText || '').replace(/\s+/g, ' ').trim().startsWith(prompt.replace(/\s+/g, ' ').trim().slice(0, 40)))
        throw Error('The prompt could not be typed into ChatGPT; nothing was sent.');
      if (!(await chatgptSubmitPrompt(tab.id, typed, prompt, typeof runToken !== 'undefined' ? runToken : null)))
        throw Error('ChatGPT Send was not accepted.');
      let stable = 0, last = -1;
      for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
        await sleep(3500); opts.shouldStop?.();
        const s = await exec(tab.id, pg_chatgptSnapshot, [], 'MAIN');
        if (typeof s.text === 'string' && s.text.trim() && !s.busy) {
          stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
          if (stable >= 1) return s.text;
        }
        opts.onStatus?.('ChatGPT is writing… ' + Math.round((Date.now() - (opts.started || Date.now())) / 1000) + 's');
      }
      throw Error('ChatGPT did not finish in time.');
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  async function askGrok(prompt, opts) {
    if (typeof ensureGrokAccess === 'function') { try { await ensureGrokAccess(); } catch (e) { throw Error('Allow grok.com access to use Grok for builder tasks: ' + (e.message || e)); } }
    let tab = await getGrokTab(SLOT);
    if (!/grok\.com/i.test(tab.url) || !/\/chat/.test(tab.url)) {
      await chrome.tabs.update(tab.id, { url: 'https://grok.com/chat', active: true });
      await waitForTabComplete(tab.id, 60000).catch(() => {});
      await sleep(2000);
    } else await chrome.tabs.update(tab.id, { active: true });
    const target = { tabId: tab.id }; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      await sleep(600);
      const before = await exec(tab.id, pg_bb_grokChat, [], 'MAIN');
      const typed = await exec(tab.id, pg_bb_grokType, [prompt], 'MAIN');
      if (!typed.ok) throw Error('The Grok composer was not found.');
      await sleep(500);
      const s0 = await exec(tab.id, pg_bb_grokChat, [], 'MAIN');
      if (!s0.sendPoint) throw Error('Grok Send was not found; nothing was sent.');
      await flowCdpClick(tab.id, s0.sendPoint.x, s0.sendPoint.y, true);
      let accepted = false;
      for (const until = Date.now() + 45000; Date.now() < until;) {
        await sleep(1200); opts.shouldStop?.();
        const s = await exec(tab.id, pg_bb_grokChat, [], 'MAIN');
        if (s.userCount > before.userCount || s.busy) { accepted = true; break; }
      }
      if (!accepted) throw Error('Grok did not accept the prompt.');
      let stable = 0, last = -1;
      for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
        await sleep(3500); opts.shouldStop?.();
        const s = await exec(tab.id, pg_bb_grokChat, [], 'MAIN');
        if (s.text && s.text.length > 40 && !s.busy) {
          stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
          if (stable >= 1) return s.text;
        }
        opts.onStatus?.('Grok is writing… ' + Math.round((Date.now() - (opts.started || Date.now())) / 1000) + 's');
      }
      throw Error('Grok did not finish in time (its chat answer may not be readable; try Gemini).');
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  async function askMeta(prompt, opts) {
    let tab = await chrome.tabs.query({}).then(tabs => tabs.find(t => /^https:\/\/(?:www\.)?meta\.ai(?:\/|$)/i.test(t.url || '')));
    if (!tab) tab = await chrome.tabs.create({ url: 'https://www.meta.ai/', active: true });
    else await chrome.tabs.update(tab.id, { active: true });
    await waitForTabComplete(tab.id, 60000).catch(() => {});
    // Meta AI requires being signed in; the composer only appears when logged in. Poll for it up to 20s.
    let hasInput = false;
    for (const until = Date.now() + 20000; Date.now() < until;) {
      hasInput = await exec(tab.id, pg_bb_metaFindComposer, [], 'MAIN').then(el => !!el).catch(() => false);
      if (hasInput) break;
      await sleep(1000);
    }
    if (!hasInput) throw Error('Meta AI composer not found. Make sure you are logged in at meta.ai in Chrome, then retry.');
    const target = { tabId: tab.id }; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      await sleep(500);
      // Type via verified method (real click + native setter, CDP insertText fallback).
      const editor = await metaTypeVerified(tab, target, pg_bb_metaType, prompt, sleep, exec);
      if (!editor.trim()) throw Error('The Meta AI composer did not accept the text.');
      const s0 = await exec(tab.id, pg_bb_metaChat, [], 'MAIN');
      // Prefer a page-level Send click (React-compatible); fall back to CDP coordinate click / Enter.
      const pageSent = await exec(tab.id, pg_bb_metaSend, [], 'MAIN').catch(() => ({ ok: false }));
      if (!pageSent.ok) {
        if (s0.sendPoint) await flowCdpClick(tab.id, s0.sendPoint.x, s0.sendPoint.y, true);
        else { await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }); await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); }
      }
      let accepted = false;
      for (const until = Date.now() + 45000; Date.now() < until;) {
        await sleep(1200); opts.shouldStop?.();
        const s = await exec(tab.id, pg_bb_metaChat, [], 'MAIN');
        const editorEmpty = !s.editorText || !String(s.editorText).trim();
        if (s.busy || editorEmpty || (typeof s.userCount === 'number' && s.userCount > (s0.userCount || 0))) { accepted = true; break; }
      }
      if (!accepted) throw Error('Meta AI did not accept the prompt.');
      let stable = 0, last = -1;
      for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
        await sleep(3500); opts.shouldStop?.();
        const s = await exec(tab.id, pg_bb_metaChat, [], 'MAIN');
        if (s.text && s.text.length > 40 && !s.busy) {
          stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
          if (stable >= 1) return s.text;
        }
        opts.onStatus?.('Meta AI is writing… ' + Math.round((Date.now() - (opts.started || Date.now())) / 1000) + 's');
      }
      throw Error('Meta AI did not finish in time (its answer may not be readable; try Gemini).');
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  const ASKERS = { gemini: askGemini, chatgpt: askChatgpt, grok: askGrok, meta: askMeta };
  async function ask(prompt, opts = {}) {
    const fn = ASKERS[platform];
    if (!fn) throw Error('Choose a build platform first.');
    return fn(prompt, opts);
  }

  // ---------- prompts + parsers (line-marked format) ----------

  function brief(s) {
    return 'Topic: ' + String(s?.topic || 'a story') + '. Niche: ' + String(s?.niche || '') +
      '. Language: ' + String(s?.language || 'English') + '. Style: ' + String(s?.style || '') + '.';
  }
  function buildPrompt(kind, s) {
    if (kind === 'topics') return [
      'You are a professional short-video story writer. Suggest exactly 5 concrete, engaging, DISTINCT story ideas.',
      'Output ONLY 5 lines, each starting with "IDEA: " followed by one vivid sentence.',
      'No numbering, no markdown, no extra text. ' + brief(s),
    ].join('\n');
    if (kind === 'hooks') return [
      'You are a hook writer for short videos. Write exactly 3 different opening hooks for the first 3 seconds.',
      'Output ONLY the following format, repeated 3 times, with no markdown and no extra text:',
      'ACTION: <a visible, specific opening action in the first 3 seconds>',
      'LINE: <the exact first spoken line, scroll-stopping>',
      brief(s),
    ].join('\n');
    const count = Math.max(1, Math.min(20, Number(s?.sceneCount) || 3));
    const dur = Number(s?.sceneDuration) || 8;
    return [
      'You are a professional video story writer. Write a complete short-video story package.',
      'Output ONLY the following line format, no markdown, no prose, no code fences:',
      'TITLE: <a short title>',
      'VOICE: <one consistent narrator/character voice description>',
      'SCENE 1',
      'IMAGE: <a vivid, detailed image prompt: subject, setting, lighting, camera and mood; 60-200 words>',
      'VIDEO: <start with "OPENING STATE: ..." then a "TIMELINE: ..." line describing shot-by-shot action; 60-200 words>',
      'SPEECH: <short spoken line for this scene>',
      'CAPTION: <short on-screen text note>',
      'SCENE 2 ... and so on.',
      'Exactly ' + count + ' scenes. Each scene is ' + dur + ' seconds. ' + brief(s),
    ].join('\n');
  }

  const stripMd = (t) => String(t || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/^[\s#>*_]+|[\s#>*_]+$/g, '').trim();
  function parseTopics(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = stripMd(line);
      let v = '';
      if (/^IDEA\s*:/i.test(t)) v = t.replace(/^IDEA\s*:\s*/i, '');
      else if (/^\d+[.)]\s+/.test(t)) v = t.replace(/^\d+[.)]\s+/, '');
      else if (/^[-*]\s+/.test(t)) v = t.replace(/^[-*]\s+/, '');
      if (v && stripMd(v).length > 8) out.push(stripMd(v));
    }
    return out.slice(0, 5);
  }
  function parseHooks(text) {
    const lines = String(text || '').split(/\r?\n/).map(stripMd).filter(Boolean);
    const hooks = []; let action = '';
    for (const line of lines) {
      if (/^ACTION\s*:/i.test(line)) action = line.replace(/^ACTION\s*:\s*/i, '').trim();
      else if (/^LINE\s*:/i.test(line) && action) {
        const lineText = line.replace(/^LINE\s*:\s*/i, '').trim();
        if (action.length >= 5 && lineText.length >= 5) hooks.push({ action: action.slice(0, 240), line: lineText.slice(0, 200) });
        action = '';
      }
    }
    return hooks.slice(0, 3);
  }
  function parseProject(text, setup) {
    const count = Math.max(1, Math.min(20, Number(setup?.sceneCount) || 3));
    const dur = Number(setup?.sceneDuration) || 8;
    let title = '', voice = '';
    const scenes = []; let cur = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const t = stripMd(raw); if (!t) continue;
      if (/^TITLE\s*:/i.test(t)) { title = t.replace(/^TITLE\s*:\s*/i, '').slice(0, 120); continue; }
      if (/^VOICE\s*:/i.test(t)) { voice = t.replace(/^VOICE\s*:\s*/i, '').slice(0, 500); continue; }
      if (/^SCENE\s+\d+/i.test(t)) { if (cur) scenes.push(cur); cur = { imagePrompt: '', videoPrompt: '', speech: '', caption: '' }; continue; }
      if (!cur) continue;
      if (/^IMAGE\s*:/i.test(t)) cur.imagePrompt += (cur.imagePrompt ? '\n' : '') + t.replace(/^IMAGE\s*:\s*/i, '');
      else if (/^VIDEO\s*:/i.test(t)) cur.videoPrompt += (cur.videoPrompt ? '\n' : '') + t.replace(/^VIDEO\s*:\s*/i, '');
      else if (/^SPEECH\s*:/i.test(t)) cur.speech += (cur.speech ? ' ' : '') + t.replace(/^SPEECH\s*:\s*/i, '');
      else if (/^CAPTION\s*:/i.test(t)) cur.caption += (cur.caption ? ' ' : '') + t.replace(/^CAPTION\s*:\s*/i, '');
    }
    if (cur) scenes.push(cur);
    const topic = String(setup?.topic || 'a story');
    while (scenes.length < count) scenes.push({ imagePrompt: '', videoPrompt: '', speech: '', caption: '' });
    const out = scenes.slice(0, count).map((s, i) => {
      let img = String(s.imagePrompt || '').trim();
      let vid = String(s.videoPrompt || '').trim();
      if (img.length < 60) img = (img + ' ' + topic + ', cinematic composition, detailed environment and expressive subject.').trim();
      if (!/OPENING STATE/i.test(vid)) vid = 'OPENING STATE: the scene opens on the established setting. ' + vid;
      if (!/TIMELINE/i.test(vid)) vid += '\nTIMELINE: the subject acts through the beat with natural camera movement.';
      return { id: 'scene_' + String(i + 1).padStart(3, '0'), durationSeconds: dur, imagePrompt: img.slice(0, 8000),
        videoPrompt: vid.slice(0, 8000), speech: String(s.speech || '').slice(0, 1500),
        caption: String(s.caption || '').slice(0, 1000), references: [] };
    });
    return { __localStub: true, title: title || topic.slice(0, 120), assets: [], scenes: out,
      voice: voice || 'One consistent narrator voice across all scenes.', setup: setup || {} };
  }

  async function produce(kind, setup, opts = {}) {
    const text = await ask(buildPrompt(kind, setup), opts);
    if (kind === 'topics') { const topics = parseTopics(text); if (topics.length < 2) throw Error('The AI did not return usable story ideas. Try a different platform or retry.'); return { topics }; }
    if (kind === 'hooks') { const hooks = parseHooks(text); if (hooks.length < 3) throw Error('The AI did not return 3 opening hooks. Try a different platform or retry.'); return { hooks }; }
    const project = parseProject(text, setup);
    if (!project.scenes.length) throw Error('The AI did not return a usable story package. Try a different platform or retry.');
    return { project };
  }

  // ---------- job shim: same {id,jobId,kind,state} + poll contract the server used ----------
  const jobs = new Map();
  function handles(route, payload) {
    return route === '/builder/jobs' && payload !== undefined
      || /^\/builder\/jobs\/[^/]+$/.test(route)
      || /^\/builder\/jobs\/[^/]+\/cancel$/.test(route);
  }
  function handleRequest(route, payload) {
    if (route === '/builder/jobs') {
      const id = 'bb_' + crypto.randomUUID();
      const kind = payload?.kind || 'project';
      const job = { id, jobId: id, kind, state: 'running' }; // generation starts immediately, so the progress bar animates at once
      jobs.set(id, job);
      (async () => {
        try {
          job.state = 'running';
          const started = Date.now();
          const result = await produce(kind, payload?.setup || {}, {
            started, onStatus: (t) => { job.detail = t; }, shouldStop: () => { if (job.state === 'cancelled') throw Error('Cancelled'); },
          });
          Object.assign(job, result, { state: 'finished' });
        } catch (e) { job.state = 'failed'; job.error = e?.message || String(e); }
      })();
      return { id, jobId: id, kind, state: 'queued' };
    }
    const m = route.match(/^\/builder\/jobs\/([^/]+)(?:\/cancel)?$/);
    if (!m) return { state: 'failed', error: 'Unknown builder job route.' };
    const job = jobs.get(m[1]);
    if (!job) return { state: 'failed', error: 'Unknown builder job.' };
    if (/\/cancel$/.test(route)) { job.state = 'cancelled'; return { state: 'cancelled' }; }
    return { id: job.id, jobId: job.id, kind: job.kind, state: job.state,
      topics: job.topics, hooks: job.hooks, project: job.project, error: job.error, detail: job.detail };
  }

  function pg_bb_metaNewChat() {
    const btn = document.querySelector('a[data-testid="new-chat-button"], [data-testid="new-chat-button"], button[aria-label*="New chat" i], [aria-label*="New chat" i]');
    if (!btn) return { ok: false };
    btn.click(); return { ok: true };
  }

  // ---------- Video → Story with Meta AI (Facebook video analysis) ----------
  // Reuses VideoReverse's parsing/validation helpers but drives a Meta AI tab for upload + asking.
  async function reverseWithMetaAI(file, options = {}) {
    const { onStatus = () => {}, signal = null } = options;
    const VR = globalThis.VideoReverse;
    if (!VR || typeof VR.parseBatch !== 'function' || typeof VR.buildRecords !== 'function')
      throw Error('The Video Reverse helpers are not loaded on this page.');
    const B = globalThis.FacelessBuilder;
    VR.validateVideo(file);
    const alive = () => { if (signal?.aborted) throw Error('Video → Story cancelled.'); if (typeof running !== 'undefined' && running) throw Error('A generation queue is running; wait for it to finish.'); };

    // Load the analyzer/builder instructions from our local server (same endpoint the Gemini flow uses).
    onStatus('Loading video instructions…');
    const conn = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    const resp = await remoteRepairRequest(conn, '/builder/video-reverse?lengths=mixed');
    const instr = resp.body || {};
    if (typeof instr.analyzer !== 'string' || instr.analyzer.length < 1000 || typeof instr.builder !== 'string' || instr.builder.length < 1000)
      throw Error('Video → Story instructions did not load. Check the local server.');
    const nextPrompt = instr.next || 'Continue: ONE fenced json block in the same shape, only new cards in assets, continuing scene ids, done true only on the last batch.';

    // Open (or create) a Meta AI tab.
    let tab = await chrome.tabs.query({}).then(tabs => tabs.find(t => /^https:\/\/(?:www\.)?meta\.ai(?:\/|$)/i.test(t.url || '')));
    if (!tab) tab = await chrome.tabs.create({ url: 'https://www.meta.ai/', active: true });
    else await chrome.tabs.update(tab.id, { active: true });
    await waitForTabComplete(tab.id, 60000).catch(() => {});
    let hasInput = false;
    for (const until = Date.now() + 20000; Date.now() < until;) {
      hasInput = await exec(tab.id, pg_bb_metaFindComposer, [], 'MAIN').then(el => !!el).catch(() => false);
      if (hasInput) break;
      await sleep(1000);
    }
    if (!hasInput) throw Error('Meta AI composer not found. Log in at meta.ai in Chrome and allow uploads, then retry.');

    // Start a fresh chat so no stale attachment/conversation blocks the upload ("only one video at a time").
    onStatus('Starting a fresh Meta AI chat…');
    await exec(tab.id, pg_bb_metaNewChat, [], 'MAIN').catch(() => {});
    await sleep(2500);
    for (const until = Date.now() + 15000; Date.now() < until;) {
      hasInput = await exec(tab.id, pg_bb_metaFindComposer, [], 'MAIN').then(el => !!el).catch(() => false);
      if (hasInput) break;
      await sleep(1000);
    }

    const target = { tabId: tab.id }; let attached = false;
    const b64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      alive();
      // After starting a fresh chat there must be NO attached video. Upload the file and wait for the thumbnail to
      // actually appear before analysing — never reuse a stale thumbnail from a previous chat.
      onStatus('Uploading the video to Meta AI…');
      const att = await exec(tab.id, pg_bb_metaAttach, [{ name: file.name || 'video.mp4', base64: b64, type: file.type || 'video/mp4' }], 'MAIN');
      if (!att?.ok) throw Error('Meta AI did not accept the video (' + (att?.error || 'attach failed') + ').');
      let st0 = null;
      for (const until = Date.now() + 300000; Date.now() < until;) {
        await sleep(3000); alive();
        st0 = await exec(tab.id, pg_bb_metaReverseState, [], 'MAIN');
        if (st0.chipsReady >= 1 && !st0.chipsBusy) break;
        onStatus('Uploading the video… ' + (st0.chipsBusy ? 'processing' : 'waiting for the video thumbnail'));
      }
      if (!(st0 && st0.chipsReady >= 1 && !st0.chipsBusy)) throw Error('The video upload to Meta AI did not finish in time. Try a smaller file.');
      onStatus('Video attached. Asking the analyser…');

      // One question: type via the React-compatible native setter, click Send, then wait for the whole answer.
      const askOnce = async (text, label, minLength = 0) => {
        alive();
        const askStart = Date.now();
        const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
        onStatus('Pasting the question into Meta AI…');
        const editor = await metaTypeVerified(tab, target, pg_bb_metaType, text, sleep, exec);
        if (!editor.replace(/\s+/g, ' ').includes(probe))
          throw Error('Meta AI: the question did not appear in the composer (got "' + editor.slice(0, 60) + '"). Try Gemini.');
        onStatus(label + ' · question typed, sending…');
        const beforeSend = await exec(tab.id, pg_bb_metaReverseState, [], 'MAIN');
        // Send: page-level button click first (React responds to it), then CDP coordinate click, then Enter.
        let sent = false;
        let lastErr = '';
        for (const until = Date.now() + 30000; Date.now() < until;) {
          await sleep(1000); alive();
          const s = await exec(tab.id, pg_bb_metaReverseState, [], 'MAIN');
          const hasUserMsg = (s.userMsgs || []).some(m => m.replace(/\s+/g, ' ').includes(probe));
          if (s.busy || hasUserMsg || (s.answered && !(s.editorText || '').trim())) { sent = true; break; }
          const clicked = await exec(tab.id, pg_bb_metaSend, [], 'MAIN').catch(() => ({ ok: false }));
          if (clicked.ok) { lastErr = 'page-click sent'; continue; }
          if (s.sendPoint) await flowCdpClick(tab.id, s.sendPoint.x, s.sendPoint.y, true);
          else {
            await exec(tab.id, () => { const c = document.querySelector('input[aria-label*="Ask Meta" i], input[placeholder*="Ask Meta" i], textarea[placeholder*="Ask Meta" i], div[contenteditable="true"][role="textbox"]'); if (c) c.focus(); return true; }, [], 'MAIN');
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          }
          lastErr = 'editorText=' + String(s.editorText || '').slice(0, 40) + ' sendPoint=' + !!s.sendPoint + ' busy=' + s.busy + ' pageClick=' + clicked.ok;
        }
        if (!sent) throw Error('Meta AI did not accept the question (' + lastErr + '). Try Gemini.');
        onStatus('Meta AI is thinking — watching the video and writing the record…');
        let stable = 0, last = -1;
        for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
          await sleep(3500); alive();
          // Read ONLY the assistant reply after our question (excludes our own prompt, which contains "END OF RECORD").
          const s = await metaReplyText(tab, probe);
          if (s.text && s.text.length >= minLength) {
            const markerDone = /END OF RECORD/i.test(s.text) || /^DONE\s*:/im.test(s.text) || /^SCENE\s+1/im.test(s.text) || /"scenes"/.test(s.text);
            stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
            if (stable >= 2 && markerDone) return { text: s.text, codes: s.codes || [] };
          }
          onStatus(label + ' · ' + Math.round((Date.now() - askStart) / 1000) + 's');
        }
        throw Error('Meta AI did not finish: ' + label);
      };

      onStatus('Meta AI is watching the video and writing the record…');
      let answer = await askOnce(instr.analyzer, 'Meta AI is analysing the video', 400);
      if (answer.text.length < 400) throw Error('Meta AI did not analyse the video: ' + answer.text.slice(0, 200));

      // Reversed videos are always niche 34 (TAGALOG DRAMA) with mixed scene lengths. The validator requires each scene's
      // videoPrompt to START with the exact heading "TAGALOG DRAMA — <N>-SECOND SCENE". Force it regardless of what Meta wrote.

      const batches = [];
      const known = () => VR.mergeBatches(batches);
      let n = 1;
      for (; n <= 15; n++) {
        const prompt = n === 1 ? (instr.builder + '\n\n' + (VR.AUTOMATION || '')) : nextPrompt;
        answer = await askOnce(prompt, 'Meta AI is writing scenes · batch ' + n);
        let batch = parseTextBatch(answer.text);
        if (!batch.scenes.length) throw Error('Meta AI did not return a valid story batch. Try again.');
        batch = fixHeadings(batch);
        const problems = VR.sceneProblems ? VR.sceneProblems(batch, known(), B) : [];
        if (problems.length && VR.promptWarnings) {
          const extra = VR.promptWarnings(batch, known());
          answer = await askOnce('Fix ONLY these problems in your last story batch. Keep the SAME plain-text format (TITLE/VOICE/ASSET/SCENE/DURATION/IMAGE/VIDEO/SPEECH/CAPTION/REFERENCES/DONE), keep every spoken word verbatim, and re-send the WHOLE batch:\n- ' + problems.concat(extra).join('\n- '), 'Meta AI is fixing batch ' + n);
          const fixed = parseTextBatch(answer.text); batches.push(fixed.scenes.length ? fixHeadings(fixed) : batch);
        } else batches.push(batch);
        onStatus('Batch ' + n + ' ready · ' + known().scenes.length + ' scenes so far');
        if (batch.done) break;
      }
      const records = VR.buildRecords(known(), B);
      onStatus('Story ready. Meta AI chat left open.');
      return records;
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  // Parse Meta's PLAIN-TEXT story package into a batch object (both video flows share this).
  function parseTextBatch(text) {
    const lines = String(text || '').split(/\r?\n/);
    const clean = (s) => String(s || '').trim();
    let title = '', voice = '', done = false;
    const assets = [], scenes = []; let cur = null;
    for (const raw of lines) {
      const t = clean(raw); if (!t) continue;
      if (/^TITLE\s*:/i.test(t)) { title = t.replace(/^TITLE\s*:\s*/i, '').slice(0, 120); continue; }
      if (/^VOICE\s*:/i.test(t)) { voice = t.replace(/^VOICE\s*:\s*/i, '').slice(0, 500); continue; }
      let m;
      if ((m = t.match(/^ASSET\s+(asset_\d+)\s*:\s*([\s\S]*)$/i))) { assets.push({ id: m[1], imagePrompt: m[2].trim() }); continue; }
      if ((m = t.match(/^ASSET\s*:\s*([\s\S]*)$/i))) { assets.push({ id: 'asset_' + String(assets.length + 1).padStart(3, '0'), imagePrompt: m[1].trim() }); continue; }
      if (/^DONE\s*:/i.test(t)) { done = /yes|true|1|done/i.test(t.replace(/^DONE\s*:\s*/i, '')); continue; }
      if (/^SCENE\s+\d+/i.test(t)) { if (cur) scenes.push(cur); cur = { durationSeconds: 8, imagePrompt: '', videoPrompt: '', speech: '', caption: '', references: [] }; continue; }
      if (!cur) continue;
      if (/^DURATION\s*:/i.test(t)) cur.durationSeconds = Number(t.replace(/^DURATION\s*:\s*/i, '')) || 8;
      else if (/^IMAGE\s*:/i.test(t)) cur.imagePrompt += (cur.imagePrompt ? '\n' : '') + t.replace(/^IMAGE\s*:\s*/i, '');
      else if (/^VIDEO\s*:/i.test(t)) cur.videoPrompt += (cur.videoPrompt ? '\n' : '') + t.replace(/^VIDEO\s*:\s*/i, '');
      else if (/^SPEECH\s*:/i.test(t)) cur.speech += (cur.speech ? ' ' : '') + t.replace(/^SPEECH\s*:\s*/i, '');
      else if (/^CAPTION\s*:/i.test(t)) cur.caption += (cur.caption ? ' ' : '') + t.replace(/^CAPTION\s*:\s*/i, '');
      else if (/^REFERENCES\s*:/i.test(t)) cur.references = t.replace(/^REFERENCES\s*:\s*/i, '').split(/[,\s]+/).map(x => x.trim()).filter(x => /^asset_\d+$/.test(x));
    }
    if (cur) scenes.push(cur);
    return { title, voice, assets, scenes, done };
  }
  // Reversed videos are always niche 34 (TAGALOG DRAMA) with mixed lengths; validator requires this exact heading.
  function fixHeadings(batch) {
    if (!batch || !Array.isArray(batch.scenes)) return batch;
    for (const s of batch.scenes) {
      const n = Math.max(1, Number(s.durationSeconds) || 8);
      const heading = 'TAGALOG DRAMA — ' + n + '-SECOND SCENE';
      const lines = String(s.videoPrompt || '').replace(/\r/g, '').split('\n');
      if (lines.length && (/SECOND SCENE/i.test(lines[0]) || /^OPENING STATE/i.test(lines[0].trim()))) lines.shift();
      s.videoPrompt = heading + '\n' + lines.join('\n').trim();
    }
    return batch;
  }

  // Video → Story from a Facebook (or any) VIDEO LINK. No file upload: Meta AI fetches the link itself, which is far more
  // reliable than uploading. Reuses VideoReverse's parsing/validation/build helpers exactly like the upload path.
  async function reverseWithMetaLink(link, options = {}) {
    const { onStatus = () => {}, signal = null } = options;
    const VR = globalThis.VideoReverse, B = globalThis.FacelessBuilder;
    if (!VR || typeof VR.parseBatch !== 'function' || typeof VR.buildRecords !== 'function')
      throw Error('The Video Reverse helpers are not loaded on this page.');
    const alive = () => { if (signal?.aborted) throw Error('Video → Story cancelled.'); if (typeof running !== 'undefined' && running) throw Error('A generation queue is running; wait for it to finish.'); };

    onStatus('Loading video instructions…');
    const conn = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    const resp = await remoteRepairRequest(conn, '/builder/video-reverse?lengths=mixed');
    const instr = resp.body || {};
    if (typeof instr.analyzer !== 'string' || instr.analyzer.length < 1000 || typeof instr.builder !== 'string' || instr.builder.length < 1000)
      throw Error('Video → Story instructions did not load. Check the local server.');
    const nextPrompt = instr.next || 'Continue: ONE fenced json block, same shape, only new cards in assets, continuing scene ids, done true only on the last batch.';

    let tab = await chrome.tabs.query({}).then(tabs => tabs.find(t => /^https:\/\/(?:www\.)?meta\.ai(?:\/|$)/i.test(t.url || '')));
    if (!tab) tab = await chrome.tabs.create({ url: 'https://www.meta.ai/', active: true });
    else await chrome.tabs.update(tab.id, { active: true });
    await waitForTabComplete(tab.id, 60000).catch(() => {});
    let hasInput = false;
    for (const until = Date.now() + 20000; Date.now() < until;) {
      hasInput = await exec(tab.id, pg_bb_metaFindComposer, [], 'MAIN').then(el => !!el).catch(() => false);
      if (hasInput) break;
      await sleep(1000);
    }
    if (!hasInput) throw Error('Meta AI composer not found. Log in at meta.ai in Chrome, then retry.');

    onStatus('Starting a fresh Meta AI chat…');
    await exec(tab.id, pg_bb_metaNewChat, [], 'MAIN').catch(() => {});
    await sleep(2500);
    for (const until = Date.now() + 15000; Date.now() < until;) {
      hasInput = await exec(tab.id, pg_bb_metaFindComposer, [], 'MAIN').then(el => !!el).catch(() => false);
      if (hasInput) break;
      await sleep(1000);
    }

    const target = { tabId: tab.id }; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      alive();

      const askOnce = async (text, label, minLength = 0) => {
        alive();
        const askStart = Date.now();
        const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
        onStatus('Pasting the link and question into Meta AI…');
        const editor = await metaTypeVerified(tab, target, pg_bb_metaType, text, sleep, exec);
        if (!editor.replace(/\s+/g, ' ').includes(probe))
          throw Error('Meta AI: the question did not appear in the composer (got "' + editor.slice(0, 60) + '"). Try a different browser.');
        onStatus(label + ' · question typed, sending…');
        const beforeSend = await exec(tab.id, pg_bb_metaReverseState, [], 'MAIN');
        let sent = false, lastErr = '';
        for (const until = Date.now() + 30000; Date.now() < until;) {
          await sleep(1000); alive();
          const s = await exec(tab.id, pg_bb_metaReverseState, [], 'MAIN');
          const hasUserMsg = (s.userMsgs || []).some(m => m.replace(/\s+/g, ' ').includes(probe));
          if (s.busy || hasUserMsg || (s.answered && !(s.editorText || '').trim())) { sent = true; break; }
          const clicked = await exec(tab.id, pg_bb_metaSend, [], 'MAIN').catch(() => ({ ok: false }));
          if (!clicked.ok && s.sendPoint) await flowCdpClick(tab.id, s.sendPoint.x, s.sendPoint.y, true);
          lastErr = 'editorText=' + String(s.editorText || '').slice(0, 40) + ' click=' + clicked.ok + ' busy=' + s.busy;
        }
        if (!sent) throw Error('Meta AI did not accept the question (' + lastErr + '). Try a different browser.');
        onStatus('Meta AI is thinking — watching the video and writing the record…');
        let stable = 0, last = -1;
        for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
          await sleep(3500); alive();
          // Read ONLY the assistant reply after our question (excludes our own prompt, which contains "END OF RECORD").
          const s = await metaReplyText(tab, probe);
          if (s.text && s.text.length >= minLength) {
            const markerDone = /END OF RECORD/i.test(s.text) || /^DONE\s*:/im.test(s.text) || /^SCENE\s+1/im.test(s.text) || /"scenes"/.test(s.text);
            stable = s.text.length === last ? stable + 1 : 0; last = s.text.length;
            if (stable >= 2 && markerDone) return { text: s.text, codes: s.codes || [] };
          }
          onStatus(label + ' · ' + Math.round((Date.now() - askStart) / 1000) + 's');
        }
        throw Error('Meta AI did not finish: ' + label);
      };

      // Parse the PLAIN-TEXT package Meta wrote (the builder prompt asks for labelled lines, never JSON).
      // Send the link with a video-analysis instruction. Replace the "attached video" wording with the link.
      const analyzerWithLink = instr.analyzer.replace(/A video has been attached to this chat\./i,
        'Watch and analyse this video, which I am sharing as a link: ' + link + '\nIf you can open it, follow it exactly as instructed below.');
      onStatus('Meta AI is watching the video from the link and writing the record…');
      let answer = await askOnce(analyzerWithLink, 'Meta AI is analysing the video', 400);
      if (answer.text.length < 400) throw Error('Meta AI could not analyse the link: ' + answer.text.slice(0, 200));

      const batches = [];
      const known = () => VR.mergeBatches(batches);
      let n = 1;
      for (; n <= 15; n++) {
        const prompt = n === 1 ? (instr.builder + '\n\n' + (VR.AUTOMATION || '')) : nextPrompt;
        answer = await askOnce(prompt, 'Meta AI is writing scenes · batch ' + n);
        let batch = parseTextBatch(answer.text);
        if (!batch.scenes.length) throw Error('Meta AI did not return a valid story batch. Try again.');
        batch = fixHeadings(batch);
        const problems = VR.sceneProblems ? VR.sceneProblems(batch, known(), B) : [];
        if (problems.length && VR.promptWarnings) {
          const extra = VR.promptWarnings(batch, known());
          answer = await askOnce('Fix ONLY these problems in your last story batch. Keep the SAME plain-text format (TITLE/VOICE/ASSET/SCENE/DURATION/IMAGE/VIDEO/SPEECH/CAPTION/REFERENCES/DONE), keep every spoken word verbatim, and re-send the WHOLE batch:\n- ' + problems.concat(extra).join('\n- '), 'Meta AI is fixing batch ' + n);
          const fixed = parseTextBatch(answer.text); batches.push(fixed.scenes.length ? fixHeadings(fixed) : batch);
        } else batches.push(batch);
        onStatus('Batch ' + n + ' ready · ' + known().scenes.length + ' scenes so far');
        if (batch.done) break;
      }
      const records = VR.buildRecords(known(), B);
      onStatus('Story ready. Meta AI chat left open.');
      return records;
    } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
  }

  loadPlatform().then(() => say('Builder tasks use ' + platform + '.'));
  globalThis.BuilderBrain = { getPlatform, setPlatform, mountPicker, ask, handles, handleRequest, platforms: PLATFORMS, reverseWithMetaAI, reverseWithMetaLink };
})();
