// AI upscale for small storyboard-sheet frames (owner 2026-10-25). ChatGPT sheet frames are ~469x833 and their videos came
// out about 4x softer than videos from normal images; Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause) on the frame brought
// them to normal-image sharpness in the owner's Flow test. Runs locally with TensorFlow.js (WebGL), nothing is uploaded.
// The bundled file holds two models: x4v3 (smoothing) and wdn-x4v3 (keeps texture); a "look" mixes them like
// Real-ESRGAN's own denoise strength: natural 0, balanced 0.5, sharp 1.
export const LOOKS = Object.freeze({natural: 0, balanced: 0.5, sharp: 1});
const TF_URL = new URL('../vendor/tf-4.22.0.min.js', import.meta.url).href;
const MODEL_URL = new URL('../assets/upscale/realesr-general-x4v3-pair.f16', import.meta.url).href;
const MANIFEST_URL = new URL('../assets/upscale/realesr-general-x4v3-pair.json', import.meta.url).href;
// Small tiles plus a short pause after each keep the PC responsive (owner 2026-10-25: 160 px tiles back to back took the
// GPU for ~2 minutes and the PC lagged). 15 ms is enough for the screen; 40 ms pauses took longer than the model itself.
const TILE = 96, PAD = 8, BREATHE_MS = 15;

let tfReady = null, modelReady = null;
const networks = new Map();

function loadTf() {
  if (globalThis.tf?.conv2d) return Promise.resolve(globalThis.tf);
  return tfReady ||= new Promise((resolve, reject) => {
    // TensorFlow.js runs `regeneratorRuntime = r` in strict mode; without an existing global it falls back to Function(),
    // which the extension's security policy blocks, and TensorFlow stops half-loaded ("tf.getBackend is not a function",
    // owner log 2026-10-25). An existing global makes the plain assignment work.
    if (!('regeneratorRuntime' in globalThis)) globalThis.regeneratorRuntime = undefined;
    const script = document.createElement('script');
    script.src = TF_URL;
    script.onload = () => {
      if (!globalThis.tf) return reject(Error('TensorFlow.js did not start.'));
      // Half-precision textures (set before the WebGL backend starts): 37% faster on an RTX 4050 and half the GPU memory,
      // same picture (56 dB against PyTorch). Only where the card can render half floats; otherwise full precision.
      if (halfFloatRenderable()) globalThis.tf.env().set('WEBGL_FORCE_F16_TEXTURES', true);
      resolve(globalThis.tf);
    };
    script.onerror = () => { tfReady = null; reject(Error('TensorFlow.js could not be loaded.')); };
    document.head.append(script);
  });
}
function halfFloatRenderable() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    return !!gl && !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  } catch { return false; }
}
// Half-precision numbers to Float32.
export function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 31, frac = h & 1023;
    out[i] = exp === 0 ? sign * 2 ** -14 * (frac / 1024) : exp === 31 ? (frac ? NaN : sign * Infinity) : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}
// The store package leaves the 4.8 MB model out (owner 2026-10-28: smaller download). The first upscale downloads it once
// from the repair server, checks it against the fingerprint in the bundled manifest, and keeps it in the browser cache,
// so later upscales work offline. The unpacked test package still carries the file and uses it directly.
const REMOTE_MODEL_URL = 'https://repair.corethea.com/models/realesr-general-x4v3-pair.f16';
const MODEL_CACHE = 'flow-upscale-model-v1';
async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function modelBytes(manifest) {
  try { const r = await fetch(MODEL_URL); if (r.ok) { const b = await r.arrayBuffer(); if (b.byteLength === manifest.values * 4) return b; } } catch {}
  const cache = globalThis.caches ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const hit = cache && await cache.match(REMOTE_MODEL_URL).catch(() => null);
  if (hit) { const b = await hit.arrayBuffer(); if (await sha256(b) === manifest.sha256) return b; await cache.delete(REMOTE_MODEL_URL).catch(() => {}); }
  const r = await fetch(REMOTE_MODEL_URL, {cache: 'no-store'});
  if (!r.ok) throw Error('the upscale model could not be downloaded (' + r.status + ')');
  const b = await r.arrayBuffer();
  if (await sha256(b) !== manifest.sha256) throw Error('the downloaded upscale model did not match');
  if (cache) await cache.put(REMOTE_MODEL_URL, new Response(b.slice(0), {headers: {'Content-Type': 'application/octet-stream'}})).catch(() => {});
  return b;
}
// Download/read the model before timing a frame, so the one-time download is never counted as a slow PC.
export async function prepareModel() { await loadModel(); }
async function loadModel() {
  return modelReady ||= (async () => {
    const manifest = await fetch(MANIFEST_URL).then(r => r.json()), bytes = await modelBytes(manifest);
    const all = halfToFloat(new Uint16Array(bytes));
    if (all.length !== manifest.values * 2) throw Error('The upscale model file is incomplete.');
    return {manifest, smooth: all.subarray(0, manifest.values), texture: all.subarray(manifest.values)};
  })().catch(error => { modelReady = null; throw error; });
}
// Chrome can fake WebGL in software (SwiftShader) when hardware acceleration is off or the driver is blocked: that runs
// on the processor and takes many minutes per frame, so it counts as "no graphics" (owner 2026-10-25: PCs without a GPU).
function rendererName() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2') || new OffscreenCanvas(1, 1).getContext('webgl');
  if (!gl) return '';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
