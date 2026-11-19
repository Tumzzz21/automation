// Google Vids automation for the editor and account the user selects in Chrome.
const VIDS_HOME = 'https://docs.google.com/videos/u/0/';
let vidsHomeTabId = null;
let vidsHomeOpening = null;
let vidsRun = null;
let vidsStarting = false;

function reportVidsConnectionError(error) {
  $('vidsConnectionStatus').textContent = error.message;
}

async function openVidsEngine() {
  if (settings.platform !== 'vids' || running || vidsStarting) return;
  await openVidsHome();
}

// Owner 2026-11-14: with the Google Vids account switch on (vids-account-switch.js), Start opens the chosen account.
function vidsHomeUrl() {
  return (typeof window !== 'undefined' && window.vidsAccountSwitch?.homeUrl?.()) || VIDS_HOME;
}

// The account switch has opened the next account's home page in this tab; the next Start opens a blank video there.
function useVidsHomeTab(id) {
  vidsHomeTabId = id;
}

function sameVidsAccount(rawUrl) {
  const sw = typeof window !== 'undefined' ? window.vidsAccountSwitch : null;
  return !sw?.homeUrl?.() || sw.accountOf(rawUrl) === sw.accountOf(vidsHomeUrl());
}

function openVidsHome() {
  if (vidsHomeOpening) return vidsHomeOpening;
  vidsHomeOpening = (async () => {
    const home = vidsHomeUrl();
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const existing = tabs.find(tab => (tab.pendingUrl || tab.url) === home);
    const tab = existing
      ? await chrome.tabs.update(existing.id, { active: true })
      : await chrome.tabs.create({ url: home, active: true });
    vidsHomeTabId = tab.id;
    $('vidsConnectionStatus').textContent = 'Sign in if Google prompts you. Start generation will open a blank video.';
    return tab;
  })().finally(() => { vidsHomeOpening = null; });
  return vidsHomeOpening;
}

