// AI assistant connection (MCP, owner 2026-10-31, Pro and Discord Pro). After the user creates an AI assistant key in
// Settings, this panel tells our server what the assistant may see (template names, Story Factory progress, queue
// counts) and picks up the assistant's start/stop commands while the panel is open. Commands run through AI Story's own
// Factory code, so every Factory rule still applies. Nothing about the Google login or Flow page is sent.
(() => {
  const FAST_MS = 5000, IDLE_MS = 60000, QUIET_MS = 10 * 60000;
  let timer = 0, quietUntil = 0, device = {id: ''}, lastLoad = null;
  async function call(path, body) {
    return (window.flowStatusClient || (await import('./lib/story-narration-generate.mjs')).serverClient()).request(path, body);   // flowStatusClient: tests
  }
  // Ready-made prompts from the user's AI chat (owner 2026-11-09). Same path as importing a TXT file; never starts by itself.
  const queueSignature = () => JSON.stringify([settings.mode, queue.map(i => i.sourceText ?? i.text)]);
  async function busyReason(ui) {
    if (running || activeRuns.size || (typeof projectImportBusy !== 'undefined' && projectImportBusy)) return 'A queue is already running in the panel. Wait for it to finish.';
    if (globalThis.MobileFlowPilot?.isActive?.()) return 'The mobile background queue is running. Wait for it to finish.';
    return (await ui.mcpFactory?.().catch(() => null))?.status === 'running' ? 'The Story Factory is running. Wait for it to finish.' : '';
  }
  // Panel settings for the AI assistant (owner 2026-11-14, members asked for aspect ratio and "Save images using reference
  // names"). Only this fixed list; account, plan, keys and payment never appear. Every change goes through the panel's own
  // control, so the same rules apply as when the member changes it by hand; the allowed values are the choices the control
  // offers right now (they depend on the engine, mode and model). Engine and mode first, the model before the length.
  const SETTINGS = [
    ['platform', 'platformSelect', 'Engine'], ['mode', '', 'Mode'], ['flowModel', 'flowModel', 'Flow video model'],
    ['flowImageModel', 'flowImageModel', 'Flow image model'], ['aspectRatio', 'aspectRatio', 'Aspect ratio'],
    ['flowDurationSeconds', 'flowDurationSeconds', 'Video length (seconds)'], ['flowOutputCount', 'flowOutputCount', 'Outputs per prompt'],
    ['videoResolution', 'videoResolution', 'Video download resolution'], ['imageDownload', 'imageDownload', 'Image download'],
    ['grokImageQuality', 'grokImageQuality', 'Grok image quality'], ['geminiModel', 'geminiModel', 'Gemini model'],
    ['referenceImageNames', 'referenceImageNames', 'Save images using reference names'], ['renameOutputs', 'renameOutputs', 'Auto change file name'],
    ['autoMatchIngredientImages', 'autoMatchIngredientImages', 'Auto match ingredient images'], ['downloadSubfolder', 'downloadSubfolder', 'Save to folder']];
  // Only the setting's own row counts: the panel hides a row when the engine or mode does not use it. A closed tab does not count.
  const shown = el => { const row = el?.closest('.field,.switch-row'); return !!el && !(row && (row.hidden || row.classList.contains('hidden'))); };
  const choices = el => [...el.options].filter(o => !o.hidden && !o.disabled).map(o => ({value: o.value, label: o.textContent.trim()}));
  const modeButtons = () => [...document.querySelectorAll('.mode-btn')].filter(b => !b.hidden && !b.disabled && !b.classList.contains('hidden'));
  function readSetting([key, id, label]) {
    if (key === 'mode') return {key, label, value: settings.mode, valueLabel: MODES[settings.mode]?.label || settings.mode, options: modeButtons().map(b => ({value: b.dataset.mode, label: MODES[b.dataset.mode]?.label || b.dataset.mode}))};
    const el = $(id);
    if (!el) return null;
    const out = {key, label, value: settings[key], available: shown(el)};   // options only for settings in use, to keep the answer short
    if (el.tagName === 'SELECT') { const list = choices(el); out.valueLabel = list.find(o => o.value === String(settings[key] ?? ''))?.label; if (out.available) out.options = list; }
    else if (el.type === 'checkbox') out.options = 'true or false';
    else out.format = 'folder name: letters, numbers, spaces, - and _, up to 60 characters';
    return out;
  }
  function getSettings() {
    return JSON.stringify({engine: settings.platform || 'flow', running: !!running, settings: SETTINGS.map(readSetting).filter(Boolean)});
  }
  const shownValue = s => s.valueLabel || String(s.value);
  async function setSettings(ui, {changes}) {
    const busy = await busyReason(ui);
    if (busy) throw Error(busy + ' Settings were not changed.');
    const wanted = changes && typeof changes === 'object' ? changes : {};
    const unknown = Object.keys(wanted).filter(k => !SETTINGS.some(s => s[0] === k));
    if (unknown.length) throw Error('These cannot be changed by the AI assistant: ' + unknown.join(', ') + '. Nothing was changed.');
    const done = [], refused = [];
    for (const entry of SETTINGS) {
      const [key, id, label] = entry;
      if (!(key in wanted)) continue;
      const before = readSetting(entry), value = wanted[key];
      if (key === 'mode') {
        const button = modeButtons().find(b => b.dataset.mode === value);
        if (!button) { refused.push(label + ': "' + value + '" is not offered on this engine'); continue; }
        button.click();
      } else {
        const el = $(id);
        if (!before?.available || (el.tagName === 'SELECT' && !before.options)) { refused.push(label + ': not used with this engine or mode'); continue; }
        if (el.tagName === 'SELECT') {
          if (!before.options.some(o => o.value === String(value))) { refused.push(label + ': "' + value + '" is not a choice here (choices: ' + before.options.map(o => o.value || '(keep current)').join(', ') + ')'); continue; }
          el.value = String(value);
        } else if (el.type === 'checkbox') {
          if (typeof value !== 'boolean') { refused.push(label + ': use true or false'); continue; }
          el.checked = value;
        } else {
          const folder = String(value ?? '').trim();
          if (!/^[\p{L}\p{N} _-]{1,60}$/u.test(folder)) { refused.push(label + ': use letters, numbers, spaces, - and _ only (up to 60)'); continue; }
          el.value = folder;
        }
        el.dispatchEvent(new Event('change', {bubbles: true}));
        collectSettingsFromForm(); renderMode();   // aspect ratio and the folder have no change handler of their own
      }
      const after = readSetting(entry);
      if (String(after.value) !== String(key === 'downloadSubfolder' ? String(value).trim() : value)) { refused.push(label + ': the panel kept ' + shownValue(after)); continue; }
      if (String(before.value) !== String(after.value)) done.push(label + ' ' + shownValue(before) + ' → ' + shownValue(after));
    }
    renderImages();
    await persistState();
    if (done.length) log('AI assistant changed: ' + done.join('; ') + '.');
    return (done.length ? 'Changed: ' + done.join('; ') + '.' : 'Nothing needed changing.') + (refused.length ? ' Not changed: ' + refused.join('; ') + '.' : '');
  }
  async function loadPrompts(ui, id, {mode, prompts, replace, durations}) {
    const busy = await busyReason(ui);
    if (busy) throw Error(busy);
    const label = MODES[mode]?.label;
    if (!label || sanitizeSettings({...settings, mode}).mode !== mode) throw Error((label || 'This mode') + ' is not available on the engine chosen in the panel.');
    // Per-prompt video lengths (owner 2026-11-14): the same lengths the panel's duration cards offer for this engine and model.
    const lengths = Array.isArray(durations) && durations.length ? durations.map(Number) : null;
    if (lengths) {
      if (MODES[mode].resultKind !== 'video') throw Error('Lengths are only for video prompts. Nothing was loaded.');
      if (lengths.length !== prompts.length) throw Error('Give one length per prompt (' + prompts.length + '), or none. Nothing was loaded.');
      const offered = flowDurationChoices(settings.platform || 'flow', settings.flowModel);
      const bad = lengths.findIndex(n => !offered.includes(n));
      if (bad >= 0) throw Error('Prompt ' + (bad + 1) + ': ' + lengths[bad] + 's is not offered for ' + (settings.flowModel || 'this model') + ' (lengths: ' + offered.join(', ') + 's). Nothing was loaded.');
    }
    const unfinished = queue.filter(i => ['pending', 'error'].includes(i.status)).length;
    if (unfinished && !replace) throw Error('The panel queue still has ' + unfinished + ' unfinished prompt(s). Ask the user if they can be replaced, then send again with replace=true. Nothing was loaded.');
    settings.mode = mode;
    renderMode();
    $('promptText').value = prompts.join('\n\n');
    sheetPrompts = [];
    const count = applyPromptsToQueue(null);
    if (lengths && count === prompts.length) queue.forEach((item, i) => { item.videoMode = lengths[i] + 's'; });
    renderImages();
    await persistState();
    if (count !== prompts.length) throw Error('Only ' + count + ' of ' + prompts.length + ' prompts could be loaded. Check them in the panel.');
    lastLoad = {id: id.slice(0, 8), signature: queueSignature()};
    const lengthText = lengths ? ' with lengths ' + lengths.map(n => n + 's').join(', ') : '';
    log('AI assistant loaded ' + count + ' prompt(s) as ' + label + lengthText + '.');
    return 'Loaded ' + count + ' prompt(s) as ' + label + lengthText + '. Nothing has started. Load id: ' + lastLoad.id + '.' + (MODES[mode].needsImages ? ' The panel has ' + images.length + ' image(s) for them.' : '');
  }
  async function startLoaded(ui, {loadId}) {
    if (lastLoad?.id !== loadId) throw Error('That is not the latest load in the panel. Load the prompts again, or press Start in the panel.');
    const busy = await busyReason(ui);
    if (busy) throw Error(busy);
    if ((settings.platform || 'flow') !== 'flow') throw Error('The AI assistant can only start Flow runs. Press Start in the panel for this engine.');
    if (queueSignature() !== lastLoad.signature) throw Error('The queue changed after it was loaded. Press Start in the panel, or load the prompts again.');
    await startQueue();
    if (!running) {
      const blocked = runPreflight().filter(x => x.level === 'error').map(x => x.message).join(' ');
      const status = $('applyStatus').textContent;
      throw Error(blocked || (/queued/.test(status) ? 'The panel did not start. Press Start in the panel to see why.' : status));
    }
    lastLoad = null;   // one load, one start
    return 'Started ' + queue.length + ' prompt(s) on Flow. Progress is in get_status.';
  }
  async function run(c) {
    const ui = window.FlowBuilderUI;
    if (!ui?.mcpStartFactory) throw Error('AI Story is still loading. Try again in a moment.');
    if (c.type === 'start-factory') return ui.mcpStartFactory(c.args || {});
    if (c.type === 'stop-factory') return ui.mcpStopFactory();
    if (c.type === 'load-prompts') return loadPrompts(ui, c.id, c.args || {});
    if (c.type === 'start-queue') return startLoaded(ui, c.args || {});
    if (c.type === 'save-project') return ui.mcpSaveProject(c.args || {});
    if (c.type === 'run-project') return ui.mcpRunProject(c.args || {});
    if (c.type === 'get-settings') return getSettings();
    if (c.type === 'set-settings') return setSettings(ui, c.args || {});
    throw Error('Unknown command.');
  }
  async function poll() {
    clearTimeout(timer); timer = 0;
    let next = IDLE_MS;
    try {
      const r = await chrome.storage.local.get(['mcpBridgeOn', 'flowStatusDevice']);
      if (r.mcpBridgeOn && Date.now() >= quietUntil) {
        device = {id: r.flowStatusDevice || ''};
        const ui = window.FlowBuilderUI, q = typeof queue !== 'undefined' && Array.isArray(queue) ? queue : [];
        const answer = await call('/mcp/poll', {device, ...(ui?.mcpSnapshot?.() || {}), factory: await ui?.mcpFactory?.().catch(() => null) || null,
          queue: {running: typeof running !== 'undefined' && !!running, done: q.filter(i => i.status === 'done').length, errors: q.filter(i => i.status === 'error').length, total: q.length,
            reasons: globalThis.QueueReasons?.queueReasonCounts(q) || {}}});
        if (answer?.hasKey === false) await chrome.storage.local.set({mcpBridgeOn: false});
        else next = FAST_MS;
        for (const c of answer?.commands || []) {
          let done;
          try { done = {ok: true, message: String(await run(c) || 'Done.')}; } catch (e) { done = {ok: false, error: e.message || String(e)}; }
          await call('/mcp/done', {device, id: c.id, ...done}).catch(() => {});
        }
      }
    } catch (e) {
      if ([401, 403, 404, 503].includes(e.status) || e.code === 'NO_SERVER') quietUntil = Date.now() + QUIET_MS;
    }
    timer = setTimeout(poll, next);
  }
  // MCP chip next to Max Speed (owner 2026-11-01): teal dot while a key is on; a click opens Settings on the MCP tab.
  const chip = typeof document !== 'undefined' ? document.getElementById('mcpChip') : null;
  const showChip = on => chip?.setAttribute('aria-pressed', String(!!on));
  if (chip) {
    chrome.storage.local.get('mcpBridgeOn').then(r => showChip(r.mcpBridgeOn)).catch(() => {});
    chip.addEventListener('click', async () => {
      await chrome.storage.local.set({studioSettingsOpenTab: 'mcp'});
      chrome.runtime.sendMessage({type: 'studio-open-settings'}).catch(() => {});
    });
  }
  // Settings turns the bridge on or off; react at once instead of waiting a minute.
  chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.mcpBridgeOn) { showChip(changes.mcpBridgeOn.newValue); quietUntil = 0; clearTimeout(timer); timer = setTimeout(poll, 500); } });
  // Support uses the identical allowlist, busy checks and live control validation.
  window.flowMcpBridge = {poll, run, setSettings: changes => setSettings(window.FlowBuilderUI || {}, {changes})};
  timer = setTimeout(poll, 3000);
})();
