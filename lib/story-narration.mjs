// Narration record (AI narration plan, owner 2026-10-31): a separate, versioned local record per story. Takes are
// immutable; the audio itself lives in its own object store (story-workspace.mjs) so timing edits never rewrite it.
// Nothing here calls a server: imported takes are free, generated takes arrive from server/narration.cjs jobs.
import {spokenText} from './story-finish.mjs';
import {timelineHash, timingIssues} from './narration-timeline.mjs';
export const NARRATION_VERSION = 1, MAX_NARRATION_BYTES = 30 * 1024 * 1024, MAX_NARRATION_SECONDS = 600, MAX_SCENE_TEXT = 600;
export const AUDIO_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac'];

// Stable, sync hash for change detection only (not security).
export function textHash(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0') + ':' + s.length;
}
// The words per scene, independent of order: reordering is a timing change, not a script change.
export function scriptHash(draft, order) { return textHash([...(order || [])].sort().map(id => [id, String(draft?.sceneTexts?.[id] || '').trim()])); }

// The spoken words of each scene, in playback order: the narration draft starts from the saved scene speech.
export function emptyNarration(project, order) {
  const scenes = project?.project?.scenes || [], texts = {};
  for (const id of order || scenes.map(s => s.id)) texts[id] = spokenText(scenes.find(s => s.id === id)?.speech || '').slice(0, MAX_SCENE_TEXT);
  // AI-narrator projects have visual-only clips with ambience and sound effects only: keep that bed softly under the voice so
  // pauses are not dead air (owner 2026-10-31). Other clips carry the video model's own voice, so they start muted.
  return {version: NARRATION_VERSION, enabled: false, selectedTakeId: '', volume: 1, originalVolume: project?.setup?.narration === 'AI narrator' ? 0.35 : 0, draft: {sceneTexts: texts, language: String(project?.setup?.language || 'English'), voiceId: '', delivery: 'calm', revision: 1}, takes: [], timing: null};
}

