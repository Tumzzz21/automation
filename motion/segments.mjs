// Motion Studio media steps, all local (no provider calls): split a long source into pieces Flow can follow,
// take the last frame of a piece for continuity, and join the generated pieces back into one video with the
// original sound. Pieces use whole seconds, so each generated clip is as long as its piece and the joined video
// stays in time with the original audio.
import * as M from '../vendor/mediabunny-1.61.6.mjs';

export const MIN_PIECE = 3, MAX_PIECE = 15, MAX_SOURCE_SECONDS = 180;
export const PIECE_CHOICES = [5, 6, 8, 10, 12, 15];

// Whole-second pieces of `size` seconds; a short tail (< 3 s) joins the previous piece when that stays <= 15 s,
// otherwise it becomes its own 3 s generation that is cut back to its real length when joining.
export function planSegments(duration, size = 8) {
  if (!(duration > 0)) throw Error('The source video has no length.');
  if (duration > MAX_SOURCE_SECONDS + .05) throw Error('Use a source video of up to ' + MAX_SOURCE_SECONDS / 60 + ' minutes.');
  size = Math.max(MIN_PIECE, Math.min(MAX_PIECE, Math.round(size)));
  const out = [];
  for (let start = 0; start < duration - .05; start += size) out.push({start, end: Math.min(duration, start + size)});
  const last = out.at(-1), tail = last.end - last.start;
  if (out.length > 1 && tail < MIN_PIECE && out.at(-2).end - out.at(-2).start + tail <= MAX_PIECE) { out.pop(); out.at(-1).end = last.end; }
  return out.map((p, index) => ({index, start: round(p.start), end: round(p.end), seconds: generationSeconds(p.end - p.start)}));
}
// Flow length for a piece: whole seconds, 3-15 (Omni 1.2 Flash's Length slider).
export const generationSeconds = length => Math.max(MIN_PIECE, Math.min(MAX_PIECE, Math.ceil(length - .05)));
const round = n => Math.round(n * 1000) / 1000;

const check = signal => { if (signal?.aborted) throw new DOMException('Paused.', 'AbortError'); };

// One piece of the source as its own MP4, without sound (Flow refuses uploaded clips with people speaking, and the
// original sound is put back after joining).
export async function cutSegment(source, start, end, {signal} = {}) {
  check(signal);
  const input = new M.Input({source: new M.BlobSource(source), formats: M.ALL_FORMATS}), target = new M.BufferTarget();
  const output = new M.Output({format: new M.Mp4OutputFormat({fastStart: 'in-memory'}), target});
  try {
    const conversion = await M.Conversion.init({input, output, trim: {start, end}, audio: {discard: true}, video: {codec: 'avc', bitrate: M.QUALITY_HIGH, forceTranscode: true}});
    if (!conversion.isValid) throw Error('This video cannot be cut in this browser (' + (conversion.discardedTracks.map(t => t.reason).join(', ') || 'unsupported') + '). Try an MP4.');
    const abort = () => conversion.cancel();
    signal?.addEventListener('abort', abort, {once: true});
    try { await conversion.execute(); } finally { signal?.removeEventListener('abort', abort); }
    check(signal);
    return new Blob([target.buffer], {type: 'video/mp4'});
  } finally { input.dispose(); }
}

// Whether a video file has a sound track (owner 2026-11-12: shown next to the source name, so "no sound" is clear).
export async function hasSound(blob) {
  const input = new M.Input({source: new M.BlobSource(blob), formats: M.ALL_FORMATS});
  try { return !!(await input.getPrimaryAudioTrack()); } catch { return null; } finally { input.dispose(); }
}

// The last picture of a clip as a PNG (continuity reference for the next piece).
export async function lastFrame(video) {
  const input = new M.Input({source: new M.BlobSource(video), formats: M.ALL_FORMATS});
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw Error('The clip has no picture.');
    const end = await track.computeDuration(), sink = new M.CanvasSink(track, {poolSize: 1});
    const frame = await sink.getCanvas(Math.max(0, end - 0.05));
    if (!frame) throw Error('The last frame could not be read.');
    const canvas = frame.canvas;
    if (canvas.convertToBlob) return await canvas.convertToBlob({type: 'image/png'});
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('The last frame could not be saved.')), 'image/png'));
  } finally { input.dispose(); }
}

