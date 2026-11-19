// Story Workspace → 🎙 Narration (AI narration plan, owner 2026-10-31, Phase 1): import a narration take, edit the
// narration text, place each scene's slice of the take on the waveform timeline, review it, and use it for preview,
// subtitles, SRT and MP4 export. Off by default; with it off nothing about playback or export changes.
import * as S from './story-workspace.mjs';
import * as N from './story-narration.mjs';
import * as T from './narration-timeline.mjs';
import * as F from './story-finish.mjs';
import {inspectNarration, analyzeVoice} from './story-render.mjs';

// pilot: show the 🎙 button (stories that already have narration always show it, so it can be turned off or removed).
export function createNarration({getProject, getOrder, storyTimeline, stopPlayback, onChange, notice, generator = null, pilot = false}) {
  const $ = id => document.getElementById(id), node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  let projectId = '', record = null, rows = [], current = {active: false, reason: 'off'}, draft = null, open = false, inspecting = 0;
  const audioCache = new Map(), speechCache = new Map(), player = new Audio(); player.preload = 'auto'; player.hidden = true; document.body.append(player);
  let playerTake = '', playerUrl = '', review = null, stopTimer = 0, playRun = 0;

  async function blobFor(takeId) { if (!audioCache.has(takeId)) audioCache.set(takeId, S.narrationAudio(takeId)); return audioCache.get(takeId); }
  async function speechFor(takeId) { if (!speechCache.has(takeId)) speechCache.set(takeId, blobFor(takeId).then(b => b ? analyzeVoice(b) : [])); return speechCache.get(takeId); }
  const scenesOf = () => getProject()?.project?.scenes || [];
  const label = id => 'Scene ' + (getOrder().indexOf(id) + 1);

  // Called by the workspace after every load: the record, the kept timeline and whether narration applies right now.
  async function refresh(id) {
    if (id !== projectId) { projectId = id; player.pause(); }
    const project = getProject(), order = getOrder();
    if (!project) { record = null; current = {active: false, reason: 'off'}; return current; }
    try { record = await S.narration(id); } catch { record = null; }
    rows = (await storyTimeline()).rows;
    current = record ? N.narrationState(record, rows, order) : {active: false, reason: 'off'};
    if (current.active) await preparePlayer(current.take.id); else player.pause();
    $('openNarration')?.classList.toggle('active', !!current.active);
    if ($('openNarration')) $('openNarration').hidden = !((typeof pilot === 'function' ? pilot() : pilot) && N.narrationFits(project.setup)) && !record;
    return current;
  }
  async function preparePlayer(takeId) {
    if (playerTake === takeId) return;
    const blob = await blobFor(takeId); if (!blob) return;
    player.pause(); if (playerUrl) URL.revokeObjectURL(playerUrl); playerUrl = URL.createObjectURL(blob); player.src = playerUrl; playerTake = takeId;
  }

  // Preview: keep the take where the story clock is (never looped, silent between slices).
  function sync(storyTime, playing) {
    clearTimeout(stopTimer);
    if (!current.active || !playing || storyTime === null) { player.pause(); return; }
    const at = T.narrationAt(T.schedule(current.marks, rows), storyTime);
    if (!at) { player.pause(); return; }
    player.volume = record.volume;
    if (Math.abs(player.currentTime - at.audioTime) > 0.15) player.currentTime = at.audioTime;
    if (player.paused) player.play().catch(() => {});
    // Stop at the slice end by the story clock or the take's own position, whichever comes first: never into the next line.
    stopTimer = setTimeout(() => player.pause(), Math.max(0, Math.min(at.remaining, at.audioTime + at.remaining - player.currentTime)) * 1000);
  }
  function pause() { clearTimeout(stopTimer); player.pause(); }

  // Subtitles from the narration (phrase timing inside each scene's slice; not word-level alignment).
  async function cuesFor(id) {
    if (!current.active) return null;
    const mark = current.marks.find(m => m.sceneId === id), row = rows.find(r => r.id === id);
    if (!mark || !row) return [];
    const segments = T.sliceSegments(await speechFor(current.take.id), mark.from, mark.to);
    return T.sliceCuesToClip(F.timeCues(record.draft.sceneTexts[id] || '', mark.to - mark.from, segments), mark, row);
  }
  function voiceFor(id) { if (!current.active) return null; const row = rows.find(r => r.id === id); return row ? T.clipWindows(T.schedule(current.marks, rows), row) : []; }
  async function exportOptions() {
    if (!record?.enabled) return null;
    if (!current.active) throw Error((current.text || 'Narration needs review.') + ' Or turn narration off in 🎙 Narration to export with the original audio.');
    return {narration: {blob: await blobFor(current.take.id), slices: T.schedule(current.marks, rows), volume: record.volume}, originalVolume: record.originalVolume};
  }

  // ---------- dialog ----------
  function info(text, bad = false) { $('narrInfo').textContent = text; $('narrInfo').classList.toggle('error', bad); }
  function takeOf(d = draft) { return d?.takes.find(t => t.id === d.selectedTakeId) || null; }
  async function openDialog() {
    if (!getProject()) return;
    stopPlayback(); open = true; onChange();
    rows = (await storyTimeline()).rows;
    try { draft = record ? N.narrationSettings(record) : N.emptyNarration(getProject(), getOrder()); } catch (e) { draft = N.emptyNarration(getProject(), getOrder()); info(e.message, true); }
    for (const id of getOrder()) if (draft.draft.sceneTexts[id] === undefined) draft.draft.sceneTexts[id] = N.emptyNarration(getProject(), getOrder()).draft.sceneTexts[id];
    // Compact dialog: the script starts folded once there is a take, the number fields start hidden.
    $('narrScriptStep').open = !draft.takes.length; $('narrMarks').classList.remove('fine'); $('narrFine').setAttribute('aria-pressed', 'false');
    $('narrFile').value = ''; info(''); renderDialog(); $('narrationDialog').showModal();
    generator?.opened?.(api);
    // A placement made before the fitting existed (or after clips changed) that shows overflow: place it again for the user.
    const take = takeOf(), marks = take && draft.timing && draft.timing.takeId === take.id ? draft.timing.sceneMarks : null;   // no take yet: nothing placed
    if (take && marks?.length && !draft.timing.reviewed && T.timingIssues(marks, rows, take.durationSeconds, getOrder().filter(id => String(draft.draft.sceneTexts[id] || '').trim())).some(i => i.code === 'overflow')) await autoPlace().catch(e => info(e.message, true));
  }
  function closeDialog() { inspecting++; playRun++; stopReview(); generator?.stop?.(); open = false; draft = null; $('narrationDialog').close(); onChange(); }
  function renderDialog() {
    $('narrEnabled').checked = !!draft.enabled; $('narrVolume').value = String(Math.round(draft.volume * 100)); $('narrVolumeOut').textContent = $('narrVolume').value + '%';
    $('narrOriginal').value = String(Math.round(draft.originalVolume * 100)); $('narrOriginalOut').textContent = $('narrOriginal').value + '%'; renderMix();
    const texts = $('narrScript'); texts.replaceChildren();
    for (const id of getOrder()) {
      const row = node('label', undefined, 'narr-line'), area = node('textarea'); area.rows = 2; area.maxLength = N.MAX_SCENE_TEXT; area.value = draft.draft.sceneTexts[id] || '';
      // Grows with its text (no resize handle), so every line is fully visible.
      const fit = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 2 + 'px'; };
      area.oninput = () => { draft.draft.sceneTexts[id] = area.value; draft.draft.revision++; if (draft.timing) draft.timing.reviewed = false; fit(); renderState(); };
      requestAnimationFrame(fit); area.rows = 1;
      row.append(node('small', String(getOrder().indexOf(id) + 1)), area); area.setAttribute('aria-label', label(id) + ' narration'); texts.append(row);
    }
    renderTakes(); renderMarks(); renderState(); generator?.render?.(api);
  }
  // A folded Script step has no height to measure: size the lines when it opens.
  $('narrScriptStep').addEventListener('toggle', () => { for (const a of $('narrScript').querySelectorAll('textarea')) { a.style.height = 'auto'; a.style.height = a.scrollHeight + 2 + 'px'; } });
  function renderTakes() {
    const list = $('narrTakes'); list.replaceChildren();
    // No takes: nothing to list; Generate and the import link sit right here.
    for (const t of draft.takes) {
      const row = node('div', undefined, 'narr-take'), pick = node('input'); pick.type = 'radio'; pick.name = 'narrTake'; pick.checked = draft.selectedTakeId === t.id;
      pick.onchange = () => { draft.selectedTakeId = t.id; if (draft.timing?.takeId !== t.id) draft.timing = null; renderMarks(); renderState(); };
      const text = node('span', (t.name || t.voiceId || (t.source !== 'imported' ? 'AI narrator' : 'Imported')) + ' · ' + t.durationSeconds.toFixed(1) + ' s');
      const listen = node('button', '▶'); listen.type = 'button'; listen.title = 'Listen to this take'; listen.setAttribute('aria-label', 'Listen to this take'); listen.onclick = () => listenTake(t.id, listen);
      const remove = node('button', '✕'); remove.type = 'button'; remove.title = 'Remove this take'; remove.setAttribute('aria-label', 'Remove this take');
      remove.onclick = async () => { if (!confirm('Remove this narration take from this story? It cannot be undone.')) return; try { draft = await S.removeNarrationTake(projectId, draft, t.id); record = draft; audioCache.delete(t.id); speechCache.delete(t.id); renderDialog(); } catch (e) { info(e.message, true); } };
      row.append(pick, text, listen, remove); list.append(row);
    }
  }
  function marksOf() { return draft.timing && draft.selectedTakeId && draft.timing.takeId === draft.selectedTakeId ? draft.timing.sceneMarks || [] : []; }
  function setMarks(marks, reviewed = false) { draft.timing = {takeId: draft.selectedTakeId, timelineHash: T.timelineHash(rows), scriptHash: N.scriptHash(draft.draft, getOrder()), reviewed, sceneMarks: marks}; }
  function renderMarks() {
    const box = $('narrMarks'); box.replaceChildren(); const take = takeOf();
    $('narrAuto').disabled = !take; $('narrReviewed').disabled = !take; $('narrPlayAll').disabled = !take; $('narrFine').disabled = !take;
    if (!take) { $('narrFitSummary').textContent = ''; box.append(node('p', 'Generate or import a take first; the scenes are placed for you.', 'trim-note')); return; }
    const marks = marksOf(), issues = T.timingIssues(marks, rows, take.durationSeconds, getOrder().filter(id => String(draft.draft.sceneTexts[id] || '').trim()));
    // Words per second of this take (pauses included), to say how many words would fill a quiet clip end.
    const gaps = T.quietGaps(marks, rows), spoken = marks.reduce((n, m) => n + Math.max(0, m.to - m.from), 0);
    const pace = spoken > 0 ? marks.reduce((n, m) => n + F.spokenText(draft.draft.sceneTexts[m.sceneId] || '').split(/\s+/).filter(Boolean).length, 0) / spoken : 2.8;
    let quietCount = 0;
    for (const id of getOrder()) {
      const m = marks.find(x => x.sceneId === id), row = rows.find(r => r.id === id), line = node('div', undefined, 'narr-mark');
      const field = (key, title) => { const f = node('label', title), input = node('input'); input.type = 'number'; input.step = '0.05'; input.min = '0'; input.value = m ? String(m[key]) : ''; input.disabled = !m;
        input.onchange = () => { const v = Number(input.value); if (!Number.isFinite(v) || v < 0) return; setMarks(marksOf().map(x => x.sceneId === id ? {...x, [key]: Math.round(v * 1000) / 1000} : x)); renderMarks(); renderState(); }; f.append(input); return f; };
      const play = node('button', '▶', 'narr-play'); play.type = 'button'; play.disabled = !m || !row; play.title = 'Play ' + label(id) + ' with its narration'; play.setAttribute('aria-label', play.title); play.onclick = () => reviewScene(id);
      const own = issues.filter(i => i.sceneId === id), quiet = !own.length && gaps.find(g => g.sceneId === id);
      // One short status per scene; the longer advice only where something needs doing.
      const status = !m ? ['not placed', 'warn'] : own.length ? ['needs a fix', 'bad'] : quiet ? [quiet.seconds.toFixed(1) + ' s quiet at the end', 'warn'] : ['✓ ' + (m.to - m.from).toFixed(1) + ' s' + (m.delay > 0 ? ', starts +' + m.delay.toFixed(1) + ' s' : '') + (row ? ' of ' + row.keptDuration.toFixed(1) + ' s' : ''), 'ok'];
      const fields = node('div', undefined, 'narr-fields'); fields.append(field('from', 'From (s)'), field('to', 'To (s)'), field('delay', 'Start after (s)'));
      line.append(play, node('strong', label(id)), node('span', status[0], 'narr-fit ' + status[1]), fields);
      for (const issue of own) line.append(node('small', issue.text, 'narr-issue'));
      if (quiet) { quietCount++; const add = Math.max(2, Math.round(quiet.seconds * pace * 0.9)); line.append(node('small', take.source !== 'imported' ? 'Add about ' + add + ' words to line ' + (getOrder().indexOf(id) + 1) + ' in Script, then generate again.' : 'Add about ' + add + ' words to this line when you record it again.', 'narr-quiet')); }
      box.append(line);
    }
    const bad = new Set(issues.map(i => i.sceneId)).size;
    $('narrFitSummary').textContent = !marks.length ? 'not placed yet' : bad ? bad + ' scene' + (bad === 1 ? ' needs' : 's need') + ' a fix' : quietCount ? '✓ all fit · ' + quietCount + ' quiet end' + (quietCount === 1 ? '' : 's') : '✓ all ' + marks.length + ' scenes fit';
    $('narrReviewed').checked = !!draft.timing?.reviewed && !issues.length; $('narrReviewed').disabled = !!issues.length || !marks.length;
  }
  function renderState() {
    const order = getOrder(), take = takeOf(), st = N.narrationState({...draft, enabled: true}, rows, order);
    const words = order.reduce((n, id) => n + F.spokenText(draft.draft.sceneTexts[id] || '').split(/\s+/).filter(Boolean).length, 0);
    $('narrSummary').textContent = words + ' words · ~' + Math.round(words / 2.5) + ' s' + (take ? ' · take ' + take.durationSeconds.toFixed(1) + ' s' : '');
    $('narrState').textContent = !take ? 'Narration is off for this story until you import or generate a take.' : st.active ? 'Ready: preview and export use this narration.' : (st.text || '');
    $('narrState').classList.toggle('error', !!take && !st.active && st.reason !== 'review');
  }
  function renderMix() { $('narrMixSummary').textContent = 'voice ' + Math.round(draft.volume * 100) + '% · clips ' + Math.round(draft.originalVolume * 100) + '%'; }
  // Listen to a whole take (no video), from the Voice step.
  async function listenTake(takeId, button) {
    const playing = review?.listen === takeId; playRun++; $('narrPlayAll').textContent = '▶ Play all'; stopReview(); if (playing) return;
    const audio = $('narrAudio'), blob = await blobFor(takeId); if (!blob) return;
    review = {urls: [URL.createObjectURL(blob)], timers: [], listen: takeId, button}; audio.src = review.urls[0]; audio.volume = draft.volume; button.textContent = '■';
    audio.onended = () => stopReview(); audio.play().catch(() => stopReview());
  }
  // Play every placed scene in order, each with its clip, so the whole story can be checked in one go.
  async function playAll() {
    const ids = getOrder().filter(id => marksOf().some(m => m.sceneId === id) && rows.some(r => r.id === id)); if (!ids.length) return;
    const run = ++playRun;
    for (const id of ids) {
      if (run !== playRun || !open) return;
      await reviewScene(id, true); const row = rows.find(r => r.id === id);
      await new Promise(r => setTimeout(r, row.keptDuration * 1000 + 150));
    }
    if (run === playRun) { stopReview(); $('narrPlayAll').textContent = '▶ Play all'; }
  }
  // Review one scene: its clip from the kept start (original sound at the chosen level) with the narration slice.
  async function reviewScene(id, chained = false) {
    if (!chained) { playRun++; $('narrPlayAll').textContent = '▶ Play all'; }
    stopReview(); const m = marksOf().find(x => x.sceneId === id), clip = await S.clips(projectId).then(list => list.find(c => c.sceneId === id)), row = rows.find(r => r.id === id);
    if (!m || !clip || !row) return;
    const video = $('narrVideo'), audio = $('narrAudio'), blob = await blobFor(draft.selectedTakeId);
    review = {urls: [URL.createObjectURL(clip.blob), URL.createObjectURL(blob)], timers: []};
    video.src = review.urls[0]; audio.src = review.urls[1]; video.hidden = false; video.volume = draft.originalVolume; audio.volume = draft.volume;
    await new Promise(r => { video.onloadedmetadata = r; setTimeout(r, 1500); });
    video.currentTime = row.trimStart; audio.currentTime = m.from; await video.play().catch(() => {});
    review.timers.push(setTimeout(() => audio.play().catch(() => {}), (m.delay || 0) * 1000));
    review.timers.push(setTimeout(() => audio.pause(), ((m.delay || 0) + m.to - m.from) * 1000));
    review.timers.push(setTimeout(() => video.pause(), row.keptDuration * 1000));
  }
  function stopReview() { if (!review) return; if (review.button) review.button.textContent = '▶'; $('narrAudio').onended = null; $('narrVideo').hidden = true; for (const t of review.timers) clearTimeout(t); $('narrVideo').pause(); $('narrAudio').pause(); $('narrVideo').removeAttribute('src'); $('narrAudio').removeAttribute('src'); for (const u of review.urls) URL.revokeObjectURL(u); review = null; }

  async function importTake(file) {
    const run = ++inspecting; info('Checking the audio…');
    try {
      const meta = await inspectNarration(file); if (run !== inspecting || !open) return;
      const bytes = await file.arrayBuffer(), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const take = {id: N.newTakeId(), source: 'imported', name: file.name, mimeType: file.type, durationSeconds: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, bytes: file.size, sha256: digest, scriptHash: N.scriptHash(draft.draft, getOrder()), createdAt: Date.now()};
      await addTake(take, new Blob([bytes], {type: file.type || 'audio/mpeg'}));
    } catch (e) { if (run === inspecting) info(e.message, true); }
  }
  // Shared by import and generated takes: saved locally first; the previous take stays until the user removes it.
  async function addTake(take, blob) {
    draft = await S.addNarrationTake(projectId, {...draft, selectedTakeId: draft.selectedTakeId || take.id}, take, blob); record = draft;
    if (draft.selectedTakeId !== take.id && confirm('Use the new take for this story? The previous take is kept either way.')) { draft.selectedTakeId = take.id; draft.timing = null; }
    renderDialog();
    // Placed right away, so the user does not need to know about Auto place.
    if (draft.selectedTakeId === take.id && !draft.timing) await autoPlace().catch(() => {});
  }
  async function autoPlace() {
    const take = takeOf(); if (!take) return; info('Finding pauses in the narration…');
    const scenes = getOrder().filter(id => String(draft.draft.sceneTexts[id] || '').trim()).map(id => ({id, text: draft.draft.sceneTexts[id]}));
    const speech = await speechFor(take.id), fit = T.fitMarks(T.firstPassMarks(scenes, take.durationSeconds, speech), rows, speech);
    setMarks(fit.marks); renderMarks(); renderState();
    const left = T.timingIssues(fit.marks, rows, take.durationSeconds, scenes.map(s => s.id)).filter(i => i.code === 'overflow').length;
    // Plain words, no seconds to type: most users only need to press Play scene and tick the review box.
    if (fit.over > 0.05) info('The narration is ' + fit.over.toFixed(1) + ' s longer than all the clips together, so ' + left + ' scene' + (left === 1 ? '' : 's') + ' cannot fit. Shorten the narration text and generate again, or use longer clips.', true);
    else if (left) info(left + ' scene' + (left === 1 ? ' is' : 's are') + ' still a little long (no pause to cut at). Lower its "to" time, or shorten that line and generate again.', true);
    else {
      const quiet = T.quietGaps(fit.marks, rows).length;
      info('Placed: every scene fits its clip' + (fit.marks.some(m => m.delay > 0) ? '. A few lines run on a moment into the next clip, like a normal edit' : fit.moved.length ? '. A few words moved to the next scene where a line was too long' : '') + '.' + (quiet ? ' ' + quiet + ' scene' + (quiet === 1 ? ' ends' : 's end') + ' with a silent stretch; the note under ' + (quiet === 1 ? 'it' : 'each') + ' says how many words would fill it.' : '') + ' Press Play all to check, then tick the box.');
    }
  }
  async function save() {
    try {
      $('saveNarration').disabled = true;
      if (draft.timing) draft.timing = {...draft.timing, timelineHash: T.timelineHash(rows), scriptHash: N.scriptHash(draft.draft, getOrder())};
      if (draft.enabled && !N.narrationState(draft, rows, getOrder()).active) throw Error('Finish the timing review before turning narration on, or save with narration off.');
      record = await S.saveNarration(projectId, draft); closeDialog(); await refresh(projectId); onChange();
      notice(record.enabled ? 'Narration saved. Preview, subtitles and export now use it.' : 'Narration saved (off). Playback and export use the original audio.');
    } catch (e) { info(e.message, true); } finally { $('saveNarration').disabled = false; }
  }

  $('openNarration').onclick = () => openDialog().catch(e => notice(e.message, true));
  $('narrFile').onchange = () => { const f = $('narrFile').files[0]; if (f) importTake(f); };
  $('narrAuto').onclick = () => autoPlace().catch(e => info(e.message, true));
  $('narrPlayAll').onclick = () => { if ($('narrPlayAll').textContent.startsWith('■')) { playRun++; stopReview(); $('narrPlayAll').textContent = '▶ Play all'; return; } $('narrPlayAll').textContent = '■ Stop'; playAll().catch(e => info(e.message, true)); };
  $('narrFine').onclick = () => { const on = $('narrMarks').classList.toggle('fine'); $('narrFine').setAttribute('aria-pressed', String(on)); };
  // Reviewed is almost always followed by "use it": turn it on together (it can still be unticked before saving).
  $('narrReviewed').onchange = () => { if (draft.timing) draft.timing.reviewed = $('narrReviewed').checked; if ($('narrReviewed').checked) { draft.enabled = true; $('narrEnabled').checked = true; } renderState(); };
  $('narrEnabled').onchange = () => { draft.enabled = $('narrEnabled').checked; };
  $('narrVolume').oninput = () => { draft.volume = Number($('narrVolume').value) / 100; $('narrVolumeOut').textContent = $('narrVolume').value + '%'; renderMix(); };
  $('narrOriginal').oninput = () => { draft.originalVolume = Number($('narrOriginal').value) / 100; $('narrOriginalOut').textContent = $('narrOriginal').value + '%'; renderMix(); };
  $('saveNarration').onclick = save; $('cancelNarration').onclick = closeDialog; $('closeNarration').onclick = closeDialog;
  $('narrationDialog').oncancel = e => { e.preventDefault(); closeDialog(); };
  window.addEventListener('pagehide', () => { player.pause(); if (playerUrl) URL.revokeObjectURL(playerUrl); stopReview(); });

  const api = {refresh, sync, pause, cuesFor, voiceFor, exportOptions, isOpen: () => open, state: () => current, originalVolume: () => record?.originalVolume ?? 0, draft: () => draft, projectId: () => projectId, addTake, info, order: getOrder, language: () => getProject()?.setup?.language || '', redrawTakes: () => { if (open && draft) renderTakes(); },
    // Seconds of clip that carry narration (scenes with a line), to warn before generating a take that cannot fit.
    clipSeconds: () => rows.filter(r => String(draft?.draft.sceneTexts[r.id] || '').trim()).reduce((n, r) => n + r.keptDuration, 0)};
  return api;
}
