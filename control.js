// control.js — Flow Automation engine. Runs inside control.html (an extension
// page, not a content script), so it has full access to:
//   - the File System Access API (structured project imports), and
//   - chrome.tabs / chrome.scripting / chrome.debugger (to drive Flow tabs).
//
// The pg_* functions are stringified and injected into the Flow page by
// chrome.scripting.executeScript. Each one must be fully self-contained
// (no closures over module state) and return JSON-serializable values.
//
// DOM knowledge is ported from Gemini Automation v3.2.5 (battle-tested against
// the live Flow UI) and extended with mode selection, image results, and
// download-resolution handling. Flow's visual UI can change; these page
// adapters are the compatibility points to update first.

// The panel shows the version of the copy that is actually loaded (read from manifest.json).
const APP_VERSION = (globalThis.chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'dev';
// A Flow project page for ANY signed-in Google account. Users with several accounts get "/u/<n>/" in the path
// (live reports, Oct 2026: flow.google.com/u/0/… and /u/4/… — Flow now adds it even for the first account); missing it
// greyed out Background Mode ("Choose Flow tab" stayed disabled) for every Flow user.
const FLOW_PROJECT_URL_RE = /^https:\/\/(?:flow\.google(?:\.com)?\/(?:u\/\d+\/)?project\/|labs\.google\/fx\/(?:[a-z]{2,3}(?:-[a-z0-9]+)?\/)?(?:u\/\d+\/)?tools\/flow\/(?:u\/\d+\/)?project\/)/i;

// Flow's result tile contains the whole prompt text; the queue card and the repair only need Flow's own warning sentence.
function summarizeFlowFailure(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const phrases = [
    /(?:we (?:noticed|detected) (?:some )?)?unusual activity[^.]*\.?/i,
    /this generation might violate our policies[^.]*\.?/i, /can[’']?t (?:make|create) videos? of real people[^.]*\.?/i,
    /violates? (?:our )?polic(?:y|ies)[^.]*\.?/i, /having a hard time fulfilling[^.]*\.?/i, /try a different prompt[^.]*\.?/i,
    /(?:could not|unable to) generate[^.]*\.?/i, /something went wrong[^.]*\.?/i, /(?:encountered|ran into) an error[^.]*\.?/i,
    /seem to be encountering an error[^.]*\.?/i, /can i (?:try something else for you|help you with something else)[^.]*\.?/i,
  ];
  for (const re of phrases) { const m = t.match(re); if (m) return m[0].trim().slice(0, 200); }
  return /\bfailed\b/i.test(t) ? 'generation failed' : (t.slice(0, 120) + (t.length > 120 ? '…' : ''));
}
const POLL_MS = 4000;
const BACKGROUND_WAKE_AFTER_MS = 90 * 1000;
const BACKGROUND_WAKE_INTERVAL_MS = 2 * 60 * 1000;
const MEDIA_WAKE_VISIBLE_MS = 3000;
const STORAGE_ROOT = 'faState';

const FLOW_SELECTORS = Object.freeze({
  editor: 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]',
  buttons: 'button',
  video: 'video',
  uploadInput: 'input[type="file"]',
  uploadDropTarget: '[data-testid*="drop" i], [aria-label*="drop" i], main, body',
});

const MODES = {
  'text-to-video': { label: 'Text to Video', flowMode: 'video', needsImages: false, resultKind: 'video' },
  'frame-to-video': { label: 'Frame to Video', flowMode: 'frames', needsImages: true, resultKind: 'video' },
  'ingredients-to-video': { label: 'Ingredients to Video', flowMode: 'ingredients', needsImages: true, resultKind: 'video' },
  'text-to-image': { label: 'Text to Image', flowMode: 'image', needsImages: false, resultKind: 'image' },
  'image-to-image': { label: 'Image to Image', flowMode: 'image', needsImages: true, resultKind: 'image' },
  'agent': { label: 'Agent Automation', flowMode: 'agent', needsImages: false, resultKind: 'video' },
};

function mobileOverlayDevice() {
  return typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
}

// Phone browsers (Quetta, finding G 2026-10-31) freeze background tabs, so the queue stalled the moment the user
// switched to the Flow tab. Active playback helped in physical Quetta tests; while a run is live the
// panel plays an inaudible looping WAV on phones and the queue keeps moving in other tabs. It also pins a media
// notification users can see. Desktop is untouched.
let mobileKeepAliveAudio = null;
function mobileRunKeepAlive(on) {
  if (!mobileOverlayDevice()) return;
  try {
    if (on && !mobileKeepAliveAudio) {
      mobileKeepAliveAudio = new Audio('data:audio/wav;base64,UklGRoQJAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWAJAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA=');
      const audio = mobileKeepAliveAudio;
      audio.loop = true;
      audio.play()
        .then(() => {
          if (mobileKeepAliveAudio !== audio) return; // stopped or replaced while play() was pending
          log('Mobile keep-alive on: the queue keeps running while you switch tabs.');
          // Name the media notification so it explains itself instead of looking like a phone glitch (owner 2026-10-31).
          try {
            navigator.mediaSession.metadata = new MediaMetadata({title: '0xtnp Flow Studio', artist: 'Queue running · you can switch tabs'});
            navigator.mediaSession.playbackState = 'playing';
          } catch {}
        })
        .catch(() => { if (mobileKeepAliveAudio === audio) mobileKeepAliveAudio = null; });   // blocked audio: behave like before (keep the tab in front)
    } else if (!on && mobileKeepAliveAudio) {
      mobileKeepAliveAudio.pause();
      mobileKeepAliveAudio.src = '';
      mobileKeepAliveAudio = null;
      try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch {}
    }
  } catch {}
}

const DEFAULT_SETTINGS = Object.freeze({
  settingsSchemaVersion: 1,
  platform: 'flow',
  mode: 'text-to-video',
  concurrentPrompts: 1,
  delayMinSeconds: 1,
  delayMaxSeconds: 5,
  // Wait after each result (owner 2026-11-06): off (0) unless the user sets it.
  afterResultMinSeconds: 0,
  afterResultMaxSeconds: 0,
  // Gentle pace (owner 2026-11-06): short random pauses before each Flow step; 'normal' unless the user changes it.
  flowPace: 'normal',
  imageProcessing: 'start-frame',
  autoMatchIngredientImages: true,
  imageOrder: 'custom',
  flowProjectUrl: 'https://flow.google.com/',
  flowImageModel: '', // keep Flow image model unless explicitly selected
  flowModel: 'Omni 1.1 Flash', // default, Omni 1.2 Flash from 2026-12-05 when 1.1 leaves Flow (flowModelCurrent); empty explicitly keeps Flow's current model
  aspectRatio: 'portrait',
  flowDurationSeconds: 8,
  flowOutputCount: 1,
  flowParallel: 1,   // Parallel in Flow (1.13.38): prompts rendering at once in one project; 1 = off
  videoResolution: 'default',
  videoGenerationResolution: '720p',
  vidsVideoModel: 'Omni',
  vidsAspectRatio: 'landscape',
  vidsResolution: '720p',
  vidsDurationSeconds: 10,
  higgsVideoModel: '',         // Higgsfield video model slug from the page address (e.g. seedance_2_5_draft); '' keeps the page's model
  higgsImageModel: '',         // Higgsfield image model slug (e.g. gpt_image_2); '' keeps the page's model
  higgsDuration: 0,            // Higgsfield video length in seconds; 0 keeps the page's length
  higgsMaxCredits: 0,          // Higgsfield: 0 = no credit limit (free plan unlimited)
  grokImageQuality: 'speed',   // Grok Image mode: 'speed' (default) or 'quality' (Quality 2.0)
  geminiModel: '',             // Gemini mode picker: '' keeps the account's choice; all models available (no pro gate)
  geminiThinking: '',          // Gemini thinking level: '' keeps the current one, else low | medium | high
  chainLastFrame: false,
  manualSheets: false,          // Storyboard sheets always available (no Pro gate)
  sheetUpscale: 'balanced',     // AI upscale of small sheet frames: off | natural | balanced | sharp (lib/upscale.mjs)
  downloadSubfolder: 'Flow Automation',
  savePromptCopy: 'no',
  imageDownload: 'save',   // 'none' = keep generated images on the platform (no auto download)
  renameOutputs: true,     // false = keep the platform's own file name
  referenceImageNames: false, // opt-in: NAME, description -> NAME.ext for manual reference images
  maxWaitMinutes: 15,
  maxAttempts: 3,
  retryDelaySeconds: 5,
  uploadSettleSeconds: 6,
  openTabWhileGenerating: true,
  autoWake: true,
  mobileOverlayDefaultsApplied: false,
  // Off by default (owner 2026-10-31): the window is drawn on the Flow page, and Flow's "unusual activity" warning names
  // extensions that modify the page. Settings can still turn it on.
  miniProgress: false,      // small progress window on the task tab while a queue runs (mini-progress.js)
  miniProgressOffApplied: false,
});

let settings = { ...DEFAULT_SETTINGS };
let promptPage = 0, queuePage = 0;
function pagedItems(items, kind) {
  const size = kind === 'prompt' ? ($('promptCardsDisclosure')?.open ? 5 : 3) : 10;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(kind === 'prompt' ? promptPage : queuePage, pages - 1);
  if (kind === 'prompt') promptPage = page; else queuePage = page;
  if ($(kind+'PageInfo')) $(kind+'PageInfo').textContent = `${page+1} / ${pages} · ${items.length} prompts`;
  if ($(kind+'Prev')) $(kind+'Prev').disabled = page===0;
  if ($(kind+'Next')) $(kind+'Next').disabled = page===pages-1;
  return items.slice(page*size,(page+1)*size);
}
let images = [];            // [{ name, type, size, dataUrl }]
let queue = [];             // [{ id, index, text, imageName, status, detail, attempts, retryAt, outputName }]
let sheetPrompts = [];      // prompts imported from csv/xlsx (richer: keeps imageName)
let logs = [];
let running = false;
let queueRejectionFlashTimer = null;
let stopRequested = false;
// Quota/gating removed: no credit limits, all prompts always submits.
let quotaStop = false;  // always false: no quota pause
let quotaSolo = false;  // always false: no solo throttling
let queueStopReason = '';
let runToken = 0;
let outputDir = null;       // FileSystemDirectoryHandle
let outputDirName = '';
let chainedFrame = null;    // { b64, type } last frame from previous video (chaining)
const activeRuns = new Map(); // promptId -> { item, slot, settled }
const slotTabs = new Map();   // slot index -> tabId
const preloadedProjectImages = new Map(); // tabId -> run token
const blobUrls = new Set();

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => self.FlowParsers;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

// Line under the tabs: a short 0xFlow summary when idle; while a queue runs, the keep-open reminder (closing stops it).
// Chrome does not let an extension set the side panel's width, so a narrow side panel shows how to widen it; Chrome then
// remembers the width (owner 2026-10-30). Not in a browser tab or on phones and tablets.
let narrowSidePanel = false;
function renderKeepOpenHint() {
  const hint = $('keepOpenHint');
  if (!hint) return;
  hint.classList.toggle('is-running', !!running);
  hint.firstElementChild.textContent = '✦';   // same mark in both states (owner 2026-10-16)
  $('keepOpenText').textContent = running ? 'Keep this panel open. Closing it stops the queue.'
    : narrowSidePanel ? 'Tip: drag the left edge of this panel to make it wider. Chrome remembers the size.'
    : 'Automate Flow, ChatGPT, Gemini & Grok, or let AI Story make the video.';
}
async function checkPanelWidth() {
  let inTab = true;
  try { inTab = !!(await chrome.tabs?.getCurrent?.()); } catch {}
  const touch = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const narrow = !inTab && !touch && window.innerWidth < 540;
  if (narrow !== narrowSidePanel) { narrowSidePanel = narrow; renderKeepOpenHint(); }
}
if (typeof window !== 'undefined' && typeof chrome !== 'undefined') {
  checkPanelWidth();
  window.addEventListener('resize', () => { clearTimeout(checkPanelWidth.timer); checkPanelWidth.timer = setTimeout(checkPanelWidth, 200); });
}

function setRunState(text, cls) {
  if (typeof window !== 'undefined') window.FlowGoogleSignIn?.renderCommunitySupport?.();
  if (typeof window !== 'undefined') window.manualAccountSwitch?.render?.();
  if (typeof window !== 'undefined') window.geminiAccountSwitch?.render?.();
  if (typeof window !== 'undefined') window.vidsAccountSwitch?.render?.();
  const el = $('runState');
  if (!el) return;
  el.textContent = text;
  el.className = cls || 'status-warn';
  renderKeepOpenHint();
  try { window.FlowBuilderUI?.queueChanged(); } catch {}
  if (typeof scheduleMiniProgress === 'function') scheduleMiniProgress();
}

function log(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${String(line)}`;
  logs.push(stamped);
  if (logs.length > 2000) logs = logs.slice(-1500);
  const el = $('log');
  if (el) {
    el.textContent += `${stamped}\n`;
    el.scrollTop = el.scrollHeight;
  }
  schedulePersist();
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await persistState().catch(() => {});
  }, 800);
}

async function persistState() {
  // Drafts and uploaded image bytes belong to this panel session only.
  await chrome.storage.local.set({ [STORAGE_ROOT]: { settings } });
}

async function loadPersisted() {
  const { [STORAGE_ROOT]: saved } = await chrome.storage.local.get(STORAGE_ROOT);
  settings = sanitizeSettings(saved?.settings || {});
  if (!saved) { await persistState(); return; }
  images = []; queue = []; logs = []; sheetPrompts = []; outputDirName = '';
  // Remove drafts saved by earlier versions as soon as this panel opens.
  await persistState();
}

// Gemini modes in the order the panel shows them.
const GEMINI_PANEL_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
const MUSE_PANEL_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
const VIDS_PANEL_MODES = ['text-to-video', 'frame-to-video', 'ingredients-to-video', 'text-to-image'];
const HIGGS_PANEL_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
const GROK_PANEL_MODES = ['text-to-image', 'image-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video'];
function sanitizeSettings(source) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  // Apply quieter mobile defaults once, including installations that persisted
  // the old enabled default. A later explicit opt-in remains respected.
  if (mobileOverlayDevice() && !source.mobileOverlayDefaultsApplied) {
    out.miniProgress = false;
    out.mobileOverlayDefaultsApplied = true;
  }
  // Once for every installation that saved the old "on" default; a later opt-in in Settings is kept.
  if (!source.miniProgressOffApplied) {
    out.miniProgress = false;
    out.miniProgressOffApplied = true;
  }
  // Owner 2026-11-07: these left Settings. The task tab is brought forward and woken when needed (both step aside while
  // Background Mode shares the tab), and the page progress window stays off (it changes Flow's page).
  out.openTabWhileGenerating = true;
  out.autoWake = true;
  out.miniProgress = false;
  // Oct 2026: Flow moved to its own domain; migrate the old labs URL default.
  if (/^https:\/\/labs\.google\/fx\/tools\/flow\/?$/i.test(String(out.flowProjectUrl || ''))) {
    out.flowProjectUrl = 'https://flow.google.com/';
  }
  out.platform = ['chatgpt', 'gemini', 'grok', 'muse', 'higgsfield', 'vids'].includes(out.platform) ? out.platform : 'flow';
  if(!['custom','name-asc','name-desc','newest','oldest'].includes(out.imageOrder))out.imageOrder='custom';
  if (out.platform === 'chatgpt' && !['text-to-image','image-to-image'].includes(out.mode)) out.mode = 'text-to-image';
  if (out.platform === 'gemini' && !GEMINI_PANEL_MODES.includes(out.mode)) out.mode = 'text-to-video';
  if (out.platform === 'grok' && !GROK_PANEL_MODES.includes(out.mode)) out.mode = 'text-to-video';
  if(out.platform==='vids'){if(!VIDS_PANEL_MODES.includes(out.mode))out.mode='text-to-video';out.concurrentPrompts=1;out.chainLastFrame=false;out.manualSheets=false;}
  if(out.platform==='muse'){if(!MUSE_PANEL_MODES.includes(out.mode))out.mode='text-to-image';out.concurrentPrompts=1;out.chainLastFrame=false;out.manualSheets=false;}
  if(out.platform==='higgsfield'){if(!HIGGS_PANEL_MODES.includes(out.mode))out.mode='text-to-video';out.concurrentPrompts=1;out.chainLastFrame=false;out.manualSheets=false;}
  out.mode = MODES[out.mode] ? out.mode : DEFAULT_SETTINGS.mode;
  // "Omni Flash" was the old default but no Flow model has that name (live: "Omni 1.1 Flash").
  out.flowImageModel = ['Nano Banana Pro','Nano Banana 2','Nano Banana 2 Lite'].includes(out.flowImageModel) ? out.flowImageModel : '';
  out.flowModel = String(out.flowModel || '').trim();
  if (/^omni flash$/i.test(out.flowModel)) out.flowModel = DEFAULT_SETTINGS.flowModel;
  // Flow's own names (live, 2026-10-10): "Veo 3.1 - Lite/Fast/Quality". Older saved names never matched them; Veo 2 is gone.
  const oldVeo = out.flowModel.match(/^veo 3\.1 (lite|fast|quality)$/i);
  if (oldVeo) out.flowModel = `Veo 3.1 - ${oldVeo[1][0].toUpperCase()}${oldVeo[1].slice(1).toLowerCase()}`;
  if (/^veo 2\b/i.test(out.flowModel)) out.flowModel = '';
  out.flowModel = flowModelCurrent(out.flowModel);
  if (!['save', 'none'].includes(out.imageDownload)) out.imageDownload = 'save';
  out.renameOutputs = out.renameOutputs !== false;
  out.referenceImageNames = out.referenceImageNames === true;
  out.grokImageQuality = out.grokImageQuality === 'quality' ? 'quality' : 'speed';
  for (const k of ['higgsVideoModel', 'higgsImageModel']) out[k] = /^[a-z0-9_.-]{2,60}$/.test(String(out[k] || '')) ? String(out[k]) : '';
  out.higgsDuration = Number(out.higgsDuration) >= 1 ? clampNumber(out.higgsDuration, 1, 30, 0) : 0;
  out.higgsMaxCredits = clampNumber(out.higgsMaxCredits, 0, 1000, 0);
  out.geminiModel = out.geminiModel;  // all models allowed; no pro gate
  out.geminiThinking = ['low', 'medium', 'high'].includes(out.geminiThinking) ? out.geminiThinking : '';
  out.concurrentPrompts = clampNumber(out.concurrentPrompts, 1, 5, 1);
  out.delayMinSeconds = clampNumber(out.delayMinSeconds, 0, 3600, DEFAULT_SETTINGS.delayMinSeconds);
  out.delayMaxSeconds = clampNumber(out.delayMaxSeconds, 0, 3600, DEFAULT_SETTINGS.delayMaxSeconds);
  if (out.delayMaxSeconds < out.delayMinSeconds) out.delayMaxSeconds = out.delayMinSeconds;
  out.afterResultMinSeconds = clampNumber(out.afterResultMinSeconds, 0, 3600, 0);
  out.afterResultMaxSeconds = Math.max(out.afterResultMinSeconds, clampNumber(out.afterResultMaxSeconds, 0, 3600, 0));
  out.flowPace = ['off', 'normal', 'slow'].includes(out.flowPace) ? out.flowPace : 'normal';
  out.flowDurationSeconds = flowDurationChoices(out.platform, out.flowModel).includes(Number(out.flowDurationSeconds)) ? Number(out.flowDurationSeconds) : clampNumber(out.flowDurationSeconds, 4, 10, DEFAULT_SETTINGS.flowDurationSeconds);
  out.flowOutputCount = clampNumber(out.flowOutputCount, 1, 4, 1);
  // Owner 2026-11-08: Max Speed runs 2 at once (was 3); fewer parallel sends per account.
  out.flowParallel = Number(out.flowParallel) > 1 ? 2 : 1;
  out.maxWaitMinutes = clampNumber(out.maxWaitMinutes, 3, 60, DEFAULT_SETTINGS.maxWaitMinutes);
  out.maxAttempts = clampNumber(out.maxAttempts, 2, 10, DEFAULT_SETTINGS.maxAttempts);
  out.retryDelaySeconds = clampNumber(out.retryDelaySeconds, 5, 600, DEFAULT_SETTINGS.retryDelaySeconds);
  out.uploadSettleSeconds = clampNumber(out.uploadSettleSeconds, 3, 120, DEFAULT_SETTINGS.uploadSettleSeconds);
  if (!['start-frame', 'all-each', 'first-only', 'pair'].includes(out.imageProcessing)) out.imageProcessing = 'start-frame';
  if (!['portrait', 'landscape', 'square'].includes(out.aspectRatio)) out.aspectRatio = 'portrait';
  out.vidsVideoModel = 'Omni';
  out.vidsAspectRatio = out.vidsAspectRatio === 'portrait' ? 'portrait' : 'landscape';
  out.vidsResolution = out.vidsResolution === '1080p' ? '1080p' : '720p';
  out.vidsDurationSeconds = Math.round(clampNumber(out.vidsDurationSeconds, 3, 15, 10));
  return out;
}

// Flow retires Omni 1.1 Flash, Veo 3.1 - Fast and Veo 3.1 - Quality on 2026-12-05 (owner 2026-11-07; Veo 3.1 - Lite and
// Lower Priority stay). Until then they stay selectable, labelled "leaving Dec 5"; from that day saved settings that name
// them become Omni 1.2 Flash and the list drops them. Empty keeps Flow's current model.
function flowModelCurrent(model, now = Date.now()) { const s = String(model ?? '').trim(); return now >= FLOW_RETIRE_AT && flowModelLeaving(s) ? 'Omni 1.2 Flash' : s; }
const FLOW_RETIRE_AT = Date.UTC(2026, 11, 5);
function flowModelLeaving(model) { return /^(omni\s*1\.1\b|omni\s*flash$|veo\s*3\.1\s*-?\s*(fast|quality)\b)/i.test(String(model ?? '').trim()); }
// Omni 1.2 Flash (owner screenshots 2026-11-06) has a Length slider from 3 to 15 seconds instead of 4/6/8/10 buttons.
function flowModelIsSlider(model) { return /^omni\s*1\.2\s*flash$/i.test(String(model || "").trim()); }
// The lengths the Duration list offers: Grok adds 15s, Omni 1.2 Flash any whole second from 3 to 15.
function flowDurationChoices(platform, model) {
  if (platform === 'grok') return [4, 6, 8, 10, 15];
  // "Flow default (keep current model)" too (owner 2026-11-07): Flow may already be on Omni 1.2 Flash. A length the
  // current Flow model cannot make pauses the queue with a clear "duration unavailable" message.
  if ((platform || 'flow') === 'flow' && (flowModelIsSlider(model) || !String(model ?? '').trim())) return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  return [4, 6, 8, 10];
}
function flowModelIsFixed8s(model) { return /^veo\b/i.test(String(model || '').trim()) && !/lower[\s_-]*priority/i.test(String(model || '')); }

// ---------- rendering ----------
function renderMode() {
  $('referenceImageNames')?.closest('.switch-row')?.classList.toggle('hidden', settings.mode !== 'text-to-image');
  const chat = settings.platform === 'chatgpt';
  const gemini = settings.platform === 'gemini';
  const grok = settings.platform === 'grok';
  const muse = settings.platform === 'muse';
  const higgs = settings.platform === 'higgsfield';
  // Flow-only controls: Gemini fixes its own clip length, model and output count.
  const vids = settings.platform === 'vids';
  const notFlow = chat || gemini || grok || muse || higgs || vids;
  $('vidsEnginePanel')?.classList.toggle('hidden', !vids);
  $('platformSelect').value = settings.platform || 'flow';
  $('platformSelect').disabled = running;
  if(muse||higgs||vids){settings.concurrentPrompts=1;settings.chainLastFrame=false;$('concurrentPrompts').value='1';$('chainLastFrame').checked=false;}
  $('concurrentPrompts').disabled=running||muse||higgs||vids;
  // Platform tabs: one is checked; only the checked one is in the Tab order (arrow keys move between them); locked while running.
  $('platformTabs').querySelectorAll('[data-platform]').forEach(button => {
    const on = button.dataset.platform === (settings.platform || 'flow');
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    button.disabled = running;
  });
  $('platformNotice').textContent = chat ? 'Images · one shared chat · sign in first'
    : gemini ? 'Images & video · new chat per prompt · sign in first'
    : grok ? 'Images & video · new page per prompt · sign in first' : muse ? 'Images & video · one at a time · sign in first' : higgs ? 'Images & video · one at a time · sign in first' : vids ? 'Omni video and Vids images · one at a time' : 'Images & video · sign in first';
  $('backgroundModeBtn').hidden = false;   // Google Vids too (owner 2026-11-14)
  if (typeof renderBackgroundTargetText === 'function') renderBackgroundTargetText();
  $('promptModesHeading').textContent = chat ? 'References per Prompt' : gemini || grok || muse || higgs || vids ? 'Images per Prompt' : 'Video Mode per Prompt';
  $('flowImageModel')?.closest('.field')?.classList.toggle('hidden',notFlow || !['text-to-image','image-to-image'].includes(settings.mode));
  $('flowModel')?.closest('.field')?.classList.toggle('hidden',notFlow || ['text-to-image','image-to-image'].includes(settings.mode));
  if($('maxSpeedControl')) $('maxSpeedControl').hidden = notFlow;
  if($('flowParallel')) $('flowParallel').disabled = running || Boolean(settings.chainLastFrame && settings.mode === 'frame-to-video');
  for (const id of ['flowOutputCount']) $(id)?.closest('.field')?.classList.toggle('hidden',notFlow);
  for(const card of document.querySelectorAll('.prompt-config')) { const select=card.querySelector('select'); if(select)select.hidden=notFlow; }
  const platformModes = chat ? ['text-to-image','image-to-image'] : gemini ? GEMINI_PANEL_MODES : grok ? GROK_PANEL_MODES : muse ? MUSE_PANEL_MODES : higgs ? HIGGS_PANEL_MODES : vids ? VIDS_PANEL_MODES : null;
  document.querySelectorAll('.mode-btn').forEach(btn=>{btn.hidden=!!platformModes&&!platformModes.includes(btn.dataset.mode);btn.classList.toggle('hidden',btn.hidden);});
  // Gemini lists Text to Image first; Flow keeps its video-first order.
  const modeOrder = gemini || grok || muse || higgs ? [...GEMINI_PANEL_MODES, 'agent'] : ['text-to-video','frame-to-video','ingredients-to-video','text-to-image','image-to-image','agent'];
  const modeButtons = [...document.querySelectorAll('.mode-btn')];
  if (modeButtons.length && modeButtons.map(b => b.dataset.mode).join() !== modeOrder.filter(m => modeButtons.some(b => b.dataset.mode === m)).join()) {
    for (const mode of modeOrder) { const btn = modeButtons.find(b => b.dataset.mode === mode); if (btn) btn.parentElement.appendChild(btn); }
  }

  for (const id of ['imageProcessingControls','imageProcessingHint']) {
    $(id).hidden = settings.mode !== 'frame-to-video' && !(vids && settings.mode === 'ingredients-to-video');
    $(id).classList.toggle('hidden', $(id).hidden);
  }
  $('imagesCard').classList.toggle('hidden', !MODES[settings.mode].needsImages);
  for(const id of ['imageOrder','imageOrderHint'])if($(id))$(id).hidden=!imageOrderApplies();
  $('ingredientMatchingCard').classList.toggle('hidden', !['ingredients-to-video', 'image-to-image'].includes(settings.mode));
  $('chainFrameRow').classList.toggle('hidden', gemini || grok || muse || higgs || vids || settings.mode !== 'frame-to-video' || settings.concurrentPrompts !== 1);
  $('manualSheetsRow')?.classList.toggle('hidden', !['chatgpt', 'flow'].includes(settings.platform || 'flow') || !['text-to-image', 'image-to-image'].includes(settings.mode));
  const videoMode = MODES[settings.mode].resultKind === 'video';
  $('aspectRatio')?.closest('.field').classList.toggle('hidden', vids);
  for (const id of ['vidsVideoModel', 'vidsAspectRatio', 'vidsResolution', 'vidsDurationSeconds']) {
    $(id)?.closest('.field').classList.toggle('hidden', !vids || !videoMode);
  }
  for (const id of ['flowDurationSeconds', 'videoResolution', 'videoGenerationResolution']) $(id).closest('.field').classList.toggle('hidden', !videoMode || gemini || muse || higgs || vids);
  for (const id of ['higgsVideoModel', 'higgsDuration']) if ($(id)) $(id).closest('.field').classList.toggle('hidden', !higgs || !videoMode);
  if ($('higgsImageModel')) $('higgsImageModel').closest('.field').classList.toggle('hidden', !higgs || videoMode);
  if ($('higgsMaxCredits')) $('higgsMaxCredits').closest('.field').classList.toggle('hidden', !higgs);
  // Grok's image options (Speed / Quality 2.0) only apply to its image modes; the settings section is named after the platform.
  if ($('grokImageQuality')) $('grokImageQuality').closest('.field').classList.toggle('hidden', !grok || videoMode);
  for (const id of ['geminiModel', 'geminiThinking']) if ($(id)) $(id).closest('.field').classList.toggle('hidden', !gemini);
  if ($('engineSettingsHeading')) $('engineSettingsHeading').textContent = chat ? 'ChatGPT' : gemini ? 'Gemini' : grok ? 'Grok' : muse ? 'Muse' : higgs ? 'Higgsfield' : vids ? 'Google Vids' : 'Flow';
  // Preserve the legacy Veo 8s behaviour. Lower Priority has its own documented 4s/6s/8s choices.
  const veoLocked = !notFlow && flowModelIsFixed8s(settings.flowModel);
  const lowerPriority = !notFlow && /lower[\s_-]*priority/i.test(settings.flowModel);
  const durationChoices = flowDurationChoices(settings.platform, settings.flowModel);
  // Flow charges double per second above 10 s (Omni 1.2 Flash, owner 2026-11-07); Grok's 15s is not marked.
  for (const option of $('flowDurationSeconds').options) option.textContent = `${option.value}s${!notFlow && Number(option.value) > 10 ? ' · 2× credits after 10s' : ''}`;
  for (const option of $('flowDurationSeconds').options) { const offered=durationChoices.includes(Number(option.value)); option.hidden=!offered; option.disabled=!offered||(veoLocked&&option.value!=='8')||(lowerPriority&&!['4','6','8'].includes(option.value)); }
  // A length the chosen model cannot make (e.g. 13s after switching from Omni 1.2 Flash back to 1.1) falls back to 8s.
  if(!durationChoices.includes(Number(settings.flowDurationSeconds))){settings.flowDurationSeconds=8;$('flowDurationSeconds').value='8';}
  if (veoLocked && settings.flowDurationSeconds !== 8) { settings.flowDurationSeconds = 8; $('flowDurationSeconds').value = '8'; }
  if (lowerPriority && ![4,6,8].includes(Number(settings.flowDurationSeconds))) {settings.flowDurationSeconds=8;$('flowDurationSeconds').value='8';}
  if ($('flowDurationHint')) { $('flowDurationHint').hidden = !(veoLocked||lowerPriority); $('flowDurationHint').textContent=lowerPriority?'Lower Priority: 4s, 6s or 8s only.':'Veo is always 8s. Use Omni 1.2 Flash for other lengths.'; }
  // Grok: generate at 480p and pick 720p/1080p here to upscale after generation ("480p (Upscale)"); 480p is a Grok-only choice.
  const gen480 = $('videoGenerationResolution').querySelector('option[value="480p"]'); if (gen480) { gen480.hidden = !grok; gen480.disabled = !grok; }
  if (!grok && $('videoGenerationResolution').value === '480p') { $('videoGenerationResolution').value = '720p'; settings.videoGenerationResolution = '720p'; }
  // "Flow default" only on Flow; Grok (and the others) keep whatever their page is set to (owner 2026-11-11: Grok said "Flow default").
  const genDefault = $('videoGenerationResolution').querySelector('option[value="default"]'); if (genDefault) genDefault.textContent = notFlow ? 'Default' : 'Flow default';
  if ($('genResHint')) $('genResHint').textContent = grok ? 'Grok images per prompt' : 'Choose resolution below to upscale.';
  // Gentle pace only slows Flow's own steps (attach, prompt), so it is hidden for the other platforms.
  $('flowPace')?.closest('.field')?.classList.toggle('hidden', notFlow);
  // 360p cheap draft is always available — never hidden or disabled on any platform.
  const no360 = false;
  const gen360 = $('videoGenerationResolution').querySelector('option[value="360p"]'); if (gen360) { gen360.hidden = false; gen360.disabled = false; }
  if (no360 && $('videoGenerationResolution').value === '360p') { $('videoGenerationResolution').value = '720p'; settings.videoGenerationResolution = '720p'; }
  // Download size for a 360p draft (owner 2026-11-09): keep it at 360p or take Flow's 720p upscale.
  const draft = !no360 && $('videoGenerationResolution').value === '360p';
  const dl360 = $('videoResolution').querySelector('option[value="360p"]'); if (dl360) { dl360.hidden = !draft; dl360.disabled = !draft; }
  const dl720 = $('videoResolution').querySelector('option[value="720p"]'); if (dl720) dl720.textContent = draft ? '720p upscaled' : '720p';
  if (!draft && $('videoResolution').value === '360p') { $('videoResolution').value = 'default'; settings.videoResolution = 'default'; }
  const dlLabel = $('videoResolution').closest('.field').querySelector('label'); if (dlLabel) dlLabel.textContent = grok ? 'Video download quality' : 'Video download resolution';
  $('uploadSettleSeconds').closest('.field').classList.toggle('hidden', !MODES[settings.mode].needsImages);
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
  });
}

const IMAGE_PROCESSING_HINTS = {
  'start-frame': 'Prompt 1 uses image 1, prompt 2 uses image 2, wrapping back around. Exactly 1 image per prompt.',
  'all-each': 'Every prompt receives every uploaded image.',
  'first-only': 'All prompts use the first uploaded image.',
  'pair': 'Prompt N uses image N. Prompts beyond the image count run without images.',
};

// Custom image order (drag / arrows / sort menu): Frame to Video picks frames in this order; Ingredients to Video attaches
// references as Image 1, 2, 3 in this order on every engine (the prompt's @mentions only decide WHICH images; Flow still
// places @-mentioned images inline where the prompt mentions them).
function imageOrderApplies(mode = settings.mode) { return mode === 'frame-to-video' || mode === 'ingredients-to-video'; }
let draggedImageIndex = null;
function changeImagePosition(from,to) {
  if(running || (typeof projectImportBusy!=='undefined' && projectImportBusy))return;
  if(!self.FlowImageOrder.move(images,from,to))return;
  settings.imageOrder='custom';renderImages();schedulePersist();
}
function renderImages() {
  const wrap = $('thumbs');
  if (!wrap) return;
  if(imageOrderApplies())self.FlowImageOrder.sort(images,settings.imageOrder);
  if($('imageOrder'))$('imageOrder').value=settings.imageOrder;
  if ($('imageOrderHint')) {
    const hint = $('imageOrderHint');
    hint.hidden = settings.mode === 'ingredients-to-video';
    hint.textContent = hint.hidden ? '' : settings.imageOrder === 'custom'
      ? 'Drag images or use the arrows to set their order. Frame selection follows this sequence.'
      : 'Frame selection follows this sequence. Move an image to switch to Custom Order.';
  }
  wrap.textContent = '';
  images.forEach((img, idx) => {
    const cell = document.createElement('div');
    cell.className = 'thumb';
    const el = document.createElement('img');
    el.src = img.dataUrl;
    el.alt = img.name;
    el.draggable=false;
    if(imageOrderApplies()) {
      cell.classList.add('is-orderable');cell.draggable=!running;cell.setAttribute('aria-label',`Image ${idx+1}: ${img.name}`);
      const position=document.createElement('span');position.className='order-position';position.textContent=String(idx+1);
      const moves=document.createElement('div');moves.className='order-controls';
      for(const [offset,label] of [[-1,'←'],[1,'→']]) {
        const button=document.createElement('button');button.type='button';button.className='order-move';button.textContent=label;
        button.title=`Move ${img.name} ${offset<0?'earlier':'later'}`;button.setAttribute('aria-label',button.title);
        button.disabled=running || idx+offset<0 || idx+offset>=images.length;
        button.dataset.orderBoundary=String(idx+offset<0 || idx+offset>=images.length);
        button.addEventListener('click',()=>changeImagePosition(idx,idx+offset));moves.append(button);
      }
      cell.append(position,moves);
      cell.addEventListener('dragstart',e=>{if(running){e.preventDefault();return;}draggedImageIndex=idx;e.dataTransfer.setData('application/x-flow-studio-image-order',String(idx));e.dataTransfer.effectAllowed='move';});
      cell.addEventListener('dragover',e=>{if(running||draggedImageIndex===null)return;e.preventDefault();cell.classList.add('order-target');e.dataTransfer.dropEffect='move';});
      cell.addEventListener('dragleave',()=>cell.classList.remove('order-target'));
      cell.addEventListener('drop',e=>{if(running||draggedImageIndex===null)return;e.preventDefault();const from=draggedImageIndex;draggedImageIndex=null;changeImagePosition(from,idx);});
      cell.addEventListener('dragend',()=>{draggedImageIndex=null;for(const node of wrap.querySelectorAll('.order-target'))node.classList.remove('order-target');});
    }
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '\u00d7';
    rm.title = 'Remove image';
    rm.addEventListener('click', () => {
      if (running) return;
      images.splice(idx, 1);
      renderImages();
      schedulePersist();
    });
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = img.name;
    cell.append(el, rm, nm);
    wrap.append(cell);
  });
  $('imageCount').textContent = `${images.length} uploaded`;
  $('imageProcessingHint').textContent = IMAGE_PROCESSING_HINTS[settings.imageProcessing] || '';
  renderPromptModes();
}

function renderPromptModes() {
  if ($('promptCardsTotal')) $('promptCardsTotal').textContent = `${queue.length} ${queue.length === 1 ? 'prompt' : 'prompts'}`;
  const wrap = $('promptModes');
  if (!wrap) return;
  wrap.textContent = '';
  if (!queue.length) { wrap.textContent = 'Type a prompt to see duration controls and image previews.'; return; }
  pagedItems(queue, 'prompt').forEach((item, index) => {
    const card = document.createElement('div'); card.className = 'prompt-config';
    const select = document.createElement('select'); select.setAttribute('aria-label', `Video mode for prompt ${item.index}`);
    // Flow's longest clip is 10s, so only 4s and 6s can start a concat (4+4, 4+6, 6+4).
    ['default', '4', '6', '8', '10', '4-concat', '6-concat'].forEach(value => {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'default' ? `Default (${settings.flowDurationSeconds}s)` : value.replace('-concat', 's Concat') + (value.includes('-') ? '' : 's');
      select.append(option);
    });
    select.hidden = settings.platform !== 'flow'; select.value = item.videoMode || 'default'; select.disabled = running || item.status === 'done';
    select.addEventListener('change', () => { item.videoMode = select.value; schedulePersist(); });
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `${item.index}. Prompt ${item.index}`;
    const subtitle = document.createElement('div'); subtitle.className = 'muted'; subtitle.textContent = `${item.text.length} characters`;
    info.append(title, subtitle); card.append(select, info);
    if ((settings.mode === 'ingredients-to-video' || settings.mode === 'image-to-image') && settings.autoMatchIngredientImages !== false) {
      const missing = P().missingImageMentions(item.text, images.map(image => image.name));
      if (missing.length) {
        const warning = document.createElement('div'); warning.className = 'status-bad'; warning.textContent = `Missing uploaded images: ${missing.map(name => '@' + name).join(', ')}`;
        info.append(warning);
      }
    }
    const previews = document.createElement('div'); previews.className = 'thumbs';
    const selectedImages = imagesForItem({...item, groupMemberIds: null}, true);
    for (const image of selectedImages) {
      const thumb = document.createElement('div'); thumb.className = 'thumb';
      const img = document.createElement('img'); img.src = image.dataUrl; img.alt = image.name;
      const name = document.createElement('div'); name.className = 'nm'; name.textContent = image.name; thumb.title = image.name;
      thumb.append(img, name); previews.append(thumb);
    }
    card.append(previews); wrap.append(card);
  });
}

function planPromptGroups(items, defaultDuration, platform='flow', model=undefined) {
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].status === 'done' || items[i].status === 'skipped') continue;
    const members = [items[i]];
    while (String(members[members.length - 1].videoMode || '').endsWith('-concat')) {
      const next = items[++i];
      if (!next || next.status === 'done' || next.status === 'skipped') throw new Error('Concat requires a following unfinished prompt.');
      members.push(next);
    }
    const durations = members.map(item => Number.parseInt(item.videoMode, 10) || defaultDuration);
    const duration = durations.reduce((a, b) => a + b, 0);
    // A single prompt may use any length its model offers (owner 2026-11-12: Omni 1.2 Flash at 12s did nothing on Start,
    // this check only knew 4/6/8/10). Concat keeps the 4+4 / 4+6 / 6+4 combinations.
    const single = members.length === 1 && typeof flowDurationChoices === 'function' && flowDurationChoices(platform, model).includes(duration);
    if (!single && ![4, 6, 8, 10].includes(duration)&&!(platform==='grok'&&members.length===1&&duration===15)) throw new Error(`Prompt ${members[0].index}: combined duration ${duration}s is unsupported. Use 4s + 4s, 4s + 6s, or 6s + 4s.`);
    let offset = 0;
    const text = members.length === 1 ? members[0].text : 'Create one continuous video with these timed scenes:\n' + members.map((item, j) => {
      const start = offset; offset += durations[j]; return `[${start}s–${offset}s] ${item.text}`;
    }).join('\n');
    groups.push({members, duration, text});
  }
  return groups;
}

function downloadFolder(item = null) {
  const base = String(settings.downloadSubfolder || 'Flow Automation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim() || 'Flow Automation';
  // AI Story results go in a folder named after the story (owner 2026-10-29); Control prompts stay in the main folder.
  return item?.builderFolder ? `${base}/${storyFolderName(item.builderFolder)}`.replace(/\/$/, '') : base;
}
function storyFolderName(title) {
  return String(title || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/g, '').trim();
}

let queueRetryTimer = null;
function queueRetryPresentation(item, now = Date.now()) {
  if (item.status !== 'pending' || !Number.isFinite(item.retryAt)) return null;
  const repaired = /^Repair \d+\/\d+ validated/.test(item.detail || '');
  if (!running || stopRequested) return repaired ? {waiting:false,badge:'Paused',detail:'Repair complete · Queue paused. Press Start to continue.'} : null;
  const seconds = Math.max(0, Math.ceil((item.retryAt - now) / 1000));
  return {waiting:true,badge:seconds ? `Starting in ${seconds}s` : 'Starting again',
    detail:(repaired ? `Repair ${item.repairCount} complete · ` : '') + (seconds
      ? `Generation resumes automatically in ${seconds}s.` : 'Generation resumes automatically shortly.')};
}
function updateQueueRetryCountdowns() {
  const body = $('queueBody');
  for (const el of body?.querySelectorAll('[data-retry-id]') || []) {
    const item = queue.find(p => p.id === el.dataset.retryId), view = item && queueRetryPresentation(item);
    if (view) el.textContent = el.dataset.retryPart === 'badge' ? view.badge : [item.attempts ? `attempt ${item.attempts}` : '', item.imageName ? `image: ${item.imageName}` : '', view.detail].filter(Boolean).join(' · ');
  }
}
function flashQueueRejection() {
  const card = $('queueCard');
  if (!card || !running || stopRequested) return;
  if (queueRejectionFlashTimer) clearTimeout(queueRejectionFlashTimer);
  card.classList.remove('is-rejection-flash');
  void card.offsetWidth;
  card.classList.add('is-rejection-flash');
  queueRejectionFlashTimer = setTimeout(() => {
    card.classList.remove('is-rejection-flash');
    queueRejectionFlashTimer = null;
  }, 1350);
}
// Prompts also get a stable reason code next to their status (lib/queue-reasons.js, QueueReasons.setQueueReason):
// Buddy and the AI assistant read the code, not the detail sentence. Add-only; skipped when the module is absent.
// Single Retry and "Retry errors" must reset the same counters.
function requeueItem(item) {
  item.status = 'pending';
  item.attempts = 0;
  item.technicalFailures = 0;
  item.retryAt = null;
  item.detail = 'requeued';
  item.refusedText = null; item.refusedUnchanged = false;
  if (item.vidsRejected) item.vidsRejected = false;
  globalThis.QueueReasons?.setQueueReason(item, 'requeued');
}
function queueRunButtonLabel(isRunning, items) {
  if (isRunning) {
    const repairing = items.some(item => item.status === 'running' &&
      (item._repairLightActive || /^(repairing\b|repair round\b)/i.test(String(item.detail || ''))));
    return repairing ? 'Repairing…' : 'Generating…';
  }
  return items.some(item => item.status === 'pending' && item.attempts > 0)
    ? '▶ Resume generation' : '▶ Start generation';
}

function renderQueue() {
  // Flow Buddy only reads the queue (see flow-buddy.js); it never changes it.
  try { window.flowBuddy?.queueChanged(); } catch {}
  try { window.FlowBuilderUI?.queueChanged(); } catch {}
  if (typeof renderManualSheetAllowance === 'function') renderManualSheetAllowance();
  if (typeof scheduleMiniProgress === 'function') scheduleMiniProgress();
  if (stopRequested && queueRejectionFlashTimer) {
    clearTimeout(queueRejectionFlashTimer);
    queueRejectionFlashTimer = null;
    $('queueCard')?.classList.remove('is-rejection-flash');
  }
  $('queueCard')?.classList.toggle('is-neon-active', running && !stopRequested);
  const importing = typeof projectImportBusy !== 'undefined' && projectImportBusy;
  for(const button of document.querySelectorAll?.('#thumbs .order-move') || [])button.disabled=running || importing || button.dataset.orderBoundary==='true';
  for (const id of ['loadProjectBtn', 'clearProjectBtn']) {
    if ($(id)) $(id).disabled = running || importing;
  }
  for (const el of document.querySelectorAll?.('.mode-btn, #controlTabPanel input, #controlTabPanel select, #controlTabPanel textarea, #settingsTabPanel input, #settingsTabPanel select, #saveSettingsBtn, #resetSettingsBtn, #clearImagesBtn, #uploadTxtBtn, #uploadSheetBtn, #thumbs .rm') || []) {
    if (el.id !== 'queueFilter') el.disabled = running || importing || (el.id === 'concurrentPrompts' && ['muse', 'higgsfield', 'vids'].includes(settings.platform));
  }
  const body = $('queueBody');
  if (!body) return;
  const previousProgress = new Map();
  for (const track of body.querySelectorAll('[data-progress-id]')) {
    const fill=track.querySelector('.flow-progress-fill');
    const width=track.getBoundingClientRect().width;
    if(fill && width>0 && !track.classList.contains('is-waiting')) previousProgress.set(track.dataset.progressId,Math.min(100,fill.getBoundingClientRect().width/width*100));
  }
  body.textContent = '';
  const counts = { pending: 0, running: 0, done: 0, error: 0, skipped: 0 };
  for (const item of queue) {
    if (counts[item.status] === undefined) counts[item.status] = 0;
    counts[item.status] += 1;
  }
  const total = queue.length;
  const resuming = queue.filter(item => queueRetryPresentation(item)?.waiting).length;
  const finished = counts.done + counts.error + counts.skipped;
  const pct = total ? Math.round((finished / total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `${pct}%`;
  $('queueStatus').textContent = total
    ? `${counts.done} done \u00b7 ${counts.running} running${resuming ? ` \u00b7 ${resuming} resuming automatically` : ''} \u00b7 ${counts.pending - resuming} pending \u00b7 ${counts.error} error${counts.skipped ? ` \u00b7 ${counts.skipped} skipped` : ''}`
    : 'No queue';
  // Storyboard sheets: 8 prompts are still 8 saved frames, but only the sheets are generated (owner 2026-10-25).
  const sheetCount = queue.filter(item => item.manualSheetIds?.length).length;
  $('visibleCount').textContent = total ? `${total} prompt(s)${sheetCount ? ` · ${sheetCount} storyboard sheet${sheetCount > 1 ? 's' : ''}` : ''}` : '';
  const retryableErrors = counts.error - queue.filter(item => item.status === 'error' && item.vidsRejected).length;
  $('retryErrorsBtn').disabled = running || retryableErrors === 0;
  $('startBtn').disabled = running || total === 0;
  $('startBtn').textContent = queueRunButtonLabel(running, queue);
  $('stopBtn').textContent = '■ Stop';
  $('retryErrorsBtn').textContent = `↻ Retry failed (${retryableErrors})`;
  if ($('runCard')) $('runCard').dataset.running = String(running);
  $('stopBtn').disabled = !running;
  $('promptText').disabled = running;
  renderPromptModes();
  $('queueGroupSummary').textContent = ` · ${counts.done}/${total} complete · ${counts.running + resuming} active${resuming ? ` (${resuming} resuming automatically)` : ''}`;
  clearInterval(queueRetryTimer); queueRetryTimer = null;
  if (resuming) queueRetryTimer = setInterval(updateQueueRetryCountdowns, 1000);
  if (!total) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.textContent = 'Your next creation starts here. Type a prompt above to build your queue.';
    body.append(empty);
  }

  for (const item of pagedItems(queue.filter(item => !$('queueFilter') || $('queueFilter').value === 'all' || item.status === $('queueFilter').value || ($('queueFilter').value === 'running' && queueRetryPresentation(item)?.waiting)), 'queue')) {
    const retryView = queueRetryPresentation(item);
    const tr = document.createElement('div'); tr.className = `queue-item ${item.status === 'running' || retryView?.waiting ? 'is-running' : ''}`;
    const tdNum = document.createElement('strong');
    tdNum.textContent = `Prompt ${item.index}`;
    const tdStatus = document.createElement('div');
    const badge = document.createElement('span');
    const needsHumanRepair = item.status === 'error' && /repair limit reached|needs prompt edit|manual revision required/i.test(item.detail || '');
    badge.className = `badge b-${needsHumanRepair ? 'human-repair' : retryView?.waiting ? 'running' : item.status}`;
    badge.textContent = item.status === 'error' && item.vidsRejected ? 'Rejected by Vids'
      : needsHumanRepair ? 'Needs human repair' : retryView?.badge || item.status;
    if (retryView) { badge.dataset.retryId = item.id; badge.dataset.retryPart = 'badge'; }
    tdStatus.append(badge);
    const tdPrompt = document.createElement('div'); tdPrompt.className = 'queue-prompt';
    const detail = document.createElement('div');
    detail.className = item.status === 'done' && item.outputName ? 'queue-output-name' : 'muted';
    if (detail.className === 'muted') detail.style.fontSize = '10px';
    if (retryView) { detail.dataset.retryId = item.id; detail.dataset.retryPart = 'detail'; }
    detail.textContent = item.status === 'done' && item.outputName ? item.outputName : [
      item.attempts ? `attempt ${item.attempts}` : '',
      item.imageName ? `image: ${item.imageName}` : '',
      retryView?.detail || item.detail || '',
    ].filter(Boolean).join(' \u00b7 ');
    tdPrompt.append(detail);
    if (item.status === 'running' || item.status === 'done') {
      const progressWrap = document.createElement('div'); progressWrap.className = 'item-progress';
      const progress = document.createElement('div'); progress.className = 'flow-progress-track'; progress.dataset.progressId = item.id;
      progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', `Prompt ${item.index} progress`);
      progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
      const saving = item.status === 'running' && (item.downloadStarted || /^downloading|^saving output/i.test(item.detail || ''));
      if (saving && item.platform !== 'chatgpt') progress.classList.add('is-saving');
      const chatProgress = item.platform === 'chatgpt';
      if(chatProgress && item.status==='running') progress.classList.add('is-chatgpt-running');
      const percent = item.status === 'done' ? 100 : chatProgress ? Math.min(99,item.progressPercent || 0) : saving ? null : item.progressPercent;
      const fill = document.createElement('div'); fill.className = 'flow-progress-fill';
      if (Number.isFinite(percent)) {
        const value = Math.min(100, Math.max(0, Math.round(percent)));
        fill.style.width = `${value}%`; progress.setAttribute('aria-valuenow', String(value));
        const previous = previousProgress.get(item.id);
        if (fill.animate && Number.isFinite(previous) && Math.abs(previous-value)>.1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          fill.animate([{width:previous+'%'},{width:value+'%'}],{duration:1400,easing:'cubic-bezier(.22,.61,.36,1)',fill:'none'});
        }
      } else {
        progress.classList.add('is-waiting'); progress.setAttribute('aria-valuetext', 'Waiting for Flow progress');
      }
      if (item.status === 'done') progress.classList.add('is-complete');
      progress.append(fill);
      const label = document.createElement('span'); label.className = 'flow-progress-label'; label.textContent = item.status === 'done' ? (chatProgress ? '100% ✓ Saved' : '✓ Saved') : saving && !chatProgress ? '↓ Saving' : Number.isFinite(percent) ? `${Math.min(100, Math.max(0, Math.round(percent)))}%` : 'Loading';
      progressWrap.append(progress, label); tdPrompt.append(progressWrap);
    }
    const tdActions = document.createElement('div'); tdActions.className = 'queue-actions';
    if ((item.status === 'error' || item.status === 'skipped') && !item.groupParent) {
      const retry = document.createElement('button');
      retry.className = 'small';
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        requeueItem(item);
        renderQueue();
        schedulePersist();
      });
      tdActions.append(retry);
    }
    if (item.status === 'pending') {
      const skip = document.createElement('button');
      skip.className = 'small ghost';
      skip.type = 'button';
      skip.textContent = 'Skip';
      skip.addEventListener('click', () => {
        item.status = 'skipped';
        item.detail = 'skipped by user';
        renderQueue();
        schedulePersist();
      });
      tdActions.append(skip);
    }
    tr.append(tdNum, tdStatus, tdPrompt, tdActions);
    body.append(tr);
  }
}

function renderLogs() {
  const el = $('log');
  if (!el) return;
  el.textContent = logs.length ? `${logs.join('\n')}\n` : '';
  el.scrollTop = el.scrollHeight;
}

// ---------- settings UI ----------
function loadSettingsIntoForm() {
  $('concurrentPrompts').value = String(settings.concurrentPrompts);
  $('delayMin').value = String(settings.delayMinSeconds);
  $('delayMax').value = String(settings.delayMaxSeconds);
  $('imageProcessing').value = settings.imageProcessing;
  // A model saved before the list changed stays selectable instead of silently resetting.
  for (const option of [...$('flowModel').options]) if (option.value && flowModelCurrent(option.value) !== option.value) option.remove();   // gone from Flow (2026-12-05)
  if (settings.flowModel && ![...$('flowModel').options].some(option => option.value === settings.flowModel)) $('flowModel').append(new Option(settings.flowModel, settings.flowModel));
  $('flowModel').value = settings.flowModel;
  if($('flowImageModel')) $('flowImageModel').value = settings.flowImageModel || '';
  $('aspectRatio').value = settings.aspectRatio;
  for (const id of ['vidsVideoModel', 'vidsAspectRatio', 'vidsResolution', 'vidsDurationSeconds']) if ($(id)) $(id).value = settings[id];
  $('flowDurationSeconds').value = String(settings.flowDurationSeconds);
  $('flowOutputCount').value = String(settings.flowOutputCount);
  if ($('flowParallel')) $('flowParallel').checked = settings.flowParallel > 1;
  $('videoResolution').value = settings.videoResolution;
  $('videoGenerationResolution').value = settings.videoGenerationResolution;
  if ($('grokImageQuality')) $('grokImageQuality').value = settings.grokImageQuality;
  for (const k of ['higgsVideoModel', 'higgsImageModel', 'higgsDuration', 'higgsMaxCredits']) if ($(k)) $(k).value = String(settings[k] ?? '');
  if ($('geminiModel')) $('geminiModel').value = settings.geminiModel || '';
  if ($('geminiThinking')) $('geminiThinking').value = settings.geminiThinking || '';
  $('chainLastFrame').checked = !!settings.chainLastFrame;
  if ($('manualSheets')) $('manualSheets').checked = !!settings.manualSheets;
  if (typeof renderManualSheetAllowance === 'function') renderManualSheetAllowance();
  if ($('sheetUpscale')) $('sheetUpscale').value = ['off', 'natural', 'balanced', 'sharp'].includes(settings.sheetUpscale) ? settings.sheetUpscale : 'balanced';
  $('downloadSubfolder').value = settings.downloadSubfolder;
  $('autoMatchIngredientImages').checked = settings.autoMatchIngredientImages !== false;
  $('savePromptCopy').value = settings.savePromptCopy;
  if ($('imageDownload')) $('imageDownload').value = settings.imageDownload;
  if ($('renameOutputs')) $('renameOutputs').checked = settings.renameOutputs !== false;
  if ($('referenceImageNames')) $('referenceImageNames').checked = settings.referenceImageNames === true;
  $('maxWaitMinutes').value = String(settings.maxWaitMinutes);
  $('maxAttempts').value = String(settings.maxAttempts);
  $('retryDelaySeconds').value = String(settings.retryDelaySeconds);
  $('afterResultMin').value = String(settings.afterResultMinSeconds);
  $('afterResultMax').value = String(settings.afterResultMaxSeconds);
  $('flowPace').value = settings.flowPace;
  $('uploadSettleSeconds').value = String(settings.uploadSettleSeconds);
  renderMode();
  renderImages();
}

function collectSettingsFromForm() {
  settings.concurrentPrompts = clampNumber($('concurrentPrompts').value, 1, 5, 1);
  settings.delayMinSeconds = clampNumber($('delayMin').value, 0, 3600, DEFAULT_SETTINGS.delayMinSeconds);
  settings.delayMaxSeconds = clampNumber($('delayMax').value, 0, 3600, DEFAULT_SETTINGS.delayMaxSeconds);
  if (settings.delayMaxSeconds < settings.delayMinSeconds) settings.delayMaxSeconds = settings.delayMinSeconds;
  settings.imageProcessing = $('imageProcessing').value;
  settings.flowModel = String($('flowModel').value || '').trim();
  if($('flowImageModel')) settings.flowImageModel = $('flowImageModel').value;
  settings.aspectRatio = $('aspectRatio').value;
  if ($('vidsVideoModel')) settings.vidsVideoModel = $('vidsVideoModel').value;
  if ($('vidsAspectRatio')) settings.vidsAspectRatio = $('vidsAspectRatio').value;
  if ($('vidsResolution')) settings.vidsResolution = $('vidsResolution').value;
  if ($('vidsDurationSeconds')) {
    settings.vidsDurationSeconds = Math.round(clampNumber($('vidsDurationSeconds').value || 10, 3, 15, 10));
    $('vidsDurationSeconds').value = settings.vidsDurationSeconds;
  }
  settings.flowDurationSeconds = flowDurationChoices(settings.platform, String($('flowModel').value || '').trim()).includes(Number($('flowDurationSeconds').value)) ? Number($('flowDurationSeconds').value) : clampNumber($('flowDurationSeconds').value, 4, 10, 8);
  settings.flowOutputCount = clampNumber($('flowOutputCount').value, 1, 4, 1);
  if ($('flowParallel')) settings.flowParallel = $('flowParallel').checked ? 2 : 1;
  settings.videoResolution = $('videoResolution').value;
  settings.videoGenerationResolution = $('videoGenerationResolution').value;
  if ($('grokImageQuality')) settings.grokImageQuality = $('grokImageQuality').value === 'quality' ? 'quality' : 'speed';
  for (const k of ['higgsVideoModel', 'higgsImageModel']) if ($(k)) settings[k] = /^[a-z0-9_.-]{2,60}$/.test($(k).value) ? $(k).value : '';
  if ($('higgsDuration')) settings.higgsDuration = Number($('higgsDuration').value) || 0;
  if ($('higgsMaxCredits')) settings.higgsMaxCredits = clampNumber($('higgsMaxCredits').value, 0, 1000, 0);
  if ($('geminiModel')) settings.geminiModel = $('geminiModel').value;
  if ($('geminiThinking')) settings.geminiThinking = $('geminiThinking').value;
  settings.chainLastFrame = $('chainLastFrame').checked;
  // While an AI Story sheets run is shown on the switch (usage-limit.js), the switch is display only: keep the saved setting.
  if ($('manualSheets') && !$('manualSheets').dataset.aiStory) settings.manualSheets = $('manualSheets').checked;
  if ($('sheetUpscale')) settings.sheetUpscale = $('sheetUpscale').value;
  settings.downloadSubfolder = String($('downloadSubfolder').value || 'Flow Automation');
  settings.autoMatchIngredientImages = $('autoMatchIngredientImages').checked;
  settings.savePromptCopy = $('savePromptCopy').value;
  if ($('imageDownload')) settings.imageDownload = $('imageDownload').value === 'none' ? 'none' : 'save';
  if ($('renameOutputs')) settings.renameOutputs = $('renameOutputs').checked;
  if ($('referenceImageNames')) settings.referenceImageNames = $('referenceImageNames').checked;
  settings.maxWaitMinutes = clampNumber($('maxWaitMinutes').value, 3, 60, 15);
  settings.maxAttempts = clampNumber($('maxAttempts').value, 2, 10, 3);
  settings.retryDelaySeconds = clampNumber($('retryDelaySeconds').value, 5, 600, DEFAULT_SETTINGS.retryDelaySeconds);
  settings.afterResultMinSeconds = clampNumber($('afterResultMin').value, 0, 3600, 0);
  settings.afterResultMaxSeconds = Math.max(settings.afterResultMinSeconds, clampNumber($('afterResultMax').value, 0, 3600, 0));
  settings.flowPace = ['off', 'normal', 'slow'].includes($('flowPace').value) ? $('flowPace').value : 'normal';
  settings.uploadSettleSeconds = clampNumber($('uploadSettleSeconds').value, 3, 120, 6);
  if (settings.miniProgress === false && typeof hideMiniProgress === 'function') hideMiniProgress();
}

// ---------- prompt import ----------
function applyPromptsToQueue(source, preserveModes = false) {
  if (running) return queue.length;
  promptPage = 0; queuePage = 0;
  const previous = queue;
  const entries = Array.isArray(source) && source.length
    ? source
    : P().parsePromptText($('promptText').value).map((text) => ({ text, imageName: '' }));
  // Typing in the prompt box rebuilds the list on every keystroke. A prompt whose text did not change keeps its
  // result (status, saved file, attempts, repaired text), so Start never regenerates finished work after an edit.
  const reusable = preserveModes ? previous.filter(item => ['done', 'error', 'skipped'].includes(item.status)) : [];
  let kept = 0;
  queue = entries.map((entry, idx) => {
    const id = `p${String(idx + 1).padStart(3, '0')}`;
    const sameText = item => (item.sourceText ?? item.text) === entry.text && (item.imageName || '') === (entry.imageName || '');
    let at = reusable.findIndex(item => sameText(item) && item.index === idx + 1);
    if (at < 0) at = reusable.findIndex(sameText);
    if (at >= 0) {
      kept++;
      return Object.assign(reusable.splice(at, 1)[0], {id, index: idx + 1, sourceText: entry.text, groupParent: null, groupMemberIds: null});
    }
    return {
      id,
      index: idx + 1,
      text: entry.text,
      sourceText: entry.text,
      imageName: entry.imageName || '',
      videoMode: preserveModes ? (previous[idx]?.videoMode || 'default') : 'default',
      status: 'pending',
      detail: '',
      attempts: 0,
      retryAt: null,
      outputName: '',
    };
  });
  // The run report keeps following this list when its finished prompts were carried over.
  $('promptCount').textContent = `${entries.length} loaded`;
  $('applyStatus').textContent = kept ? `${entries.length} prompt(s) queued · ${kept} unchanged prompt(s) keep their results` : `${entries.length} prompt(s) queued`;
  renderQueue();
  schedulePersist();
  return queue.length;
}

async function readTextFile(file) {
  return file.text();
}

async function importTxtFile(file) {
  if (running) return;
  const text = await readTextFile(file);
  if (running) return;
  $('promptText').value = text.trim();
  sheetPrompts = [];
  const count = applyPromptsToQueue(null);
  log(`Imported ${count} prompt(s) from ${file.name}.`);
}

async function importSheetFile(file) {
  if (running) return;
  let rows = null;
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    if (typeof XLSX === 'undefined') {
      log(`Cannot parse ${file.name}: xlsx library failed to load (vendor/xlsx.full.min.js missing). Use .csv instead.`);
      $('applyStatus').textContent = 'xlsx library unavailable \u2014 use .csv';
      return;
    }
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  } else {
    const text = await readTextFile(file);
    rows = P().parseDelimited(text);
  }
  if (running) return;
  sheetPrompts = P().sheetRowsToPrompts(rows);
  if (!sheetPrompts.length) {
    log(`No prompts found in ${file.name}.`);
    $('applyStatus').textContent = 'no prompts found in file';
    return;
  }
  $('promptText').value = '';
  const withImages = sheetPrompts.filter((p) => p.imageName).length;
  const count = applyPromptsToQueue(sheetPrompts);
  log(`Imported ${count} prompt(s) from ${file.name}${withImages ? ` (${withImages} with image column)` : ''}.`);
}

// ---------- image library ----------
function addImageFiles(files) {
  if (running) return Promise.resolve();
  files = Array.from(files || []).filter(file => file.type.startsWith('image/'));
  let added = 0;
  const loaded = new Array(files.length);
  let pending = files.length;
  return new Promise((resolve) => {
    if (!pending) return resolve();
    for (const [index, file] of files.entries()) {
      if (!file.type.startsWith('image/')) { pending -= 1; continue; }
      const reader = new FileReader();
      reader.onload = () => {
        if (!running) {
          loaded[index] = { name: file.name, type: file.type, size: file.size, lastModified:file.lastModified, dataUrl: String(reader.result) };
          added += 1;
        }
        if (--pending <= 0) done();
      };
      reader.onerror = () => {
        if (--pending <= 0) done();
      };
      reader.readAsDataURL(file);
    }
    function done() {
      if (!running) images.push(...loaded.filter(Boolean));
      renderImages();
      schedulePersist();
      log(`Added ${added} image(s); library now holds ${images.length}.`);
      window.flowBuddy?.event('images-added', {added, total: images.length});
      resolve();
    }
  });
}

function requiredProjectImages(items) {
  return [...new Map(items.filter(entry => !['done','skipped'].includes(entry.status))
    .flatMap(entry => imagesForItem(entry)).map(image => [image.name.toLowerCase(),image])).values()];
}

function dataUrlToB64(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return {
    b64: dataUrl.slice(comma + 1),
    type: (dataUrl.slice(0, comma).match(/^data:([^;]+)/) || [])[1] || 'image/png',
  };
}

// Resolve the uploaded images a queue item should use, honoring the CSV image
// column first, then the image-processing option, then last-frame chaining.
// Modes that don't consume images never auto-attach the library.
function imagesForItem(item, preview = false) {
  const savedProjectFrame=Boolean(item.builderProjectId||item.manualRestoreFrame);
  if (!savedProjectFrame && !preview && chainedFrame && settings.mode === 'frame-to-video' && settings.chainLastFrame) {
    return [{name:`chained_frame_${Date.now()}.png`,type:'image/png',dataUrl:`data:image/png;base64,${chainedFrame.b64}`}];
  }
  if (!item.groupMemberIds?.length && item.referenceNames?.length && MODES[settings.mode].needsImages) {
    const selected = item.referenceNames.map(name => images.find(image => image.name === name)).filter(Boolean);
    if (settings.mode === 'frame-to-video') return selected.slice(0,1);
    return selected;
  }
  if (item.groupMemberIds?.length) {
    const selected = item.groupMemberIds.flatMap(id => {
      const member = queue.find(entry => entry.id === id);
      return member ? imagesForItem({...member, groupMemberIds: null}) : [];
    });
    return [...new Map(selected.map(image => [image.name, image])).values()];
  }
  const modeDef = MODES[settings.mode] || MODES['text-to-video'];
  if (!modeDef.needsImages) return [];
  const names = images.map((img) => img.name);
  if (item.imageName) {
    // matchImageByName returns null when nothing matches (and null >= 0 is true).
    const idx = P().matchImageByName(item.imageName, names);
    if (idx != null && idx >= 0) return [images[idx]];
    if (!preview) log(`${item.id}: CSV image "${item.imageName}" not found in uploaded images; falling back to ${settings.imageProcessing}.`);
  }
  if ((settings.mode === 'ingredients-to-video' || settings.mode === 'image-to-image') && settings.autoMatchIngredientImages !== false) {
    const mentions = P().imageIndicesMentionedInPrompt(item.text, names);
    // Ingredients follow the Images card order (Custom Order); the prompt only decides which images are used.
    if (settings.mode === 'ingredients-to-video') mentions.sort((a, b) => a - b);
    if (mentions.length || /@[\p{L}\p{N}_-]+/u.test(item.text)) return mentions.map(index => images[index]);
  }
  if (!savedProjectFrame && chainedFrame && settings.mode === 'frame-to-video' && settings.chainLastFrame) {
    return [{ name: `chained_frame_${Date.now()}.png`, type: 'image/png', dataUrl: `data:image/png;base64,${chainedFrame.b64}` }];
  }
  if (settings.mode === 'image-to-image') return images.slice();
  const indices = P().imageIndicesForPrompt(item.index - 1, images.length, settings.imageProcessing);
  return indices.map((i) => images[i]).filter(Boolean);
}

// Quetta can throttle the background panel's timers after its native download sheet.
// Wake only this extension's own control tab once the file is saved.
async function wakeMobilePanelAfterSave() {
  if (!mobileOverlayDevice()) return false;
  try {
    const panel = await chrome.tabs.getCurrent?.();
    if (panel?.id == null || String(panel.url || '').split(/[?#]/)[0] !== chrome.runtime.getURL('control.html')) return false;
    await chrome.tabs.update(panel.id, {active:true});
    return true;
  } catch { return false; }
}

// ---------- tab & injection helpers ----------
function assertRunActive(token) {
  if (stopRequested || token !== runToken) throw new Error('Automation cancelled by user');
}

async function waitForTabComplete(tabId, timeoutMs = 180000) {
  if (stopRequested) throw new Error('Automation cancelled by user');
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === 'complete') return;
  return new Promise((resolve, reject) => {
    let finished = false, checking = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(stopCheck);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Flow tab did not finish loading within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    // Completion can happen between the first get() and listener registration,
    // or Chrome can omit the event. Recheck this same tab, never another project.
    const check = async () => {
      if (finished) return;
      if (stopRequested) { finish(new Error('Automation cancelled by user')); return; }
      if (checking) return;
      checking = true;
      try {
        const current = await chrome.tabs.get(tabId);
        if (stopRequested) finish(new Error('Automation cancelled by user'));
        else if (current.status === 'complete') finish();
      } catch (error) { finish(error); }
      finally { checking = false; }
    };
    const stopCheck = setInterval(check, 500);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish(stopRequested ? new Error('Automation cancelled by user') : undefined);
    }
    chrome.tabs.onUpdated.addListener(listener);
    void check();
  });
}

// Owner 2026-11-07 (Flow "unusual activity" reports): page scripts run in the extension's own space (Chrome's isolated
// world). They read Flow's page and keep their state there; nothing is left in Flow's own code. Only the prompt-text
// fallback (pg_flowInsertPrompt) still asks for 'MAIN': a React text box ignores a value set from outside its code.
async function exec(tabId, func, args = [], world) {
  const target = { tabId };
  const opts = { target, func, args };
  if (world) opts.world = world;
  const [injection] = await chrome.scripting.executeScript(opts);
  if (injection && injection.error) {
    throw new Error(typeof injection.error === 'string' ? injection.error : JSON.stringify(injection.error));
  }
  return injection ? injection.result : undefined;
}

// Each side panel (one per window) owns the tabs it creates and keeps a
// heartbeat. A newly opened panel closes only tabs whose owner stopped beating,
// never the working tabs of a panel that is still running in another window.
const PANEL_ID = globalThis.crypto?.randomUUID?.() || `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const PANEL_HEARTBEAT_MS = 30 * 1000;
const PANEL_STALE_MS = 3 * PANEL_HEARTBEAT_MS;
async function beatPanelHeartbeat() {
  const { automationPanelHeartbeats = {} } = await chrome.storage.local.get('automationPanelHeartbeats');
  const now = Date.now();
  const live = Object.fromEntries(Object.entries(automationPanelHeartbeats).filter(([, at]) => now - at < PANEL_STALE_MS));
  await chrome.storage.local.set({ automationPanelHeartbeats: { ...live, [PANEL_ID]: now } });
}

async function registerAutomationTab(tabId) {
  const { automationTabIds = [] } = await chrome.storage.local.get('automationTabIds');
  const entries = automationTabIds.filter((entry) => (entry?.tabId ?? entry) !== tabId);
  await chrome.storage.local.set({ automationTabIds: [...entries, { tabId, panel: PANEL_ID }] });
  await beatPanelHeartbeat();
}

async function cleanupOrphanTabs() {
  const { automationTabIds = [], automationPanelHeartbeats = {} } = await chrome.storage.local.get(['automationTabIds', 'automationPanelHeartbeats']);
  const now = Date.now();
  const kept = [];
  for (const entry of automationTabIds) {
    // Entries from older versions are plain tab IDs without an owner.
    const tabId = entry?.tabId ?? entry;
    const ownerAlive = entry?.panel && entry.panel !== PANEL_ID && now - (automationPanelHeartbeats[entry.panel] || 0) < PANEL_STALE_MS;
    if (ownerAlive) { kept.push(entry); continue; }
    try {
      const tab = await chrome.tabs.get(tabId);
      if (/^https:\/\/(?:labs\.google|flow\.google)\//i.test(tab.url || '')) await chrome.tabs.remove(tabId);
    } catch { /* tab no longer exists */ }
  }
  await chrome.storage.local.set({ automationTabIds: kept });
}

// Flow postpones loading media while its tab is backgrounded. Briefly select
// the tab so the page becomes visible, then restore the user's tab.
async function wakeFlowTab(tabId) {
  try {
    const automationTab = await chrome.tabs.get(tabId);
    const [previousTab] = await chrome.tabs.query({ active: true, windowId: automationTab.windowId });
    if (previousTab && previousTab.id === tabId) {
      await sleep(MEDIA_WAKE_VISIBLE_MS);
      return { ok: true, switched: false };
    }
    await chrome.tabs.update(tabId, { active: true });
    await sleep(MEDIA_WAKE_VISIBLE_MS);
    const [currentTab] = await chrome.tabs.query({ active: true, windowId: automationTab.windowId });
    if (currentTab && currentTab.id === tabId && previousTab && previousTab.id != null) {
      await chrome.tabs.update(previousTab.id, { active: true }).catch(() => {});
    }
    return { ok: true, switched: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function showFlowActivityWarning() {
  if (typeof document === 'undefined') return;
  let dialog = document.getElementById('flowActivityWarning');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'flowActivityWarning';
    dialog.setAttribute('aria-labelledby', 'flowActivityWarningTitle');
    const heading = document.createElement('h2'); heading.id = 'flowActivityWarningTitle'; heading.textContent = 'Your queue is paused';
    const message = document.createElement('p');
    message.textContent = 'Flow paused your run. Other Flow extensions can cause this. Switch them off in chrome://extensions, even if you aren’t using them. If you have no other extensions, wait a few minutes and try again.';
    const note = document.createElement('p'); note.textContent = 'Then reload the Flow tab and start the queue again. Closing this message will not restart it.';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'primary'; close.textContent = 'Understood'; close.addEventListener('click', () => dialog.close());
    dialog.append(heading, message, note, close); document.body.append(dialog);
  }
  if (!dialog.open) dialog.showModal();
}
async function notifyUser(title, message) {
  await chrome.runtime.sendMessage({ type: 'notify', title, message }).catch(() => {});
}

// ---------- prompt typing (CDP with DOM fallback) ----------
async function flowInsertPrompt(tabId, text) {
  const mobile = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
  // Android CDP clicks/desktop modifier keys can open the frame picker instead of focusing the editor.
  // Try the existing verified DOM insertion first; desktop keeps its real-typing path.
  if (mobile) {
    const dom = await exec(tabId, pg_flowInsertPrompt, [text, FLOW_SELECTORS], 'MAIN').catch(() => null);
    if (dom?.ok) return dom;
    log('Mobile Flow prompt insert was not confirmed; trying real typing.');
  }
  try {
    return await flowInsertPromptWithDebugger(tabId, text);
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    // Owner 2026-11-08 (compared with Flow Automation, which only types for real): on computers the prompt text is never
    // written into Flow's page by a script. A banner or menu that took the cursor is closed with Esc and real typing runs
    // once more (it clears the box first, so nothing is doubled). Phones keep the page insert.
    if (!mobile && chrome.debugger) {
      log(`Real typing did not take (${message}); closing any open Flow panel with Esc and typing once more.`);
      await flowCdpEscape(tabId).catch(() => {});
      await sleep(600);
      try { return await flowInsertPromptWithDebugger(tabId, text); }
      catch (again) { throw new Error(`Flow prompt typing failed twice (${String(again?.message || again)}); the prompt was not written into Flow's page by script`); }
    }
    log(`Debugger typing unavailable (${message}); trying direct DOM insert.`);
    const dom = await exec(tabId, pg_flowInsertPrompt, [text, FLOW_SELECTORS], 'MAIN');
    if (dom && dom.ok) return dom;
    throw dom && dom.error ? new Error(dom.error) : e;
  }
}

async function flowInsertPromptWithDebugger(tabId, text) {
  if (!chrome.debugger) throw new Error('Chrome debugger permission is not available for real Flow typing');
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (!/another debugger|already attached/i.test(message)) throw e;
  }
  try {
    const point = await exec(tabId, pg_flowPromptEditorPoint, []);
    if (!point || !point.ok) throw new Error(`Flow prompt editor point failed: ${point ? point.error : 'no response'}`);
    const key = (method, params) => chrome.debugger.sendCommand(target, method, params);
    await key('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await key('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await key('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(200);
    // Ctrl+A + Backspace outside the prompt box selects every item in the Flow project and moves it to the trash
    // (owner 2026-10-29: "3 items moved to trash", start frames vanished). Only press them with the cursor in the editor.
    const focused = await exec(tabId, pg_flowEditorFocused, []).catch(() => false);
    if (!focused) throw new Error('the prompt box did not take the cursor');
    // Select-all + Backspace clears whatever the composer holds (chained
    // sessions can leave the previous prompt behind).
    await key('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await key('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await key('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await key('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    await key('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await key('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await sleep(150);
    await key('Input.insertText', { text: String(text || '') });
    await sleep(500);
    const verify = await exec(tabId, pg_flowVerifyPromptText, [text]);
    if (!verify || !verify.ok) throw new Error(`Flow prompt verification failed after real typing: ${verify ? verify.error : 'no response'}`);
    return verify;
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

function pg_flowNativePicker(action, name, pointOnly) {
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  // Phone layout (owner log 2026-11-06, Quetta on Android, 360x461): "+" opens a sheet that is not
  // flow-add-menu-popover-content. Its "Search assets" box is the same, so the menu is the box’s nearest panel.
  // Checked on a real phone (Quetta, 360x620): flow-mobile-add-menu inside div[role=dialog].mobile-overlay; a row tap adds and closes it.
  const findPicker = () => {
    const popover = Array.from(document.querySelectorAll("flow-add-menu-popover-content")).find(visible);
    if (popover) return popover;
    const search = Array.from(document.querySelectorAll("input")).find(input => visible(input) && /search assets/i.test((input.getAttribute("placeholder") || "") + " " + (input.getAttribute("aria-label") || "")));
    if (!search) return null;
    const panel = search.closest("[role=\"dialog\"], .flow-menu-panel, .cdk-overlay-pane, [role=\"menu\"]");
    if (panel && visible(panel)) return panel;
    for (let node = search.parentElement; node && node !== document.body; node = node.parentElement) if (node.querySelector("[role=\"option\"]")) return node;
    return search.parentElement;
  };
  const picker = findPicker();
  if (!picker) return {ok:false, error:'Native @ picker is not open'};
  if (action === 'search') {
    const input = picker.querySelector('input[placeholder="Search assets"], input[aria-label="Search assets"]') || picker.querySelector('input');
    if (!input) return {ok:false, error:'Native asset search missing'};
    // Computers (owner 2026-11-08): only where the box is; the panel clicks and types into it for real.
    if (pointOnly) { input.scrollIntoView?.({block:'nearest', inline:'nearest'}); const rect = input.getBoundingClientRect(); return {ok:true, x:rect.left + Math.min(rect.width / 2, 60), y:rect.top + rect.height / 2}; }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, name.replace(/\.[^.]+$/, ''));
    input.dispatchEvent(new Event('input', {bubbles:true}));
    return {ok:true};
  }
  const target = action === 'row'
    ? Array.from(picker.querySelectorAll('[role="option"]')).find(button => button.querySelector('.asset-title, .footer-title')?.textContent.trim().toLowerCase() === name.toLowerCase())
    : Array.from(picker.querySelectorAll('button, [role="button"]')).find(button => /^(?:add|add to prompt)$/i.test(button.innerText.trim()));
  if (!target || !visible(target) || target.disabled) return {ok:false, error:`Native picker ${action} not ready for ${name}`};
  // A 461px phone page can leave the row or "Add to prompt" below the fold; a click there would miss.
  target.scrollIntoView?.({block:'nearest', inline:'nearest'});
  const rect = target.getBoundingClientRect();
  return {ok:true, x:rect.left + rect.width/2, y:rect.top + rect.height/2};
}

// Owner 2026-11-08: the library search text was set by the page script (value + a page-made input event). On computers it
// is now typed for real: a real click into "Search assets", a check that the cursor is in that box (Ctrl+A anywhere else
// selects the project's items), then real keys. Anything unexpected falls back to the page way.
function pg_flowSearchState() {
  const a = document.activeElement;
  const ok = !!a && a.tagName === 'INPUT' && /search assets/i.test((a.getAttribute('placeholder') || '') + ' ' + (a.getAttribute('aria-label') || ''));
  return {focused: ok, value: ok ? a.value : ''};
}
async function flowNativeSearch(tabId, name) {
  if (!chrome.debugger || flowMobileUa()) return exec(tabId, pg_flowNativePicker, ['search', name]);
  const at = await exec(tabId, pg_flowNativePicker, ['search', name, true]);
  if (!at?.ok) return at;
  const text = String(name).replace(/\.[^.]+$/, ''), target = {tabId};
  let owned = false;
  try {
    try { await chrome.debugger.attach(target, '1.3'); owned = true; }
    catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
    await flowCdpClick(tabId, at.x, at.y, true);
    await sleep(150);
    const focus = await exec(tabId, pg_flowSearchState, []);
    if (!focus?.focused) throw Error('the search box did not take the cursor');
    if (focus.value) {
      await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2});
      await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17});
      await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8});
    }
    await send('Input.insertText', {text});
    await sleep(200);
    const after = await exec(tabId, pg_flowSearchState, []);
    if (after?.value !== text) throw Error('the search text did not land');
    return {ok: true};
  } catch (e) {
    log(`Flow library search: typed by the page instead (${String(e?.message || e).slice(0, 80)}).`);
    return exec(tabId, pg_flowNativePicker, ['search', name]);
  } finally { if (owned) await chrome.debugger.detach(target).catch(() => {}); }
}

async function flowSelectNativePhoto(tabId, name) {
  const before = await exec(tabId, pg_flowMentionState, [false]);
  const beforeCount = (before.names || []).filter(value => value.toLowerCase() === name.toLowerCase()).length;
  for (const action of ['search', 'row', 'add']) {
    const startedAt = Date.now(); let point;
    while (Date.now() - startedAt < 15000) {
      point = action === 'search' ? await flowNativeSearch(tabId, name) : await exec(tabId, pg_flowNativePicker, [action, name]);
      if (point?.ok) break;
      await sleep(250);
    }
    if (!point?.ok) throw new Error(point?.error || `Native picker ${action} timed out`);
    if (action !== 'search') await flowCdpClick(tabId, point.x, point.y);
    await sleep(400);
    // In @ mode a trusted row click can insert the chip immediately and
    // close the picker. Do not wait for an Add button that no longer exists.
    if (action === 'row' || action === 'add') {
      const state = await exec(tabId, pg_flowMentionState, [false]);
      if ((state.names || []).filter(value => value.toLowerCase() === name.toLowerCase()).length > beforeCount) return;
    }
  }
}

function pg_flowMentionState(focusEnd) {
  const editor = document.querySelector('div.ProseMirror[contenteditable="true"]');
  if (!editor) return {ok:false, error:'Flow native prompt editor missing'};
  if (focusEnd) {
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  return {ok:true, mentionPrefix: /\S$/.test(editor.textContent || '') ? ' ' : '', names:Array.from(editor.querySelectorAll('.mention-chip[data-mention-id]')).map(chip=>chip.textContent.trim())};
}

// Composer "+" menu state (Oct 2026): "+" opens the same asset popover as @,
// and attached assets render as img[alt="Ingredient image"] above the editor.
function pg_flowAssetMenuState() {
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  // Phone layout (owner log 2026-11-06, Quetta on Android, 360x461): "+" opens a sheet that is not
  // flow-add-menu-popover-content. Its "Search assets" box is the same, so the menu is the box’s nearest panel.
  // Checked on a real phone (Quetta, 360x620): flow-mobile-add-menu inside div[role=dialog].mobile-overlay; a row tap adds and closes it.
  const findPicker = () => {
    const popover = Array.from(document.querySelectorAll("flow-add-menu-popover-content")).find(visible);
    if (popover) return popover;
    const search = Array.from(document.querySelectorAll("input")).find(input => visible(input) && /search assets/i.test((input.getAttribute("placeholder") || "") + " " + (input.getAttribute("aria-label") || "")));
    if (!search) return null;
    const panel = search.closest("[role=\"dialog\"], .flow-menu-panel, .cdk-overlay-pane, [role=\"menu\"]");
    if (panel && visible(panel)) return panel;
    for (let node = search.parentElement; node && node !== document.body; node = node.parentElement) if (node.querySelector("[role=\"option\"]")) return node;
    return search.parentElement;
  };
  const open = !!findPicker();
  const plus = [...document.querySelectorAll('button[aria-label="Add ingredients to the prompt box"]'),
    ...document.querySelectorAll('button[aria-label="Magdagdag ng mga ingredient sa prompt box"]')].find(visible);
  const rect = plus?.getBoundingClientRect();
  return {open, plus: rect ? {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2} : null,
    attached: Array.from(document.querySelectorAll('img[alt="Ingredient image"]')).filter(visible).length};
}

// Adds project assets through "+" → row → "Add to prompt" with trusted clicks.
// "Add to prompt" only appears after a row is selected, and Flow ignores
// synthetic clicks here, so each step is a CDP click confirmed by Flow's own
// ingredient thumbnail count. One debugger session covers the whole sequence:
// attaching shows Chrome's debugging banner, which shifts the page, so every
// point is measured after attachment (a stale point misses the row and the
// click outside closes the menu).
// Gentle pace (owner 2026-11-06): a short random pause before each Flow step (attach an image, enter the prompt, press
// Generate), so prompts do not reach Flow in a fixed, instant rhythm. Seconds per step; 'off' has no pauses.
const FLOW_PACE_STEPS = {normal: {attach: [0.8, 1.8], prompt: [1, 2], generate: [1.5, 3]}, slow: {attach: [2, 4], prompt: [2, 4], generate: [3, 6]}};
function flowPaceMs(level, step, random = Math.random) {
  const range = FLOW_PACE_STEPS[level]?.[step];
  return range ? Math.round((range[0] + random() * (range[1] - range[0])) * 1000) : 0;
}
async function flowPacePause(level, step) {
  const ms = flowPaceMs(level, step);
  if (ms) await sleep(ms);
}

async function flowAttachFromAssetMenu(tabId, names, token, pace) {
  const target = { tabId };
  let ownsDebugger = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    ownsDebugger = true;
  } catch (e) {
    if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e;
  }
  try {
    await sleep(400); // let the debugging banner settle the layout
    for (const name of names) { if (pace) await flowPacePause(pace, 'attach'); await attachOneFromAssetMenu(tabId, name, token); }
  } finally {
    await cdpEscape((method, params) => chrome.debugger.sendCommand(target, method, params)).catch(() => {});
    if (ownsDebugger) await chrome.debugger.detach(target).catch(() => {});
  }
}

// Removes every reference image from the unsent draft via Flow's "Clear prompt"
// and confirms Flow shows none, so the next prompt carries only its own images.
async function flowClearComposerIngredients(tabId, token) {
  let state = await exec(tabId, pg_flowAssetMenuState, []);
  if (!state.attached) return;
  let lastClear = '';
  const target = { tabId };
  let ownsDebugger = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    ownsDebugger = true;
  } catch (e) {
    if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e;
  }
  try {
    await sleep(400); // measure after Chrome's debugging banner shifts the page
    if (await exec(tabId, pg_flowBlurPromptEditor, [])) await sleep(600); // let the phone keyboard close
    for (let attempt = 1; attempt <= 3 && state.attached; attempt++) {
      assertRunActive(token);
      const clear = await exec(tabId, pg_flowClearIngredientDraft, []);
      if (!clear) { lastClear = 'no visible Clear prompt (×) button'; break; }
      lastClear = `tap ${Math.round(clear.x)},${Math.round(clear.y)} hit ${clear.hit}; ${clear.view}`;
      if (attempt < 3) await flowCdpClick(tabId, clear.x, clear.y, true);
      else if (chrome.debugger && !flowMobileUa()) { lastClear += '; third real click'; const again = await exec(tabId, pg_flowClearDraftByScript, [true]); if (again?.clickAt) await flowCdpClick(tabId, again.clickAt.x, again.clickAt.y, true); }
      else { lastClear += '; pressed from the page'; await exec(tabId, pg_flowClearDraftByScript, []); }
      await sleep(700);
      state = await exec(tabId, pg_flowAssetMenuState, []);
      // Phone test 2026-11-06 (Quetta, panel tab in front): Flow takes the tap while hidden but does not redraw until its
      // tab is shown, so the old picture count stayed for 15 s and every prompt lost one try. Show Flow for a moment
      // and read again before tapping a second time.
      if (state.attached) {
        await wakeFlowTab(tabId);
        state = await exec(tabId, pg_flowAssetMenuState, []);
      }
    }
  } finally {
    if (ownsDebugger) await chrome.debugger.detach(target).catch(() => {});
  }
  if (state.attached) throw new Error(`Flow attachment failed: composer still holds ${state.attached} reference image(s) from the upload; prompt was not submitted so it cannot use the wrong references.${lastClear ? ` (Clear prompt: ${lastClear})` : ''}`);
  log(`Cleared upload references from the Flow composer${/pressed from the page/.test(lastClear) ? ' (the × had to be pressed from the page; taps did not reach it)' : ''}.`);
}

async function attachOneFromAssetMenu(tabId, name, token) {
  const click = point => flowCdpClick(tabId, point.x, point.y, true);
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertRunActive(token);
    let state = await exec(tabId, pg_flowAssetMenuState, []);
    const before = state.attached;
    if (!state.open) {
      if (!state.plus) throw new Error('Could not add uploaded Flow media to prompt: composer + button not found');
      await click(state.plus);
      const openedAt = Date.now();
      do { await sleep(250); state = await exec(tabId, pg_flowAssetMenuState, []); } while (!state.open && Date.now() - openedAt < 5000);
      if (!state.open) { lastError = 'asset menu did not open'; continue; }
    }
    let closedEarly = false;
    for (const action of ['search', 'row', 'add']) {
      const startedAt = Date.now(); let point;
      while (Date.now() - startedAt < 10000) {
        assertRunActive(token);
        point = action === 'search' ? await flowNativeSearch(tabId, name) : await exec(tabId, pg_flowNativePicker, [action, name]);
        if (point?.ok) break;
        // A closed menu will not reopen by waiting: start this file again.
        if (/not open/i.test(point?.error || '')) break;
        await sleep(300);
      }
      if (!point?.ok) { lastError = point?.error || `${action} step timed out`; closedEarly = /not open/i.test(lastError); break; }
      if (action !== 'search') await click(point);
      await sleep(action === 'search' ? 900 : 500);
    }
    const addedAt = Date.now();
    do { state = await exec(tabId, pg_flowAssetMenuState, []); if (state.attached > before) break; await sleep(300); } while (Date.now() - addedAt < (closedEarly ? 1000 : 6000));
    if (state.attached > before) {
      log(`Attached ${name} to the Flow prompt (${state.attached} ingredient image${state.attached === 1 ? '' : 's'}).`);
      return;
    }
    if (!lastError) lastError = `Flow did not show ${name} as an ingredient`;
    if (attempt < 3) log(`Attaching ${name} to the Flow prompt: ${lastError}; retrying (${attempt + 1}/3).`);
  }
  throw new Error(`Could not add uploaded Flow media to prompt: ${name}: ${lastError}`);
}

async function flowInsertNativeReferences(tabId, text, names) {
  const segments = P().promptReferenceSegments(text, names);
  await flowInsertPromptWithDebugger(tabId, '');
  const expected = [];
  for (const segment of segments) {
    const focus = await exec(tabId, pg_flowMentionState, [true]);
    if (!focus.ok) throw new Error(focus.error);
    const target = {tabId}; let attached = false;
    try {
      try { await chrome.debugger.attach(target, '1.3'); attached = true; }
      catch (error) { if (!/already attached|another debugger/i.test(String(error))) throw error; }
      // Flow's mention matcher requires a whitespace boundary before @.
      // Role mappings commonly wrap tags in parentheses: CASTILLO (@char_1).
      await chrome.debugger.sendCommand(target, 'Input.insertText', {text: segment.type === 'photo' ? (focus.mentionPrefix || '') + '@' : segment.text});
    } finally { if (attached) await chrome.debugger.detach(target).catch(()=>{}); }
    if (segment.type === 'photo') {
      await sleep(500);
      await flowSelectNativePhoto(tabId, segment.name);
      expected.push(segment.name);
      let state;
      const chipStartedAt = Date.now();
      do {
        state = await exec(tabId, pg_flowMentionState, [false]);
        if (state.names?.length >= expected.length) break;
        await sleep(200);
      } while (Date.now() - chipStartedAt < 10000);
      if (!state?.ok) throw new Error(state?.error || 'Flow native prompt editor missing');
      for (const name of new Set(expected)) {
        if (state.names.filter(value=>value.toLowerCase()===name.toLowerCase()).length < expected.filter(value=>value===name).length) throw new Error(`Flow did not insert a native photo chip for ${name}`);
      }
    }
  }
  return {ok:true, method:'native-photo-mentions'};
}

// Settings application via trusted CDP pointer events. Flow's popover radios
// ignore synthetic DOM clicks (verified live Oct 2026), so every click below
// goes through the Chrome DevTools protocol, which pages treat as real input.
const FLOW_OPTION_REJECT = 'settings trigger|start generation|add ingredients|what do you want|generating will use|credits|upload|import|open file|add media|browse|select model|new project';

async function cdpMouseClick(sendCmd, x, y) {
  await sendCmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sendCmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sendCmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Owner 2026-11-07: each time Chrome's debugger connects or disconnects, Chrome shows or hides its "started debugging
// this browser" bar and the page changes size. While a queue runs, the first connection to a tab stays open until the
// run ends (flowDebuggerRelease): later attach/detach calls for that tab do nothing. Outside a run nothing changes.
function flowDebuggerHold() {
  const api = globalThis.chrome?.debugger;
  if (!api) return null;
  if (api.flowHold) return api.flowHold;
  const hold = api.flowHold = {on: false, tabs: new Set()}, attach = api.attach.bind(api), detach = api.detach.bind(api);
  api.attach = async (target, version) => {
    if (hold.on && hold.tabs.has(target?.tabId)) return;
    await attach(target, version);
    if (hold.on && target?.tabId != null) hold.tabs.add(target.tabId);
  };
  api.detach = async target => { if (hold.on && hold.tabs.has(target?.tabId)) return; return detach(target); };
  hold.release = async () => { const tabs = [...hold.tabs]; hold.on = false; hold.tabs.clear(); for (const tabId of tabs) await detach({tabId}).catch(() => {}); };
  api.onDetach?.addListener?.(source => hold.tabs.delete(source?.tabId));
  return hold;
}
function flowDebuggerKeep() { const hold = flowDebuggerHold(); if (hold) hold.on = true; }
async function flowDebuggerRelease() { await flowDebuggerHold()?.release?.(); }

async function cdpEscape(sendCmd) {
  await sendCmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sendCmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}

// Real pointer move without a click — activates CSS :hover overlays (the
// video card's Download/⋮ buttons only render under a real hover; synthetic
// events never trigger CSS hover states).
async function flowCdpMouseMove(tabId, x, y, connected = false) {
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  if (connected) return send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (!/another debugger|already attached/i.test(message)) throw e;
  }
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

// Zoom is changed per tab only (Flow 50%, ChatGPT 50%, Grok 50%); a finished queue puts the tab back to 100%.
// Never touches a tab that still uses the site's own zoom: setZoom on such a tab would overwrite the
// user's saved zoom for the whole site.
async function restoreTabZoom(tabId) {
  try {
    const zoom = await chrome.tabs.getZoomSettings(tabId);
    if (zoom?.scope !== 'per-tab') return;
    await chrome.tabs.setZoom(tabId, 1);
  } catch {}
}

// Photo upload (owner 2026-11-07): use Flow's file field if it is already there; otherwise open the composer's "+" menu
// with a real mouse click (not a script click) and put the photos into the field that menu shows.
async function flowAttachPhotos(tabId, files, settleMs) {
  // Phones without Chrome's debugger keep the page-side "+" click (no real mouse available there).
  if (!chrome.debugger) return exec(tabId, pg_flowAttachStart, [files, settleMs, FLOW_SELECTORS]);
  // Owner 2026-11-08: members with "unusual activity" mostly upload photos (Frames / Ingredients to Video), and a page-made
  // drop or file-field change is something Flow can tell apart. On computers the photos now go in like a person's: real
  // clicks on "+" and "Upload media", and Chrome's file picker is answered by the debugger with the files (saved for a
  // moment in Downloads/0xFlow-upload-temp, removed after the upload). Any miss falls back to the page upload below.
  if (!flowMobileUa()) {
    const real = await flowUploadReal(tabId, files, settleMs).catch(e => ({ok: false, error: String(e?.message || e)}));
    if (real.ok) return {state: 'working', method: 'upload-media', count: files.length};
    log(`Flow upload: real "Upload media" route not used (${real.error}); using the page upload instead.`);
  }
  const first = await exec(tabId, pg_flowAttachStart, [files, settleMs, FLOW_SELECTORS, 'direct']);
  if (first?.state !== 'needs-menu') return first;
  await flowCdpClick(tabId, first.point.x, first.point.y);
  await sleep(400);
  const menu = await exec(tabId, pg_flowAttachStart, [files, settleMs, FLOW_SELECTORS, 'after-menu']);
  if (menu?.state !== 'needs-drop') return menu;
  // Flow on computers opens a menu without a file field (owner run 2026-11-07). Left open it covered the page: the
  // next uploads did not land and finished cards showed no download button on hover. Close it, then drop the photos.
  await flowCdpEscape(tabId);
  await sleep(300);
  return exec(tabId, pg_flowAttachStart, [files, settleMs, FLOW_SELECTORS, 'drop']);
}

// ---------- real photo upload (owner 2026-11-08) ----------
const FLOW_UPLOAD_TEMP = '0xFlow-upload-temp';
const flowUploadTempIds = new Set();
// Uploads still in progress, per Flow tab. The copies sit in one shared folder, so they are removed only once no tab is
// still uploading (two prompts running side by side must not delete each other's photos).
const flowUploadBusy = new Map();
async function flowUploadTempDone(tabId) {
  for (const [token, tab] of flowUploadBusy) if (tab === tabId) flowUploadBusy.delete(token);
  await flowUploadTempCleanup();
}
// Saves the photos to Downloads/0xFlow-upload-temp/ under their own names (Flow and the readiness check go by the file name)
// and returns their full paths for Chrome's file picker. One fixed folder: Chrome removes the files but not folders, so at
// most this one empty folder stays (owner 2026-11-08). Chrome's download bubble is hidden while the copies are saved
// ("downloads.ui"), so the members don't see their character photos "downloading"; it is turned back on right after.
// Owner 2026-11-12 ("I still see the extension download the image"): the bubble was switched back on as soon as each
// copy was saved, while the copy was still in Chrome's download list, so Chrome showed it. It now stays hidden until
// flowUploadTempCleanup has deleted the copies and removed them from the list (or the save failed).
let flowUploadUiHidden = false;
async function flowUploadDownloadUi(show) {
  if (typeof chrome.downloads?.setUiOptions !== 'function' || flowUploadUiHidden === !show) return;
  flowUploadUiHidden = !show;
  await chrome.downloads.setUiOptions({enabled: show}).catch(() => {});
}
async function flowUploadTempSave(files) {
  const folder = FLOW_UPLOAD_TEMP, out = [];
  await flowUploadDownloadUi(false);
  let saved = false;
  try { for (const file of files) {
    const name = String(file.name || 'image.png').replace(/[\\/:*?"<>|]+/g, '_');
    const url = URL.createObjectURL(new Blob([base64ToBuffer(file.base64)], {type: file.type || 'image/png'}));
    const wanted = folder + '/' + name;
    const naming = (d, suggest) => { if (d.url === url || d.finalUrl === url) suggest({filename: wanted, conflictAction: 'overwrite'}); else suggest(); };
    chrome.downloads.onDeterminingFilename?.addListener(naming);
    try {
      const id = await chrome.downloads.download({url, filename: wanted, saveAs: false, conflictAction: 'overwrite'});
      flowUploadTempIds.add(id);
      let record = null;
      for (let i = 0; i < 60; i++) { [record] = await chrome.downloads.search({id}); if (record?.state !== 'in_progress') break; await sleep(250); }
      if (record?.state !== 'complete' || !record.filename) throw Error('temporary copy of ' + name + ' was not saved' + (record?.error ? ' (' + record.error + ')' : ''));
      if (!record.filename.endsWith(name)) throw Error('temporary copy of ' + name + ' was renamed by the browser');
      out.push(record.filename);
    } finally { chrome.downloads.onDeterminingFilename?.removeListener(naming); URL.revokeObjectURL(url); }
  } saved = true; } finally { if (!saved && !flowUploadBusy.size && !flowUploadTempIds.size) await flowUploadDownloadUi(true); }
  return out;
}
// Deletes the temporary copies (and leftovers of an earlier run) from disk and from Chrome's download list.
async function flowUploadTempCleanup() {
  if (flowUploadBusy.size) return;
  const old = await chrome.downloads.search({filenameRegex: '0xFlow-upload-temp', limit: 200}).catch(() => []);
  const ids = new Set([...flowUploadTempIds, ...old.map(x => x.id)]);
  flowUploadTempIds.clear();
  for (const id of ids) { await chrome.downloads.removeFile(id).catch(() => {}); await chrome.downloads.erase({id}).catch(() => {}); }
  if (!flowUploadBusy.size) await flowUploadDownloadUi(true);
}
// Where the open "+" menu's "Upload media" item is (the panel clicks it for real).
function pg_flowUploadMenuPoint() {
  const shown = e => { const r = e.getBoundingClientRect(), st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const label = e => ((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
  const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, [role="button"]')).filter(shown)
    .filter(e => /^(?:upload(?: media| images?| files?| from (?:your )?(?:computer|device))?|add (?:media|from (?:your )?computer))$/i.test(label(e).replace(/^\S{1,24}\s+(?=upload|add)/i, '')))
    .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  const hit = items[0];
  if (!hit) return {ok: false, error: '"Upload media" not in the + menu'};
  const r = hit.getBoundingClientRect();
  return {ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: label(hit).slice(0, 40)};
}
// Tells the readiness check (pg_flowAttachPoll) which photos are on their way, as the page-side routes do.
function pg_flowAttachMark(names, settleMs, method) {
  window.__flowAttach = {state: 'working', want: names.length, names, start: Date.now(), stableSince: 0, settleMs: Number(settleMs) || 6000, method, error: null};
  return true;
}
async function flowUploadReal(tabId, files, settleMs) {
  if (!chrome.debugger?.onEvent || !chrome.downloads?.download) return {ok: false, error: 'debugger or downloads not available'};
  // Opens "+" with a real click and finds "Upload media"; a menu without it is closed again.
  const openMenu = async () => {
    const plus = await exec(tabId, pg_flowAttachStart, [[], settleMs, FLOW_SELECTORS, 'point']).catch(() => null);
    if (!plus?.point) return {ok: false, error: plus?.error || 'the + button was not found'};
    await flowCdpClick(tabId, plus.point.x, plus.point.y); await sleep(400);
    const at = await exec(tabId, pg_flowUploadMenuPoint, []).catch(() => null);
    if (!at?.ok) { await flowCdpEscape(tabId); await sleep(300); }
    return at || {ok: false, error: 'menu not read'};
  };
  const token = {};
  flowUploadBusy.set(token, tabId);
  let paths;
  try { paths = await flowUploadTempSave(files); }
  catch (e) { flowUploadBusy.delete(token); await flowUploadTempCleanup(); return {ok: false, error: String(e?.message || e)}; }
  const target = {tabId}, send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  let chooser = null, wake = null, sent = 0;
  const onEvent = (source, method, params) => { if (source?.tabId === tabId && !source.sessionId && method === 'Page.fileChooserOpened') { chooser = params; wake?.(); } };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await send('Page.enable');
    await send('Page.setInterceptFileChooserDialog', {enabled: true});
    // Flow's file field may take one photo at a time: then each photo gets its own "+" → "Upload media".
    for (let round = 0; sent < paths.length && round < paths.length; round++) {
      const point = await openMenu();
      if (!point.ok) { if (!round) return {ok: false, error: point.error}; break; }
      chooser = null;
      await flowCdpClick(tabId, point.x, point.y);
      if (!chooser) await new Promise(resolve => { wake = resolve; setTimeout(resolve, 4000); });
      wake = null;
      if (!chooser?.backendNodeId) { await flowCdpEscape(tabId); await sleep(300); if (!round) return {ok: false, error: 'Chrome\'s file picker did not open after "Upload media"'}; break; }
      const take = chooser.mode === 'selectMultiple' ? paths.slice(sent) : paths.slice(sent, sent + 1);
      await send('DOM.setFileInputFiles', {files: take, backendNodeId: chooser.backendNodeId});
      sent += take.length;
      if (sent < paths.length) await sleep(800);
    }
    if (sent < paths.length) log(`Flow upload: ${sent} of ${paths.length} photos went in through "Upload media"; the readiness check retries the rest.`);
    await exec(tabId, pg_flowAttachMark, [files.map(x => x.name), settleMs, 'upload-media']);
    // Safety net: the attach loop removes the copies once Flow has them; this catches a run that stops meanwhile.
    setTimeout(() => { flowUploadBusy.delete(token); flowUploadTempCleanup().catch(() => {}); }, 10 * 60000);
    return {ok: true, sent};
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await send('Page.setInterceptFileChooserDialog', {enabled: false}).catch(() => {});
    if (!sent) { flowUploadBusy.delete(token); await flowUploadTempCleanup().catch(() => {}); }
  }
}

// Owner 2026-11-07: 0xFlow no longer patches Flow's page to keep its download blob, and Flow revokes that blob as soon as
// Chrome has the file. While a download is clicked, the debugger connection (already open) notes Flow's own replies;
// afterwards Chrome hands back the reply whose size equals the saved file exactly (Story Workspace copy, output folder,
// 2K storyboard sheet). Nothing on Flow's page changes and nothing is downloaded a second time.
function flowReplyWatch(tabId, mimePattern) {
  const send = (method, params, sessionId) => chrome.debugger.sendCommand(sessionId ? {tabId, sessionId} : {tabId}, method, params);
  const buffers = {maxResourceBufferSize: 64 * 1048576, maxTotalBufferSize: 192 * 1048576};
  const replies = new Map(), seen = new Map(), workers = new Set(), held = [];
  let on = false, readError = '', paused = 0, fetchOn = false;
  // Owner run 2026-11-08: the page itself showed no matching reply, so Flow's workers are watched too and a short
  // note (place, kind, status, type, size; never the address) says what was seen when nothing matched.
  const onEvent = (source, method, params) => {
    if (source?.tabId !== tabId || !params) return;
    const sid = source.sessionId || '', key = `${sid}|${params.requestId}`;
    if (method === 'Fetch.requestPaused' && !sid) {
      paused++;
      // Owner run 2026-11-08: Flow's 4.8 MB video reply was seen but could no longer be read afterwards (Flow keeps it
      // as a blob). The reply is copied while it passes through and then released unchanged to Flow.
      const type = (params.responseHeaders || []).find(h => /^content-type$/i.test(h.name))?.value || '';
      const keep = params.responseStatusCode === 200 && mimePattern.test(type);
      (keep ? send('Fetch.getResponseBody', {requestId: params.requestId}).then(body => {
        if (body?.body) held.unshift(body.base64Encoded ? base64ToBuffer(body.body) : new TextEncoder().encode(body.body).buffer);
        held.length = Math.min(held.length, 3);
      }).catch(e => { readError = 'copy: ' + String(e?.message || e).slice(0, 60); }) : Promise.resolve())
        .finally(() => send('Fetch.continueRequest', {requestId: params.requestId}).catch(() => {}));
    } else if (method === 'Target.attachedToTarget') {
      if (/worker/i.test(params.targetInfo?.type || '') && params.sessionId) { workers.add(params.sessionId); send('Network.enable', buffers, params.sessionId).catch(() => {}); }
    } else if (method === 'Network.responseReceived') {
      const r = params.response || {};
      if (seen.size < 30 && (params.type !== 'Image' || /^image\//i.test(mimePattern.source))) seen.set(key, {where: sid ? 'worker' : 'page', type: params.type || '?', status: r.status, mime: r.mimeType || '?', size: 0, end: ''});
      if (r.status === 200 && mimePattern.test(r.mimeType || '')) replies.set(key, {sid, requestId: params.requestId, done: false, size: 0});
    } else if (method === 'Network.loadingFinished') {
      if (seen.has(key)) Object.assign(seen.get(key), {size: params.encodedDataLength || 0, end: 'done'});
      if (replies.has(key)) Object.assign(replies.get(key), {done: true, size: params.encodedDataLength || 0});
    } else if (method === 'Network.loadingFailed' && seen.has(key)) {
      seen.get(key).end = String(params.errorText || 'failed').slice(0, 40);
    }
  };
  const stop = () => {
    if (!on) return;
    on = false;
    chrome.debugger.onEvent.removeListener(onEvent);
    for (const sid of workers) { send('Network.disable', undefined, sid).catch(() => {}); send('Target.detachFromTarget', {sessionId: sid}).catch(() => {}); }
    workers.clear();
    send('Fetch.disable').catch(() => {});
    send('Target.setAutoAttach', {autoAttach: false, waitForDebuggerOnStart: false, flatten: true}).catch(() => {});
    send('Network.disable').catch(() => {});
  };
  return {
    async start() {
      if (!chrome.debugger?.onEvent || on) return;
      chrome.debugger.onEvent.addListener(onEvent);
      try { await send('Network.enable', buffers); on = true; }
      catch { chrome.debugger.onEvent.removeListener(onEvent); return; }
      await send('Fetch.enable', {patterns: ['Fetch', 'XHR'].map(resourceType => ({urlPattern: '*', resourceType, requestStage: 'Response'}))})
        .then(() => { fetchOn = true; }).catch(e => { readError = 'pass-through off: ' + String(e?.message || e).slice(0, 60); });
      await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        filter: [{type: 'worker'}, {type: 'shared_worker'}, {type: 'service_worker'}]}).catch(() => {});
    },
    // Newest first; only replies close to the saved size are read back (headers make the transfer slightly larger).
    async bytes(size) {
      if (!on || !(size > 0)) { stop(); return null; }
      try {
        for (let i = 0; i < 20 && !held.some(b => b.byteLength === size) && [...replies.values()].some(r => !r.done); i++) await new Promise(r => setTimeout(r, 250));
        const copy = held.find(b => b.byteLength === size);
        if (copy) return copy;
        if (held.length) readError = 'copied ' + held.map(b => b.byteLength).join('/') + ' bytes, saved file ' + size;
        const candidates = [...replies.values()].reverse().filter(reply => reply.done && (!reply.size || Math.abs(reply.size - size) < 262144)).slice(0, 6);
        for (const reply of candidates) {
          const body = await send('Network.getResponseBody', {requestId: reply.requestId}, reply.sid).catch(e => { readError = readError || 'read: ' + String(e?.message || e).slice(0, 60); return null; });
          if (!body?.body || !body.base64Encoded) { if (body) readError = readError || 'read: reply came back as text'; continue; }
          const buf = base64ToBuffer(body.body);
          if (buf.byteLength === size) return buf;
          readError = readError || `read ${buf.byteLength} bytes, saved file ${size}`;
        }
        return null;
      } finally { stop(); }
    },
    // What Flow's page and workers answered while the download ran, for the log when no reply matched.
    summary() {
      if (!seen.size) return (on || workers.size ? 'no replies seen' : 'reply watch was not running') + (readError ? '; ' + readError : '');
      const mb = n => n ? `${(n / 1048576).toFixed(1)} MB` : 'no size';
      return [...seen.values()].slice(-8).map(s => `${s.where} ${s.type} ${s.status} ${s.mime} ${mb(s.size)}${s.end && s.end !== 'done' ? ' ' + s.end : ''}`).join('; ') + (readError ? '; ' + readError : '') + `; pass-through ${fetchOn ? paused + ' paused' : 'off'}`;
    },
    stop,
  };
}

// Owner 2026-11-08 (compared with Flow Automation, whose every click is a real one): on computers the buttons of Flow's
// rarer screens (New project, Done/back, Agent panel Close, Clear prompt) get a real mouse click from the panel; the page
// script only says where the button is. After a click it waits up to waitMs for the page script to need no further click.
// Phones keep the page's own click.
async function flowExecWithRealClick(tabId, fn, args = [], {clicks = 1, waitMs = 0} = {}) {
  if (!chrome.debugger || flowMobileUa()) return exec(tabId, fn, args);
  let result = await exec(tabId, fn, [...args, true]);
  for (let n = 0; n < clicks && result?.clickAt; n++) {
    await flowCdpClick(tabId, result.clickAt.x, result.clickAt.y);
    const until = Date.now() + waitMs;
    do { await sleep(waitMs ? 400 : 0); result = await exec(tabId, fn, [...args, true]); } while (result?.clickAt && Date.now() < until);
  }
  if (result?.clickAt) { const { clickAt, ...rest } = result; return {...rest, ok: false, error: rest.error || 'Flow did not react to the click'}; }
  return result;
}

function flowMobileUa() {
  return typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
}
// True only when the cursor sits in Flow's prompt box and nothing that Enter could pick from is open.
function pg_flowEnterSubmitReady() {
  const active = document.activeElement;
  const editor = active?.closest?.('[contenteditable="true"], [role="textbox"], textarea');
  if (!editor) return false;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return !Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], .cdk-overlay-pane')).some(visible);
}
async function flowCdpEnter(tabId) {
  const target = {tabId};
  let attached = false;
  try { await chrome.debugger.attach(target, '1.3'); attached = true; }
  catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
  try {
    const key = {key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13};
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {type: 'rawKeyDown', ...key});
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {type: 'char', ...key, text: '\r', unmodifiedText: '\r'});
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {type: 'keyUp', ...key});
  } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
}

async function flowCdpEscape(tabId) {
  const target = {tabId};
  let attached = false;
  try { await chrome.debugger.attach(target, '1.3'); attached = true; }
  catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
  try { await cdpEscape((method, params) => chrome.debugger.sendCommand(target, method, params)); }
  finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
}

// One trusted click at viewport coordinates: attach, click, detach.
async function flowCdpClick(tabId, x, y, connected = false, resolvePoint) {
  const target = { tabId };
  if (connected) return cdpMouseClick((method, params) => chrome.debugger.sendCommand(target, method, params), x, y);
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (!/another debugger|already attached/i.test(message)) throw e;
  }
  try {
    // Attaching can resize the viewport when Chrome displays its debugger banner.
    if (resolvePoint) {
      const point = await resolvePoint();
      if (!point) return false;
      ({ x, y } = point);
    }
    await cdpMouseClick((method, params) => chrome.debugger.sendCommand(target, method, params), x, y);
    return true;
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

// The model dropdown inside the open settings popover, e.g. "Omni 1.1 Flash ▾".
function pg_flowModelDropdown() {
  const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const button = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible)
    .find(element => /arrow_drop_down/.test(element.innerText || '') && element.closest('.cdk-overlay-container, [role="dialog"], [role="menu"]'));
  if (!button) return {ok:false, error:'Flow model selector not found'};
  const rect = button.getBoundingClientRect();
  return {ok:true, text:String(button.innerText || '').replace(/arrow_drop_down/g, '').replace(/\s+/g, ' ').trim(), x:rect.left + rect.width / 2, y:rect.top + rect.height / 2};
}

// Omni 1.2 Flash's "Length" slider (3–15 s) in the settings popover: its current value, range and track ends.
function pg_flowLengthSlider() {
  const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const scope = element => element.closest('.cdk-overlay-container, [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
  const el = Array.from(document.querySelectorAll('[role="slider"], input[type="range"]')).filter(visible).find(scope);
  if (!el) return {ok:false, error:'no length slider'};
  const num = value => value === null || value === undefined || value === '' ? NaN : Number(value);
  let min = num(el.getAttribute('aria-valuemin') ?? el.min), max = num(el.getAttribute('aria-valuemax') ?? el.max), now = num(el.getAttribute('aria-valuenow') ?? el.value);
  const label = (String(scope(el).innerText || "").match(/(\d{1,2})\s*Sec\b/i) || [])[1];
  if (!Number.isFinite(now) && label) now = Number(label);
  // Live Omni 1.2 Flash (owner log 2026-11-12: chip stayed 13s while "duration" was clicked every pass): the slider numbers
  // its 13 stops 0..12, so aria-valuenow is a stop, not seconds. The header ("13 Sec") is the length: read that, on 3..15.
  if (label && min === 0 && [1, 12, 100].includes(max)) { min = 3; max = 15; }
  if (!Number.isFinite(min)) min = 3;
  if (!Number.isFinite(max)) max = 15;
  if (label && min === 3 && max === 15) now = Number(label);
  // The thumb is small; its track is the first wider ancestor (a native range input is its own track).
  let track = el;
  if (el.tagName !== 'INPUT') { for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) { if (node.getBoundingClientRect().width > el.getBoundingClientRect().width * 3) { track = node; break; } } }
  const rect = track.getBoundingClientRect(), thumb = el.getBoundingClientRect(), pad = el.tagName === 'INPUT' ? 8 : thumb.width / 2;
  return {ok:true, min, max, now, label: label ? Number(label) : null, left: rect.left + pad, right: rect.right - pad, y: thumb.top + thumb.height / 2};
}

// Preference notices are logged once per value, not on every prompt.
const loggedFlowPreferences = new Set();
function logModelPreference(model, confirmed) {
  if (!model) return;
  // A later settings pass may not see the model menu; once confirmed, stay confirmed.
  if (!confirmed && loggedFlowPreferences.has(`model:${model}:true`)) return;
  const key = `model:${model}:${confirmed}`;
  if (loggedFlowPreferences.has(key)) return;
  loggedFlowPreferences.add(key);
  log(confirmed ? `Flow model "${model}" confirmed in the settings chip.`
    : `Flow model "${model}" could not be confirmed in the settings chip; Flow may keep its current model.`);
}

async function flowSetupViaDebugger(tabId, opts) {
  if (!chrome.debugger) throw new Error('Chrome debugger permission is not available for Flow settings clicks');
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    if (!/another debugger|already attached/i.test(message)) throw e;
  }
  const sendCmd = (method, params) => chrome.debugger.sendCommand(target, method, params);
  try {
    const mode = (opts && opts.mode) || 'video';
    const videoFamily = mode === 'video' || mode === 'frames' || mode === 'ingredients';
    const aspectRatio = (opts && opts.aspectRatio) || 'portrait';
    const durationSeconds = String((opts && opts.durationSeconds) || 8);
    const outputCount = String((opts && opts.outputCount) || 1);
    const resolutionMap = { '360p': '360p', '720p': '720p', '1080p': '1080p', '2k': '2k', '4k': '4k' };
    const resolutionExact = resolutionMap[opts && opts.videoResolution] || null;
    const aspectExact = aspectRatio === 'landscape' ? '16:9' : aspectRatio === 'square' ? '1:1' : '9:16';
    // Click order mirrors the popover layout; the popover stays open across
    // option clicks (verified live), so one open covers the whole list.
    const want = [];
    // Most video models remain preferences. Lower Priority must be confirmed
    // exactly, because silently retaining another model could spend credits.
    const model = String((opts && opts.model) || '').trim();
    const strictLowerPriority = videoFamily && model.toLowerCase().replace(/[^a-z0-9.]/g,'') === 'veo3.1litelowerpriority';
    if(strictLowerPriority&&!['4','6','8'].includes(durationSeconds))return {ok:false,durationUnavailable:true,error:'duration unavailable: Veo 3.1 - Lite [Lower Priority] supports 4s, 6s or 8s. Choose a supported duration before restarting.'};
    if (videoFamily) {
      want.push({ label: 'mode', exact: 'video' });
      if (mode === 'frames') want.push({ label: 'video type', exact: 'frames' });
      if (mode === 'ingredients') want.push({ label: 'video type', exact: 'ingredients' });
      want.push({ label: 'aspect', exact: aspectExact });
      want.push({ label: 'duration', exact: `${durationSeconds}s` });
      want.push({ label: 'outputs', exact: `x${outputCount}` });
      if (resolutionExact) want.push({ label: 'resolution', exact: resolutionExact });
    } else if (mode === 'image') {
      want.push({ label: 'mode', exact: 'image' });
      // Image results honor the chosen aspect ratio too (best effort; verified below).
      want.push({ label: 'aspect', exact: aspectExact });
      // And the Output count (x1-x4): without it Flow kept a hand-picked x2 and made 2 images per prompt (owner 2026-10-16).
      want.push({ label: 'outputs', exact: `x${outputCount}` });
    }
    let lastChip = '';
    // Verified live (2026-10-10): in Frames, the Veo 3.1 models (Lite/Fast/Quality) show NO duration buttons and always
    // make 8s; only Omni 1.1 Flash offers 4s/6s/8s/10s. Remember whether the wanted duration was ever offered.
    let durationOffered = false, flowModelName = '';
    // Clear any popover a previous prompt left open — a stale menu hides the
    // settings trigger and fails the whole setup ("settings trigger not found").
    await cdpEscape(sendCmd).catch(() => {});
    await sleep(300);
    // Flow's Agent switch left on hides the settings chip and the Start/End frame slots (user report 2026-10-24:
    // "Flow settings trigger not found" until Agent was turned off). Switch it off unless this queue is Agent mode.
    if (mode !== 'agent' && typeof pg_flowAgentChip === 'function') {
      // A fresh Pro project can open the Agent side panel ("Untitled session") instead of the bottom composer; its own
      // prompt box has no settings chip. Close it first (owner 2026-10-24), then the Agent switch below.
      const panel = await exec(tabId, pg_flowCloseAgentPanel, [!!chrome.debugger && !flowMobileUa()]).catch(() => null);
      if (panel?.clickAt) await flowCdpClick(tabId, panel.clickAt.x, panel.clickAt.y);
      if (panel?.closed) { log('Flow opened its Agent side panel; closed it to use the normal prompt box.'); await sleep(1500); }
      const agentChip = await exec(tabId, pg_flowAgentChip, []).catch(() => null);
      if (agentChip?.pressed) {
        await cdpMouseClick(sendCmd, agentChip.x, agentChip.y);
        await sleep(1200);
        const after = await exec(tabId, pg_flowAgentChip, []).catch(() => null);
        log(after?.pressed ? 'Flow Agent is switched on and could not be turned off; turn off Agent in Flow, then press Retry.' : 'Flow Agent was switched on; turned it off so the settings and frame slots show.');
      }
    }
    for (let pass = 1; pass <= 3; pass++) {
      if (mode === 'agent') {
        // Agent is a composer toggle, not a popover option. Only click when
        // it is not already engaged so retries can never double-toggle it off.
        const pt = await exec(tabId, pg_flowOptionPoint, ['agent', 'settings trigger|add ingredients|start generation|upload|import|browse', true]);
        if (pt && pt.ok && pt.pressed !== 'true') {
          await cdpMouseClick(sendCmd, pt.x, pt.y);
          await sleep(400);
          return { ok: true, settingsText: 'agent' };
        }
        if (pt && pt.ok) return { ok: true, settingsText: 'agent already on' };
        lastChip = 'agent toggle not found';
        await sleep(700);
        continue;
      }
      const trigger = await exec(tabId, pg_flowSettingsTriggerPoint, []);
      if (!trigger || !trigger.ok) {
        lastChip = trigger ? trigger.error : 'no response';
        await sleep(700);
        continue;
      }
      lastChip = trigger.text;
      await cdpMouseClick(sendCmd, trigger.x, trigger.y);
      await sleep(500);
      const clicked = [], kept = [];
      // Letters, digits and dots only: "Veo 3.1 Fast" and Flow's "Veo 3.1 - Fast" are the same model.
      const compactText = value => String(value || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
      const modelMatches = value => strictLowerPriority ? compactText(String(value||'').replace(/\bvolume_up\b/gi,''))===compactText(model) : mode==='image'?compactText(value)===compactText(model):compactText(value).includes(compactText(model));
      for (const w of want) {
        const pt = await exec(tabId, pg_flowOptionPoint, [w.exact, FLOW_OPTION_REJECT]);
        if (pt && pt.ok) {
          // Flow already shows this option as chosen (e.g. the second setup after an upload): no click needed.
          if (pt.selected) { kept.push(w.label); if (w.label === 'duration') durationOffered = true; continue; }
          await cdpMouseClick(sendCmd, pt.x, pt.y);
          clicked.push(w.label);
          if (w.label === 'duration') durationOffered = true;
          await sleep(250);
        }
      }
      if (videoFamily && !durationOffered && clicked.length) {
        const current = await exec(tabId, pg_flowModelDropdown, []).catch(() => null);
        if (current?.ok) flowModelName = current.text;
      }
      // The model is a dropdown inside this popover ("Omni 1.1 Flash ▾",
      // "Nano Banana 2.1 ▾"). Open it only when a different model was chosen.
      let modelConfirmed = false;
      // Image and video models are independent explicit preferences.
      if (model && (videoFamily || mode === 'image')) {
        let dropdown = await exec(tabId, pg_flowModelDropdown, []);
        modelConfirmed = !!dropdown?.ok && modelMatches(dropdown.text);
        if (dropdown?.ok && !modelConfirmed) {
          await cdpMouseClick(sendCmd, dropdown.x, dropdown.y);
          await sleep(400);
          let pt = await exec(tabId, pg_flowOptionPoint, [model, 'arrow_drop_down|settings trigger|start generation|upload' + (mode === 'image' && model === 'Nano Banana 2' ? '|\\blite\\b|\\bpro\\b' : '')]);
          if(strictLowerPriority&&!pt?.ok)pt=await exec(tabId,pg_flowOptionPoint,[model.replace('[Lower Priority]','(Lower Priority)'),'arrow_drop_down|settings trigger|start generation|upload']);
          // A model leaving Flow (Omni 1.1 Flash, Veo Fast/Quality) that Flow no longer lists: use Omni 1.2 Flash for this run
          // instead of whatever model Flow had (owner 2026-11-07).
          if (!pt?.ok && videoFamily && typeof flowModelLeaving === 'function' && flowModelLeaving(model)) {
            pt = await exec(tabId, pg_flowOptionPoint, ['Omni 1.2 Flash', 'arrow_drop_down|settings trigger|start generation|upload']);
            if (pt?.ok) log(`Flow no longer offers ${model}; using Omni 1.2 Flash for this prompt. Choose Omni 1.2 Flash in Settings to stop this message.`);
          }
          if (pt?.ok) { await cdpMouseClick(sendCmd, pt.x, pt.y); await sleep(400); clicked.push('model'); }
          else { await cdpEscape(sendCmd); await sleep(200); }
          dropdown = await exec(tabId, pg_flowModelDropdown, []);
          modelConfirmed = !!dropdown?.ok && modelMatches(dropdown.text);
        }
      }
      // Omni 1.2 Flash (owner screenshots 2026-11-06) has no 4s/6s/8s/10s buttons: a "Length" slider from 3 to 15 seconds.
      // Click the track near the wanted length, then step with the arrow keys until the slider reads exactly that length.
      if (videoFamily && !clicked.includes('duration') && !kept.includes('duration') && typeof pg_flowLengthSlider === 'function') {
        const wantSeconds = Number(durationSeconds);
        let slider = await exec(tabId, pg_flowLengthSlider, []).catch(() => null);
        if (slider?.ok && wantSeconds >= slider.min && wantSeconds <= slider.max) {
          if (slider.now !== wantSeconds) {
            const frac = (wantSeconds - slider.min) / Math.max(1, slider.max - slider.min);
            await cdpMouseClick(sendCmd, slider.left + frac * (slider.right - slider.left), slider.y);
            await sleep(300);
          }
          for (let step = 0; step < 20; step++) {
            slider = await exec(tabId, pg_flowLengthSlider, []).catch(() => null);
            if (!slider?.ok || slider.now === wantSeconds || !Number.isFinite(slider.now)) break;
            const right = slider.now < wantSeconds, key = right ? 'ArrowRight' : 'ArrowLeft', code = right ? 39 : 37;
            await sendCmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
            await sendCmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
            await sleep(150);
          }
          if (slider?.ok && slider.now === wantSeconds) { durationOffered = true; clicked.push('duration'); }
        } else if (slider?.ok) {
          durationOffered = false; flowModelName = flowModelName || (await exec(tabId, pg_flowModelDropdown, []).catch(() => null))?.text || '';
        }
      }
      await cdpEscape(sendCmd);
      await sleep(300);
      if(strictLowerPriority&&!modelConfirmed)return {ok:false,modelUnavailable:true,error:'model unavailable: Veo 3.1 - Lite [Lower Priority] could not be confirmed on this Flow account. Queue paused; no paid model will be used. Check the model in Flow or choose another model explicitly.'};
      const chipPt = await exec(tabId, pg_flowSettingsTriggerPoint, []);
      lastChip = chipPt && chipPt.ok ? chipPt.text : lastChip;
      const chip = lastChip;
      const durationOk = new RegExp(`\\b${durationSeconds}s\\b`).test(chip);
      const outputOk = new RegExp(`\\bx${outputCount}\\b`).test(chip);
      const aspectOk = aspectRatio === 'landscape'
        ? /16\s*:\s*9|crop_16_9/.test(chip)
        : aspectRatio === 'square' ? /1\s*:\s*1/.test(chip) : /9\s*:\s*16|crop_9_16/.test(chip);
      if (videoFamily && durationOk && outputOk && aspectOk) {
        // Resolution is a preference: account tiers expose different option
        // sets (e.g. only 360p/720p), so a missing option downgrades with a
        // log line rather than failing the whole run.
        if (resolutionExact && !new RegExp(`\\b${resolutionExact}\\b`).test(chip)) {
          log(`Flow resolution preference ${resolutionExact} is not available on this account; Flow will use its current resolution.`);
        }
        logModelPreference(model, modelConfirmed || compactText(chip).includes(compactText(model)));
        return { ok: true, settingsText: chip, clicked, kept };
      }
      // Live chip (Oct 2026): Image mode shows "🍌 nano banana 2 …", with no
      // "image" word at all — accept the banana model markers too.
      // The chip shows the count ("Nano Banana 2.1 ▯ x2"): a wrong count gets another pass; a chip without any count is accepted.
      const imageCountOk = outputOk || !/\bx[1-4]\b/.test(chip);
      if (mode === 'image' && imageCountOk && (/image\s*·|\bimage\b|nano\s*banana|banana\s*pro/i.test(chip)) && !/video\s*·/.test(chip)) {
        if (!aspectOk && !loggedFlowPreferences.has('image-aspect:' + aspectRatio)) {
          loggedFlowPreferences.add('image-aspect:' + aspectRatio);
          log(`Flow image aspect ratio ${aspectExact} could not be confirmed in the settings chip; Flow may use its current ratio.`);
        }
        if(model && !modelConfirmed) return {ok:false,error:`Flow image model "${model}" could not be confirmed. Select an available image model or choose Flow default.`};
        logModelPreference(model, modelConfirmed);
        return { ok: true, settingsText: chip, clicked, kept };
      }
      log(`Flow settings pass ${pass}: chip "${chip}" (clicked: ${clicked.join(', ') || 'none'}).`);
    }
    if (mode === 'agent') return { ok: false, error: `Flow Agent toggle not found: ${lastChip}` };
    if (mode === 'image') return { ok: false, settingsText: lastChip, error: /\bx[1-4]\b/.test(lastChip) && !new RegExp(`\bx${outputCount}\b`).test(lastChip)
      ? `Flow image output count did not change to x${outputCount}; chip shows "${lastChip}"`
      : `Flow did not switch to Image mode; chip shows "${lastChip}"` };
    // The settings menu opened but had no button for the wanted duration: the selected Flow model cannot make it. Every
    // other prompt would fail the same way, so the caller pauses the queue with this explanation.
    if (videoFamily && !durationOffered && flowModelName) {
      const fixed = (lastChip.match(/\b(\d{1,2})s\b/) || [])[1];
      return { ok: false, durationUnavailable: true, settingsText: lastChip,
        error: `duration unavailable: Flow's model "${flowModelName}" has no ${durationSeconds}s option in this mode${fixed ? ` (it makes ${fixed}s videos)` : ''}. Set Duration to ${fixed ? `${fixed}s` : 'a length Flow offers'} in the extension, or choose Omni 1.2 Flash (any length from 3s to 15s) as the Flow model, then press Start` };
    }
    return {
      ok: false,
      error: `Flow settings did not apply: wanted ${durationSeconds}s x${outputCount} ${aspectRatio}${resolutionExact ? ` ${resolutionExact}` : ''}, chip shows "${lastChip}"`,
      settingsText: lastChip,
    };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

// ==========================================================================
// Page-context functions (stringified & injected; must be self-contained)
// ==========================================================================

// Oct 2026 Flow UI: the composer settings popover uses custom radio widgets
// that ignore synthetic DOM clicks and accessibility presses — only trusted
// (CDP) pointer events toggle them (verified live: chip stays "8s" after a
// synthetic click, becomes "10s" after a real one). So setup is split: page
// functions below LOCATE controls and report viewport coordinates; the panel
// dispatches real CDP mouse clicks via flowSetupViaDebugger().

async function pg_flowEnsureProject(pointOnly = false) {
  let clickAt = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const clickElement = (element) => {
    if (!element) return false;
    const target = element.closest?.('button, [role="button"], a[href]') || element;
    if (pointOnly) { const r = target.getBoundingClientRect(); clickAt = {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; return true; }
    let nativeClicked = false;
    try {
      if (typeof target.click === 'function') {
        target.click();
        nativeClicked = true;
      }
    } catch { /* continue with synthetic events */ }
    try {
      if (!nativeClicked && typeof HTMLElement !== 'undefined') {
        HTMLElement.prototype.click.call(target);
        nativeClicked = true;
      }
    } catch { /* continue with synthetic events */ }
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y) || target;
    let sent = false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      let event = null;
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y });
      } else if (typeof MouseEvent === 'function') {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      } else if (typeof Event === 'function') {
        event = new Event(type, { bubbles: true, cancelable: true });
      }
      if (event) {
        hit.dispatchEvent(event);
        if (hit !== target) target.dispatchEvent(event);
        sent = true;
      }
    }
    return nativeClicked || sent;
  };
  const editor = () => Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  if (/\/trash\b/i.test(location.href) || /trash is empty/i.test(document.body?.innerText || '')) {
    const back = Array.from(document.querySelectorAll('button, [role="button"], a[href], div, span'))
      .filter(visible)
      .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
      .filter(({ text }) => /\bback to\b|arrow_back/.test(text))
      .sort((a, b) => (a.rect.left + a.rect.top) - (b.rect.left + b.rect.top))[0];
    if (back) clickElement(back.item);
    else history.back();
    return { ok: false, creatingProject: true, error: 'Returning from Flow trash view', clickAt };
  }
  if (/\/project\//i.test(location.href)) {
    return editor()?{ ok: true, url: location.href, hasEditor: true }:{ok:false,waitingForEditor:true,error:'Waiting for Flow composer'};
  }
  let created = false;
  const newProject = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter(visible)
    .map((item) => ({ item, text: textOf(item) }))
    .filter(({ text }) => text.includes('new project'))
    .sort((a, b) => (a.text.length <= 24 && b.text.length > 24) ? -1 : 1)[0];
  if (newProject && !newProject.item.disabled && newProject.item.getAttribute('aria-disabled') !== 'true') {
    created = clickElement(newProject.item);
  }
  return { ok: false, creatingProject: created, error: created ? 'Creating Flow project' : 'Flow project editor not found', clickAt };
}

// The composer's settings chip button (aria "settings trigger", shows text
// like "Video · 720p · 8s" plus x1/aspect). Returns its center point and its
// text — the text doubles as the chip readout used for verification.
function pg_flowSettingsTriggerPoint() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
    .filter(visible)
    .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
    .filter(({ text, rect }) =>
      rect.top > window.innerHeight * 0.5 &&
      (text.includes('settings trigger') || /video\s*·|image\s*·/.test(text)) &&
      !/agent|add ingredients|start generation|upload|new project/.test(text)
    )
    .sort((a, b) => {
      const score = (c) =>
        (c.text.includes('settings trigger') ? 9000 : 0) +
        (c.rect.width < 320 ? 500 : 0) + c.rect.left;
      return score(b) - score(a);
    });
  const best = candidates[0];
  if (!best) return { ok: false, error: 'Flow settings trigger not found' };
  try { best.item.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* ignore */ }
  const rect = best.item.getBoundingClientRect();
  return {
    ok: true,
    x: Math.max(1, Math.min(window.innerWidth - 2, rect.left + rect.width / 2)),
    y: Math.max(1, Math.min(window.innerHeight - 2, rect.top + rect.height / 2)),
    text: best.text,
  };
}

// Find a settings-popover option by exact compact text ("10s", "9:16", "x1",
// "video", "frames", "image", "720p", "agent"). Exact matching sidesteps the
// section headers ("Video duration", "Output count") that merely contain the
// words; loose matches are only allowed for small option-sized controls so
// container groups never win. Returns the click point in viewport CSS pixels
// plus the control's toggle state when it exposes one.
// Flow's Agent side panel (flow-agent-panel): clicks its close button ("close" icon; any language).
function pg_flowCloseAgentPanel(pointOnly = false) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const panel = [...document.querySelectorAll('flow-agent-panel')].find(visible);
  if (!panel) return { closed: false };
  const close = [...panel.querySelectorAll('button')].filter(visible)
    .find(b => (b.innerText || '').trim().toLowerCase() === 'close' || /^close$/i.test(b.getAttribute('aria-label') || ''));
  if (!close) return { closed: false, error: 'Agent panel close button not found' };
  if (pointOnly) { const r = close.getBoundingClientRect(); return { closed: true, clickAt: {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)} }; }
  close.click();
  return { closed: true };
}

// Flow's Agent composer switch (button.agent-mode-chip, aria-pressed). Any language: found by its class first.
function pg_flowAgentChip() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chip = [...document.querySelectorAll('button.agent-mode-chip')].find(visible)
    || [...document.querySelectorAll('button[aria-pressed]')].find(e => visible(e) && /^agent$/i.test((e.innerText || '').trim()));
  if (!chip) return null;
  const r = chip.getBoundingClientRect();
  return { pressed: chip.getAttribute('aria-pressed') === 'true', x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pg_flowOptionPoint(exactText, rejectSource, allowOutsideSelectable) {
  const wanted = String(exactText || '').toLowerCase().replace(/\s+/g, '');
  if (!wanted) return { ok: false, error: 'No option text given' };
  const reject = rejectSource ? new RegExp(rejectSource, 'i') : null;
  // Settings options live in radio/menu containers. Requiring that context
  // stops this search from ever returning an unrelated page button — a
  // trusted CDP click on e.g. an "Upload image" button would open the OS
  // file picker and stall the whole run. The Agent composer toggle is the
  // one sanctioned exception (a plain aria-pressed button).
  const SELECTABLE = '[role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"], [role="menu"], [role="listbox"], [role="dialog"]';
  const inSelectable = (item) => {
    if (!item || !item.closest) return false;
    return item.matches('[role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"]') ||
      !!item.closest(SELECTABLE);
  };
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="menuitemradio"], label, div, span'))
    .filter(visible)
    .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
    .filter(({ item, text, rect }) => {
      if (!allowOutsideSelectable && !inSelectable(item)) return false;
      if (reject && reject.test(text)) return false;
      // Anything that could summon the native file picker is never an option.
      if (/upload|import|open file|add media|browse/i.test(text)) return false;
      const compact = text.toLowerCase().replace(/\s+/g, '');
      if (compact === wanted) return true;
      // Loose containment only for compact, option-sized controls (e.g.
      // "360p 360p generates faster at lower resolution").
      return compact.includes(wanted) &&
        compact.length <= wanted.length + 40 &&
        rect.width > 0 && rect.width <= 280 &&
        rect.height > 0 && rect.height <= 64;
    })
    .sort((a, b) => {
      const score = (c) => {
        const compact = c.text.toLowerCase().replace(/\s+/g, '');
        return (compact === wanted ? 5000 : 0) +
          (c.rect.width <= 280 && c.rect.height <= 64 ? 1000 : 0) +
          (c.text.length <= 16 ? 500 : 0) - c.text.length;
      };
      return score(b) - score(a);
    });
  const best = candidates[0];
  if (!best) return { ok: false, error: `Option "${exactText}" not found in Flow settings` };
  try { best.item.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  const rect = best.item.getBoundingClientRect();
  return {
    ok: true,
    x: Math.max(1, Math.min(window.innerWidth - 2, rect.left + Math.max(8, rect.width / 2))),
    y: Math.max(1, Math.min(window.innerHeight - 2, rect.top + Math.min(20, rect.height / 2))),
    text: best.text,
    pressed: best.item.getAttribute('aria-pressed'),
    checked: best.item.getAttribute('aria-checked'),
    // Already chosen in Flow (owner 2026-11-06): only an explicit selected mark counts; no mark means click as before.
    selected: [best.item, best.item.closest('[role="radio"], [role="menuitemradio"], [role="option"], [role="tab"], button')].some(el => !!el && (
      el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' ||
      /^(on|checked|active|selected)$/.test(el.getAttribute('data-state') || ''))),
  };
}

function pg_flowComposerReady() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editor = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  const overlayText = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"]'))
    .filter(visible)
    .map((item) => `${item.innerText || ''} ${item.textContent || ''}`.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter((text) => /omni flash|veo 3|veo 3\.1|veo 2|4s|6s|8s|10s|x1|x2|x3|x4|nano banana/.test(text));
  // Flow's current touch settings panel has no dialog/menu role. Escape alone may leave it open.
  const mobile = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
  const settingsPanel = mobile && Array.from(document.querySelectorAll('flow-prompt-box-settings')).find(visible);
  if (settingsPanel) {
    const trigger = document.querySelector('button[aria-label="Settings trigger"]');
    if (visible(trigger)) trigger.click();
    return {ok:false, hasEditor:!!editor, overlayCount:Math.max(1,overlayText.length), overlayText, closingSettings:!!trigger};
  }
  return {
    ok: !!editor && overlayText.length === 0,
    hasEditor: !!editor,
    overlayCount: overlayText.length,
    overlayText: overlayText.slice(0, 2),
  };
}

function pg_nudgeMediaIntoView() {
  const videos = Array.from(document.querySelectorAll('video'));
  for (const video of videos) {
    try { video.preload = 'auto'; } catch { /* ignore readonly media quirks */ }
    try { video.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* ignore detached nodes */ }
  }
  try { window.scrollTo(0, Math.max(0, window.scrollY || 0)); } catch { /* ignore */ }
  return { videoCount: videos.length };
}

// Huawei phone 2026-11-06: the × was visible but taps on it never cleared the draft. A phone keyboard left open by the
// prompt editor moves the visible part of the page (visualViewport offset), and a point measured from the page layout
// then lands beside the button. The point is given in visible-screen terms, and `hit` names what is under it.
function pg_flowClearIngredientDraft() {
  const button = document.querySelector('button[aria-label="Clear prompt"]');
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2, vv = window.visualViewport;
  const ox = Math.round(vv?.offsetLeft || 0), oy = Math.round(vv?.offsetTop || 0);
  const under = document.elementFromPoint(cx, cy), hitButton = under?.closest?.('button');
  const hit = hitButton === button ? 'clear button' : under ? `${under.tagName.toLowerCase()}${hitButton ? ` in button "${(hitButton.getAttribute('aria-label') || hitButton.innerText || '').trim().slice(0, 30)}"` : ''}` : 'nothing';
  return {x: cx - ox, y: cy - oy, hit, view: `page ${innerWidth}x${innerHeight}, visible ${Math.round(vv?.width || innerWidth)}x${Math.round(vv?.height || innerHeight)} at ${ox},${oy} zoom ${vv?.scale || 1}`};
}

// Closes the phone keyboard before the × is measured (the mobile worker does the same before its other taps).
function pg_flowBlurPromptEditor() {
  const active = document.activeElement;
  if (!active?.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]')) return false;
  active.blur();
  return true;
}

// Last resort when trusted taps do not clear the draft: press the × from inside the page.
function pg_flowClearDraftByScript(pointOnly = false) {
  const button = document.querySelector('button[aria-label="Clear prompt"]');
  if (!button || button.disabled) return false;
  if (pointOnly) { const r = button.getBoundingClientRect(); return {clickAt: {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}}; }
  button.click();
  return true;
}

// kind 'image': Flow image results are grid tiles holding a flow-image-tile. Verified live (Text to Image and Image to Image,
// 2026-10-10): the new tile shows "0%…100%" while a flow-pending-tile is inside, stays the SAME element until the picture
// (flow-content.google/image/…) arrives, and is placed first in the grid. Old tiles are marked before Send and never match.
function pg_flowStartResultTracking(key, expectedTiles = 1, kind = 'video', parallel = false, promptHead = '') {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  // Parallel in Flow (1.13.38): several prompts render at once in ONE project, so every prompt keeps its own tracker.
  // Serial runs (parallel=false) behave exactly as before: one tracker, older trackers stopped.
  const trackers = window.__flowStudioResultTrackers || (window.__flowStudioResultTrackers = {});
  if (!parallel) {
    window.__flowStudioResultTracker?.observer?.disconnect();
    for (const other of Object.values(trackers)) other.observer?.disconnect();
    window.__flowStudioResultTrackers = {};
  }
  const image = kind === 'image';
  const tiles = () => image
    ? Array.from(document.querySelectorAll('flow-grid-tile-container')).filter(tile => tile.querySelector('flow-image-tile'))
    : Array.from(document.querySelectorAll('flow-video-tile'));
  const progress = tile => /\b\d{1,3}\s*%/.test(tile.innerText || '');
  // Nothing else is rendering at submission, so every new rendering tile
  // belongs to this prompt. Outputs x2-x4 produce that many tiles: the first
  // one in grid order is the main result, the others are saved after it as
  // _2/_3/_4 (user report 2026-10-18: "chose 4 but it downloads only one").
  // More tiles than requested is ambiguous.
  const claimed = tile => !!markOf(tile, 'sub');
  // Parallel: tiles of the other prompts in flight are claimed (tagged) and may keep rendering; only an UNCLAIMED
  // rendering tile (nobody knows whose it is) blocks a new submission.
  if (parallel ? tiles().some(tile => progress(tile) && !claimed(tile)) : tiles().some(progress)) return {ok:false,error:`Flow already has a rendering ${image ? 'image' : 'video'}. Wait for it to finish before submitting another prompt.`};
  // Image tiles already on the page can never become this prompt's result (an old picture Flow draws again included).
  const before = new Set(tiles());
  const allowed = Math.max(1, Number(expectedTiles) || 1);
  const norm = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const head = norm(promptHead).slice(0, 60);
  const tracker = {key, kind, tile:null, tiles:[], identity:null, identities:{}, error:null, before, parallel:!!parallel, open:!!parallel, head, allowed, slots:[], tilesFn:tiles};
  // Flow RE-CREATES video tiles that are still rendering whenever a new video starts (live test 2026-10-18), so an
  // element reference is not stable. A tile's grid position is: new tiles are added at one end, so a claimed tile moves
  // only by the number of tiles added after it. Re-tag re-created tiles of every prompt in flight before anyone claims.
  window.__flowStudioRetag = () => {
    for (const owner of Object.values(window.__flowStudioResultTrackers || {})) {
      if (!owner.parallel || !owner.slots?.length) continue;
      const list = owner.tilesFn();
      owner.tiles.forEach((element, index) => {
        if (element?.isConnected && list.includes(element)) return;
        const slot = owner.slots[index];
        if (!slot) return;
        const position = slot.front ? slot.index + (list.length - slot.total) : slot.index;
        const candidate = list[position];
        const want = index ? `${owner.key}#${index + 1}` : owner.key;
        if (!candidate) return;
        const tag = markOf(candidate, 'sub');
        if (tag && tag !== want) return;
        flowMarks.sub.set(candidate, want);
        owner.tiles[index] = candidate; if (!index) owner.tile = candidate;
      });
    }
  };
  // A finished result (loaded web picture) can never be a prompt that was sent seconds ago (Flow may redraw an older,
  // finished tile of another prompt while this one is being sent).
  // A refused tile can still show the start image, so a refusal message means "not finished" (it is claimable).
  const refused = tile => /failed|violat|polic(?:y|ies)|something went wrong|could not generate|unable to generate|try a different prompt/i.test(tile.innerText || '');
  const finished = tile => !progress(tile) && !refused(tile) && Array.from(tile.querySelectorAll?.('img') || []).some(img => /^https:\/\//i.test(img.currentSrc || img.src || '') && img.complete && img.naturalWidth > 0);
  // Flow also RE-CREATES old "Failed" tiles of earlier prompts when a new video starts (live test 2026-10-19: one refusal
  // made every later prompt "ambiguous"). A refused tile is this prompt's only when the number of retired/new refused tiles
  // on the page grew since this prompt started; a re-created old one does not change that number.
  // Include retired attempts even while tagged: a remount losing its tag is not a new refusal.
  const refusedCount = () => tiles().filter(tile => refused(tile) && !progress(tile)
    // A different active prompt turning into a refusal is still its owner's result.
    && !Object.values(window.__flowStudioResultTrackers || {}).some(owner => owner !== tracker && owner.tiles?.includes(tile))).length;
  const refusedBefore = parallel ? refusedCount() : 0;
  // A tile that shows ANOTHER in-flight prompt's text belongs to that prompt (Flow shows the prompt while it loads).
  const othersText = tile => { const text = norm(tile.innerText); return Object.values(window.__flowStudioResultTrackers || {}).some(other => other !== tracker && other.head && other.head.length >= 20 && text.includes(other.head) && !(head.length >= 20 && text.includes(head))); };
  const scan = () => {
    if (tracker.parallel) window.__flowStudioRetag?.();
    if (tracker.error || tracker.tiles.length >= allowed) return;
    if (tracker.parallel && !tracker.open) return;
    // Parallel claim window (from just before Send until the panel releases the Flow page): only this prompt is being
    // sent, so every new unclaimed tile is this prompt's, including a tile Flow refused at once (no % shown).
    // Old completed tiles briefly lose their thumbnails during a grid redraw.
    // Wait for rendering/refusal/prompt evidence rather than claiming blank skeletons.
    let fresh = tracker.parallel
      ? tiles().filter(tile => !before.has(tile) && !claimed(tile) && !finished(tile) && !othersText(tile)
        && (progress(tile) || refused(tile) || (head.length >= 20 && norm(tile.innerText).includes(head))))
      : tiles().filter(tile => progress(tile) && !tracker.tiles.includes(tile) && !(image && before.has(tile)));
    if (tracker.parallel) {
      const freshRefused = fresh.filter(tile => refused(tile) && !progress(tile));
      if (freshRefused.length) {
        const room = Math.max(0, refusedCount() - refusedBefore), list = tiles(), newestFirst = window.__flowStudioNewTilesFirst !== false;
        freshRefused.sort((a, b) => newestFirst ? list.indexOf(a) - list.indexOf(b) : list.indexOf(b) - list.indexOf(a));
        const keep = new Set(freshRefused.slice(0, room));
        fresh = fresh.filter(tile => !freshRefused.includes(tile) || keep.has(tile));
      }
    }
    if (!fresh.length) return;
    if (tracker.tiles.length + fresh.length > allowed) {
      // Before the main tile is known this is ambiguous; afterwards only the extra outputs stop being collected.
      if (!tracker.tile) tracker.error = 'More new rendering tiles appeared than requested; result is ambiguous';
      else tracker.tiles.length = allowed;
      return;
    }
    fresh.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return Math.abs(ra.top - rb.top) > 40 ? ra.top - rb.top : ra.left - rb.left;
    });
    const list = tracker.parallel ? tiles() : null;
    for (const tile of fresh) {
      flowMarks.sub.set(tile, tracker.tiles.length ? `${key}#${tracker.tiles.length + 1}` : key);
      tracker.tiles.push(tile);
      if (list) {
        // Which end Flow adds new tiles to: learnt from the first claim on a grid with 2+ tiles, then remembered.
        const index = list.indexOf(tile);
        if (list.length >= 2 && window.__flowStudioNewTilesFirst === undefined) window.__flowStudioNewTilesFirst = index <= (list.length - 1) / 2;
        tracker.slots.push({index, total:list.length, front:window.__flowStudioNewTilesFirst ?? true});
      }
    }
    tracker.tile = tracker.tiles[0];
  };
  tracker.observer = new MutationObserver(scan);
  tracker.observer.observe(document.body, {childList:true,subtree:true,characterData:true,attributes:true});
  if (parallel) window.__flowStudioResultTrackers[key] = tracker; else window.__flowStudioResultTracker = tracker;
  return {ok:true};
}

// Parallel: how many tiles this prompt has claimed so far; close=true ends its claim window (the next prompt may be sent).
function pg_flowClaimWindow(key, close = false) {
  const tracker = window.__flowStudioResultTrackers?.[key];
  if (!tracker) return {ok:false,error:'Submission tracker was lost'};
  if (close) tracker.open = false;
  return {ok:true,count:tracker.tiles.length,expected:tracker.allowed,error:tracker.error || null};
}

function pg_flowTrackedResult(key, index = 0) {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  const tracker = window.__flowStudioResultTrackers?.[key] || window.__flowStudioResultTracker;
  if (!tracker || tracker.key !== key) return {ready:false,error:'Submission tracker was lost'};
  if (tracker.error) return {ready:false,error:tracker.error};
  if (tracker.parallel) window.__flowStudioRetag?.();
  let tile = index ? tracker.tiles?.[index] : tracker.tile;
  if (!tile) return {ready:false,waiting:true};
  if (!tile.isConnected && tracker.parallel && tracker.head.length >= 20) {
    // Flow redrew the tile: take it back only when exactly one unclaimed tile shows THIS prompt's text.
    const norm = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const matches = Array.from(document.querySelectorAll(tracker.kind === 'image' ? 'flow-grid-tile-container' : 'flow-video-tile'))
      .filter(candidate => !markOf(candidate, 'sub') && norm(candidate.innerText).includes(tracker.head));
    if (matches.length === 1) {
      flowMarks.sub.set(matches[0], index ? `${key}#${index + 1}` : key);
      tracker.tiles[index] = matches[0]; if (!index) tracker.tile = matches[0]; tile = matches[0];
    }
  }
  if (!tile.isConnected) return {ready:false,error:'Tracked rendering tile was replaced; result cannot be confirmed safely'};
  const keyOf = src => String(src || '').split('?')[0].split('#')[0];
  const text = tile.innerText || '';
  const percentage = text.match(/\b(\d{1,3})\s*%/);
  if (tracker.kind === 'image') {
    // Done = no percentage, no pending overlay, and a loaded full-size web picture inside THIS tile.
    const picture = Array.from(tile.querySelectorAll('img')).find(img => /^https:\/\//i.test(img.currentSrc || img.src || '') && img.complete && img.naturalWidth >= 256);
    const pending = !!tile.querySelector('flow-pending-tile');
    const src = picture ? (picture.currentSrc || picture.src) : '';
    return {ready:!percentage && !pending && !!src, progressPercent:percentage?Number(percentage[1]):null, src,
      width:picture?.naturalWidth || 0, height:picture?.naturalHeight || 0, title:tile.getAttribute('aria-label') || tile.querySelector('.footer-title')?.textContent || ''};
  }
  // The alt text is translated in other Flow languages: fall back to the tile's own loaded web image.
  const image = tile.querySelector('img[alt="Generated video thumbnail"]')
    || tile.querySelector('img[alt="Nabuong thumbnail ng video"]')
    || Array.from(tile.querySelectorAll?.('img') || []).find(img => /^https:\/\//i.test(img.currentSrc || img.src || '') && img.complete && img.naturalWidth > 0);
  const video = tile.querySelector('video');
  const poster = keyOf(image?.currentSrc || image?.src);
  const videoSource = keyOf(video?.currentSrc || video?.src);
  const known = tracker.identities || (tracker.identities = {});
  if (!percentage && poster) known[index] = {posterSources:[poster]};
  if (!index && known[0]) tracker.identity = known[0];
  const identity = {tileId:markOf(tile, 'res') || null,
    posterSources:poster?[poster]:(known[index]?.posterSources || []),videoSource:videoSource||null};
  return {ready:!percentage && !!(poster || (videoSource && video.readyState >= 1)),progressPercent:percentage?Number(percentage[1]):null,identity,title:tile.querySelector('.footer-title')?.textContent || ''};
}

function pg_flowStopResultTracking(key) {
  const tracker = window.__flowStudioResultTracker;
  if (tracker?.key === key) { tracker.observer?.disconnect(); delete window.__flowStudioResultTracker; }
  const parallel = window.__flowStudioResultTrackers?.[key];
  if (parallel) { parallel.observer?.disconnect(); delete window.__flowStudioResultTrackers[key]; }
}

function pg_flowVideoSnapshot(selectors) {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  selectors = selectors || { video: 'video' };
  const sources = Array.from(document.querySelectorAll(selectors.video || 'video'))
    .map((video) => video.currentSrc || video.src)
    .filter(Boolean);
  // Flow leaves old cards as posters until hovered, so video URLs alone
  // cannot identify the results that already existed before submission.
  for (const tile of new Set([...document.querySelectorAll('flow-video-tile'), ...document.querySelectorAll('flow-grid-tile-container, flow-tile-container')])) {
    let id = markOf(tile, 'res');
    if (!id) { id = `${Date.now()}-${Math.random().toString(36).slice(2)}`; flowMarks.res.set(tile, id); }
    sources.push(`tile:${id}`);
    for (const img of tile.querySelectorAll('img')) {
      if (img.currentSrc || img.src) sources.push(`poster:${img.currentSrc || img.src}`);
    }
  }
  // Same normalization as pg_flowCheckStatus: generated titles are not warning text.
  const scopeText = (element) => {
    let value = String(element.innerText || '');
    const title = element.querySelector?.('.footer-title')?.textContent;
    if (title && title.trim()) value = value.split(title).join(' ');
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  };
  // Image tiles too: a failed image ("Failed / We noticed some unusual activity") is a grid tile, not a flow-video-tile.
  const failureBaselineScopes = Array.from(document.querySelectorAll('flow-video-tile,flow-grid-tile-container,[role="alert"]'))
    .map(scopeText).filter(Boolean);
  return { sources, count: sources.length, failureBaselineText: (document.body?.innerText || '').toLowerCase(), failureBaselineScopes };
}

// The completed video card: reports a hover point (the panel CDP-moves the
// real mouse there to activate the card's CSS :hover overlay buttons), any
// Download/⋮ button already in the card DOM, and the card's top-right corner
// as the usual overlay-button location fallback.
function pg_flowVideoCardPoint(excludeSourcesArg, expectedResult = null) {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  // Target THIS prompt's video: sources present before submission are passed
  // in as excludeSources, so older completed videos in the same project can
  // never steal the hover. Among the remaining, the newest card renders
  // highest, so topmost wins; size is only the tiebreaker.
  const sourceKey = value => String(value || '').split('?')[0].split('#')[0];
  const exclude = new Set((excludeSourcesArg || []).filter(Boolean).map(sourceKey));
  // Observed live: hovering replaces /image/<asset UUID> with
  // /video/<the same UUID> and removes the <img> entirely. Compare the
  // exact Flow asset ID across these two transports, never card position.
  const assetKey = value => {
    const source = sourceKey(value);
    const flow = /^https:\/\/flow-content\.google\/(?:image|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(source);
    return flow ? `flow-asset:${flow[1].toLowerCase()}` : source;
  };
  const mediaSources = tile => [...tile.querySelectorAll('img'), ...tile.querySelectorAll('video')]
    .flatMap(media => [media.currentSrc,media.src]).filter(Boolean);
  const excludeAssets = new Set((excludeSourcesArg || []).filter(Boolean).map(src=>assetKey(String(src).replace(/^poster:/,''))));
  const resultCard = element => element.closest('flow-video-tile') || element.closest('flow-grid-tile-container, flow-tile-container');
  const matchesExpected = element => {
    if (!expectedResult) return true;
    const tile = resultCard(element) || element;
    const wanted = (expectedResult.posterSources?.length ? expectedResult.posterSources
      : [expectedResult.videoSource]).filter(Boolean).map(assetKey);
    if (wanted.length) return mediaSources(tile).some(src=>wanted.includes(assetKey(src)));
    return !!expectedResult.tileId && markOf(tile, 'res') === expectedResult.tileId;
  };
  const excludedCard = element => {
    const tile = resultCard(element);
    if (!tile) return false;
    if (exclude.has(`tile:${markOf(tile, 'res')}`)) return true;
    return mediaSources(tile).some(src => excludeAssets.has(assetKey(src)));
  };
  const candidates = Array.from(document.querySelectorAll('video'))
    .filter((v) => visible(v) && (v.currentSrc || v.src) && v.readyState >= 1 && !excludeAssets.has(assetKey(v.currentSrc || v.src)) && !excludedCard(v) && matchesExpected(v))
    // A hover/player portal can mount an older video that was absent in the
    // baseline. It is not evidence of a new result without its result card.
    .filter(v => !excludeSourcesArg || !!resultCard(v))
    .map((v) => {
      const rect = v.getBoundingClientRect();
      return {
        v,
        rect,
        isNew: !exclude.has(v.currentSrc || v.src),
        top: rect.top,
        area: v.videoWidth * v.videoHeight,
      };
    });
  candidates.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;   // new video first
    if (Math.abs(a.top - b.top) > 40) return a.top - b.top; // highest = newest
    return b.area - a.area;                                 // bigger ties win
  });
  let video = candidates[0] && candidates[0].v;
  // 2026-10-02: no <video> is mounted until a card is hovered - fall back to the newest finished poster card
  // (topmost, then leftmost) so the panel can hover it, which mounts the video and reveals the card's buttons.
  let posterCard = null;
  // Prefer the actual result tile, even when a hover player is mounted.
  // Player wrappers can have different bounds/ancestors and transient URLs;
  // choosing them first can discard the tile's confirmed thumbnail identity.
  // Grid order only ranks tiles that already pass the exact identity filter.
  const flowCards = Array.from(document.querySelectorAll('flow-video-tile')).filter(tile => {
    const thumbnail = tile.querySelector('img[alt="Generated video thumbnail"]');
    const media = tile.querySelector('video');
    const finished = !!(thumbnail && (thumbnail.currentSrc || thumbnail.src)) || !!(media && (media.currentSrc || media.src) && media.readyState >= 1);
    return visible(tile) && !excludedCard(tile) && finished && matchesExpected(tile) && !/\b\d{1,3}\s*%/.test(textOf(tile));
  });
  flowCards.sort((a,b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return Math.abs(ra.top-rb.top) > 40 ? ra.top-rb.top : ra.left-rb.left;
  });
  if (flowCards.length) { posterCard = flowCards[0]; video = null; }
  if (!video && !posterCard) {
    const seen = new Set();
    const cards = [];
    for (const leaf of Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && (e.textContent || '').trim() === 'play_circle')) {
      if (leaf.closest('flow-video-tile')) continue;
      let node = leaf;
      for (let i = 0; i < 10 && node.parentElement; i++) {
        node = node.parentElement;
        const r0 = node.getBoundingClientRect();
        if (r0.width > 100 && r0.height > 150 && r0.height < 520) break;
      }
      if (!visible(node)) continue;
      if (!matchesExpected(node) || Array.from(node.querySelectorAll('img')).some(img => exclude.has(`poster:${sourceKey(img.currentSrc || img.src)}`))) continue;
      const r = node.getBoundingClientRect();
      const key = `${Math.round(r.left)},${Math.round(r.top)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (/\b\d{1,3}%\b|generating|processing|rendering|queued|loading/.test(textOf(node))) continue;
      cards.push(node);
    }
    cards.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 40) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    posterCard = cards[0] || null;
  }
  const anchor = video || posterCard;
  if (!anchor) return { ok: false, error: 'No completed video card found' };
  try { anchor.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch { /* ignore */ }
  const videoRect = anchor.getBoundingClientRect();
  let card = anchor;
  const tile = anchor.closest('flow-grid-tile-container, flow-tile-container, flow-video-tile');
  if (tile) {
    card = tile;
  } else if (!posterCard) {
    for (let depth = 0; depth < 7 && card.parentElement; depth++) {
      card = card.parentElement;
      const rect = card.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 160 && rect.height < 900) break;
    }
  }
  const cardRect = card.getBoundingClientRect();
  const buttons = Array.from(card.querySelectorAll('button, [role="button"], [aria-label]'))
    .filter((item) => {
      if (!visible(item)) return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 8 && rect.width <= 60 && rect.height > 8 && rect.height <= 60;
    })
    .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
    .filter(({ text }) => /download|more_vert|more options|kebab|ellipsis|\bmore\b/.test(text));
  const download = buttons.find(({ text }) => /\bdownload\b/.test(text)) || buttons[0] || null;
  const pointOf = (rect) => ({
    x: Math.max(1, Math.min(window.innerWidth - 2, rect.left + rect.width / 2)),
    y: Math.max(1, Math.min(window.innerHeight - 2, rect.top + rect.height / 2)),
  });
  const cardVideo = video || card.querySelector('video');
  const identity = {
    tileId: markOf(card, 'res') || null,
    posterSources: Array.from(card.querySelectorAll('img')).map(img => sourceKey(img.currentSrc || img.src)).filter(Boolean),
    videoSource: cardVideo ? sourceKey(cardVideo.currentSrc || cardVideo.src) : null,
  };
  // Flow virtualizes its grid: scrolling elsewhere can unmount a confirmed
  // tile. Remember the viewport where THIS result was actually observed so
  // download lookup can restore it without choosing a different result.
  const scrollParents = [];
  for (let parent = card.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
      scrollParents.push({element:parent,top:parent.scrollTop,left:parent.scrollLeft});
    }
  }
  const views = window.__flowStudioResultViews || (window.__flowStudioResultViews = new Map());
  const view = {x:window.scrollX || 0,y:window.scrollY || 0,parents:scrollParents};
  for (const key of [...identity.posterSources, identity.videoSource].filter(Boolean)) {
    views.delete(key);
    views.set(key, view);
  }
  while (views.size > 40) views.delete(views.keys().next().value);
  return {
    ok: true,
    identity,
    hover: pointOf(videoRect),
    button: download ? { ...pointOf(download.rect), text: download.text } : null,
    corner: {
      x: Math.max(1, Math.min(window.innerWidth - 2, cardRect.right - 22)),
      y: Math.max(1, Math.min(window.innerHeight - 2, cardRect.top + 22)),
    },
  };
}

function pg_flowRestoreConfirmedVideoView(expectedResult) {
  const views = window.__flowStudioResultViews;
  const keyOf = src => String(src || '').split('?')[0].split('#')[0];
  const keys = [...(expectedResult?.posterSources || []), expectedResult?.videoSource].filter(Boolean).map(keyOf);
  const view = keys.map(key => views?.get(key)).find(Boolean);
  if (!view) return {restored:false};
  for (const parent of [...view.parents].reverse()) {
    if (!parent.element.isConnected) continue;
    try { parent.element.scrollTo({top:parent.top,left:parent.left,behavior:'instant'}); }
    catch { parent.element.scrollTop = parent.top; parent.element.scrollLeft = parent.left; }
  }
  window.scrollTo({left:view.x,top:view.y,behavior:'instant'});
  return {restored:true};
}

// Best match for a text pattern among currently open menu/popover items (or
// compact buttons anywhere when no menu container is identifiable). Returns a
// trusted-click point, the item text, and its href when it is an anchor.
// The rows of every menu that is open now, e.g. ["Favorite", "Download", "360p Original size"]. Used for the log when the
// Download list does not show its sizes (owner 2026-11-10: several members, cause not visible without it).
function pg_flowOpenMenuTexts() {
  const visible = e => { const r = e.getBoundingClientRect(), st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const rows = [];
  for (const menu of Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')).filter(visible))
    for (const item of Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, a[href]')).filter(visible)) {
      const text = (item.innerText || item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (text) rows.push(text + (item.matches(':disabled, [aria-disabled="true"]') ? ' (off)' : ''));
    }
  return rows.slice(0, 30);
}

function pg_flowMenuItemPoint(patternSource, rejectSource) {
  const pattern = new RegExp(String(patternSource || ''), 'i');
  const reject = rejectSource ? new RegExp(rejectSource, 'i') : null;
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const menus = Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"], [class*="popover" i], [class*="dropdown" i]')).filter(visible);
  const scopes = menus.length ? menus : [document];
  const candidates = [];
  for (const scope of scopes) {
    for (const item of Array.from(scope.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [role="button"], [role="option"], a[href], div, span'))) {
      if (!visible(item)) continue;
      // Read the entire clickable row: a label span alone hides captions
      // such as "Animated GIF" and the disabled state of its parent button.
      const actionable = item.closest('button, [role="menuitem"], [role="menuitemradio"], [role="button"], [role="option"], a[href]');
      if (actionable && actionable !== item) continue;
      if (item.matches(':disabled, [aria-disabled="true"]')) continue;
      const text = textOf(item);
      if (!text || text.length > 240) continue;
      if (reject && reject.test(text)) continue;
      if (!pattern.test(text)) continue;
      const rect = item.getBoundingClientRect();
      if (rect.width <= 0 || rect.width > 320 || rect.height <= 0 || rect.height > 80) continue;
      candidates.push({ item, text, rect, inMenu: menus.includes(scope) || !!item.closest('[role="menu"], [role="dialog"], [role="listbox"]') });
    }
  }
  candidates.sort((a, b) => {
    const score = (c) => (c.inMenu ? 3000 : 0) +
      (c.item.matches('button, [role="menuitem"], [role="menuitemradio"], [role="option"], a[href]') ? 2000 : 0) +
      (/original size|original resolution/.test(c.text) ? 1000 : 0) +
      (c.text.length <= 24 ? 800 : 0) - c.text.length;
    return score(b) - score(a);
  });
  const best = candidates[0];
  if (!best) return { ok: false, error: `No menu item matching ${patternSource}` };
  return {
    ok: true,
    x: Math.max(1, Math.min(window.innerWidth - 2, best.rect.left + best.rect.width / 2)),
    y: Math.max(1, Math.min(window.innerHeight - 2, best.rect.top + best.rect.height / 2)),
    text: best.text,
    href: best.item.tagName === 'A' ? best.item.href : null,
  };
}

// Flow image outputs saved in this panel session, by content (SHA-256) → prompt id.
const flowSavedImages = new Map();
async function flowImageFingerprint(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Tiles Flow marks "Failed / Failed to load image." after a rejected upload.
// Counted rather than named: a failed tile does not show its filename.
function pg_flowFailedUploadCount() {
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  return Array.from(document.querySelectorAll('div, span, p'))
    .filter(element => !element.children.length && /^failed to load image\.?$/i.test(String(element.textContent || '').trim()) && visible(element)).length;
}

function pg_flowExistingImages(fileNames) {
  const normalize = name => String(name || '').trim().split(/[\\/]/).pop().toLowerCase();
  const wanted = new Set((fileNames || []).map(normalize));
  const stem = name => normalize(name).replace(/\.(?:png|jpe?g|webp|gif|avif)$/i, '');
  const resolveName = value => {
    const name = normalize(value);
    if (wanted.has(name)) return name;
    // Some Flow cards omit the image extension. Never guess between two files
    // sharing that basename, and never use substring matching (char_1/char_10).
    if (/\.(?:png|jpe?g|webp|gif|avif)$/i.test(name)) return null;
    const matches = Array.from(wanted).filter(file => stem(file) === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const found = new Set();
  const attached = new Set();
  const mediaKey = src => String(src || '').split('?')[0];
  const composerSources = new Set(Array.from(document.querySelectorAll('img[alt="Ingredient image"]')).map(img => mediaKey(img.currentSrc || img.src)));
  for (const tile of document.querySelectorAll('flow-grid-tile-container, flow-image-tile')) {
    const thumbnail = tile.querySelector('img[alt="Tile displaying a user\'s image"], img[alt="Tile na nagpapakita ng larawan ng user"], flow-image-tile img')
      || (tile.matches?.('flow-image-tile') ? tile.querySelector('img') : null);
    if (!thumbnail || !(thumbnail.currentSrc || thumbnail.src) || !thumbnail.complete || !(thumbnail.naturalWidth > 0)) continue;
    // A loaded preview can appear while Flow is still processing the upload.
    const progress = tile.querySelector('[role="progressbar"], [aria-busy="true"]');
    if (progress && (progress.getAttribute?.('aria-busy') === 'true' || progress.getAttribute?.('aria-valuenow') !== '100')) continue;
    const labels = [tile, thumbnail, ...tile.querySelectorAll('.footer-title, [role="button"], button, [title], [aria-label], [data-filename], [data-file-name]')];
    for (const label of labels) {
      const values = [label.textContent, ...['title', 'aria-label', 'data-filename', 'data-file-name'].map(attr => label.getAttribute?.(attr))];
      for (const value of values) {
        const name = resolveName(value);
        if (name) {
          found.add(name);
          if (composerSources.has(mediaKey(thumbnail.currentSrc || thumbnail.src))) attached.add(name);
        }
      }
    }
  }
  return { names: Array.from(found), attachedNames: Array.from(attached) };
}

// mode (owner 2026-11-07): undefined = phone worker (opens "+" itself); 'direct' = use a file input that is already there,
// else return the "+" point for a real mouse click; 'after-menu' = that click was made, set the input it showed.
async function pg_flowAttachStart(fileB64s, settleMs, selectors, mode) {
  selectors = selectors || { uploadInput: 'input[type="file"]' };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const clickElement = (element) => {
    if (!element) return false;
    const target = element.closest?.('button, [role="button"], [role="menuitem"], [role="option"], a[href]') || element;
    try {
      if (typeof target.click === 'function') target.click();
    } catch { /* continue with synthetic events */ }
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y) || target;
    let sent = false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      let event = null;
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y });
      } else if (typeof MouseEvent === 'function') {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      } else if (typeof Event === 'function') {
        event = new Event(type, { bubbles: true, cancelable: true });
      }
      if (event) {
        hit.dispatchEvent(event);
        if (hit !== target) target.dispatchEvent(event);
        sent = true;
      }
    }
    return sent;
  };
  const clickPoint = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    return hit ? clickElement(hit) : false;
  };
  const findPromptEditor = () => Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  let preComposerUploadInputs = [];
  const openComposerUpload = async () => {
    preComposerUploadInputs = Array.from(document.querySelectorAll(selectors.uploadInput || 'input[type="file"]'));
    const editor = findPromptEditor();
    if (!editor) return { ok: false, error: 'Flow prompt editor not found before composer upload' };
    const editorRect = editor.getBoundingClientRect();
    const composer = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], div'))
      .filter(visible)
      .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
      .filter(({ text, rect }) =>
        rect.top > window.innerHeight * 0.55 &&
        rect.width > 260 &&
        rect.height > 45 &&
        rect.height < 180 &&
        rect.left <= editorRect.left + 120 &&
        rect.right >= editorRect.right - 80 &&
        /agent|video|what do you want|create|change|nano banana/.test(text)
      )
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0] || { rect: editorRect };
    // Flow's own labelled + button first (owner run 2026-11-13, Motion Studio: with a reference chip already in the prompt
    // box, the guess below took the chip and the real click removed the video). The guess never takes a chip.
    const labelledPlus = Array.from(document.querySelectorAll('button[aria-label]')).find((item) => visible(item) && /^add ingredients to the prompt box$/i.test(item.getAttribute('aria-label') || ''));;
    const plusButton = labelledPlus ? {item: labelledPlus, rect: labelledPlus.getBoundingClientRect()} : Array.from(document.querySelectorAll('button, [role="button"], [aria-label], div, span'))
      .filter(visible)
      .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
      .filter(({ item, text, rect }) => {
        const nearComposer = rect.top >= composer.rect.top - 18 && rect.bottom <= composer.rect.bottom + 18;
        const leftSide = rect.left >= composer.rect.left - 8 && rect.left <= composer.rect.left + 95;
        const small = rect.width >= 18 && rect.width <= 74 && rect.height >= 18 && rect.height <= 74;
        return nearComposer && leftSide && small && !/agent|video|10s|x1|settings|crop|trash|delete|ingredient/.test(text) && !item.closest?.('[class*="chip"], [aria-label="Ingredient"]');
      })
      .sort((a, b) => (a.rect.left + a.rect.top) - (b.rect.left + b.rect.top))[0];
    if (mode === 'direct' || mode === 'point') {
      window.__flowAttachPreInputs = preComposerUploadInputs;
      const r = plusButton ? plusButton.rect : null;
      return { ok: true, menuPoint: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: composer.rect.left + 24, y: composer.rect.bottom - 24 } };
    }
    const opened = (plusButton ? clickElement(plusButton.item) : false) ||
      clickPoint(composer.rect.left + 24, composer.rect.bottom - 24);
    if (!opened) return { ok: false, error: 'Flow composer + button not found' };
    // Never click the menu's "Upload media" item. Its handler calls
    // fileInput.click(), and while the transient user activation from our
    // trusted CDP input (settings/submit) is still live, Chrome honors that
    // call and opens the NATIVE OS file picker — stalling the whole run.
    // Opening the attach menu alone is enough: Flow mounts its <input
    // type=file> then, and the caller sets .files on it programmatically.
    for (let wait = 0; wait < 20; wait++) {
      await sleep(200);
      const inputs = Array.from(document.querySelectorAll(selectors.uploadInput || 'input[type="file"]'));
      const fresh = inputs.filter((item) => !preComposerUploadInputs.includes(item) && !item.disabled);
      const anyEnabled = inputs.filter((item) => !item.disabled);
      if (fresh.length || (anyEnabled.length && !preComposerUploadInputs.length)) {
        return { ok: true, method: 'plus-menu-file-input' };
      }
    }
    return { ok: false, error: 'Flow file input did not appear after opening the attach menu' };
  };
  const waitForMenuInput = async () => {
    preComposerUploadInputs = window.__flowAttachPreInputs || [];
    for (let wait = 0; wait < 20; wait++) {
      const inputs = Array.from(document.querySelectorAll(selectors.uploadInput || 'input[type="file"]'));
      if (inputs.some((item) => !preComposerUploadInputs.includes(item) && !item.disabled) || (inputs.some((item) => !item.disabled) && !preComposerUploadInputs.length)) return { ok: true };
      await sleep(200);
    }
    return { ok: false, error: 'Flow file input did not appear after opening the attach menu' };
  };
  const files = (fileB64s || []).map((f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name, { type: f.type || 'image/png' });
  });
  // 'point' (owner 2026-11-08): only where the + button is, for the panel's real click; nothing on the page changes.
  if (mode === 'point') { const plus = await openComposerUpload(); return plus.ok ? {state: 'needs-menu', point: plus.menuPoint} : {state: 'error', error: plus.error}; }
  window.__flowAttach = {
    state: 'working',
    want: files.length,
    names: files.map((file) => file.name),
    start: Date.now(),
    stableSince: 0,
    settleMs: Number(settleMs) || 6000,
    method: null,
    error: null,
  };
  if (!files.length) {
    window.__flowAttach = { state: 'done', want: 0, count: 0, method: 'none' };
    return { state: 'done', want: 0, count: 0 };
  }
  try {
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    const setFiles = (input) => {
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Route 1 — direct: if the page already exposes an enabled file input,
    // set it without opening any menu. Zero clicks means zero chance of a
    // trusted-click path ever summoning the native OS file picker.
    const latentInputs = Array.from(document.querySelectorAll(selectors.uploadInput || 'input[type="file"]')).filter((item) => !item.disabled);
    if (latentInputs.length) {
      setFiles(latentInputs[latentInputs.length - 1]);
      window.__flowAttach.method = 'latent-file-input';
      return { state: 'working', method: window.__flowAttach.method, count: files.length };
    }
    // Route 2 — composer menu: open "+" (never "Upload media" itself — see the
    // user-activation note inside), then set whatever file input appeared.
    if (mode === 'direct') {
      const plus = await openComposerUpload();
      window.__flowAttach = plus.ok ? { state: 'idle' } : { state: 'error', want: files.length, count: 0, error: plus.error };
      return plus.ok ? { state: 'needs-menu', point: plus.menuPoint } : window.__flowAttach;
    }
    const opened = mode === 'after-menu' ? await waitForMenuInput() : mode === 'drop' ? null : await openComposerUpload();
    const inputs = Array.from(document.querySelectorAll(selectors.uploadInput || 'input[type="file"]'));
    const newInputs = inputs.filter((item) => !preComposerUploadInputs.includes(item));
    const enabledInputs = inputs.filter((item) => !item.disabled);
    const input = mode === 'drop' ? null : newInputs.find((item) => !item.disabled) || enabledInputs[enabledInputs.length - 1] || null;
    if (input) {
      setFiles(input);
      window.__flowAttach.method = 'composer-file-input';
      return { state: 'working', method: window.__flowAttach.method, count: files.length };
    }
    // The panel closes the "+" menu (Esc) before the drop, so it does not stay open over the page.
    if (mode === 'after-menu') {
      window.__flowAttach = { state: 'idle' };
      return { state: 'needs-drop', note: opened && opened.error };
    }
    // Route 3 — drop onto the composer. Owner tried removing this on 2026-11-07, but Flow's "+" menu on computers no
    // longer creates a file field, so the drop is how Flow actually takes the photos; it only runs when no field exists.
    const dropTarget = findPromptEditor() ||
      document.querySelector(selectors.uploadDropTarget || 'main') ||
      document.body;
    try {
      dropTarget.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      dropTarget.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      dropTarget.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch { /* the poll reports it if Flow did not take the photos */ }
    window.__flowAttach.method = 'drop-paste';
    return { state: 'working', method: 'drop-paste', count: files.length, note: opened && opened.error };
  } catch (e) {
    window.__flowAttach.state = 'error';
    window.__flowAttach.error = String(e && e.message ? e.message : e);
    return window.__flowAttach;
  }
}

function pg_flowAttachPoll(projectImages) {
  const state = window.__flowAttach || { state: 'done', want: 0, count: 0 };
  const now = Date.now();
  if (state.state === 'working') {
    const text = `${document.body ? document.body.innerText || '' : ''}`.toLowerCase().replace(/\s+/g, ' ');
    const names = Array.isArray(state.names) ? state.names : [];
    const readyNames = new Set((projectImages?.names || []).map(name => String(name).toLowerCase()));
    const readyCount = names.filter(name => readyNames.has(String(name).toLowerCase())).length;
    const projectHasAll = names.length > 0 && readyCount === names.length;
    const matchedNames = names.filter((name) => text.includes(String(name || '').toLowerCase()));
    const bottomImages = Array.from(document.querySelectorAll('img, video'))
      .filter((item) => {
        if (!item) return false;
        const rect = item.getBoundingClientRect();
        const style = window.getComputedStyle(item);
        return rect.width > 12 &&
          rect.height > 12 &&
          rect.top > window.innerHeight * 0.55 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      }).length;
    const percentValues = Array.from(text.matchAll(/\b(\d{1,3})\s*%\b/g), (match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);
    const activePercents = percentValues.filter((value) => value > 0 && value < 100);
    const missingNames = names.filter((name) => projectImages
      ? !readyNames.has(String(name || '').toLowerCase())
      : !text.includes(String(name || '').toLowerCase()));
    const count = projectImages ? readyCount : Math.max(names.length ? matchedNames.length : 0, state.count || 0);
    const hasAllNames = names.length
      ? matchedNames.length >= Math.min(state.want || names.length, names.length)
      : true;
    const uploadBusy = activePercents.length > 0 || /uploading|processing|preparing|adding media/.test(text);
    // Composer-visible thumbnails + the filename on the page are the strong
    // "upload landed" signals. Busy-text alone is weak: an unrelated rendering
    // card's "42%" or a lingering "processing" label anywhere in the page would
    // otherwise reset the stability window forever and stall the queue.
    const composerHasAll = state.want > 0 && bottomImages >= state.want;
    if (projectHasAll || (!projectImages && hasAllNames && (composerHasAll || !uploadBusy))) {
      state.stableSince = state.stableSince || now;
    } else {
      state.stableSince = 0;
    }
    state.count = count;
    state.progress = percentValues.length ? Math.max(...percentValues) : null;
    state.busyCount = activePercents.length;
    state.bottomImages = bottomImages;
    state.missingNames = missingNames.slice(0, 3);
    const neededStability = projectHasAll ? Math.min(state.settleMs, 2000) : composerHasAll ? Math.min(state.settleMs, 4000) : state.settleMs;
    if ((projectHasAll || (!projectImages && hasAllNames)) && state.stableSince && now - state.stableSince >= neededStability) {
      state.state = 'done';
      state.count = state.want;
      if (projectHasAll) state.detectedVia = 'loaded project images';
    } else if (!projectImages && hasAllNames && state.start && now - state.start > Math.max(state.settleMs * 6, 45000)) {
      // Time override: the filename is on the page but flaky busy indicators
      // keep resetting the window. Proceed — later stages (Add to Prompt
      // readiness, composer checks) still verify the asset is really usable.
      state.state = 'done';
      state.count = state.want;
      state.forced = true;
    } else if ((projectImages ? !projectHasAll : !hasAllNames) && state.start && now - state.start > 150000) {
      state.state = 'error';
      state.error = `Upload readiness not confirmed after ${Math.round((now - state.start) / 1000)}s; missing ready project images: ${names.filter(name => !readyNames.has(String(name).toLowerCase())).join(', ')}`;
    }
  }
  return {
    state: state.state,
    count: state.count || 0,
    want: state.want || 0,
    method: state.method || null,
    error: state.error || null,
    progress: state.progress,
    busyCount: state.busyCount || 0,
    bottomImages: state.bottomImages || 0,
    missingNames: state.missingNames || [],
    stableMs: state.stableSince ? Math.max(0, now - state.stableSince) : 0,
    elapsedMs: state.start ? Math.max(0, now - state.start) : 0,
    forced: !!state.forced,
    detectedVia: state.detectedVia || null,
  };
}

async function pg_flowInsertPrompt(text, selectors) {
  selectors = selectors || { editor: 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]' };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editorText = (element) => {
    const clone = element.cloneNode(true);
    for (const placeholder of Array.from(clone.querySelectorAll('[data-slate-placeholder="true"]'))) placeholder.remove();
    const valueText = 'value' in element ? String(element.value || '') : '';
    const visibleText = String(clone.innerText || '').trim();
    const fallbackText = String(clone.textContent || '').trim();
    const content = valueText.trim() || visibleText || fallbackText;
    return content
      .replace(/\uFEFF/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const findPromptEditor = () => {
    const candidates = Array.from(document.querySelectorAll(selectors.editor))
      .filter(visible);
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect();
      const text = `${candidate.getAttribute('placeholder') || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.innerText || ''} ${candidate.textContent || ''}`.toLowerCase();
      let score = rect.top;
      if (/what do you want|create|prompt|describe/.test(text)) score += 5000;
      if (/search|find scene|all statuses|aug \d/.test(text)) score -= 5000;
      if (candidate.isContentEditable || candidate.getAttribute('role') === 'textbox') score += 500;
      if (rect.width > 250) score += 200;
      if (rect.top > window.innerHeight * 0.45) score += 700;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  };
  const editor = findPromptEditor();
  if (!editor) return { ok: false, error: 'No Flow prompt editor found' };
  const source = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return { ok: false, error: 'Prompt is empty' };
  editor.focus();
  if ('value' in editor) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
    if (setter) setter.call(editor, source);
    else editor.value = source;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, source);
    if (!editorText(editor).toLowerCase().includes(source.toLowerCase().replace(/\s+/g, ' ').trim())) {
      try {
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        const dt = new DataTransfer();
        dt.setData('text/plain', source);
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      } catch { /* keep the execCommand result */ }
    }
  }
  await sleep(300);
  const pageText = `${document.body ? document.body.innerText || '' : ''}`.toLowerCase();
  if (/application error.*client-side exception|client-side exception has occurred/.test(pageText)) {
    return { ok: false, error: 'Flow page crashed after prompt insert' };
  }
  const actual = editorText(editor).replace(/\s+/g, ' ').trim();
  const expected = source.replace(/\s+/g, ' ').trim();
  const actualCompact = actual.toLowerCase().replace(/\s+/g, '');
  const expectedCompact = expected.toLowerCase().replace(/\s+/g, '');
  return actual === expected || actual.includes(expected) || actualCompact.includes(expectedCompact)
    ? { ok: true, length: actual.length, expected: source.length, lines: source.split('\n').length, method: 'flow-editor' }
    : { ok: false, error: `Flow prompt verification failed: editor has ${actual.length}/${expected.length} normalized chars` };
}

async function pg_flowReturnToProjectComposer(pointOnly = false) {
  let clickAt = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const clickElement = (element) => {
    if (!element) return false;
    const target = element.closest?.('button, [role="button"], a[href]') || element;
    if (pointOnly) { const r = target.getBoundingClientRect(); clickAt = {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; return true; }
    try {
      if (typeof target.click === 'function') { target.click(); return true; }
    } catch { /* continue with synthetic events */ }
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y) || target;
    let sent = false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      let event = null;
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y });
      } else if (typeof MouseEvent === 'function') {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      } else if (typeof Event === 'function') {
        event = new Event(type, { bubbles: true, cancelable: true });
      }
      if (event) {
        hit.dispatchEvent(event);
        if (hit !== target) target.dispatchEvent(event);
        sent = true;
      }
    }
    return sent;
  };
  const pageLooksLikeMediaDetail = () => {
    const bodyText = `${document.body ? document.body.innerText || '' : ''}`.toLowerCase();
    return /\/edit\//i.test(location.href) ||
      bodyText.includes('what do you want to change?') ||
      (bodyText.includes('hide history') && bodyText.includes('done'));
  };
  const hasProjectCreateComposer = () => {
    const bodyText = `${document.body ? document.body.innerText || '' : ''}`.toLowerCase();
    return bodyText.includes('what do you want to create?') && !bodyText.includes('what do you want to change?');
  };
  if (!pageLooksLikeMediaDetail()) {
    const project = /\/project\/[^/?#]+\/?(?:[?#]|$)/i.test(location.href);
    return { ok: project || hasProjectCreateComposer(), alreadyProject: project || hasProjectCreateComposer(), url: location.href };
  }
  for (let attempt = 1; attempt <= 3 && pageLooksLikeMediaDetail(); attempt++) {
    const done = Array.from(document.querySelectorAll('button, [role="button"], a[href], div, span'))
      .filter(visible)
      .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
      .filter(({ text, rect }) =>
        /\bdone\b|arrow_back|go back/.test(text) &&
        rect.top < 100 &&
        !/hide history|delete|download|favorite/.test(text)
      )
      .sort((a, b) => {
        const score = (candidate) =>
          (/^done$/.test(candidate.text) ? 5000 : 0) +
          (candidate.text.includes('arrow_back') ? 2000 : 0) +
          (candidate.rect.right > window.innerWidth - 220 ? 1000 : 0) -
          candidate.rect.left;
        return score(b) - score(a);
      })[0];
    if (done) clickElement(done.item);
    else history.back();
    if (clickAt) return { ok: false, returning: true, clickAt, url: location.href };
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      if (!pageLooksLikeMediaDetail() && (/\/project\/[^/?#]+\/?(?:[?#]|$)/i.test(location.href) || hasProjectCreateComposer())) {
        return { ok: true, returned: true, url: location.href };
      }
      await sleep(400);
    }
  }
  return {
    ok: !pageLooksLikeMediaDetail(),
    returned: !pageLooksLikeMediaDetail(),
    error: pageLooksLikeMediaDetail() ? 'Flow stayed on uploaded image detail page after upload' : null,
    url: location.href,
  };
}

// True only when the cursor is in a text editor that is not the search box (see flowInsertPromptWithDebugger).
function pg_flowEditorFocused() {
  const active = document.activeElement;
  const editor = active?.closest?.('textarea, [contenteditable="true"], [role="textbox"]') || (active?.matches?.('input[type="text"]') ? active : null);
  if (!editor) return false;
  const label = `${editor.getAttribute('placeholder') || ''} ${editor.getAttribute('aria-label') || ''}`.toLowerCase();
  return !/search/.test(label);
}

function pg_flowPromptEditorPoint() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.getAttribute?.('placeholder') || ''} ${element.getAttribute?.('aria-label') || ''} ${element.innerText || ''} ${element.textContent || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const editor = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .map((item) => ({ item, text: textOf(item), rect: item.getBoundingClientRect() }))
    .filter(({ text }) => !/search assets|search|all statuses/.test(text))
    .sort((a, b) => {
      const score = (candidate) =>
        candidate.rect.top +
        (/what do you want|create|change|prompt/.test(candidate.text) ? 6000 : 0) +
        (candidate.rect.top > window.innerHeight * 0.55 ? 1500 : 0) +
        (candidate.rect.width > 220 ? 700 : 0);
      return score(b) - score(a);
    })[0];
  if (!editor) return { ok: false, error: 'Flow prompt editor not found' };
  try { editor.item.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* ignore */ }
  const rect = editor.item.getBoundingClientRect();
  return {
    ok: true,
    x: Math.max(1, Math.min(window.innerWidth - 2, rect.left + Math.min(80, rect.width / 2))),
    y: Math.max(1, Math.min(window.innerHeight - 2, rect.top + Math.min(28, rect.height / 2))),
    text: editor.text,
  };
}

function pg_flowVerifyPromptText(text) {
  const expected = String(text || '').replace(/\s+/g, ' ').trim();
  const expectedCompact = expected.toLowerCase().replace(/\s+/g, '');
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const cleanText = (element) => {
    const clone = element.cloneNode(true);
    for (const placeholder of Array.from(clone.querySelectorAll?.('[data-slate-placeholder="true"]') || [])) {
      placeholder.remove();
    }
    const valueText = 'value' in element ? String(element.value || '') : '';
    const visibleText = String(clone.innerText || '').trim();
    const fallbackText = String(clone.textContent || '').trim();
    return (valueText.trim() || visibleText || fallbackText).replace(/\s+/g, ' ').trim();
  };
  const editors = Array.from(document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .map((item) => ({ item, text: cleanText(item), rect: item.getBoundingClientRect() }))
    .filter(({ item, rect }) => {
      const hint = `${item.getAttribute?.('placeholder') || ''} ${item.getAttribute?.('aria-label') || ''}`;
      if (/search|find scene|all statuses/i.test(hint) || item.closest?.('flow-video-tile')) return false;
      // Long mobile prompts/soft keyboards move the real editor above the lower half of the viewport.
      return rect.top > window.innerHeight * 0.45 || !!item.matches?.('.ProseMirror[contenteditable="true"], [data-slate-editor="true"]');
    })
    .sort((a, b) => b.text.length - a.text.length);
  const actual = editors[0]?.text || '';
  const actualCompact = actual.toLowerCase().replace(/\s+/g, '');
  // Fallback evidence comes from the composer only. Result tiles repeat earlier
  // prompts (and the same prompt on a retry), so page-wide text cannot prove
  // that this prompt is in the editor.
  let composer = editors.slice().sort((a, b) => b.rect.top - a.rect.top)[0]?.item || null;
  for (let depth = 0; composer?.parentElement && depth < 3; depth++) composer = composer.parentElement;
  const composerText = composer && !composer.closest?.('flow-video-tile') && !composer.querySelector?.('flow-video-tile') ? String(composer.innerText || '') : '';
  const bodyText = composerText.replace(/\s+/g, ' ').trim();
  const bodyCompact = bodyText.toLowerCase().replace(/\s+/g, '');
  const expectedLower = expected.toLowerCase();
  const anchors = [
    expectedLower.match(/\bscene\s+\d+[^.]{0,80}/)?.[0],
    expectedLower.match(/\bduration:\s*\d+s/)?.[0],
    expectedLower.match(/\bnegative:[^.]{0,100}/)?.[0],
    expectedLower.match(/\baction:[^.]{0,120}/)?.[0],
  ].filter(Boolean);
  const anchorHits = anchors.filter((anchor) => bodyText.toLowerCase().includes(anchor)).length;
  // One shared anchor (e.g. "duration: 8s") is common to every prompt in a series.
  const visibleEnough = (anchors.length >= 2 && anchorHits >= 2) ||
    (expectedCompact.length > 100 && bodyCompact.includes(expectedCompact.slice(Math.max(0, expectedCompact.length - 500))));
  return actual === expected || actual.includes(expected) || actualCompact.includes(expectedCompact) || visibleEnough
    ? { ok: true, length: actual.length, expected: expected.length, method: visibleEnough && !actual ? 'debugger-insertText-visible-body' : 'debugger-insertText' }
    : { ok: false, error: `editor has ${actual.length}/${expected.length} normalized chars`, actualPreview: actual.slice(0, 120), bodyPreview: bodyText.slice(-180) };
}

function pg_flowGeneratePoint() {
  const pageText = `${document.body ? document.body.innerText || '' : ''}`.toLowerCase();
  if (/application error.*client-side exception|client-side exception has occurred/.test(pageText)) {
    return { ok: false, crashed: true, error: 'Flow page crashed before generation could start' };
  }
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
    .filter(visible)
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const text = textOf(item);
      const disabled = item.disabled || item.getAttribute('aria-disabled') === 'true';
      return { item, text, disabled, rect };
    })
    .filter(({ text, rect }) =>
      rect.top > window.innerHeight * 0.6 &&
      /start generation|arrow_forward|\bgenerate\b|\bsend\b|submit/.test(text) &&
      !/add_2|add media|add ingredients|cancel|delete|trash|settings trigger|download/.test(text)
    )
    .sort((a, b) => {
      const score = (c) =>
        (c.text.includes('start generation') ? 9000 : 0) +
        (c.rect.width <= 90 && c.rect.height <= 90 ? 2000 : 0) +
        c.rect.left;
      return score(b) - score(a);
    });
  const best = candidates[0];
  if (!best) return { ok: false, error: 'Flow generate button not found' };
  return {
    ok: true,
    x: Math.max(1, Math.min(window.innerWidth - 2, best.rect.left + best.rect.width / 2)),
    y: Math.max(1, Math.min(window.innerHeight - 2, best.rect.top + best.rect.height / 2)),
    disabled: best.disabled,
    text: best.text.slice(0, 60),
  };
}

// Credit state of the Flow page: the whole page text (banners, dialogs, toasts) plus the submit button's own label and
// tooltip, and whether Flow shows its low-credit warning ("You're running low on Google Flow credits" / "Add AI credits").
function pg_flowCreditState() {
  const clean = value => String(value || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const labels = Array.from(document.querySelectorAll('[aria-label], [title], [data-tooltip], [role="tooltip"], [role="alert"], [role="dialog"]'))
    .map(element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-tooltip'),
      /^(?:tooltip|alert|dialog)$/.test(element.getAttribute('role') || '') ? element.innerText : ''].join(' '))
    .map(clean).filter(text => /credit|quota|limit/.test(text));
  const text = clean(`${document.body ? document.body.innerText || '' : ''} ${labels.join(' ')}`);
  return { text, lowCredits: /running low on (?:google flow |ai |flow )?credits|add ai credits|top up to get more/.test(text) };
}

// After a successful submit Flow clears the composer. True submission
// confirmation that no synthetic click can fake.
function pg_flowComposerCleared() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const editors = Array.from(document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]'))
    .filter(visible)
    .filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.5)
    .filter(el => !el.querySelector?.('textarea,[contenteditable="true"],[role="textbox"]'));
  if (!editors.length) return { cleared: false, editorCount: 0 };
  const chars = editors.reduce((total, el) => {
    const clone = el.cloneNode(true);
    for (const placeholder of Array.from(clone.querySelectorAll?.('[data-slate-placeholder="true"]') || [])) placeholder.remove();
    const valueText = 'value' in el ? String(el.value || '') : '';
    const visibleText = String(clone.innerText || '').trim();
    return total + (valueText.trim() || visibleText).replace(/\uFEFF/g, '').trim().length;
  }, 0);
  return { cleared: chars === 0, editorCount: editors.length, chars };
}

function pg_flowCheckStatus(selectors, baselineSources, failureBaselineText, failureBaselineScopes, promptText, ownKey = '') {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  selectors = selectors || { video: 'video' };
  const text = (document.body ? document.body.innerText : '').toLowerCase();
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mediaCardText = (element) => {
    const tile = element.closest('flow-video-tile');
    if (tile) return textOf(tile);
    let node = element;
    let best = '';
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const txt = textOf(node);
      if (
        txt &&
        rect.width >= element.getBoundingClientRect().width &&
        rect.height >= element.getBoundingClientRect().height &&
        rect.height < 520
      ) {
        best = txt;
      }
    }
    return best;
  };
  const videos = Array.from(document.querySelectorAll(selectors.video || 'video')).filter(visible);
  const statusVideos = videos.map((video) => {
    const cardText = mediaCardText(video);
    const playable =
      !!(video.currentSrc || video.src) &&
      video.readyState >= 1 &&
      (video.videoWidth > 0 || (Number.isFinite(video.duration) && video.duration > 0));
    const inProgress = /\b\d{1,3}\s*%/.test(cardText) || (!playable && /\bgenerating\b|\bprocessing\b|\brendering\b|\bqueued\b|\bloading\b/.test(cardText));
    return { playable, inProgress, cardText };
  });
  const completedVideos = statusVideos.filter((item) => item.playable && !item.inProgress);
  // 2026-10-02: Flow only mounts a <video> inside a card while that card is HOVERED; at rest a finished card is a poster
  // (class pre-hover-overlay / footer-overlay-has-progress-bar with a play_circle icon). Counting <video> elements alone
  // never saw prompt 2's finished video, so the run sat in "generating (1/2 complete)" until the 15-minute timeout.
  const posterKeys = new Set();
  const posterBusy = new Set();
  // Flow's current grid uses 84x150 portrait tiles. A finished thumbnail
  // exists before hover mounts a video; count the tile itself once.
  for (const tile of document.querySelectorAll('flow-video-tile')) {
    if (!visible(tile)) continue;
    const rect = tile.getBoundingClientRect();
    const key = `${Math.round(rect.left)},${Math.round(rect.top)}`;
    const thumbnail = tile.querySelector('img[alt="Generated video thumbnail"]');
    const video = tile.querySelector('video');
    const finished = !!(thumbnail && (thumbnail.currentSrc || thumbnail.src)) ||
      !!(video && (video.currentSrc || video.src) && video.readyState >= 1);
    posterKeys.add(key);
    if (!finished || /\b\d{1,3}\s*%/.test(textOf(tile))) posterBusy.add(key);
  }
  for (const leaf of Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && (e.textContent || '').trim() === 'play_circle')) {
    if (leaf.closest('flow-video-tile')) continue;
    let node = leaf;
    for (let i = 0; i < 10 && node.parentElement; i++) {
      node = node.parentElement;
      const r0 = node.getBoundingClientRect();
      if (r0.width > 100 && r0.height > 150 && r0.height < 520) break;
    }
    if (!visible(node)) continue;
    const r = node.getBoundingClientRect();
    const key = `${Math.round(r.left)},${Math.round(r.top)}`;
    posterKeys.add(key);
    if (/\b\d{1,3}%\b|generating|processing|rendering|queued|loading/.test(textOf(node))) posterBusy.add(key);
  }
  const posterCompleted = Array.from(posterKeys).filter((k) => !posterBusy.has(k)).length;
  const playableVideo = completedVideos.length > 0 || posterCompleted > 0;
  const baseline = new Set(baselineSources || []);
  // Video tiles and grid tiles (image results, failed image tiles) that were not on the page before Send.
  // Parallel (ownKey): other prompts' tiles appear after this Send too, so only the tiles THIS prompt claimed count.
  if (ownKey) window.__flowStudioRetag?.();
  const ownTile = tile => { const value = markOf(tile, 'sub') || ''; return value === ownKey || value.startsWith(ownKey + '#'); };
  const newTiles = Array.from(new Set([...document.querySelectorAll('flow-video-tile'), ...document.querySelectorAll('flow-grid-tile-container')]))
    .filter(tile => ownKey ? ownTile(tile) : !baseline.has(`tile:${markOf(tile, 'res')}`));
  const failurePhrases = [
    'failed', 'could not generate', 'unable to generate', 'try a different prompt',
    'violates', 'policy', 'something went wrong',
    'seem to be encountering an error', 'encountered an error', 'ran into an error',
    'can i try something else for you',
    'videos of real people', 'having a hard time fulfilling', 'can i help you with something else',
  ];
  // Flow titles finished tiles from the prompt ("Business deal failed"), so the
  // title is never warning text, and a finished tile is a result, not a failure.
  const scopeText = (element) => {
    let value = String(element.innerText || '');
    const title = element.querySelector?.('.footer-title')?.textContent;
    if (title && title.trim()) value = value.split(title).join(' ');
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  };
  const finishedTile = (tile) => {
    const thumbnail = tile.querySelector?.('img[alt="Generated video thumbnail"]');
    return !!(thumbnail && (thumbnail.currentSrc || thumbnail.src)) && !/\b\d{1,3}\s*%/.test(textOf(tile));
  };
  let candidateScopes = baselineSources && document.querySelectorAll('flow-video-tile,flow-grid-tile-container').length
    ? [...newTiles.filter(tile => !finishedTile(tile)), ...Array.from(document.querySelectorAll('[role="alert"]'))].filter(visible).map(scopeText)
    : [text.slice(-3000)];
  let scopedFailures = false;
  if (ownKey) {
    // Own tiles are new by definition. Page alerts cannot be tied to one prompt: only account warnings count.
    scopedFailures = true;
    candidateScopes = [...newTiles.filter(tile => !finishedTile(tile)).filter(visible).map(scopeText),
      ...Array.from(document.querySelectorAll('[role="alert"]')).filter(visible).map(scopeText).filter(value => /unusual activity|browser extensions that modify the page/.test(value))];
  } else if (Array.isArray(failureBaselineScopes)) {
    const currentScopes = Array.from(document.querySelectorAll('flow-video-tile,flow-grid-tile-container,[role="alert"]')).filter(visible).map(scopeText);
    // Compare whole warnings, so a new technical failure cannot make an old
    // policy warning look new. Recreated DOM nodes do not affect this check.
    if (currentScopes.length) {
      scopedFailures = true;
      candidateScopes = candidateScopes.filter(scope =>
        currentScopes.filter(value => value === scope).length > failureBaselineScopes.filter(value => value === scope).length);
    }
  }
  // A new tile shows the submitted prompt while it loads ("... she studies the failed check ..."): words INSIDE the prompt
  // are never Flow's warning (user report, Oct 2026: a prompt containing "failed" was failed twice 4 s after Send).
  // Remove the prompt, or its visible start when Flow cuts it short, before looking for failure words.
  const promptNorm = String(promptText || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const withoutPrompt = (value) => {
    let out = String(value || '');
    if (promptNorm.length < 20) return out;
    out = out.split(promptNorm).join(' ');
    const head = promptNorm.slice(0, 80);
    for (let at = out.indexOf(head), guard = 0; at >= 0 && guard < 20; at = out.indexOf(head), guard++) out = out.slice(0, at) + ' ' + out.slice(at + promptNorm.length);
    return out;
  };
  const failureScope = candidateScopes.find(scope => failurePhrases.some(phrase => {
    const failureScope = withoutPrompt(scope);
    if (!failureScope.includes(phrase)) return false;
    // React may replace a previous failed tile, losing its injected tile ID.
    // Lingering alerts are also outside tile IDs. Require a new occurrence
    // since submission before treating either as this prompt's failure.
    if (scopedFailures || typeof failureBaselineText !== 'string') return true;
    return withoutPrompt(text).split(phrase).length > withoutPrompt(failureBaselineText).split(phrase).length;
  })) || '';
  // A batch can have a refused output while another output is still rendering.
  // Give the current rendering result a chance to finish before repairing.
  const currentStillRendering = newTiles.some(tile => visible(tile) && /\b\d{1,3}\s*%/.test(textOf(tile)));
  const accountWarning = /unusual activity|browser extensions that modify the page/.test(failureScope);
  const failureText = failureScope && (!currentStillRendering || accountWarning) ? failureScope.trim().slice(0,4000) : null;
  // The % Flow paints on a generating card (e.g. "42%"). Surfaced for the
  // queue detail; NOT used as the completion trigger — cards can flash 100%
  // before the finished video element is actually loadable.
  const progressPercent = Math.max(
    0,
    ...statusVideos
      .filter((item) => item.inProgress)
      .map((item) => {
        const match = String(item.cardText || '').match(/\b(\d{1,3})\s*%/);
        return match ? Number(match[1]) : 0;
      })
  ) || null;
  return {
    text: text.slice(-2000),
    hasVideo: playableVideo,
    ready: playableVideo,
    failureText,
    failureKind: failureText && /polic(?:y|ies)|violat|different prompt|real people/.test(failureScope) ? 'policy' : (failureText ? 'transient' : null),
    videoCount: Math.max(completedVideos.length, posterCompleted),
    rawVideoCount: Math.max(videos.length, posterKeys.size),
    generatingCount: Math.max(statusVideos.filter((item) => item.inProgress).length, posterBusy.size),
    progressPercent,
  };
}

function pg_getVideoSource(selectors, options) {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  selectors = selectors || { video: 'video' };
  options = options || {};
  const excludeSources = new Set((options.excludeSources || []).filter(Boolean));
  const completedOnly = !!options.completedOnly;
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const textOf = (element) => `${element.innerText || ''} ${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const cardText = (element) => {
    let node = element;
    let best = '';
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const txt = textOf(node);
      if (txt && rect.width >= element.getBoundingClientRect().width && rect.height >= element.getBoundingClientRect().height && rect.height < 560) {
        best = txt;
      }
    }
    return best;
  };
  const videos = Array.from(document.querySelectorAll(selectors.video))
    .filter((video) => {
      const src = video.currentSrc || video.src;
      if (!src) return false;
      if (excludeSources.has(src)) return false;
      const tile = video.closest('flow-video-tile');
      if (tile && (excludeSources.has(`tile:${markOf(tile, 'res')}`) ||
        Array.from(tile.querySelectorAll('img')).some(img => excludeSources.has(`poster:${img.currentSrc || img.src}`)))) return false;
      if (completedOnly && !visible(video)) return false;
      const text = cardText(video);
      if (completedOnly && /\b\d{1,3}%\b|generating|processing|rendering|queued|loading/.test(text)) return false;
      return !completedOnly || (
        video.readyState >= 1 &&
        (video.videoWidth > 0 || (Number.isFinite(video.duration) && video.duration > 0))
      );
    })
    .sort((a, b) => {
      const score = (video) => {
        const rect = video.getBoundingClientRect();
        const topLeftScore = (window.innerHeight - rect.top) + (window.innerWidth - rect.left);
        return (
          (video.readyState >= 1 ? 1000000 : 0) +
          (video.videoWidth * video.videoHeight) +
          (video.getClientRects().length ? 100000 : 0) +
          topLeftScore
        );
      };
      return score(b) - score(a);
    });
  const video = videos[0];
  if (!video) return { ok: false, error: 'No completed new video element with a source found' };
  const src = video.currentSrc || video.src;
  let host = 'page blob';
  try { host = new URL(src).hostname || new URL(src).protocol; } catch { /* keep fallback label */ }
  return {
    ok: true,
    src,
    host,
    readyState: video.readyState,
    width: video.videoWidth,
    height: video.videoHeight,
    count: videos.length,
  };
}

// Best-effort: open the media card's download menu and pick a resolution
// option (720p/1080p/2K/4K). Silently reports notFound when Flow's UI differs;
// the caller falls back to the default-resolution source.
// Storyboard sheets (owner 2026-10-23): the tracked image tile, scrolled into view, for its right-click menu.
function pg_flowTrackedTilePoint(key) {
  const tracker = window.__flowStudioResultTrackers?.[key] || window.__flowStudioResultTracker;
  const tile = tracker && tracker.key === key ? tracker.tile : null;
  if (!tile || !tile.isConnected) return {ok:false, error:'tracked image tile not found'};
  tile.scrollIntoView({block:'center', inline:'center'});
  const picture = tile.querySelector('img') || tile, rect = picture.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? {ok:true, x:rect.left + rect.width / 2, y:rect.top + rect.height / 2} : {ok:false, error:'tracked image tile is not visible'};
}

function pg_startMediaExtraction(sourceUrl) {
  window.__flowMedia = { state: 'working', b64: null, error: null };
  const requestState = window.__flowMedia;
  if (!sourceUrl) {
    window.__flowMedia = { state: 'error', b64: null, error: 'No media source URL' };
    return 'no-media';
  }
  fetch(sourceUrl, { credentials: 'include' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      if (window.__flowMedia !== requestState) return;
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 0x8000; // avoid call-stack limits on String.fromCharCode(...bigArray)
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      window.__flowMedia = { state: 'done', b64: btoa(binary), error: null, byteLength: bytes.length };
    })
    .catch((e) => {
      if (window.__flowMedia === requestState) window.__flowMedia = { state: 'error', b64: null, error: String(e) };
    });
  return 'started';
}

function pg_pollMediaExtraction() {
  const v = window.__flowMedia;
  if (!v) return { state: 'missing' };
  return { state: v.state, error: v.error, byteLength: v.byteLength || 0 };
}

function pg_readMediaChunk(offset, size) {
  const v = window.__flowMedia;
  if (!v || v.state !== 'done' || !v.b64) return null;
  return v.b64.slice(offset, offset + size);
}

function pg_mediaB64Length() {
  const v = window.__flowMedia;
  return (v && v.b64) ? v.b64.length : 0;
}

// Last-frame extraction for chaining: seek the newest completed video to its
// final moment and rasterize it. Cross-origin videos taint the canvas, in
// which case toDataURL throws and we report unavailable — never a hard error.
function pg_extractLastFrame(excludeSources = [], expectedResult = null) {
  // Owner 2026-11-07: which tile belongs to which prompt is kept in the extension's own space, never written onto Flow's tiles.
  const flowMarks = window.__flowStudioMarks || (window.__flowStudioMarks = {sub: new WeakMap(), res: new WeakMap()});
  const markOf = (el, kind) => (el && typeof el === 'object' && flowMarks[kind].get(el)) || null;
  return new Promise((resolve) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const videos = Array.from(document.querySelectorAll('video'))
      .filter(v => !excludeSources.includes(v.currentSrc || v.src) && !excludeSources.includes(`tile:${markOf(v.closest('flow-video-tile'), 'res')}`))
      .filter(v => {
        if (!expectedResult) return true;
        const key = value => String(value || '').split('?')[0].split('#')[0];
        const tile = v.closest('flow-video-tile') || v.closest('flow-grid-tile-container, flow-tile-container');
        if (expectedResult.posterSources?.length) return !!tile && Array.from(tile.querySelectorAll('img')).some(img => expectedResult.posterSources.some(src => key(src) === key(img.currentSrc || img.src)));
        if (expectedResult.videoSource) return key(v.currentSrc || v.src) === key(expectedResult.videoSource);
        return !!tile && !!expectedResult.tileId && markOf(tile, 'res') === expectedResult.tileId;
      })
      .filter((v) => visible(v) && (v.currentSrc || v.src) && Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0)
      .sort((a, b) => ((b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight)));
    const video = videos[0];
    if (!video) {
      resolve({ ok: false, error: 'No completed video element for last-frame extraction' });
      return;
    }
    const finish = (b64) => resolve({ ok: true, b64, width: video.videoWidth, height: video.videoHeight });
    try {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d').drawImage(video, 0, 0);
          const b64 = canvas.toDataURL('image/png').split(',')[1];
          finish(b64);
        } catch (e) {
          resolve({ ok: false, error: `Canvas protected: ${String(e && e.message ? e.message : e)}` });
        }
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = Math.max(0, video.duration - 0.15);
      setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        resolve({ ok: false, error: 'Timed out seeking to the last frame' });
      }, 5000);
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
}

// ==========================================================================
// Runner
// ==========================================================================

function buildPromptForItem(item, fileB64s) {
  const source = String(item.generationText || item.text || '').trim();
  const names = (fileB64s || [])
    .map((file) => String(file?.name || '').trim())
    .filter(Boolean);
  if (!names.length) return source;
  // A single start frame is attached separately; its filename adds no mapping value.
  if (settings.mode === 'frame-to-video' && (fileB64s || []).length === 1) return source;
  const alreadyMentionsAll = names.every((name) => source.toLowerCase().includes(name.toLowerCase()));
  if (alreadyMentionsAll) return source;
  return [
    `UPLOADED ASSETS TO USE: ${names.join(', ')}`,
    'Use the uploaded asset filename(s) above as the visual reference for the matching scene or character names in this prompt.',
    '',
    source,
  ].join('\n');
}

function flowLaunchUrl(source) {
  try {
    const url=new URL(source);
    if(!['flow.google','flow.google.com','labs.google'].includes(url.hostname))return DEFAULT_SETTINGS.flowProjectUrl;
    const home=url.hostname==='labs.google'?'/fx/tools/flow/':'/';
    const accountPath=url.pathname.match(/\/u\/(\d+)\//);
    url.pathname=accountPath ? home+'u/'+accountPath[1]+'/' : home;
    url.hash='';
    const authuser=url.searchParams.get('authuser');url.search='';
    if(authuser!==null)url.searchParams.set('authuser',authuser);
    return url.href;
  }catch{return DEFAULT_SETTINGS.flowProjectUrl;}
}

function pg_flowPageLanguage() { return document.documentElement.lang || ''; }

// Flow translates its labels for the account's language (Tagalog: "Simulan ang pagbuo", thumbnails
// "Tile na nagpapakita ng larawan ng user"). The automation matches Flow's English labels, so a Flow
// page in another language is reloaded with ?hl=en (only that tab; the account setting is unchanged).
async function ensureFlowEnglish(tabId, item, beforeReload = null) {
  const lang = await exec(tabId, pg_flowPageLanguage, []).catch(() => '');
  if (typeof lang !== 'string' || !lang || /^en\b/i.test(lang)) return;
  const current = await chrome.tabs.get(tabId);
  const url = new URL(current.url);
  url.searchParams.set('hl', 'en');
  log(`${item.id}: Flow page language is "${lang}"; reloading Flow in English (hl=en) so its labels match the automation.`);
  if (beforeReload) await beforeReload();   // parallel: the other prompts finish first (a reload loses their trackers)
  item.detail = 'switching Flow to English';
  renderQueue();
  await chrome.tabs.update(tabId, {url: url.href});
  await sleep(500);
  await waitForTabComplete(tabId);
  await sleep(2500);
  const after = await exec(tabId, pg_flowPageLanguage, []).catch(() => '');
  if (typeof after === 'string' && after && !/^en\b/i.test(after)) log(`${item.id}: Flow still shows language "${after}" after hl=en; some steps may not find Flow's buttons. Set Flow or the Google account language to English.`);
}

// Flow is a SPA: its composer can be ready while Chrome still reports loading.
async function ensureFlowProjectReady(tabId,item,token){
  for(let attempt=0;attempt<20;attempt++){
    assertRunActive(token);
    const nav=await flowExecWithRealClick(tabId,pg_flowEnsureProject,[],{waitMs:1500});
    if(nav?.ok)return;
    item.detail=nav?.creatingProject?'creating Flow project':'waiting for Flow composer';renderQueue();
    await sleep(1500);
  }
  throw Error('Flow composer did not become ready. Open the project and press Retry.');
}

function pg_flowCurrentUrl() { return location.href; }
async function getFlowTab(slot) {
  if (typeof flowParallelCount === 'function' && flowParallelCount() > 1 && slot !== 0 && !slotTabs.has(slot)) { const shared = await getFlowTab(0); slotTabs.set(slot, shared.id); return shared; }
  if (slotTabs.has(slot)) {
    let tab;
    try {
      const requestedId = slotTabs.get(slot);
      tab = await chrome.tabs.get(requestedId);
      // Quetta on Android can return the active extension tab instead of the requested Flow tab.
      // Only accept the original ID from the tab inventory; never inject into a different tab.
      if (tab.id !== requestedId) {
        const mobile = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
        tab = mobile ? (await chrome.tabs.query({})).find(candidate => candidate.id === requestedId) : null;
        if (!tab) throw new Error('Requested Flow tab is unavailable');
      }
    } catch { throw Object.assign(new Error('The selected Flow tab was closed. Open Flow with the intended account and restart the queue.'), {code:'FLOW_TAB_CHANGED'}); }
    // Some Android browsers return stale/empty tab metadata after their native download UI.
    // Verify only this same tab; never switch to a different project/account.
    const flowUrl = /^https:\/\/(?:labs\.google|flow\.google(?:\.com)?)\//i;
    if (!flowUrl.test(tab.url || tab.pendingUrl || '')) {
      const actual = await exec(tab.id, pg_flowCurrentUrl, []).catch(() => '');
      if (!flowUrl.test(actual)) throw Object.assign(new Error('The Flow tab used by this queue is no longer on Google Flow. Open your Flow project in that tab again, then press Start.'), {code:'FLOW_TAB_CHANGED'});
    }
    return tab;
  }
  const specific = /^https:\/\/(?:labs\.google|flow\.google(?:\.com)?)\//i.test(settings.flowProjectUrl)
    ? settings.flowProjectUrl
    : DEFAULT_SETTINGS.flowProjectUrl;
  // With more than one worker, each worker builds its own project so the
  // shared project page's state never interleaves between workers.
  const url = settings.concurrentPrompts <= 1 || (typeof flowParallelCount === 'function' && flowParallelCount() > 1) ? specific : flowLaunchUrl(specific);
  const tab = await chrome.tabs.create({ url, active: settings.openTabWhileGenerating });
  slotTabs.set(slot, tab.id);
  await registerAutomationTab(tab.id);
  return tab;
}

// Preferred video download: hover the finished card with the REAL mouse (CDP)
// so its overlay buttons render, click ⋮/Download, then click the wanted
// resolution in the popover (verified live options: 480p/720p/1080p), and
// fetch the real MP4. Throws so the caller can fall back to the src fetch.
let flowDownloadTurn = Promise.resolve();

// ---------- Parallel in Flow (1.13.38; owner 2026-10-18: max 3, off by default, Flow only) ----------
// Several prompts render at once in the user's ONE Flow project. Typing/attaching/Send and the download menu use the
// page, so they take turns (flowPageLock); waiting for the render is what runs in parallel. Each prompt claims its own
// result tiles while it holds the page (pg_flowStartResultTracking parallel mode), so results never mix.
function flowParallelCount() {
  if ((settings.platform || 'flow') !== 'flow') return 1;
  if (settings.chainLastFrame && settings.mode === 'frame-to-video') return 1;   // chaining needs strict order
  return Math.min(2, Math.max(1, Number(settings.flowParallel) || 1));
}
function runConcurrency() { if (typeof quotaSolo !== 'undefined' && quotaSolo) return 1; if (settings.platform === 'vids') return 1; return ['muse','higgsfield'].includes(settings.platform)?1:(settings.platform || 'flow') === 'flow' ? flowParallelCount() : settings.concurrentPrompts; }
let flowPageTurn = Promise.resolve();
function flowPageLock() {
  let release;
  const previous = flowPageTurn;
  flowPageTurn = new Promise(resolve => { release = resolve; });
  return previous.then(() => { let done = false; return () => { if (!done) { done = true; release(); } }; });
}
const flowInFlight = new Set();   // prompts sent to Flow that are still rendering or saving (parallel mode)
let flowDraining = null;          // a prompt that needs the page to itself (a refresh): new sends wait
async function flowLockForSend(item, token) {
  for (;;) {
    const release = await flowPageLock();
    if (!flowDraining || flowDraining === item.id) return release;
    release(); await sleep(1000); assertRunActive(token);
  }
}
// A refresh would lose the other prompts' result trackers: let them finish first (they can still save meanwhile).
async function flowDrainOthers(item, token, why, page) {
  const others = () => [...flowInFlight].some(id => id !== item.id);
  if (flowParallelCount() <= 1 || !others()) return;
  flowDraining = item.id;
  page.release?.(); page.release = null;
  while (others()) { item.detail = `waiting for the other Flow prompts to finish before ${why}`; renderQueue(); await sleep(2000); assertRunActive(token); }
  page.release = await flowPageLock();
}
let flowDownloadsPending = 0;
// Pages with an anonymous timed-out upscale need a refresh before another
// download can be claimed. Recovery clears the flag instead of poisoning the queue.
const flowDownloadUnsafeTabs = new Set();
// Parallel: a Flow refresh destroys the other prompts' result tracking (owner run 2026-10-19: after p002's download
// timed out, the refresh left p003/p004 with "No completed video card found"). Refresh only when no other prompt
// of this run is still in Flow; until then the page stays flagged and the last prompt out refreshes it.
function flowOthersInFlight(id) {
  if (typeof flowInFlight !== 'undefined' && typeof flowParallelCount === 'function' && flowParallelCount() > 1) return [...flowInFlight].some(other => other !== id);
  // One at a time (owner 2026-11-10): the next prompt now starts while this video is still being prepared, so it can be
  // on the page when this download times out. Its run is in activeRuns until it is saved or failed.
  return typeof activeRuns !== 'undefined' && [...activeRuns.keys()].some(other => other !== id);
}
async function downloadVideoViaMenu(...args) {
  // Downloads omit tab IDs and may omit referrers. Serialize the capture
  // window so concurrent workers cannot claim one another's Flow download.
  const previous = flowDownloadTurn;
  const waiting = flowDownloadsPending > 0;
  flowDownloadsPending++;
  let release;
  flowDownloadTurn = new Promise((resolve) => { release = resolve; });
  if (waiting) {
    try { args[3]?.('generation complete — waiting for the previous Flow download/upscale; this download has not started'); }
    catch { /* UI-only */ }
  }
  await previous;
  try { return await downloadVideoViaMenuUnlocked(...args); }
  finally { flowDownloadsPending--; release(); }
}

function matchesFlowDownload(item, tabUrl, startedAt) {
  if (Date.parse(item.startTime || '') < startedAt) return false;
  const flowOrigin = /^https:\/\/(?:flow\.google\.com|labs\.google|flow\.google)(?:\/|$)/i;
  const knownMp4 = /video\/mp4/i.test(item.mime || '') || /\.mp4(?:$|[?#])/i.test(item.filename || '') || /\.mp4(?:$|[?#])/i.test(item.url || '');
  // Chrome often reports Flow's blob download before its type is known: no MIME (or a generic one) and a bare UUID
  // file name with no extension. That download must still be claimed, or the rename into the output folder is
  // skipped and the video lands in Downloads under its UUID. Clearly non-video types are still rejected.
  const mime = String(item.mime || '').toLowerCase();
  const unknownType = !mime || /^(?:application|binary)\/octet-stream$/.test(mime);
  const clearlyOther = /^(?:image|text|audio)\//.test(mime) || /json|html|zip|pdf/.test(mime) || /\.(?:png|jpe?g|webp|gif|txt|json|zip|csv|html?)(?:$|[?#])/i.test(item.filename || '');
  const fromFlow = flowOrigin.test(item.referrer || '') || flowOrigin.test(String(item.url || '').replace(/^blob:/, '')) ||
    flowOrigin.test(String(item.finalUrl || '').replace(/^blob:/, '')) || /^https:\/\/flow-content\.google\//i.test(item.url || '');
  const media = knownMp4 || (unknownType && fromFlow && !clearlyOther);
  if (!media) return false;
  if (item.referrer) {
    if (!flowOrigin.test(item.referrer)) return false;
    try {
      const ref = new URL(item.referrer);
      return ref.pathname === '/' || ref.pathname === new URL(tabUrl).pathname;
    } catch { return false; }
  }
  // Flow creates blob downloads with no referrer under Chrome's privacy
  // policy. Their URL still identifies the originating Flow page.
  return flowOrigin.test((item.url || '').replace(/^blob:/, '')) ||
    /^https:\/\/flow-content\.google\//i.test(item.url || '');
}

async function downloadVideoViaMenuUnlocked(tabId, promptId, excludeSources, onStage, targetMp4Name, onDownloadStarted, expectedResult, captureForWorkspace=false) {
  const recoverTimedOutPage = async () => {
    if (!flowDownloadUnsafeTabs.has(tabId)) return;
    if (typeof flowOthersInFlight === 'function' && flowOthersInFlight(promptId)) { try { onStage?.('Flow refresh postponed until the other prompts are saved'); } catch { /* UI-only */ } return; }
    try { onStage?.('refreshing Flow after the previous download timeout'); } catch { /* UI-only */ }
    // Checked above: no other prompt is being submitted or tracked on this page now.
    // Navigation destroys the old upscale callback before the next capture.
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId, 60000);
    flowDownloadUnsafeTabs.delete(tabId);
  };
  await recoverTimedOutPage();
  const downloadStartedAt = Date.now();
  const stage = (text) => {
    try { onStage && onStage(text); } catch { /* UI-only */ }
    if (/^(locating|opening|hovering|clicking|settling)\b/.test(text)) log(`${promptId}: ${text} (+${Math.round((Date.now() - downloadStartedAt) / 1000)}s after download lookup started).`);
  };
  let openedAnyMenu = false;
  let handedOff = false;
  let videoReplies = null;
  const target = { tabId };
  let ownsDebugger = false;
  const releaseDebugger = async () => {
    if (!ownsDebugger) return;
    ownsDebugger = false;
    await chrome.debugger.detach(target).catch(() => {});
  };
  try {
    // Attaching changes the viewport when Chrome displays its debugger banner.
    // Locate every point after attachment, and keep the same layout/hover alive
    // until resolution selection and menu cleanup are complete.
    try {
      await chrome.debugger.attach(target, '1.3');
      ownsDebugger = true;
    } catch (e) {
      if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e;
    }
    await sleep(350);
    stage('locating the finished video card');
    let resultPin = expectedResult;
    const locateConfirmedCard = async () => {
      let lastError = 'card lookup: no response';
      for (let attempt = 0; attempt < 20; attempt++) {
        if (typeof stopRequested !== 'undefined' && stopRequested) throw new Error('Cancelled by user');
        const found = await exec(tabId, pg_flowVideoCardPoint, [excludeSources || [], resultPin]);
        if (found?.ok) return found;
        lastError = found?.error || 'card lookup: no response';
        // A lookup without a positive identity cannot safely be recovered.
        if (!resultPin || attempt === 19) break;
        stage(`restoring the confirmed video card (lookup retry ${attempt + 1}/19)`);
        await exec(tabId, pg_flowRestoreConfirmedVideoView, [resultPin]);
        await sleep(800);
      }
      throw new Error(lastError);
    };
    const card = await locateConfirmedCard();
    resultPin = expectedResult || card.identity;
    const mobileMenu = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
    const openDownloadSizes = async () => {
    if (mobileMenu) {
      // Flow exposes its tile menu through contextmenu on touch layouts.
      // Use the same trusted context click as image downloads, on this exact
      // identity-confirmed card, rather than waiting for a hover-only button.
      stage('opening the confirmed video touch menu');
      const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
      const current = await locateConfirmedCard();
      openedAnyMenu = true;
      await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:current.hover.x, y:current.hover.y, button:'none'});
      await send('Input.dispatchMouseEvent', {type:'mousePressed', x:current.hover.x, y:current.hover.y, button:'right', clickCount:1});
      await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:current.hover.x, y:current.hover.y, button:'right', clickCount:1});
      await sleep(700);
    } else {
      // Desktop keeps its real hover overlay and remeasures mounted buttons.
      stage('hovering the video card for its download menu');
      await flowCdpMouseMove(tabId, card.hover.x, card.hover.y, true);
      await sleep(700);
      let button = null;
      for (let attempt = 0; attempt < 8 && !button; attempt++) {
        const re = await locateConfirmedCard();
        button = re && re.ok ? re.button : null;
        if (!button) {
          // Something left open over the page (owner run 2026-11-07: three cards showed no button) stops the hover:
          // close it once with Esc, then hover again.
          if (attempt === 4) { await cdpEscape((method, params) => chrome.debugger.sendCommand(target, method, params)).catch(() => {}); await sleep(300); }
          await flowCdpMouseMove(tabId, re.hover.x, re.hover.y, true); await sleep(400);
        }
      }
      if (!button) throw new Error('Finished card download button did not appear after hover');
      const openTarget = button;
      openedAnyMenu = true;
      await flowCdpClick(tabId, openTarget.x, openTarget.y, true);
      await sleep(700);
    }
    // The ⋮ menu may show Download directly, or this click already opened the
    // resolution popover. Only click "Download" when no resolution items are
    // on screen yet.
    let option = await exec(tabId, pg_flowMenuItemPoint, ['\\d{3,4}p|\\b4k\\b', 'animated|\\bgif\\b|upscale note|watermark']).catch(() => null);
    if (!option || !option.ok) {
      stage('opening the card Download menu');
      const downloadItem = await exec(tabId, pg_flowMenuItemPoint, ['\\bdownload\\b', 'downloading|downloaded|download failed']);
      if (!downloadItem || !downloadItem.ok) throw new Error('Download item not found on the video card menu');
      await flowCdpClick(tabId, downloadItem.x, downloadItem.y, true);
      await sleep(700);
      // Both desktop and touch layouts can mount the submenu late under load.
      // Wait for it without clicking Download twice (which can close the menu).
      const attempts = 24;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (typeof stopRequested !== 'undefined' && stopRequested) throw new Error('Cancelled by user');
        option = await exec(tabId, pg_flowMenuItemPoint, ['\\d{3,4}p|\\b4k\\b', 'animated|\\bgif\\b']).catch(() => null);
        if (option?.ok) break;
        if (attempt + 1 < attempts) await sleep(500);
      }
    }
    return option;
    };
    // Owner 2026-11-10 (several members: "No resolution options appeared after clicking Download"): the sizes can mount
    // late or not at all on the first try. Wait longer (12 s), then close the menu and open it again, up to 3 times.
    // The log and the final error name what the menu showed, so a changed Flow menu can be seen from a Debug log.
    let option = null, menuError = '', menuShown = '';
    const sendKey = (method, params) => chrome.debugger.sendCommand(target, method, params);
    for (let round = 0; round < 3 && !(option && option.ok); round++) {
      if (round) {
        log(`${promptId}: ${menuError}; the open menu shows: ${menuShown || 'nothing'}. Closing it and opening the Download menu again (try ${round + 1} of 3).`);
        for (let i = 0; i < 3; i++) { await cdpEscape(sendKey).catch(() => {}); await sleep(300); }
        await sleep(900);
      }
      try { option = await openDownloadSizes(); menuError = option && option.ok ? '' : 'No resolution options appeared after clicking Download'; }
      // Only a menu that did not show is tried again; a lost card, Stop or a closed page fails as before.
      catch (e) { if (!/Download item not found/i.test(e?.message || '')) throw e; option = null; menuError = String(e?.message || e); }
      if (!(option && option.ok)) menuShown = ((await exec(tabId, pg_flowOpenMenuTexts).catch(() => null)) || []).join(' | ');
    }
    if (!option || !option.ok) throw new Error(`${menuError}${menuShown ? ` (the menu showed: ${menuShown})` : ''}`);
    // An explicit download preference must match; never silently save a lower resolution.
    const wanted = String(settings.videoResolution || 'default').toLowerCase();
    let pick = option;
    if (wanted !== 'default' && !new RegExp(`\\b${wanted}\\b`, 'i').test(option.text || '')) {
      const all = await exec(tabId, pg_flowMenuItemPoint, [`\\b${wanted}\\b`, 'animated|\\bgif\\b']).catch(() => null);
      if (all && all.ok) pick = all;
      // A 360p draft (owner 2026-11-07): Flow may not offer the bigger download size for it. Save what Flow offers
      // instead of leaving the draft in Flow.
      else if (String(settings.videoGenerationResolution || '').toLowerCase() === '360p') log(`${promptId}: Flow offers no ${wanted} download for this 360p draft; saving ${(/(\d{3,4}p|\b4k\b)/i.exec(option.text || '') || [option.text || 'its default size'])[0]} instead.`);
      else throw new Error(`Flow download resolution unavailable: ${wanted}. Generated video is retained in Flow; choose an available download resolution.`);
    }
    const pickedLabel = /(\d{3,4}p)/i.exec(pick.text || option.text || '')?.[1] || (pick.text || '').slice(0, 12);
    const detail = `download menu, picked ${pickedLabel}`;
    // Chrome's own downloader is the reliable transport (re-fetching the
    // signed URL from the panel raced and 403'd). Register a rename so the
    // browser download lands in the chosen Chrome Downloads subfolder,
    // then click the resolution and wait for Chrome to report it complete.
    // Never download to the final output name; cleanup must not delete it.
    const targetName = outputDir ? `flowstudio-temp-${Date.now()}-${Math.random().toString(36).slice(2,10)}.mp4`
      : targetMp4Name || `flow_${String(Date.now() % 1000).padStart(3, '0')}.mp4`;
    const folder = downloadFolder(typeof queue !== 'undefined' ? queue.find(x => x.id === promptId) : null);
    const subfolder = `${folder}/`;
    stage(`clicking ${pickedLabel} — Chrome is saving it`);
    let downloadId = null, suggestedName = targetName;
    let menuClosed = false;
    let mobileSaveReady = !mobileMenu;
    // Owner 2026-11-10: since about Nov 9 Flow prepares a 720p download for 35-55 s before Chrome gets the file (it was
    // 5-10 s), and the next prompt waited all that time. On computers the next prompt may now start as soon as the size
    // is chosen and the menu is closed: Flow prepares the file in the background and nothing else touches the page for
    // this download. Its download window stays open (downloadVideoViaMenu serializes downloads), so a second video that
    // finishes early waits until this one is saved. Phones still wait for Chrome's download (their Save sheet needs it).
    let detectionLogged = false;
    const handOffDownload = () => {
      if (downloadId !== null && !detectionLogged) {
        detectionLogged = true;
        log(`${promptId}: browser download detected for ${pickedLabel} (+${Math.round((Date.now() - captureStartedAt) / 1000)}s after resolution selection).`);
      }
      if (!mobileSaveReady || !menuClosed || handedOff) return;
      if (downloadId === null && mobileMenu) return;
      handedOff = true;
      if (downloadId === null) log(`${promptId}: Flow is preparing ${pickedLabel}; the next prompt can start while this video is prepared and saved.`);
      if (onDownloadStarted) onDownloadStarted();
    };
    let downloadDone = null;
    let completionTimer;
    let pollTimer;
    let polling = true;
    const flowTab = await chrome.tabs.get(tabId);
    const captureStartedAt = Date.now();
    const isFlowDownload = (item) => {
      if (!polling) return false;
      if (downloadId !== null) return item.id === downloadId;
      return matchesFlowDownload(item, flowTab.url, captureStartedAt);
    };
    const determiningListener = (downloadItem, suggest) => {
      if (!isFlowDownload(downloadItem)) { suggest(); return; }
      downloadId = downloadItem.id;
      handOffDownload();
      const ownName = !outputDir && settings.renameOutputs === false ? outputFileName({id: promptId}, 'mp4', platformFileName(downloadItem.filename)) : '';
      suggestedName = ownName || targetName;
      suggest({ filename: `${subfolder}${suggestedName}`, conflictAction: 'uniquify' });
    };
    const createdListener = (item) => {
      if (isFlowDownload(item)) { downloadId = item.id; handOffDownload(); }
    };
    const changedListener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        if (downloadDone) downloadDone({ state: delta.state.current, id: delta.id, error: delta.error?.current });
      }
    };
    chrome.downloads.onCreated.addListener(createdListener);
    chrome.downloads.onDeterminingFilename.addListener(determiningListener);
    chrome.downloads.onChanged.addListener(changedListener);
    let outcome = null;
    try {
      downloadDone = null; // assigned lazily below
      const waitMinutes = 5;
      const completion = new Promise((resolve) => { downloadDone = resolve; completionTimer = setTimeout(() => { polling = false; resolve({ state: 'timeout' }); }, waitMinutes * 60 * 1000); });
      let lastStageAt = 0;
      // Events can arrive before the filename/MIME is populated, or the
      // complete event may precede ID capture. Reconcile Chrome's records.
      const poll = async () => {
        // Stop while Flow is still preparing (no browser download yet) ends the wait now instead of after up to 5 minutes.
        // A download Chrome already started is left to finish, so it still gets its name.
        if (typeof stopRequested !== 'undefined' && stopRequested && downloadId === null) { polling = false; downloadDone({ state: 'cancelled' }); return; }
        if (Date.now() - lastStageAt > 5000) {
          const elapsed = Math.floor((Date.now() - captureStartedAt) / 1000);
          // 720p and lower need no upscale and start within seconds. Chrome silently holds a site's second automatic
          // download until "Download multiple files" is allowed (owner run 2026-10-19: p001 saved, p002 never started).
          const blockedHint = elapsed >= 20 && mobileMenu ? ' — tap Download in the browser\'s save prompt (or turn off "Ask Before Downloading" in its download settings)'
            : elapsed >= 20 && !/1080|2160|4k/i.test(pickedLabel) ? ' — if Chrome asks to allow multiple downloads from flow.google.com, click Allow' : '';
          stage(downloadId === null
            ? `${elapsed >= 120 ? 'Taking longer than expected — ' : ''}waiting for Flow ${pickedLabel} preparation/upscaling (${elapsed}s; timeout ${waitMinutes}m)${blockedHint}`
            : `${elapsed >= 120 ? 'Taking longer than expected — ' : ''}Chrome is saving ${pickedLabel} (${elapsed}s; timeout ${waitMinutes}m)`);
          lastStageAt = Date.now();
        }
        try {
          const records = await chrome.downloads.search(downloadId !== null ? { id: downloadId } : { startedAfter: new Date(captureStartedAt).toISOString() });
          if (!polling) return;
          const record = records.find(isFlowDownload);
          if (record) {
            downloadId = record.id;
            handOffDownload();
            if (record.state === 'complete' || record.state === 'interrupted') {
              downloadDone({state: record.state, id: record.id, error: record.error});
              return;
            }
          }
        } catch { /* transient downloads API failure; retry */ }
        if (polling) pollTimer = setTimeout(poll, 500);
      };
      // Let Flow create its authenticated download, including blob URLs.
      if (typeof flowReplyWatch === 'function') { videoReplies = flowReplyWatch(tabId, /^video\/|octet-stream/i); await videoReplies.start().catch(() => {}); }
      await flowCdpClick(tabId, pick.x, pick.y, true);
      await sleep(700);
      // Resolution selection starts Flow's background preparation. Close any
      // remaining menu before allowing the next prompt to use this composer.
      await cdpEscape((method,params)=>chrome.debugger.sendCommand(target,method,params));
      // Owner phone test 2026-11-08: phones have no run-long debugger hold, and letting go here also ended the reply copy
      // while Flow was still fetching the video. Phones let go right after the copy is taken (below).
      if (!(mobileMenu && videoReplies)) await releaseDebugger();
      menuClosed = true;
      handOffDownload();
      await poll();
      outcome = await completion;
    } finally {
      polling = false;
      clearTimeout(completionTimer);
      clearTimeout(pollTimer);
      chrome.downloads.onCreated.removeListener(createdListener);
      chrome.downloads.onDeterminingFilename.removeListener(determiningListener);
      chrome.downloads.onChanged.removeListener(changedListener);
    }
    if (!outcome || outcome.state !== 'complete') {
      if (outcome?.state === 'cancelled') {
        // Flow may still hand over this download later: refresh the page before its next download, like after a timeout.
        flowDownloadUnsafeTabs.add(tabId);
        throw new Error('Automation cancelled by user');
      }
      if (outcome?.state === 'timeout') {
        // A known browser ID cannot be claimed by the next capture. If Flow
        // never started a browser download, clear its pending page callbacks
        // while the generation slot is still held, then let the queue continue.
        let recoveryDetail = '';
        if (downloadId === null && typeof flowOthersInFlight === 'function' && flowOthersInFlight(promptId)) {
          flowDownloadUnsafeTabs.add(tabId);
          recoveryDetail = '. Flow will be refreshed after the other prompts are saved';
        } else if (downloadId === null) {
          flowDownloadUnsafeTabs.add(tabId);
          try {
            await recoverTimedOutPage();
            recoveryDetail = '. Flow refreshed; the next video will get its own download attempt';
          } catch (error) {
            recoveryDetail = '. Flow refresh failed: ' + String(error?.message || error) + '; recovery will be retried before the next download';
          }
        }
        throw new Error('Flow download wait expired: 5-minute limit reached; video retained in Flow; generation will not be retried' + recoveryDetail);
      }
      throw new Error(`browser download did not complete (${outcome ? outcome.error || outcome.state : 'no signal'})`);
    }
    // Confirm size via the downloads record (byte-level MP4 check is not
    // possible on Chrome-managed files; size plus Flow's own encoding is the
    // acceptance gate here).
    const [record] = await chrome.downloads.search({ id: outcome.id });
    const bytes = (record && record.fileSize) || 0;
    if (bytes < 100 * 1024) throw new Error(`downloaded file is only ${bytes} bytes`);
    const replyBytes = videoReplies ? await videoReplies.bytes(bytes).catch(() => null) : null;
    if (mobileMenu) await releaseDebugger();
    if (videoReplies) log(`${promptId}: ${replyBytes ? 'copy for the workspace read from Flow\'s own reply' : `Flow's reply could not be read back (${videoReplies.summary()}); the workspace copy falls back to the download link`}.`);
    if (mobileMenu && !(typeof stopRequested !== 'undefined' && stopRequested)) {
      if (typeof wakeMobilePanelAfterSave === 'function') await wakeMobilePanelAfterSave();
      stage('settling mobile save for 3 seconds before continuing');
      // A native Save sheet can outlive the download-created event. Hold the
      // generation slot until completion, then let the sheet dismiss before
      // touching Flow settings or releasing another prompt.
      for (let i = 0; i < 6; i++) {
        if (typeof stopRequested !== 'undefined' && stopRequested) break;
        await sleep(500);
      }
      if (!(typeof stopRequested !== 'undefined' && stopRequested)) {
        try {
          await chrome.tabs.update(tabId, {active:true});
          const currentUrl = await exec(tabId, pg_flowCurrentUrl, []);
          if (String(currentUrl).split(/[?#]/)[0] !== String(flowTab.url).split(/[?#]/)[0]) throw new Error('the original Flow project is no longer open');
          try { await chrome.debugger.attach(target, '1.3'); ownsDebugger = true; }
          catch (error) { if (!/another debugger|already attached/i.test(String(error?.message || error))) throw error; }
          const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
          let composerReady = false;
          for (let attempt = 0; attempt < 10; attempt++) {
            if (typeof stopRequested !== 'undefined' && stopRequested) break;
            await cdpEscape(send);
            const composer = await exec(tabId, pg_flowComposerReady, []);
            if (composer?.ok) { composerReady = true; break; }
            await sleep(500);
          }
          await releaseDebugger();
          if (!composerReady && !(typeof stopRequested !== 'undefined' && stopRequested)) throw new Error('Flow composer or video settings are still covered');
          mobileSaveReady = composerReady;
        } catch (error) {
          // The file is already saved. Preserve that success and remaining
          // prompts instead of converting cleanup into a regeneration retry.
          stopRequested = true;
          queueStopReason = `Video saved. Return to the original Flow project, then press Start (${String(error?.message || error)}).`;
          log(`${promptId}: ${queueStopReason}`);
        }
      }
      if (!(typeof stopRequested !== 'undefined' && stopRequested)) handOffDownload();
    }
    // Android reports a content:// id instead of a path; the file lands at the requested Download/<folder>/<name>
    // (Firebase phone test 2026-10-30), so name it by the request instead of warning about "1000000026".
    const contentUri = /^content:\/\//i.test(String(record?.filename || ''));
    const actualName = contentUri ? suggestedName : String(record?.filename || '').split(/[\\/]/).pop() || targetName;
    // Say where Chrome really put it: a download that was not renamed lands in the Downloads root under Flow's own name.
    const savedPath = String(record?.filename || '').replace(/\\/g, '/');
    const parent = savedPath.slice(0, savedPath.lastIndexOf('/'));
    const inFolder = contentUri || (!!savedPath && parent.toLowerCase().endsWith(`/${folder.toLowerCase()}`));
    if (!inFolder) log(`${promptId}: WARNING — Chrome saved the video as "${actualName}" in your Downloads folder, not in "${folder}" (the download was not renamed). Full path: ${record.filename}`);
    else if (contentUri) log(`${promptId}: video saved via Flow ${detail} to Android Downloads as ${subfolder}${actualName} (${bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`}).`);
    else log(`${promptId}: video saved via Flow ${detail} → ${subfolder}${actualName} (${bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`}). Full path: ${record.filename}`);
    return { placedName: inFolder ? `${subfolder}${actualName}` : actualName, actualFilename:record?.filename || '', destinationVerified:inFolder, where:contentUri ? `Android Downloads/${folder}` : inFolder ? `Chrome Downloads/${folder}` : 'Chrome Downloads (requested folder not verified)', bytes, downloadId:outcome.id, sourceUrl: record?.finalUrl || record?.url, replyBytes };
  } finally {
    videoReplies?.stop();
    // Never leave a popover open — a stale menu breaks the next prompt's
    // setup ("settings trigger not found").
    if (openedAnyMenu && !handedOff) {
      try {
        await cdpEscape((method, params) => chrome.debugger.sendCommand(target, method, params));
      } catch { /* best effort */ }
    }
    await releaseDebugger();
  }
}

// Recover an already-generated download into the requested folder without another
// provider generation. Keep the original file; only use its exact captured URL.
async function flowEnsureDownloadFolder(tab, item, placed, token) {
  if (outputDir || placed.destinationVerified !== false) return placed;
  // Android browsers can ignore subfolders. A second download cannot fix
  // that and prompts for Save again; retain the completed native file instead.
  const android = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
  if (android) {
    log(`${item.id}: video retained in Android Downloads; skipping unsupported subfolder recovery to avoid a duplicate download.`);
    return {...placed, where:'Android Downloads'};
  }
  const stopped = () => (typeof stopRequested !== 'undefined' && stopRequested) || (token !== undefined && token !== runToken);
  if (stopped()) return placed;
  try {
    const bytes = placed.replyBytes || await downloadMediaBuffer(tab.id, {src:placed.sourceUrl,host:'Flow folder recovery'}, item.id);
    if (!P().bufferHasMp4Signature(bytes) || bytes.byteLength !== placed.bytes) throw Error('Selected-resolution MP4 verification failed');
    if (stopped()) return placed;
    const saved = await saveOutput(item, bytes, 'mp4', platformFileName(placed.placedName));
    log(`${item.id}: folder recovery: ${saved.name} -> ${saved.where}; original Chrome download retained.`);
    return {...placed, placedName:saved.name, where:saved.where, destinationVerified:saved.where === `Chrome Downloads/${downloadFolder(item)}`};
  } catch (error) {
    log(`${item.id}: folder recovery unavailable (${error.message}). Video remains at ${placed.actualFilename || 'Chrome Downloads'}; move it manually. Do not regenerate it.`);
    return placed;
  }
}

const mediaExtractionTurns = new Map();
// Storyboard sheets need Flow's 2K upscale: at 1K each of the four frames is only ~384 px wide. Right-click the tracked
// tile -> Download -> "2K Upscaled" (menu checked live 2026-10-23), catch the file Flow hands to Chrome, read its bytes
// and remove Chrome's temporary copy (saveOutput saves the sheet under its own name). Returns null when 2K is not offered.
async function flowDownloadTile2K(tabId, trackingKey, item) {
  const target = {tabId}, send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  let attached = false, created = null, finished = '', sheetReplies = null;
  try { await chrome.debugger.attach(target, '1.3'); attached = true; }
  catch (e) { if (!/another debugger|already attached/i.test(String(e?.message || e))) throw e; }
  const startedAt = Date.now();
  const fromFlow = d => /flow\.google|labs\.google|flow-content\.google/i.test(`${d.url || ''} ${d.finalUrl || ''} ${d.referrer || ''}`) || /^blob:https:\/\/(?:flow|labs)\.google/i.test(d.url || '');
  const onCreated = d => { if (!created && Date.parse(d.startTime || '') >= startedAt - 1000 && fromFlow(d) && !/video/i.test(d.mime || '')) created = d; };
  const onChanged = delta => { if (created && delta.id === created.id && delta.state && ['complete', 'interrupted'].includes(delta.state.current)) finished = delta.state.current; };
  chrome.downloads.onCreated.addListener(onCreated); chrome.downloads.onChanged.addListener(onChanged);
  const escape = async () => { for (let i = 0; i < 2; i++) { await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27}).catch(() => {}); await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27}).catch(() => {}); } };
  try {
    await exec(tabId, pg_flowTrackedTilePoint, [trackingKey]); await sleep(600);
    const tile = await exec(tabId, pg_flowTrackedTilePoint, [trackingKey]);
    if (!tile?.ok) throw new Error(tile?.error || 'tracked image tile not found');
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:tile.x, y:tile.y, button:'none'});
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x:tile.x, y:tile.y, button:'right', clickCount:1});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:tile.x, y:tile.y, button:'right', clickCount:1});
    await sleep(800);
    const download = await exec(tabId, pg_flowMenuItemPoint, ['\\bdownload\\b', 'downloading|downloaded|failed']);
    if (!download?.ok) throw new Error('Download was not in the image menu');
    await flowCdpMouseMove(tabId, download.x, download.y, true); await sleep(700);
    let option = await exec(tabId, pg_flowMenuItemPoint, ['\\b2k\\b', '\\b4k\\b|\\b1k\\b']);
    if (!option?.ok) { await cdpMouseClick(send, download.x, download.y); await sleep(700); option = await exec(tabId, pg_flowMenuItemPoint, ['\\b2k\\b', '\\b4k\\b|\\b1k\\b']); }
    if (!option?.ok) { await escape(); return null; }
    sheetReplies = typeof flowReplyWatch === 'function' ? flowReplyWatch(tabId, /^image\/|octet-stream/i) : null;
    await sheetReplies?.start().catch(() => {});
    await cdpMouseClick(send, option.x, option.y);
    // The upscale runs on Google's side before Chrome gets the file.
    for (const limit = Date.now() + 120000; !(created && finished) && Date.now() < limit;) { if (typeof stopRequested !== 'undefined' && stopRequested) throw new Error('Cancelled by user'); await sleep(500); }
    if (!created) throw new Error('Flow did not start the 2K download within 2 minutes');
    if (finished !== 'complete') throw new Error('the 2K download did not finish');
    const [record] = await chrome.downloads.search({id: created.id});
    const buf = (sheetReplies ? await sheetReplies.bytes(record?.fileSize || 0).catch(() => null) : null)
      || await downloadMediaBuffer(tabId, {src: created.finalUrl || created.url || record?.finalUrl || record?.url, host:'Flow 2K download'}, item.id);
    if (record?.exists !== false) await chrome.downloads.removeFile(created.id).catch(() => {});
    await chrome.downloads.erase({id: created.id}).catch(() => {});
    return buf;
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated); chrome.downloads.onChanged.removeListener(onChanged);
    sheetReplies?.stop();
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

async function downloadMediaBuffer(tabId, source, label) {
  const previous = mediaExtractionTurns.get(tabId) || Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  mediaExtractionTurns.set(tabId, turn);
  await previous;
  try { return await downloadMediaBufferUnlocked(tabId, source, label); }
  finally { release(); if (mediaExtractionTurns.get(tabId) === turn) mediaExtractionTurns.delete(tabId); }
}
async function downloadMediaBufferUnlocked(tabId, source, label) {
  // Flow's phone grid serves small /asb/ previews. Fetch the same image at its original size.
  const mobileImage = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
  if (mobileImage && /^https:\/\/flow\.google\.com\/asb\//i.test(source.src || '')) {
    const original = new URL(source.src);
    if (/=s\d+(?:-[a-z0-9]+)*$/i.test(original.pathname)) {
      original.pathname = original.pathname.replace(/=s\d+(?:-[a-z0-9]+)*$/i, '=s0');
      source = {...source, src: original.href};
    }
  }
  let buf = null;
  let extensionFetchError = null;
  if (/^https?:/i.test(source.src)) {
    for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
      try {
        const response = await fetch(source.src, { credentials: 'include', cache: 'no-store', signal:AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
          throw new Error(`unexpected content type ${contentType}`);
        }
        buf = await response.arrayBuffer();
        log(`${label}: media downloaded from ${source.host} via extension fetch.`);
      } catch (e) {
        extensionFetchError = String(e && e.message ? e.message : e);
        if (attempt < 3) await sleep(1500);
      }
    }
    if (!buf) log(`${label}: extension fetch from ${source.host} failed; trying page extraction.`);
  }
  if (!buf) {
    await exec(tabId, pg_startMediaExtraction, [source.src]);
    let extractState = null;
    const extractStart = Date.now();
    while (Date.now() - extractStart < 120000) {
      extractState = await exec(tabId, pg_pollMediaExtraction, []);
      if (extractState && (extractState.state === 'done' || extractState.state === 'error')) break;
      await sleep(1000);
    }
    if (!extractState || extractState.state !== 'done') {
      const pageError = extractState ? (extractState.error || extractState.state) : 'timed out';
      const extensionDetail = extensionFetchError ? `; extension fetch: ${extensionFetchError}` : '';
      throw new Error(`Media extraction failed from ${source.host}: page fetch: ${pageError}${extensionDetail}`);
    }
    const b64Len = await exec(tabId, pg_mediaB64Length, []);
    if (!b64Len) throw new Error('Media extraction produced an empty result');
    const CHUNK = 4 * 1024 * 1024;
    let mediaB64 = '';
    for (let off = 0; off < b64Len; off += CHUNK) {
      const part = await exec(tabId, pg_readMediaChunk, [off, CHUNK]);
      if (part == null) throw new Error(`Lost media data at offset ${off}`);
      mediaB64 += part;
    }
    if (mediaB64.length !== b64Len) {
      throw new Error(`Media data incomplete: got ${mediaB64.length} of ${b64Len} base64 chars`);
    }
    buf = base64ToBuffer(mediaB64);
    log(`${label}: media downloaded from ${source.host} via page extraction.`);
  }
  return buf;
}

// File names use the prompt's FIRST SENTENCE, after labels such as "Scene 1:", "SCENE 01 -", "Shot 2.", "Eksena 3:",
// "[Style: ...]" or "(0-8s)" (user report 2026-10-19: every file was named 001_Scene_..., so scenes could not be told apart).
function outputNameForItem(item, ext) {
  // A storyboard sheet is not a scene image: p01_sheet_001-004.jpg (owner 2026-10-24: it was saved as p01_scene_001).
  if(item.builderProjectId&&item.builderSheetIds?.length)return `p${String(item.builderPartNumber||1).padStart(2,'0')}_sheet_${item.builderSheetIds[0].replace(/^\D+/,'')}-${item.builderSheetIds.at(-1).replace(/^\D+/,'')}.${String(ext).replace(/[^a-z0-9]/gi,'').toLowerCase()}`;
  if(item.builderProjectId&&(item.builderImageId||item.builderSceneId))return `p${String(item.builderPartNumber||1).padStart(2,'0')}_${item.builderImageId||item.builderSceneId}.${String(ext).replace(/[^a-z0-9]/gi,'').toLowerCase()}`;
  const flowNamePromptStart = text => {
    const trim = value => value.replace(/^[\s"'*#>_\-]+/, '');
    let rest = trim(String(text || ''));
    const label = /^(?:\[[^\]\n]{0,200}\]|\([^)\n]{0,30}\d[^)\n]{0,30}\)|(?:scene|shot|frame|clip|part|prompt|eksena|kuha|video prompt|image prompt)\s*#?\s*\d*[a-z]?(?=\s*[:.)|\-–—(]|\s*$|\s+\d))\s*[:.)|\-–—]?\s*/i;
    for (let i = 0; i < 5; i++) { const next = trim(rest.replace(label, '')); if (next === rest) break; rest = next; }
    if (!/\p{L}/u.test(rest)) return String(text || '');
    // The first sentence (when it has at least 3 words); otherwise the start of the text.
    const sentence = rest.split(/(?<=[.!?])\s+|\n+/)[0];
    return (sentence.match(/[\p{L}\p{N}]+/gu) || []).length >= 3 ? sentence : rest;
  };
  // A scene label alone on the first line ("Scene_01", "SCENE 12") keeps its number in the name: 001_Scene_01_... (user
  // report 2026-11-08: Scene_01 / Scene_02 prompts were saved as 001_Scene_GEMINI_..., 002_Scene_GEMINI_...).
  // A reference block at the top ("REFERENCE ROLE MAPPING" + "Image 1 \u2014 SAB \u2026" lines) is skipped, so the name comes from the
  // scene itself (owner 2026-11-08: every Drama Factory prompt was saved as 00N_REFERENCE_ROLE_MAPPING (1).mp4).
  const skipReferences = text => {
    const head = text.match(/^\s*(?:reference(?:\s+role)?\s+mapping|role\s+mapping|references?|reference\s+images?|character\s+references?)\s*:?[ \t]*\r?\n/i);
    if (!head) return text;
    const lines = text.slice(head[0].length).split(/\r?\n/);
    let i = 0;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:shot|scene|eksena|clip|part)\b/i.test(lines[i])
      && /^\s*(?:[-*\u2022]\s*)?(?:image|img|ref|reference|char|loc|prop|@)|[=\u2192\u2014\u2013:]/i.test(lines[i])) i++;
    const rest = lines.slice(i).join('\n');
    return /\p{L}/u.test(rest) ? rest.replace(/^\s+/, '') : text;
  };
  const original = String(item.text || item.generationText || '');
  let source = skipReferences(original);
  const ownLabel = source.match(/^\s*((?:scene|shot|eksena|clip|part)[\s_#-]*\d+[a-z]?)[ \t]*\r?\n/i);
  if (ownLabel && source === original) source = source.slice(0, ownLabel[0].length) + skipReferences(source.slice(ownLabel[0].length));
  const prompt = flowNamePromptStart((ownLabel ? source.slice(ownLabel[0].length) : source).normalize('NFKD').replace(/[\u0300-\u036f]/g,''));
  let words = (prompt.match(/[\p{L}\p{N}]+/gu) || []).filter(word=>/^\p{L}/u.test(word) || /^\d+(?:st|nd|rd|th)$/i.test(word));
  if (ownLabel) words = [ownLabel[1].replace(/[\s_#-]+/g, '_'), ...words];
  words = words.slice(0, ownLabel ? 5 : 6);
  // JSON scene prompts ({"scene_number": 183, ...}) are named by their scene, not "scene_number_character_locks_..." (owner 2026-10-25).
  const jsonScene = String(item.text || '').trim().match(/^\{[\s\S]*?"scene_number"\s*:\s*"?([\p{L}\p{N}_-]{1,20})/u)?.[1];
  const title = jsonScene ? `scene_${jsonScene}` : words.length ? words.join('_').slice(0,120).replace(/_+$/,'') : 'Prompt';
  return `${String(item.index).padStart(3,'0')}_${title}${item.outputSuffix || ''}.${String(ext).replace(/[^a-z0-9]/gi,'').toLowerCase()}`;
}

// ---------- auto download & file names (Settings → Output) ----------
// "No download": the result stays on the platform (Flow, ChatGPT, Gemini, Grok); nothing is saved to the computer.
// Faceless Builder items always download: the builder needs the image for review and the video step.
function autoDownloadOff(kind, item = null) {
  if (item?.builderProjectId) return false;
  return kind === 'video' ? settings.videoResolution === 'none' : settings.imageDownload === 'none';
}
function finishWithoutDownload(item, platform, kind) {
  item.status = 'done'; item.outputName = ''; item.progressPercent = 100; item.retryAt = null;
  item.detail = `${kind} generated — kept in ${platform} (auto download is off)`;
  if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);
  log(`${item.id}: ${item.detail}.`);
}
// The platform's own file name, from a media URL (".../generated_video.mp4") or a Chrome download path.
function platformFileName(source) {
  const raw = String(source || '');
  if (!raw || /^(?:blob|data):/i.test(raw)) return '';
  let last = raw;
  try { if (/^https?:/i.test(raw)) last = new URL(raw).pathname; } catch { /* keep as is */ }
  last = last.split(/[\\/]/).pop() || '';
  try { last = decodeURIComponent(last); } catch { /* keep encoded */ }
  return last;
}
// Auto change file name ON (default): "001_prompt_words.ext". OFF: the platform's own name, made safe for Windows; when the
// platform gives no usable name, "<platform>_<prompt id>.ext".
// Explicit reference format: NAME, description (or @NAME, description).
// Keep image bytes/extension intact, reject paths and Windows device names, and
// leave Builder's stable IDs and all video file names on their existing paths.
// Say once per prompt why the reference name was not used, instead of silently saving 003_....png.
function referenceNameMiss(item) {
  if (!item?.id || item.referenceNameMissLogged || typeof log !== 'function') return;
  item.referenceNameMissLogged = true;
  log(`${item.id}: "Save images using reference names" is on, but the first line does not start with a name. Write it as NAME, description (for example GAB, Filipino man...). This image keeps its normal file name.`);
}
function referenceImageFileName(item, ext) {
  if (!settings.referenceImageNames || item.builderProjectId || !/^(png|jpe?g|webp|avif|gif|heic)$/i.test(ext)) return '';
  // User report 2026-11-08 ("fails sometimes"): also accept the usual ways people write the name — NFC/NFD accents,
  // a hidden BOM, **bold** or "quoted" names, "NAME: description", digits ("GUARD 2"), dots/brackets/& ("Dr. Cruz",
  // "GAB (young)") and a typed extension ("GAB.png, ..."). Path characters still fall back to the normal name.
  const firstLine = String(item.text || item.generationText || '').normalize('NFC').replace(/[​-‍﻿]/g, '').trim().split(/\r?\n/)[0]
    .replace(/^[\s>#"“”'‘’]+/, '');
  const match = firstLine.match(/^@?(?:\*\*|__)?([\p{L}\p{N}][\p{L}\p{M}\p{N}_'’ .()&-]{0,63}?)(?:\*\*|__)?\s*["”’]?\s*[,:]\s*\S/u);
  if (!match) { referenceNameMiss(item); return ''; }
  const name = match[1].trim().replace(/\.(?:png|jpe?g|webp|avif|gif|heic)$/i, '').replace(/\s+/g, '_').replace(/[._-]+$/, '');
  if (!name || name.startsWith('.') || /^(?:scene|shot|frame|clip|part|prompt|eksena|kuha)_?#?\d*$/i.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) { referenceNameMiss(item); return ''; }
  const suffix = String(item.outputSuffix || '').replace(/[^a-z0-9_-]/gi, '');
  return `${name}${suffix}.${String(ext).toLowerCase()}`;
}
function outputFileName(item, ext, platformName = '') {
  if(item.builderProjectId)return outputNameForItem(item,ext);
  const referenceName = referenceImageFileName(item, ext);
  if (referenceName) return referenceName;
  if (settings.renameOutputs !== false) return outputNameForItem(item, ext);
  const cleanExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase();
  let name = String(platformName || '').replace(/[\u0000-\u001f<>:"\/\\|?*]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  if (name && !/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${cleanExt}`;
  return name || `${item.platform || settings.platform || 'flow'}_${item.id}.${cleanExt}`;
}

function canCleanupTemporaryDownload(downloadPath, finalName) {
  const base = String(downloadPath || '').split(/[\\/]/).pop().toLowerCase();
  return base !== String(finalName || '').toLowerCase() && /^flowstudio-temp-[a-z0-9-]+\.mp4$/.test(base);
}
// A free name in the project folder: "001_x.mp4", else "001_x (2).mp4", "001_x (3).mp4"… (never overwrite an earlier render;
// the Chrome Downloads path does the same with conflictAction 'uniquify').
async function freeOutputName(dir, name) {
  const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${base} (${n})${ext}`;
    try { await dir.getFileHandle(candidate); } catch (error) { if (error?.name === 'NotFoundError') return candidate; throw error; }
  }
  throw new Error(`Too many files named like ${name} in the project folder`);
}

async function saveOutput(item, buf, ext, platformName = '') {
  if (item.manualSheetIds?.length && /^(png|jpe?g|webp)$/i.test(ext)) return await saveManualSheet(item, buf, ext, platformName);
  if(item.manualProjectId&&item.manualSceneId&&/^(mp4|webm)$/i.test(ext)&&window.FlowBuilderUI?.captureManualVideo){
    try{await window.FlowBuilderUI.captureManualVideo(item,buf,ext);}catch(error){log(`${item.id}: video downloaded, but manual workspace copy could not be saved (${error.message}). Import the downloaded clip in Story Workspace.`);}
  }
  if (item.builderProjectId && !item.skipBuilderCapture && /^(png|jpg|jpeg|webp|avif)$/i.test(ext)) {
    await window.FlowBuilderUI.captureImage(item, buf, ext);
  }
  if(item.builderProjectId&&item.builderSceneId&&String(ext).toLowerCase()==='mp4'&&window.FlowBuilderUI?.captureVideo){
    try{await window.FlowBuilderUI.captureVideo(item,buf,ext);}catch(error){log(`${item.id}: workspace clip could not be saved locally (${error.message}); import the downloaded MP4 in Story Workspace.`);}
  }
  let name = typeof outputFileName === 'function' ? outputFileName(item, ext, platformName) : outputNameForItem(item, ext);
  if (outputDir) {
    name = await freeOutputName(outputDir, name);
    const outHandle = await outputDir.getFileHandle(name, { create: true });
    const writable = await outHandle.createWritable();
    await writable.write(buf);
    await writable.close();
    if (settings.savePromptCopy === 'yes') {
      const txtHandle = await outputDir.getFileHandle(`${name.replace(/\.[^.]+$/, '')}.txt`, { create: true });
      const txtWritable = await txtHandle.createWritable();
      await txtWritable.write(item.text || '');
      await txtWritable.close();
    }
    return { name, where: outputDirName || 'selected folder' };
  }
  const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', mp4: 'video/mp4' };
  const blob = new Blob([buf], { type: mimes[String(ext).toLowerCase()] || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  blobUrls.add(url);
  // Claim our own blob download's file name. Without this, a download-manager extension that re-suggests Chrome's default
  // name can drop the file into the Downloads root under the blob's UUID, ignoring the subfolder and file name given below.
  const folder = downloadFolder(item);
  const wanted = `${folder}/${name}`;
  const naming = (d, suggest) => { if (d.url === url || d.finalUrl === url) suggest({ filename: wanted, conflictAction: 'uniquify' }); else suggest(); };
  const namingEvents = chrome.downloads.onDeterminingFilename;
  if (namingEvents?.addListener) namingEvents.addListener(naming);
  let savedRecord = null;
  try {
    // Android browsers (Quetta) ask the user to tap Download for every file; a prompt nobody tapped comes back USER_CANCELED.
    // The image is already made, so offer the prompt again instead of losing it (owner log 2026-10-29).
    const mobile = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
    const saveHint = 'Waiting for the browser to save the file: tap Download in its prompt. To skip the prompt for every file, turn off "Ask Before Downloading" in the browser\'s download settings (Quetta: menu → Downloads → settings).';
    let complete = false;
    for (let attempt = 1; !complete; attempt++) {
      const downloadId = await chrome.downloads.download({ url, filename: wanted, saveAs: false });
      // Phones wait up to 10 minutes: Quetta holds each file behind its own Download sheet, and even a saved file took up
      // to 100 seconds (Firebase phone test 2026-10-30). One hint after 20 seconds says what to tap.
      const started = Date.now(), limit = mobile ? 600000 : 120000; let interrupted = '', hinted = false;
      while (Date.now() - started < limit && !(mobile && typeof stopRequested !== 'undefined' && stopRequested)) {
        const [record] = await chrome.downloads.search({id: downloadId});
        if (record?.state === 'complete') { complete = true; savedRecord = record; if (mobile && typeof wakeMobilePanelAfterSave === 'function') await wakeMobilePanelAfterSave(); break; }
        if (record?.state === 'interrupted') { interrupted = record.error || 'check Chrome Downloads'; break; }
        if (mobile && !hinted && Date.now() - started > 20000) { hinted = true; log(`${item.id}: ${saveHint}`); }
        await sleep(500);
      }
      if (complete) break;
      if (!interrupted) throw Error(mobile ? `Media download did not finish: the browser's Download prompt was not tapped. The image is still in Flow; press Retry. ${saveHint}` : 'Media download did not finish. Check Chrome Downloads before retrying.');
      if (!(mobile && interrupted === 'USER_CANCELED' && attempt < 3)) throw Error('Media download interrupted: ' + interrupted + (mobile && interrupted === 'USER_CANCELED' ? ' (the browser\'s Download prompt was not tapped; the image is still in the ChatGPT/Flow tab)' : ''));
      log(`${item.id}: the browser's save prompt was closed without saving — tap Download to save ${name} (try ${attempt + 1} of 3).`);
      await sleep(1500);
    }
  } finally {
    if (namingEvents?.removeListener) namingEvents.removeListener(naming);
    setTimeout(() => { URL.revokeObjectURL(url); blobUrls.delete(url); }, 5 * 60 * 1000);
  }
  // Report where Chrome really put it: a file that ignored the subfolder is in the Downloads root under another name.
  const savedPath = String(savedRecord?.filename || '').replace(/\\/g, '/');
  const savedParent = savedPath.slice(0, savedPath.lastIndexOf('/'));
  // Android reports a content:// id ("content://media/external/downloads/1000000023"), not a path; the file itself
  // lands at the requested Download/<folder>/<name> (Firebase phone test 2026-10-30).
  if (/^content:\/\//i.test(savedPath)) {
    log(`${item.id}: saved to Android Downloads as ${wanted}.`);
    return { name, where: `Android Downloads/${folder}` };
  }
  if (!savedPath || !savedParent.toLowerCase().endsWith(`/${folder.toLowerCase()}`)) {
    const actual = savedPath.split('/').pop() || name;
    const mobileDownload = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
    if (mobileDownload) {
      log(`${item.id}: saved ${actual} in Android Downloads; this browser did not apply the requested subfolder.`);
      return {name:actual, where:'Android Downloads'};
    }
    log(`WARNING — Chrome saved "${name}" as "${actual}" in your Downloads folder, not in "${downloadFolder(item)}". Another extension or a Chrome download setting overrode the name (try turning off other download-manager extensions). Full path: ${savedRecord.filename}`);
    return { name: actual, where: 'Chrome Downloads (not in the subfolder)' };
  }
  return { name: savedPath.split('/').pop() || name, where: `Chrome Downloads/${folder}` };
}

// Outputs per Prompt 2-4 (Flow): after the main result is saved, the prompt's other result tiles are saved too, named
// like the main file plus _2/_3/_4. A missing or failed extra never fails the prompt (the main file is already saved and
// the extra stays in Flow); a Stop simply ends this step. AI Story items keep one result (the builder uses one image).
function flowWantsExtraOutputs(item) {
  return (Number(settings.flowOutputCount) || 1) > 1 && !item?.builderProjectId && !autoDownloadOff(MODES[settings.mode]?.resultKind === 'video' ? 'video' : 'image', item);
}
async function flowSaveExtraOutputs(tab, item, trackingKey, wantsVideo, token) {
  if (!tab?.id || !flowWantsExtraOutputs(item)) return;
  const count = Math.min(4, Number(settings.flowOutputCount) || 1), mainDetail = item.detail, savedNames = [];
  const stopped = () => stopRequested || token !== runToken;
  for (let index = 1; index < count && !stopped(); index++) {
    const label = `output ${index + 1}/${count}`;
    let tracked = null, stableSince = null, lastKey = '';
    const start = Date.now();
    while (!stopped() && Date.now() - start < settings.maxWaitMinutes * 60 * 1000) {
      tracked = await exec(tab.id, pg_flowTrackedResult, [trackingKey, index]).catch(() => null);
      if (!tracked || tracked.error) break;
      if (tracked.waiting && Date.now() - start > 60000) break;   // Flow made fewer results than requested
      if (tracked.ready) {
        const key = JSON.stringify(wantsVideo ? tracked.identity : tracked.src);
        if (key !== lastKey) { lastKey = key; stableSince = Date.now(); }
        if (Date.now() - stableSince >= 3000) break;
      } else { stableSince = null; lastKey = ''; }
      item.detail = `saving the other Flow results (${label}${Number.isFinite(tracked.progressPercent) ? `, ${tracked.progressPercent}%` : ''})`;
      renderQueue();
      await sleep(POLL_MS);
    }
    if (stopped()) break;
    if (!tracked?.ready) {
      log(`${item.id}: ${label} not saved — ${tracked?.error || (tracked?.waiting ? 'Flow showed no extra result tile' : 'it did not finish in time')}. It stays in Flow.`);
      continue;
    }
    const extra = Object.assign({}, item, {outputSuffix: `_${index + 1}`});
    delete extra.manualProjectId; delete extra.manualSceneId; // Extra takes download separately; keep the primary workspace clip.
    try {
      let saved;
      if (wantsVideo) {
        let placed = await downloadVideoViaMenu(tab.id, item.id, [], text => { item.detail = `${label}: ${text}`; renderQueue(); },
          outputNameForItem(extra, 'mp4'), null, tracked.identity);
        placed = await flowEnsureDownloadFolder(tab, extra, placed, token);
        if (outputDir) {
          const bytes = placed.replyBytes || await downloadMediaBuffer(tab.id, {src: placed.sourceUrl, host: 'Flow download'}, item.id);
          if (!P().bufferHasMp4Signature(bytes)) throw new Error('Invalid MP4 data');
          saved = await saveOutput(extra, bytes, 'mp4', platformFileName(placed.placedName));
          if (canCleanupTemporaryDownload(placed.actualFilename, saved.name)) await chrome.downloads.removeFile(placed.downloadId).catch(() => {});
        } else saved = {name: placed.placedName, where: placed.where || 'Chrome Downloads'};
      } else {
        let host = 'page'; try { host = new URL(tracked.src).hostname; } catch { /* keep label */ }
        const buf = await downloadMediaBuffer(tab.id, {ok: true, src: tracked.src, host}, item.id);
        if (buf.byteLength < 10 * 1024 || !P().bufferHasImageSignature(buf)) throw new Error('the downloaded bytes are not a valid image');
        saved = await saveOutput(extra, buf, guessImageExt(buf, ''), platformFileName(tracked.src));
      }
      savedNames.push(saved.name);
      log(`${item.id}: ${label} saved - ${saved.name} \u2192 ${saved.where}.`);
    } catch (error) {
      log(`${item.id}: ${label} could not be saved (${String(error?.message || error)}). It stays in Flow.`);
    }
  }
  item.extraOutputs = savedNames;
  item.detail = savedNames.length ? `${mainDetail} (+${savedNames.length} more result${savedNames.length > 1 ? 's' : ''})` : mainDetail;
  renderQueue();
}

// Which Flow project a tab shows ("" on the home page): a kept video is only looked for in its own project.
function flowProjectKey(url) { return String(url || '').match(/\/project\/([^/?#]+)/)?.[1] || ''; }

async function runPrompt(item, slot, token) {
  if (settings.platform === 'vids') return runMainVidsPrompt(item, slot, token);
  if(settings.platform === 'chatgpt') return runChatgptPrompt(item,slot,token);
  item.platform = settings.platform === 'gemini' ? 'gemini' : settings.platform === 'grok' ? 'grok' : settings.platform==='muse'?'muse':settings.platform==='higgsfield'?'higgsfield':'flow';
  // v1.10.2: a prompt that Flow refused and that could not be repaired then (helper missing, repair failed) is REPAIRED FIRST
  // when it is retried - the refused text is never resubmitted to Flow just to be refused again. A prompt edited by hand
  // since then is generated as the user wrote it.
  if (item.repairPendingError && typeof repairFailedPrompt === 'function') {
    const pendingError = item.repairPendingError;
    const editedByHand = item.repairPendingText != null && item.text !== item.repairPendingText;
    item.repairPendingError = null; item.repairPendingText = null;
    if (!editedByHand) {
      item.status = 'running'; item.detail = 'repairing the refused prompt before generating'; renderQueue();
      const handled = await repairFailedPrompt(item, pendingError, token);
      if (handled) { schedulePersist(); return; }              // repaired (scheduled as pending) or stopped with a reason
      if (token !== runToken || stopRequested) {               // Stop pressed: keep it for the next Retry, never resubmit
        item.status = 'pending'; item.repairPendingError = pendingError; item.repairPendingText = item.text;
        item.detail = 'waiting - will repair before generating'; globalThis.QueueReasons?.setQueueReason(item, 'repair_pending'); renderQueue(); schedulePersist(); return;
      }
      // repair is switched off (or not applicable): generate normally below
    }
  }
  if(item.manualProjectId)await window.FlowBuilderUI.rememberManualInput(item);
  // Gemini gets the same repair-first Retry as Flow (above), then its own engine.
  if(settings.platform === 'gemini') return runGeminiPrompt(item,slot,token);
  if(settings.platform === 'grok') return runGrokPrompt(item,slot,token);
  if(settings.platform === 'muse') return runMusePrompt(item,slot,token);
  if(settings.platform === 'higgsfield') return runHiggsPrompt(item,slot,token);
  item.downloadStarted = false;
  const modeDef = MODES[settings.mode] || MODES['text-to-video'];
  item.attempts = (item.attempts || 0) + 1;
  item.retryAt = null;
  item.status = 'running';
  item.detail = 'opening Flow tab';
  renderQueue();
  let tab = null;
  let flowSubmitted = false;
  const assertFlowActive = () => {
    assertRunActive(token);
    if (quotaStop && !flowSubmitted) throw new Error('Flow quota pause: no new submission');
  };
  let chainPause = '';
  // A missing last frame must pause the queue only after this video is saved;
  // otherwise Resume would generate (and pay for) the same prompt again.
  const pauseForChainFailure = () => {
    if (!chainPause) return;
    stopRequested = true;
    queueStopReason = chainPause;
    log(`${item.id}: ${chainPause}`);
    chainPause = '';
  };
  const trackingKey = `${token}:${item.id}:${item.attempts}`;
  // Chrome has saved this prompt's video: move/copy it where it belongs and finish the prompt. Used after a new video and
  // by the download-only Retry below.
  const finishPlacedVideo = async placed => {
    const wantsVideo = true;
    item.flowKept = null;
    placed = await flowEnsureDownloadFolder(tab, item, placed, token);
    if (outputDir) {
      try {
        const folderBytes = placed.replyBytes || await downloadMediaBuffer(tab.id, {src:placed.sourceUrl,host:'Flow download'},item.id);
        if (!P().bufferHasMp4Signature(folderBytes)) throw new Error('Invalid MP4 data');
        const saved = await saveOutput(item,folderBytes,'mp4',platformFileName(placed.placedName));
        const savedFile = await (await outputDir.getFileHandle(saved.name)).getFile();
        if (savedFile.size !== folderBytes.byteLength || !P().bufferHasMp4Signature(await savedFile.slice(0,512).arrayBuffer())) throw new Error('Project copy verification failed');
        if (canCleanupTemporaryDownload(placed.actualFilename, saved.name)) {
          await chrome.downloads.removeFile(placed.downloadId).catch(error=>log(`${item.id}: project copy verified, but temporary download cleanup failed: ${error.message}`));
        } else log(`${item.id}: retained Chrome download to protect the final output from cleanup.`);
        item.status='done';item.outputName=saved.name;try { window.flowStatusReport?.saved(tab?.url); } catch {}if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);item.detail=`saved ${saved.name} → ${saved.where}`;
        renderQueue();log(`${item.id}: done - ${saved.name} → ${saved.where}.`);await flowSaveExtraOutputs(tab, item, trackingKey, wantsVideo, token);pauseForChainFailure();return;
      } catch(error) { throw new Error(`Project output folder save failed (Chrome copy remains at ${placed.placedName}): ${error.message}`); }
    }
    if((item.builderProjectId&&item.builderSceneId||item.manualProjectId&&item.manualSceneId)&&window.FlowBuilderUI?.captureVideo){
      try{
        const workspaceBytes=placed.replyBytes||await downloadMediaBuffer(tab.id,{src:placed.sourceUrl,host:'Flow download'},item.id);
        if(!P().bufferHasMp4Signature(workspaceBytes))throw Error('Invalid MP4 data');
        await (item.manualProjectId?window.FlowBuilderUI.captureManualVideo(item,workspaceBytes,'mp4'):window.FlowBuilderUI.captureVideo(item,workspaceBytes,'mp4'));
      }catch(error){log(`${item.id}: video is downloaded; workspace copy unavailable (${error.message}). Import the downloaded MP4 in Story Workspace.`);}
    }
    item.status='done';item.outputName=placed.placedName;try { window.flowStatusReport?.saved(tab?.url); } catch {}
    if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);
    item.detail=`saved ${placed.placedName} (${placed.bytes >= 1048576 ? `${(placed.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(placed.bytes / 1024))} KB`}) → ${placed.where || 'Chrome Downloads'}`;
    renderQueue();log(`${item.id}: done - ${item.detail}`);await flowSaveExtraOutputs(tab, item, trackingKey, wantsVideo, token);pauseForChainFailure();return;
  
  };
  const parallel = typeof flowParallelCount === 'function' && flowParallelCount() > 1, page = {release: null};
  try {
    if (parallel) { item.detail = 'waiting for its turn to send to Flow'; renderQueue(); page.release = await flowLockForSend(item, token); }
    tab = await getFlowTab(slot);
    // Background mode: confirm each prompt that the shared tab really is this Flow tab (else the mode stops and waking resumes).
    const sharedTab = typeof confirmBackgroundTab === 'function' && await confirmBackgroundTab(tab.id);
    if (settings.openTabWhileGenerating && !sharedTab) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await waitForTabComplete(tab.id);
    assertFlowActive();
    await sleep(2500);
    await ensureFlowEnglish(tab.id, item, parallel ? () => flowDrainOthers(item, token, 'switching Flow to English', page) : null);
    assertFlowActive();

    item.detail = 'opening Flow project';
    renderQueue();
    await ensureFlowProjectReady(tab.id,item,token);
    // Desktop needs room for Flow's controls; mobile keeps its native composer/keyboard layout.
    const mobileFlow = typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));
    if (!mobileFlow) {
      await chrome.tabs.setZoomSettings(tab.id, {mode: 'automatic', scope: 'per-tab'});
      await chrome.tabs.setZoom(tab.id, 0.5);
      await sleep(800);
    }
    assertRunActive(token);

    // Download-only Retry (owner 2026-11-10): this prompt's video is already finished in Flow.
    if (item.flowKept && modeDef.resultKind === 'video') {
      const kept = item.flowKept, here = flowProjectKey((await chrome.tabs.get(tab.id).catch(() => tab))?.url);
      const why = kept.text !== item.text ? 'the prompt was changed' : !kept.project || kept.project !== here ? 'another Flow project is open' : Date.now() - kept.at > 12 * 3600 * 1000 ? 'it was made more than 12 hours ago' : '';
      if (why) { item.flowKept = null; log(`${item.id}: the finished video is not reused (${why}); generating a new one.`); }
      else {
        item.detail = 'saving the finished video from Flow (no new generation)'; renderQueue();
        log(`${item.id}: Retry saves the video that is already finished in Flow; no new generation, no credits.`);
        let placed;
        try {
          placed = await downloadVideoViaMenu(tab.id, item.id, [], stageText => { item.detail = `downloading: ${stageText}`; renderQueue(); },
            outputNameForItem(item, 'mp4'), null, kept.identity, Boolean((item.builderProjectId && item.builderSceneId) || (item.manualProjectId && item.manualSceneId)));
        } catch (e) {
          const message = String(e?.message || e);
          if (/cancelled by user/i.test(message)) throw e;
          // The download step itself failed again: the video is still there, keep it for the next Retry.
          if (/No resolution options|Download item not found|download button did not appear|Flow download wait expired|browser download did not complete|downloaded file is only|resolution unavailable/i.test(message))
            throw new Error(`Flow requested download failed: could not download the confirmed result: ${message}. Generated video retained in Flow; Retry tries the download again without making a new video.`);
          // The card is gone (deleted, or the page shows other results): only now is a new video needed.
          item.flowKept = null;
          throw new Error(`Flow requested download failed: the finished video was not found in this Flow project any more (${message}). Press Retry to generate it again (this uses credits).`);
        }
        await finishPlacedVideo(placed);
        return;
      }
    }

    item.detail = `setting up Flow (${modeDef.flowMode}, ${settings.aspectRatio})`;
    renderQueue();
    const setup = await flowSetupViaDebugger(tab.id, {
      aspectRatio: settings.aspectRatio,
      durationSeconds: item.generationDuration || Number.parseInt(item.videoMode, 10) || settings.flowDurationSeconds,
      outputCount: settings.flowOutputCount,
      mode: modeDef.flowMode,
      videoResolution: settings.videoGenerationResolution,
      model: modeDef.flowMode === 'image' ? settings.flowImageModel : settings.flowModel,
    });
    if (!setup || !setup.ok) throw new Error(`Flow setup failed: ${setup ? setup.error : 'no response'}`);
    await sleep(800);
    assertFlowActive();
    item.detail = 'confirming Flow composer';
    renderQueue();
    let composer = null;
    const composerStart = Date.now();
    while (Date.now() - composerStart < 30000) {
      composer = await exec(tab.id, pg_flowComposerReady, []);
      if (composer && composer.ok) break;
      await sleep(1000);
      assertFlowActive();
    }
    if (!composer || !composer.ok) {
      throw new Error(`Flow composer not ready after setup: ${composer ? `${composer.overlayCount || 0} setup overlay(s) still open` : 'no response'}`);
    }

    // --- images ---
    let fileB64s = [];
    const chosenImages = imagesForItem(item);
    if (modeDef.flowMode === 'frames' && !chosenImages.length) throw new Error('Flow frame attachment failed: no start image assigned to this prompt');
    if (chosenImages.length) {
      item.detail = `attaching Flow images (${chosenImages.length})`;
      renderQueue();
      fileB64s = chosenImages.map((img) => {
        const { b64, type } = dataUrlToB64(img.dataUrl);
        return { name: img.name, base64: b64, type };
      });
      const preload = (modeDef.flowMode === 'ingredients' || settings.mode === 'image-to-image') && preloadedProjectImages.get(tab.id) !== token;
      const preloadImages = preload ? requiredProjectImages(queue) : chosenImages;
      const uploadFiles = preload ? preloadImages.map(img => { const {b64,type}=dataUrlToB64(img.dataUrl);return {name:img.name,base64:b64,type}; }) : fileB64s;
      if (preload) log(`${item.id}: preloading ${uploadFiles.length} required project images before generation.`);
      const existingProject = preload ? await exec(tab.id,pg_flowExistingImages,[uploadFiles.map(file=>file.name)]) : {names:[]};
      const missingFiles = uploadFiles.filter(file=>!existingProject.names.includes(file.name.toLowerCase()));
      const batches = [];
      for (let offset=0;offset<missingFiles.length;offset+=preload?10:1) batches.push(missingFiles.slice(offset,offset+(preload?10:1)));
      for (const batch of batches) {
      const file = {name:batch.map(entry=>entry.name).join(', ')};
      assertRunActive(token);
      const existing = modeDef.needsImages
        ? await exec(tab.id, pg_flowExistingImages, [batch.map(entry=>entry.name)]) : {names: []};
      if (batch.every(entry=>existing.names.includes(entry.name.toLowerCase()))) {
        log(`${item.id}: reusing existing Flow image ${file.name}; upload skipped.`);
        continue;
      }
      // Flow sometimes rejects part of a batch ("Failed to load image."). Notice
      // those tiles instead of waiting out the full timeout, and re-upload only
      // the images that did not become ready, once, before failing the prompt.
      let attach = null;
      let pendingUpload = batch;
      for (let uploadTry = 1; uploadTry <= 2; uploadTry++) {
        item.detail = `${uploadTry > 1 ? 're-uploading' : 'uploading'} ${pendingUpload.length} image(s): ${pendingUpload.map(entry => entry.name).join(', ')}`;
        renderQueue();
        const failedBefore = await exec(tab.id, pg_flowFailedUploadCount, []);
        await flowAttachPhotos(tab.id, pendingUpload, settings.uploadSettleSeconds * 1000);
        attach = null;
        const attachStart = Date.now();
        let flowFailed = 0, lastReady = -1, progressAt = Date.now();
        while (Date.now() - attachStart < 300000) {
          const projectImages = await exec(tab.id, pg_flowExistingImages, [pendingUpload.map(entry => entry.name)]);
          attach = await exec(tab.id, pg_flowAttachPoll, [projectImages]);
          if (attach && (attach.state === 'done' || attach.state === 'error')) break;
          const readyNow = (projectImages.names || []).length;
          if (readyNow !== lastReady) { lastReady = readyNow; progressAt = Date.now(); }
          flowFailed = Math.max(0, (await exec(tab.id, pg_flowFailedUploadCount, [])) - failedBefore);
          // Flow marked uploads as failed and nothing else has landed for 10s.
          if (flowFailed && Date.now() - progressAt >= 10000) break;
          const attachCount = `${attach?.count || 0}/${pendingUpload.length} images`;
          const progress = Number.isFinite(attach?.progress) ? `, ${attach.progress}%` : '';
          const stable = attach?.stableMs ? `, stable ${Math.floor(attach.stableMs / 1000)}/${settings.uploadSettleSeconds}s` : '';
          const failed = flowFailed ? `, ${flowFailed} failed in Flow` : '';
          const elapsed = `, ${Math.floor((attach?.elapsedMs || 0) / 1000)}s elapsed`;
          item.detail = `waiting for Flow uploads (${attachCount}${progress}${stable}${failed}${elapsed})`;
          renderQueue();
          await sleep(1000);
          assertRunActive(token);
        }
        if (flowUploadTempIds.size) await flowUploadTempDone(tab.id).catch(() => {});
        if (attach?.state === 'done') break;
        let ready = await exec(tab.id, pg_flowExistingImages, [pendingUpload.map(entry => entry.name)]);
        let missing = pendingUpload.filter(entry => !(ready.names || []).includes(entry.name.toLowerCase()));
        // "Failed to load image." is usually only Flow's thumbnail failing to
        // display: after a page refresh the uploaded image is there. Refresh
        // first; re-uploading would create duplicate assets in the project.
        // The same when readiness simply timed out (owner run 2026-11-05: p005/p006 waited 150 s, re-uploaded, and the
        // project ended with three copies of p01_scene_006): the upload had landed but its tile was not shown as loaded.
        if (missing.length) {
          item.detail = flowFailed ? `Flow could not show ${flowFailed} uploaded image(s) — refreshing Flow to load them` : 'upload not confirmed — refreshing Flow to look for it before any re-upload';
          renderQueue();
          log(flowFailed ? `${item.id}: Flow showed ${flowFailed} upload(s) as "Failed to load image"; refreshing Flow to check them before any re-upload.` : `${item.id}: ${attach ? attach.error || attach.state : 'no response'}; refreshing Flow to look for ${missing.map(entry => entry.name).join(', ')} before any re-upload.`);
          if (typeof parallel !== 'undefined' && parallel) await flowDrainOthers(item, token, 'refreshing Flow', page);
          await chrome.tabs.reload(tab.id);
          await waitForTabComplete(tab.id, 60000);
          const refreshedAt = Date.now();
          do {
            await sleep(2000);
            assertRunActive(token);
            ready = await exec(tab.id, pg_flowExistingImages, [pendingUpload.map(entry => entry.name)]);
            missing = pendingUpload.filter(entry => !(ready.names || []).includes(entry.name.toLowerCase()));
          } while (missing.length && Date.now() - refreshedAt < 45000);
          if (!missing.length) {
            log(`${item.id}: after the refresh all ${pendingUpload.length} uploaded image(s) are in the project; nothing re-uploaded.`);
            attach = {state: 'done', method: attach?.method || 'drop-paste', detectedVia: 'project images after a Flow refresh'};
            break;
          }
        }
        const reason = flowFailed ? `Flow could not process ${missing.length} upload(s) even after a refresh` : (attach ? attach.error || attach.state : 'no response');
        if (!missing.length) { attach = {...attach, state: 'done'}; break; }
        if (uploadTry === 2) throw new Error(`Flow attachment failed: ${reason}: ${missing.map(entry => entry.name).join(', ')}`);
        log(`${item.id}: ${reason} (${missing.map(entry => entry.name).join(', ')}); re-uploading only those images.`);
        pendingUpload = missing;
      }
      if (!attach || attach.state !== 'done') {
        throw new Error(`Flow attachment failed: ${attach ? attach.error || attach.state : 'no response'}`);
      }
      if (attach.detectedVia) log(`${item.id}: upload complete — ${batch.length}/${batch.length} required images confirmed via ${attach.detectedVia}.`);
      if (modeDef.needsImages) {
        let ready = false;
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < 120000) {
          assertRunActive(token);
          const uploaded = await exec(tab.id, pg_flowExistingImages, [batch.map(entry=>entry.name)]);
          if (batch.every(entry=>uploaded.names.includes(entry.name.toLowerCase()))) { ready = true; break; }
          item.detail = `waiting for uploaded image to finish: ${file.name}`;
          renderQueue(); await sleep(1000);
        }
        if (!ready) throw new Error(`Flow attachment failed: ${file.name} did not become a ready project image`);
      }
      log(`${item.id}: Flow accepted ${file.name} via ${attach.method || 'unknown method'}.`);
      if (preload) {
        // Drop-paste uploads also add every file to the draft as a reference.
        await flowExecWithRealClick(tab.id,pg_flowReturnToProjectComposer,[],{clicks:3,waitMs:8000});
        await flowClearComposerIngredients(tab.id, token);
      }
      }
      if (preload) preloadedProjectImages.set(tab.id,token);

      item.detail = 'returning to Flow project composer';
      renderQueue();
      const returnedToComposer = await flowExecWithRealClick(tab.id, pg_flowReturnToProjectComposer, [], {clicks: 3, waitMs: 8000});
      if (!returnedToComposer || !returnedToComposer.ok) {
        throw new Error(`Flow did not return to project composer after upload: ${returnedToComposer ? returnedToComposer.error || returnedToComposer.url : 'no response'}`);
      }
      await sleep(800);
      // Start from an empty reference list so the prompt gets exactly the images
      // it names (uploads for other prompts must not ride along).
      if (modeDef.flowMode !== 'frames') await flowClearComposerIngredients(tab.id, token);

      if (modeDef.flowMode === 'frames') {
        item.detail='selecting and confirming Flow start frame';renderQueue();
        item.flowStartFrameIdentity=await ensureFlowStartFrame(tab.id,fileB64s[0].name,token);
        log(`${item.id}: start frame confirmed: ${fileB64s[0].name}`);
      }
      // Frames mode: explicit Start selection verifies attachment; forcing the
      // asset into the prompt text would turn it into an ingredient instead.
      if (modeDef.flowMode !== 'frames' && !((modeDef.flowMode === 'ingredients' || settings.mode === 'image-to-image') && /@[\p{L}\p{N}_-]+/u.test(item.generationText || item.text))) {
        item.detail = 'adding uploaded Flow media to prompt';
        renderQueue();
        const current = await exec(tab.id, pg_flowExistingImages, [fileB64s.map(file => file.name)]);
        const toAttach = fileB64s.map(file => file.name).filter(name => !(current.attachedNames || []).includes(name.toLowerCase()));
        if (toAttach.length) await flowAttachFromAssetMenu(tab.id, toAttach, token, settings.flowPace);
      }

      item.detail = 'restoring Flow settings after media attach';
      renderQueue();
      const postAttachSetup = await flowSetupViaDebugger(tab.id, {
        aspectRatio: settings.aspectRatio,
        durationSeconds: item.generationDuration || Number.parseInt(item.videoMode, 10) || settings.flowDurationSeconds,
        outputCount: settings.flowOutputCount,
        mode: modeDef.flowMode,
        videoResolution: settings.videoGenerationResolution,
        model: modeDef.flowMode === 'image' ? settings.flowImageModel : settings.flowModel,
      });
      if (!postAttachSetup || !postAttachSetup.ok) {
        throw new Error(`Flow setup failed after media attach: ${postAttachSetup ? postAttachSetup.error : 'no response'}`);
      }
      if (postAttachSetup.kept) log(`${item.id}: Flow settings after attach: ${postAttachSetup.kept.length} already set${postAttachSetup.kept.length ? ' (' + postAttachSetup.kept.join(', ') + ')' : ''}, clicked ${postAttachSetup.clicked?.length ? postAttachSetup.clicked.join(', ') : 'none'}.`);
      await sleep(500);
    }

    const composerBeforeSubmit = await flowExecWithRealClick(tab.id, pg_flowReturnToProjectComposer, [], {clicks: 3, waitMs: 8000});
    if (!composerBeforeSubmit?.ok) throw new Error('Flow project composer not found before prompt submission');
    assertFlowActive();
    // --- prompt ---
    item.detail = 'submitting Flow prompt';
    renderQueue();
    const nativeReferences = (modeDef.flowMode === 'ingredients' || settings.mode === 'image-to-image') && /@[\p{L}\p{N}_-]+/u.test(item.generationText || item.text);
    const flowPrompt = nativeReferences ? (item.generationText || item.text) : buildPromptForItem(item, fileB64s);
    await flowPacePause(settings.flowPace, 'prompt');
    assertFlowActive();
    const ins = nativeReferences
      ? await flowInsertNativeReferences(tab.id, flowPrompt, fileB64s.map(file=>file.name))
      : await flowInsertPrompt(tab.id, flowPrompt);
    if (!ins || !ins.ok) throw new Error(`Could not enter Flow prompt: ${ins ? ins.error : 'no response'}`);

    // Verify again after inserting the prompt: neither setup nor text entry may clear the frame.
    if(modeDef.flowMode==='frames') {
      const frame=await exec(tab.id,pg_flowFrameState,[fileB64s[0].name,item.flowStartFrameIdentity||null]);
      if(!frame?.ready)throw new Error('Flow frame attachment failed: start frame changed before generation. Prompt was not submitted.');
    }
    // --- generate ---
    const wantsVideo = modeDef.resultKind === 'video';
    const baselineStatus = await exec(tab.id, pg_flowCheckStatus, [FLOW_SELECTORS]).catch(() => null);
    const baselineVideoCount = Number(baselineStatus?.videoCount || 0);
    const baselineVideos = await exec(tab.id, pg_flowVideoSnapshot, [FLOW_SELECTORS]);
    const baselineVideoSources = Array.isArray(baselineVideos?.sources) ? baselineVideos.sources : [];
    // Videos and images alike: watch for the tile THIS prompt creates, and later save only from that tile.
    {
      let tracking = await exec(tab.id, pg_flowStartResultTracking, [trackingKey, settings.flowOutputCount, wantsVideo ? 'video' : 'image', parallel, flowPrompt.slice(0, 200)]);
      // A tile from an earlier prompt is still rendering (e.g. an extra image): wait for it (up to 5 min) instead of failing
      // this and every following prompt within seconds (owner log 2026-10-16). Nothing is submitted while waiting.
      const waitStart = Date.now();
      while (!tracking?.ok && /already has a rendering/i.test(tracking?.error || '') && Date.now() - waitStart < 5 * 60 * 1000) {
        item.detail = `waiting for Flow to finish the ${wantsVideo ? 'video' : 'image'} that is still rendering`;
        renderQueue();
        await sleep(5000);
        assertRunActive(token);
        tracking = await exec(tab.id, pg_flowStartResultTracking, [trackingKey, settings.flowOutputCount, wantsVideo ? 'video' : 'image', parallel, flowPrompt.slice(0, 200)]);
      }
      if (Date.now() - waitStart > 6000 && tracking?.ok) log(`${item.id}: waited ${Math.round((Date.now() - waitStart) / 1000)}s for an earlier Flow result to finish rendering.`);
      if (!tracking?.ok) throw new Error(`Flow requested download failed: ${tracking?.error || 'Submission tracking unavailable'}. No new generation was submitted.`);
    }
    let trackedImage = null;

    let sent = null, blockedSince = 0;
    let submitClicks = 0;
    const submitStart = Date.now();
    // The send button ignores synthetic DOM clicks (same widget toolkit as the
    // settings radios), so submit through a trusted CDP click and verify the
    // submission by watching the composer clear. Generate is pressed ONCE per prompt (owner 2026-11-04: members were
    // getting Flow's "unusual activity" warning; a second click on a slow page could send a duplicate request).
    // If Flow never confirms within 45 s the prompt stops for review instead of being clicked again.
    while (Date.now() - submitStart < 180000) {
      assertFlowActive();
      const pt = await exec(tab.id, pg_flowGeneratePoint, []);
      if (pt && pt.crashed) { sent = pt; break; }
      if (pt && pt.ok && !pt.disabled) {
        blockedSince = 0;
        if(submitClicks >= 1) throw new Error('Flow submission unconfirmed after one click. Check Flow for a generated result before Retry; 0xFlow never presses Generate twice for the same prompt.');   // safety net
        await flowPacePause(settings.flowPace, 'generate');
        assertFlowActive();
        submitClicks++;
        // Owner 2026-11-08: send with the Enter key, the way a person sends a typed prompt, when the cursor is still in
        // Flow's prompt box and no list or menu is open (Enter would pick from it). Otherwise one click on Create.
        let enterReady = !flowMobileUa() && await exec(tab.id, pg_flowEnterSubmitReady, []).catch(() => false);
        if (enterReady) await flowCdpEnter(tab.id);
        else await flowCdpClick(tab.id, pt.x, pt.y);
        let confirmed = false, enterFallback = !enterReady;
        const verifyStart = Date.now();
        while (Date.now() - verifyStart < 45000) {
          await sleep(1500);
          const after = await exec(tab.id, pg_flowComposerCleared, []).catch(() => null);
          if (after && after.cleared) { confirmed = true; break; }
          const result = await exec(tab.id, pg_flowTrackedResult, [trackingKey]).catch(() => null);
          if (result && !result.error && (result.ready || Number.isFinite(result.progressPercent))) { confirmed = true; break; }
          // Flow ignored the Enter key (prompt still in the box, Create still enabled, no new tile): nothing was sent,
          // so one click on Create sends it. Never more than this one click.
          if (!enterFallback && Date.now() - verifyStart >= 6000) {
            enterFallback = true;
            const again = await exec(tab.id, pg_flowGeneratePoint, []).catch(() => null);
            if (again?.ok && !again.disabled && !(result && (result.ready || Number.isFinite(result.progressPercent)))) {
              log(`${item.id}: Flow did not take the Enter key; sending with one click on Create.`);
              await flowCdpClick(tab.id, again.x, again.y);
              enterReady = false;
            }
          }
        }
        if (confirmed) { sent = { ok: true, method: enterReady ? 'cdp-enter-key' : 'cdp-start-generation', buttonText: enterReady ? 'Enter' : pt.text }; break; }
        log(`${item.id}: Flow did not confirm the submit within 45 s; not clicking again.`);
        throw new Error('Flow submission unconfirmed after one click. Check Flow for a generated result before Retry; 0xFlow never presses Generate twice for the same prompt.');
      } else {
        // Out of credits: Flow keeps the button disabled (or hides it) and never says so in a result tile.
        // Stop on an explicit message, or after 30 s blocked while Flow shows its low-credit warning.
        const credit = await exec(tab.id, pg_flowCreditState, []).catch(() => null);
        try { if (credit?.lowCredits) window.flowStatusReport?.credit(tab.url, 'low'); } catch {}
        if (credit && P().isFlowQuotaText(credit.text)) throw new Error(`Flow quota message detected: ${quotaSnippet(credit.text)}`);
        blockedSince ||= Date.now();
        if (credit?.lowCredits && Date.now() - blockedSince >= 30000) {
          throw new Error('Flow quota message detected: submit stayed blocked for 30 s while Flow shows its low-credit warning (credits used up)');
        }
        item.detail = `waiting for Flow submit button (${pt && pt.disabled ? 'disabled' : 'not found'})`;
        renderQueue();
        await sleep(2000);
      }
    }
    if (!sent || !sent.ok) throw new Error(`Could not start Flow generation: ${sent ? sent.error || 'submit click never confirmed' : 'no response'}`);
    flowSubmitted = true;
    log(`${item.id}: generation submitted${sent.buttonText ? ` ("${sent.buttonText}")` : ''} via ${sent.method || 'cdp'}.`);
    if (parallel) {
      flowInFlight.add(item.id);
      // Keep the page until Flow shows all of this prompt's result tiles, so the next prompt can never take one.
      let claim = null;
      const claimStart = Date.now();
      while (Date.now() - claimStart < 45000) {
        claim = await exec(tab.id, pg_flowClaimWindow, [trackingKey, false]).catch(() => null);
        if (!claim?.ok || claim.error || claim.count >= claim.expected) break;
        await sleep(1000);
      }
      if (claim?.ok && !claim.error && claim.count >= claim.expected) {
        await exec(tab.id, pg_flowClaimWindow, [trackingKey, true]).catch(() => {});
        if (flowDraining === item.id) flowDraining = null;
        page.release?.(); page.release = null;
        { const own = activeRuns.get(item.id); if (own) own.rendering = true; }   // Flow accepted it: it now holds credits
        log(`${item.id}: ${claim.count} result tile(s) claimed; the next prompt may be sent while this one renders.`);
      } else {
        log(`${item.id}: ${claim?.error ? `result tiles unclear (${claim.error})` : `Flow did not show all ${claim?.expected || settings.flowOutputCount} result tile(s) within 45 s`}; the next prompt waits until this one is finished (parallel paused for safety).`);
      }
    }
    if (item._cloudRepairMemory) item._cloudRepairMemory.generationId = crypto.randomUUID();

    // --- wait for result ---
    item.detail = 'generating in Flow...';
    renderQueue();
    const startedAt = Date.now();
    let lastWakeAt = 0;
    let ready = false;
    let readyStableSince = null;
    let resultSource = null;
    let resultIdentity = null;
    while (Date.now() - startedAt < settings.maxWaitMinutes * 60 * 1000) {
      await sleep(POLL_MS);
      assertRunActive(token);
      const status = await exec(tab.id, pg_flowCheckStatus, [FLOW_SELECTORS, baselineVideoSources, baselineVideos.failureBaselineText, baselineVideos.failureBaselineScopes, flowPrompt, parallel ? trackingKey : '']);
      item.progressPercent = status.progressPercent;
      // Credits are reserved when Flow accepts a prompt, so a credit message on the page cannot cancel a prompt Flow is already
      // rendering. It belongs to a refused submission of another prompt, which stops the queue itself (owner log 2026-11-04: p001 and
      // p002 were rendering, were abandoned by this check and would have been generated again on the next account).
      if (P().isFlowQuotaText(status.text) && !activeRuns.get(item.id)?.rendering) {
        throw new Error(`Flow quota message detected: ${quotaSnippet(status.text)}`);
      }
      if (status.failureText) {
        // full tile text goes to the activity log only; the card, retries and repair get the short warning
        log(`${item.id}: Flow failure text (full): ${String(status.failureText).replace(/\s+/g, ' ').slice(0, 1500)}`);
        if (/unusual activity|browser extensions that modify the page/i.test(status.failureText)) throw new Error(`Flow unusual activity detected: ${summarizeFlowFailure(status.failureText)}`);
        if (status.failureKind === 'policy') {
          flashQueueRejection();
          if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item, {passed: false, warning: summarizeFlowFailure(status.failureText)});
          throw new Error(`Flow policy rejection: ${summarizeFlowFailure(status.failureText)}`);
        }
        throw new Error(`Flow generation failed: ${summarizeFlowFailure(status.failureText)}`);
      }
      if (wantsVideo) {
        const tracked = await exec(tab.id, pg_flowTrackedResult, [trackingKey]);
        if (tracked?.error) throw new Error(`Flow requested download failed: ${tracked.error}. Generated video retained in Flow; no guessed tile will be downloaded.`);
        if (tracked?.progressPercent != null) item.progressPercent = tracked.progressPercent;
        const completedCount = Number(status.videoCount || 0);
        const newCard = tracked?.ready
          ? await exec(tab.id, pg_flowVideoCardPoint, [[], tracked.identity]) : null;
        const hasNewCompletedVideo = !!newCard?.ok;
        if (hasNewCompletedVideo) {
          // Keep the submission tracker's stable thumbnail ID even if a
          // mounted preview exposes a different container or media URL.
          const nextIdentity = {...newCard.identity, posterSources:tracked.identity.posterSources.length
            ? tracked.identity.posterSources : newCard.identity.posterSources};
          if (resultIdentity && JSON.stringify(resultIdentity) !== JSON.stringify(nextIdentity)) readyStableSince = null;
          resultIdentity = nextIdentity;
          if (readyStableSince == null) readyStableSince = Date.now();
          if (Date.now() - readyStableSince >= Math.max(3000, settings.uploadSettleSeconds * 1000)) {
            log(`${item.id}: tracked generated result confirmed: ${tracked.title || 'untitled'}; thumbnail ${tracked.identity.posterSources.join(', ') || tracked.identity.videoSource}.`);
            ready = true;
            break;
          }
        } else {
          readyStableSince = null;
        }
        const generatingCount = Number(status.generatingCount || 0);
        const rawCount = Number(status.rawVideoCount || completedCount);
        const stable = readyStableSince ? `, stable ${Math.floor((Date.now() - readyStableSince) / 1000)}s` : '';
        item.detail = `generating in Flow... (${completedCount}/${baselineVideoCount + 1} complete, ${generatingCount}/${rawCount} rendering${Number.isFinite(status.progressPercent) && status.progressPercent > 0 ? `, ${status.progressPercent}%` : ''}${stable})`;
      } else {
        // Same as videos: only the tile this prompt created counts, never "any new picture on the page".
        const tracked = await exec(tab.id, pg_flowTrackedResult, [trackingKey]);
        if (tracked?.error) throw new Error(`Flow requested download failed: ${tracked.error}. Generated image retained in Flow; no guessed tile will be downloaded.`);
        if (tracked?.progressPercent != null) item.progressPercent = tracked.progressPercent;
        if (tracked?.ready) {
          if (trackedImage?.src !== tracked.src) readyStableSince = null;
          trackedImage = tracked;
          if (readyStableSince == null) readyStableSince = Date.now();
          if (Date.now() - readyStableSince >= Math.max(3000, settings.uploadSettleSeconds * 1000)) {
            log(`${item.id}: tracked generated image confirmed: ${tracked.title || 'untitled'} (${tracked.width}x${tracked.height}).`);
            ready = true;
            break;
          }
        } else {
          readyStableSince = null;
        }
        const pct = tracked?.progressPercent ?? status.progressPercent;
        item.detail = `generating image in Flow... (${tracked?.waiting ? 'waiting for the new tile' : tracked?.ready ? 'finished' : 'rendering'}${Number.isFinite(pct) && pct > 0 ? `, ${pct}%` : ''}${readyStableSince ? `, stable ${Math.floor((Date.now() - readyStableSince) / 1000)}s` : ''})`;
      }
      renderQueue();
      const now = Date.now();
      if (settings.autoWake && !(typeof backgroundModeActiveFor === 'function' && backgroundModeActiveFor(tab.id)) && now - startedAt >= BACKGROUND_WAKE_AFTER_MS && now - lastWakeAt >= BACKGROUND_WAKE_INTERVAL_MS) {
        item.detail = 'briefly waking Flow tab to load media';
        renderQueue();
        await wakeFlowTab(tab.id);
        lastWakeAt = Date.now();
        item.detail = wantsVideo ? 'generating in Flow...' : 'generating image in Flow...';
        renderQueue();
      }
    }
    if (!ready) throw new Error('Timed out waiting for Flow result');
    if (wantsVideo && !resultIdentity) throw new Error('Flow requested download failed: completed result identity could not be confirmed. Video retained in Flow; no tile was downloaded.');
    // Record the confirmed generation before download: a timeout cannot erase a working fix.
    if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item, {passed: true});

    // Parallel: the download menu and the page nudge use the page, so saving waits for its turn too.
    if (parallel && !page.release) {
      item.detail = 'finished — waiting for its turn to save from Flow'; renderQueue();
      page.release = await flowPageLock();
      // (No drain here: two prompts waiting for each other to leave would deadlock. The download step refreshes the
      // page only when this prompt is the last one in Flow.)
    }
    // --- download & save ---
    const noDownload = autoDownloadOff(wantsVideo ? 'video' : 'image', item);
    item.detail = noDownload ? 'finishing (auto download is off)' : 'downloading Flow media bytes';
    renderQueue();
    // Video lookup already scrolls only the confirmed result into view. The
    // generic nudge visits old players and can unmount that tile from Flow's grid.
    if (!wantsVideo && !noDownload) await exec(tab.id, pg_nudgeMediaIntoView, []).catch(() => null);
    let buf = null;
    let placed = null;
    if (wantsVideo && !noDownload) {
      // Primary: Flow's own Download menu on the finished card — the only
      // source of a real, resolution-selected MP4 (the raw <video> src is no
      // longer a clean MP4 stream). baselineVideoSources pins the targeting
      // to THIS prompt's new video even in projects with older completed ones.
      // Chrome's own downloader places the file (renamed on the fly).
      try {
        placed = await downloadVideoViaMenu(tab.id, item.id, [], (stageText) => {
          item.detail = `downloading: ${stageText}`;
          renderQueue();
        }, outputNameForItem(item, 'mp4'), () => {
          if (token !== runToken || stopRequested) return;
          const run = activeRuns.get(item.id);
          if (run && !(settings.chainLastFrame && settings.mode === 'frame-to-video') && !flowWantsExtraOutputs(item)) run.generationDone = true;
          item.downloadStarted = true;
          item.detail = 'upscaling/downloading in background';
          renderQueue();
        }, resultIdentity, Boolean((item.builderProjectId&&item.builderSceneId)||(item.manualProjectId&&item.manualSceneId)));
      } catch (e) {
        // Owner 2026-11-10: the video is finished in Flow and only its download failed. Remember which one it is, so Retry
        // (or Resume after Stop) saves that video instead of generating, and paying for, a new one.
        if (resultIdentity) {
          item.flowKept = {identity: resultIdentity, project: flowProjectKey(tab?.url), text: item.text, at: Date.now()};
          throw new Error(`Flow requested download failed: could not download the confirmed result: ${String(e?.message || e)}. Generated video retained in Flow; no other tile will be used. Retry saves it from Flow without making a new video.`);
        }
        if (settings.videoResolution && settings.videoResolution !== 'default') throw new Error(`Flow requested download failed (${settings.videoResolution}): ${String(e?.message || e)}. Generated video retained in Flow; no lower-resolution fallback.`);
        if (item.downloadStarted) throw new Error(`Flow background download failed; generated video retained: ${String(e?.message || e)}`);
        if (/^Flow download wait expired/i.test(String(e?.message || e))) throw e;
        log(`${item.id}: download-menu path failed (${String(e && e.message ? e.message : e)}); falling back to the video source fetch.`);
      }
    }
    // User log 2026-11-04: a story's scenes each bring their own start frame (imagesForItem never chains them), so a missing
    // last frame must not pause the queue after every video. Capture it only when a remaining prompt would use it.
    const chainUsed = queue.some(e => e !== item && !['done','skipped'].includes(e.status) && !(e.builderProjectId || e.manualRestoreFrame));
    if (settings.chainLastFrame && settings.mode === 'frame-to-video' && !chainUsed) chainedFrame = null;
    if (settings.chainLastFrame && settings.mode === 'frame-to-video' && chainUsed) {
      const frame = await exec(tab.id, pg_extractLastFrame, [baselineVideoSources, resultIdentity]).catch(() => null);
      if (!frame?.ok || !frame.b64) {
        chainedFrame = null;
        chainPause = `Last-frame chaining unavailable: ${frame?.error || 'could not capture this video'}. Queue paused after saving this video to prevent using the wrong frame`;
      } else {
        chainedFrame = {b64:frame.b64};
        log(`${item.id}: captured this video's last frame before the next prompt.`);
      }
    }
    // Auto download off: the confirmed result stays in Flow (the last frame above is still captured for chaining).
    if (noDownload) { finishWithoutDownload(item, 'Flow', wantsVideo ? 'video' : 'image'); renderQueue(); pauseForChainFailure(); return; }
    if (placed) { await finishPlacedVideo(placed); return; }
    let mediaSourceUrl = '';   // for "Auto change file name" off: the platform's own name
    if (!buf) {
      let resultSource;
      if (wantsVideo) {
        resultSource = await exec(tab.id, pg_getVideoSource, [FLOW_SELECTORS, {
          excludeSources: baselineVideoSources,
          completedOnly: true,
        }]);
        if (!resultSource || !resultSource.ok) {
          throw new Error(`Flow video source lookup failed: ${resultSource ? resultSource.error : 'no response'}`);
        }
      } else {
        // The picture inside the tracked tile, read again now (Flow may have swapped in a sharper URL since).
        const tracked = await exec(tab.id, pg_flowTrackedResult, [trackingKey]).catch(() => null);
        const src = (tracked?.ready && tracked.src) || trackedImage?.src;
        if (!src) throw new Error('Flow requested download failed: the tracked image tile has no picture any more. Generated image retained in Flow; no guessed tile will be downloaded.');
        let host = 'page'; try { host = new URL(src).hostname; } catch { /* keep label */ }
        resultSource = { ok: true, src, host };
      }
      mediaSourceUrl = resultSource.src || '';
      // Storyboard sheet: the 2K upscale, so each cut frame is full size; the 1K picture only when 2K is unavailable.
      if (!wantsVideo && (item.builderSheetIds || item.manualSheetIds)) {
        item.detail = 'downloading the storyboard sheet in 2K'; renderQueue();
        try { buf = await flowDownloadTile2K(tab.id, trackingKey, item); if (buf) log(`${item.id}: storyboard sheet downloaded in 2K (${Math.round(buf.byteLength / 1024)} KB).`); }
        catch (error) { if (stopRequested) throw error; log(`${item.id}: 2K sheet download failed (${error.message}); using the 1K picture, so the scene frames will be smaller.`); }
        if (!buf) log(`${item.id}: Flow offered no 2K download; using the 1K picture, so the scene frames will be smaller.`);
      }
      if (!buf) buf = await downloadMediaBuffer(tab.id, resultSource, item.id);
    }
    const ext = wantsVideo ? 'mp4' : guessImageExt(buf, '');
    if (wantsVideo) {
      if (buf.byteLength < 100 * 1024) throw new Error(`Refusing to save: video is only ${buf.byteLength} bytes`);
      if (!P().bufferHasMp4Signature(buf)) throw new Error('Refusing to save: downloaded bytes do not contain a valid MP4 ftyp signature');
    } else {
      if (buf.byteLength < 10 * 1024) throw new Error(`Refusing to save: image is only ${buf.byteLength} bytes`);
      if (!P().bufferHasImageSignature(buf)) throw new Error('Refusing to save: downloaded bytes do not look like a supported image');
      // Last safety net: the very same picture as another prompt's output means Flow made no new image for this prompt
      // (e.g. it failed) and an older picture was picked up. Never save it under this prompt's name.
      const fingerprint = await flowImageFingerprint(buf);
      const owner = flowSavedImages.get(fingerprint);
      if (owner && owner !== item.id) throw new Error(`Refusing to save: this is the same picture already saved for ${owner}. Flow showed no new image for this prompt; check Flow for a failed tile`);
      flowSavedImages.set(fingerprint, item.id);
    }

    item.detail = 'saving output';
    renderQueue();
    const saved = await saveOutput(item, buf, ext, platformFileName(mediaSourceUrl));
    item.status = 'done';
    try { window.flowStatusReport?.saved(tab?.url); } catch {}
    item.outputName = saved.name;
    if (typeof reportRepairOutcome === 'function') reportRepairOutcome(item);
    item.detail = `saved ${saved.name} (${buf.byteLength >= 1048576 ? `${(buf.byteLength / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(buf.byteLength / 1024))} KB`}) \u2192 ${saved.where}`;
    renderQueue();
    log(`${item.id}: done - ${saved.name} (${buf.byteLength >= 1048576 ? `${(buf.byteLength / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(buf.byteLength / 1024))} KB`}) \u2192 ${saved.where}.`);
    await flowSaveExtraOutputs(tab, item, trackingKey, wantsVideo, token);
    pauseForChainFailure();
  } catch (e) {
    const errorText = String(e && e.message ? e.message : e);
    const flowCrashed = /client-side exception|flow page crashed/i.test(errorText);
    let quotaHit = /^Flow quota message detected/.test(errorText);
    // A prompt that cannot even start (no submit, no Start frame button, no composer) while Flow shows a credit
    // message means the credits ran out: stop instead of failing every remaining prompt the same way.
    if (!quotaHit && tab?.id && !stopRequested && token === runToken
      && /^Could not start Flow generation|Start frame selector|composer not found|generate button not found/i.test(errorText)) {
      const credit = await exec(tab.id, pg_flowCreditState, []).catch(() => null);
      // An explicit out-of-credit message stops at once. The "running low" banner alone needs the same failure a second
      // time (one slow Flow moment once stopped a queue that still had credits — owner log 2026-10-16).
      // The page text still holds an earlier tile's "not enough credits" while that prompt waits for its solo retry
      // (owner log 2026-10-29: p005 stopped the queue on the running-low banner); then only the banner rule applies.
      const soloPending = queue.some(x => x.quotaSoloRetry && x.status === 'pending');
      // A missing Start frame box is a page problem, not a credit one: with only the "running low" banner it never counts as
      // out of credits (owner log 2026-10-30: 39 credits left, yet the run stopped and switched accounts).
      const frameBox = /Start frame selector/i.test(errorText);
      if (credit && ((!soloPending && P().isFlowQuotaText(credit.text)) || (credit.lowCredits && !frameBox && (item.technicalFailures || 0) >= 1))) {
        quotaHit = true;
        log(`${item.id}: ${errorText} — Flow shows a credit warning (${quotaSnippet(credit.text)}).`);
      }
    }
    const retryable = !/^(Project output folder save failed|Flow download wait expired|Flow background download failed|Flow requested download failed)/i.test(errorText) && (flowCrashed || /settings did not apply|attachment failed|media extraction failed|failed to fetch|timed out waiting|generation failed|policy rejection|video source lookup failed|No completed video card|could not enter|not found|prompt typing failed twice|native (?:@ )?picker|native asset search|tab was closed|frame with id|cannot access contents/i.test(errorText));
    if (stopRequested || token !== runToken || /cancelled by user|^Flow quota pause:/i.test(errorText)) {
      item.status = 'pending';
      item.retryAt = null;
      item.detail = /^Flow quota pause:/i.test(errorText) ? 'Waiting for Flow credits — not submitted' : 'cancelled - ready to resume';
      globalThis.QueueReasons?.setQueueReason(item, /^Flow quota pause:/i.test(errorText) ? 'quota_wait' : 'stopped_resumable');
      if (!/cancelled by user/i.test(errorText)) log(`${item.id}: stopped during: ${errorText}`);
      renderQueue();
    } else if (e?.code === 'FLOW_TAB_CHANGED' || (/Flow prompt verification failed/i.test(errorText) && typeof navigator !== 'undefined' && (!!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '')))) {
      stopRequested = true;
      queueStopReason = e?.code === 'FLOW_TAB_CHANGED' ? 'return to the original Flow project, then press Start' : 'Flow mobile prompt entry needs attention; close the asset picker and press Start';
      item.status = 'pending'; item.retryAt = null; item.detail = errorText; globalThis.QueueReasons?.setQueueReason(item, 'tab_changed');
      renderQueue();log(`${item.id}: ${errorText}. Queue paused; remaining prompts are kept for resume.`);
    } else if (/^Flow setup failed(?: after media attach)?: model unavailable:/i.test(errorText)) {
      stopRequested=true;queueStopReason='requested Flow Lower Priority model is unavailable';item.status='pending';item.retryAt=null;item.detail=errorText;globalThis.QueueReasons?.setQueueReason(item,'model_unavailable');renderQueue();log(`${item.id}: ${errorText}. Remaining prompts are kept for resume.`);
    } else if (/^Flow setup failed: duration unavailable:/i.test(errorText)) {
      // A settings mismatch fails every prompt the same way: pause once with the fix instead of failing the whole list.
      stopRequested = true;
      queueStopReason = 'the chosen duration is not offered by Flow\'s current model';
      item.status = 'pending'; item.retryAt = null;
      item.detail = errorText.replace(/^Flow setup failed: duration unavailable: /i, ''); globalThis.QueueReasons?.setQueueReason(item, 'duration_unavailable');
      renderQueue();
      log(`${item.id}: ${item.detail}. Queue paused; nothing was sent to Flow.`);
    } else if (/^Flow unusual activity detected:/i.test(errorText)) {
      stopRequested = true;
      queueStopReason = 'Flow unusual activity';
      item.status = 'pending'; item.retryAt = null;
      item.detail = 'Flow unusual activity — queue paused; check Flow manually before resuming'; globalThis.QueueReasons?.setQueueReason(item, 'unusual_activity');
      renderQueue(); showFlowActivityWarning();
      log(`${item.id}: ${errorText}. Queue paused; no automatic retry or prompt repair.`);
      // Safety net: the page progress window changes Flow's page, so the setting is switched off after this warning.
      if (settings.miniProgress !== false && typeof hideMiniProgress === 'function') {
        settings.miniProgress = false; if ($('miniProgress')) $('miniProgress').checked = false; hideMiniProgress(); schedulePersist();
        log('The progress window on the Flow page is now off, in case it contributed to this warning. Turn it back on in Settings → "Show a small progress window on the page".');
      }
      await notifyUser('0xtnp Flow Studio paused', 'Your queue is paused. Open 0xFlow to see what to do next.');
    // Only a video Flow really accepted (rendering) holds credits. Prompts that were merely sent at the same moment do not:
    // three refusals in a row then meant three wasted tries before the stop and account switch (owner 2026-10-29).
    } else if (quotaHit && !item.quotaSoloRetry && [...activeRuns.entries()].some(([id, run]) => id !== item.id && run.rendering && !run.generationDone)) {
      // Flow reserves credits for every video still rendering, so with a low balance a parallel prompt can be refused while
      // the account still has credits (owner log 2026-10-28: p002 refused, p003 submitted the same second and saved).
      // Wait for the others, then retry this prompt once on its own; only a second refusal is a real quota stop.
      const others = [...activeRuns.entries()].filter(([id, run]) => id !== item.id && run.rendering && !run.generationDone).length;
      item.quotaSoloRetry = true; quotaSolo = true;
      item.status = 'pending'; item.retryAt = null;
      item.detail = 'Flow had no free credits while other videos render; retrying alone when they finish'; globalThis.QueueReasons?.setQueueReason(item, 'solo_retry');
      renderQueue();
      log(`${item.id}: Flow said "not enough credits" while ${others} other video(s) were still rendering. Flow reserves credits for each running video, so this prompt is retried once on its own after they finish; the rest of this run sends one prompt at a time.`);
    } else if (quotaHit) {
      quotaStop = true;
      queueStopReason = 'Flow credits or usage limit reached';
      item.status = 'pending';
      item.retryAt = null;
      item.detail = `quota reached - retry later`; globalThis.QueueReasons?.setQueueReason(item, 'quota_wait');
      renderQueue();
      log(`${item.id}: Flow quota/credit limit hit (${errorText.replace(/^Flow quota message detected: /, '')}). New submissions paused; already-submitted results will finish saving. Press Start once your credits reset.`);
      await notifyUser('0xtnp Flow Studio quota stop', 'Flow reported a credit/usage limit. The queue paused; restart it after the limit resets.');
    } else if (running && item.manualSheetIds && /policy rejection/i.test(errorText)) {
      // A refused storyboard sheet goes straight to single images: Flow refuses the same 4-scene text again within
      // seconds (owner log 2026-10-25: 3 attempts per sheet, ~30 s lost each). The singles get the usual retries and repair.
      item.status = 'error'; item.retryAt = null;
      item.detail = `Flow refused the sheet (${errorText})`; globalThis.QueueReasons?.setQueueReason(item, 'sheet_refused');
      renderQueue();
    } else if (running && typeof repairFailedPrompt === 'function' && await repairFailedPrompt(item, errorText, token)) {
      // Validated repair is queued for this scene only.
    } else if (running && /^Flow policy rejection:/i.test(errorText) && item.refusedText === (item.generationText || item.text)) {
      // Owner run 2026-11-11: with cloud repair off, one scene's identical prompt was refused 9 times ("prominent people":
      // 3 queue tries x 3 Factory passes). Flow judges the same text the same way, so a second identical refusal ends it.
      item.status = 'error'; item.retryAt = null; item.refusedUnchanged = true;
      item.detail = 'Flow refused this exact prompt twice; not sent again. Change the wording or the start image (or turn on cloud repair), then Retry'; globalThis.QueueReasons?.setQueueReason(item, 'refused_twice');
      // "Prominent people" also judges the face in an AI Story start image: the Builder then makes that scene image again
      // once (same step as when cloud repair blames the image), and only that scene's video runs again.
      if (/prominent people/i.test(errorText) && item.builderSceneId && settings.mode === 'frame-to-video') item.imageSuspect = true;
      renderQueue();
      log(`${item.id}: ${errorText}. Same prompt refused twice — not resent. Edit it or turn on cloud repair, then Retry.`);
    } else if (running && settings.mode === 'ingredients-to-video' && /^Flow generation failed:/i.test(errorText)
      && !item.referenceSimplificationTried && (item.technicalFailures || 0) < settings.maxAttempts - 1
      && P().simplifyRepeatedShotReferences(item.generationText || item.text, images.map(image => image.name)) !== (item.generationText || item.text)) {
      const before = item.generationText || item.text;
      item.referenceSimplificationTried = true;
      item.technicalFailures = (item.technicalFailures || 0) + 1;
      item.referenceSimplificationOriginal = before;
      item.text = P().simplifyRepeatedShotReferences(before, images.map(image => image.name));
      item.generationText = item.text;
      item.status = 'pending'; item.retryAt = Date.now() + settings.retryDelaySeconds * 1000;
      item.detail = 'Retrying with repeated shot/dialogue image tags simplified; story and reference anchors preserved'; globalThis.QueueReasons?.setQueueReason(item, 'retry_scheduled');
      renderQueue();
      log(`${item.id}: generic generation failure — removed redundant @ tags in shots/dialogue only. One simplified retry; dialogue, timing and character references unchanged.`);
    } else if (running && retryable && (item.technicalFailures = (item.technicalFailures || 0) + 1) < settings.maxAttempts) {
      if (/^Flow policy rejection:/i.test(errorText)) item.refusedText = item.generationText || item.text;
      if (flowCrashed && tab?.id) {
        item.detail = 'Flow crashed - reloading project before retry';
        renderQueue();
        await chrome.tabs.reload(tab.id).catch(() => {});
        await sleep(5000);
      }
      item.status = 'pending';
      item.retryAt = Date.now() + settings.retryDelaySeconds * 1000;
      item.detail = `technical retry ${item.technicalFailures + 1}/${settings.maxAttempts} scheduled`; globalThis.QueueReasons?.setQueueReason(item, 'retry_scheduled');
      renderQueue();
      log(`${item.id}: technical failure ${item.technicalFailures}/${settings.maxAttempts}: ${errorText}. Retrying in ${settings.retryDelaySeconds} seconds.`);
    } else {
      item.status = 'error';
      item.retryAt = null;
      item.detail = `Error after ${item.attempts || 1} attempt(s): ${errorText}`; globalThis.QueueReasons?.setQueueReason(item, globalThis.QueueReasons?.classifyQueueError(errorText) || 'failed');
      renderQueue();
      log(`${item.id}: failed after ${item.attempts || 1} attempt(s): ${errorText}`);
      await notifyUser('0xtnp Flow Studio error', `${item.id} failed after ${item.attempts || 1} attempt(s).`);
    }
    // Generated but not saved: still pause before the next chained prompt.
    pauseForChainFailure();
  } finally {
    if (tab?.id) await exec(tab.id, pg_flowStopResultTracking, [trackingKey]).catch(() => {});
    if (typeof flowInFlight !== 'undefined') flowInFlight.delete(item.id);
    if (typeof flowDraining !== 'undefined' && flowDraining === item.id) flowDraining = null;
    page.release?.(); page.release = null;
  }
}

function quotaSnippet(text) {
  const value = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const match = value.match(/.{0,60}(limit|credit|quota).{0,80}/);
  return match ? match[0].trim() : value.slice(0, 140);
}

function guessImageExt(buf, src) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  const brand = P().isoImageBrand(buf);
  if (brand) return brand;
  const path = String(src || '').split('?')[0];
  if (/\.png$/i.test(path)) return 'png';
  if (/\.jpe?g$/i.test(path)) return 'jpg';
  if (/\.webp$/i.test(path)) return 'webp';
  return 'png';
}

function freeSlotIndex() {
  const used = new Set([...activeRuns.values()].filter(run => !run.generationDone).map((run) => run.slot));
  for (let i = 0; i < (typeof runConcurrency === 'function' ? runConcurrency() : settings.concurrentPrompts); i++) {
    if (!used.has(i)) return i;
  }
  return -1;
}

// ---------- pre-start check (run-report.js) ----------
function runPreflight() {
  if (settings.platform === 'vids') return vidsQueueIssues();
  if (typeof preflightCheck !== 'function') return [];
  const items = queue.filter(item => item.status === 'pending' && !item.groupParent);
  // Higgsfield makes AI Story scene videos (owner 2026-11-17); story images still come from the image engines.
  if(settings.platform==='higgsfield'&&items.some(i=>/-concat$/.test(i.videoMode||'')))return [{level:'error',hard:true,message:'Higgsfield makes one video per prompt; use a queue without combined scenes.'}];
  if(settings.platform==='higgsfield'&&items.some(i=>i.builderProjectId&&(!i.builderSceneId||!MODES[settings.mode]?.resultKind||MODES[settings.mode].resultKind!=='video')))return [{level:'error',hard:true,message:'Higgsfield makes AI Story videos only. Choose another engine for the story images.'}];
  if(settings.platform==='muse'&&items.some(i=>i.builderProjectId||/-concat$/.test(i.videoMode||'')))return [{level:'error',hard:true,message:'Muse currently supports manual queues without combined scenes. AI Story/Concat integration is not enabled.'}];
  return preflightCheck({items, settings, images, modeDef: MODES[settings.mode] || {},
    imagesFor: item => imagesForItem({...item, groupMemberIds: null}, true),
    missingMentions: (text, names) => P().missingImageMentions(text, names),
    matchImageByName: (name, names) => P().matchImageByName(name, names),
    rawFolder: settings.downloadSubfolder, folder: downloadFolder()});
}
function renderPreflight(issues = []) {
  const box = $('preflightBox');
  if (!box) return;
  box.hidden = !issues.length;
  if (!issues.length) { box.innerHTML = ''; return; }
  const errors = issues.filter(issue => issue.level === 'error');
  box.className = errors.length ? 'preflight preflight-error' : 'preflight preflight-warning';
  box.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = errors.length ? 'Fix these before starting' : 'Started — please check';
  const list = document.createElement('ul');
  for (const issue of issues) { const li = document.createElement('li'); li.dataset.level = issue.level; li.textContent = issue.message; list.append(li); }
  box.append(title, list);
  const row = document.createElement('div'); row.className = 'toolbar';
  if (errors.length && !errors.some(issue => issue.hard)) {
    const anyway = document.createElement('button'); anyway.type = 'button'; anyway.className = 'small'; anyway.textContent = 'Start anyway';
    anyway.addEventListener('click', () => { renderPreflight([]); startQueue({skipPreflight: true}); });
    row.append(anyway);
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'small ghost'; close.textContent = 'Dismiss';
  close.addEventListener('click', () => renderPreflight([]));
  row.append(close); box.append(row);
}

// ---------- browser diagnostics (Debug Logs) ----------
// Users report problems in Microsoft Edge, which can put tabs to sleep (Sleeping tabs / efficiency mode). These lines
// make every log say which browser it came from, and what state the working tab was in when a prompt failed.
async function browserInfoText() {
  try {
    const data = navigator.userAgentData;
    const values = data?.getHighEntropyValues ? await data.getHighEntropyValues(['fullVersionList', 'platformVersion']) : null;
    const brands = (values?.fullVersionList || data?.brands || []).filter(b => !/not.?a.?brand|chromium/i.test(b.brand));
    const main = brands.find(b => /edge/i.test(b.brand)) || brands.find(b => /chrome/i.test(b.brand)) || brands[0];
    if (main) return `${main.brand} ${main.version} (${data.platform || 'unknown OS'})`;
  } catch { /* fall back to the user agent */ }
  const ua = navigator.userAgent || '';
  const m = ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/);
  return m ? `${/Edg\//.test(ua) ? 'Microsoft Edge' : 'Chrome'} ${m[1]}` : ua.slice(0, 120);
}
// Phone or computer, screen size, and where the panel is open (side panel, its own tab, popup): mobile browsers open the
// panel as a tab, which puts the Flow tab in the background while the user watches (owner's user on Quetta, 2026-10-30).
async function deviceInfoText() {
  const parts = [navigator.userAgentData?.mobile || /Android|Mobile/i.test(navigator.userAgent || '') ? 'phone/tablet' : 'computer'];
  try { parts.push(`screen ${screen.width}x${screen.height} @${Math.round((devicePixelRatio || 1) * 10) / 10}x`, `panel ${innerWidth}x${innerHeight}`); } catch {}
  try { const own = await chrome.tabs.getCurrent(); parts.push(own ? `panel open as a tab${own.active ? ' (in front)' : ''}` : 'panel in the side panel or a popup'); } catch {}
  return parts.join(', ');
}
function pg_tabHealth() {
  return {visibility: document.visibilityState, focused: document.hasFocus(), wasDiscarded: !!document.wasDiscarded, readyState: document.readyState, size: `${innerWidth}x${innerHeight}`};
}
async function logTabHealth(item, slot) {
  const tabId = slotTabs.get(slot);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const page = await exec(tabId, pg_tabHealth, []).catch(error => ({error: String(error?.message || error).slice(0, 120)}));
    const parts = [`status ${tab.status}`, `active ${!!tab.active}`, `discarded ${!!tab.discarded}`];
    if ('frozen' in tab) parts.push(`frozen ${!!tab.frozen}`);
    if (page?.error) parts.push(`page not reachable (${page.error})`);
    else parts.push(`page ${page.visibility}`, `focused ${page.focused}`, `was asleep ${page.wasDiscarded}`, `document ${page.readyState}`);
    if (page.size) parts.push(`page size ${page.size}`);
    log(`${item.id}: tab state when it ended: ${parts.join(', ')}.`);
  } catch (error) { log(`${item.id}: tab state when it ended: tab not available (${String(error?.message || error).slice(0, 120)}).`); }
}
// Logs when the browser puts one of the queue's working tabs to sleep during a run (Edge Sleeping tabs, memory saver).
function watchTabSleep(token) {
  const listener = (tabId, change) => {
    if (token !== runToken) { try { chrome.tabs.onUpdated.removeListener(listener); } catch {} return; }   // an old run's watcher
    if (![...slotTabs.values()].includes(tabId)) return;
    if (change.discarded === true) log(`WARNING: the browser discarded (put to sleep) a working tab (id ${tabId}) during the run. In Edge: Settings → System and performance → add the site to "Never put these sites to sleep".`);
    if (change.frozen === true) log(`WARNING: the browser froze a working tab (id ${tabId}) during the run (sleeping tabs / efficiency mode).`);
  };
  // The browser itself ending a debugger session (not our own detach): phones dropped it mid-click with "Debugger is not
  // attached" (owner's user on Quetta, 2026-10-30), and the reason was missing from the log.
  const detached = (source, reason) => {
    if (token !== runToken || ![...slotTabs.values()].includes(source?.tabId)) return;
    log(`WARNING: the browser ended the debugger connection to a working tab (id ${source.tabId}): ${reason}${reason === 'canceled_by_user' ? ' (the "started debugging" bar was closed, or the browser cancelled it)' : reason === 'target_closed' ? ' (the tab closed or reloaded)' : ''}.`);
  };
  try { chrome.debugger?.onDetach?.addListener(detached); } catch {}
  try { chrome.tabs.onUpdated.addListener(listener); } catch { try { chrome.debugger?.onDetach?.removeListener(detached); } catch {} return () => {}; }
  return () => { try { chrome.tabs.onUpdated.removeListener(listener); } catch {} try { chrome.debugger?.onDetach?.removeListener(detached); } catch {} };
}

async function mainLoop(token) {
  let nextSubmissionAt = 0, afterResultUntil = 0;
  const startedLog = `Queue started: ${queue.length} prompt(s), mode ${MODES[settings.mode].label}, ${typeof flowParallelCount === 'function' && flowParallelCount() > 1 ? `parallel in Flow ${flowParallelCount()}` : `${settings.concurrentPrompts} concurrent`}, delay ${settings.delayMinSeconds}-${settings.delayMaxSeconds}s${settings.afterResultMaxSeconds > 0 ? `, wait after each result ${settings.afterResultMinSeconds}-${settings.afterResultMaxSeconds}s` : ''}.`;
  log(startedLog);
  try { mobileRunKeepAlive(true); } catch {}   // unfreeze this tab on phones while the queue runs (finding G 2026-10-31)
  try { window.flowBuddy?.event('queue-start', {total: queue.length, platform: settings.platform || 'flow'}); } catch {}
  try { if ((settings.platform || 'flow') === 'flow') window.flowStatusReport?.queueStart(); } catch {}   // Flow accounts dashboard
  const stopWatchingSleep = typeof watchTabSleep === 'function' ? watchTabSleep(token) : () => {};
  if (typeof browserInfoText === 'function') browserInfoText().then(async text => log(`Browser: ${text} · extension v${APP_VERSION} · platform ${settings.platform || 'flow'} · ${await deviceInfoText()}.`)).catch(() => {});
  if (typeof usageRefresh === 'function') await usageRefresh(true);   // free plan counter (usage-limit.js)
  while (running && !stopRequested && token === runToken) {
    const activeCount = [...activeRuns.values()].filter(run => !run.generationDone).length;
    // A retry cooldown holds its place; later prompts must not jump ahead.
    const pending = queue.filter((p) => p.status === 'pending' && !p.groupParent && !activeRuns.has(p.id));
    const retryBarrier = queue.findIndex(p => !p.groupParent &&
      ((p.status === 'pending' && p.retryAt) ||
       (activeRuns.has(p.id) && !activeRuns.get(p.id).generationDone && p.attempts > 1)));
    const candidate = pending[0];
    const canSubmit = candidate && (!candidate.retryAt || candidate.retryAt <= Date.now()) &&
      (retryBarrier < 0 || queue.indexOf(candidate) <= retryBarrier);
    if (canSubmit && activeCount < (typeof runConcurrency === 'function' ? runConcurrency() : settings.concurrentPrompts)) {
      if (Date.now() < nextSubmissionAt) {
        await sleep(250);
        continue;
      }
      // The user's "Wait after each result" (off unless set): counted from when the last result finished.
      if (Date.now() < afterResultUntil) {
        const left = Math.ceil((afterResultUntil - Date.now()) / 1000), detail = `waiting ${left}s before the next prompt (your Wait after each result setting)`;
        if (candidate.detail !== detail) { candidate.detail = detail; renderQueue(); }
        await sleep(250);
        continue;
      }
      if (/^waiting \d+s before the next prompt/.test(candidate.detail || '')) candidate.detail = '';
      const item = pending[0];
      const slot = freeSlotIndex();
      if (slot < 0) { await sleep(250); continue; }
      // Free plan: N saved results per day (usage-limit.js); the queue pauses with the prompts kept, like a credit stop.
      if (typeof usageAllowsNext === 'function') {
        const gate = await usageAllowsNext(activeCount);
        if (!gate.ok) {
          stopRequested = true; queueStopReason = gate.reason;
          log(gate.message); renderQueue();
          await notifyUser('0xFlow free plan', gate.message);
          break;
        }
      }
      nextSubmissionAt = Date.now() + P().randomDelayMs(settings.delayMinSeconds, settings.delayMaxSeconds);
      const entry = { item, slot, settled: false };
      activeRuns.set(item.id, entry);
      runPrompt(item, slot, token)
        .catch((e) => { item.status = 'error'; item.retryAt = null; item.detail = `Unexpected runner error: ${String(e && e.message ? e.message : e)}`; globalThis.QueueReasons?.setQueueReason(item, 'failed'); log(`${item.id}: ${item.detail}`); })
        .finally(() => {
          if (item.status === 'done' && typeof usageRecordSaved === 'function') usageRecordSaved(item);   // counts 1 saved result
          if (token !== runToken) return;
          // A failure, timeout or scheduled retry: record the tab's state for the Debug Logs (sleep, hidden page…).
          if (item.status === 'error' || (item.status === 'pending' && item.retryAt) || /timed out/i.test(item.detail || '')) { if (typeof logTabHealth === 'function') logTabHealth(item, slot).catch(() => {}); }
          if (item.manualSheetIds && item.status === 'error') manualSheetFallback(item);
          for (const member of queue.filter(entry => entry.groupParent === item.id)) {
            member.status = item.status === 'pending' ? 'combined' : item.status;
            member.outputName = item.outputName;
            member.detail = `Combined with prompt ${item.index} · ${item.detail}`;
          }
          activeRuns.delete(item.id);
          // A finished or failed prompt starts the user's wait (a scheduled retry keeps its own retry delay).
          if (item.status !== 'pending' && settings.afterResultMaxSeconds > 0) afterResultUntil = Math.max(afterResultUntil, Date.now() + P().randomDelayMs(settings.afterResultMinSeconds, settings.afterResultMaxSeconds));
          renderQueue();
          schedulePersist();
        });
      renderQueue();
      continue;
    }
    if (!queue.some(item => item.status === 'pending' && !item.groupParent) && activeCount === 0) {
      // Storyboard frames still being AI-upscaled in the background: the run ends when they are saved.
      if (typeof sheetUpscaleJobs !== 'undefined' && sheetUpscaleJobs.size) { await Promise.allSettled([...sheetUpscaleJobs]); continue; }
      break;
    }
    await sleep(500);
  }
  // Let in-flight prompts observe stopRequested, then finalize.
  if (token !== runToken) return;
  while (activeRuns.size) {
    await sleep(500);
    if (token !== runToken) return;
  }
  running = false;
  stopWatchingSleep();
  // AI Story Auto about to start its next stage: keep Background Mode on, or that stage runs in a hidden tab where
  // Flow's settings menu never opens (owner log 2026-10-16: three videos failed "settings did not apply", page hidden).
  // The Builder stops it when the whole Auto run ends or Auto stops.
  const autoContinues = !quotaStop && !stopRequested && queue.length > 0 && queue.every(item => item.status === 'done' && item.builderProjectId)
    && Boolean(window.FlowBuilderUI?.autoRunOn?.());
  if (typeof stopBackgroundMode === 'function' && !autoContinues) stopBackgroundMode('');   // no message when the queue ends (owner 2026-10-18)
  if (!autoContinues) { try { mobileRunKeepAlive(false); } catch {} }   // auto-continue restarts the queue (and the keep-alive) moments later
  // Every end (finished, stopped, paused or with errors) gives the tabs their normal zoom back; the next run zooms out again.
  for (const tabId of slotTabs.values()) await restoreTabZoom(tabId).catch(() => {});
  setRunState(quotaStop ? 'quota stop' : 'idle', quotaStop ? 'status-bad' : 'status-warn');
  const doneCount = queue.filter((p) => p.status === 'done').length;
  const errCount = queue.filter((p) => p.status === 'error').length;
  if (!quotaStop && !stopRequested && errCount === 0 && doneCount === queue.length && queue.length) {
    log(`Queue complete: ${doneCount}/${queue.length} saved.`);
    await notifyUser('0xtnp Flow Studio complete', `All ${doneCount} prompt(s) finished.`);
  } else if (stopRequested && !quotaStop) {
    log(queueStopReason ? `Queue paused: ${queueStopReason}.` : 'Queue stopped by user.');
  }
  try { window.flowBuddy?.event('queue-end', {done: doneCount, errors: errCount, total: queue.length, stopped: stopRequested, quota: quotaStop, reason: queueStopReason}); } catch {}
  // Flow accounts dashboard + Telegram alerts (flow-status-report.js); before the account switcher acts.
  try { if ((settings.platform || 'flow') === 'flow') window.flowStatusReport?.queueEnd({quota: !!quotaStop, stopped: !!stopRequested, reason: queueStopReason || '', errors: errCount}); } catch {}
  // Clean = every prompt saved, nothing stopped or paused: only then may the Builder's Auto run start the next stage.
  const clean = !quotaStop && !stopRequested && errCount === 0 && doneCount === queue.length && queue.length > 0;
  // The Factory needs to know WHY a run ended (credits / unusual activity / errors / Stop), not only whether it was clean.
  const refusedOnly = errCount > 0 && queue.filter((p) => p.status === 'error').every((p) => p.refusedUnchanged);
  const endInfo = {tabId:slotTabs.get(0),projectUrl:settings.flowProjectUrl,clean, quota: !!quotaStop, stopped: !!stopRequested, reason: queueStopReason || '', errors: errCount, refusedOnly};
  stopRequested = false;
  renderQueue();
  schedulePersist();
  if (typeof flowDebuggerRelease === 'function') await flowDebuggerRelease();
  try { await window.FlowBuilderUI?.queueEnded(endInfo); } catch(e) { console.warn('Builder continuation:',e); }
  // Manual Flow queues (Pro, opt-in): switch to the next chosen Flow account on credits and continue (manual-account-switch.js).
  if (quotaStop && !window.manualAccountSwitch) log('Account switching is not loaded in this panel; reload the extension.');
  try { await window.manualAccountSwitch?.queueEnded(endInfo, queue); } catch(e) { log('Account switching failed: ' + (e?.message || e)); }
  try { await window.geminiAccountSwitch?.queueEnded(endInfo, queue); } catch(e) { log('Gemini account switching failed: ' + (e?.message || e)); }
  try { await window.vidsAccountSwitch?.queueEnded(endInfo, queue); } catch(e) { log('Google Vids account switching failed: ' + (e?.message || e)); }
}

function flowAutomationCapabilityIssue() {
  if (typeof chrome.scripting?.executeScript !== 'function') return 'This browser does not provide the page-scripting API required for Flow automation. The 0xFlow interface can open, but Flow generation is not supported here yet.';
  if (typeof chrome.debugger?.attach !== 'function' || typeof chrome.debugger?.sendCommand !== 'function') return 'This browser does not provide the debugger API required for Flow automation. The 0xFlow interface can open, but Flow generation is not supported here yet.';
  return '';
}

async function startQueue(options = {}) {
  // Every refusal is shown next to Start, not only in the Debug log (owner 2026-11-12: "I click Start, nothing happens").
  const startBlocked = message => { $('applyStatus').textContent = message; renderPreflight([{level:'error', message, hard:true}]); log('Cannot start: ' + message); };
  if(globalThis.OxMotion?.busy && !(await globalThis.OxMotion.releaseIfOrphaned?.())){startBlocked('Motion Studio is using Flow right now (generating, or waiting for you in the Flow tab). Pause it in the Motion Studio window or let it finish, then press Start.');return;}
  globalThis.window?.manualAccountSwitch?.cancelPending?.();
  globalThis.window?.geminiAccountSwitch?.cancelPending?.();
  globalThis.window?.vidsAccountSwitch?.cancelPending?.();
  if (running) return;
  if (activeRuns.size) { startBlocked('The last run is still closing (' + activeRuns.size + ' prompt' + (activeRuns.size === 1 ? '' : 's') + '). Wait a few seconds, then press Start again.'); return; }
  if (typeof projectImportBusy !== 'undefined' && projectImportBusy) { startBlocked('A project is still loading. Wait for it to finish, then press Start.'); return; }
  const skipPreflight = options?.skipPreflight === true;   // the Start button passes a click event, never this flag
  if (outputDir) try {
    let permission = await outputDir.queryPermission({mode:'readwrite'});
    if (permission !== 'granted') permission = await outputDir.requestPermission({mode:'readwrite'});
    if (permission !== 'granted') throw new Error('Allow access to the imported project output folder before starting.');
  } catch (error) {
    $('projectImportStatus').textContent=error.message;
    $('settingsTabBtn').click();$('loadProjectBtn').closest('details').open=true;
    log(`Cannot start: ${error.message}`);return;
  }
  collectSettingsFromForm();
  if (settings.platform === 'vids') {
    try { await startMainVidsQueue(); } catch (error) { startBlocked(error.message); }
    return;
  }
  if (queue.some(item => item.vidsPending)) { startBlocked('Recover the submitted result in Google Vids before starting another engine.'); return; }
  // Opening the interface does not imply that the browser implements Flow's automation APIs.
  if ((settings.platform || 'flow') === 'flow' && queue.some(item => item.status === 'pending' && !item.groupParent) && typeof flowAutomationCapabilityIssue === 'function') {
    const issue = flowAutomationCapabilityIssue();
    if (issue) { $('applyStatus').textContent = issue; log('Cannot start: ' + issue); return; }
  }
  // Pre-start check: everything a run would only discover prompt by prompt. Errors stop here ("Start anyway" overrides
  // unless nothing could work); warnings are shown and the queue starts.
  if (queue.some(item => item.status === 'pending' && !item.groupParent)) {
    const issues = runPreflight();
    const errors = issues.filter(issue => issue.level === 'error');
    if (errors.length && !(skipPreflight && !errors.some(issue => issue.hard))) {
      renderPreflight(issues);
      log(`Cannot start yet: ${errors.map(issue => issue.message).join(' | ')}`);
      return;
    }
    renderPreflight(issues.filter(issue => issue.level === 'warning'));
    for (const issue of issues) log(`Check before start (${issue.level}${skipPreflight && issue.level === 'error' ? ', started anyway' : ''}): ${issue.message}`);
  }
  let factoryFlowTab=null;
  try{if((settings.platform||'flow')==='flow'&&queue.some(i=>i.status==='pending'))factoryFlowTab=await window.FlowBuilderUI?.factoryFlowTab?.(queue)||null;}
  catch(e){$('applyStatus').textContent=e.message;log('Factory Flow project: '+e.message);return;}
  try { if (!factoryFlowTab && await globalThis.window?.manualAccountSwitch?.beforeStart?.(queue) === false) return; } catch (e) { log('Account switching failed: ' + (e?.message || e)); return; }
  try { if (!factoryFlowTab && await globalThis.window?.geminiAccountSwitch?.beforeStart?.(queue) === false) return; } catch (e) { log('Gemini account switching failed: ' + (e?.message || e)); return; }
  let [activeTab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  let capturedTabId = typeof getBackgroundFlowTabId === 'function' ? getBackgroundFlowTabId() : null;
  if(factoryFlowTab){if(capturedTabId!=null&&capturedTabId!==factoryFlowTab.id)stopBackgroundMode('Factory is using its own part project');capturedTabId=null;activeTab=factoryFlowTab;}
  const bgPlatform = settings.platform || 'flow';
  const bgName = bgPlatform === 'chatgpt' ? 'ChatGPT' : bgPlatform === 'gemini' ? 'Gemini' : bgPlatform === 'grok' ? 'Grok' : bgPlatform==='muse'?'Muse':bgPlatform==='higgsfield'?'Higgsfield':'Flow';
  const activeIsTarget = (bgPlatform === 'chatgpt' ? /^https:\/\/chatgpt\.com(?:\/|$)/i : bgPlatform === 'gemini' ? /^https:\/\/gemini\.google\.com(?:\/|$)/i : bgPlatform === 'grok' ? /^https:\/\/grok\.com(?:\/|$)/i : bgPlatform==='muse'?/^https:\/\/(?:[a-z0-9-]+\.)?muse\.ai(?:\/|$)/i: bgPlatform==='higgsfield'?/^https:\/\/(?:[a-z0-9-]+\.)?higgsfield\.ai(?:\/|$)/i: /^https:\/\/(?:flow\.google(?:\.com)?(?:\/|$)|labs\.google\/fx\/tools\/flow(?:\/|$))/i).test(activeTab?.url || '');
  if (capturedTabId != null && activeIsTarget && activeTab.id !== capturedTabId) {
    stopBackgroundMode(`${bgName} tab changed — enable sharing again for this account`);
  } else if (capturedTabId != null) {
    activeTab = await chrome.tabs.get(capturedTabId).catch(()=>null);
    if (!activeTab) { stopBackgroundMode(`${bgName} tab closed · sharing stopped`); return; }
  }
  if(!factoryFlowTab){const prepared=globalThis.window?.manualAccountSwitch?.takeStartTab?.()||globalThis.window?.geminiAccountSwitch?.takeStartTab?.();if(prepared){activeTab=prepared;capturedTabId=null;}}
  if (running) return;
  const activeFlow = (settings.platform || 'flow') === 'flow' && /^https:\/\/(?:flow\.google(?:\.com)?(?:\/|$)|labs\.google\/fx\/tools\/flow(?:\/|$))/i.test(activeTab?.url || '');
  settings.flowProjectUrl = activeFlow ? activeTab.url : DEFAULT_SETTINGS.flowProjectUrl;
  if (settings.platform === 'chatgpt' || settings.platform === 'gemini' || settings.platform === 'grok' || settings.platform==='muse' || settings.platform==='higgsfield' || activeFlow || (settings.chainLastFrame && settings.mode === 'frame-to-video')) { settings.concurrentPrompts = 1; $('concurrentPrompts').value = '1'; }
  slotTabs.clear();
  if(settings.platform==='gemini' && typeof isGeminiTab==='function' && isGeminiTab(activeTab)) { slotTabs.set(0,activeTab.id); log('Using the active Gemini tab and its signed-in account.'); }
  if(settings.platform==='grok' && typeof isGrokTab==='function' && isGrokTab(activeTab)) {
    slotTabs.set(0,activeTab.id);
    if (typeof zoomGrokTab === 'function') await zoomGrokTab(activeTab.id);
    log('Using the active Grok tab and its signed-in account.');
  }
  if(settings.platform==='higgsfield'&&typeof isHiggsTab==='function'&&isHiggsTab(activeTab)){slotTabs.set(0,activeTab.id);log('Using the active Higgsfield tab and its signed-in account.');}
  if(settings.platform==='muse'&&typeof isMuseTab==='function'&&isMuseTab(activeTab)){slotTabs.set(0,activeTab.id);log('Using the active Muse chat and its signed-in account.');}
  if(settings.platform==='chatgpt' && typeof isChatgptTab==='function' && isChatgptTab(activeTab)) {
    rememberChatgptTaskTab(activeTab);slotTabs.set(0,activeTab.id);
    if (typeof zoomChatgptTab === 'function') await zoomChatgptTab(activeTab.id);
    log('Using the active ChatGPT tab and its current conversation.');
  }
  if (activeFlow) { slotTabs.set(0,activeTab.id); log('Using the active Flow tab and its current signed-in account.'); }
  else if ((settings.platform || 'flow') === 'flow') {
    // A fresh flow.google.com tab can open on another Google account (one with no credits). Reuse the Flow tab the
    // user worked in last so the queue keeps that tab's account.
    const open = (await chrome.tabs.query({url:['https://flow.google.com/*','https://flow.google/*','https://labs.google/fx/*']}).catch(()=>[]))
      .filter(t => /^https:\/\/(?:flow\.google(?:\.com)?(?:\/|$)|labs\.google\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$))/i.test(t.url || ''))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (open[0]) {
      settings.flowProjectUrl = open[0].url; settings.concurrentPrompts = 1; $('concurrentPrompts').value = '1';
      slotTabs.set(0, open[0].id); log('Using your open Flow tab and its signed-in account (not a new tab).');
    }
  }
  const modeDef = MODES[settings.mode];
  if (!queue.length) {
    $('applyStatus').textContent = 'load prompts first';
    return;
  }
  if (!queue.some(item => item.status === 'pending' && !item.groupParent)) {
    $('applyStatus').textContent = 'No pending prompts. Completed prompts are already saved; use Retry on failed prompts.';
    return;
  }
  if (modeDef.needsImages && !images.length) {
    $('applyStatus').textContent = `${modeDef.label} needs at least one uploaded image`;
    log(`Cannot start: ${modeDef.label} requires uploaded images.`);
    return;
  }
  quotaStop = false; quotaSolo = false;
  for (const q of queue) delete q.quotaSoloRetry;
  queueStopReason = '';
  // Missing @mentions are reported by the pre-start check above (all prompts at once).
  try {
    const groups = planPromptGroups(queue, settings.flowDurationSeconds, settings.platform, settings.flowModel);
    if (groups.some(group => group.members.length > 1) && modeDef.resultKind !== 'video') throw new Error('Concat is available in video modes.');
    for (const group of groups) {
      const parent = group.members[0];
      parent.groupParent = null;
      parent.generationText = group.text; parent.generationDuration = group.duration;
      parent.groupMemberIds = group.members.length > 1 ? group.members.map(member => member.id) : null;
      for (const member of group.members.slice(1)) { member.groupParent = parent.id; member.status = 'combined'; member.detail = `Combined with prompt ${parent.index}`; }
    }
  } catch (error) { startBlocked(error.message); return; }
  try { await planManualSheets(); }
  catch (error) { log('Storyboard sheets could not be planned (' + error.message + '); every prompt runs as a single image.'); }
  try { await window.FlowBuilderUI?.prepareManualQueue?.(); }
  catch(error) { log('Manual project could not be saved: '+error.message); $('applyStatus').textContent=error.message; return; }
  stopRequested = false;
  chainedFrame = null;
  running = true;
  if (typeof flowDebuggerKeep === 'function') flowDebuggerKeep();
  setRunState('running', 'status-ok');
  renderQueue();
  mainLoop(++runToken);
}

// ---------- storyboard sheets for manual queues (trial or Pro, owner 2026-10-25) ----------
// Every 4 suitable pending prompts in a row become one 2x2 image (lib/storyboard-sheets.mjs reads the JSON scene format,
// the "START FRAME TO CAPTURE" format and any other prompt). The first prompt carries the sheet; the sheet is cut into 4
// frames saved under each prompt's own file name. A sheet that fails for good runs its 4 prompts as single images.
// Settings switch, off by default: switching it off restores the normal queue completely.
const SHEET_MAX_REFS = 8;
function manualSheetsActive() {
  return !!settings.manualSheets && ['chatgpt', 'flow'].includes(settings.platform || 'flow') && ['text-to-image', 'image-to-image'].includes(settings.mode)
    && settings.aspectRatio === 'portrait' && ((typeof usageState !== 'undefined' && !!usageState?.unlimited)
      || (typeof featureState !== 'undefined' && featureState?.plan === 'free' && featureState.sheets?.included
        && globalThis.FlowGoogleSignIn?.current?.()?.signedIn));
}
async function planManualSheets() {
  // A previous run's grouping is undone first (Stop, then Start again plans afresh).
  for (const x of queue) {
    if (x.manualSheetIds) { x.manualSheetIds = null; x.groupMemberIds = null; x.generationText = x.text; }
    if (x.sheetParent) { if (x.status === 'combined') x.status = 'pending'; x.groupParent = null; x.sheetParent = null; }
  }
  if (settings.manualSheets && typeof featureAllowance === 'function') await featureAllowance(true);
  if (!manualSheetsActive()) return 0;
  const S = await import('./lib/storyboard-sheets.mjs');
  // Owner test 2026-10-25: crowd scenes and 4+ people join sheets too (8 prompts = 2 sheets). To restore the limit, add
  // "&& S.manualPanel(x.text).people <= S.MAX_PEOPLE" back here.
  const eligible = x => x.status === 'pending' && !x.groupParent && !x.groupMemberIds?.length && !x.sheetFallback && !x.builderProjectId;
  // A crowd scene or a prompt that cannot join is skipped, not a break: each frame is saved under its own prompt's name, so
  // the four prompts of a sheet need not be neighbours (owner 2026-10-25: one crowd scene left prompt 1 on its own).
  // Discord Pro: storyboard sheets per month (usage-limit.js, owner 2026-10-25); the prompts past the allowance run singly.
  const possible = Math.floor(queue.filter(eligible).length / S.SHEET_SIZE);
  const cap = possible && typeof sheetsAllowed === 'function' ? await sheetsAllowed(possible) : possible;
  let run = [], made = 0;
  for (const x of queue) {
    if (!eligible(x)) continue;
    const refs = new Set([...run, x].flatMap(m => imagesForItem({...m, groupMemberIds: null}, true).map(image => image.name)));
    if (refs.size > SHEET_MAX_REFS) run = [];
    run.push(x);
    if (run.length < S.SHEET_SIZE) continue;
    if (made >= cap) { run = []; continue; }
    const parent = run[0];
    parent.manualSheetIds = run.map(m => m.id); parent.groupMemberIds = parent.manualSheetIds;
    parent.generationText = S.manualSheetPrompt(run.map(m => m.text), {platform: settings.platform || 'flow'});
    for (const m of run.slice(1)) Object.assign(m, {groupParent: parent.id, sheetParent: parent.id, status: 'combined', detail: `In storyboard sheet with prompt ${parent.index}`});
    made++; run = [];
  }
  if (made) log(`Storyboard sheets: ${made} sheet(s) of 4 prompts; the other prompts run as single images.`);
  if (cap < possible && typeof sheetsLimitReached === 'function') sheetsLimitReached(cap);
  return made;
}
// AI upscale of small sheet frames (owner 2026-10-25): ChatGPT frames are ~469 px wide and their videos came out about 4x
// softer than videos from normal images. Flow 2K frames (~765 px) and normal images are left alone. Any failure saves the
// frame at its normal size (one log line); the queue never stops for it. Also used by AI Story sheets (faceless-builder-ui).
const UPSCALE_BELOW_WIDTH = 700, UPSCALE_TOO_SLOW_S = 60;   // the first frame includes ~15 s engine start
let upscaleWarned = false, upscaleTooSlow = false, upscaleGpuLogged = false, upscaleEngineStarted = false;
// Phones and tablets skip it (owner 2026-10-25): about a minute per frame, heat, and the ~100 MB it needs can make the
// browser close the tab, which would end the queue. Same check as the phone sign-in (google-signin.js).
const upscaleOnMobile = () => !!navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
// Same checks as upscaleSheetFrame, without upscaling: does this sheet get AI-upscaled frames?
let sheetUpscaleChain = Promise.resolve();
const sheetUpscaleJobs = new Set();
function sheetUpscaleWanted(frame) {
  const look = settings.sheetUpscale || 'balanced';
  return look !== 'off' && !upscaleTooSlow && frame.width < UPSCALE_BELOW_WIDTH && !upscaleOnMobile();
}
async function upscaleSheetFrame(frame, options = {}) {
  const look = settings.sheetUpscale || 'balanced';
  if (look === 'off' || upscaleTooSlow || !(frame.width < UPSCALE_BELOW_WIDTH)) return null;
  if (upscaleOnMobile()) {
    if (!upscaleWarned) { upscaleWarned = true; log('AI upscale is skipped on phones and tablets; sheet frames are saved at their normal size.'); }
    return null;
  }
  try {
    const U = await import('./lib/upscale.mjs');
    await U.prepareModel?.();
    const started = Date.now();
    const blob = await U.upscaleFrame(frame, {...options, look: U.LOOKS[look] ?? U.LOOKS.balanced});
    const seconds = (Date.now() - started) / 1000;
    // A very slow PC (built-in graphics under load) pays for one frame at most: the rest of this session skips upscaling.
    if (seconds > UPSCALE_TOO_SLOW_S) { upscaleTooSlow = true; log(`AI upscale took ${Math.round(seconds)} s for one frame on this PC; the next frames are saved at normal size. Set "AI upscale small frames" to Off to skip it, or reload the panel to try again.`); }
    return {blob, seconds};
  } catch (error) {
    if (!upscaleWarned) { upscaleWarned = true; log(`AI upscale skipped (${error.message}); sheet frames are saved at their normal size.`); }
    return null;
  }
}
function manualSheetFallback(parent) {
  const ids = parent.manualSheetIds || [];
  log(`${parent.id}: storyboard sheet did not work (${parent.detail || 'failed'}); its ${ids.length} prompts run as single images.`);
  for (const id of ids) {
    const m = queue.find(x => x.id === id);
    if (m) Object.assign(m, {status: 'pending', retryAt: null, groupParent: null, sheetParent: null, sheetFallback: true, attempts: 0, technicalFailures: 0, chatgptFlagAttempts: 0, chatgptErrorAttempts: 0, repairCount: 0, detail: 'single image (storyboard sheet did not work)'});
  }
  delete parent.chatgptResult;
  Object.assign(parent, {manualSheetIds: null, groupMemberIds: null, generationText: parent.text});
}
async function saveManualSheet(parent, buf, ext, platformName) {
  const S = await import('./lib/storyboard-sheets.mjs'), bitmap = await createImageBitmap(new Blob([buf]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(bitmap, 0, 0);
  const grid = S.findGrid(ctx.getImageData(0, 0, bitmap.width, bitmap.height));
  if (!grid.ok) throw Object.assign(Error(`Storyboard sheet not usable (${grid.reason})`), {sheetUnusable: true});
  if (typeof featureRecord === 'function') featureRecord('sheets', 1);   // a sheet that worked uses one of the day's sheets
  const members = parent.manualSheetIds.map(id => queue.find(x => x.id === id));
  // The whole sheet too, for checking ("001_..._storyboard_sheet.png").
  const sheetSaved = await saveOutput({...parent, manualSheetIds: null, outputSuffix: '_storyboard_sheet'}, buf, ext, platformName).catch(error => { log(`${parent.id}: the whole sheet could not be saved (${error.message}).`); return null; });
  const frames = grid.boxes.map(box => { const frame = new OffscreenCanvas(box.w, box.h); frame.getContext('2d').drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h); return frame; });
  const where = `prompts ${members.filter(Boolean).map(m => m.index).join(', ')}`;
  const saveFrame = async (i, blob, upscaled) => {
    const member = members[i];
    if (!member) return null;
    const saved = await saveOutput({...member, manualSheetIds: null}, await blob.arrayBuffer(), 'png', platformName);
    Object.assign(member, {outputName: saved.name, detail: `saved ${saved.name} → ${saved.where} (${i ? `from storyboard sheet with prompt ${parent.index}` : 'storyboard sheet frame'}${upscaled ? ', AI-upscaled' : ''})`});
    if (i) Object.assign(member, {status: 'done', progressPercent: 100, groupParent: null, retryAt: null});
    return saved;
  };
  if (!sheetUpscaleWanted(frames[0])) {
    let first = null;
    for (const [i, frame] of frames.entries()) { const saved = await saveFrame(i, await frame.convertToBlob({type: 'image/png'}), false); if (i === 0) first = saved; }
    log(`${parent.id}: storyboard sheet cut into ${frames.length} frames (${frames[0].width}x${frames[0].height}) for ${where}.`);
    return first;
  }
  // AI upscale in the background (owner 2026-10-25): the queue already sends the next prompt while these frames are
  // upscaled and saved one after another; the run only ends once every frame is saved (mainLoop waits for the jobs).
  for (const m of members.slice(1)) if (m) Object.assign(m, {groupParent: null, detail: `AI upscaling this frame… (storyboard sheet with prompt ${parent.index})`});
  log(`${parent.id}: storyboard sheet cut into ${frames.length} frames (${frames[0].width}x${frames[0].height}) for ${where}; AI upscale runs in the background.`);
  const job = sheetUpscaleChain.then(async () => {
    let upscaled = 0, seconds = 0;
    const each = [];
    for (const [i, frame] of frames.entries()) {
      const member = members[i];
      try {
        const up = await upscaleSheetFrame(frame, {type: 'image/png'});
        if (up) { upscaled++; seconds += up.seconds; each.push(up.seconds.toFixed(1)); }
        await saveFrame(i, up?.blob || await frame.convertToBlob({type: 'image/png'}), !!up);
      } catch (error) {
        if (member) Object.assign(member, {status: 'error', groupParent: null, retryAt: null, detail: `storyboard frame could not be saved: ${error.message}`});
        log(`${member?.id || parent.id}: storyboard frame could not be saved (${error.message}).`);
      }
      if (typeof renderQueue === 'function') renderQueue();
      if (typeof schedulePersist === 'function') schedulePersist();
    }
    // Each frame's time and, once, the graphics chip (owner run 2026-10-25: 62 s for 4 frames where an idle RTX 4050 takes
    // ~19 s, 13.6 s of it the first frame's engine start): shows whether it was the start, a busy card or the wrong chip.
    if (upscaled) {
      const gpu = upscaleGpuLogged ? '' : (upscaleGpuLogged = true, (await import('./lib/upscale.mjs')).graphicsName());
      log(`${parent.id}: AI-upscaled ${upscaled} frame(s) to ${frames[0].width * 2}x${frames[0].height * 2} in ${Math.round(seconds)} s (${each.join(' + ')} s${upscaleEngineStarted ? '' : '; the first includes the engine start'}${gpu ? '; graphics: ' + gpu : ''}) and saved them for ${where}.`);
      upscaleEngineStarted = true;
    }
  });
  sheetUpscaleChain = job.catch(() => {});
  sheetUpscaleJobs.add(job); job.finally(() => sheetUpscaleJobs.delete(job)).catch(() => {});
  return sheetSaved || {name: `${parent.id} storyboard sheet`, where: 'frames are being saved'};
}

function stopQueue() {
  globalThis.window?.manualAccountSwitch?.cancelPending?.();
  globalThis.window?.geminiAccountSwitch?.cancelPending?.();
  globalThis.window?.vidsAccountSwitch?.cancelPending?.();
  if (!running) return;
  stopRequested = true;
  if (typeof renderQueue === 'function') renderQueue();
  queueStopReason = 'Stopped by user';
  setRunState('stopping\u2026', 'status-warn');
  log('Stop requested; finishing cancellations.');
}

// ---------- UI wiring ----------
function switchTab(panelId, btn) {
  for (const id of ['controlTabPanel', 'builderTabPanel', 'settingsTabPanel', 'repairTabPanel', 'logsTabPanel']) {
    $(id)?.classList.toggle('hidden', id !== panelId);
  }
  document.querySelectorAll('.top-tab').forEach((tab) => tab.setAttribute('aria-selected', String(tab === btn)));
  // Top-level tabs share the document scroll position. Start each destination at its beginning.
  window.scrollTo({top: 0, left: 0, behavior: 'instant'});
}

function wireUi() {
  // Platform tabs (Flow · ChatGPT · Gemini · Grok): a click or arrow key picks one; the hidden select stays the source of truth.
  const platformOptions = Array.from($('platformTabs').querySelectorAll('[data-platform]'));
  const pickPlatform = (button) => {
    if (running || !button) return;
    if ($('platformSelect').value !== button.dataset.platform) {
      $('platformSelect').value = button.dataset.platform;
      $('platformSelect').dispatchEvent(new Event('change'));
    }
    button.focus();
  };
  platformOptions.forEach(button => button.addEventListener('click', () => {
    if (button.dataset.platform === 'vids' && $('platformSelect').value === 'vids') {
      openVidsEngine().catch(reportVidsConnectionError);
    }
    pickPlatform(button);
  }));
  $('platformTabs').addEventListener('keydown', event => {
    const keys = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};
    if (!(event.key in keys) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = Math.max(0, platformOptions.indexOf(document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? platformOptions.length - 1 : (index + keys[event.key] + platformOptions.length) % platformOptions.length;
    pickPlatform(platformOptions[next]);
  });
  $('platformSelect').addEventListener('change',()=>{
    if(running)return;
    if(typeof stopBackgroundMode==='function')stopBackgroundMode('');
    settings.platform=$('platformSelect').value;
    if(settings.platform==='chatgpt'&&!['text-to-image','image-to-image'].includes(settings.mode))settings.mode='text-to-image';
    if(settings.platform==='gemini'&&!GEMINI_PANEL_MODES.includes(settings.mode))settings.mode='text-to-video';
    if(settings.platform==='grok'&&!GROK_PANEL_MODES.includes(settings.mode))settings.mode='text-to-video';
    if(settings.platform==='vids'){
      if(!VIDS_PANEL_MODES.includes(settings.mode))settings.mode='text-to-video';
      openVidsEngine().catch(reportVidsConnectionError);
    }
    if(settings.platform==='higgsfield'){if(!HIGGS_PANEL_MODES.includes(settings.mode))settings.mode='text-to-video';settings.concurrentPrompts=1;settings.chainLastFrame=false;if(typeof ensureHiggsAccess==='function')ensureHiggsAccess().then(ok=>{if(!ok)log('Higgsfield access was not granted. Select Higgsfield again before starting.');else higgsOpenPage().catch(e=>log('Higgsfield page: '+e.message));}).catch(e=>log('Higgsfield permission: '+e.message));}
    if(settings.platform==='muse'){if(!MUSE_PANEL_MODES.includes(settings.mode))settings.mode='text-to-image';settings.concurrentPrompts=1;settings.chainLastFrame=false;if(typeof ensureMuseAccess==='function')ensureMuseAccess().then(ok=>{if(!ok)log('Muse access was not granted. Select Muse again before starting.');else museOpenPage().catch(e=>log('Muse page: '+e.message));}).catch(e=>log('Muse permission: '+e.message));}
    if(settings.platform==='grok'&&typeof ensureGrokAccess==='function')ensureGrokAccess().then(ok=>{if(!ok)log('Grok access was not granted. Pick Grok again and allow the permission before starting.');});
    renderMode();renderPromptModes();persistState().catch(()=>{});
  });
  $('promptCardsDisclosure').addEventListener('toggle',()=>{promptPage=0;renderPromptModes();});
  for (const kind of ['prompt','queue']) {
    for (const [direction,delta] of [['Prev',-1],['Next',1]]) $(kind+direction).addEventListener('click',()=>{
      if(kind==='prompt'){promptPage+=delta;renderPromptModes();}else{queuePage+=delta;renderQueue();}
    });
  }
  $('queueFilter').addEventListener('change',()=>{queuePage=0;renderQueue();});
  $('controlTabBtn').addEventListener('click', (e) => switchTab('controlTabPanel', e.currentTarget));
  $('settingsTabBtn').addEventListener('click', (e) => switchTab('settingsTabPanel', e.currentTarget));
  $('repairTabBtn').addEventListener('click', (e) => switchTab('repairTabPanel', e.currentTarget));
  $('logsTabBtn').addEventListener('click', (e) => switchTab('logsTabPanel', e.currentTarget));

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (running) return;
      settings.mode = btn.dataset.mode;
      renderMode();
      // Higgsfield: open its video or image page at once, in the same tab.
      if (settings.platform === 'higgsfield' && typeof higgsOpenPage === 'function') higgsOpenPage().catch((e) => log('Higgsfield page: ' + e.message));
      if (settings.platform === 'muse' && typeof museOpenPage === 'function') museOpenPage().catch((e) => log('Muse page: ' + e.message));
      // Redraw the image list too: order arrows, sorting and the hint depend on the mode (renderImages also redraws the prompt cards).
      renderImages();
      // Persist at once: a panel reload inside the debounce window must not
      // resurrect the previous mode.
      persistState().catch(() => {});
    });
  });
  for (const id of ['concurrentPrompts', 'imageProcessing', 'flowOutputCount', 'flowParallel', 'downloadSubfolder', 'flowDurationSeconds', 'flowModel', 'flowImageModel', 'autoMatchIngredientImages', 'imageDownload', 'renameOutputs', 'referenceImageNames', 'videoResolution', 'grokImageQuality', 'geminiModel', 'geminiThinking', 'manualSheets', 'sheetUpscale']) {
    $(id).addEventListener('change', () => {
      if (running) { if(id === 'flowParallel') $('flowParallel').checked = settings.flowParallel > 1; if (id === 'manualSheets') $('manualSheets').checked = !!settings.manualSheets; return; }
      collectSettingsFromForm();
      renderMode();
      renderImages();
      schedulePersist();
    });
  }
  for (const id of ['vidsVideoModel', 'vidsAspectRatio', 'vidsResolution', 'vidsDurationSeconds']) {
    $(id)?.addEventListener('change', () => {
      if (running) return;
      collectSettingsFromForm();
      schedulePersist();
    });
  }
  // The page progress window can be switched on or off at any time, also while a queue runs.
  $('miniProgress')?.addEventListener('change', () => {
    settings.miniProgress = $('miniProgress').checked;
    if (!settings.miniProgress && typeof hideMiniProgress === 'function') hideMiniProgress();
    schedulePersist();
  });
  // Generating at 360p changes the download choices (360p or 720p upscaled), so redraw them at once.
  $('videoGenerationResolution').addEventListener('change', () => {
    if (running) return;
    collectSettingsFromForm(); renderMode(); schedulePersist();
  });
  for (const id of ['delayMin', 'delayMax']) {
    $(id).addEventListener('change', () => {
      if (running) return;
      collectSettingsFromForm();
      $('delayMin').value = String(settings.delayMinSeconds);
      $('delayMax').value = String(settings.delayMaxSeconds);
      schedulePersist();
    });
  }
  $('promptText').addEventListener('input', () => {
    sheetPrompts = [];
    applyPromptsToQueue(null, true);
  });
  $('applyPromptsBtn').addEventListener('click', () => applyPromptsToQueue(null));
  $('uploadTxtBtn').addEventListener('click', () => $('txtFileInput').click());
  $('uploadSheetBtn').addEventListener('click', () => $('sheetFileInput').click());
  $('txtFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importTxtFile(file);
    e.target.value = '';
  });
  $('sheetFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importSheetFile(file);
    e.target.value = '';
  });

  const dz = $('dropzone');
  const fileInput = $('imageFileInput');
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add('drag'); });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.remove('drag'); });
  }
  dz.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) await addImageFiles(files);
  });
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) await addImageFiles(files);
    e.target.value = '';
  });
  $('clearImagesBtn').addEventListener('click', () => {
    if (running) return;
    images = [];
    chainedFrame = null;
    renderImages();
    schedulePersist();
    log('Cleared the image library.');
  });
  $('imageOrder').addEventListener('change',()=>{
    if(running)return;
    settings.imageOrder=$('imageOrder').value;renderImages();schedulePersist();
  });

  $('startBtn').addEventListener('click', () => startQueue());
  $('stopBtn').addEventListener('click', stopQueue);
  $('retryErrorsBtn').addEventListener('click', () => {
    let reset = 0;
    for (const item of queue) {
      if (item.vidsRejected) continue;
      if ((item.status === 'error' || item.status === 'skipped') && !item.groupParent) {
        requeueItem(item);
        reset += 1;
      }
    }
    log(`Requeued ${reset} prompt(s).`);
    renderQueue();
    schedulePersist();
  });

  $('saveSettingsBtn').addEventListener('click', () => {
    if (running) return;
    collectSettingsFromForm();
    loadSettingsIntoForm();
    schedulePersist();
    $('saveStatus').textContent = 'saved';
    setTimeout(() => { $('saveStatus').textContent = ''; }, 2000);
    log('Settings saved.');
  });
  $('resetSettingsBtn').addEventListener('click', () => {
    if (running) return;
    settings = { ...DEFAULT_SETTINGS };
    loadSettingsIntoForm();
    schedulePersist();
    log('Settings reset to defaults.');
  });

  $('copyLogBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(logs.join('\n')).catch(() => {});
  });
  $('exportLogBtn').addEventListener('click', () => {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${downloadFolder()}/debug-log.txt`, saveAs: true }).catch(() => {});
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  });
  $('clearLogBtn').addEventListener('click', () => {
    logs = [];
    renderLogs();
    schedulePersist();
  });
}

// ---------- init ----------
function resetPanelSession() {
  stopRequested = true; runToken++; running = false;
  quotaStop = false; quotaSolo = false;
  images = []; queue = []; sheetPrompts = []; logs = []; chainedFrame = null;
  activeRuns.clear(); slotTabs.clear(); outputDir = null; outputDirName = '';
  preloadedProjectImages.clear(); if (typeof flowSavedImages !== 'undefined') flowSavedImages.clear();
  promptPage = 0; queuePage = 0;
  if ($('queueFilter')) $('queueFilter').value = 'all';
  $('promptText').value = ''; $('promptCount').textContent = '0 loaded';
  if ($('projectImportStatus')) $('projectImportStatus').textContent = 'Load scene prompts and their reference images together.';
  document.querySelectorAll('input[type="file"]').forEach(input => { input.value = ''; });
  $('applyStatus').textContent = '';
  setRunState('idle', 'status-warn');
  loadSettingsIntoForm(); renderQueue(); renderLogs();
  persistState().catch(()=>{});
}

(async function init() {
  // A panel closed during a photo upload left Chrome's download bubble hidden; a new panel turns it back on.
  try { chrome.downloads?.setUiOptions?.({enabled: true})?.catch?.(() => {}); } catch {}
  const versionLabel = document.getElementById('versionLabel');
  if (versionLabel) versionLabel.textContent = `v${APP_VERSION}`;
  const versionBadge = document.getElementById('versionBadge');
  if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;
  await loadPersisted();
  wireUi();
  loadSettingsIntoForm();
  renderLogs();
  renderQueue();
  setRunState('idle', 'status-warn');
  $('promptCount').textContent = `${queue.length} loaded`;
  await cleanupOrphanTabs().catch(() => {});
  await beatPanelHeartbeat().catch(() => {});
  setInterval(() => { beatPanelHeartbeat().catch(() => {}); }, PANEL_HEARTBEAT_MS);
  log(`0xtnp Flow Studio v${APP_VERSION} ready. Mode: ${MODES[settings.mode].label}.`);
  chrome.sidePanel?.onClosed?.addListener(async info => {
    const window = await chrome.windows.getCurrent();
    if (info.windowId === window.id) resetPanelSession();
  });
})();

















































// Settings popup shares preferences with the live panel; never interrupts a run.
let studioDeferredSettings=null;
chrome.storage.onChanged.addListener((changes,area)=>{
 if(area!=='local'||!changes.faState?.newValue?.settings)return;
 const incoming=changes.faState.newValue.settings;
 const patch={};for(const key of ['imageDownload','videoResolution','downloadSubfolder'])if(incoming[key]!==undefined&&incoming[key]!==settings[key])patch[key]=incoming[key];
 if(!Object.keys(patch).length)return;
 if(running){studioDeferredSettings={...(studioDeferredSettings||{}),...patch};return}
 Object.assign(settings,patch);loadSettingsIntoForm();
});
setInterval(()=>{if(studioDeferredSettings&&!running){Object.assign(settings,studioDeferredSettings);studioDeferredSettings=null;loadSettingsIntoForm();schedulePersist();}},1000);
