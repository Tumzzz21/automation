export const MAX_MOTION_SECONDS = 15;
export const motionDuration = seconds => [4,6,8,10].find(n=>n>=seconds-.05)||Math.min(MAX_MOTION_SECONDS,Math.ceil(seconds-.05));
export function resetPreparation(project){
  if(project.run&&!/^(preparing|uploading .+|filling prompt)$/.test(project.run.phase||''))throw Error('This run may already have been submitted. Use Recover an unfinished result; preparation was not reset.');
  const next={...project};delete next.run;return next;
}
export function validateProject(p) {
  if (!p || p.version !== 1 || typeof p.id !== 'string' || !p.id) throw Error('Invalid project.');
  if (!p.source || !Number.isFinite(p.source.duration) || p.source.duration <= 0 || p.source.duration > MAX_MOTION_SECONDS + .05) throw Error('Choose a source clip of 15 seconds or less.');
  if (!p.character || !p.character.type.startsWith('image/')) throw Error('Choose one character image.');
  for (const file of [p.source, p.character, p.background].filter(Boolean)) {
    if (!file.key || !file.name || !Number.isFinite(file.size) || file.size <= 0 || file.size > 40 * 1024 * 1024) throw Error('Each input must be under 40 MB and contain media.');
  }
  if (!p.source.type.startsWith('video/')) throw Error('Source must be a video.');
  if (p.background && !p.background.type.startsWith('image/')) throw Error('Background must be an image.');
  return p;
}
export function composePrompt(p) {
  validateProject(p);
  return [
    'REFERENCE-VIDEO MOTION STUDY',
    `OUTPUT — One ${motionDuration(p.source.duration)}-second video. Match the source clip aspect ratio and visible action timing. Do not extend or loop the performance.`,
    `REFERENCES — Source video: ${p.source.name}. Character identity image: ${p.character.name}.`,
    p.background ? `ENVIRONMENT — Use ${p.background.name} as the background reference.` : 'ENVIRONMENT — Preserve the source video environment and composition.',
    'MOTION — Use the attached video as the motion and camera reference. Preserve its action order, screen positions, gaze directions, camera movement and prop interactions. Apply that movement to the person in the character image. Do not treat the video as a still-image reference.',
    'IDENTITY — 100% match to the attached character identity image. No redesign. Copy its face, hairstyle, clothing, accessories and proportions exactly throughout the clip. The character image takes precedence over the source performer’s appearance. Keep the same identity across every frame.',
    'AUDIO — No speech or music. Natural environmental sound only.',
    'EXCLUDE — Added captions, watermarks, logos, extra people, identity changes, duplicate limbs and invented cuts.',
    p.notes?.trim() ? `ADDITIONAL DIRECTION — ${p.notes.trim()}` : ''
  ].filter(Boolean).join('\n');
}
export function flowProjectUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://flow.google.com' || !/^\/(?:u\/\d+\/)?project\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) throw Error('Select an open Flow project tab.');
  return url.href;
}