export function softwareGraphics() {
  try {
    const renderer = rendererName();
    if (!renderer) return 'no WebGL';
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer) ? renderer : '';
  } catch { return ''; }
}
// The graphics chip Chrome runs it on, for the log ("ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x…) Direct3D11…)"
// → "NVIDIA GeForce RTX 4050 Laptop GPU"). A laptop on battery may use its built-in chip instead, which is much slower.
export function graphicsName() {
  try {
    const r = rendererName(), m = r.match(/^ANGLE \([^,]*,\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?(?:\s+Direct3D|\s+OpenGL|\s+Vulkan|,|\)$)/i);
    return (m ? m[1] : r).trim();
  } catch { return ''; }
}
// TensorFlow warns once per session "High memory usage in GPU … most likely due to a memory leak" when a frame's working
// memory passes a limit based on the screen size. Each tile's memory is freed (upscaleFrame), so it is not a leak, but it
// showed on the extension's Errors page (owner 2026-10-30). Only that one message is hidden.
let quietGpuWarning = false;
function hideGpuMemoryWarning() {
  if (quietGpuWarning) return;
  quietGpuWarning = true;
  const warn = console.warn.bind(console);
  console.warn = (...args) => { if (/^High memory usage in GPU/.test(String(args[0] ?? ''))) return; warn(...args); };
}
// The network for one look, as TensorFlow tensors (kept for the session).
async function network(look) {
  const software = softwareGraphics();
  if (software) throw Error(`this PC has no hardware graphics for AI upscaling (${software})`);
  const tf = await loadTf();
  if (!['webgl', 'webgpu'].includes(tf.getBackend())) {
    if (!(await tf.setBackend('webgl').catch(() => false))) throw Error('This PC has no WebGL graphics for AI upscaling.');
    await tf.ready();
  }
  hideGpuMemoryWarning();
  const key = String(look);
  if (networks.has(key)) return {tf, layers: networks.get(key)};
  const {manifest, smooth, texture} = await loadModel();
  const mixed = new Float32Array(smooth.length);
  for (let i = 0; i < mixed.length; i++) mixed[i] = look * smooth[i] + (1 - look) * texture[i];
  let at = 0;
  const take = n => mixed.subarray(at, at += n);
  const layers = manifest.layers.map(l => ({
    kernel: tf.tensor4d(take(9 * l.in * l.out), [3, 3, l.in, l.out]),
    bias: tf.tensor1d(take(l.out)),
    alpha: l.prelu ? tf.tensor1d(take(l.out)) : null
  }));
  if (at !== mixed.length) throw Error('The upscale model layout does not match.');
  networks.set(key, layers);
  return {tf, layers};
}
function run(tf, layers, input) {   // input [1,h,w,3] in 0..1 -> [1,4h,4w,3]
  return tf.tidy(() => {
    let y = input;
    for (const l of layers) {
      y = tf.add(tf.conv2d(y, l.kernel, 1, 'same'), l.bias);
      if (l.alpha) y = tf.prelu(y, l.alpha);
    }
    const [, h, w] = input.shape;
    return tf.clipByValue(tf.add(tf.depthToSpace(y, 4), tf.image.resizeNearestNeighbor(input, [h * 4, w * 4])), 0, 1);
  });
}
// A short pause while the panel is visible; Chrome stretches timers in hidden pages to ~1 s, so there only a message-loop
// yield (still lets other GPU work in between the small tiles).
function breathe() {
  if (document.visibilityState === 'visible') return new Promise(resolve => setTimeout(resolve, BREATHE_MS));
  return new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(0); });
}
// Upscales a frame (canvas, ImageBitmap or OffscreenCanvas) by `scale` (2 by default) and returns a Blob.
export async function upscaleFrame(source, {look = LOOKS.balanced, scale = 2, type = 'image/png', quality} = {}) {
  const {tf, layers} = await network(look);
  const w = source.width, h = source.height;
  const read = new OffscreenCanvas(w, h), readCtx = read.getContext('2d', {willReadFrequently: true});
  readCtx.drawImage(source, 0, 0);
  const rgba = readCtx.getImageData(0, 0, w, h).data, rgb = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i] / 255; rgb[j + 1] = rgba[i + 1] / 255; rgb[j + 2] = rgba[i + 2] / 255; }
  const image = tf.tensor4d(rgb, [1, h, w, 3]);
  // 2x (the normal case): the x4 output is averaged down 2x2 on the GPU, so a quarter of the data comes back and it goes
  // straight into the final picture (no x4 canvas, no canvas resize). Any other scale: x4, then a canvas resize.
  const gpuScale = scale === 2 ? 2 : 4, outW = w * gpuScale, outH = h * gpuScale, pixels = new Uint8ClampedArray(outW * outH * 4);
  // Hidden panel (the user watches ChatGPT): bigger tiles, fewer round trips; the screen they look at is not this page.
  const tileSize = document.visibilityState === 'visible' ? TILE : TILE * 2;
  try {
    for (let y0 = 0; y0 < h; y0 += tileSize) for (let x0 = 0; x0 < w; x0 += tileSize) {
      const x1 = Math.min(w, x0 + tileSize), y1 = Math.min(h, y0 + tileSize);
      const px0 = Math.max(0, x0 - PAD), py0 = Math.max(0, y0 - PAD), px1 = Math.min(w, x1 + PAD), py1 = Math.min(h, y1 + PAD);
      const tile = tf.slice(image, [0, py0, px0, 0], [1, py1 - py0, px1 - px0, 3]);
      const out = run(tf, layers, tile);
      let core = tf.slice(out, [0, (y0 - py0) * 4, (x0 - px0) * 4, 0], [1, (y1 - y0) * 4, (x1 - x0) * 4, 3]);
      if (gpuScale === 2) { const half = tf.avgPool(core, 2, 2, 'valid'); core.dispose(); core = half; }
      // Read back synchronously: TensorFlow's async read polls with timers, which Chrome stretches to ~1 s each in a
      // background window (owner log 2026-10-25: 29 s per frame on an RTX 4050 that needs 7 s with the panel in front).
      const values = core.dataSync(), tw = (x1 - x0) * gpuScale, th = (y1 - y0) * gpuScale;
      // Uint8ClampedArray rounds and clamps by itself (adding 0.5 made half the pixels one level too bright).
      for (let yy = 0, j = 0; yy < th; yy++) {
        for (let o = ((y0 * gpuScale + yy) * outW + x0 * gpuScale) * 4, end = o + tw * 4; o < end; o += 4, j += 3) {
          pixels[o] = values[j] * 255; pixels[o + 1] = values[j + 1] * 255; pixels[o + 2] = values[j + 2] * 255; pixels[o + 3] = 255;
        }
      }
      tf.dispose([tile, out, core]);
      await breathe();   // let the GPU draw the screen in between
    }
  } finally { image.dispose(); }
  const result = new OffscreenCanvas(outW, outH);
  result.getContext('2d').putImageData(new ImageData(pixels, outW, outH), 0, 0);
  let final = result;
  if (gpuScale !== scale) {   // x4 model, then down to the wanted scale with high-quality smoothing
    final = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    const ctx = final.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(result, 0, 0, final.width, final.height);
  }
  return final.convertToBlob(quality == null ? {type} : {type, quality});
}
