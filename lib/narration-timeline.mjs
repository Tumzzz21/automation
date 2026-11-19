// Narration timeline (AI narration plan, owner 2026-10-31): one shared, pure mapping from a narration take to story
// time, used by preview, subtitles, SRT, music ducking and MP4 export, so they can never disagree.
// rows: the kept story timeline [{id, offset, trimStart, keptDuration}] (story-workspace storyTimeline()).
// marks: one per scene [{sceneId, from, to, delay}] in take seconds; the scene's slice of the take [from, to) starts
// `delay` seconds after the kept clip starts. Marks are placed by the user; nothing here claims word-level alignment.
const round = t => Math.round(t * 1000) / 1000;
export const MAX_SPILL = 1.5;

export function timelineHash(rows) {
  return JSON.stringify((rows || []).map(r => [r.id, round(r.offset), round(r.trimStart || 0), round(r.keptDuration)]));
}

// Scheduled slices in story time: [{sceneId, at, from, length}], sorted by `at`.
export function schedule(marks, rows) {
  const byId = new Map((rows || []).map(r => [r.id, r]));
  return (marks || []).filter(m => byId.has(m.sceneId) && m.to > m.from).map(m => {
    const row = byId.get(m.sceneId);
    return {sceneId: m.sceneId, at: row.offset + Math.max(0, m.delay || 0), from: m.from, length: m.to - m.from};
  }).sort((a, b) => a.at - b.at);
}

// Problems that block a narrated export. Each names the scene so the review panel can point at it.
export function timingIssues(marks, rows, takeDuration, sceneIds = (rows || []).map(r => r.id)) {
  const issues = [], byScene = new Map((marks || []).map(m => [m.sceneId, m])), rowById = new Map((rows || []).map(r => [r.id, r]));
  let lastTo = 0;
  for (const id of sceneIds) {
    const m = byScene.get(id), row = rowById.get(id);
    if (!row) { issues.push({sceneId: id, code: 'no-clip', text: 'This scene has no clip in the story.'}); continue; }
    if (!m) { issues.push({sceneId: id, code: 'no-mark', text: 'Place this scene in the narration.'}); continue; }
    if (!(m.from >= 0) || !(m.to > m.from)) { issues.push({sceneId: id, code: 'empty', text: 'This scene has no narration selected.'}); continue; }
    if (m.to > takeDuration + 0.01) issues.push({sceneId: id, code: 'past-end', text: 'The selection runs past the end of the narration.'});
    if (m.from < lastTo - 0.01) issues.push({sceneId: id, code: 'overlap', text: 'This scene repeats narration from the scene before.'});
    // A line may run on into the next clip by up to MAX_SPILL s (owner 2026-10-31: a voice only pauses about every 2 s,
    // so exact cuts often cannot fit); the next scene's part must then start after it ("Start after"), so voices never overlap.
    const next = (rows || []).find(r => Math.abs(r.offset - (row.offset + row.keptDuration)) < 0.01), nextMark = next && sceneIds.includes(next.id) ? byScene.get(next.id) : null;
    const spill = !next ? 0 : Math.min(MAX_SPILL, nextMark ? Math.max(0, nextMark.delay || 0) : next.keptDuration);
    const room = row.keptDuration - Math.max(0, m.delay || 0) + spill, need = m.to - m.from;
    if (need > room + 0.05) issues.push({sceneId: id, code: 'overflow', text: 'The narration is ' + (need - room).toFixed(1) + ' s longer than this clip. Trim the selection, start it earlier, or use a longer clip.'});
    lastTo = Math.max(lastTo, m.to);
  }
  return issues;
}

// Where the take is at story time t (for preview): {audioTime, sceneId, remaining} or null when no narration plays at t.
export function narrationAt(slices, t) {
  for (const s of slices || []) if (t >= s.at && t < s.at + s.length) return {audioTime: s.from + (t - s.at), sceneId: s.sceneId, remaining: s.at + s.length - t};
  return null;
}

// The narration window inside one clip, in ORIGINAL clip time (same convention as analyzeVoice), for music ducking.
export function clipWindows(slices, row) {
  const start = row.offset, end = row.offset + row.keptDuration, out = [];
  for (const s of slices || []) {
    const a = Math.max(start, s.at), b = Math.min(end, s.at + s.length);
    if (b > a) out.push({start: (row.trimStart || 0) + a - start, end: (row.trimStart || 0) + b - start});
  }
  return out;
}

// Cues timed inside one scene's slice of the take (slice time, from timeCues) moved to ORIGINAL clip time, so the
// existing subtitle drawing and toSRT() use the narration, not the muted clip audio.
export function sliceCuesToClip(cues, mark, row) {
  const shift = (row.trimStart || 0) + Math.max(0, mark.delay || 0), limit = (row.trimStart || 0) + row.keptDuration;
  return (cues || []).map(c => ({...c, start: c.start + shift, end: Math.min(limit, c.end + shift), words: (c.words || []).map(w => ({...w, start: w.start + shift, end: Math.min(limit, w.end + shift)}))})).filter(c => c.end > c.start);
}

// Speech windows of the take that fall inside [from, to), moved to slice time (input for timeCues()).
export function sliceSegments(segments, from, to) {
  return (segments || []).map(s => ({start: Math.max(from, s.start) - from, end: Math.min(to, s.end) - from})).filter(s => s.end - s.start > 0.02);
}

