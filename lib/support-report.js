// Shared report boundary: the preview and server use the same allowlist and redaction.
(() => {
  'use strict';
  const SETTING_KEYS = Object.freeze(['platform', 'mode', 'flowModel', 'flowImageModel', 'aspectRatio', 'flowDurationSeconds', 'flowOutputCount', 'videoResolution', 'imageDownload',
    'grokImageQuality', 'geminiModel', 'referenceImageNames', 'renameOutputs', 'autoMatchIngredientImages', 'downloadSubfolder']);
  function redact(value) {
    return String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
      .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
        try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
        catch { return '[url]'; }
      })
      .replace(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi, '[email]')
      .replace(/\bBearer\s+[^\s,"';]+/gi, 'Bearer [redacted]')
      .replace(/\boxmcp_[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\b(?:AIza[A-Za-z0-9_-]{15,}|sk[_-][A-Za-z0-9_-]{16,})/g, '[redacted]')
      .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|key|secret|password|authorization|cookie|set-cookie)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
      .replace(/\b[A-F0-9]{24,}\b/gi, '[redacted]')
      .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/g, '[redacted]')
      .replace(/([A-Z]:[\\/]Users[\\/])[^\\/\r\n]+/gi, '$1[user]')
      .replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1[user]');
  }
  const utf8Size = text => [...text].reduce((n, c) => n + (c.codePointAt(0) < 128 ? 1 : c.codePointAt(0) < 2048 ? 2 : c.codePointAt(0) < 65536 ? 3 : 4), 0);
  function line(value) {
    const clean = redact(value).replace(/[\r\n\t]/g, ' ');
    let result = '', bytes = 0;
    // Bound escaped UTF-8 as well as characters, so 300 Unicode-heavy lines
    // still fit the server's 200 KB body limit without cutting the Send payload.
    for (const character of clean) {
      const size = utf8Size(JSON.stringify(character)) - 2;
      if (bytes + size > 500 || result.length + character.length > 500) break;
      result += character; bytes += size;
    }
    return result;
  }
  function cleanSettings(input) {
    const out = {};
    for (const key of SETTING_KEYS) {
      if (!input || !Object.hasOwn(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') out[key] = line(value).slice(0, 100);
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    }
    return out;
  }
  function cleanReport(input = {}) {
    const logs = Array.isArray(input.logs) ? input.logs.filter(v => typeof v === 'string').join('\n') : typeof input.logs === 'string' ? input.logs : '';
    return {version: line(typeof input.version === 'string' ? input.version : '').slice(0, 40),
      platform: line(typeof input.platform === 'string' ? input.platform : '').slice(0, 40),
      settings: cleanSettings(input.settings), logs: logs.split(/\r?\n/).slice(-300).map(line),
      note: line(typeof input.note === 'string' ? input.note : '')};
  }
  // Reject the entire answer's changes when even one key/value is outside the contract.
  function allowedChanges(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Support returned invalid setting changes.');
    for (const [key, value] of Object.entries(input)) {
      if (!SETTING_KEYS.includes(key) || !(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length <= 100))) throw Error('Support returned an unsupported setting change.');
    }
    return {...input};
  }
  const api = Object.freeze({SETTING_KEYS, redact, line, cleanSettings, cleanReport, allowedChanges});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.SupportReportData = api;
})();