function isVidsHome(rawUrl) {
  return /^https:\/\/docs\.google\.com\/videos(?:\/u\/\d+)?\/?(?:[?#].*)?$/.test(rawUrl || '');
}

// With pointOnly the tile is not clicked: its centre is returned for a real (CDP) click. Owner test 2026-11-14: the
// "+" tile ignored a script click, so the editor never opened.
function pg_clickVidsBlankVideo(pointOnly = false) {
  if (location.origin !== 'https://docs.google.com' || !/^\/videos(?:\/u\/\d+)?\/?$/.test(location.pathname)) return false;
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible';
  const enabled = element => visible(element) && !element.closest(':disabled,[aria-disabled="true"],[inert]');
  const buttons = 'button,[role="button"]';
  const name = element => normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
  // The "+" tile is a role="option" templateview inside a listbox that carries the same name; take the tile itself
  // (innermost), because a click in the middle of the wide listbox lands on empty space (owner test 2026-11-14).
  const named = [...document.querySelectorAll(`${buttons},[role="option"],.docs-homescreen-templates-templateview`)]
    .filter(element => /^blank vid(?:eo)?$/.test(name(element)) && enabled(element));
  let button = named.find(element => !named.some(other => other !== element && element.contains(other)));
  if (!button) {
    const headings = 'h1,h2,h3,h4,[role="heading"],.docs-homescreen-templates-header,div,span';
    const heading = [...document.querySelectorAll(headings)].find(element =>
      visible(element) && normalize(element.textContent) === 'start a new video');
    for (let section = heading?.parentElement; section && section !== document.body; section = section.parentElement) {
      if ([...section.querySelectorAll(headings)].some(element => /^recent videos$/.test(normalize(element.textContent)))) break;
      const tiles = 'a[href],.docs-homescreen-templates-templateview,[tabindex="0"]';
      const controls = [...section.querySelectorAll(`${buttons},${tiles}`)].filter(enabled);
      const candidates = controls.filter(element => !controls.some(other => other !== element && other.contains(element)) &&
        /^(?:\+|blank(?: vid(?:eo)?)?|(?:new|(?:start|create)(?: a)? new) video)?$/.test(name(element)));
      if (candidates.length === 1) button = candidates[0];
      if (candidates.length) break;
    }
  }
  if (!button) return false;
  if (pointOnly) {
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }
  button.click();
  return true;
}

// Real mouse click first; a script click only when the debugger cannot attach (for example DevTools is open).
async function clickVidsBlankVideo(tab) {
  if (!(await exec(tab.id, pg_clickVidsBlankVideo, [true]))) return false;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  try {
    return await flowCdpClick(tab.id, 0, 0, false, () => exec(tab.id, pg_clickVidsBlankVideo, [true]));
  } catch {
    return !!(await exec(tab.id, pg_clickVidsBlankVideo));
  }
}

async function openBlankVidsEditor(isCurrent) {
  const home = vidsHomeOpening ? await vidsHomeOpening
    : Number.isInteger(vidsHomeTabId) ? await chrome.tabs.get(vidsHomeTabId).catch(() => null) : null;
  const target = home && !vidsDocumentKey(home.url) && sameVidsAccount(home.url) ? home : await openVidsHome();
  for (let attempt = 0; attempt < 30 && isCurrent(); attempt++) {
    const tab = await chrome.tabs.get(target.id);
    if (!isCurrent()) return;
    if (tab.status === 'complete' && tab.url) {
      if (!isVidsHome(tab.url)) throw new Error('Open Google Vids and finish signing in, then press Start generation again.');
      const tabsBeforeClick = await chrome.tabs.query({ windowId: tab.windowId });
      if (!isCurrent()) return;
      if (await clickVidsBlankVideo(tab)) {
        const existingIds = new Set(tabsBeforeClick.map(candidate => candidate.id));
        $('vidsConnectionStatus').textContent = 'Opening a blank Google Vids editor…';
        for (let poll = 0; poll < 90 && isCurrent(); poll++) {
          const tabs = await chrome.tabs.query({ windowId: tab.windowId });
          const editor = tabs.find(candidate => (candidate.id === tab.id ||
            (candidate.openerTabId === tab.id && !existingIds.has(candidate.id))) &&
            candidate.status === 'complete' && vidsDocumentKey(candidate.url));
          if (editor && isCurrent()) return editor;
          // Still on the home page after 10 s: the click did not land, so try once more with a script click.
          if (poll === 20 && isVidsHome((await chrome.tabs.get(tab.id).catch(() => null))?.url)) await exec(tab.id, pg_clickVidsBlankVideo).catch(() => {});
          await sleep(500);
        }
        if (isCurrent()) throw new Error('The blank Google Vids editor did not finish opening. Return to Google Vids and try again.');
        return;
      }
    }
    await sleep(500);
  }
  if (isCurrent()) throw new Error('Google Vids did not show Blank video or the Start a new video tile. Check that the home page is loaded and signed in.');
}

function vidsQueueIssues() {
  const reject = message => [{ level: 'error', hard: true, message }];
  const items = queue.filter(item => item.status === 'pending' && !item.groupParent);
  if (!VIDS_PANEL_MODES.includes(settings.mode)) return reject('Choose a Google Vids mode.');
  if (!items.length) return reject('Load an unfinished prompt first.');
  if (queue.some(item => item.status === 'combined') ||
      items.some(item => /-concat$/.test(item.videoMode || ''))) {
    return reject('Use a queue without Concat for Google Vids.');
  }
  // AI Story videos (owner 2026-11-14): scene clips only; story images still come from the image engines.
  if (items.some(item => item.builderProjectId && (!item.builderSceneId || settings.mode === 'text-to-image'))) {
    return reject('Google Vids makes AI Story videos only. Choose another engine for the story images.');
  }
  const lengths = new Set(items.filter(item => item.builderSceneId).map(item => Number(item.builderDurationSeconds)));
  if (lengths.size > 1 || (lengths.size === 1 && ![...lengths].every(n => n === Number(settings.vidsDurationSeconds)))) {
    return reject('Every AI Story scene must use the Google Vids video length (' + settings.vidsDurationSeconds + 's). Load the story videos again.');
  }
  if (items.some(item => !String(item.text || '').trim())) return reject('Every Vids queue item needs a prompt.');
  return [];
}

function mainVidsReferences(item, mode) {
  if (item.vidsPending || !MODES[mode].needsImages) return [];
  const names = images.map(file => file.name);
  if (mode === 'ingredients-to-video' && settings.autoMatchIngredientImages !== false) {
    const missing = P().missingImageMentions(item.text, names);
    if (missing.length) throw new Error('Upload the missing Vids references: ' + missing.join(', '));
  }
  if (item.imageName && P().matchImageByName(item.imageName, names) < 0) throw new Error('Upload ' + item.imageName + ' before starting.');
  const selected = imagesForItem({ ...item, groupMemberIds: null });
  const files = mode === 'frame-to-video' ? selected.slice(0, 1) : selected;
  if (!files.length || files.length > 7) throw new Error('Prompt ' + item.index + ' needs ' +
    (mode === 'frame-to-video' ? 'one start frame.' : 'one to seven ingredients.'));
  if (files.some(file => !/^data:image\/(png|jpeg);base64,/i.test(file.dataUrl))) throw new Error('Use PNG or JPEG references in Google Vids.');
  return files;
}

async function startMainVidsQueue() {
  if (vidsStarting || running || activeRuns.size) return;
  const issue = vidsQueueIssues()[0];
  if (issue) throw new Error(issue.message);
  const mode = settings.mode;
  const items = queue;
  const pending = items.filter(item => item.status === 'pending' && !item.groupParent);
  const saved = items.find(item => item.vidsPending);
  if (saved && (saved !== pending[0] || saved.vidsPending.mode !== mode)) {
    throw new Error('Select the original Google Vids mode and retry the submitted result first.');
  }
  const references = new Map(pending.map(item => [item.id, mainVidsReferences(item, mode)]));
  const videoSettings = mode === 'text-to-image' ? null : {
    model: settings.vidsVideoModel || 'Omni',
    aspect: settings.vidsAspectRatio || 'landscape',
    resolution: settings.vidsResolution || '720p',
    duration: settings.vidsDurationSeconds ?? 10,
  };
  const isCurrent = () => !running && !activeRuns.size && queue === items &&
    settings.platform === 'vids' && settings.mode === mode &&
    pending.every(item => items.includes(item) && item.status === 'pending');
  vidsStarting = true;
  try {
    // Background mode (owner 2026-11-14): the shared Vids video tab is used as it is, without opening a new blank
    // video or bringing the tab to the front; sharing keeps it running while another tab is on top.
    const sharedId = !saved && typeof getBackgroundFlowTabId === 'function' ? getBackgroundFlowTabId() : null;
    const sharedTab = sharedId != null ? await chrome.tabs.get(sharedId).catch(() => null) : null;
    const shared = sharedTab && vidsDocumentKey(sharedTab.url) &&
      (typeof confirmBackgroundTab !== 'function' || await confirmBackgroundTab(sharedTab.id)) ? sharedTab : null;
    if (shared) log('Background mode: using the shared Google Vids video; it can stay behind other tabs.');
    const tab = saved ? await chrome.tabs.get(saved.vidsPending.tabId).catch(() => null)
      : shared || await openBlankVidsEditor(isCurrent);
    if (!isCurrent()) return;
    const key = vidsDocumentKey(tab?.url);
    if (!key || (saved && key !== saved.vidsPending.key)) {
      throw new Error('Reopen the original Google Vids editor to recover the submitted result.');
    }
    const binding = { tabId: tab.id, key, mode, account: saved?.vidsPending.account };
    const background = typeof backgroundModeActiveFor === 'function' && backgroundModeActiveFor(binding.tabId);
    if (settings.openTabWhileGenerating !== false && !background) await chrome.tabs.update(binding.tabId, { active: true });
    const { account } = await inspectVids(binding);
    if (!account) throw new Error('Sign in to Google Vids, then press Start generation again.');
    if (!isCurrent()) return;
    binding.account = account;
    if (saved) binding.settings = saved.vidsPending.settings;
    else {
      const prepared = await prepareVids(binding);
      if (!isCurrent()) return;
      binding.settings = videoSettings ? await applyVidsVideoSettings(binding, videoSettings, isCurrent) : prepared.settings;
    }
    if (!isCurrent()) return;
    $('vidsConnectionStatus').textContent = 'Connected to ' + (tab.title || 'Google Vids');
    slotTabs.clear();
    slotTabs.set(0, binding.tabId);
    for (const item of pending) {
      item.retryAt = null;
      item.groupMemberIds = null;
    }
    vidsRun = { ...binding, references };
    stopRequested = false;
    quotaStop = false;
    quotaSolo = false;
    queueStopReason = '';
    chainedFrame = null;
    running = true;
    renderPreflight([]);
    $('applyStatus').textContent = binding.settings;
    setRunState('Google Vids running', 'status-ok');
    renderQueue();
    mainLoop(++runToken).catch(error => {
      running = false;
      setRunState('stopped', 'status-bad');
      $('applyStatus').textContent = error.message;
      renderQueue();
    });
  } finally {
    vidsStarting = false;
  }
}

function runMainVidsPrompt(item, _slot, token) {
  if (!vidsRun) throw new Error('Connect a Vids editor and start the queue first.');
  return runVidsPrompt(item, token, vidsRun);
}

function vidsDocumentKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.match(/^\/videos\/(?:u\/\d+\/)?d\/[\w-]+\/edit\/?$/);
    return url.origin === 'https://docs.google.com' && path
      ? `${url.pathname.replace(/\/$/, '')}|${url.searchParams.get('authuser') ?? ''}` : '';
  } catch {
    return '';
  }
}

