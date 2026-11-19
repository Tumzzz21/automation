// Storyboard sheets (Pro, owner 2026-10-23): one 9:16 Flow image holds four scenes as a 2x2 grid of 9:16 panels; the
// extension downloads it at 2K, cuts it into four start frames and saves them as normal scene images.
// Prototype (C:\Tagalog\storyboard-prototype): the grid must be described as TWO COLUMNS and TWO ROWS ("do not stack"),
// otherwise Flow stacks four wide strips; five people in one sheet was refused under every wording, three passed.

export const SHEET_SIZE = 4;
export const MAX_PEOPLE = 3;

const isCharacterCard = asset => /\bcharacter reference (?:sheet|image|card)\b/i.test(asset?.imagePrompt || '');
const cardName = asset => String(asset?.imagePrompt || '').match(/\bcharacter reference (?:sheet|image|card) of ([^,.;\n]+)/i)?.[1]?.trim() || '';

// People visible in a scene: its character cards when it has references, otherwise the distinct names placed on a
// screen side in the image prompt ("Danilo on camera LEFT"). Unknown counts as one person.
export function peopleIn(scene, assets = []) {
  const cards = (scene.references || []).map(id => assets.find(a => a.id === id)).filter(isCharacterCard);
  if (cards.length) return cards.length;
  const text = String(scene.imagePrompt || '');
  // "Danilo on camera LEFT", "Carmen stand on camera RIGHT", "Boyet sits at camera CENTER"
  const names = new Set([...text.matchAll(/(?<![\p{L}])(\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)?)(?:\s+\p{Ll}+){0,3}\s+(?:camera|screen)\s+(?:LEFT|RIGHT|CENTER|CENTRE)\b/gu)].map(m => m[1]));
  // "Don Eduardo and Doña Carmen stand on camera RIGHT": the first name of a pair too
  for (const m of text.matchAll(/(?<![\p{L}])(\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)?)\s+and\s+(?=\p{Lu}[^.;]{0,60}?(?:camera|screen)\s+(?:LEFT|RIGHT|CENTER|CENTRE)\b)/gu)) names.add(m[1]);
  // "Maya sits on camera LEFT ... Also visible: Maya Alcantara on camera LEFT" is one person (owner 2026-10-24: every
  // scene of a ChatGPT story counted double, so no sheet was planned).
  // All-capital words are never people: "…sits at camera CENTER and Nonoy sits…" made CENTER a fourth person (owner
  // 2026-10-26: scenes 3-4 counted 4, so scenes 1-4 became single images).
  const all = [...names].filter(n => n !== n.toUpperCase());
  // Also "Carmen ... Also visible: Aling Carmen": a title in front is the same person (owner 2026-10-25: scene 10 counted 4,
  // so it and its neighbours became single images).
  const people = all.filter(n => !all.some(m => m !== n && (m.startsWith(n + ' ') || m.endsWith(' ' + n))));
  return Math.max(1, people.length);
}

// Groups of four consecutive scenes for sheets; everything else (crowded scenes, scenes already tried as a sheet,
// a short remainder) stays a single image. Scenes inside one sheet must share one way of being made (with or
// without references), because one queue runs one mode.
export function planSheets(scenes, assets = [], {tried = [], maxPeople = MAX_PEOPLE} = {}) {
  const triedSet = new Set(tried), plan = [];
  let run = [];
  const flush = () => { for (const s of run) plan.push({kind: 'single', ids: [s.id]}); run = []; };
  for (const scene of scenes) {
    const eligible = !triedSet.has(scene.id) && peopleIn(scene, assets) <= maxPeople;
    if (!eligible) { flush(); plan.push({kind: 'single', ids: [scene.id]}); continue; }
    if (run.length && Boolean(run[0].references?.length) !== Boolean(scene.references?.length)) flush();
    run.push(scene);
    if (run.length === SHEET_SIZE) { plan.push({kind: 'sheet', ids: run.map(s => s.id)}); run = []; }
  }
  flush();
  return plan;
}

