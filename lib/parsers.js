// lib/parsers.js — pure logic shared by the extension panel and Node tests.
// No chrome.* or DOM access allowed in this file.
(function (root) {
  'use strict';

  // Split raw prompt text into individual prompts. Blank lines separate
  // multi-line prompts. Single line breaks always belong to the same prompt.
  function parsePromptText(raw, maxPrompts = 1000) {
    const source = String(raw || '').replace(/\r\n?/g, '\n');
    const blocks = source.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);
    // Builder downloads (2026-11-04) put a ruled "SCENE 1 — VIDEO PROMPT" heading block over each prompt and a
    // title/count line on top: those are labels, not prompts.
    const heading = (block) => /^═{3,}$/m.test(block) && block.split('\n').every((l) => /^═{3,}$/.test(l.trim()) || /^(SCENE|REFERENCE)\s+\d+\b/i.test(l.trim()));
    const intro = blocks.length > 1 && heading(blocks[1]) && !heading(blocks[0]) && !/═/.test(blocks[0]) && /^.{0,200}\n?\d+ [a-z -]*prompts?$/i.test(blocks[0]);
    return blocks.filter((block, i) => !heading(block) && !(intro && i === 0)).slice(0, maxPrompts);
  }

  // RFC4180 CSV/TSV parser: quoted fields, embedded commas, quotes and
  // line breaks inside quotes. Auto-detects the delimiter per line.
  function parseDelimited(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const delimiter = detectDelimiter(text);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; continue; }
      if (ch === delimiter) { row.push(field); field = ''; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      if (ch === '\r') continue;
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => String(cell || '').trim() !== ''));
  }

  function detectDelimiter(text) {
    const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
    const inQuotesCount = (firstLine.match(/"/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;
    if (inQuotesCount % 2 === 0 && commas > 0 && commas >= tabs) return ',';
    if (tabs > 0) return '\t';
    return ',';
  }

  // Choose the prompt column from sheet rows: prefer an explicit terse prompt
  // header (real column names are exact), otherwise the widest text column of
  // the first row. Long free-text cells never count as headers, so a data row
  // that merely contains the word "prompt" is kept as data.
  const HEADER_EXACT = /^(?:prompts?|video prompts?|prompt text|text|description|idea)$/i;
  function pickPromptColumn(rows) {
    if (!rows.length) return { header: null, col: 0, imageCol: null };
    const header = rows[0].map((cell) => String(cell || '').trim());
    const headerish = header.some((cell) => cell && cell.length <= 32 && HEADER_EXACT.test(cell));
    let col = 0;
    let imageCol = null;
    if (headerish) {
      col = header.findIndex((cell) => cell && cell.length <= 32 && HEADER_EXACT.test(cell));
      if (col < 0) col = 0;
      imageCol = header.findIndex((cell) => cell && /^(image|frame|start_?frame|asset|filename|file)$/i.test(cell));
      return { header, col, imageCol, dataRows: rows.slice(1) };
    }
    // No header: pick the column with the longest average cell text.
    const width = Math.max(...rows.map((r) => r.length));
    let best = 0;
    let bestScore = -1;
    for (let c = 0; c < width; c++) {
      let total = 0;
      let count = 0;
      for (const r of rows) {
        const cell = String(r[c] || '');
        if (cell.trim()) { total += cell.trim().length; count++; }
      }
      const score = count ? total / count : 0;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return { header: null, col: best, imageCol: null, dataRows: rows };
  }

  function sheetRowsToPrompts(rows, maxPrompts = 1000) {
    const { col, imageCol, dataRows } = pickPromptColumn(rows || []);
    const prompts = [];
    for (const row of dataRows || []) {
      const text = String(row[col] || '').trim();
      if (!text) continue;
      const imageName = imageCol != null && imageCol >= 0 ? String(row[imageCol] || '').trim() : '';
      prompts.push({ text, imageName });
      if (prompts.length >= maxPrompts) break;
    }
    return prompts;
  }

  // Resolve which uploaded images (by index) a prompt should use.
  // options.mode: 'start-frame' | 'all-each' | 'first-only' | 'pair'
  function imageIndicesForPrompt(promptIndex, imageCount, mode) {
    if (!imageCount) return [];
    switch (mode) {
      case 'all-each': return Array.from({ length: imageCount }, (_, i) => i);
      case 'first-only': return [0];
      case 'pair': return promptIndex < imageCount ? [promptIndex] : [];
      case 'start-frame':
      default: return [promptIndex % imageCount];
    }
  }

  // Match a CSV "image" cell to an uploaded image filename (basename compare).
  function matchImageByName(name, imageNames) {
    const wanted = String(name || '').trim().toLowerCase().replace(/\.[^.]+$/, '');
    if (!wanted) return null;
    const exact = imageNames.findIndex((n) => n.toLowerCase() === `${wanted}.${n.split('.').pop().toLowerCase()}`);
    if (exact >= 0) return exact;
    const idx = imageNames.findIndex((n) => n.toLowerCase().replace(/\.[^.]+$/, '') === wanted);
    return idx >= 0 ? idx : null;
  }

  function bufferHasMp4Signature(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 16) return false;
    // ftyp is variable length: Flow includes several compatible brands and
    // currently emits a 32-byte box rather than the older 24-byte box.
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length || (size - 16) % 4 !== 0) return false;
    if (String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) !== 'ftyp') return false;
    return true;
  }

  function bufferHasImageSignature(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12) return false;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true; // PNG
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true; // JPEG
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true; // GIF
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      // RIFF also wraps AVI video and WAV audio; only WEBP is an image.
      return String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP';
    }
    return !!isoImageBrand(bytes);
  }

  // HEIC/HEIF/AVIF are ISO-BMFF files: the "ftyp" box starts at byte 4 and its
  // major brand follows (an MP4 also has ftyp, so the brand decides).
  function isoImageBrand(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 12 || String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) !== 'ftyp') return null;
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (/^(?:avif|avis)$/.test(brand)) return 'avif';
    if (/^(?:heic|heix|heim|heis|hevc|hevx|heif|mif1|msf1)$/.test(brand)) return 'heic';
    return null;
  }

  // Conservative Flow quota/credit detection. Only explicit exhaustion
  // phrases stop the queue — loose words like "limit" alone must not.
  function isFlowQuotaText(text) {
    const value = String(text || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) return false;
    return [
      /you'?ve (?:hit|reached) your (?:daily )?limit/,
      /you'?re out of (?:credits|generations)/,
      /out of credits for (?:today|now)/,
      /credit limit reached/,
      /monthly (?:credit|generation) limit/,
      /you'?ve used all (?:your )?credits/,
      /limit resets (?:at|on|tomorrow)/,
      // "try again later" alone is Flow's generic error wording, not a quota.
      /try again (?:tomorrow|once your credits)/,
      /(?:limit|credits?)(?: (?:reached|exceeded))?[.!]? try again later/,
      /usage limit reached/,
      // Flow AI-credit wording. "You're running low on … credits" still has credits left and does not match.
      /(?:not enough|insufficient|no) (?:ai |google flow |flow )?credits/,
      /(?:out of|run out of|ran out of) (?:your )?(?:ai |google flow |flow )?credits/,
      /\b0 (?:ai )?credits (?:left|remaining|available)/,
      /(?:need|get|buy) more (?:ai )?credits to (?:generate|continue|create)/,
      /credits? (?:balance )?(?:is |are )?(?:empty|depleted|exhausted|used up)/,
    ].some((pattern) => pattern.test(value));
  }

  function randomDelayMs(minSeconds, maxSeconds) {
    const min = Math.max(0, Number(minSeconds) || 0);
    const max = Math.max(min, Number(maxSeconds) || min);
    const span = Math.max(0, max - min);
    return Math.round((min + Math.random() * span) * 1000);
  }

  function imageIndicesMentionedInPrompt(text, names) {
    const prompt = String(text || '').toLowerCase();
    return names.map((name, index) => {
      const base = String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
      if (!base) return null;
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_-])@?${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'u');
      const match = pattern.exec(prompt);
      return match ? {index, position: match.index} : null;
    }).filter(Boolean).sort((a, b) => a.position - b.position || a.index - b.index).map(item => item.index);
  }

  function missingImageMentions(text, names) {
    const basenames = new Set(names.map(name => String(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase()));
    return [...new Set(Array.from(String(text || '').matchAll(/@([\p{L}\p{N}_-]+)/gu), match => match[1]).filter(name => !basenames.has(name.toLowerCase())))];
  }

  function promptReferenceSegments(text, names) {
    const segments = [];
    const source = String(text || '');
    let offset = 0;
    for (const match of source.matchAll(/@([\p{L}\p{N}_-]+)(?:\.(?:png|jpe?g|webp))?/giu)) {
      const index = matchImageByName(match[1], names);
      if (index == null || index < 0) throw new Error(`Missing image for ${match[0]}`);
      if (match.index > offset) segments.push({type: 'text', text: source.slice(offset, match.index)});
      segments.push({type: 'photo', name: names[index]}); offset = match.index + match[0].length;
    }
    if (offset < source.length) segments.push({type:'text', text:source.slice(offset)});
    return segments;
  }

  function simplifyRepeatedShotReferences(text, names) {
    const source = String(text || '');
    const parts = source.split(/(?=^\[[^\]\r\n]+\])/m);
    const isShotOrDialogue = part => /^\[(?:Multi-Camera Shot Sequence|Shot Sequence|Shots|Dialogue(?: & Audio)?|Audio)\]/i.test(part);
    const retained = new Set();
    for (const part of parts.filter(part => !isShotOrDialogue(part))) {
      for (const match of part.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
        const index = matchImageByName(match[1], names);
        if (index != null && index >= 0) retained.add(match[1].toLowerCase());
      }
    }
    return parts.map(part => isShotOrDialogue(part)
      ? part.replace(/"[^"\r\n]*"|“[^”\r\n]*”|@([\p{L}\p{N}_-]+)/gu, (tag, name) => name && retained.has(name.toLowerCase()) ? name : tag)
      : part).join('');
  }
  const api = {
    simplifyRepeatedShotReferences,
    promptReferenceSegments,
    missingImageMentions,
    imageIndicesMentionedInPrompt,
    parsePromptText,
    parseDelimited,
    pickPromptColumn,
    sheetRowsToPrompts,
    imageIndicesForPrompt,
    matchImageByName,
    bufferHasMp4Signature,
    bufferHasImageSignature,
    isoImageBrand,
    isFlowQuotaText,
    randomDelayMs,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlowParsers = api;
})(typeof self !== 'undefined' ? self : this);