function vidsMediaSource(rawUrl, image = false) {
  try {
    const url = new URL(rawUrl);
    if (image && /^data:image\/(?:png|jpeg|webp);base64,/i.test(rawUrl)) return { src: rawUrl, host: 'Vids image' };
    if (image && url.protocol === 'blob:' && url.origin === 'https://docs.google.com') return { src: url.href, host: 'Vids image' };
    if (image && url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        /(?:^|\.)(?:googleusercontent\.com|usercontent\.google\.com|gstatic\.com|ggpht\.com)$/.test(url.hostname)) {
      return { src: url.href, host: url.hostname };
    }
    if (!image && url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        /^contribution-[\w-]+\.usercontent\.google\.com$/.test(url.hostname) &&
        url.pathname === '/download' && /\.mp4$/i.test(url.searchParams.get('filename') || '')) {
      return { src: url.href, host: url.hostname };
    }
  } catch { /* Invalid or incomplete preview source. */ }
  return null;
}

// Injected as a self-contained function. Only inspect the Vids UI and its media element.
function pg_vidsInspect(action, binding, expectedPrompt = '', files = []) {
  const visible = element => !!element && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible';
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const label = element => normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText);
  const unique = (root, selector, predicate = () => true) => {
    const matches = Array.from(root.querySelectorAll(selector)).filter(node => visible(node) && predicate(node));
    return matches.length === 1 ? matches[0] : null;
  };
  const point = element => {
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  };
  const account = unique(document, '#docs-chrome [aria-label^="Google Account:"],#docs-chrome [title^="Google Account:"]');
  const accountLabel = account && label(account);
  const url = new URL(location.href);
  const key = `${url.pathname.replace(/\/$/, '')}|${url.searchParams.get('authuser') ?? ''}`;
  if (url.origin !== 'https://docs.google.com' || key !== binding.key || !accountLabel ||
      (binding.account && binding.account !== accountLabel)) return { wrongTarget: true };
  // A new video opens with Vids' "Getting started" picker, and promo bubbles ("Reimagine your video") can cover the AI
  // video panel (owner test 2026-11-14). Close them with their own Close button. Never the side sheet or a dialog that
  // holds fields, sliders or lists (settings).
  if (action === 'dismiss') {
    const popups = [...document.querySelectorAll('[aria-label="Getting started"],.getting-started-dialog,[role="dialog"]')]
      .filter(node => visible(node) && !node.closest('[role="complementary"]') &&
        (node.matches('[aria-label="Getting started"],.getting-started-dialog') ||
          !node.querySelector('textarea,input,[contenteditable="true"],[role="slider"],[role="listbox"],[role="menu"]:not([aria-hidden="true"])')));
    for (const popup of popups) {
      const close = [...popup.querySelectorAll('button,[role="button"]')].find(node => visible(node) && /^close$/i.test(node.getAttribute('aria-label') || ''));
      const at = point(close);
      if (at) return { account: accountLabel, point: at };
    }
    return { account: accountLabel, point: null };
  }
  const image = binding.mode === 'text-to-image';
  const frame = binding.mode === 'frame-to-video';
  const rail = document.getElementById(image ? 'content-library-rail-image-synthesis-element' : 'content-library-rail-video-generation-element');
  const buttons = 'button,[role="button"]';
  const sheet = image ? (() => {
    const heading = unique(document, 'h1,h2,h3,[role="heading"]', node => normalize(node.textContent) === 'Generate an image');
    for (let parent = heading?.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (unique(parent, 'textarea,[contenteditable="true"]') && unique(parent, buttons, node => /^(?:Create|Creating\.{3}|Creating…)$/i.test(label(node)))) return parent;
    }
    return null;
  })() : unique(document, '[role="complementary"][aria-roledescription="side sheet"]', node => {
    const heading = document.getElementById(node.getAttribute('aria-labelledby'));
    return /^AI video clip$/i.test(normalize(heading?.textContent));
  });
  if (!sheet) return { account: accountLabel, point: action === 'rail' ? point(rail) : null };

  const modeControls = `[role="tab"],${buttons},[aria-pressed],[role="radio"]`;
  const modeName = (node, name) => [label(node), normalize(node.innerText)].includes(name);
  const modeRow = node => {
    for (let row = node.parentElement; row && row !== sheet; row = row.parentElement) {
      if (['Create', 'Animate', 'Extend'].every(name => unique(row, modeControls, control => modeName(control, name)))) return row;
    }
    return null;
  };
  const desiredMode = frame ? 'Animate' : 'Create';
  const create = unique(sheet, '[role="tab"]', node => modeName(node, desiredMode)) ||
    (!image && unique(sheet, modeControls, node => modeName(node, desiredMode) && !!modeRow(node)));
  const panel = image ? sheet : unique(sheet, '[role="tabpanel"]', node => {
    return node.getAttribute('aria-labelledby') === create?.id ||
      (create?.id && node.id === create.getAttribute('aria-controls'));
  }) || unique(sheet, '[role="tabpanel"]');
  const createSelected = image || ['aria-selected', 'aria-pressed', 'aria-checked'].some(attr => create?.getAttribute(attr) === 'true') ||
    (panel?.getAttribute('aria-labelledby') === create?.id && !!create?.id);
  // The prompt box's Expand/Collapse button. Its id changes between loads (elptr_35, elptr_36 in the owner's test
  // 2026-11-14, when scene 2 stopped folded), so find it by its component class or exact label.
  const liveToggle = [...sheet.querySelectorAll('[data-idom-class*="collapsiblePromptBoxToggleExpansionButton"],button[aria-label="Expand"],button[aria-label="Collapse"]')]
    .find(visible) || document.getElementById('elptr_35');
  const collapsed = !image && visible(liveToggle) && sheet.contains(liveToggle) && label(liveToggle) === 'Expand';
  const editor = !collapsed && createSelected && panel && unique(panel, 'textarea,[contenteditable="true"]', node => {
    return !node.parentElement?.closest('[contenteditable="true"]');
  });
  if (action === 'open-prompt') {
    if (editor || image || frame) return { account: accountLabel, point: null };
    const startsPrompt = text => /^Describe your video(?:[.\s]|$)/i.test(normalize(text));
    const previews = [...sheet.querySelectorAll('textarea,[role="textbox"],[placeholder],button,[role="button"],div,span,p')]
      .filter(node => visible(node) && [node.getAttribute('placeholder'), node.getAttribute('aria-placeholder'),
        node.getAttribute('aria-label'), node.innerText].some(startsPrompt));
    const leaves = previews.filter(node => !previews.some(other => other !== node && node.contains(other)));
    const previewPoint = leaves.length === 1 ? point(leaves[0]) : null;
    return { account: accountLabel, point: previewPoint };
  }
  if (action === 'expand' || action === 'activate-expand') {
    if (editor) return { account: accountLabel };
    const expandName = /^(?:expand\b|show (?:the )?(?:prompt|composer)\b|chevron_up$|keyboard_arrow_up$|expand_less$)/i;
    const toggles = `${buttons},[aria-expanded="false"],[tabindex="0"],[data-tooltip],[aria-describedby],[role="switch"]`;
    const descriptions = node => [node.getAttribute('aria-labelledby'), node.getAttribute('aria-describedby')]
      .filter(Boolean).join(' ').split(/\s+/).map(id => document.getElementById(id)?.textContent);
    const isExpand = node => typeof node.click === 'function' && node.getAttribute('aria-expanded') !== 'true' &&
      [label(node), node.getAttribute('title'), node.getAttribute('data-tooltip'), ...descriptions(node)]
        .some(name => expandName.test(normalize(name)));
    const named = visible(liveToggle) && sheet.contains(liveToggle) && isExpand(liveToggle)
      ? liveToggle : unique(sheet, toggles, isExpand);
    if (action === 'activate-expand') {
      const activated = !!named && !named.disabled && named.getAttribute('aria-disabled') !== 'true';
      if (activated) named.click();
      return { account: accountLabel, activated };
    }
    const namedPoint = point(named);
    if (namedPoint) return { account: accountLabel, point: namedPoint };
    // Some versions render an unlabeled chevron next to the video mode tabs.
    for (let row = create && modeRow(create); row && row !== sheet; row = row.parentElement) {
      const expand = unique(row, toggles, node => {
        if (node.closest('[role="tab"]') || ['Create', 'Edit', 'Animate', 'Extend'].some(name => modeName(node, name)) ||
            node.getAttribute('aria-expanded') === 'true') return false;
        return node.getAttribute('aria-expanded') === 'false' || (!label(node) && !node.getAttribute('data-tooltip'));
      });
      const expandPoint = point(expand);
      if (expandPoint) return { account: accountLabel, point: expandPoint };
      if (row === panel) break;
    }
    return { account: accountLabel, point: null };
  }
  const settingsButton = unique(sheet, buttons, node => /^Generation settings:/i.test(label(node)));
  const settingsLabel = image ? 'Vids image generator' : settingsButton && label(settingsButton);
  if (action === 'video-settings') {
    const wanted = expectedPrompt;
    const controls = 'button,[role="button"],[role="combobox"],[role="listbox"],[aria-haspopup],[tabindex="0"]';
    const names = node => [label(node), normalize(node.innerText), normalize(node.getAttribute('title')),
      normalize(document.getElementById(node.getAttribute('aria-labelledby'))?.textContent)];
    const matchesName = (node, pattern) => names(node).some(name => pattern.test(name));
    const durationLabels = [...document.querySelectorAll('label,div,span')].filter(node =>
      visible(node) && /^video duration$/i.test(normalize(node.innerText)));
    let popover = durationLabels.find(node => !durationLabels.some(other => other !== node && node.contains(other)))?.parentElement;
    while (popover && popover !== document.body && !(/\bResolution\b/i.test(popover.innerText || '') &&
      /\bAspect ratio\b/i.test(popover.innerText || '') && /\bVideo model\b/i.test(popover.innerText || ''))) {
      popover = popover.parentElement;
    }
    if (popover === document.body) popover = null;
    const controlPoint = (root, selector, predicate) => {
      const candidates = [...root.querySelectorAll(selector)].filter(node => visible(node) && predicate(node));
      const outer = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
      return outer.length === 1 ? point(outer[0]) : null;
    };
    const response = { account: accountLabel, settings: settingsLabel, open: !!popover };
    if (!popover) return { ...response, point: point(settingsButton) };
    if (!wanted.field) return response;
    if (wanted.field === 'aspect') {
      const pattern = wanted.value === 'portrait' ? /\bportrait\b|9\s*:\s*16/i : /\blandscape\b|16\s*:\s*9/i;
      return { ...response, point: controlPoint(popover, `${controls},[role="radio"],[role="option"],[aria-pressed]`,
        node => matchesName(node, pattern) && !matchesName(node, /landscape.*portrait|portrait.*landscape/i)) };
    }
    if (wanted.field === 'duration') {
      const slider = unique(popover, '[role="slider"],input[type="range"]');
      if (!slider) return response;
      const valueText = slider.getAttribute('aria-valuetext') || '';
      const seconds = valueText.match(/^(\d+)\s*(?:s(?:ec(?:ond)?s?)?)?$/i)?.[1];
      const rawMin = slider.getAttribute('aria-valuemin') ?? slider.min;
      const rawMax = slider.getAttribute('aria-valuemax') ?? slider.max;
      const rawNow = slider.getAttribute('aria-valuenow') ?? slider.value;
      const now = seconds ? Number(seconds) : Number(rawMin) === 3 && rawNow != null ? Number(rawNow) : null;
      if (wanted.focus && slider.getAttribute('aria-disabled') !== 'true' && !slider.disabled) slider.focus();
      return { ...response, duration: now, focused: slider.contains(document.activeElement),
        maximum: Number(rawMin) === 3 && rawMax ? Number(rawMax) : null };
    }
    const fieldLabel = wanted.field === 'model' ? 'Video model' : 'Resolution';
    if (wanted.menu) {
      const options = '[role="option"],[role="menuitem"],[role="menuitemradio"],.goog-menuitem';
      const wantedName = node => names(node).some(value => value.toLowerCase() === wanted.value.toLowerCase());
      const menu = unique(document, '[role="menu"],[role="listbox"]', node => !!node.querySelector(options));
      return { ...response, point: controlPoint(menu || document, options, wantedName) ||
        (menu && controlPoint(menu, controls, wantedName)) };
    }
    const namedTrigger = controlPoint(popover, controls, node => names(node).some(value => value.toLowerCase() === fieldLabel.toLowerCase()));
    const currentTrigger = wanted.current && controlPoint(popover, controls, node => names(node).some(value =>
      value.toLowerCase() === wanted.current.toLowerCase()));
    return { ...response, point: currentTrigger || namedTrigger };
  }
  const generate = unique(sheet, buttons, node => label(node) === (image ? 'Create' : 'Generate'));
  const attachmentControls = panel ? Array.from(panel.querySelectorAll(buttons)).filter(node => visible(node) &&
    /^Remove (?:image|ingredient|reference|uploaded image|attachment)\b/i.test(label(node))) : [];
  const attach = panel && unique(panel, buttons, node => frame ? label(node) === 'Add image' : /^(?:Add )?Ingredients$/i.test(label(node)));
  const addingIngredient = !image && !frame && attachmentControls.length > 0;
  const addIngredient = addingIngredient && unique(panel, buttons, node => label(node) === 'Add avatar or ingredients');
  if (action === 'add-ingredient') {
    return { account: accountLabel, point: editor && settingsLabel === binding.settings ? point(addIngredient) : null };
  }
  if (action === 'upload') {
    if (!files.length || !editor || settingsLabel !== binding.settings) return { account: accountLabel, uploaded: false };
    const menuControls = `${buttons},[role="menuitem"],[tabindex="0"]`;
    const uploadControl = addingIngredient
      ? unique(document, menuControls, node => label(node) === 'Upload' && !!point(node))
      : attach;
    if (!uploadControl) return { account: accountLabel, waitingForUpload: addingIngredient, uploaded: false };
    const selector = 'input[type="file"]:not([disabled])';
    const localInputs = Array.from(panel.querySelectorAll(selector));
    let input = null;
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    const deliver = target => {
      if (!target || target.type !== 'file' || target.disabled) return;
      target.files = transfer.files;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      input = target;
    };
    if (!addingIngredient && localInputs.length === 1) {
      deliver(localInputs[0]);
    } else {
      // Capture only the file input invoked synchronously by this specific Vids control.
      const proto = HTMLInputElement.prototype;
      const original = proto.click;
      const originalPicker = proto.showPicker;
      const intercept = function () { if (this.type === 'file') deliver(this); };
      try {
        proto.click = intercept;
        if (originalPicker) proto.showPicker = intercept;
        uploadControl.click();
      } finally {
        proto.click = original;
        if (originalPicker) proto.showPicker = originalPicker;
      }
    }
    return { account: accountLabel, uploaded: !!input };
  }
  const results = Array.from(sheet.querySelectorAll('[data-generation-id]'));
  const prompt = normalize(expectedPrompt);
  const ready = results.flatMap(card => {
    const video = card.querySelector('video[aria-label^="Generated video:"]');
    const source = video?.currentSrc || video?.getAttribute('src');
    const description = normalize(video?.getAttribute('aria-label')).replace(/^Generated video:\s*/i, '');
    const compact = value => value.replace(/\s/g, '');
    if (!source || !prompt || !compact(description).startsWith(`${compact(prompt)},`)) return [];
    return [{ id: card.dataset.generationId, source }];
  });
  const imageCells = image ? Array.from(sheet.querySelectorAll('[id^="goog-palette-cell-"]')) : [];
  const imageResults = imageCells.flatMap(cell => {
    const descriptions = [cell, ...cell.querySelectorAll('[aria-label],[title]')].map(node =>
      normalize(node.getAttribute('aria-label') || node.getAttribute('title')));
    if (!prompt || !descriptions.some(description => description.startsWith(`Create image, ${prompt},`))) return [];
    const picture = cell.querySelector('img[src],img[srcset]');
    const painted = [cell, ...cell.querySelectorAll('[style]')].find(node => node.style.backgroundImage.startsWith('url('));
    const source = picture?.currentSrc || picture?.getAttribute('src') ||
      painted?.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    return source ? [{ id: cell.id, source }] : [];
  });
  const progress = Array.from(sheet.querySelectorAll('[role="progressbar"],progress,[id^="progress-percentage-"]')).find(visible);
  const percent = progress?.getAttribute('aria-valuenow');
  const text = normalize(sheet.innerText);
  const rejections = (text.match(/\bthat request looks like it goes against our terms\b/gi) || []).length;
  const quota = /(?:hit|reached|exceeded|used up)\b.{0,65}\b(?:limit|quota)|(?:limit|quota)\b.{0,35}\b(?:reached|exceeded)|no (?:video )?generations? (?:left|remaining)/i.test(text);
  const failed = /couldn.t generate|failed to generate|generation failed|couldn.t create (?:your|this|the) (?:video|clip)/i.test(text);
  const busy = !!progress || /Bringing your vision to life|\b(?:Generating|Creating)(?:\.{3}|…)/i.test(text);
  const targets = {
    create: createSelected ? null : create,
    editor,
    remove: attachmentControls[0],
    generate: !busy && prompt && settingsLabel === binding.settings && attachmentControls.length === (binding.referenceCount || 0) &&
      normalize(editor?.value ?? editor?.innerText) === prompt ? generate : null,
  };
  return {
    account: accountLabel, sheet: true, editor: !!editor, settings: settingsLabel,
    editorFocused: !!editor && editor.contains(document.activeElement),
    prompt: normalize(editor?.value ?? editor?.innerText),
    ids: image ? imageCells.map(cell => cell.id) : results.map(card => card.dataset.generationId),
    ready: image ? imageResults : ready, busy, attachments: attachmentControls.length,
    percent: percent != null && Number.isFinite(Number(percent)) ? Number(percent) : null,
    quota, failed, rejections, point: point(targets[action]),
  };
}

