// Project backup and restore (owner 2026-10-29): projects live only in this Chrome profile's IndexedDB, so removing the
// extension, another profile or clearing site data loses them. A backup file brings them back. Images travel as data URLs;
// Story Workspace video clips are not included (the MP4s are already in the user's Downloads).
export const BACKUP_FORMAT = 'flow-studio-project-backup';
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

const blobToDataUrl = blob => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });

// narrations (optional): [{projectId, record, blob}] from story-workspace.mjs backupNarrations(); the selected take only.
export async function packBackup(records, now = Date.now(), narrations = []) {
  const projects = [];
  for (const p of records) {
    if (p.id === 'draft') continue;
    const media = {};
    for (const [id, m] of Object.entries(p.media || {})) if (m?.blob) media[id] = {name: m.name, sha256: m.sha256, type: m.blob.type, dataUrl: await blobToDataUrl(m.blob)};
    projects.push({...p, media});
  }
  const backup = {format: BACKUP_FORMAT, version: 1, exportedAt: now, projects};
  // An optional field: backups stay version 1, and readers that do not know it simply skip it.
  if (narrations.length) backup.narrations = await Promise.all(narrations.map(async n => ({projectId: n.projectId, record: n.record, audio: {type: n.blob.type, dataUrl: await blobToDataUrl(n.blob)}})));
  return backup;
}

// Narrations to restore: only for projects that have none in this browser (never overwritten). Damaged entries are skipped.
export function narrationRestorePlan(data, existingIds, validate = r => r) {
  const have = new Set(existingIds), out = [];
  for (const n of Array.isArray(data?.narrations) ? data.narrations : []) {
    if (typeof n?.projectId !== 'string' || !n.projectId || have.has(n.projectId) || !n.audio?.dataUrl) continue;
    try { const record = validate(n.record); if (record.takes.length !== 1) continue; out.push({projectId: n.projectId, record, take: record.takes[0], blob: dataUrlToBlob(n.audio.dataUrl, n.audio.type)}); have.add(n.projectId); } catch { /* skipped, the project itself still restores */ }
  }
  return out;
}

export function dataUrlToBlob(dataUrl, type) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) throw Error('A saved image in the backup is damaged.');
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], {type: type || m[1] || 'application/octet-stream'});
}

// Records to save from a backup. Projects already in this browser are kept as they are (never overwritten).
export function restorePlan(data, existingIds) {
  if (data?.format !== BACKUP_FORMAT || data.version !== 1 || !Array.isArray(data.projects)) throw Error('This is not a 0xFlow project backup.');
  const have = new Set(existingIds), add = [];
  let skipped = 0;
  for (const p of data.projects) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id === 'draft') continue;
    if (have.has(p.id)) { skipped++; continue; }
    const media = {};
    for (const [id, m] of Object.entries(p.media || {})) if (m?.dataUrl) media[id] = {name: m.name, sha256: m.sha256, blob: dataUrlToBlob(m.dataUrl, m.type)};
    // A story that was still being written cannot resume its old server job; it opens as "Needs attention".
    add.push({...p, media, ...(['queued', 'running'].includes(p.state) ? {state: 'failed', error: 'Restored from a backup while it was still being written. Rebuild it.'} : {})});
    have.add(p.id);
  }
  return {add, skipped};
}