// A first placement for review: the take is cut in scene order in proportion to each scene's text length, and every
// cut moves to the middle of the nearest pause, however far (owner 2026-10-31: a cut inside speech clipped words in the
// export). The first and last cuts keep a little room so soft starts and word tails are not lost. Not alignment.
export function firstPassMarks(scenes, takeDuration, segments = []) {
  const weights = scenes.map(s => Math.max(1, String(s.text || '').replace(/\s+/g, '').length)), total = weights.reduce((a, b) => a + b, 0);
  const speech = (segments || []).filter(s => s.end > s.start);
  const start = speech.length ? Math.max(0, speech[0].start - 0.15) : 0, end = speech.length ? Math.min(takeDuration, speech[speech.length - 1].end + 0.35) : takeDuration;
  const gaps = speech.slice(1).map((s, i) => (speech[i].end + s.start) / 2);
  const cuts = [start];let acc = 0;
  for (let i = 0; i < scenes.length - 1; i++) {
    acc += weights[i];
    let cut = start + (end - start) * acc / total;
    const near = gaps.filter(g => g > cuts[cuts.length - 1] + 0.3 && g < end - 0.3).sort((a, b) => Math.abs(a - cut) - Math.abs(b - cut))[0];
    if (near !== undefined) cut = near;
    cuts.push(Math.max(cuts[cuts.length - 1], cut));
  }
  cuts.push(end);
  return scenes.map((s, i) => ({sceneId: s.id, from: round(cuts[i]), to: round(cuts[i + 1]), delay: 0}));
}

// Owner 2026-10-31 (users struggled with "x s longer than this clip"): moves the cuts between scenes so every scene's
// part fits its clip. Cuts land only on pauses, so no word is cut, dropped or repeated. A voice only pauses about every
// 2 s, so when exact cuts cannot fit, a line may run on into the next clip (at most MAX_SPILL s) like a normal edit, and
// the next scene's part starts just after it (its "Start after"). Exact fits are preferred, then cuts close to the plan.
// Returns {marks, moved, over}: moved = scenes whose part changed, over = seconds the whole narration is longer than all
// the clips. When nothing fits, the marks come back unchanged.
export function fitMarks(marks, rows, segments = []) {
  const rowOf = new Map((rows || []).map(r => [r.id, r])), list = (marks || []).map(m => ({...m}));
  const kept = m => rowOf.get(m.sceneId)?.keptDuration ?? Infinity, space = m => kept(m) - Math.max(0, m.delay || 0);
  const need = list.reduce((n, m) => n + Math.max(0, m.to - m.from), 0), have = list.reduce((n, m) => n + Math.max(0, space(m)), 0);
  const result = (out, moved = []) => ({marks: out, moved, over: round(Math.max(0, need - have))});
  if (!list.length || !timingIssues(list, rows, Infinity, list.map(m => m.sceneId)).some(i => i.code === 'overflow')) return result(list);
  const speech = (segments || []).filter(s => s.end > s.start);
  // Pauses only: a cut anywhere else lands inside a word. Without any detected pause the original cuts are all there is.
  const pauses = speech.slice(1).map((s, i) => round((speech[i].end + s.start) / 2)), cand = [...new Set(pauses.length ? pauses : list.slice(1).map(m => m.from))].sort((a, b) => a - b);
  const start = list[0].from, end = list[list.length - 1].to, n = list.length;
  const adjacent = i => { const r = rowOf.get(list[i].sceneId), s = rowOf.get(list[i + 1]?.sceneId); return !!(r && s && Math.abs(s.offset - (r.offset + r.keptDuration)) < 0.01); };
  // Each state: where the next scene's part starts (at), how late in its clip (delay), the cost so far and the path.
  let states = [{at: start, delay: 0, cost: 0, path: []}];
  for (let i = 0; i < n && states.length; i++) {
    const last = i === n - 1, next = [];
    for (const st of states) {
      const room = kept(list[i]) - st.delay, longest = room + (!last && adjacent(i) ? MAX_SPILL - 0.2 : 0);
      for (const p of last ? [end] : cand.filter(p => p > st.at + 0.3 && p - st.at <= longest && p < end - 0.3)) {
        const over = Math.max(0, p - st.at - room);
        if (last && over > 0.05) continue;
        next.push({at: p, delay: over > 0.05 ? round(over + 0.15) : 0, cost: st.cost + (last ? 0 : Math.abs(p - list[i].to)) + over * 3, path: [...st.path, {...list[i], from: st.at, to: p, delay: st.delay}]});
      }
    }
    // Keep, per cut, only states not beaten on both delay (room left later) and cost.
    const byAt = new Map();for (const s of next) (byAt.get(s.at) || byAt.set(s.at, []).get(s.at)).push(s);
    states = [...byAt.values()].flatMap(group => { group.sort((a, b) => a.delay - b.delay || a.cost - b.cost); let best = Infinity; return group.filter(s => s.cost < best && (best = s.cost, true)); });
  }
  if (!states.length) return result(list);
  const out = states.reduce((a, b) => b.cost < a.cost ? b : a).path;
  return result(out, out.filter((m, i) => m.from !== list[i].from || m.to !== list[i].to || (m.delay || 0) !== (list[i].delay || 0)).map(m => m.sceneId));
}

// Owner 2026-10-31 ("dead air"): scenes whose narration ends well before their clip does. Not a blocking issue; the
// review panel suggests adding words to that line. A part that runs on into the next clip has no gap.
export function quietGaps(marks, rows, minSeconds = 1.2) {
  const rowOf = new Map((rows || []).map(r => [r.id, r]));
  return (marks || []).flatMap(m => {
    const r = rowOf.get(m.sceneId), gap = r ? r.keptDuration - Math.max(0, m.delay || 0) - (m.to - m.from) : 0;
    return gap >= minSeconds ? [{sceneId: m.sceneId, seconds: round(gap)}] : [];
  });
}