async function inspectVids(binding, action = '', prompt = '', files = []) {
  const state = await exec(binding.tabId, pg_vidsInspect, [action, binding, prompt, files], action === 'upload' ? 'MAIN' : undefined);
  // No quota check — always allow
  return state;
}

async function prepareVids(binding) {
  const triedActions = new Set();
  let dismissed = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (dismissed < 4) {
      const popup = await inspectVids(binding, 'dismiss');
      if (popup.point) {
        dismissed++;
        await flowCdpClick(binding.tabId, popup.point.x, popup.point.y, false,
          async () => (await inspectVids(binding, 'dismiss')).point);
        await sleep(450);
        continue;
      }
    }
    const state = await inspectVids(binding);
    if (state.busy) throw new Error('Google Vids is already generating a clip. Wait for it to finish.');
    if (state.editor && state.settings) return state;
    // Expand the composer before changing modes. Clicking an already selected tab
    // can leave the composer collapsed when its selection markup is still loading.
    const actions = state.sheet ? ['expand', 'activate-expand', 'create', 'open-prompt'] : ['rail'];
    const available = actions.filter(action => !triedActions.has(action));
    const candidates = [...available, ...actions.filter(action => triedActions.has(action))];
    for (const action of candidates) {
      const { point, activated } = await inspectVids(binding, action);
      if (activated) {
        triedActions.add(action);
        break;
      }
      if (!point) continue;
      const clicked = await flowCdpClick(binding.tabId, point.x, point.y, false,
        async () => (await inspectVids(binding, action)).point);
      triedActions.add(action);
      if (clicked === false) continue;
      break;
    }
    await sleep(450);
  }
  const panel = binding.mode === 'text-to-image' ? 'Generate an image' : binding.mode === 'frame-to-video' ? 'AI Video → Animate' : 'AI Video → Create';
  throw new Error(`Open ${panel} in Google Vids and expand its prompt box.`);
}

