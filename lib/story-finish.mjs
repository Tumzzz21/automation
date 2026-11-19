// Finish layer for Story Workspace exports (Phase 1, owner 2026-10-19): automatic subtitles from the AI Story dialogue,
// timed to the voices heard in each clip; six caption styles (Reels default since owner 2026-10-19, text only, no speaker names); hook title
// and end card; SRT export; One-click Finish presets. Pure timing + canvas drawing: nothing leaves the device.
// Reels (owner 2026-10-19, from the owner's own video): 2-3 words on one line, white with the spoken word yellow, soft shadow.
export const CAPTION_STYLES = ['reel', 'karaoke', 'bold', 'clean', 'pop', 'gold'];
export const STYLE_LABELS = {reel: 'Reels', karaoke: 'Karaoke', bold: 'Bold Shorts', clean: 'Clean', pop: 'Pop', gold: 'Drama Gold'};
export const POSITIONS = ['bottom', 'middle', 'top'];
export const DEFAULT_FINISH = {
  subtitles: {enabled: false, style: 'reel', position: 'bottom', size: 1, highlight: '#fff000'},
  title: {enabled: false, text: '', seconds: 2.5},
  end: {enabled: false, text: ''},
  effects: {transition: 'cut', transitionSeconds: 0.4, slowZoom: false},
  quality: '720',
};
// Phase 2 (owner 2026-10-19): scene transitions and a slow zoom on every clip.
export const TRANSITIONS = ['cut', 'fade', 'flash', 'zoom'];
export const TRANSITION_LABELS = {cut: 'Cut', fade: 'Fade', flash: 'Flash', zoom: 'Zoom punch'};
const clampNum = (value, lo, hi, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const color = value => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : DEFAULT_FINISH.subtitles.highlight;

export function finishSettings(value = {}) {
  const s = value.subtitles || {}, t = value.title || {}, e = value.end || {}, x = value.effects || {};
  return {
    subtitles: {enabled: s.enabled === true, style: CAPTION_STYLES.includes(s.style) ? s.style : 'reel',
      position: POSITIONS.includes(s.position) ? s.position : 'bottom', size: clampNum(s.size, 0.7, 1.5, 1), highlight: color(s.highlight)},
    title: {enabled: t.enabled === true, text: cleanText(t.text, 90), seconds: clampNum(t.seconds, 1, 5, 2.5)},
    end: {enabled: !!e.enabled, text: cleanText(e.text, 60)},
    effects: {transition: TRANSITIONS.includes(x.transition) ? x.transition : 'cut', transitionSeconds: clampNum(x.transitionSeconds, 0.2, 1, 0.4), slowZoom: x.slowZoom === true},
    quality: value.quality === '1080' ? '1080' : '720',
  };
}

// How a frame looks at time t (seconds into the KEPT clip): scale for the slow zoom / zoom punch, and a color overlay
// for fade (black) or flash (white). Transitions take half their length on each side of a cut.
const easeOut = x => 1 - Math.pow(1 - x, 3);
export function frameLook(effects, clipIndex, clipCount, t, duration) {
  const e = finishSettings({effects}).effects, half = e.transitionSeconds / 2;
  let scale = 1, overlay = null;
  if (e.slowZoom && duration > 0) { const k = Math.min(1, Math.max(0, t / duration)); scale *= clipIndex % 2 ? 1.06 - 0.06 * k : 1 + 0.06 * k; }
  const first = clipIndex === 0, last = clipIndex === clipCount - 1;
  if (e.transition === 'zoom') {
    if (!first && t < e.transitionSeconds) scale *= 1 + 0.14 * (1 - easeOut(t / e.transitionSeconds));
    if (!last && t > duration - half) scale *= 1 + 0.05 * Math.pow((t - (duration - half)) / half, 2);
  } else if (e.transition === 'fade' || e.transition === 'flash') {
    let a = 0;
    if (!first && t < half) a = 1 - t / half;
    if (!last && t > duration - half) a = Math.max(a, (t - (duration - half)) / half);
    if (a > 0) overlay = e.transition === 'fade' ? {color: '0,0,0', alpha: a} : {color: '255,255,255', alpha: 0.9 * a * a};
  }
  return {scale, overlay};
}
// Text sizes are tuned for a vertical frame's width. On a wide 16:9 frame they follow the height instead, so subtitles
// and titles keep a normal size (owner 2026-11-10). Vertical frames are unchanged.
export const textUnit = (width, height) => width > height ? height * 0.9 : width;
export function drawFrame(ctx, image, width, height, look) {
  const s = look?.scale || 1;
  ctx.drawImage(image, (width - width * s) / 2, (height - height * s) / 2, width * s, height * s);
}
export function drawOverlay(ctx, width, height, look) {
  if (!look?.overlay) return;
  ctx.save(); ctx.fillStyle = `rgba(${look.overlay.color},${Math.min(1, look.overlay.alpha)})`; ctx.fillRect(0, 0, width, height); ctx.restore();
}
// Music level over one kept clip (one value per `step` s): lowered to `duck` while someone speaks, with a soft
// attack (0.15 s before speech) and release (0.35 s after). segments are in KEPT clip time.
export function duckCurve(segments, duration, {duck = 0.35, step = 0.02} = {}) {
  const n = Math.max(2, Math.ceil(duration / step) + 1), out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const t = k * step; let level = 1;
    for (const s of segments || []) {
      if (t >= s.start - 0.15 && t <= s.end + 0.35) {
        const into = t < s.start ? (t - (s.start - 0.15)) / 0.15 : t > s.end ? 1 - (t - s.end) / 0.35 : 1;
        level = Math.min(level, 1 - (1 - duck) * Math.max(0, Math.min(1, into)));
      }
    }
    out[k] = level;
  }
  return out;
}

