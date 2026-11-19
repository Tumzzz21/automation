// Softer retry for a story Flow keeps refusing because of how a character is described (owner 2026-11-10).
// Owner run 2026-11-10: "Dante — handcuffed man in charcoal t-shirt" was locked into every scene; Flow refused each
// video, the repair AI answered "manual revision required: Dante is locked as a 'handcuffed man' … the start frame
// depicts physical restraint", and the new start images were drawn from the same words. This file takes the restraint
// out of the DESCRIPTIONS (image prompts, video prompts, cast looks), once per story, so the new images and videos show
// the person without it. Spoken lines (text in quotes) are never changed. It is a content change to fit Flow's rules,
// not a way around them; a story that is still refused fails as before.
const WHO = '(?:young |old |older |elderly |adult |middle-aged |thin |tall |short |tired |nervous |frightened |weary )*(?:man|woman|boy|girl|person|suspect|prisoner|inmate|detainee|figure|teen|teenager|father|mother|son|daughter|husband|wife|worker|driver|guard)';
const HELD = '(?:hand-?cuffed|cuffed|shackled|zip-?tied|tied-?up|chained)';
const RULES = [
  // "handcuffed man in charcoal t-shirt" -> "man in charcoal t-shirt"
  [new RegExp('\\b' + HELD + '\\s+(?=' + WHO + '\\b)', 'gi'), ''],
  // "his hands cuffed behind his back" -> "his hands clasped together"
  [new RegExp('\\b(his|her|their)\\s+(?:hands|wrists)\\s+(?:are\\s+|still\\s+)?' + HELD + '(?:\\s+(?:behind\\s+(?:his|her|their)\\s+back|in\\s+front(?:\\s+of\\s+(?:him|her|them))?|together))?', 'gi'), '$1 hands clasped together'],
  // ", in handcuffs" / "wearing steel handcuffs" / "with shackles on" -> removed
  [/,?\s*\b(?:in|wearing|with|still in)\s+(?:steel |metal |police |heavy )?(?:handcuffs|hand-cuffs|cuffs|shackles|chains|zip-?ties)(?:\s+on(?:\s+(?:his|her|their)\s+wrists)?)?\b/gi, ''],
  // "Dante is handcuffed" / "sits handcuffed" -> "is waiting" / "sits waiting"
  [new RegExp('\\b' + HELD + '\\b', 'gi'), 'waiting'],
  // what is left of the object itself
  [/\b(?:the\s+|a\s+pair\s+of\s+|his\s+|her\s+|their\s+)?(?:handcuffs|hand-cuffs|shackles)\b/gi, 'his wristwatch'],
];
const tidy = text => text.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.;:])/g, '$1').replace(/,\s*,/g, ',').replace(/\(\s*\)/g, '');

// Rewords everything outside double quotes (straight or curly); quoted speech stays word for word.
export function softenLook(text) {
  const source = String(text ?? '');
  const parts = source.split(/("[^"\n]*"|“[^”\n]*”)/);
  const out = parts.map((part, i) => i % 2 ? part : RULES.reduce((value, [pattern, to]) => value.replace(pattern, to), part)).join('');
  return out === source ? source : tidy(out);
}

// Softens a whole project in place. Returns what changed: {changed, prompts, imageIds, assetIds, example:{from,to}}.
// imageIds = scenes whose START IMAGE words changed and whose video is not finished: their pictures must be made again.
export function softenProject(project, {done = []} = {}) {
  const result = {changed: false, prompts: 0, imageIds: [], assetIds: [], example: null};
  if (!project) return result;
  const finished = new Set(done);
  const note = (from, to) => {
    result.changed = true; result.prompts++;
    if (!result.example) {
      const hit = new RegExp('[^.\\n,;:—–-]*\\b(?:' + HELD.slice(3, -1) + '|handcuffs|shackles)\\b[^.\\n,;:—–]*', 'i').exec(from);
      if (hit) result.example = {from: hit[0].trim().slice(0, 80), to: softenLook(hit[0]).trim().slice(0, 80)};
    }
    return to;
  };
  const apply = (holder, key) => { const from = holder?.[key]; if (typeof from !== 'string') return false; const to = softenLook(from); if (to === from) return false; holder[key] = note(from, to); return true; };
  for (const scene of project.scenes || []) {
    const image = apply(scene, 'imagePrompt');
    apply(scene, 'videoPrompt');
    if (image && !finished.has(scene.id)) result.imageIds.push(scene.id);
  }
  for (const asset of project.assets || []) if (apply(asset, 'imagePrompt')) result.assetIds.push(asset.id);
  if (Array.isArray(project.castLooks)) project.castLooks = project.castLooks.map(look => {
    if (typeof look === 'string') { const to = softenLook(look); return to === look ? look : note(look, to); }
    if (look && typeof look === 'object') for (const key of Object.keys(look)) apply(look, key);
    return look;
  });
  return result;
}