// PEOPLE: the fixed looks the server adds to Direct-frame image prompts; the sheet names them once in CHARACTERS instead.
const FIELD = /\b(START FRAME|OPENING STATE|COMPOSITION|LIGHTING|MOOD|NEGATIVE|STYLE|PEOPLE)\s*:/g;
function fields(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim(), out = {}, marks = [...text.matchAll(FIELD)];
  marks.forEach((m, i) => { out[m[1]] = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).trim().replace(/[\s.]+$/, ''); });
  out.lead = (marks[0] ? text.slice(0, marks[0].index) : text).trim();
  return out;
}
// The style words of the scene prompts ("photorealistic cinematic live-action photograph (real Filipino actors...)").
function styleOf(prompt) {
  const lead = fields(prompt).lead.replace(/^create\s+(?:a|one)\s+/i, '').replace(/\b9\s*:\s*16\b|\bvertical\b|\bportrait\b/gi, '').replace(/\bSTART FRAME\b.*$/i, '').replace(/[\s,.]+$/, '').trim();
  return lead || 'photorealistic cinematic film still';
}
// Direct-scene stories have no character cards, but Tagalog drama video prompts carry "CHARACTERS — one line per visible
// character: Mateo — young man, white shirt. Screen side: ...". ChatGPT made the 2x2 once a CHARACTERS list named the
// looks (owner test 2026-10-24); without it, it asked for a reference image. First look per name wins.
// One scene's CHARACTERS lines: name -> look ("Tristan" -> "young man in maroon t-shirt").
// Children always wear covered clothes (owner 2026-10-26: Flow refused scene 4 twice for 'content related to minors'
// with a girl in a "yellow sando" and a boy in a "blue undershirt"). Same rule as server/builder-engine.cjs childClothes.
const CHILD_LOOK = /\b(?:girl|boy|child|kid|toddler|baby|infant|schoolgirl|schoolboy|daughter|son)\b|\b(?:[1-9]|1[0-7])\s*-?\s*years?\s*old\b/i;
const BARE_CLOTHES = /\b(?:sando|undershirt|under-shirt|tank[- ]?top|singlet|camisole|sleeveless(?:\s+(?:shirt|top|vest))?|swim(?:suit|wear|ming\s+trunks)|bikini|trunks|shirtless|bare[- ]chested|topless|no\s+shirt|diaper|underwear|briefs)\b/gi;
export function childClothes(look) {
  if (!CHILD_LOOK.test(look)) return look;
  return String(look).replace(BARE_CLOTHES, 't-shirt').replace(/\bt-shirt(?:,?\s+t-shirt)+\b/gi, 't-shirt');
}
function sceneLooks(scene) {
  const block = String(scene.videoPrompt || '').match(/CHARACTERS\s*[—–-][^:]*:\s*([\s\S]*?)(?=\bTIMELINE\b|\bAUDIO\b|$)/)?.[1] || '';
  // A Direct-frame line also states the full outfit ("…; wearing a white nurse uniform and white shoes, the same outfit …"):
  // the sheet uses that outfit.
  const outfit = s => s.replace(/^.*?;\s*wearing\s+(.+?),\s*the same outfit as in the start frame for the whole clip$/, '$1');
  return new Map([...block.matchAll(/(\p{Lu}[\p{L}'.-]+(?:\s\p{Lu}[\p{L}'.-]+)?)\s+[—–-]\s+([^.\n]+?)\.?\s*Screen side/gu)].map(m => [m[1], childClothes(outfit(m[2].trim()))]));
}
// A look that names clothes (not an action such as "man outside chopping firewood").
const CLOTHES = /\b(?:shirt|t-shirt|blouse|dress|gown|suit|tuxedo|uniform|jacket|cardigan|coat|overcoat|vest|waistcoat|blazer|sweater|hoodie|polo|skirt|pants|trousers|jeans|apron|barong|duster|robe|pajamas|sando|tank top|scrubs|sweatshirt)\b/i;
// The age from the voice lock ("Elena — earnest, concerned Filipina woman in her early 20s, ..."): the look lines carry
// clothes only, so ChatGPT drew the 20-year-old sister as a woman of about 50 (owner's 18-scene test 2026-10-25).
function ageOf(voice, name) {
  const part = String(voice || '').split(/[;\n]/).find(x => x.trim().toLowerCase().startsWith(name.toLowerCase() + ' '));
  return part?.match(/\b((?:early|mid|late)[- ]?\d0s|\d0s|\d{1,2}(?:\s*-\s*\d{1,2})?\s*years?\s*old)\b/i)?.[1] || '';
}
// A single scene image (↻ Regenerate, a scene made alone) gets the scene's clothes from its video CHARACTERS: the image
// prompt has looks only, so ChatGPT invented the clothes and copied the children's undershirts from earlier frames (owner
// 2026-10-26). Children never wear revealing clothes and are never kissed or touched in the picture.
export function sceneClothesLine(scene) {
  const looks = [...sceneLooks(scene)].filter(([, look]) => CLOTHES.test(look));
  const prompt = String(scene.imagePrompt || '');
  if (!looks.length || /\bCLOTHES:/.test(prompt)) return '';
  const kids = looks.some(([, look]) => CHILD_LOOK.test(look)) || CHILD_LOOK.test(prompt);
  return ' CLOTHES: ' + looks.map(([name, look]) => name + ' — ' + look).join('; ') + '.' + (kids ? ' The children are fully clothed in these clothes; no one kisses or touches the children.' : '');
}
export function castFromVideos(scenes, voice = '') {
  // Pass every scene of the story: a scene can describe an action instead of clothes ("man outside chopping firewood"),
  // so each person gets the look used most often (first seen wins a tie), the same for every sheet. A panel whose scene
  // dresses the person differently says so itself (sheetPrompt), e.g. a flashback or a scene at home.
  const looks = new Map();
  for (const s of scenes) for (const [name, look] of sceneLooks(s)) {
    const count = looks.get(name) || new Map();
    count.set(look, (count.get(look) || 0) + 1); looks.set(name, count);
  }
  return [...looks].map(([name, count]) => ({name, look: [...count].sort((a, b) => b[1] - a[1])[0][0], age: ageOf(voice, name)}));
}
// The sheet's style without "(real Filipino actors, ...)" or "real": a live-action photo becomes a film still.
function sheetStyle(prompt) {
  const style = styleOf(prompt).replace(/\s*\([^)]*\)/g, '').replace(/\blive-action photograph\b/i, 'film still').replace(/\breal\s+/gi, '').replace(/\s+/g, ' ').trim();
  return /\b(?:still|photo|image|illustration|render|painting|frame)\b/i.test(style) ? style : style + ' still';
}
// ChatGPT panels in the owner's tested prototype style (2026-10-24): who is where and what they do, in plain words. The
// full Flow panel (camera jargon, framing, light; ~3,000 characters per sheet) made ChatGPT answer "I couldn't generate
// the storyboard image" / "the image tool requires an image reference".
function plainPanel(scene) {
  const f = fields(scene.imagePrompt);
  // Each panel keeps its own light in plain words (owner 2026-10-24: without it the dusk and tungsten scenes 6-7 came out
  // in daylight, and Veo follows the frame). Framing stays out: camera jargon made ChatGPT refuse.
  const light = noKelvin(f.LIGHTING || '');
  const text = [f['START FRAME'], f['OPENING STATE'], light && 'Light: ' + light].filter(Boolean).join('. ') || panelText(scene);
  return noAttached(text).replace(/\s*\bat 0(?:\.0+)?\s*s\b/gi, '').replace(/\s*\bAlso visible:(?:\b(?:Atty|Dr|Dra|Mr|Mrs|Ms|Sr|Jr|Engr|Gng|Hon|St)\.|[^.])*\./gi, '')
    .replace(/\b(?:(on|in|at|to)\s+)?(?:the\s+)?(?:camera|screen)\s+(LEFT|RIGHT|CENTER|CENTRE)\b/gi, (m, prep, side) => (prep || 'on') + ' the ' + (/^cent/i.test(side) ? 'center' : side.toLowerCase()))
    .replace(/\s*,\s*(?=[.;]|$)/g, '').replace(/\s+/g, ' ').trim();
}
// One panel = the scene's own opening moment, without its negative list or repeated style words.
function panelText(scene) {
  const f = fields(scene.imagePrompt);
  const parts = [f['START FRAME'], f['OPENING STATE'], f.COMPOSITION && 'Framing: ' + f.COMPOSITION, f.LIGHTING && 'Light: ' + f.LIGHTING];
  const text = parts.filter(Boolean).join('. ') || f.lead.replace(/^create\s+(?:a|one)\s+[^.]*?\b(?:of|showing)\b\s*/i, '');
  // Kelvin codes ("WB 5600K", "3200K key with 7500K fill") are drawn as text by image models. "Also visible: Maya
  // Alcantara on camera LEFT" repeats people already placed and reads as extra people in a small panel.
  return noKelvin(noAttached(text).replace(/\s*\bAlso visible:(?:\b(?:Atty|Dr|Dra|Mr|Mrs|Ms|Sr|Jr|Engr|Gng|Hon|St)\.|[^.])*\./gi, ''));
}
// Part 2+ start frames say "In the attached first image, Roland stands…" (written for the video step). On a sheet no such
// image is attached, so ChatGPT asked to upload it instead of drawing (owner 2026-10-29). The panel keeps the placement.
function noAttached(text) {
  return String(text).replace(/\b(?:in|from)\s+the\s+attached\s+(?:first\s+|start(?:ing)?\s+|previous\s+)?(?:image|frame|photo|picture)\s*,?\s*(\w)?/gi, (m, c) => c ? c.toUpperCase() : '');
}
function noKelvin(text) {
  return String(text).replace(/\s*,?\s*\b(?:WB\s*)?\d{4,5}\s*K\b(?:\s+(?:key|fill|rim|light)\b)?(?:\s+(?:with|and)\s+\d{4,5}\s*K\b(?:\s+(?:key|fill|rim|light)\b)?)?/gi, '')
    .replace(/\s*,\s*(?=[.;]|$)/g, '').replace(/\s+/g, ' ').trim().replace(/[\s.]+$/, '');
}

