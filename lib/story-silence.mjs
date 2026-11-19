// Dead air at the start and end of a clip (owner test 2026-11-05: a 41 s scene rebuilt into 60 s, with up to 3 s of silence
// where one clip ended and the next began). Finds the first and last real sound and proposes a trim that keeps a short
// lead-in and a reaction after the last word. The original clip is never changed; the trim is saved like a manual one.

// channels: Float32Array per channel; returns {first, last} in seconds, or null when the clip has no real sound.
// "Sound" is measured against the clip's own room tone (the quietest tenth of the clip): quiet sobbing or breathing at the end
// of a clip is acting and is kept (owner clip p001: sobs at -40 dB over a -52 dB room); only room tone counts as dead air.
export function soundBounds(channels, rate, {windowMs = 20, minSoundMs = 120, aboveRoomDb = 10} = {}) {
  const size = Math.max(1, Math.round(rate * windowMs / 1000)), length = channels[0]?.length || 0, count = Math.floor(length / size);
  if (!count) return null;
  const db = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    for (const ch of channels) for (let i = w * size, end = i + size; i < end; i++) sum += ch[i] * ch[i];
    db[w] = 10 * Math.log10(sum / (size * channels.length) + 1e-12);
  }
  const sorted = Float32Array.from(db).sort(), room = sorted[Math.floor(count * 0.1)];
  const threshold = room + aboveRoomDb, need = Math.max(1, Math.round(minSoundMs / windowMs));
  let first = -1, last = -1, run = 0;
  for (let w = 0; w < count; w++) {
    run = db[w] >= threshold ? run + 1 : 0;
    if (run >= need) { if (first < 0) first = w - need + 1; last = w; }
  }
  return first < 0 ? null : {first: first * size / rate, last: (last + 1) * size / rate};
}

// The trim to save, or null when there is little to cut (under minCut seconds in total) or no sound was found.
export function deadAirTrim(duration, bounds, {lead = 0.25, tail = 0.6, minCut = 0.4} = {}) {
  if (!bounds || !Number.isFinite(duration) || duration <= 0) return null;
  const start = Math.max(0, Math.floor((bounds.first - lead) * 100) / 100), end = Math.min(duration, Math.ceil((bounds.last + tail) * 100) / 100);
  if (end - start < 1 || start + (duration - end) < minCut) return null;
  return {start, end};
}
