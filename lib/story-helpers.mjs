// Small AI Story helpers (owner 2026-10-29): what a run will make, the backup reminder, and the end of a finished part.

// What the remaining steps of this part will make, so users know before Start (Flow credit prices change, so we count
// generations instead of guessing credits). sheets: storyboard sheets make one image per 4 scenes.
export function runEstimate(p, {sheets = false} = {}) {
  const redo = new Set(p.redoIds || []), missing = x => !p.media?.[x.id] || redo.has(x.id);
  const imageOnly = p.setup?.exportProfile === 'Image prompts only', noSceneImages = p.setup?.exportProfile === 'Recurring assets + video';
  const scenes = p.project?.scenes || [], references = (p.project?.assets || []).filter(missing).length;
  const scenesMissing = noSceneImages ? 0 : scenes.filter(missing).length;
  const sceneImages = sheets ? Math.ceil(scenesMissing / 4) : scenesMissing;
  const done = new Set(p.videoDoneIds || []), videos = imageOnly ? 0 : scenes.filter(s => !done.has(s.id)).length;
  return {references, scenes: scenesMissing, sceneImages, sheets: !!sheets && scenesMissing > 0, videos, videoSeconds: videos * (Number(p.setup?.sceneDuration) || 8)};
}

// Flow video credits per clip at 720p, one output, read from Flow's own 'Generating will use N credits' (owner screenshots
// 2026-10-29, Ingredients mode). Only confirmed prices: other models and images show counts only.
export const FLOW_VIDEO_CREDITS = {'Omni 1.1 Flash': {4: 7, 6: 10, 8: 12, 10: 15}};
// Omni 1.2 Flash (owner screenshots 2026-11-07): per second up to 10 s, double per second above 10 s; 720p = 3x 360p.
// 720p: 8s = 24, 10s = 30, 15s = 60. 360p: 8s = 8, 10s = 10, 15s = 20.
export const OMNI_12_PER_SECOND = {'360p': 1, '720p': 3};
export function videoCredits(model, seconds, count, resolution = '720p') {
  const s = Number(seconds), rate = OMNI_12_PER_SECOND[resolution];
  const per = model === 'Omni 1.2 Flash' ? (rate && s >= 3 && s <= 15 ? rate * Math.min(s, 10) + 2 * rate * Math.max(0, s - 10) : 0)
    : resolution === '720p' ? FLOW_VIDEO_CREDITS[model]?.[s] : 0;
  return per && count ? per * count : 0;
}

export function estimateText(e, {imagePlatform = '', videoPlatform = '', model = '', resolution = '720p'} = {}) {
  const name = x => ({flow: 'Flow', chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok', vids: 'Google Vids', higgsfield: 'Higgsfield'})[x] || x;
  const images = e.references + e.sceneImages, parts = [];
  if (images) parts.push(images + ' image' + (images === 1 ? '' : 's') + (e.sheets ? ' (' + e.sceneImages + ' storyboard sheet' + (e.sceneImages === 1 ? '' : 's') + ' for ' + e.scenes + ' scenes)' : '') + (imagePlatform ? ' on ' + name(imagePlatform) : ''));
  if (e.videos) parts.push(e.videos + ' video' + (e.videos === 1 ? '' : 's') + ' × ' + Math.round(e.videoSeconds / e.videos) + 's' + (videoPlatform ? ' on ' + name(videoPlatform) + (videoPlatform === 'flow' && model ? ' (' + model + ')' : '') : ''));
  const credits = videoPlatform === 'flow' && e.videos ? videoCredits(model, Math.round(e.videoSeconds / e.videos), e.videos, resolution) : 0;
  return parts.length ? 'This run makes ' + parts.join(' + ') + '.' + (credits ? ' The videos use about ' + credits + ' Flow credits (' + resolution + ').' : '') + ' Check you have enough credits first.' : '';
}

// Projects live only in this browser: remind after every 5 newly finished stories since the last backup or reminder.
export const BACKUP_EVERY = 5;
export function finishedStories(records) {
  return records.filter(r => r.id !== 'draft' && (r.state === 'videos_finished' || (r.setup?.exportProfile === 'Image prompts only' && r.imagesReviewed))).length;
}
export function backupDue(records, lastCount = 0) {
  const n = finishedStories(records);
  return n - (Number(lastCount) || 0) >= BACKUP_EVERY ? n : 0;
}

// The last spoken line (or the last scene's picture) of a finished part, shown on the "Continue to Part N" card.
export function partEnding(p) {
  const last = (p.project?.scenes || []).at(-1);
  if (!last) return '';
  const line = String(last.speech || '').replace(/\[[^\]]*\]/g, '').split(/\n/).map(x => x.trim()).filter(Boolean).at(-1) || '';
  return line.slice(0, 160);
}

// Pronunciation list (owner 2026-10-29): "Skinavor = skin-AH-vor", one per line. Each scene's video prompt gets a line for the
// words that scene actually says, so brand and Filipino names are not mispronounced (the video model may still vary).
export function parsePronunciations(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*(?:=|→|->|:)\s*(.+?)\s*$/.exec(line);
    if (m && m[1].length <= 60 && m[2].length <= 80 && !out.some(x => x.word.toLowerCase() === m[1].toLowerCase())) out.push({word: m[1], say: m[2]});
  }
  return out.slice(0, 20);
}
export function pronunciationLine(pairs, speech) {
  const text = String(speech || '').toLowerCase();
  const used = pairs.filter(p => text.includes(p.word.toLowerCase()));
  return used.length ? 'PRONUNCIATION — ' + used.map(p => 'say "' + p.word + '" as "' + p.say + '"').join('; ') + '.' : '';
}