function readVidsVideoSettings(label) {
  const parts = String(label || '').replace(/^Generation settings:\s*/i, '').split(/\s*[,•·]\s*/);
  const text = parts.join(' ');
  return {
    model: parts[0],
    resolution: text.match(/\b(?:720|1080)p\b/i)?.[0].toLowerCase(),
    aspect: text.match(/\b(?:portrait|landscape)\b/i)?.[0].toLowerCase() ||
      (/9\s*:\s*16/.test(text) ? 'portrait' : /16\s*:\s*9/.test(text) ? 'landscape' : null),
    duration: Number(text.match(/\b(\d{1,2})\s*(?:s|sec(?:ond)?s?)\b/i)?.[1]),
  };
}

async function sendVidsDurationKey(tabId, increase) {
  const target = { tabId };
  let attached = false;
  try { await chrome.debugger.attach(target, '1.3'); attached = true; }
  catch (error) { if (!/another debugger|already attached/i.test(String(error?.message || error))) throw error; }
  const key = increase ? 'ArrowRight' : 'ArrowLeft';
  const code = increase ? 39 : 37;
  try {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      });
    }
  } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
}

async function applyVidsVideoSettings(binding, wanted, isCurrent) {
  const inspect = (request = {}) => inspectVids(binding, 'video-settings', request);
  const click = async state => {
    if (!isCurrent() || !state.point) return false;
    await flowCdpClick(binding.tabId, state.point.x, state.point.y);
    await sleep(300);
    return true;
  };
  const fields = ['model', 'resolution', 'aspect', 'duration'];
  const fieldNames = { model: 'Video model', resolution: 'Resolution', aspect: 'Aspect ratio', duration: 'Video duration' };
  const matches = state => {
    const actual = readVidsVideoSettings(state.settings);
    return fields.every(field => actual[field] === wanted[field]);
  };
  let state = await inspect();
  let issue = '';
  if (!matches(state)) {
    for (const field of fields) {
      if (!isCurrent()) return;
      const current = readVidsVideoSettings(state.settings)[field];
      if (current === wanted[field]) continue;
      const request = { field, value: wanted[field], current: String(current || '') };
      if (!state.open) {
        if (await click(state)) {
          for (let attempt = 0; attempt < 5 && isCurrent(); attempt++) {
            state = await inspect();
            if (state.open) break;
            await sleep(150);
          }
        }
      }
      if (!state.open) { issue = 'The video settings popover could not be located.'; break; }
      if (field === 'duration') {
        for (let step = 0; step < 12 && isCurrent(); step++) {
          const slider = await inspect({ ...request, focus: true });
          const seconds = slider.duration ?? readVidsVideoSettings(slider.settings).duration;
          if (seconds === wanted.duration || !slider.focused || !Number.isFinite(seconds) ||
              (slider.maximum && wanted.duration > slider.maximum) || !isCurrent()) break;
          await sendVidsDurationKey(binding.tabId, seconds < wanted.duration);
          await sleep(120);
        }
      } else {
        if (!(await click(await inspect(request)))) {
          issue = `${fieldNames[field]} control could not be located or clicked.`;
          break;
        }
        if (field !== 'aspect' && !(await click(await inspect({ ...request, menu: true })))) {
          issue = `${fieldNames[field]} option ${wanted[field]} could not be located or clicked.`;
          break;
        }
      }
      state = await inspect();
      if (readVidsVideoSettings(state.settings)[field] !== wanted[field]) {
        issue = `${fieldNames[field]} did not change to ${wanted[field]}.`;
        break;
      }
    }
  }
  if (!isCurrent()) return;
  if (state.open) {
    await flowCdpEscape(binding.tabId);
    await sleep(250);
    state = await inspect();
  }
  if (state.open || !matches(state)) {
    throw new Error(`Google Vids could not confirm ${wanted.model}, ${wanted.resolution}, ${wanted.aspect}, ${wanted.duration}s. ${issue || (state.open ? 'The settings popover is still open.' : '')} The editor reports ${state.settings || 'no video settings'}.`);
  }
  return state.settings;
}

