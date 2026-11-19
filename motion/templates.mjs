// Motion Studio templates (owner 2026-11-12): ready motion clips from our server (server/motion-templates.cjs), our
// own generations of trending moves. The download icon fetches the clip straight into Motion Studio as the source video;
// a clip already fetched once is kept in this browser (Cache Storage) and checked against its sha256.
const CACHE = 'oxmotion-templates-v1';
const DEFAULT_BASE = 'https://repair.corethea.com';

export async function serverBase(storage = globalThis.chrome?.storage?.local) {
  let url = '';
  try { url = (await storage?.get('remoteRepairUrl'))?.remoteRepairUrl || ''; } catch {}
  try { const u = new URL(String(url).trim()); if (u.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(u.hostname)) return u.href.replace(/\/+$/, ''); } catch {}
  return DEFAULT_BASE;
}

export async function loadTemplates({base, fetchImpl = fetch} = {}) {
  const r = await fetchImpl(base + '/motion/templates', {cache: 'no-store', credentials: 'omit'});
  if (r.status === 404) return [];   // an older server without templates
  if (!r.ok) throw Error('Templates could not load (HTTP ' + r.status + ').');
  const list = (await r.json())?.templates;
  return Array.isArray(list) ? list.filter(t => t && typeof t.id === 'string' && typeof t.video === 'string' && /^\/motion\/templates\//.test(t.video)) : [];
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// -> File (video/mp4) named after the template. onProgress(0..1) while downloading.
export async function templateFile(t, {base, fetchImpl = fetch, caches = globalThis.caches, onProgress = () => {}} = {}) {
  const url = base + t.video, key = url + '?sha=' + t.sha256;
  const cache = caches ? await caches.open(CACHE).catch(() => null) : null;
  let blob = null;
  const hit = await cache?.match(key).catch(() => null);
  if (hit) { blob = await hit.blob(); if (hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())) !== t.sha256) { blob = null; await cache.delete(key).catch(() => {}); } }
  if (!blob) {
    const r = await fetchImpl(url, {credentials: 'omit', cache: 'no-store'});
    if (!r.ok) throw Error('The template could not download (HTTP ' + r.status + '). Try again.');
    const total = Number(r.headers.get('content-length')) || t.size || 0, parts = [];
    if (r.body?.getReader) {
      const reader = r.body.getReader(); let got = 0;
      for (;;) { const {done, value} = await reader.read(); if (done) break; parts.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total)); }
      blob = new Blob(parts, {type: 'video/mp4'});
    } else blob = new Blob([await r.arrayBuffer()], {type: 'video/mp4'});
    if (hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())) !== t.sha256) throw Error('The template download was damaged. Try again.');
    await cache?.put(key, new Response(blob, {headers: {'Content-Type': 'video/mp4'}})).catch(() => {});
    // An older version of the same template (it was remade, e.g. with its sound) is dropped from this browser.
    for (const old of await cache?.keys().catch(() => []) || []) if (old.url.startsWith(url + '?sha=') && old.url !== new URL(key).href) await cache.delete(old).catch(() => {});
  }
  onProgress(1);
  const name = String(t.title || t.id).replace(/[^\w .-]+/g, '').trim().slice(0, 60) || t.id;
  return new File([blob], name + '.mp4', {type: 'video/mp4', lastModified: Date.parse(t.added || '') || 0});
}

// Renders the grid into `root`. onUse(template) is called by the download icon.
export function renderTemplates(root, list, {base, onUse, busy = () => false}) {
  root.replaceChildren();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  if (!list.length) {
    const empty = el('div', 'tpl-empty');
    empty.append(el('strong', null, 'No templates yet'), el('small', null, 'Ready motion clips will appear here. You can still use your own video in the Source tab.'));
    root.append(empty); return;
  }
  const tags = ['All', ...new Set(list.map(t => t.tag).filter(Boolean))];
  const bar = el('div', 'tpl-tags'), grid = el('div', 'tpl-grid');
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Template groups');
  let pick = 'All';
  const draw = () => {
    for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.tag === pick));
    grid.replaceChildren(...list.filter(t => pick === 'All' || t.tag === pick).map(card));
  };
  for (const tag of tags.length > 2 ? tags : []) { const b = el('button', null, tag); b.type = 'button'; b.dataset.tag = tag; b.onclick = () => { pick = tag; draw(); }; bar.append(b); }
  function card(t) {
    const c = el('article', 'tpl-card'), media = el('div', 'tpl-media'), img = el('img'), info = el('div', 'tpl-info'), use = el('button', 'tpl-use', '⬇');
    img.src = base + t.thumb; img.alt = ''; img.loading = 'lazy'; img.onerror = () => img.remove(); media.append(img);
    // A short silent loop plays while the pointer rests on the card.
    let video = null;
    c.addEventListener('pointerenter', () => { if (video) return; video = el('video'); Object.assign(video, {muted: true, loop: true, playsInline: true, src: base + t.preview}); video.setAttribute('aria-hidden', 'true'); media.append(video); video.play().catch(() => {}); });
    c.addEventListener('pointerleave', () => { video?.remove(); video = null; });
    const words = el('div');
    words.append(el('strong', null, t.title), el('small', null, [t.tag, Math.round(t.seconds) + ' s', t.width && t.height ? (t.width >= t.height ? '16:9' : '9:16') : ''].filter(Boolean).join(' · ')));
    use.type = 'button'; use.title = 'Use this template as the source video'; use.setAttribute('aria-label', 'Use template ' + t.title);
    use.onclick = async () => { if (busy()) return; use.disabled = true; c.classList.add('loading'); try { await onUse(t, p => c.style.setProperty('--p', Math.round(p * 100) + '%')); } finally { use.disabled = false; c.classList.remove('loading'); c.style.removeProperty('--p'); } };
    info.append(words, use); c.append(media, info);
    return c;
  }
  root.append(...(bar.children.length ? [bar] : []), grid);
  draw();
}