const POSITIONS = ['TOP-LEFT', 'TOP-RIGHT', 'BOTTOM-LEFT', 'BOTTOM-RIGHT'];
// The sheet prompt for four scenes. `cards` are the attached character cards in attachment order.
// "young woman, white catering uniform" -> "white catering uniform": the clothes part of a CHARACTERS look.
const clothesOnly = look => String(look).replace(/^(?:(?:young|older|mature|slender|tall|elegant|stern|middle-aged)\s+)*(?:man|woman)(?:\s+in|,)?\s*/i, '');
export function sheetPrompt(scenes, assets = [], {platform = 'flow', story = scenes, voice = '', castLooks = [], wide = false} = {}) {
  const chatgpt = platform === 'chatgpt';
  if (scenes.length !== SHEET_SIZE) throw Error('A storyboard sheet needs exactly four scenes.');
  const refs = [...new Set(scenes.flatMap(s => s.references || []))].map(id => assets.find(a => a.id === id)).filter(Boolean);
  const cast = refs.filter(isCharacterCard).map(cardName).filter(Boolean);
  const lines = [
    // Flow titles a tile from the first words of its prompt (owner 2026-10-24: sheets showed as "Char...").
    // Wide 16:9 stories (owner 2026-11-11): four 16:9 panels in a 2x2 grid make one 16:9 sheet; findGrid({wide}) cuts it.
    (chatgpt ? 'Create' : 'Storyboard sheet: create') + (wide
      ? ' ONE wide horizontal 16:9 image divided into FOUR WIDE LANDSCAPE PANELS arranged in TWO COLUMNS and TWO ROWS (like a 2x2 window): one thin pure-white vertical line runs down the exact middle from top to bottom, and one thin pure-white horizontal line runs across the exact middle from left to right. Each of the four panels is itself a wide horizontal 16:9 landscape image. Do NOT stack the panels in one row or one column. No outer border.'
      : ' ONE vertical 9:16 image divided into FOUR TALL PORTRAIT PANELS arranged in TWO COLUMNS and TWO ROWS (like a 2x2 window): one thin pure-white vertical line runs down the exact middle from top to bottom, and one thin pure-white horizontal line runs across the exact middle from left to right. Each of the four panels is itself a tall vertical 9:16 portrait image. Do NOT stack the panels in one column. No outer border.'),
    // The owner's tested ChatGPT wording (2026-10-24): "real Filipino actors" + "same faces" made ChatGPT ask for a
    // reference image ("the image tool requires an image reference"); "original fictional characters" passes.
    `Every panel is a separate ${sheetStyle(scenes[0].imagePrompt)} of original fictional adult characters from the same fictional Filipino drama, with the same characters${chatgpt ? ' and location wherever they appear; each panel has its own light and time of day as described' : ', clothes, location and light wherever they appear'}.`,
    'No text anywhere: no captions, no panel numbers, no labels, no speech bubbles, no logos, no brand names; bottles, cups, bags and signs are plain and unlabeled.'
  ];
  let people = [];
  if (!cast.length && chatgpt) {
    people = castFromVideos(story, voice).filter(c => scenes.some(s => plainPanel(s).includes(c.name)));
    // The story's fixed looks (castLooks: age, hair, build) make each person a distinct individual; without them two
    // women got the same default face (owner 2026-10-25). Never the word "face" here: it makes ChatGPT ask for a reference.
    const fixed = new Map(castLooks.map(c => [String(c.name).toLowerCase(), String(c.look).replace(/\b([\w-]+)\s+face\b/gi, '$1 features').replace(/\bfaces?\b/gi, 'features')]));
    const entry = c => { const id = fixed.get(c.name.toLowerCase()); return id ? c.name + ': ' + id + ', usually in ' + clothesOnly(c.look) : c.name + (c.age ? ' (' + c.age + ')' : '') + ': ' + c.look; };
    if (people.length) lines.push('CHARACTERS (fictional; the same people in every panel, in these clothes unless a panel names other clothes' + (fixed.size ? '; each person clearly a different individual as described' : '') + '): ' + people.map(entry).join('; ') + '.');
  } else if (!cast.length && castLooks.length) {
    // Flow: the fixed looks once for the sheet (not in every panel; Flow refuses long sheet prompts).
    const inSheet = castLooks.filter(c => scenes.some(s => panelText(s).includes(c.name)));
    if (inSheet.length) lines.push('CHARACTERS (fictional; the same people wherever they appear, each clearly a different individual): ' + inSheet.map(c => c.name + ': ' + c.look).join('; ') + '.');
  }
  if (cast.length) lines.push('The attached reference images show the characters (' + cast.join(', ') + '): keep each face, hairstyle and outfit exactly as in its reference.');
  // A scene that dresses someone differently from their usual look (a flashback, at home, another day) says so in its own
  // panel: with one look per person for the whole story, ChatGPT put Tristan in a tuxedo while cooking in the province
  // flashback (owner's 18-scene test 2026-10-25).
  const ownClothes = s => people.flatMap(c => { const look = sceneLooks(s).get(c.name); return look && look !== c.look && CLOTHES.test(look) ? [c.name + ' wears ' + clothesOnly(look) + ' here'] : []; });
  scenes.forEach((s, i) => { const own = chatgpt ? ownClothes(s) : []; lines.push(POSITIONS[i] + ' PANEL: ' + (chatgpt ? plainPanel(s) : panelText(s)) + (own.length ? ' (' + own.join('; ') + ')' : '') + '.'); });
  lines.push('NEGATIVE: no text, no numbers, no extra people, no merged or uneven panels, no distorted hands, no identity drift between panels.');
  return lines.join(' ');   // one paragraph: a blank line separates prompts in the queue box (owner 2026-10-24)
}

