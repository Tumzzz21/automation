// Story shape (owner 2026-11-10, member request): an AI Story or Video → Story project can be wide 16:9 instead of
// vertical 9:16. The story's prompts are written for 9:16 (server rulebooks); a wide project keeps them as written and
// this file rewords the frame wording when the prompts are loaded into the queue. Vertical projects are never touched.
(function (g) {
  const isLandscape = p => String((p && p.aspect) || '') === '16:9';
  function landscapeText(text) {
    return String(text)
      .replace(/\b9\s*:\s*16\s+vertical\b/gi, '16:9 horizontal')
      .replace(/\bvertical\s+9\s*:\s*16\b/gi, 'horizontal 16:9')
      .replace(/\b9\s*:\s*16\b/g, '16:9')
      .replace(/\b9\s*x\s*16\b/gi, '16x9')
      // Character sheets are square in vertical stories; a wide story asks for wide sheets (member: "1:1 not good").
      .replace(/\bsquare\s+1\s*:\s*1\b/gi, '16:9 horizontal')
      .replace(/\bvertical\s+(clip|video|frame|format|image|photo|picture|composition|framing)\b/gi, 'horizontal $1')
      .replace(/\bmobile-safe\b/gi, 'title-safe');
  }
  const text = (p, value) => isLandscape(p) ? landscapeText(value) : String(value);
  // The queue's aspect setting: wide stories are 'landscape' for every picture and video; vertical keeps its own choice.
  const aspect = (p, vertical) => isLandscape(p) ? 'landscape' : (vertical || 'portrait');
  g.StoryShape = {isLandscape, landscapeText, text, aspect};
})(typeof globalThis !== 'undefined' ? globalThis : this);
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.StoryShape;