// ---- Motion Studio (owner 2026-11-12): a long source is made piece by piece, then joined. ----
export const STUDIO_VERSION = 2;
export const DEFAULT_STUDIO = {pieceSeconds: 8, ratio: 'portrait', resolution: '720p', download: 'same', continuity: false, originalAudio: true, autoDownload: true, prompt: ''};
export function studioSettings(s = {}) {
  const out = {...DEFAULT_STUDIO, ...s};
  out.pieceSeconds = [5, 6, 8, 10, 12, 15].includes(Number(out.pieceSeconds)) ? Number(out.pieceSeconds) : 8;
  if (!['portrait', 'landscape'].includes(out.ratio)) out.ratio = 'portrait';
  // Omni 1.2 Flash offers 360p and 720p only (owner screenshot 2026-11-12).
  if (!['720p', '360p'].includes(out.resolution)) out.resolution = '720p';
  // A 360p draft can be saved as made or as Flow's 720p upscale (owner 2026-11-12); 720p is saved as made.
  out.download = out.resolution === '360p' && out.download === '720p' ? '720p' : 'same';
  for (const k of ['continuity', 'originalAudio', 'autoDownload']) out[k] = out[k] === true;
  out.prompt = String(out.prompt || '').slice(0, 1000);
  return out;
}
export function validateStudio(p) {
  if (!p || p.version !== STUDIO_VERSION || !p.id) throw Error('Invalid motion project.');
  if (!p.source || !p.source.type?.startsWith('video/') || !(p.source.duration > 0)) throw Error('Add a source video first.');
  if (p.source.duration > 180.05) throw Error('Use a source video of up to 3 minutes.');
  if (!p.character || !p.character.type?.startsWith('image/')) throw Error('Add your character image first.');
  for (const file of [p.source, p.character, p.background].filter(Boolean)) if (!file.key || !(file.size > 0) || file.size > 200 * 1024 * 1024) throw Error('Each file must be under 200 MB.');
  return p;
}
// The prompt for one piece. The video is the motion reference; the character image is the identity.
export function piecePrompt(p, piece, {continuity = false} = {}) {
  const s = studioSettings(p.settings), total = p.pieces?.length || 1;
  return [
    'REFERENCE-VIDEO MOTION STUDY' + (total > 1 ? ` · PART ${piece.index + 1} OF ${total}` : ''),
    `OUTPUT — One ${piece.seconds}-second ${s.ratio === 'landscape' ? '16:9' : '9:16'} video. Follow the source clip's action timing second by second. Do not extend, slow down or loop the performance.`,
    `REFERENCES — Source video: piece-${piece.index + 1}.mp4. Character identity image: ${p.character.name}.` + (continuity ? ' Continuity frame: previous-frame.png.' : ''),
    p.background ? `ENVIRONMENT — Use ${p.background.name} as the background reference.` : 'ENVIRONMENT — Preserve the source video environment, lighting and composition.',
    'MOTION — Use the attached video as the motion and camera reference. Copy its body movement, dance steps, hand gestures, action order, screen positions, gaze directions, camera movement and prop interactions. Apply that movement to the person in the character image. Do not treat the video as a still image.',
    'IDENTITY — 100% match to the attached character identity image. No redesign. Copy its face, hairstyle, clothing, accessories and proportions exactly in every frame. The character image takes precedence over the source performer’s appearance.',
    continuity ? 'CONTINUITY — The continuity frame is the last frame of the previous part. Start this clip matching it: same person, outfit, lighting, framing and position, so the parts join without a visible jump.' : '',
    'AUDIO — No speech or music. Natural environmental sound only.',
    'EXCLUDE — Captions, text, watermarks, logos, extra people, identity changes, duplicate limbs and invented cuts.',
    s.prompt.trim() ? `ADDITIONAL DIRECTION — ${s.prompt.trim()}` : ''
  ].filter(Boolean).join('\n');
}

// Flow's refusal in plain words for the member (owner 2026-11-12). Flow's own sentence is kept at the end.
export function flowRefusalHint(message){
  const m=String(message||'').replace(/\s+/g,' ').trim();
  const words=m?' (Flow said: "'+m.slice(0,200)+'")':'';
  if(/unusual activity|extensions that modify/i.test(m))return 'Flow paused for unusual activity. Turn off other Flow extensions, reload the Flow tab, then press ↻ on this piece.'+words;
  // Owner test 2026-11-12: "…policies about generating prominent people" on the basketball template (NBA arena).
  if(/prominent|famous|public figure|celebrit/i.test(m))return 'Flow thinks this piece shows a famous person: the source video looks like a real event or star (for example a pro game with logos), or the character looks like someone known. Use another source video or template; changing the character alone rarely helps. Flow refunds refused pieces.'+words;
  if(/polic|violat|real people/i.test(m))return 'Flow refused this piece. It usually means the video or the character shows a real person, a child, revealing clothes or violence. Try another character picture or source video, then press ↻ on this piece.'+words;
  if(/wrong|error|could ?n.t|could not|unable|can.t|failed|hard time|different prompt/i.test(m))return 'Flow could not make this piece (a Flow error, not a content flag). Press ↻ on this piece to try again.'+words;
  return m;
}
