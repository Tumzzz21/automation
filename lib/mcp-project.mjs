// Turns prompts written in the user's AI chat into a local AI Story project (owner 2026-11-09): the image prompts and video
// prompts stay paired by scene, and AI Story's own steps (images, then videos, Auto, Retry, Workspace) run it.
const MIN = 40, MAX = 16000, MAX_SCENES = 60, MAX_INGREDIENTS = 40;
const OMNI = /^omni1[12]flash$/, IMAGE_ENGINES = ['flow', 'chatgpt', 'gemini', 'grok'];
const CHAT_SITES = {chatgpt: /^https:\/\/chatgpt\.com(?:\/|$)/i, gemini: /^https:\/\/gemini\.google\.com(?:\/|$)/i, grok: /^https:\/\/(?:[\w-]+\.)?grok\.com(?:\/|$)/i};
// A run on Gemini, ChatGPT or Grok types into the active tab of that site. Started from that same site's chat, it would type into the user's conversation.
export const chatInTheWay = (url, engines) => engines.find(e => CHAT_SITES[e]?.test(String(url || ''))) || '';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const check = (text, label) => {
  if (text.length < MIN) throw Error(label + ' is too short to be a full prompt (' + text.length + ' characters). Nothing was saved.');
  if (text.length > MAX) throw Error(label + ' is too long (up to ' + MAX + ' characters). Nothing was saved.');
  return text;
};
const secondsOf = (scene, fallback) => {
  const n = Number(scene.duration_seconds || String(scene.video_prompt).match(/\[Duration\][^\n\d]*(\d{1,2})/i)?.[1] || fallback);
  if (!Number.isInteger(n) || n < 3 || n > 15) throw Error('Scene length must be a whole number from 3 to 15 seconds.');
  return n;
};
// A tag such as @MAYA or a plain MAYA, as a whole name only.
const nameRe = (name, at) => new RegExp((at ? '@' : '(?<![\\p{L}\\p{N}_-])@?') + escapeRe(name) + '(?![\\p{L}\\p{N}_-])', at ? 'giu' : 'iu');

export function buildProject(input, settings, B, {id = crypto.randomUUID(), requestId = crypto.randomUUID(), now = Date.now()} = {}) {
  const raw = Array.isArray(input?.scenes) ? input.scenes : [], list = Array.isArray(input?.ingredients) ? input.ingredients : [];
  if (!raw.length || raw.length > MAX_SCENES) throw Error('A project has 1 to ' + MAX_SCENES + ' scenes.');
  if (list.length > MAX_INGREDIENTS) throw Error('A project has up to ' + MAX_INGREDIENTS + ' ingredients.');
  const withImage = raw.filter(s => s.image_prompt).length, recurring = list.length > 0;
  if (recurring && withImage) throw Error('Send either image prompts for each scene, or an ingredient sheet. Not both in one project.');
  if (!recurring && withImage !== raw.length) throw Error('Every scene needs an image prompt, or send an ingredient sheet. ' + (raw.length - withImage) + ' scene(s) have no image prompt.');

  const imageEngine = input.image_engine || 'flow';
  if (!IMAGE_ENGINES.includes(imageEngine)) throw Error('Images can be made on: ' + IMAGE_ENGINES.join(', ') + '.');
  if (input.video_model && !B.flowVideoModels().includes(input.video_model)) throw Error('Flow video model must be one of: ' + B.flowVideoModels().join(', ') + '. Nothing was saved.');
  const target = B.generationTargets({imagePlatform: imageEngine, videoPlatform: 'flow', ...(input.video_model ? {model: input.video_model} : {})}, settings), seconds = raw.map(s => secondsOf(s, settings.flowDurationSeconds || 8));
  const same = seconds.every(n => n === seconds[0]), plain = same && [8, 10].includes(seconds[0]);
  if (!(plain && seconds[0] === 8) && !OMNI.test(String(target.model).toLowerCase().replace(/[^a-z0-9]/g, ''))) throw Error('These scenes need Omni Flash in Flow. Send again with video_model Omni 1.2 Flash, or choose it in the panel. Nothing was saved.');

  const seen = new Set();
  const assets = list.map((x, i) => {
    const name = String(x.name || '').trim(), key = name.toLowerCase();
    if (!name || seen.has(key)) throw Error(name ? 'The ingredient ' + name + ' is listed twice.' : 'Ingredient ' + (i + 1) + ' has no name.');
    seen.add(key);
    return {id: 'asset_' + String(i + 1).padStart(3, '0'), name, imagePrompt: check(String(x.prompt || ''), 'Ingredient ' + name)};
  });
  const scenes = raw.map((s, i) => {
    const label = 'Scene ' + (i + 1); let videoPrompt = check(String(s.video_prompt || ''), label + ' video prompt'), references = [];
    if (recurring) {
      if (Array.isArray(s.ingredients) && s.ingredients.length) {
        references = s.ingredients.map(n => {
          const a = assets.find(x => x.name.toLowerCase() === String(n).trim().toLowerCase());
          if (!a) throw Error(label + ' uses "' + n + '", which is not in the ingredient sheet. Nothing was saved.');
          return a;
        });
        references = [...new Set(references)];
      } else references = assets.filter(a => nameRe(a.name).test(videoPrompt));
      if (!references.length) throw Error(label + ' does not name any ingredient. Nothing was saved.');
      // AI Story turns "Image N" into Flow's own reference tag for the scene's Nth picture. Longest name first, so MAYA_OLD is not read as MAYA.
      for (const a of [...references].sort((x, y) => y.name.length - x.name.length)) videoPrompt = videoPrompt.replace(nameRe(a.name, true), 'Image ' + (references.indexOf(a) + 1));
    }
    return {id: 'scene_' + String(i + 1).padStart(3, '0'), durationSeconds: seconds[i], speech: '', caption: '', imagePrompt: recurring ? videoPrompt : check(String(s.image_prompt), label + ' image prompt'), videoPrompt, references: references.map(a => a.id)};
  });
  const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'AI chat story';
  const setup = {importedPackage: true, topic: title, sceneCount: String(scenes.length), sceneDuration: plain ? String(seconds[0]) : '10', exportProfile: recurring ? 'Recurring assets + video' : 'Scene image + video', ...(plain ? {} : {sceneLengths: 'flex'})};
  const project = B.validateProject({title, voice: 'As written in each video prompt.', assets, scenes}, setup);
  return {id, kind: 'project', state: 'prompts_ready', origin: 'ai-chat', createdAt: now, day: new Date(now).toISOString().slice(0, 10), requestId, setup: project.setup, project, media: {}, imagesReviewed: false, target: {imagePlatform: imageEngine, videoPlatform: 'flow', model: target.model}};
}