// ---------- subtitles: phrases, voice timing, karaoke words ----------
// Dialogue as spoken: stage directions in (), [] or ** ** are not read aloud; speaker labels ("TERESA:") are dropped
// (owner: text only).
export function spokenText(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/(^|[\n.!?]\s*)[A-ZÀ-Ý][A-ZÀ-Ý .'-]{1,24}:\s*/g, '$1')
    .replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
}
// 2-4 word phrases (Shorts style). Sentence and comma breaks are respected; a lone last word joins the phrase before.
export function phrases(text, maxWords = 4) {
  const out = [];
  for (const part of spokenText(text).split(/(?<=[.!?,;:—–])\s+/)) {
    const words = part.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords));
    if (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 2].length < maxWords + 1) {
      const last = out.pop(); out[out.length - 1].push(...last);
    }
  }
  return out.filter(p => p.length).map(p => p.join(' '));
}
// Where voices are heard: 20 ms RMS frames above an adaptive threshold, small gaps merged.
export function voiceSegments(samples, sampleRate, {minGap = 0.3, minLength = 0.15} = {}) {
  if (!samples?.length || !sampleRate) return [];
  const hop = Math.max(1, Math.round(sampleRate * 0.02)), rms = [];
  for (let i = 0; i < samples.length; i += hop) {
    let sum = 0; const end = Math.min(samples.length, i + hop);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const sorted = [...rms].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.2)] || 0, peak = sorted[sorted.length - 1] || 0;
  const threshold = Math.max(floor * 3, peak * 0.12, 0.01), step = hop / sampleRate;
  const loose = rms.map(v => v >= threshold);
  // A voice has a pitch (80-400 Hz) and is the loudest pitched sound in the clip. Sound effects before or between the
  // lines are not: knocks/hooves/footsteps have no pitch, a hum or drone is much quieter than the speech (owner export
  // 2026-10-19 "The Moving Picture of 1650": captions up to 2.7 s early because a wagon and footsteps counted as voice).
  const pitch = rms.map((v, f) => loose[f] ? periodicity(samples, f * hop, hop * 2, sampleRate) : 0);
  const pitched = rms.filter((v, f) => loose[f] && pitch[f] >= 0.4).sort((a, b) => a - b);
  let voiced = loose;
  if (pitched.length >= 5) {
    const level = pitched[Math.floor(pitched.length * 0.9)], grow = Math.round(0.15 / step);
    const core = rms.map((v, f) => loose[f] && pitch[f] >= 0.4 && v >= level * 0.35);
    const strict = loose.map((on, f) => on && core.slice(Math.max(0, f - grow), f + grow + 1).some(Boolean));   // consonants at word edges
    // Whispered or unusual audio has little pitch: keep the plain loudness result then.
    if (strict.filter(Boolean).length >= loose.filter(Boolean).length * 0.35) voiced = strict;
  }
  const segments = [];
  voiced.forEach((on, index) => {
    if (!on) return;
    const start = index * step, end = start + step, last = segments[segments.length - 1];
    if (last && start - last.end <= minGap) last.end = end; else segments.push({start, end});
  });
  return segments.filter(s => s.end - s.start >= minLength);
}
// Normalized autocorrelation peak for pitches 80-400 Hz (1 = perfectly periodic, ~0 = noise or a click).
function periodicity(samples, at, length, sampleRate) {
  const end = Math.min(samples.length, at + length), n = end - at;
  if (n < sampleRate / 80 * 1.5) return 0;
  let mean = 0; for (let i = at; i < end; i++) mean += samples[i]; mean /= n;
  let energy = 0; for (let i = at; i < end; i++) energy += (samples[i] - mean) ** 2;
  if (energy <= 1e-9) return 0;
  let best = 0;
  for (let lag = Math.floor(sampleRate / 400); lag <= Math.ceil(sampleRate / 80); lag++) {
    let sum = 0; for (let i = at; i + lag < end; i++) sum += (samples[i] - mean) * (samples[i + lag] - mean);
    if (sum > best) best = sum;
  }
  return best / energy;
}
// Cues in ORIGINAL clip time. Each SENTENCE is placed on a stretch of speech and sentence breaks fall on real pauses
// (dynamic programming over the gaps between voiced parts); a sentence lasts about as long as it takes to say it, so
// music or a sound effect after the speech never stretches it (owner test 2026-10-19: up to 1.7 s late after a scream).
// Phrases inside a sentence follow its voiced time. Karaoke word times are even inside each phrase. `shift` = nudge (s).
const CHARS_PER_SECOND = 16, PACE_CAP = 1.15;   // measured on AI Story dialogue: 16-20 letters per second
const letters = text => (String(text).match(/\p{L}/gu) || []).length;
function sentencesOf(text) {
  return spokenText(text).split(/(?<=[.!?])\s+/).map(t => t.trim()).filter(t => letters(t) > 0);
}
// windows: voiced parts [{start,end}]; returns time at `position` seconds of voiced time from the windows' start.
// A START that falls exactly on the end of a voiced part moves to the next voiced part (speech resumes there).
function voicedAt(windows, position, isStart = false) {
  let left = position;
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k], len = w.end - w.start;
    // a start in the last 0.2 s of a voiced part belongs to the next one (the previous word is still ending)
    if (isStart && k < windows.length - 1 && left >= len - 0.2 && left < len + 1e-6) return windows[k + 1].start;
    if (isStart ? left < len - 1e-6 : left <= len) return w.start + left;
    left -= len;
  }
  return windows.length ? windows[windows.length - 1].end : 0;
}
function cuesForSpan(text, windows, shift, duration) {
  const list = phrases(text);
  const total = windows.reduce((n, s) => n + s.end - s.start, 0);
  const weights = list.map(p => letters(p) + 2), weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return list.map((phrase, index) => {
    const share = total * weights[index] / weightSum;
    const start = Math.max(0, Math.min(duration, voicedAt(windows, cursor, true) + shift)), end = Math.max(start + 0.25, Math.min(duration, voicedAt(windows, cursor + share) + shift));
    cursor += share;
    const words = phrase.split(/\s+/), per = (end - start) / words.length;
    return {start, end, text: phrase, words: words.map((w, i) => ({w, start: start + i * per, end: start + (i + 1) * per}))};
  });
}
// Keep only the first `seconds` of voiced time (a sentence never runs into later music or effects).
function capWindows(windows, seconds) { const out = []; let left = seconds; for (const w of windows) { if (left <= 0) break; const len = Math.min(w.end - w.start, left); out.push({start: w.start, end: w.start + len}); left -= len; } return out; }
export function timeCues(text, duration, segments = [], {shift = 0} = {}) {
  const sentences = sentencesOf(text);
  if (!sentences.length || !(duration > 0)) return [];
  const raw = (segments || []).map(s => ({start: Math.max(0, s.start), end: Math.min(duration, s.end)})).filter(s => s.end - s.start > 0.05);
  // An isolated blip (short and far from other sound) is noise, not the start of a line.
  const kept = raw.filter((s, k) => s.end - s.start >= 0.2 || (k > 0 && s.start - raw[k - 1].end < 0.4) || (k < raw.length - 1 && raw[k + 1].start - s.end < 0.4));
  // Long voiced parts are cut into 0.25 s pieces so two sentences said in one breath can still be split.
  const segs = [];
  for (const s0 of kept) for (let t = s0.start; t < s0.end - 1e-6; t += 0.25) segs.push({start: t, end: Math.min(s0.end, t + 0.25)});
  const voiced = segs.reduce((n, s) => n + s.end - s.start, 0);
  const merged = kept;
  const expected = sentences.map(t => Math.max(0.6, letters(t) / CHARS_PER_SECOND));
  if (!segs.length || voiced < Math.min(1, duration * 0.15)) {
    // No usable voice: spread over the clip with a small margin, at speaking pace.
    const start = Math.min(0.3, duration * 0.05), span = Math.min(duration - 0.3 - start, expected.reduce((a, b) => a + b, 0) * 1.15);
    return cuesForSpan(sentences.join(' '), [{start, end: start + Math.max(0.2, span)}], shift, duration);
  }
  const n = sentences.length, m = segs.length;
  if (m < n) return cuesForSpan(sentences.join(' '), capWindows(merged, expected.reduce((a, b) => a + b, 0) * 1.4), shift, duration);
  // dp[i][j]: best cost placing sentences < i using segments < j; sentence i-1 ends on segment j-1.
  const INF = 1e9, dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(INF)), from = Array.from({length: n + 1}, () => new Array(m + 1).fill(-1));
  const skipped = (a, b) => { let t = 0; for (let k = a; k < b; k++) t += segs[k].end - segs[k].start; return t; };
  for (let j = 0; j <= m; j++) dp[0][j] = skipped(0, j) * 1.5;            // leading noise may be skipped (penalized)
  for (let i = 1; i <= n; i++) for (let b = i; b <= m; b++) for (let a = i - 1; a < b; a++) {
    if (dp[i - 1][a] >= INF) continue;
    const v = skipped(a, b), e = expected[i - 1];
    const over = Math.max(0, v - e * PACE_CAP);                                // voiced time beyond a slow reading
    let cost = Math.pow(Math.log(Math.max(0.2, Math.min(v, e * PACE_CAP)) / e), 2) * 2 + over * 1.2;   // speech left without a subtitle is expensive
    if (a > 0 && i > 1) cost -= Math.min(0.8, segs[a].start - segs[a - 1].end);   // sentence breaks like real pauses
    if (dp[i - 1][a] + cost < dp[i][b]) { dp[i][b] = dp[i - 1][a] + cost; from[i][b] = a; }
  }
  let bestEnd = n, best = INF;
  for (let j = n; j <= m; j++) { const c = dp[n][j] + skipped(j, m) * 0.25; if (c < best) { best = c; bestEnd = j; } }   // trailing sound is cheap to skip
  const spans = []; for (let i = n, j = bestEnd; i > 0; i--) { const a = from[i][j]; spans.unshift([a, j]); j = a; }
  const joined = list => list.reduce((out, w) => { const last = out[out.length - 1]; if (last && w.start - last.end < 1e-6) last.end = w.end; else out.push({...w}); return out; }, []);
  return sentences.flatMap((sentence, i) => cuesForSpan(sentence, capWindows(joined(segs.slice(spans[i][0], spans[i][1])), expected[i] * PACE_CAP), shift, duration));
}
export function cueAt(cues, t) { return (cues || []).find(c => t >= c.start && t < c.end) || null; }