// ---- manual queues (Control tab, owner 2026-10-25) ---------------------------------------------------------------------
// Users paste their own start-frame prompts. Three shapes are read: the JSON scene format ("character_locks", "blocking",
// "setting", "camera", "style_lock"), the "START FRAME TO CAPTURE: / Composition: / Lighting: / Continuity:" format with
// @char_01 references, and any other text (used whole, minus negatives and Kelvin codes).
const CROWD = /\b(?:crowd|crowded|groups? of|mataong|maraming tao|grupo ng|mga estudyante|audience|spectators)\b/i;
const firstSentence = t => String(t || '').split(/(?<=[.!?])\s+/)[0].replace(/[\s.]+$/, '');
const shortFraming = t => String(t || '').split(/[,;]/).slice(0, 2).join(',').replace(/\b\d{2,3}\s*mm\b/gi, '').replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/[\s,]+$/, '').trim();
function section(text, name) {
  const m = String(text).match(new RegExp('(?:^|\\n)\\s*' + name + '\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:Use|START FRAME TO CAPTURE|SCENE BRIDGE|Composition|Lighting|Mood|Continuity|Negative)\\s*:|$)', 'i'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
export function manualPanel(text) {
  const raw = String(text || '').trim();
  let json = null;
  if (/^\{[\s\S]*\}$/.test(raw)) { try { json = JSON.parse(raw); } catch { json = null; } }
  if (json && typeof json === 'object') {
    const cast = (Array.isArray(json.character_locks) ? json.character_locks : []).map(lock => {
      const m = String(lock).match(/^\s*\[CHARACTER LOCK:\s*([^\]/]+?)\s*(?:\/[^\]]*)?\]\s*([\s\S]*)$/i);
      return m ? {name: m[1].trim(), look: m[2].replace(/\s+/g, ' ').trim()} : null;
    }).filter(Boolean);
    const action = [json.blocking, json.emotion].filter(Boolean).map(firstSentence).join('. ');
    const panel = [action, json.story_prop && 'Prop: ' + json.story_prop, json.setting && 'Place and light: ' + noKelvin(json.setting), json.camera && 'Framing: ' + shortFraming(json.camera)].filter(Boolean).join('. ');
    const crowd = !cast.length && CROWD.test([json.blocking, json.setting, json.camera].join(' '));
    return {panel: noKelvin(panel), cast, style: firstSentence(json.style_lock), people: crowd ? 99 : Math.max(1, cast.length), refs: false,
      parts: {action: firstSentence(json.blocking), emotion: firstSentence(json.emotion), prop: json.story_prop || '', place: json.setting || '', framing: json.camera ? shortFraming(json.camera) : ''}};
  }
  const capture = section(raw, 'START FRAME TO CAPTURE');
  if (capture) {
    const cast = section(raw, 'Continuity').split(/(?<=\.)\s+(?=\p{Lu}[\p{L}'-]+:)/u).map(part => part.match(/^(\p{Lu}[\p{L}'-]+):\s*(.+?)\.?$/u)).filter(Boolean).map(m => ({name: m[1], look: firstSentence(m[2])}));
    const light = firstSentence(section(raw, 'Lighting').replace(/^Motivated practical lighting\s*[—–-]\s*/i, ''));
    const panel = [capture.replace(/[\s.]+$/, ''), light && 'Light: ' + noKelvin(light), section(raw, 'Composition') && 'Framing: ' + shortFraming(section(raw, 'Composition'))].filter(Boolean).join('. ');
    const chars = new Set((capture.match(/@char_\d+/gi) || []).map(x => x.toLowerCase()));
    const crowd = CROWD.test(capture);
    return {parts: {action: capture, place: light, framing: section(raw, 'Composition') ? shortFraming(section(raw, 'Composition')) : ''}, panel: noKelvin(panel), cast, style: firstSentence(raw.split('\n')[0]).replace(/^create\s+(?:a|one)\s+/i, '').replace(/\b9\s*:\s*16\b|\bvertical\b/gi, '').replace(/\bSTART FRAME\b.*$/i, '').replace(/\s+/g, ' ').trim(), people: crowd ? 99 : Math.max(1, chars.size || peopleIn({imagePrompt: capture})), refs: /@\w+/.test(raw)};
  }
  const body = raw.replace(/\b(?:NEGATIVE|Negative|EXCLUDE)\s*:[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
  return {panel: noKelvin(body), cast: [], style: '', people: CROWD.test(body) ? 99 : peopleIn({imagePrompt: body}), refs: /@\w+/.test(raw)};
}
// The sheet prompt for four manual prompts (in queue order). Kept short (owner test 2026-10-25): Flow refused four scenes
// at 4,300 characters and made the same four at 3,100 in a compact layout, the risky details unchanged. So: a short
// grid/style head, one look per character, and per panel place: action, feeling, prop, framing. Sounds and Kelvin go,
// and while the text is over SHEET_BUDGET the props, feelings and looks are shortened step by step.
export const SHEET_BUDGET = 3000;
const SOUND = /\b(?:hum|humming|bass|music|jazz|chatter|noise|clinking|beeps?|buzzing|honking|horn|echoing|idling|laughter|chime|clatter|clicking|vibrating|muffled|traffic|cicadas)\b/i;
const tidy = t => noKelvin(String(t || '')).replace(/\bcamera (LEFT|RIGHT|CENTER)\b/g, '$1').replace(/\s+/g, ' ').replace(/[\s.;,]+$/, '').trim();
// Shortened by whole clauses (", " / "; "), never mid-phrase; the first clause always stays.
function clip(t, max) {
  t = tidy(t);
  if (t.length <= max) return t;
  // A comma inside quoted text is not a clause end (owner run 2026-10-25: "wristband with 'Reyes, M.'" was cut to "'Reyes").
  const guarded = t.replace(/(^|[\s(])(['"‘“])([^'"’”]*?)(['"’”])(?=[\s.,;:)]|$)/g, (m, pre, a, body, b) => pre + a + body.replace(/[,;]/g, c => c === ',' ? '\u0001' : '\u0002') + b);
  const parts = guarded.split(/(?=[,;]\s)/);
  let out = parts[0];
  for (const part of parts.slice(1)) { if ((out + part).length > max) break; out += part; }
  return out.replace(/\u0001/g, ',').replace(/\u0002/g, ';').trim();
}
// Place and light without sounds; from level 2 the clock time goes too (the light says it).
const placeOf = (setting, keep, level = 0) => tidy(String(setting || '').split(/,\s*/).filter(c => !SOUND.test(c) && !(level >= 2 && /^\s*\d{1,2}:\d{2}\s*(?:AM|PM|MN)?\s*$/i.test(c))).slice(0, keep).join(', '));
function compactPanel(p, level) {
  const x = p.parts;
  if (!x) return clip(p.panel, [900, 600, 450, 320][level]);
  const place = placeOf(x.place, level < 3 ? 3 : 2, level);
  const framing = x.framing && (/\bshot\b/i.test(x.framing) ? tidy(x.framing) : tidy(x.framing) + ' shot');
  const bits = [clip(x.action, level < 3 ? 400 : 260), x.emotion && clip(x.emotion, [200, 120, 90, 70][level]), x.prop && clip(x.prop, [200, 110, 80, 60][level]), framing];
  return (place ? place + ': ' : '') + bits.filter(Boolean).map(cap).join('. ');
}
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
// The face/hair part and the OUTFIT part are shortened separately, so a long face description never pushes out the clothes.
function lookOf(look, max) {
  const [face, outfit] = String(look).split(/\s*[—–]+\s*OUTFIT:\s*/i);
  if (!outfit) return clip(face, max);
  return clip(face, Math.round(max * 0.5)) + '. ' + cap(clip(outfit, Math.round(max * 0.5)));
}
export function manualSheetPrompt(texts, {platform = 'flow', budget = SHEET_BUDGET} = {}) {
  if (texts.length !== SHEET_SIZE) throw Error('A storyboard sheet needs exactly four prompts.');
  const chatgpt = platform === 'chatgpt', panels = texts.map(manualPanel);
  let style = (panels.find(p => p.style)?.style || 'photorealistic cinematic film still').replace(/,?\s*\b9\s*:\s*16\b\s*(?:vertical|portrait)?/gi, '').replace(/\b(?:vertical|portrait)\b/gi, '')
    .replace(/\blive-action\b/gi, '').replace(/\breal\s+/gi, '').replace(/\s+,/g, ',').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').split(',')[0].trim();
  if (!/\b(?:still|photo|photograph|image|illustration|render|painting|frame)\b/i.test(style)) style += ' still';
  const cast = new Map();
  for (const p of panels) for (const c of p.cast) if (!cast.has(c.name.toLowerCase())) cast.set(c.name.toLowerCase(), c);
  const named = [...cast.values()].filter(c => panels.some(p => new RegExp('\\b' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(p.panel)));
  const build = level => [
    (chatgpt ? 'Create' : 'Storyboard sheet: create') + ' ONE vertical 9:16 image divided into FOUR equal tall portrait panels in a precise 2x2 grid (two columns, two rows): one thin pure-white vertical line and one thin pure-white horizontal line meet at the exact center. Do NOT stack the panels in one column. No outer border.',
    // No "adult" (owner test 2026-10-25: ChatGPT refused the sheet with it and made it without), and never "faces"
    // (ChatGPT then asks for a reference image, 2026-10-24 and again 2026-10-25).
    `STYLE: ${style}; each panel is a different moment from the same fictional Filipino drama with original fictional characters, the same characters and clothes in every panel, each panel with its own place and light. No text, captions, labels, logos or brand names; props are plain and unlabeled.`,
    panels.some(p => p.refs) && 'The attached reference images are named with @ in the panels (for example @char_01): keep each character, place and prop exactly as in its reference.',
    named.length && 'CHARACTERS (fictional; identical in every panel): ' + named.map(c => c.name + ': ' + lookOf(c.look, [400, 230, 180, 140][level])).join('; ') + '.',
    ...panels.map((p, i) => POSITIONS[i] + ' PANEL — ' + compactPanel(p, level) + '.'),
    'NEGATIVE: no text, no extra people, no uneven or merged panels, no distorted hands, no character or outfit changes.'
  ].filter(Boolean).join(' ');
  let text = build(0);
  for (let level = 1; level < 4 && text.length > budget; level++) text = build(level);
  return text;
}

// ---- cutting ---------------------------------------------------------------------------------------------------------
// `image` is ImageData-like ({width, height, data: RGBA}). Returns the four panel boxes (left to right, top to bottom)
// when the sheet is a clean 2x2 of 9:16 panels, otherwise {ok:false, reason}.
export function findGrid(image, {white = 228, share = 0.85, wide = false} = {}) {
  const {width: w, height: h, data} = image;
  const lineWhite = (axis, i) => {
    let hit = 0, n = 0;
    if (axis === 'row') for (let x = 0; x < w; x += 3) { const o = (i * w + x) * 4; n++; if (data[o] >= white && data[o + 1] >= white && data[o + 2] >= white) hit++; }
    else for (let y = 0; y < h; y += 3) { const o = (y * w + i) * 4; n++; if (data[o] >= white && data[o + 1] >= white && data[o + 2] >= white) hit++; }
    return hit / n >= share;
  };
  const spans = axis => {
    const size = axis === 'row' ? h : w, out = [];
    let start = 0, inWhite = true;   // leading white = outer border
    for (let i = 0; i <= size; i++) {
      const white = i < size && lineWhite(axis, i);
      if (!white && inWhite) { start = i; inWhite = false; }
      else if ((white || i === size) && !inWhite) { if (i - start > size * 0.12) out.push([start, i]); inWhite = true; }
    }
    return out;
  };
  const rows = spans('row'), cols = spans('col');
  if (rows.length !== 2 || cols.length !== 2) return {ok: false, reason: `the sheet has ${cols.length} column(s) x ${rows.length} row(s), not a 2x2 grid`};
  // ChatGPT draws the white dividers a little unevenly: a row next to the divider can still be partly white (owner
  // 2026-10-25: a white line on top of one frame). Shave each panel's edges while an edge line has visible white on it.
  // Only the edges next to a divider. An edge pixel counts as divider residue when it is light AND clearly brighter than
  // the picture 3 px further inside: the divider blends into a light, often tinted line (owner 2026-10-25: a warm-grey
  // column survived an "all channels >= 215" rule), while a lamp or white shirt at the edge is bright on both sides.
  const lum = (x, y) => { const o = (y * w + x) * 4; return (data[o] + data[o + 1] + data[o + 2]) / 3; };
  const residue = (edge, inward) => {   // edge/inward: pixel lists of the edge line and the line 3 px inside
    let hit = 0;
    for (let i = 0; i < edge.length; i++) { const e = lum(...edge[i]); if (e >= 170 && e - lum(...inward[i]) >= 35) hit++; }
    return edge.length ? hit / edge.length : 0;
  };
  const rowLine = (b, y) => Array.from({length: b.w}, (_, i) => [b.x + i, y]);
  const colLine = (b, x) => Array.from({length: b.h}, (_, i) => [x, b.y + i]);
  const shave = (b, row, col) => {
    // The divider always blends into the one line next to it (a grey seam even when too faint for the check below): that
    // line goes first; one pixel of picture is invisible.
    if (row === 1) { b.y++; b.h--; } else b.h--;
    if (col === 1) { b.x++; b.w--; } else b.w--;
    if (row === 1) for (let k = 0; k < 6 && b.h > 8 && residue(rowLine(b, b.y), rowLine(b, b.y + 3)) > 0.1; k++) { b.y++; b.h--; }
    if (row === 0) for (let k = 0; k < 6 && b.h > 8 && residue(rowLine(b, b.y + b.h - 1), rowLine(b, b.y + b.h - 4)) > 0.1; k++) b.h--;
    if (col === 1) for (let k = 0; k < 6 && b.w > 8 && residue(colLine(b, b.x), colLine(b, b.x + 3)) > 0.1; k++) { b.x++; b.w--; }
    if (col === 0) for (let k = 0; k < 6 && b.w > 8 && residue(colLine(b, b.x + b.w - 1), colLine(b, b.x + b.w - 4)) > 0.1; k++) b.w--;
    return b;
  };
  const boxes = rows.flatMap(([y0, y1], r) => cols.map(([x0, x1], c) => shave({x: x0, y: y0, w: x1 - x0, h: y1 - y0}, r, c)));
  const ws = boxes.map(b => b.w), hs = boxes.map(b => b.h);
  // ChatGPT sometimes draws one row taller than the other (owner 2026-10-30, "Huling Pasensya": rows of 764 and 904 px, all
  // four pictures fine). Up to 12% difference is used; each panel is then trimmed to 9:16 on its own.
  if (Math.max(...ws) - Math.min(...ws) > w * 0.12 || Math.max(...hs) - Math.min(...hs) > h * 0.12) return {ok: false, reason: 'the four panels are not equal'};
  // Panels a little wider than 9:16 (ChatGPT can answer 2:3) are trimmed from the centre; a panel a little taller loses its
  // extra mostly at the bottom (table, floor), a quarter at the top, so heads stay in. Anything further off is refused.
  // Wide sheets: panels from about 3:2 (ChatGPT's wide picture is 3:2) to a little wider than 16:9 are used; each is cut to
  // 16:9 the same way (a taller panel loses its extra mostly at the bottom, a wider one at both sides).
  if (wide) {
    for (const b of boxes) { const shape = b.w / b.h; if (shape < 1.4 || shape > 16 / 9 + 0.12) return {ok: false, reason: `the panels are not 16:9 (${shape.toFixed(2)})`}; }
    return {ok: true, boxes: boxes.map(b => {
      const w = Math.min(b.w, Math.round(b.h * 16 / 9)), h = Math.min(b.h, Math.round(b.w * 9 / 16));
      return {x: b.x + Math.floor((b.w - w) / 2), y: b.y + Math.floor((b.h - h) / 4), w, h};
    })};
  }
  for (const b of boxes) { const shape = b.w / b.h; if (shape < 9 / 16 - 0.06 || shape > 0.7) return {ok: false, reason: `the panels are not 9:16 (${shape.toFixed(2)})`}; }
  const fitted = boxes.map(b => {
    const w = Math.min(b.w, Math.round(b.h * 9 / 16)), h = b.w / b.h < 9 / 16 - 0.04 ? Math.round(b.w * 16 / 9) : b.h;   // panels that passed before stay as they were
    return {x: b.x + Math.floor((b.w - w) / 2), y: b.y + Math.floor((b.h - h) / 4), w, h};
  });
  return {ok: true, boxes: fitted};
}