const level = (x, fallback) => { const n = x === undefined ? fallback : Number(x); if (!Number.isFinite(n) || n < 0 || n > 1) throw Error('Volume must be between 0 and 100%.'); return n; };
const num = x => { const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > MAX_NARRATION_SECONDS) throw Error('Narration timing is invalid.'); return Math.round(n * 1000) / 1000; };
// Validates a stored, restored or edited record (take metadata only; audio blobs are checked by inspectNarration).
// Narration is for narrated stories only (owner 2026-11-11: no Narration in the Workspace for dramas, where the characters
// speak in the clips). Same rule as narrationEligible in lib/faceless-builder.js (a test keeps the two equal).
const DRAMA_NICHES = [34, 36, 37, 38, 39, 40, 58, 61], NO_NARRATOR = [35, 41, 42, 55, 56, 57], NARRATOR_NICHES = [59, 60];
export function narrationFits(setup) {
  if (!setup) return false;
  const n = Number(setup.niche);
  if (setup.narration === 'AI narrator') return true;
  return !DRAMA_NICHES.includes(n) && !NO_NARRATOR.includes(n) && (['B-roll with narration', 'Hands-only process'].includes(setup.format) || NARRATOR_NICHES.includes(n));
}
// AI takes: the server pilot ('google') and the member's own key (owner 2026-11-11: 'google' or 'elevenlabs').
export const AI_SOURCES = ['google', 'elevenlabs'];
export function narrationSettings(n) {
  if (!n || n.version !== NARRATION_VERSION) throw Error('This narration was saved by a newer version. Update the extension.');
  const texts = {};
  for (const [id, t] of Object.entries(n.draft?.sceneTexts || {})) { if (!/^scene_\d{3}$/.test(id)) continue; const v = String(t || ''); if (v.length > MAX_SCENE_TEXT) throw Error('Keep each scene narration under ' + MAX_SCENE_TEXT + ' characters.'); texts[id] = v; }
  const takes = (n.takes || []).map(t => ({id: String(t.id), source: AI_SOURCES.includes(t.source) ? t.source : 'imported', jobId: String(t.jobId || ''), name: String(t.name || '').slice(0, 120), mimeType: String(t.mimeType || ''), durationSeconds: num(t.durationSeconds), sampleRate: Number(t.sampleRate) || 0, channels: Number(t.channels) || 0, bytes: Number(t.bytes) || 0, sha256: String(t.sha256 || ''), scriptHash: String(t.scriptHash || ''), generationHash: String(t.generationHash || ''), model: String(t.model || ''), voiceId: String(t.voiceId || ''), createdAt: Number(t.createdAt) || 0}));
  if (takes.some(t => !/^take_[a-z0-9-]{6,64}$/.test(t.id)) || new Set(takes.map(t => t.id)).size !== takes.length) throw Error('Narration takes are damaged.');
  const selectedTakeId = takes.some(t => t.id === n.selectedTakeId) ? n.selectedTakeId : '';
  const timing = n.timing && takes.some(t => t.id === n.timing.takeId) ? {takeId: n.timing.takeId, timelineHash: String(n.timing.timelineHash || ''), reviewed: n.timing.reviewed === true, scriptHash: String(n.timing.scriptHash || ''), sceneMarks: (n.timing.sceneMarks || []).filter(m => /^scene_\d{3}$/.test(m.sceneId)).map(m => ({sceneId: m.sceneId, from: num(m.from), to: num(m.to), delay: num(m.delay || 0)}))} : null;
  return {version: NARRATION_VERSION, enabled: n.enabled === true && !!selectedTakeId, selectedTakeId, volume: level(n.volume, 1), originalVolume: level(n.originalVolume, 0),
    draft: {sceneTexts: texts, language: String(n.draft?.language || '').slice(0, 60), voiceId: String(n.draft?.voiceId || '').slice(0, 60), delivery: String(n.draft?.delivery || 'calm').slice(0, 30), revision: Math.max(1, Number(n.draft?.revision) || 1)}, takes, timing};
}

// Whether the selected take can be used for preview/export right now, and why not.
// rows = current kept timeline; order = current scene order.
export function narrationState(n, rows, order) {
  if (!n?.enabled || !n.selectedTakeId) return {active: false, reason: 'off'};
  const take = n.takes.find(t => t.id === n.selectedTakeId);
  if (!take) return {active: false, reason: 'missing', text: 'The selected narration take is missing. Choose or import a take.'};
  const t = n.timing;
  // An AI take speaks the text it was made from: edited text needs a new take (an imported take is the user's own).
  if (take.source !== 'imported' && take.scriptHash !== scriptHash(n.draft, order)) return {active: false, reason: 'script', take, text: 'The narration text changed after this AI take was made, so the audio no longer matches. Generate a new take or undo the edit.'};
  if (!t || t.takeId !== take.id) return {active: false, reason: 'timing', take, text: 'Place the scenes in the narration before export.'};
  if (t.scriptHash !== scriptHash(n.draft, order)) return {active: false, reason: 'script', take, text: 'The narration text changed after this take was placed. Review the take again or make a new one.'};
  if (t.timelineHash !== timelineHash(rows)) return {active: false, reason: 'timeline', take, text: 'Scenes were trimmed, reordered or replaced. Review the narration timing again (no new take is needed).'};
  const issues = timingIssues(t.sceneMarks, rows, take.durationSeconds, order.filter(id => String(n.draft.sceneTexts[id] || '').trim()));
  if (issues.length) return {active: false, reason: 'issues', take, issues, text: issues.length + ' scene' + (issues.length > 1 ? 's need' : ' needs') + ' timing review.'};
  if (!t.reviewed) return {active: false, reason: 'review', take, text: 'Play each scene and confirm the timing.'};
  return {active: true, take, marks: t.sceneMarks};
}

export function newTakeId() { return 'take_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10)); }