// ---------- drawing ----------
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const word of text.split(/\s+/)) { const last = lines.length - 1; if (last >= 0 && ctx.measureText(lines[last] + ' ' + word).width <= maxWidth) lines[last] += ' ' + word; else lines.push(word); }
  return lines;
}
const font = (weight, size) => `${weight} ${Math.round(size)}px Inter, 'Segoe UI', Arial, sans-serif`;
// Reels: the cue is shown 2-3 words at a time (the group with the word being spoken), one line, uppercase, bold,
// white with that word in the highlight color, soft shadow instead of a thick outline, no growing word.
function reelGroups(count) {
  const groups = [];
  for (let i = 0; i < count; i += 3) groups.push([i, Math.min(count, i + 3)]);
  if (groups.length > 1 && groups.at(-1)[1] - groups.at(-1)[0] === 1) { groups.at(-2)[1] -= 1; groups.at(-1)[0] -= 1; }   // 3+1 -> 2+2
  return groups;
}
function drawReel(ctx, width, height, cue, t, s) {
  const words = cue.words.length ? cue.words : [{w: cue.text, start: cue.start, end: cue.end}];
  let current = words.findIndex(w => t >= w.start && t < w.end);
  if (current < 0) current = Math.max(0, words.findLastIndex(w => w.start <= t));
  const [a, b] = reelGroups(words.length).find(([x, y]) => current >= x && current < y);
  const shown = words.slice(a, b).map(w => String(w.w).toUpperCase());
  let size = textUnit(width, height) * 0.046 * s.size;
  ctx.save();
  const setFont = () => { ctx.font = font(700, size); if ('letterSpacing' in ctx) ctx.letterSpacing = `${(size * 0.03).toFixed(1)}px`; };
  setFont();
  const measure = () => { const space = ctx.measureText(' ').width + size * 0.12, widths = shown.map(w => ctx.measureText(w).width); return {space, widths, total: widths.reduce((x, y) => x + y, 0) + space * (shown.length - 1)}; };
  let m = measure();
  while (m.total > width * 0.9 && size > 14) { size -= 2; setFont(); m = measure(); }
  const y = (s.position === 'top' ? height * 0.2 : s.position === 'middle' ? height * 0.5 : height * 0.765) - size / 2;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.22; ctx.shadowOffsetY = size * 0.05;
  let x = (width - m.total) / 2;
  shown.forEach((word, i) => {
    ctx.lineWidth = size * 0.07; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeText(word, x, y);   // keeps white readable on bright frames
    ctx.fillStyle = a + i === current ? s.highlight : '#ffffff'; ctx.fillText(word, x, y);
    x += m.widths[i] + m.space;
  });
  ctx.restore();
}
// Draws the subtitle of time t (clip time). Karaoke lights up the current word in the highlight color.
export function drawSubtitle(ctx, width, height, cues, t, settings) {
  const s = finishSettings({subtitles: settings}).subtitles;
  const cue = s.enabled ? cueAt(cues, t) : null;
  if (!cue) return;
  if (s.style === 'reel') { drawReel(ctx, width, height, cue, t, s); return; }
  const upper = s.style !== 'clean' && s.style !== 'gold';
  const text = upper ? cue.text.toUpperCase() : cue.text;
  let size = textUnit(width, height) * (s.style === 'clean' ? 0.05 : 0.064) * s.size;
  ctx.save();
  ctx.font = font(s.style === 'clean' ? 650 : 900, size);
  let lines = wrap(ctx, text, width * 0.84);
  while (lines.length > 2 && size > 14) { size -= 2; ctx.font = font(s.style === 'clean' ? 650 : 900, size); lines = wrap(ctx, text, width * 0.84); }
  const lineHeight = size * 1.18, block = lines.length * lineHeight;
  const centerY = s.position === 'top' ? height * 0.2 : s.position === 'middle' ? height * 0.5 : height * 0.76;
  let y = centerY - block / 2;
  // Pop: the text is laid out ONCE at its final size and scaled as a whole (owner: changing the font size every frame
  // re-wrapped the lines and made them jump). Quick overshoot, then settle.
  if (s.style === 'pop') {
    const x = Math.min(1, Math.max(0, (t - cue.start) / 0.2)), c1 = 1.70158, c3 = c1 + 1;
    const k = 0.78 + 0.22 * (1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2));
    ctx.translate(width / 2, centerY); ctx.scale(k, k); ctx.translate(-width / 2, -centerY);
    ctx.globalAlpha = Math.min(1, x * 3);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  if (s.style === 'gold') {
    const boxW = Math.min(width * 0.9, Math.max(...lines.map(l => ctx.measureText(l).width)) + size * 1.2), pad = size * 0.35;
    ctx.fillStyle = 'rgba(12,9,20,.82)'; roundRect(ctx, (width - boxW) / 2, y - pad, boxW, block + pad * 2, size * 0.35); ctx.fill();
  }
  const current = s.style === 'karaoke' ? cue.words.findIndex(w => t >= w.start && t < w.end) : -1;
  let wordIndex = 0;
  for (const line of lines) {
    // The lit word is drawn 4 % larger with a thick outline: a little extra room so it never touches its neighbour
    // (owner export 2026-10-19 showed "PAINTEDGLASS").
    const words = line.split(' '), widths = words.map(w => ctx.measureText(w).width), space = ctx.measureText(' ').width + (s.style === 'karaoke' ? size * 0.05 : 0);
    let x = width / 2 - (widths.reduce((a, b) => a + b, 0) + space * (words.length - 1)) / 2;
    for (let i = 0; i < words.length; i++, wordIndex++) {
      const cx = x + widths[i] / 2;
      if (s.style === 'clean') { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = size * 0.25; ctx.shadowOffsetY = size * 0.06; }
      else if (s.style !== 'gold') { ctx.lineWidth = size * 0.2; ctx.strokeStyle = '#0b0910'; ctx.strokeText(words[i], cx, y); }
      ctx.fillStyle = s.style === 'gold' ? '#f8df86' : (wordIndex === current ? s.highlight : '#ffffff');
      if (wordIndex === current) { ctx.save(); ctx.translate(cx, y + size / 2); ctx.scale(1.04, 1.04); ctx.translate(-cx, -(y + size / 2)); ctx.fillText(words[i], cx, y); ctx.restore(); }
      else ctx.fillText(words[i], cx, y);
      ctx.shadowColor = 'transparent';
      x += widths[i] + space;
    }
    y += lineHeight;
  }
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
// Hook title over the first seconds (global story time), fading in and out.
export function drawTitle(ctx, width, height, title, t) {
  const s = finishSettings({title}).title;
  if (!s.enabled || !s.text || t >= s.seconds) return;
  const alpha = Math.min(1, t / 0.25, (s.seconds - t) / 0.4);
  ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
  const band = ctx.createLinearGradient(0, 0, 0, height * 0.38);
  band.addColorStop(0, 'rgba(10,7,18,.85)'); band.addColorStop(1, 'rgba(10,7,18,0)');
  ctx.fillStyle = band; ctx.fillRect(0, 0, width, height * 0.38);
  let size = textUnit(width, height) * 0.078; ctx.font = font(900, size);
  let lines = wrap(ctx, s.text.toUpperCase(), width * 0.86);
  while (lines.length > 3 && size > 16) { size -= 2; ctx.font = font(900, size); lines = wrap(ctx, s.text.toUpperCase(), width * 0.86); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  const grad = ctx.createLinearGradient(width * 0.2, 0, width * 0.8, 0); grad.addColorStop(0, '#c5a6ff'); grad.addColorStop(1, '#8ee5df');
  lines.forEach((line, i) => { const y = height * 0.1 + i * size * 1.12; ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#0b0910'; ctx.strokeText(line, width / 2, y); ctx.fillStyle = grad; ctx.fillText(line, width / 2, y); });
  ctx.restore();
}
export const END_CARD_SECONDS = 2.2;
// End card over the last seconds: the picture darkens and the text fades in.
export function drawEndCard(ctx, width, height, end, remaining) {
  const s = finishSettings({end}).end;
  if (!s.enabled || !s.text || remaining > END_CARD_SECONDS) return;
  const k = Math.min(1, (END_CARD_SECONDS - remaining) / 0.5);
  ctx.save(); ctx.fillStyle = `rgba(10,7,18,${0.6 * k})`; ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = k; let size = textUnit(width, height) * 0.08; ctx.font = font(900, size);
  const lines = wrap(ctx, s.text.toUpperCase(), width * 0.84);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * size * 1.15));
  ctx.fillStyle = '#c5a6ff'; ctx.fillRect(width * 0.4, height / 2 + lines.length * size * 0.6 + size * 0.3, width * 0.2, Math.max(3, size * 0.08));
  ctx.restore();
}

// ---------- SRT and presets ----------
const stamp = t => { const ms = Math.max(0, Math.round(t * 1000)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
// scenes: [{cues (clip time), trimStart, offset (story time of the kept clip start), keptDuration}]
export function toSRT(scenes) {
  const rows = [];
  for (const scene of scenes) for (const cue of scene.cues || []) {
    const start = cue.start - (scene.trimStart || 0), end = cue.end - (scene.trimStart || 0);
    if (end <= 0 || start >= scene.keptDuration) continue;
    rows.push([scene.offset + Math.max(0, start), scene.offset + Math.min(scene.keptDuration, end), cue.text]);
  }
  return rows.map(([a, b, text], i) => `${i + 1}\n${stamp(a)} --> ${stamp(b)}\n${text}\n`).join('\n');
}
// One-click Finish: Reels captions everywhere (owner 2026-10-19: "I want something like this subtitle"; was Karaoke),
// always the reference yellow; the end card follows the niche and series.

export function presetFor(setup = {}, title = '') {
  const niche = Number(setup.niche), part = Number(setup.partNumber) || 1, parts = Number(setup.partsTotal) || 1;
  const tagalog = /tagalog|filipino/i.test(String(setup.language || '')) || [34, 35, 38, 39, 40].includes(niche);
  const more = parts > 1 && part < parts;
  return finishSettings({
    subtitles: {enabled: true, style: 'reel', position: 'bottom', size: 1, highlight: DEFAULT_FINISH.subtitles.highlight},
    title: {enabled: !!title, text: parts > 1 ? `${title} · Part ${part}` : title, seconds: 2.5},
    end: {enabled: true, text: more ? (tagalog ? `Abangan ang Part ${part + 1}` : `Follow for Part ${part + 1}`) : (tagalog ? 'Wakas' : 'The End')},
    effects: {transition: niche === 38 ? 'flash' : [35, 39].includes(niche) ? 'zoom' : 'fade', transitionSeconds: 0.4, slowZoom: true},
    quality: '720',
  });
}

// Suggested text/styles are ready, but optional finishing starts off until selected.
export function initialFinish(setup = {}, title = '') {
  const suggested = presetFor(setup, title);
  return finishSettings({...suggested, subtitles:{...suggested.subtitles,enabled:false}, title:{...suggested.title,enabled:false}, end:{...suggested.end,enabled:false}, effects:{...suggested.effects,transition:'cut',slowZoom:false}});
}
