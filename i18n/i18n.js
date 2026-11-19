// 0xFlow interface language (owner 2026-11-04: a member asked for Thai; option A = static interface text only).
// Display-only layer: it swaps the visible text, tooltips and placeholders of 0xFlow's own pages when the English text matches
// a dictionary entry exactly (or a {placeholder} pattern). It never touches prompts, logs, story text or anything typed into a
// field, never changes element values or ids, and never runs on Flow, Gemini, ChatGPT or Grok pages. English stays the source:
// switching back restores the original text. Logs, errors and live progress messages stay in English.
(() => {
  'use strict';
  if (globalThis.oxI18n) return;
  const LANGS = {en:'English',th:'ไทย (Thai)',bn:'বাংলা (Bangla)',vi:'Tiếng Việt', 'zh-Hans':'简体中文',ko:'한국어',ja:'日本語',es:'Español',ro:'Română'};
  const dictionaryLoads = new Map();
  let languageRevision = 0;
  function loadDictionary(code) {
    if (code === 'en' || dicts()[code]) return Promise.resolve();
    if (!LANGS[code]) return Promise.resolve();
    if (!dictionaryLoads.has(code)) dictionaryLoads.set(code, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = globalThis.chrome?.runtime?.getURL?.('i18n/' + code + '.js') || 'i18n/' + code + '.js';
      script.onload = () => dicts()[code] ? resolve() : reject(Error('Language dictionary unavailable'));
      script.onerror = () => { script.remove(); dictionaryLoads.delete(code); reject(Error('Language dictionary unavailable')); };
      document.head.append(script);
    }));
    return dictionaryLoads.get(code);
  }
  async function activate(code) {
    const revision = ++languageRevision;
    try { await loadDictionary(code); } catch { code = 'en'; }
    if (revision === languageRevision) apply(code);
  }
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  // Containers whose text is the member's own content or diagnostic output.
  const SKIP = 'script,style,textarea,pre,code,[contenteditable="true"],[contenteditable=""],[data-no-i18n],#log,#logs,#debugLog,.scene-source-text,.project-source-title';
  const dicts = () => globalThis.OXFLOW_I18N || {};
  let lang = 'en', exact = null, patterns = [], active = false;
  const textRec = new WeakMap();                       // text node -> {src, out}
  const attrRec = new WeakMap();                       // element -> {[attr]: {src, out}}
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function compile(d) {
    exact = d?.exact || null;
    patterns = Object.entries(d?.patterns || {}).map(([key, value]) => {
      const names = [];
      const re = new RegExp('^' + key.split(/\{(\w+)\}/).map((part, i) => i % 2 ? (names.push(part), '(.+?)') : esc(part)).join('') + '$');
      return {re, names, value};
    });
  }
  function lookup(key) {
    if (!exact || !key) return null;
    if (Object.prototype.hasOwnProperty.call(exact, key)) return exact[key];
    for (const p of patterns) {
      const m = key.match(p.re);
      // A captured part that is itself a dictionary entry ("64 templates · All") is translated too.
      if (m) return p.value.replace(/\{(\w+)\}/g, (all, n) => { const i = p.names.indexOf(n); if (i < 0) return all; const v = m[i + 1]; return Object.prototype.hasOwnProperty.call(exact, v) ? exact[v] : v; });
    }
    return null;
  }
  function translate(s) {
    const value = lookup(norm(s));
    if (value == null) return null;
    return s.match(/^\s*/)[0] + value + s.match(/\s*$/)[0];
  }
  const skipped = el => !el || !!el.closest(SKIP);
  // Attributes are interface hints even on a text box (its placeholder), so only an explicit opt-out skips them.
  const attrSkipped = el => !el || !!el.closest('[data-no-i18n]');

  function doText(node) {
    if (skipped(node.parentElement)) return;
    const option = node.parentElement?.closest('option');
    if (option && !option.hasAttribute('value')) option.setAttribute('value', option.value);
    const rec = textRec.get(node), cur = node.nodeValue;
    const src = rec && cur === rec.out ? rec.src : cur;      // code may have set new text since our last write
    const out = active ? translate(src) : null;
    if (out == null) { if (rec && cur === rec.out) node.nodeValue = rec.src; textRec.delete(node); return; }
    textRec.set(node, {src, out});
    if (cur !== out) node.nodeValue = out;
  }
  function doAttr(el, attr) {
    if (!ATTRS.includes(attr) || attrSkipped(el)) return;
    const recs = attrRec.get(el) || {}, rec = recs[attr], cur = el.getAttribute(attr);
    if (cur == null) { delete recs[attr]; return; }
    const src = rec && cur === rec.out ? rec.src : cur;
    const out = active ? translate(src) : null;
    if (out == null) { if (rec && cur === rec.out) el.setAttribute(attr, rec.src); delete recs[attr]; attrRec.set(el, recs); return; }
    recs[attr] = {src, out}; attrRec.set(el, recs);
    if (cur !== out) el.setAttribute(attr, out);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) doText(n);
    const els = root.querySelectorAll ? root.querySelectorAll('[title],[placeholder],[aria-label]') : [];
    if (root.nodeType === 1) for (const a of ATTRS) if (root.hasAttribute(a)) doAttr(root, a);
    for (const el of els) for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
  }

  let observer = null;
  function observe() {
    if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
    observer = new MutationObserver(list => {
      if (!active) return;
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
        else for (const n of m.addedNodes) walk(n);
      }
    });
    observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS});
  }

  function detect() {
    let ui = '';
    try { ui = globalThis.chrome?.i18n?.getUILanguage?.() || ''; } catch {}
    ui = String(ui || globalThis.navigator?.language || '').toLowerCase();
    if (/^zh(?:-|$)/.test(ui)) return 'zh-Hans';
    const base = ui.split(/[-_]/)[0];
    return LANGS[base] ? base : 'en';
  }
  function apply(next) {
    const d = dicts();
    lang = next && next !== 'en' && d[next] ? next : 'en';
    active = lang !== 'en';
    compile(active ? d[lang] : null);
    try { document.documentElement.lang = lang; } catch {}
    observe();
    walk(document.body);                                 // translate, or restore English when switching back
    try { document.dispatchEvent(new CustomEvent('oxflow-language', {detail: {lang}})); } catch {}
  }
  async function stored() {
    try { return (await globalThis.chrome?.storage?.local?.get?.('uiLanguage'))?.uiLanguage || null; } catch { return null; }
  }
  // Any <select data-ox-language> on a 0xFlow page is a language picker: "auto" follows Chrome's language.
  function bindPickers(saved) {
    for (const sel of document.querySelectorAll('select[data-ox-language]')) {
      sel.value = saved && LANGS[saved] ? saved : 'auto';
      if (sel.dataset.oxBound) continue;
      sel.dataset.oxBound = '1';
      sel.addEventListener('change', async () => {
        if (sel.value === 'auto') { try { await globalThis.chrome.storage.local.remove('uiLanguage'); } catch {} await activate(detect()); }
        else await globalThis.oxI18n.setLanguage(sel.value);
      });
    }
  }
  async function start() {
    const saved = await stored();
    bindPickers(saved);
    await activate(saved || detect());
    try {
      globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
        if (area === 'local' && changes.uiLanguage) { bindPickers(changes.uiLanguage.newValue); void activate(changes.uiLanguage.newValue || detect()); }
      });
    } catch {}
  }

  globalThis.oxI18n = {
    LANGS,
    get lang() { return lang; },
    // Saving the choice updates every open 0xFlow page through storage.onChanged.
    async setLanguage(next) {
      const value = LANGS[next] ? next : 'en';
      try { await globalThis.chrome.storage.local.set({uiLanguage: value}); } catch {}
      bindPickers(value);
      await activate(value);
    },
    async savedLanguage() { return (await stored()) || null; },
    t(s) { return active ? (lookup(norm(s)) ?? s) : s; },
    _test: {translate: s => translate(s), apply, walk, detect},
  };
  if (typeof document === 'undefined') return;
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, {once: true});
})();
