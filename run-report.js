'use strict';
// Run receipts (one CSV per queue run: prompts, settings, attempts, repairs, errors and saved files) and the
// pre-start check (problems that would only surface prompt by prompt during a run). Pure functions over the queue
// and settings; control.js gathers the inputs and shows the results. Nothing here touches the network or storage.

const RUN_REPORT_PLATFORMS = {flow: 'Google Flow', chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok', muse: 'Muse', higgsfield: 'Higgsfield'};

function runReportPad(n) { return String(n).padStart(2, '0'); }
function runReportStamp(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${runReportPad(d.getMonth() + 1)}-${runReportPad(d.getDate())} ${runReportPad(d.getHours())}:${runReportPad(d.getMinutes())}:${runReportPad(d.getSeconds())}`;
}
function runReportDuration(ms) {
  if (!(ms > 0)) return '';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
function runReportFileName(ms = Date.now()) {
  const d = new Date(ms);
  return `run-report_${d.getFullYear()}-${runReportPad(d.getMonth() + 1)}-${runReportPad(d.getDate())}_${runReportPad(d.getHours())}-${runReportPad(d.getMinutes())}-${runReportPad(d.getSeconds())}.csv`;
}

// input: {queue, settings, modeLabel, version, run: {firstStartedAt, lastStartedAt, finishedAt, starts, stopReason}, referencesFor(item) -> [names], now}
function runReportData(input) {
  const {queue = [], settings = {}, run = {}, version = '', modeLabel = '', referencesFor = () => [], now = Date.now()} = input;
  const items = queue.filter(item => !item.groupParent || item.status === 'combined');
  const count = status => items.filter(item => item.status === status).length;
  const video = /video|agent/.test(settings.mode || '');
  return {
    version, exportedAt: now,
    platform: RUN_REPORT_PLATFORMS[settings.platform] || 'Google Flow', mode: modeLabel || settings.mode || '',
    settings: {
      'Aspect ratio': settings.aspectRatio || '',
      ...(video ? {'Video duration': settings.flowDurationSeconds ? `${settings.flowDurationSeconds}s` : '', 'Generation resolution': settings.videoGenerationResolution || '', 'Download resolution': settings.videoResolution || ''} : {}),
      'Concurrent prompts': settings.concurrentPrompts ?? '', 'Image processing': settings.imageProcessing || '',
      'Download folder': settings.downloadSubfolder || '', 'Maximum attempts': settings.maxAttempts ?? '',
    },
    run: {startedAt: run.firstStartedAt || 0, finishedAt: run.finishedAt || 0, starts: run.starts || 0, stopReason: run.stopReason || '',
      running: !!run.running},
    totals: {total: items.length, done: count('done'), errors: count('error'), pending: count('pending') + count('running'),
      skipped: count('skipped') + count('combined'), repaired: items.filter(item => item.repairCount > 0).length},
    prompts: items.map(item => ({
      index: item.index, id: item.id || '', status: item.status || '', attempts: item.attempts || 0, repairs: item.repairCount || 0,
      outputFile: item.outputName || '', detail: item.detail || '', references: referencesFor(item) || [],
      prompt: item.text || '', originalPrompt: item.originalText && item.originalText !== item.text ? item.originalText : '',
    })),
  };
}

// One CSV cell. Text that a spreadsheet would run as a formula (= + - @ at the start, e.g. "@char_1 walks …") is
// prefixed with an apostrophe so it stays text.
function runReportCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function runReportCsv(report) {
  const rows = [];
  const row = (...cells) => rows.push(cells.map(runReportCell).join(','));
  row('0xtnp Flow Studio run report');
  row('Version', report.version);
  row('Exported', runReportStamp(report.exportedAt));
  row('Platform', report.platform);
  row('Mode', report.mode);
  for (const [name, value] of Object.entries(report.settings)) row(name, value);
  row('Started', runReportStamp(report.run.startedAt));
  row('Finished', report.run.running ? 'still running' : runReportStamp(report.run.finishedAt));
  row('Run time', report.run.running ? '' : runReportDuration(report.run.finishedAt - report.run.startedAt));
  row('Start presses', report.run.starts);
  row('Result', `${report.totals.done} of ${report.totals.total} saved, ${report.totals.errors} error(s), ${report.totals.pending} pending, ${report.totals.skipped} skipped or combined, ${report.totals.repaired} repaired`);
  if (report.run.stopReason) row('Stopped because', report.run.stopReason);
  rows.push('');
  row('Prompt', 'Status', 'Attempts', 'Repairs', 'Saved file', 'Result / error', 'Reference images', 'Prompt sent', 'Original prompt (before repair)', 'ID');
  for (const p of report.prompts) row(p.index, p.status, p.attempts, p.repairs, p.outputFile, p.detail, p.references.join('; '), p.prompt, p.originalPrompt, p.id);
  // BOM so spreadsheet apps read Tagalog, accents and emoji as UTF-8.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// ---------- pre-start check ----------
// input: {items (pending prompts), settings, images (uploaded, [{name}]), modeDef {label, needsImages}, imagesFor(item) -> images,
//         missingMentions(text, names) -> [names], matchImageByName(name, names) -> index|null, rawFolder, folder}
// Returns [{level: 'error' | 'warning', message}]. Errors stop Start (the user can still press "Start anyway").
function preflightCheck(input) {
  const {items = [], settings = {}, images = [], modeDef = {}, imagesFor = () => [], missingMentions = () => [], matchImageByName = () => null,
    rawFolder = '', folder = ''} = input;
  const issues = [];
  const list = numbers => numbers.length > 8 ? `${numbers.slice(0, 8).join(', ')} and ${numbers.length - 8} more` : numbers.join(', ');
  const prompts = numbers => `${numbers.length === 1 ? 'Prompt' : 'Prompts'} ${list(numbers)}`;
  const names = images.map(image => image.name);
  const mode = settings.mode || '';
  if (modeDef.needsImages && !images.length) {
    issues.push({level: 'error', hard: true, message: `${modeDef.label || 'This mode'} needs uploaded images. Add them under Images first.`});
  } else if (modeDef.needsImages) {
    const mentionMissing = new Map();
    if ((mode === 'ingredients-to-video' || mode === 'image-to-image') && settings.autoMatchIngredientImages !== false) {
      for (const item of items) for (const name of missingMentions(item.text || '', names)) {
        if (!mentionMissing.has(name)) mentionMissing.set(name, []);
        mentionMissing.get(name).push(item.index);
      }
      for (const [name, numbers] of mentionMissing) issues.push({level: 'error', message: `${prompts(numbers)} ${numbers.length === 1 ? 'mentions' : 'mention'} @${name}, but no uploaded image has that name.`});
    }
    const chained = mode === 'frame-to-video' && settings.chainLastFrame;
    const none = items.filter(item => !(chained && item !== items[0]) && !imagesFor(item).length).map(item => item.index);
    if (none.length && !mentionMissing.size) issues.push({level: 'error', message: `${prompts(none)} ${none.length === 1 ? 'has' : 'have'} no ${mode === 'frame-to-video' ? 'start image' : 'reference images'} assigned.`});
    if (settings.platform === 'grok' && mode === 'ingredients-to-video') {
      const one = items.filter(item => imagesFor(item).length === 1).map(item => item.index);
      if (one.length) issues.push({level: 'error', message: `${prompts(one)}: Grok needs at least 2 reference images for Ingredients to Video (one image is a start frame — use Frame to Video).`});
    }
    const csvMissing = items.filter(item => item.imageName && !(matchImageByName(item.imageName, names) >= 0 && matchImageByName(item.imageName, names) != null));
    if (csvMissing.length) issues.push({level: 'warning', message: `${prompts(csvMissing.map(item => item.index))}: the image named in your file (${[...new Set(csvMissing.map(item => item.imageName))].slice(0, 3).join(', ')}) was not uploaded; ${settings.imageProcessing || 'the image order'} is used instead.`});
  }
  const typed = String(rawFolder || '').trim();
  if (typed && folder && typed !== folder) issues.push({level: 'warning', message: `Download folder "${typed}" contains characters Windows does not allow; files go to "${folder}".`});
  return issues;
}

if (typeof module !== 'undefined') module.exports = {runReportData, runReportCsv, runReportCell, runReportFileName, runReportStamp, runReportDuration, preflightCheck};