async function setVidsReferences(binding, references, token) {
  let state = await inspectVids(binding);
  for (let attempt = 0; state.attachments && attempt < 7; attempt++) {
    assertRunActive(token);
    const { point } = await inspectVids(binding, 'remove');
    if (!point) break;
    await flowCdpClick(binding.tabId, point.x, point.y);
    await sleep(350);
    state = await inspectVids(binding);
  }
  if (state.attachments) throw new Error('Clear the existing references in the Vids composer before continuing.');
  for (const [index, image] of references.entries()) {
    assertRunActive(token);
    if (index > 0) {
      const { point } = await inspectVids(binding, 'add-ingredient');
      if (!point) throw new Error(`Google Vids did not show the Add button for ingredient ${index + 1}.`);
      assertRunActive(token);
      await flowCdpClick(binding.tabId, point.x, point.y);
    }
    const { b64, type } = dataUrlToB64(image.dataUrl);
    let result;
    for (let attempt = 0; attempt < (index > 0 ? 8 : 1); attempt++) {
      assertRunActive(token);
      result = await inspectVids(binding, 'upload', '', [{ name: image.name, type, base64: b64 }]);
      if (!result.waitingForUpload) break;
      await sleep(200);
    }
    if (!result?.uploaded) throw new Error(`Google Vids did not accept image ${index + 1} (${image.name}).`);
    const deadline = Date.now() + 30_000;
    do {
      assertRunActive(token);
      state = await inspectVids(binding);
      if (state.attachments === index + 1) break;
      await sleep(350);
    } while (Date.now() < deadline);
    if (state.attachments !== index + 1) throw new Error('Vids did not confirm the uploaded reference.');
  }
}