// Join the generated pieces in order. takes: [{blob, seconds}] (seconds = that piece's real length, the clip is cut
// to it). audio: the source video to take the sound from (original audio), or null to keep each clip's own sound.
export async function mergeTakes(takes, {audio = null, fps = 30, signal, onProgress = () => {}} = {}) {
  if (!takes.length) throw Error('There are no generated pieces to join.');
  const inputs = takes.map(t => new M.Input({source: new M.BlobSource(t.blob), formats: M.ALL_FORMATS}));
  const sourceInput = audio ? new M.Input({source: new M.BlobSource(audio), formats: M.ALL_FORMATS}) : null;
  let output, finished = false;
  try {
    const tracks = await Promise.all(inputs.map(i => i.getPrimaryVideoTrack()));
    tracks.forEach((t, i) => { if (!t) throw Error('Piece ' + (i + 1) + ' has no picture. Generate it again.'); });
    // Every piece is drawn on one canvas the size of the first piece (Flow returns the same size for one run).
    const width = even(tracks[0].displayWidth), height = even(tracks[0].displayHeight);
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    const target = new M.BufferTarget(), format = new M.Mp4OutputFormat({fastStart: 'in-memory'});
    output = new M.Output({format, target});
    const picture = new M.CanvasSource(canvas, {codec: 'avc', bitrate: M.QUALITY_HIGH});
    output.addVideoTrack(picture, {frameRate: fps});
    const total = takes.reduce((n, t) => n + t.seconds, 0);
    let sound = null, sourceAudio = null;
    if (sourceInput) {
      sourceAudio = await sourceInput.getPrimaryAudioTrack();
      if (!sourceAudio) throw Error('The source video has no sound. Turn off "Use original audio" to keep the generated sound.');
    }
    const wantsAudio = sourceAudio || (await Promise.all(inputs.map(i => i.getPrimaryAudioTrack()))).some(Boolean);
    if (wantsAudio) { sound = new M.AudioSampleSource({codec: 'aac', bitrate: 192000}); output.addAudioTrack(sound); }
    await output.start();
    // Picture: each piece from its first frame for its real length, one frame every 1/fps second.
    let offset = 0;
    for (const [i, track] of tracks.entries()) {
      const first = await track.getFirstTimestamp(), length = takes[i].seconds, frames = Math.max(1, Math.round(length * fps));
      const sink = new M.VideoSampleSink(track), times = Array.from({length: frames}, (_, f) => first + f / fps);
      for await (const sample of sink.samplesAtTimestamps(times)) {
        check(signal);
        if (sample) { ctx.clearRect(0, 0, width, height); sample.draw(ctx, 0, 0, width, height); sample.close(); }
        await picture.add(offset, 1 / fps);
        offset = Math.round((offset + 1 / fps) * 1e6) / 1e6;
      }
      onProgress(Math.round((i + 1) / tracks.length * (sound ? 80 : 99)));
    }
    picture.close();
    // Sound: the original track over the whole length, or each piece's own sound at its place.
    if (sound) {
      const parts = sourceAudio ? [{track: sourceAudio, from: await firstTime(sourceInput), length: total, at: 0}]
        : await Promise.all(takes.map(async (t, i) => ({track: await inputs[i].getPrimaryAudioTrack(), from: await tracks[i].getFirstTimestamp(), length: t.seconds, at: takes.slice(0, i).reduce((n, x) => n + x.seconds, 0)})));
      let added = 0;
      for (const part of parts) {
        if (!part.track) continue;
        for await (const sample of new M.AudioSampleSink(part.track).samples(part.from, part.from + part.length)) {
          let piece = sample;
          try {
            check(signal);
            const a = Math.max(0, Math.round((part.from - sample.timestamp) * sample.sampleRate)), b = Math.min(sample.numberOfFrames, Math.round((part.from + part.length - sample.timestamp) * sample.sampleRate));
            if (b <= a) continue;
            if (a || b < sample.numberOfFrames) piece = sample.trim(a, b);
            piece.setTimestamp(part.at + Math.max(0, piece.timestamp - part.from));
            await sound.add(piece); added++;
          } finally { if (piece !== sample) piece.close(); sample.close(); }
        }
      }
      if (!added && sourceAudio) throw Error('No sound could be read from the source video.');
      sound.close();
    }
    check(signal); await output.finalize(); finished = true; onProgress(100);
    return new Blob([target.buffer], {type: 'video/mp4'});
  } finally {
    if (output && !finished) await output.cancel().catch(() => {});
    for (const i of inputs) i.dispose(); sourceInput?.dispose();
  }
}
const even = n => Math.max(2, Math.round(n / 2) * 2);
async function firstTime(input) { const v = await input.getPrimaryVideoTrack(); return v ? await v.getFirstTimestamp() : 0; }
