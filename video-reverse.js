// video-reverse.js — Video → Story (owner 2026-11-04). The user's video is uploaded to their own Gemini chat, which
// reads it with 0xFlow's own reverse/0xflow-video-reader.md and rebuilds it with reverse/0xflow-scene-rebuilder.md
// (owner 2026-11-04: our own files, written from the 0xFlow Tagalog Drama rulebook and validator). The scenes come back as JSON in the 0xFlow Tagalog Drama format and are saved as
// normal Story Builder projects (niche 34, reference images first, scene image + video), so the usual
// reference → start frame → review → video steps run on them. Scenes the validator rejects go back to Gemini to fix.
(() => {
  'use strict';
  const MAX_BYTES = 200 * 1024 * 1024, MAX_SECONDS = 15 * 60, PART_MAX = 18, BATCH_MAX = 8, MAX_BATCHES = 15, REPAIRS = 2;
  // Owner 2026-11-04: the two instruction files live on the server (server/video-reverse/) and are fetched for signed-in
  // members at the start of each run; they are not part of the extension package.
  const FILES = {analyzer: '0xflow-video-reader.md', builder: '0xflow-scene-rebuilder.md'};

  const AUTOMATION = [
    '',
    '---',
    'Start now with batch 1: reply with ONE fenced json block and nothing before or after it, holding at most ' + BATCH_MAX + ' scenes in the Section 9 shape, with "done": true only in the batch that holds the last line of RECORD 6.'
  ].join('\n');
  const NEXT = 'tuloy — next batch: ONE fenced json block in the same shape (only new cards in "assets", scene IDs continuing, "done" true only on the last batch).';

  // ---------- pure helpers (unit-tested in tests/video-reverse.test.cjs) ----------

  // Gemini sometimes writes real line breaks or tabs inside JSON strings; escape them so the batch still parses.
  function looseJson(text) {
    try { return JSON.parse(text); } catch {}
    let out = '', inString = false, escaped = false;
    for (const c of String(text)) {
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        else if (c === '\n') { out += '\\n'; continue; }
        else if (c === '\r') continue;
        else if (c === '\t') { out += '\\t'; continue; }
      } else if (c === '"') inString = true;
      out += c;
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
  }

  // ---------- shot cuts measured in the browser (owner 2026-11-08) ----------
  // Gemini guesses where the original's shots change; 0xFlow now measures the camera cuts from the video's own frames (in
  // the panel, nothing leaves the PC) and sends the times with the first message, so RECORD 6 and the scene pacing follow
  // the real cuts. Each sampled frame becomes a small signature: a 3 x 16-bin colour histogram plus a 16 x 9 grey thumbnail.
  const CUT_W = 64, CUT_H = 36, CUT_STEP = 0.1, CUT_MIN_SHOT = 0.5;
  function frameSignature(rgba, w = CUT_W, h = CUT_H) {
    const hist = new Float32Array(48), grey = new Float32Array(144), n = w * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      hist[r >> 4]++; hist[16 + (g >> 4)]++; hist[32 + (b >> 4)]++;
      grey[Math.floor(y * 9 / h) * 16 + Math.floor(x * 16 / w)] += (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    }
    for (let i = 0; i < 48; i++) hist[i] /= n;
    const cell = n / 144; for (let i = 0; i < 144; i++) grey[i] /= cell;
    return {hist, grey};
  }
  // 0 = same picture, 1 = nothing in common. The histogram ignores movement inside a shot; the thumbnail catches a cut
  // between two shots with the same colours (the same room from another side).
  function frameDifference(a, b) {
    let h = 0, p = 0;
    for (let i = 0; i < 48; i++) h += Math.abs(a.hist[i] - b.hist[i]);
    for (let i = 0; i < 144; i++) p += Math.abs(a.grey[i] - b.grey[i]);
    return {hist: h / 6, pix: p / 144};
  }
  // Tuned on a 0xFlow story export (owner 2026-11-08): real cuts scored 0.12-0.37 on the thumbnail, movement inside a
  // shot stayed under 0.13 (typical frame 0.014). A cut must also stand out from the frames around it, so fast handheld
  // motion or a dance does not count as a string of cuts.
  const CUT_PIX = 0.1, CUT_HIST = 0.4;
  // Dark night shots change less on both scores (owner test 2026-11-08: 0.33 colour + 0.098 thumbnail was a real cut).
  const isCut = d => d.hist >= CUT_HIST || d.pix >= CUT_PIX || (d.hist >= 0.25 && d.pix >= 0.06);
  const sameShot = d => d.hist < 0.2 && d.pix < 0.07;
  // frames: [{t, sig}] in time order. A cut is the first frame of the new shot. A one-frame flash (camera flash, lightning,
  // a white frame) is not a cut: the frame after it looks like the frame before it again.
  function cutsFromFrames(frames, {minShot = CUT_MIN_SHOT} = {}) {
    const diffs = frames.map((x, i) => i ? frameDifference(frames[i - 1].sig, x.sig) : {hist: 0, pix: 0}), cuts = [];
    for (let i = 1; i < frames.length; i++) {
      const d = diffs[i];
      if (!isCut(d) && !(d.hist >= 0.12 && d.pix >= 0.06)) continue;
      const around = [];
      for (let j = i - 1; j >= 1 && frames[i].t - frames[j].t <= 1.5; j--) if (frames[i].t - frames[j].t > 0.25) around.push(diffs[j].pix);
      for (let j = i + 1; j < frames.length && frames[j].t - frames[i].t <= 1.5; j++) if (frames[j].t - frames[i].t > 0.25) around.push(diffs[j].pix);
      around.sort((x, y) => x - y);
      const usual = around.length ? around[around.length >> 1] : 0;
      if (d.hist < CUT_HIST && d.pix < usual * 4) continue;
      // Two near-identical shots (owner test 2026-11-08 at 0:42, the same boy and puppy, new clip): a small jump that is
      // far above the still frames around it.
      if (!isCut(d) && d.pix < Math.max(usual * 8, 0.06)) continue;
      const next = frames[i + 1];
      if (next && next.t - frames[i].t < 0.35 && sameShot(frameDifference(frames[i - 1].sig, next.sig))) continue;
      const before = frames[i - 2];   // the frame right after a flash looks like the one before the flash
      if (before && frames[i].t - before.t < 0.35 && sameShot(frameDifference(before.sig, frames[i].sig))) continue;
      const t = Math.round(frames[i].t * 10) / 10, last = cuts.length ? cuts[cuts.length - 1] : 0;
      if (t - last < minShot) continue;
      cuts.push(t);
    }
    // Dissolves (owner test 2026-11-08: a 2-second cross-fade from the talking bag to the junkyard was missed): every step
    // changes a little, so no single step is a cut. A run of at least 0.4 s of steady change whose two ends look like two
    // different shots is one cut, placed at its biggest step.
    // A cross-fade changes the colours on every step (0.1-0.4); people moving inside a shot change the thumbnail but keep
    // the colours (about 0.04), so only steady colour change counts here.
    const moving = d => d.hist >= 0.08;
    for (let i = 1; i < frames.length;) {
      if (!moving(diffs[i])) { i++; continue; }
      let j = i; while (j + 1 < frames.length && moving(diffs[j + 1])) j++;
      const span = frames[j].t - frames[i - 1].t;
      if (span >= 0.4 && span <= 3.5) {
        const ends = frameDifference(frames[i - 1].sig, frames[j].sig);
        let peak = i; for (let k = i; k <= j; k++) if (diffs[k].hist + diffs[k].pix > diffs[peak].hist + diffs[peak].pix) peak = k;
        const t = Math.round(frames[peak].t * 10) / 10;
        if ((ends.hist >= CUT_HIST || ends.pix >= CUT_PIX) && !cuts.some(c => c >= frames[i - 1].t - minShot && c <= frames[j].t + minShot)) cuts.push(t);
      }
      i = j + 1;
    }
    cuts.sort((x, y) => x - y);
    // A fade-out or a last-frame glitch at the very end is not a new shot.
    const end = frames.length ? frames[frames.length - 1].t : 0;
    return cuts.filter((t, k) => end - t >= 1 && (!k || t - cuts[k - 1] >= minShot));
  }
  const clockTime = t => { const m = Math.floor(t / 60), sec = t - m * 60; return String(m).padStart(2, '0') + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1); };
  // The block added to the first message. Empty when nothing was measured (old browser, unreadable video): the run then
  // works exactly as before.
  function cutsMessage(cuts, seconds) {
    if (!Array.isArray(cuts) || !cuts.length || !(seconds > 0)) return '';
    const shots = [0, ...cuts].map((start, i, all) => ({start, end: i + 1 < all.length ? all[i + 1] : seconds}));
    const avg = seconds / shots.length;
    return ['', '---', 'MEASURED CAMERA CUTS — 0xFlow measured the cuts of this video from its frames (' + shots.length + ' shots, ' + clockTime(seconds) + ' long, about ' + avg.toFixed(1) + ' s per shot). A new shot starts at each of these times (mm:ss.s):',
      cuts.map(clockTime).join(', '),
      'Use these real times: every [mm:ss] in RECORD 6 and RECORD 7 sits in the shot where it really happens, a CUT TO is written only at one of these cuts, and the rebuilt shots keep the original\'s rhythm (short where the original cuts fast, long where it holds). A slow fade or dissolve may not be listed; add it if you see one. The word limit of each shot still comes first: a line too long for a short shot gets a longer shot or continues in the next one.'].join('\n');
  }

  // Gemini's own short error replies ("I encountered an error doing what you asked. Could you try again?").
  function geminiFailed(text) {
    const t = String(text || '').trim();
    return t.length < 300 && /encountered an error|something went wrong|could you try again|try again later/i.test(t);
  }
  // One batch from Gemini's reply: the code blocks first (largest first), then the outermost {...} of the text.
  function parseBatch(reply) {
    const codes = (Array.isArray(reply?.codes) ? reply.codes : []).slice().sort((a, b) => b.length - a.length);
    const text = String(reply?.text ?? reply ?? '');
    const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]);
    const brace = text.indexOf('{') >= 0 ? [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)] : [];
    for (const raw of [...codes, ...fenced, ...brace]) {
      let data;
      try { data = looseJson(String(raw).trim()); } catch { continue; }
      if (!data || !Array.isArray(data.scenes)) continue;
      return {
        title: String(data.title || '').trim(), voice: String(data.voice || '').trim(), done: data.done === true,
        assets: (Array.isArray(data.assets) ? data.assets : []).filter(a => a && typeof a.id === 'string').map(a => ({id: a.id.trim(), imagePrompt: String(a.imagePrompt || '').trim()})),
        scenes: data.scenes.filter(s => s && typeof s === 'object').map(s => ({
          id: String(s.id || ''), durationSeconds: Number(s.durationSeconds) || 10, speech: String(s.speech ?? '').replace(/\s+/g, ' ').trim(),
          caption: String(s.caption ?? ''), imagePrompt: String(s.imagePrompt || '').trim(), videoPrompt: String(s.videoPrompt || '').replace(/\r\n?/g, '\n').trim(),
          references: Array.isArray(s.references) ? [...new Set(s.references.map(String))] : [], source: String(s.source ?? '').trim()}))
      };
    }
    return null;
  }

  // mixed: the server sent the 4/6/8/10-second rules (owner 2026-11-05), so scenes keep their own length; 'flex' (owner
  // 2026-11-07): the 3-15-second rules for Omni 1.2 Flash. true means 'mixed' (older callers).
  function setupFor(title, count, mixed = false) {
    return {niche: '34', topicMode: 'Reference description', topic: 'Rebuilt from the user’s own video: ' + (title || 'Tagalog drama'), language: 'Tagalog',
      sceneDuration: '10', sceneCount: String(count), format: 'Cinematic story', partsTotal: '1', partNumber: 1, style: 'Photorealistic cinematic',
      imageMode: 'Extension image queue', exportProfile: 'Scene image + video', destination: 'Save in extension', imageWorkflow: 'Reference images first', reverseVideo: true, ...(mixed ? {sceneLengths: mixed === 'flex' ? 'flex' : 'mixed'} : {})};
  }

  // Each scene is checked on its own with every card known so far, so one bad scene names itself.
  // Owner test 2026-11-08: "Tagalog dialogue exceeds its individual shot word budget" alone did not tell Gemini which shot
  // was too full, and both repair rounds failed. The repair message now names each shot, its length, its word count and
  // the most it may hold (the same table as the builder validator), and how to fix it.
  const SHOT_MAX = {2: 6, 2.5: 8, 3: 10, 3.5: 12, 4: 13, 4.5: 15, 5: 16};
  const clock = t => { const [m, sec] = String(t).split(':'); return Number(m) * 60 + Number(sec); };
  function shotBudgetDetails(scene, B) {
    const out = [], count = typeof B?.spokenWords === 'function' ? B.spokenWords : text => String(text).trim().split(/\s+/).filter(Boolean).length;
    for (const m of String(scene.videoPrompt || '').matchAll(/\[(\d{1,2}:\d{2}(?:\.\d+)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\.\d+)?)\]\s*SHOT\s*(\d+)\s*[—-]([^]*?)(?=\[\d{1,2}:|\nAUDIO\s*[—-]|$)/g)) {
      const length = clock(m[2]) - clock(m[1]), max = SHOT_MAX[length] || Math.floor(length * 3.3);
      const words = count([...m[4].matchAll(/["“]([^"”]+)["”]/g)].map(x => x[1]).join(' '));
      if (words > max) out.push('SHOT ' + m[3] + ' [' + m[1] + '-' + m[2] + '] is ' + length + ' s and holds ' + words + ' spoken words; a ' + length + ' s shot may hold at most ' + max);
    }
    return out.length ? ' (' + out.join('; ') + '. Fix: make that shot longer by taking time from a shot with fewer words or a silent shot, keeping the scene length, or move the words that do not fit into the next shot of the same speaker or the next scene. Never drop or change a spoken word.)' : '';
  }
  function sceneProblems(batch, known, B) {
    const assets = [...known.assets, ...batch.assets.filter(a => !known.assets.some(k => k.id === a.id))], voice = known.voice || batch.voice;
    const problems = [];
    if (!batch.scenes.length) problems.push('the batch has no scenes');
    batch.scenes.forEach((scene, i) => {
      const label = scene.id || 'scene ' + (i + 1);
      // Only the cards this scene uses (plus any it names that do not exist, so that error is reported): a whole video can
      // have more cards than one project allows (live test 2026-11-04: batch 4 brought card 13).
      const used = assets.filter(a => scene.references.includes(a.id));
      const {source, ...plain} = scene;
      try { B.validateProject({title: known.title || batch.title || 'Video', voice, assets: used, scenes: [{...plain, id: 'scene_001'}]}, setupFor(known.title || batch.title, 1, known.mixed)); }
      catch (e) { const text = String(e.message || e); problems.push(label + ': ' + text.replace(/scene_001/g, label) + (/individual shot word budget/i.test(text) ? shotBudgetDetails(scene, B) : '')); }
    });
    return problems;
  }

  // Owner review 2026-11-04 (restaurant test): slips the builder validator allows but Veo gets wrong. Gemini is asked to fix
  // them with the other problems; if it cannot within the repair rounds, the batch is still kept (they are not fatal).
  const TAGALOG_WORDS = new Set('ang ng mga na sa si ni po ko mo ka siya ako ikaw kayo tayo kami sila hindi oo opo kaya lang pala ba naman nga ito iyan yan iyon yun natin namin ninyo nila din rin pa kung pero at may wala dito diyan doon saan bakit paano sino ano anak sige ngayon talaga muna ha eh kasi daw raw nang yung kay kina akin atin amin iyo kanya'.split(' '));
  const ENGLISH_WORDS = new Set('the a an your you i is are to of and it me my we us our sir maam ma\'am doesn\'t don\'t make money call give most good evening welcome please thank thanks yes no what why how this that be do does not with for at else anything everything'.split(' '));
  function englishOnly(line) {
    const words = line.toLowerCase().replace(/[^a-z'\s-]/g, ' ').split(/\s+/).filter(Boolean);
    return words.length >= 2 && !words.some(w => TAGALOG_WORDS.has(w.replace(/^'|'$/g, ''))) && words.some(w => ENGLISH_WORDS.has(w));
  }
  // Owner tests 2026-11-05: Flow sees only the start frame, so a face it did not see clearly is invented in a later close-up.
  // (1) someone shown from behind in START FRAME gets a close-up, a single or an on-camera line; (2) Shot 1 is wide and a
  // later shot is a close-up. Both go back to Gemini with the other warnings.
  const BACK = /back (?:is )?(?:turned )?to(?:ward)? (?:the )?camera|(?:seen )?from behind|from the back|back of (?:her|his|their) head|(?:faces|facing|turned) away|shoulder (?:soft |blurred )?(?:at|on) the (?:left|right|frame) edge|out of frame/i;
  const WIDE = /\b(?:wide|full[- ]body|full[- ]length|full shot|long shot)\b/i;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function faceHidden(start, name, names) {
    if (new RegExp('\\b' + esc(name) + "['’]s (?:shoulder|back)\\b", 'i').test(start)) return true;
    const others = names.filter(n => n.toLowerCase() !== name.toLowerCase()).map(esc);
    const stop = new RegExp('[;.]' + (others.length ? '|\\b(?:' + others.join('|') + ')\\b' : ''), 'i');
    for (const m of start.matchAll(new RegExp('\\b' + esc(name) + '\\b', 'gi'))) {
      const rest = start.slice(m.index + m[0].length), end = rest.search(stop);
      if (BACK.test(end < 0 ? rest : rest.slice(0, end))) return true;
    }
    return false;
  }
  function faceWarnings(label, text, names) {
    const out = [], start = (text.match(/^START FRAME\s*[—-]\s*(.*)$/m) || [])[1] || '';
    const shots = text.split('\n').filter(l => /^\[\d\d:\d\d/.test(l)).map(l => l.replace(/"[^"]*"/g, ' '));
    // Not named in START FRAME at all counts too (owner test 2026-11-05 "Ang Pagsisinungaling Mo": scene 5 started on a
    // close-up of the man alone and cut to the woman, who got a new face).
    const absent = names.filter(n => !new RegExp('\\b' + esc(n) + '\\b', 'i').test(start));
    const hidden = names.filter(n => absent.includes(n) || faceHidden(start, n, names));
    const wide = shots[0] && WIDE.test(shots[0].split(/\.\s/)[0].replace(/^\[[^\]]*\]\s*SHOT \d+\s*[—-]\s*/, ''));
    shots.forEach((shot, i) => {
      if (!i) return;
      const n = (shot.match(/SHOT (\d+)/) || [])[1] || String(i + 1);
      for (const name of hidden) if (new RegExp('(?:close[- ]?up|single|medium shot) on ' + esc(name) + '\\b|\\b' + esc(name) + ' is the only speaking face', 'i').test(shot))
        out.push(label + ' SHOT ' + n + ': ' + name + (absent.includes(name) ? ' is not in the START FRAME' : ' is seen from behind in the START FRAME') + ', so the video would invent ' + name + "'s face here. Either show " + name + "'s face three-quarter toward the camera in the START FRAME (and imagePrompt), or keep " + name + ' from behind in this scene and make the line an explicit off-screen voice over the listener.');
      if (wide && /close[- ]?up/i.test(shot))
        out.push(label + ' SHOT ' + n + ': Shot 1 is a wide shot, so the faces are too small to hold up in this close-up. Keep this scene wide or medium (a slow push-in at most), or start the scene on a medium shot.');
    });
    return out;
  }
  // Mixed lengths (owner tests 2026-11-05): told to stay near the original's running time, Gemini still made 50 s and then
  // 54 s of a 41 s video (two short lines got a 6 s scene). Each scene now names the stretch of the original it covers
  // ("source": "mm:ss-mm:ss", from its first line to where the next scene's first line starts) and may be at most that
  // stretch plus about a second of breathing room, rounded up to 4/6/8/10 — or longer only if its words need it (2.5 per second).
  const LENGTHS = [4, 6, 8, 10];
  function sourceSeconds(source) {
    const m = String(source || '').match(/^(\d{1,2}):(\d\d(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}):(\d\d(?:\.\d+)?)$/);
    return m ? Math.round(((m[3] * 60 + +m[4]) - (m[1] * 60 + +m[2])) * 100) / 100 : null;
  }
  function longestFor(span, words = 0, mode = 'mixed') {
    // flex (Omni 1.2 Flash): whole seconds from 3 to 15.
    if (mode === 'flex') return Math.min(15, Math.max(3, Math.ceil(span + 1 - 1e-9), Math.ceil(words / 2.5 - 1e-9)));
    const fit = n => LENGTHS.find(l => l >= n) || 10;
    return Math.max(fit(span + 1), fit(words / 2.5));
  }
  function lengthWarnings(label, scene, mode = 'mixed') {
    const span = sourceSeconds(scene.source), words = String(scene.speech || '').split(/\s+/).filter(Boolean).length;
    if (span == null) return [label + ': add "source": "mm:ss-mm:ss" — the RECORD 6 time span this scene covers, from its first line to where the next scene\'s first line starts (for example "00:12-00:16").'];
    if (span <= 0) return [label + ': "source" ' + scene.source + ' must end after it starts.'];
    const most = longestFor(span, words, mode);
    if (scene.durationSeconds > most) return [label + ': it covers only ' + span + ' s of the original video (' + scene.source + '), so it may be at most ' + most + ' seconds, not ' + scene.durationSeconds + '. Make it a ' + most + '-second scene (same words, shorter shots), or join it with the next scene.'];
    return [];
  }
  const ROOM_FILLER = new Set('soft softly blurred blur wall walls background light lighter beige cream warm muted neutral plain toned tone with and the out focus bokeh slightly gently color colour colored coloured dim dark pale white behind same'.split(' '));
  // The things that make a room recognisable (doorframe, decal, slats), not the words for "some wall".
  function roomWords(s) { return String(s || '').toLowerCase().split(/[^\p{L}]+/u).filter(w => w.length >= 4 && !ROOM_FILLER.has(w)); }
  function promptWarnings(batch, known) {
    const voice = known.voice || batch.voice || '', out = [];
    const locked = voice.split(';').map(x => x.split(/\s[—-]\s/)[0].trim()).filter(Boolean);
    batch.scenes.forEach((scene, i) => {
      const label = scene.id || 'scene ' + (i + 1), text = String(scene.videoPrompt || '').replace(/\r\n?/g, '\n');
      if (known.mixed) out.push(...lengthWarnings(label, scene, known.mixed));
      // Owner test 2026-11-07 (flex): above 10 s Flow charges double, so only one unbroken line may run longer.
      const spoken = (text.match(/^\[\d{1,2}:\d\d[^\n]*"[^"\n]+"/gm) || []).length;
      if (known.mixed === 'flex' && scene.durationSeconds > 10 && spoken > 1)
        out.push(label + ': it is ' + scene.durationSeconds + ' seconds with ' + spoken + ' separate lines. Above 10 seconds Flow charges double, so split it into two scenes of 10 seconds or less at a line break (each with its own source span); only one unbroken line or action may run longer than 10 seconds.');
      // Owner test 2026-11-05 ("Ang Pinili Mong Kasinungalingan"): "medium two-shot" start frames came out waist- or knee-up in
      // 9:16, and the close-ups that followed got softer, changed faces and a blank wall instead of the hallway.
      const comp = (String(scene.imagePrompt || '').match(/COMPOSITION:\s*([^.]*)/i) || [])[1] || '';
      if (/two[- ]shot/i.test(comp) && !/chest|close/i.test(comp) && text.split('\n').some(l => /^\[\d\d:\d\d/.test(l) && /close[- ]?up/i.test(l.replace(/"[^"]*"/g, ' '))))
        out.push(label + ': the clip has close-ups but its start frame is a "' + comp.trim().split(',')[0] + '", which comes out waist-up with small faces. In imagePrompt COMPOSITION write "close two-shot framed from the chest up, both heads in the upper half of the frame" (and match START FRAME), so the faces hold up in the close-ups.');
      // Owner test 2026-11-05: Gemini dropped every ? ! and comma ("Bakit mo inamin Joko Dahil narinig mo na mahal kita"), which
      // flattens the delivery (a question reads like a statement).
      if (String(scene.speech || '').split(/\s+/).filter(Boolean).length >= 4 && !/[?!.,…—–-]/.test(scene.speech))
        out.push(label + ': the lines lost their punctuation. Put back each line\'s own ? ! , . from RECORD 6, in both "speech" and the quoted lines (same words).');
      const block = (text.match(/\nCHARACTERS\b[^\n]*\n([\s\S]*?)\nTIMELINE\b/) || [])[1] || '';
      const listed = block.split('\n').map(l => l.split(/\s[—-]\s/)[0].trim().toLowerCase()).filter(Boolean);
      const offscreen = new Set([...text.matchAll(/off[- ]screen voice of ([\p{L}][\p{L} .'-]*?)(?=[;,.])/giu)].map(m => m[1].trim().toLowerCase()));
      // An off-screen speaker must still be one of the story's people, written exactly as in the voice lock.
      if (locked.length) for (const who of offscreen) if (!locked.some(n => n.toLowerCase() === who)) {
        const near = locked.find(n => n.toLowerCase().endsWith(who) || who.endsWith(n.toLowerCase()));
        out.push(label + ': "off-screen voice of ' + who.toUpperCase() + '" is not a name from the voice lock' + (near ? '; write ' + near : '') + '. Use the exact name of a person in the story.');
      }
      let rest = text.slice(0, text.search(/\nAUDIO\b/) > 0 ? text.search(/\nAUDIO\b/) : undefined).replace(/\nCHARACTERS\b[\s\S]*?\nTIMELINE\b/, '\n').replace(/"[^"]*"/g, ' ');
      for (const name of [...new Set([...locked, ...listed.map(n => n.toUpperCase())])].sort((a, b) => b.length - a.length)) {
        const re = new RegExp('(^|[^\\p{L}])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}])', 'giu');
        if (re.test(rest) && !listed.includes(name.toLowerCase()) && !offscreen.has(name.toLowerCase())) out.push(label + ': ' + name + ' is named in the prompt but has no line in its CHARACTERS block. Add a CHARACTERS line for ' + name + ' or remove the name.');
        rest = rest.replace(re, '$1#');
      }
      const rooms = {}, faceless = new Set();
      // Owner test 2026-11-06 (second run of "Ang Kasinungalingan Mo"): after the face rule Gemini gave all 8 scenes the same
      // two-shot start frame, then opened 6 of them with "Punch-in medium close-up on MARCO" at 00:00 — a jump on frame one.
      const shotLines = text.split('\n').filter(l => /^\[\d\d:\d\d/.test(l)).map(l => l.replace(/"[^"]*"/g, ' '));
      const who = shotLines.map(l => ((l.match(/close[- ]?up on ([\p{L}]+)/iu) || [])[1] || '').toUpperCase());
      if (/two[- ]shot/i.test(comp) && shotLines.length) {
        if (who.every(w => w && w === who[0]))
          out.push(label + ': every shot is on ' + who[0] + ', but the start frame is a two-shot. Start this scene on a medium close-up of ' + who[0] + ' (the other person only a soft shoulder at the edge) and write that in COMPOSITION and START FRAME; SHOT 1 then shows that frame as it is.');
        else if (/^\[00:00[^\]]*\]\s*SHOT 1\s*[—–-]\s*(?:punch[- ]in|(?:tight |medium )?close[- ]?up)/i.test(shotLines[0]))
          out.push(label + ' SHOT 1: it opens on a close-up at 00:00, but the start frame is a two-shot, so the clip would jump on its first frame. SHOT 1 shows the start frame as it is; move the punch-in to SHOT 2.');
      }
      for (const shot of text.split('\n').filter(l => /^\[\d\d:\d\d/.test(l))) {
        // Owner test 2026-11-05 (mixed lengths): a 0.5 s closing reaction shot slipped through; the rules ask for 1.5 s or more.
        const span = shot.match(/^\[(\d\d):(\d\d(?:\.\d+)?)\s*-\s*(\d\d):(\d\d(?:\.\d+)?)\]/);
        if (span && (span[3] * 60 + +span[4]) - (span[1] * 60 + +span[2]) < 1.5 - 1e-9)
          out.push(label + ' ' + (shot.match(/SHOT \d+/) || ['a shot'])[0] + ' is only ' + ((span[3] * 60 + +span[4]) - (span[1] * 60 + +span[2])) + ' s long; every shot needs at least 1.5 seconds. Merge it into the shot before it, or drop it and give its time to that shot.');
        const n = (shot.match(/SHOT (\d+)/) || [])[1] || '?', who = (shot.match(/([\p{L}][\p{L} ]*?) is the only speaking face/u) || [])[1];
        if (who && (/\binsert\b/i.test(shot) || new RegExp(who.trim() + '[^.;]*off[- ](?:camera|screen)', 'i').test(shot)))
          out.push(label + ' SHOT ' + n + ': ' + who.trim() + ' speaks off-camera, so do not write "is the only speaking face". Write: Explicit off-screen voice of ' + who.trim() + '; all visible characters stay silent with mouths closed.');
        // Owner test 2026-11-05 ("Ang Piling Kasinungalingan"): SHOT 1 put JOKO before "the wood doorframe", SHOT 2 (closer) before
        // "the muted cream wall"; the clip then swapped the room for a blank or patterned wall. Same person, same scene → same room.
        const plain = shot.replace(/"[^"]*"/g, ' '), subject = ((plain.match(/close[- ]?up on ([\p{L}]+)/iu) || [])[1] || '').toUpperCase();
        const behind = (plain.match(/behind (?:him|her|them)(?: is| are)?\s+([^.;]+)/i) || [])[1];
        // Owner test 2026-11-06 ("Ang Kasinungalingan Mo" scene 2): the start frame was JOKO alone, SHOT 2 cut to ELLA, and she came
        // out with a different face and top and no bag. A face the start frame does not show is invented.
        if (subject && comp && listed.includes(subject.toLowerCase()) && !new RegExp('(^|[^\\p{L}])' + subject + '(?![\\p{L}])', 'iu').test(comp) && !faceless.has(subject)) {
          faceless.add(subject);
          out.push(label + ' SHOT ' + n + ': it shows ' + subject + ' close up, but the start frame (COMPOSITION: "' + comp.trim().split(';')[0] + '") does not show ' + subject + '\'s face. A face that is not in the start frame comes out changed (other face, other clothes). Start this scene on a close two-shot framed from the chest up with both faces (name both in COMPOSITION), or give ' + subject + '\'s shot its own scene.');
        }
        if (subject) {
          const prev = rooms[subject];
          if (prev && !(behind && roomWords(behind).some(w => roomWords(prev.text).includes(w))))
            out.push(label + ' SHOT ' + n + ': ' + (behind ? 'behind ' + subject + ' it says "' + behind.trim() + '"' : 'it does not say what is behind ' + subject) + ', but SHOT ' + prev.n + ' has "' + prev.text.trim() + '". A closer shot of the same person keeps the same room: repeat the same background words (same objects), or the video model invents a new wall.');
          if (behind && roomWords(behind).length && !prev) rooms[subject] = {n, text: behind};
        }
        for (const m of shot.matchAll(/in natural Tagalog:\s*"([^"]*)"/g)) if (englishOnly(m[1]))
          out.push(label + ' SHOT ' + n + ': the line "' + m[1] + '" is English, so write "in English with a natural Filipino accent:" instead of "in natural Tagalog:" (keep the words verbatim).');
      }
      out.push(...faceWarnings(label, text, block.split('\n').map(l => l.split(/\s[—-]\s/)[0].trim()).filter(Boolean)));
    });
    return out;
  }

  function mergeBatches(batches) {
    const merged = {title: '', voice: '', assets: [], scenes: []};
    for (const b of batches) {
      merged.title ||= b.title; merged.voice ||= b.voice;
      for (const a of b.assets) if (!merged.assets.some(x => x.id === a.id)) merged.assets.push(a);
      merged.scenes.push(...b.scenes);
    }
    merged.scenes = merged.scenes.map((s, i) => ({...s, id: 'scene_' + String(i + 1).padStart(3, '0')}));
    return merged;
  }

  // Up to 18 scenes per project; a longer video becomes Part 1 / Part 2 … standalone projects of even size.
  // Owner test 2026-11-04 ("Ang Karapatan sa Pamamahay"): Gemini shortened the AUDIO voice lock to bare names ("Voice lock:
  // GRACE, BRYAN.") and wrote "OPENING STATE:" instead of "OPENING STATE —". The voice list is already in the project, so the
  // full voice of each named speaker is filled in here, and the heading gets its long dash.
  function polishScene(scene, voice) {
    const voices = new Map(String(voice || '').split(';').map(x => x.trim()).filter(Boolean).map(x => [x.split(/\s[—–-]\s/)[0].trim().toLowerCase(), x]));
    const videoPrompt = scene.videoPrompt
      .replace(/^OPENING STATE\s*:\s*/m, 'OPENING STATE — ')
      .replace(/Voice lock:\s*([^\n]*?)\.(?= No music)/, (all, list) => {
        if (/\s[—–-]\s/.test(list)) return all;   // already full voices
        const names = list.split(/,|\band\b/).map(n => n.trim()).filter(Boolean);
        return names.every(n => voices.has(n.toLowerCase())) ? 'Voice lock: ' + names.map(n => voices.get(n.toLowerCase())).join('; ') + '.' : all;
      });
    return videoPrompt === scene.videoPrompt ? scene : {...scene, videoPrompt};
  }

  let wideRun = false;   // the uploaded video is wide (16:9 and similar): its records are saved as wide stories
  function buildRecords(merged, B, now = Date.now(), uuid = () => crypto.randomUUID()) {
    const total = merged.scenes.length;
    if (!total) throw Error('Gemini returned no scenes.');
    const parts = Math.ceil(total / PART_MAX), size = Math.ceil(total / parts), records = [];
    const batchId = uuid();
    for (let p = 0; p < parts; p++) {
      const scenes = merged.scenes.slice(p * size, (p + 1) * size).map(({source, ...s}, i) => ({...polishScene(s, merged.voice), id: 'scene_' + String(i + 1).padStart(3, '0')}));
      const title = (merged.title || 'Video rebuild') + (parts > 1 ? ' · Part ' + (p + 1) : '');
      const setup = setupFor(merged.title, scenes.length, merged.mixed);
      const used = new Set(scenes.flatMap(s => s.references));
      const project = B.validateProject({title, voice: merged.voice, assets: merged.assets.filter(a => used.has(a.id)), scenes}, setup);
      records.push({id: uuid(), kind: 'project', state: 'prompts_ready', origin: 'video-reverse', reverseBatchId: batchId, reversePart: p + 1, reverseParts: parts,
        createdAt: now + p, day: new Date(now).toISOString().slice(0, 10), requestId: uuid(), setup, project, media: {}, imagesReviewed: false, ...(wideRun ? {aspect: '16:9'} : {})});
    }
    return records;
  }

  function validateVideo(file) {
    if (!(file instanceof Blob) || !file.size) throw Error('Choose a video file first.');
    if (file.size > MAX_BYTES) throw Error('The video is larger than 200 MB. Trim or compress it first.');
    if (file.type && !/^video\//i.test(file.type)) throw Error('That file is not a video (' + file.type + ').');
    return file;
  }

  // ---------- page functions (run inside the Gemini tab) ----------

  function pg_reverseState() {
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const editor = Array.from(document.querySelectorAll('div.ql-editor[contenteditable="true"]')).find(shown) || null;
    const chips = Array.from(document.querySelectorAll('uploader-file-preview')).filter(c => !c.closest('user-query, model-response'));
    const busySelector = 'mat-spinner,mat-progress-spinner,mat-progress-bar,[role="progressbar"],[aria-busy="true"],[class*="spinner"],[class*="progress"],[class*="loading"]';
    let ready = 0, uploading = 0;
    for (const chip of chips) {
      const busy = Array.from(chip.querySelectorAll(busySelector)).some(e => e.getClientRects().length > 0) || /uploading|processing|preparing|\b\d{1,3}\s*%/i.test(chip.innerText || '');
      if (busy) uploading++; else ready++;
    }
    const buttons = Array.from(document.querySelectorAll('button')).filter(shown);
    const stop = buttons.some(b => /^stop( response| generating)?$/i.test(b.getAttribute('aria-label') || ''));
    const users = Array.from(document.querySelectorAll('user-query')), models = Array.from(document.querySelectorAll('model-response'));
    const last = models.at(-1), after = !!(users.at(-1) && last && (users.at(-1).compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING));
    const body = after ? (last.querySelector('message-content .markdown, .markdown') || last) : null;
    return {editor: !!editor, editorText: editor ? editor.innerText : '', chips: chips.length, chipsReady: ready, chipsBusy: uploading,
      busy: stop, userCount: users.length, answered: after && !!(body?.innerText || '').trim(),
      text: body ? body.innerText : '', codes: body ? Array.from(body.querySelectorAll('code')).map(c => c.innerText).filter(t => t.length > 20) : []};
  }

  // The composer's real file input appears only after the "+" menu (and sometimes its "Upload files" item) opens
  // (live test 2026-11-02, video-reverse copy): poll for it instead of querying once.
  async function pg_reverseAttach(f) {
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const findInput = () => Array.from(document.querySelectorAll('input[type=file]')).find(i => !String(i.id || '').includes('xtnp')) || null;
    const waitInput = async ms => { for (const until = Date.now() + ms; Date.now() < until;) { const i = findInput(); if (i) return i; await new Promise(r => setTimeout(r, 250)); } return null; };
    const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
    const file = new File([bytes], f.name, {type: f.type || 'video/mp4'});
    let input = await waitInput(500);
    if (!input) {
      const plus = Array.from(document.querySelectorAll('button[aria-label], button[mattooltip]')).find(b => shown(b) && /add|attach|insert|upload|plus/i.test(b.getAttribute('aria-label') || b.getAttribute('mattooltip') || ''));
      if (plus) { plus.click(); input = await waitInput(4000); }
    }
    if (!input) {
      const item = Array.from(document.querySelectorAll('button, [role=menuitem], label')).find(b => shown(b) && /upload\s*files?/i.test(b.innerText || b.textContent || ''));
      if (item) { item.click(); input = await waitInput(3000); }
    }
    if (!input) return {ok: false, error: 'no file input'};
    try {
      const dt = new DataTransfer(); dt.items.add(file); input.value = '';
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (desc?.set) desc.set.call(input, dt.files); else input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true};
    } catch (e) { return {ok: false, error: String(e?.message || e)}; }
  }

  // Gemini's one-time "reminder about creating videos" rights dialog must be confirmed or the send never counts.
  function pg_reverseDismissReminder() {
    const dialog = Array.from(document.querySelectorAll('[role=dialog], mat-dialog-container, .cdk-overlay-pane')).find(d => /rights to any content|reminder about creating/i.test(d.innerText || ''));
    if (!dialog) return {ok: false};
    const buttons = Array.from(dialog.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0);
    const accept = buttons.find(b => !/cancel/i.test(b.innerText || '')) || buttons.at(-1);
    if (!accept) return {ok: false};
    accept.click(); return {ok: true};
  }

  function pg_reverseSend() {
    const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const buttons = Array.from(document.querySelectorAll('button')).filter(b => shown(b) && (/^send message$|send|submit/i.test(b.getAttribute('aria-label') || b.getAttribute('mattooltip') || '') || b.classList.contains('send-button')));
    const send = buttons.find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!send) return {ok: false};
    send.click(); return {ok: true};
  }

  // ---------- the run ----------

  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  const readDataUrl = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error || Error('The video could not be read.')); r.readAsDataURL(file); });
  const videoSeconds = file => new Promise(resolve => {
    const v = document.createElement('video'), url = URL.createObjectURL(file); v.preload = 'metadata';
    const done = s => { URL.revokeObjectURL(url); resolve(s); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0); v.onerror = () => done(0); setTimeout(() => done(0), 8000); v.src = url;
  });

  // A wide video (16:9 and similar) is rebuilt as a wide story (owner 2026-11-10); vertical and square stay vertical.
  const videoWide = file => new Promise(resolve => {
    const v = document.createElement('video'), url = URL.createObjectURL(file); v.preload = 'metadata';
    const done = wide => { URL.revokeObjectURL(url); resolve(wide); };
    v.onloadedmetadata = () => done(v.videoWidth > 0 && v.videoWidth / v.videoHeight >= 1.2); v.onerror = () => done(false); setTimeout(() => done(false), 8000); v.src = url;
  });

  // Plays the video muted and fast in a hidden <video> and signs one frame every CUT_STEP seconds of video. Best effort:
  // any problem (no requestVideoFrameCallback, a codec the browser cannot decode, a timeout) returns null and the run
  // continues without measured cuts.
  async function measureCuts(file, {seconds = 0, onProgress = () => {}, signal = null, debug = null} = {}) {
    if (typeof document === 'undefined' || !(seconds > 1)) return null;
    const video = document.createElement('video');
    if (typeof video.requestVideoFrameCallback !== 'function') return null;
    const url = URL.createObjectURL(file), canvas = document.createElement('canvas');
    canvas.width = CUT_W; canvas.height = CUT_H;
    const ctx = canvas.getContext('2d', {willReadFrequently: true}), frames = [];
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const limit = setTimeout(() => finish(null), Math.max(60000, seconds / 6 * 1000 + 30000));
    const abort = () => finish(null); signal?.addEventListener?.('abort', abort);
    let lastT = -1, lastShown = 0;
    const onFrame = (now, meta) => {
      const t = Number(meta?.mediaTime ?? video.currentTime);
      if (t - lastT >= CUT_STEP - 0.02) {
        try { ctx.drawImage(video, 0, 0, CUT_W, CUT_H); frames.push({t, sig: frameSignature(ctx.getImageData(0, 0, CUT_W, CUT_H).data)}); lastT = t; }
        catch { finish(null); return; }
        const pct = Math.min(99, Math.floor(t / seconds * 100)); if (pct >= lastShown + 10) { lastShown = pct; onProgress(pct); }
      }
      if (!video.ended) video.requestVideoFrameCallback(onFrame);
    };
    video.onended = () => finish(frames);
    video.onerror = () => finish(null);
    try {
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; setTimeout(() => reject(Error('load')), 15000); });
      // About 8x: a 5-minute video takes ~40 s, one frame about every 0.13 s of video. Short videos run slower for detail.
      video.playbackRate = seconds <= 90 ? 4 : 8;
      video.requestVideoFrameCallback(onFrame);
      await video.play();
      const result = await done;
      if (!result || result.length < 5 || result[result.length - 1].t < seconds * 0.9) return null;
      if (debug) debug.frames = result;
      return cutsFromFrames(result);
    } catch { return null; }
    finally { clearTimeout(limit); signal?.removeEventListener?.('abort', abort); video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  }

  // runId (owner 2026-11-12): Free and Discord Free Pro get 1 Video → Story try a day; the server counts a run once
  // (a resume of the same run is free). Paid Pro is unlimited.
  const RUN_KEY = 'videoReverseLastRun';
  async function loadInstructions(runId = '') {
    if (typeof remoteRepairRequest !== 'function') throw Error('Cloud connection is not loaded on this page.');
    const connection = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    if (!connection.remoteRepairToken || !connection.remoteRepairUrl) throw Error('Connect cloud repair in the Auto-Fix tab first to use Video → Story.');
    let result;
    // Omni 1.2 Flash makes any length from 3 to 15 s (owner 2026-11-07): ask for those rules too. An older server ignores flex=1.
    const model = typeof settings === 'undefined' ? '' : typeof flowModelCurrent === 'function' ? flowModelCurrent(settings.flowModel) : settings.flowModel;
    const flex = /^omni\s*1\.2\s*flash$/i.test(String(model || '').trim());
    try { result = await remoteRepairRequest(connection, '/builder/video-reverse?lengths=mixed' + (flex ? '&flex=1' : '') + (runId ? '&run=' + encodeURIComponent(runId) : '')); }
    catch (e) { throw Error('Could not reach the 0xFlow server to start Video → Story. Check your internet and try again.'); }
    if (result.status === 401) throw Error('Sign in with Google to rebuild a video.');
    if (result.status === 429 && result.body?.code === 'FEATURE_LIMIT') {
      const message = result.body.error || "You've used today's free Video → Story try. Upgrade to Pro for unlimited use.";
      if (typeof upgradeNudge === 'function') upgradeNudge(message, 'reverse');
      throw Object.assign(Error(message), {code: 'FEATURE_LIMIT', upgrade: true});
    }
    if (result.status >= 400) throw Error(result.body?.error || 'Video → Story is not available on this server yet.');
    const {analyzer, builder} = result.body || {};
    if (typeof analyzer !== 'string' || typeof builder !== 'string' || analyzer.length < 1000 || builder.length < 1000) throw Error('Video → Story instructions did not load. Try again in a minute.');
    // An older server ignores ?lengths=mixed and sends the 10-second rules: then every scene stays 10 seconds.
    const lengths = result.body?.sceneLengths;
    return {analyzer, builder, mixed: lengths === 'flex' ? 'flex' : lengths === 'mixed' ? 'mixed' : false};
  }

  // Removes the run's Gemini chat once it is finished, so the instructions do not stay in the member's Gemini history.
  // Best effort: Gemini changes its page often, so a miss never fails the run (the caller says to delete it by hand).
  async function pg_reverseDeleteChat() {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const label = e => ((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')).replace(/\s+/g, ' ').trim();
    const find = (selector, re, root = document) => Array.from(root.querySelectorAll(selector)).filter(shown).find(e => re.test(label(e)));
    const id = (location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!id) return {ok: false, error: 'not a saved chat'};
    // The side-nav row of this chat has a "more" menu; its link points at /app/<id>.
    const row = Array.from(document.querySelectorAll('a[href*="/app/' + id + '"]')).map(a => a.closest('conversation, [data-test-id="conversation"], li, div[role="listitem"]') || a.parentElement).find(Boolean);
    let menu = row && (row.querySelector('[data-test-id="actions-menu-button"]') || find('button', /conversation actions|more|menu/i, row));
    if (!menu) menu = find('button', /open menu for conversation actions|conversation actions/i);
    if (!menu) return {ok: false, error: 'chat menu not found'};
    menu.click(); await wait(600);
    const del = document.querySelector('[data-test-id="delete-button"]') || find('button,[role="menuitem"]', /^\s*delete\b/i);
    if (!del) return {ok: false, error: 'delete item not found'};
    del.click(); await wait(800);
    const confirm = document.querySelector('[data-test-id="confirm-button"]') || find('button', /^\s*delete\s*$/i, document.querySelector('mat-dialog-container, [role="dialog"]') || document);
    if (!confirm) return {ok: false, error: 'confirm button not found'};
    confirm.click(); await wait(1500);
    return {ok: !location.pathname.includes('/app/' + id)};
  }

  // The run works in a Gemini tab. When it ends the member lands back where they started (their page or the extension tab), not
  // on Gemini. A tab that is already the Gemini tab, or one that was closed meanwhile, is left alone.
  async function returnToTab(origin, geminiTabId) {
    if (!origin?.id || origin.id === geminiTabId) return false;
    try {
      await chrome.tabs.get(origin.id);
      await chrome.tabs.update(origin.id, {active: true});
      if (origin.windowId != null) await chrome.windows.update(origin.windowId, {focused: true});
      return true;
    } catch { return false; }
  }

  // resume = error.resume from a failed run: continue its batches in the same Gemini chat (no new upload or analysis).
  async function runInner(file, {onStatus = () => {}, signal = null, resume = null} = {}) {
    const B = globalThis.FacelessBuilder;
    for (const name of ['getGeminiTab', 'waitForTabComplete', 'exec', 'pg_geminiFocusEditor', 'dataUrlToB64'])
      if (typeof globalThis[name] !== 'function') throw Error('The Gemini engine is not loaded on this page.');
    if (!resume) validateVideo(file);
    const origin = (await chrome.tabs.query({active: true, lastFocusedWindow: true}).catch(() => []))[0] || null;
    const alive = () => { if (signal?.aborted) throw Error('Video → Story cancelled.'); if (typeof running !== 'undefined' && running) throw Error('A generation queue is running; wait for it to finish.'); };
    const seconds = resume ? 0 : await videoSeconds(file);
    const wide = resume ? !!resume.wide : await videoWide(file);
    wideRun = wide;
    if (wide && !resume && typeof log === 'function') log('Video → Story: the video is wide, so the story will be Wide 16:9 (change it under Shape on the project page).');
    if (seconds > MAX_SECONDS) throw Error('The video is ' + Math.round(seconds / 60) + ' minutes long. Use a video of 15 minutes or less.');
    // Trying the SAME video again after a failure keeps its run id, so a failed try does not use up the day's free try.
    const fileKey = resume ? '' : [file.name, file.size, file.lastModified].join('|');
    const lastRun = resume ? null : (await chrome.storage.local.get(RUN_KEY).catch(() => ({})))[RUN_KEY];
    const runId = resume?.runId || (lastRun?.key === fileKey && lastRun.runId) || crypto.randomUUID();
    if (!resume) await chrome.storage.local.set({[RUN_KEY]: {key: fileKey, runId}}).catch(() => {});
    const {analyzer, builder, mixed} = await loadInstructions(runId);
    alive();
    let state, tab, cutNote = '';
    if (resume) {
      tab = await chrome.tabs.get(resume.tabId).catch(() => null);
      if (!tab || !/^https:\/\/gemini\.google\.com\//.test(tab.url || '')) throw Error('The Gemini chat of the last run was closed. Start again.');
    } else {
    onStatus('Reading the video…');
    const {b64} = dataUrlToB64(await readDataUrl(file));
    onStatus('Reading the video… finding the camera cuts');
    const cuts = await measureCuts(file, {seconds, signal, onProgress: p => onStatus('Reading the video… finding the camera cuts ' + p + '%')});
    alive();
    cutNote = cutsMessage(cuts, seconds);
    if (typeof log === 'function') log(cuts ? 'Video → Story: measured ' + cuts.length + ' camera cuts in ' + Math.round(seconds) + ' s of video.' : 'Video → Story: camera cuts not measured; Gemini times the shots itself.');
    onStatus('Opening a new chat…');
    tab = await getGeminiTab(0);
    await chrome.tabs.update(tab.id, {url: 'https://gemini.google.com/app'});
    await waitForTabComplete(tab.id); await sleepMs(2500); alive();
    for (const until = Date.now() + 60000; Date.now() < until; await sleepMs(1500)) { state = await exec(tab.id, pg_reverseState, [], 'MAIN'); if (state.editor) break; alive(); }
    if (!state?.editor) throw Error('Gemini did not open. Sign in to gemini.google.com in this browser, then try again.');
    onStatus('Uploading the video…');
    const attached = await exec(tab.id, pg_reverseAttach, [{name: file.name || 'video.mp4', base64: b64, type: file.type || 'video/mp4'}], 'MAIN');
    if (!attached?.ok) {
      const pasted = typeof pg_geminiPasteImages === 'function' ? await exec(tab.id, pg_geminiPasteImages, [[{name: file.name || 'video.mp4', base64: b64, type: file.type || 'video/mp4'}]], 'MAIN') : null;
      if (!pasted?.ok) throw Error('Gemini did not accept the video (' + (attached?.error || 'attach failed') + ').');
    }
    for (const until = Date.now() + 300000; Date.now() < until;) {
      await sleepMs(3000); alive();
      state = await exec(tab.id, pg_reverseState, [], 'MAIN');
      if (state.chipsReady >= 1 && !state.chipsBusy) break;
      onStatus('Uploading the video… ' + (state.chipsBusy ? 'processing' : 'waiting'));
    }
    if (!(state.chipsReady >= 1 && !state.chipsBusy)) throw Error('The video upload did not finish in time. Try a smaller file.');
    }

    const target = {tabId: tab.id};
    let owned = false;
    // One message: type it, send it, confirm Gemini took it, and wait for the whole answer.
    // minLength (owner test 2026-11-08): with the Gemini tab hidden behind another window, Chrome slows the page and the
    // answer arrives in bursts; "RECORD 1 — OVERVIEW" stood still for 8 s and was taken as the whole answer. A reply shorter
    // than minLength now has to stay unchanged for about 80 s before it counts as finished.
    const askOnce = async (text, label, minLength = 0) => {
      alive();
      await exec(tab.id, pg_geminiFocusEditor, [], 'MAIN').catch(() => false);
      await chrome.debugger.sendCommand(target, 'Input.insertText', {text});
      await sleepMs(1000);
      const before = await exec(tab.id, pg_reverseState, [], 'MAIN');
      const probe = text.replace(/\s+/g, ' ').trim().slice(0, 60), typed = before.editorText.replace(/\s+/g, ' ');
      if (!typed.includes(probe)) throw Error('The message could not be typed into Gemini; nothing was sent.');
      if (!(await exec(tab.id, pg_reverseSend, [], 'MAIN'))?.ok) throw Error('Gemini’s send button was not found; nothing was sent.');
      let accepted = false;
      for (const until = Date.now() + 45000; Date.now() < until;) {
        await sleepMs(1500); alive();
        await exec(tab.id, pg_reverseDismissReminder, [], 'MAIN');
        state = await exec(tab.id, pg_reverseState, [], 'MAIN');
        if (state.userCount > before.userCount || state.busy) { accepted = true; break; }
      }
      if (!accepted) throw Error('Gemini did not accept the message.');
      const started = Date.now();
      let stable = 0, lastLength = -1;
      for (const until = Date.now() + 15 * 60000; Date.now() < until;) {
        await sleepMs(4000); alive();
        await exec(tab.id, pg_reverseDismissReminder, [], 'MAIN');
        state = await exec(tab.id, pg_reverseState, [], 'MAIN');
        if (state.answered && !state.busy) { stable = state.text.length === lastLength ? stable + 1 : 0; lastLength = state.text.length; if (stable >= (state.text.length < minLength ? 20 : 1)) return state; }
        onStatus(label + ' · ' + Math.round((Date.now() - started) / 1000) + 's');
      }
      throw Error('Gemini did not finish in time (' + label + ').');
    };
    // Owner test 2026-11-05: Gemini answered the long first message with "I encountered an error doing what you asked. Could you
    // try again?" and the run sent "fix your batch" for a batch that never came. A Gemini error now gets the same message again.
    const ask = async (text, label, minLength = 0) => {
      let state = await askOnce(text, label, minLength);
      for (let i = 0; i < 2 && geminiFailed(state.text); i++) { onStatus('The AI had an error; sending again…'); await sleepMs(5000); state = await askOnce(text, label, minLength); }
      return state;
    };

    const removeChat = async text => {
      try { onStatus(text); const done = await exec(tab.id, pg_reverseDeleteChat, [], 'MAIN'); if (!done?.ok) onStatus('Saved. Delete the Gemini chat yourself if you want it gone (' + (done?.error || 'it did not close') + ').'); }
      catch { onStatus('Saved. Delete the Gemini chat yourself if you want it gone.'); }
    };
    try {
      try { await chrome.debugger.attach(target, '1.3'); owned = true; }
      catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
      // The member may switch to another window or browser during the 5-15 minutes; the Gemini tab then counts as hidden and
      // Chrome slows it. Telling the page it still has focus keeps Gemini writing at normal speed. Best effort.
      await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
      let answer;
      if (!resume) {
        answer = await ask(analyzer + cutNote, 'Gemini is watching the video and writing the record', 400);
        if (answer.text.length < 400) throw Error('Gemini did not analyse the video: ' + answer.text.slice(0, 200));
        for (let i = 0; i < 4 && /itutuloy|"tuloy"/i.test(answer.text.slice(-400)); i++) answer = await ask('tuloy', 'Gemini is finishing the transcript');
      }
      const batches = resume ? resume.batches.slice() : [];
      const known = () => ({...mergeBatches(batches), mixed});
      let n = resume ? resume.n : 1;
      try {
      for (; n <= MAX_BATCHES; n++) {
        // A resumed run first reads the batch already in the chat (usually the one that failed) and repairs it there.
        answer = resume && n === resume.n ? await exec(tab.id, pg_reverseState, [], 'MAIN') : await ask(n === 1 ? builder + '\n' + AUTOMATION : NEXT, 'Gemini is writing scenes · batch ' + n);
        const check = b => b ? [...sceneProblems(b, known(), B), ...promptWarnings(b, known())] : ['the reply was not one valid json block'];
        let batch = parseBatch(answer), problems = check(batch);
        for (let r = 0; r < REPAIRS && problems.length; r++) {
          onStatus('Fixing ' + problems.length + ' scene(s) in batch ' + n + '…');
          answer = await ask('0xFlow rejected parts of your last batch:\n- ' + problems.join('\n- ') + '\nFix exactly these problems (keep every spoken word verbatim, keep the 0xFlow format) and re-send the WHOLE batch as ONE fenced json block in the same shape.', 'Gemini is fixing batch ' + n);
          batch = parseBatch(answer); problems = check(batch);
        }
        if (problems.length) console.warn('Video → Story batch ' + n + ' kept with:', problems);
        problems = batch ? sceneProblems(batch, known(), B) : ['the reply was not one valid json block'];   // only real errors stop the run
        if (problems.length) throw Error('Gemini could not fix batch ' + n + ': ' + problems.slice(0, 3).map(p => p.replace(/ \(SHOT \d+ \[[^]*$/, '')).join(' · ') + '. The Gemini chat stays open so you can check it.');
        batches.push(batch);
        onStatus('Batch ' + n + ' ready · ' + known().scenes.length + ' scenes so far');
        if (batch.done) break;
        if (n === MAX_BATCHES) throw Error('Gemini kept sending batches without finishing.');
      }
      } catch (e) {
        if (!/cancelled/i.test(e.message || '')) e.resume = {tabId: tab.id, batches: batches.slice(), n, wide, runId};
        else { await removeChat('Cancelled; removing the Gemini chat…'); await returnToTab(origin, tab.id); }
        throw e;
      }
      await chrome.storage.local.remove(RUN_KEY).catch(() => {});   // the story is written: the next video is a new try
      const records = buildRecords(known(), B);
      await removeChat('Video → Story saved; removing the Gemini chat…');
      await returnToTab(origin, tab.id);
      return records;
    } finally {
      await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
      if (owned) { try { await chrome.debugger.detach(target); } catch {} }
    }
  }

  // Owner phone test 2026-11-04: a run takes 5-15 minutes in the member's Gemini tab, so the extension tab sits in the background and the
  // phone browser throttles its timers to about one step a minute (the progress froze until the member went back to the extension).
  // The same inaudible keep-alive the Flow queue uses on phones is on for the whole run; on a computer it does nothing.
  async function run(file, options) {
    const keepAlive = on => { try { if (typeof mobileRunKeepAlive === 'function') mobileRunKeepAlive(on); } catch {} };
    keepAlive(true);
    try { return await runInner(file, options); }
    finally { keepAlive(false); }
  }

  const api = {shotBudgetDetails, frameSignature, frameDifference, cutsFromFrames, cutsMessage, measureCuts, FILES, AUTOMATION, MAX_BYTES, MAX_SECONDS, PART_MAX, looseJson, parseBatch, geminiFailed, setupFor, sceneProblems, promptWarnings, sourceSeconds, longestFor, englishOnly, polishScene, mergeBatches, buildRecords, validateVideo,
    pg_reverseState, pg_reverseDeleteChat, loadInstructions, returnToTab, pg_reverseAttach, pg_reverseDismissReminder, pg_reverseSend, run};
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else globalThis.VideoReverse = api;
})();