async function insertVidsPrompt(binding, prompt) {
  const target = { tabId: binding.tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const { point } = await inspectVids(binding, 'editor');
    if (!point) throw new Error('The Vids prompt editor is obscured.');
    const send = (method, args) => chrome.debugger.sendCommand(target, method, args);
    await cdpMouseClick(send, point.x, point.y);
    if (!(await inspectVids(binding)).editorFocused) throw new Error('The Vids prompt editor did not receive focus.');
    const modifiers = /Mac/.test(navigator.platform) ? 4 : 2;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.insertText', { text: prompt });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function runVidsPrompt(item, token, binding) {
  const prompt = String(item.text || '').trim();
  const image = binding.mode === 'text-to-image';
  const files = binding.references?.get(item.id) || [];
  const { references: _references, ...target } = binding;
  binding = { ...target, referenceCount: files.length };
  item.platform = 'vids';
  item.vidsRejected = false;
  item.attempts = (item.attempts || 0) + 1;
  item.retryAt = null;
  item.status = 'running';
  item.detail = item.vidsPending ? 'recovering submitted Vids clip' : 'preparing Google Vids';
  item.progressPercent = null;
  renderQueue();
  const handleRejection = async rejection => {
    const handled = typeof repairFailedPrompt === 'function' && await repairFailedPrompt(item, rejection, token);
    if (token !== runToken) return;
    const revised = String(item.text || '').trim() !== prompt;
    if (stopRequested || !handled || (item.status === 'pending' && !revised)) {
      item.status = 'error';
      item.retryAt = null;
      item.detail = stopRequested ? 'Google Vids rejected this request. Auto-Fix was stopped.'
        : 'Google Vids rejected this request under its terms. Review the prompt and reference images before retrying.';
    }
    item.vidsRejected = item.status === 'error';
    log(`${item.id}: ${item.detail}`);
    schedulePersist();
  };
  try {
    if (!item.vidsPending) {
      if (item.repairPendingError?.startsWith('Google Vids policy rejection:')) {
        if (item.repairPendingText === item.text) {
          await handleRejection(item.repairPendingError);
          return;
        }
        item.repairPendingError = null;
        item.repairPendingText = null;
      }
      const before = await prepareVids(binding);
      if (before.settings !== binding.settings) throw new Error('Omni settings changed during the run. Start again with the desired settings.');
      assertRunActive(token);
      if (!image && (before.attachments || files.length)) await setVidsReferences(binding, files, token);
      await insertVidsPrompt(binding, prompt);
      let submit;
      for (let attempt = 0; attempt < 12 && !submit?.point; attempt++) {
        assertRunActive(token);
        submit = await inspectVids(binding, 'generate', prompt);
        if (submit.busy) throw new Error('Vids started another generation before submission.');
        if (!submit.point) await sleep(250);
      }
      if (!submit?.point) throw new Error('Vids did not confirm the prompt, Omni settings, and Generate button.');
      assertRunActive(token);
      // Record before clicking so an uncertain click never causes an automatic duplicate.
      item.vidsPending = { ...binding, ids: submit.ids, hadFailure: !!submit.failed, rejectionsBefore: submit.rejections || 0 };
      await flowCdpClick(binding.tabId, submit.point.x, submit.point.y);
    }
    item.detail = 'waiting for Google Vids';
    const deadline = Date.now() + settings.maxWaitMinutes * 60_000;
    let source = null;
    while (Date.now() < deadline) {
      assertRunActive(token);
      const state = await inspectVids(binding, '', prompt);
      const rejections = state.rejections || 0;
      if (rejections < (item.vidsPending.rejectionsBefore || 0)) item.vidsPending.rejectionsBefore = rejections;
      if (!state.failed || state.busy) item.vidsPending.hadFailure = false;
      const result = (state.ready || []).filter(entry => !item.vidsPending.ids.includes(entry.id));
      if (!image && result.length > 1) throw new Error('Several new Vids clips matched the prompt.');
      if (result.length) {
        source = vidsMediaSource(result[0].source, image);
        if (!source) throw new Error('Vids returned an unrecognized media delivery URL.');
        break;
      }
      if (!state.busy && rejections > (item.vidsPending.rejectionsBefore || 0)) {
        item.vidsPending = null;
        item.progressPercent = null;
        await handleRejection('Google Vids policy rejection: That request looks like it goes against our terms.');
        return;
      }
      if (state.failed && !state.busy && !item.vidsPending.hadFailure) {
        item.vidsPending = null;
        throw new Error('Google Vids reported that the generation failed.');
      }
      item.progressPercent = state.percent;
      renderQueue();
      await sleep(1800);
    }
    if (!source) throw new Error('Vids did not return a matching result before the timeout. Use Retry errors and Start in Google Vids to check the same submission.');
    assertRunActive(token);
    item.detail = 'saving Vids clip';
    renderQueue();
    let bytes;
    try {
      bytes = await downloadMediaBuffer(binding.tabId, source, item.id);
    } catch {
      throw new Error('Chrome could not read the Vids result. Keep it open and retry to save the same result.');
    }
    assertRunActive(token);
    const valid = image ? P().bufferHasImageSignature(bytes) : P().bufferHasMp4Signature(bytes);
    if (!valid) throw new Error(`Vids returned bytes that could not be verified as ${image ? 'an image' : 'MP4'}.`);
    const saved = await saveOutput(item, bytes, image ? guessImageExt(bytes, '') : 'mp4', 'Google Vids');
    if (token !== runToken) return;
    item.vidsPending = null;
    item.status = 'done';
    item.outputName = saved.name;
    item.detail = `saved ${saved.name} → ${saved.where}`;
    if (typeof reportRepairOutcome === 'function') void reportRepairOutcome(item, { passed: true });
    log(`${item.id}: Google Vids result saved as ${saved.name}.`);
  } catch (error) {
    if (token !== runToken) return;
    item.status = stopRequested || error.quota ? 'pending' : 'error';
    item.detail = error.message;
    // At the limit no clip comes for this submission: forget it, so the account switch (or the next Start) opens a new video.
    if (error.quota) item.vidsPending = null;
    if (stopRequested) return;
    if (error.quota) quotaStop = true;
    stopRequested = true;
    queueStopReason = item.detail;
    $('applyStatus').textContent = item.detail;
    log(`${item.id}: ${item.detail}`);
  } finally {
    if (token === runToken) renderQueue();
  }
}
