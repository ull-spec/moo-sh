// feed.js
// Wires the preload-exposed `window.mush` API to the shared line-view
// renderer for the feed window. Display-only: no networking here, all of
// that lives in the main process behind window.mush.

import { createLineView } from '../shared/line-view.js';
import { createTabbedPanel } from '../shared/tabbed-panel.js';
import { makeResizer } from '../shared/resizer.js';
import { fontFamilyValue } from '../shared/font.js';
import { COLOR_KEYS, COLOR_VARS, isHexColor } from '../shared/color.js';
import { normalizeSound, soundEnabledFor } from '../shared/sound.js';
import { createInputHistory } from '../shared/input-history.js';

const scrollbackEl = document.getElementById('scrollback');
const cmdlogEl = document.getElementById('cmdlog');
const cmdlineEl = document.getElementById('cmdline');
const inputFormEl = document.getElementById('inputform');
const statusbarEl = document.getElementById('statusbar');
const soundSlotEl = document.getElementById('sound-slot');

// Inline image previews are opt-in per line-view. The main scrollback and the
// Pages/Channels tabbed panels (tabbed-panel.js, below) all get them; only
// the #cmdlog echo view (your own typed input) omits the flag and renders
// image URLs as plain clickable links, since there's nothing to preview there.
const view = createLineView(scrollbackEl, { images: true });

// Separate, capped view echoing only the user's own outgoing input, shown in
// the small #cmdlog pane above the input box — distinct from server output.
const cmdlogView = cmdlogEl ? createLineView(cmdlogEl, { maxLines: 200 }) : null;

// Right-column tabbed panels: one tab per page correspondent, one per channel.
// Main routes PAGE-role lines to pages:line and CHANNEL-role lines to
// channel:line, each carrying { key, name, text }.
const pagesStripEl = document.getElementById('pages-tabs');
const pagesPanel =
  pagesStripEl
    ? createTabbedPanel({
        stripEl: pagesStripEl,
        bodyEl: document.getElementById('pages-body'),
        emptyEl: document.getElementById('pages-empty'),
        maxLines: 1000,
        images: true,
        hydrate: (window.mush && typeof window.mush.getHistory === 'function')
          ? (key) => window.mush.getHistory('page', key)
          : undefined,
      })
    : null;
const channelsStripEl = document.getElementById('channels-tabs');
const channelsPanel =
  channelsStripEl
    ? createTabbedPanel({
        stripEl: channelsStripEl,
        bodyEl: document.getElementById('channels-body'),
        emptyEl: document.getElementById('channels-empty'),
        maxLines: 1000,
        images: true,
        hydrate: (window.mush && typeof window.mush.getHistory === 'function')
          ? (key) => window.mush.getHistory('channel', key)
          : undefined,
      })
    : null;

// --- Resizable layout -----------------------------------------------------
const mainEl = document.getElementById('main');
const rightColEl = document.getElementById('right-col');
const pagesPanelEl = document.getElementById('pages-panel');
const colGutterEl = document.getElementById('col-gutter');
const panelGutterEl = document.getElementById('panel-gutter');

const COL_MIN = 240;      // px, min width of the Pages/Channels column
const PANEL_MIN = 80;     // px, min height of the Pages panel
const FEED_RESERVE = 320; // px, keep at least this much for the feed column
const PANEL_RESERVE = 120;// px, keep at least this much for the Channels panel

const layoutState = {}; // { rightColWidth?, pagesPanelHeight?, cmdlogHeight? }
let layoutLoaded = false;

function sendLayout() {
  if (!layoutLoaded) return;                       // never persist during initial apply
  if (window.mush && typeof window.mush.setSettings === 'function') {
    // Always send the COMPLETE layout object (settings:set shallow-merges the
    // patch, replacing the whole `layout` key). Undefined keys are dropped by
    // JSON.stringify, so unset dimensions stay unset on disk.
    window.mush.setSettings({ layout: { ...layoutState } });
  }
}

const colResizer = makeResizer({
  gutterEl: colGutterEl, axis: 'x', direction: -1, // drag left => sidebar grows
  getSize: () => rightColEl.getBoundingClientRect().width,
  setSize: (px) => { rightColEl.style.flex = `0 0 ${px}px`; },
  min: COL_MIN,
  max: () => mainEl.clientWidth - FEED_RESERVE,
  onCommit: (px) => { layoutState.rightColWidth = Math.round(px); sendLayout(); },
});

const panelResizer = makeResizer({
  gutterEl: panelGutterEl, axis: 'y', direction: 1, // drag down => pages panel grows
  getSize: () => pagesPanelEl.getBoundingClientRect().height,
  setSize: (px) => { pagesPanelEl.style.flex = `0 0 ${px}px`; },
  min: PANEL_MIN,
  max: () => rightColEl.clientHeight - PANEL_RESERVE,
  onCommit: (px) => { layoutState.pagesPanelHeight = Math.round(px); sendLayout(); },
});

// #cmdlog keeps its native CSS resize:vertical handle; we only PERSIST its
// height (debounced) via a ResizeObserver, so there is no duplicated drag code.
const CMDLOG_DEBOUNCE_MS = 400;
let cmdlogTimer = null;
if (cmdlogEl && typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => {
    if (!layoutLoaded) return;
    const h = Math.round(cmdlogEl.offsetHeight);
    if (layoutState.cmdlogHeight === h) return;    // no real change (e.g. the initial apply)
    layoutState.cmdlogHeight = h;
    clearTimeout(cmdlogTimer);
    cmdlogTimer = setTimeout(sendLayout, CMDLOG_DEBOUNCE_MS);
  });
  ro.observe(cmdlogEl);
}

function applyFontMono(name) {
  const v = fontFamilyValue(name);
  if (v) document.documentElement.style.setProperty('--font-mono', v);
}

function applyColors(colors) {
  if (!colors || typeof colors !== 'object') return;
  for (const key of COLOR_KEYS) {
    if (isHexColor(colors[key])) {
      document.documentElement.style.setProperty(COLOR_VARS[key], colors[key]);
    }
  }
}

function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  if (typeof theme.fontMono === 'string') applyFontMono(theme.fontMono);
  applyColors(theme.colors);
}

// --- Sound notifications ---------------------------------------------------
// Live mirror of the persisted sound settings; starts at defaults until the
// initial getSettings() roundtrip resolves, then stays in sync via
// onSettingsChanged (kept live so toggles/mutes made in the Settings window
// take effect here without a reload).
let soundState = normalizeSound(null);

const SOUND_SRC = {
  page: '../assets/sounds/page.mp3',
  channel: '../assets/sounds/channel.wav',
  activity: '../assets/sounds/channel.wav', // activity intentionally reuses the channel wav
};
let lastSoundSrc = null;

// Reuse the single #sound-slot element (never create per-event audio
// elements — that produced the ghost overlapping-stream bug). Only reset
// currentTime when replaying the SAME file back-to-back; otherwise swap src.
function playSound(kind) {
  const src = SOUND_SRC[kind];
  if (!soundSlotEl || !src) return;
  if (lastSoundSrc === src) {
    soundSlotEl.currentTime = 0;
  } else {
    soundSlotEl.src = src;
    lastSoundSrc = src;
  }
  const p = soundSlotEl.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

// Record a newly-seen page/channel name into the roster so it appears in
// Settings with a default-ON toggle. `kind` is 'page' or 'channel'.
//
// Deliberately NOT a local-cache read-modify-write of the whole `sound`
// object (unlike settings.js's toggles) — this fires on server-traffic
// timing the user doesn't control, and racing it against a full-object write
// from the Settings window could silently clobber a mute the user just set.
// appendSoundRoster does an atomic disk-fresh append in main instead; the
// local soundState mirror catches up via the settings:changed broadcast that
// follows, same as any other cross-window settings change.
function noteName(kind, name) {
  if (typeof name !== 'string' || name === '') return;
  const rosterKey = kind === 'page' ? 'pages' : 'channels';
  if (soundState[rosterKey].includes(name)) return;
  if (window.mush && typeof window.mush.appendSoundRoster === 'function') {
    window.mush.appendSoundRoster(kind, name);
  }
}

// Decide whether to play a sound for a page/channel line, and fire it.
// Playback is suppressed when the user is already looking at the content:
// the window is OS-focused AND the line landed in the currently-active tab.
// Callers MUST call panel.appendLine BEFORE this, because appendLine may
// activate a brand-new tab — if it just became active while the window is
// focused, we correctly stay silent.
function maybePlayTab(kind, name, panel, key) {
  if (!soundEnabledFor(soundState, kind, name)) return;
  const looking = document.hasFocus() && panel && panel.isActive(key);
  if (looking) return;
  playSound(kind);
}

// Activity fires per feed LINE, not per discrete event like page/channel, so a
// busy feed while the window is unfocused would otherwise retrigger the clip
// on every line. Cooldown limits it to once per ACTIVITY_COOLDOWN_MS.
const ACTIVITY_COOLDOWN_MS = 4000;
let lastActivitySoundAt = 0;
function maybePlayActivity() {
  if (!soundEnabledFor(soundState, 'activity')) return;
  if (document.hasFocus()) return;
  const now = Date.now();
  if (now - lastActivitySoundAt < ACTIVITY_COOLDOWN_MS) return;
  lastActivitySoundAt = now;
  playSound('activity');
}

function revealLayout() { document.body.classList.add('layout-ready'); }

function applySavedLayout(layout) {
  if (!layout || typeof layout !== 'object') return;
  if (Number.isFinite(layout.rightColWidth) && colResizer) {
    layoutState.rightColWidth = colResizer.applySize(layout.rightColWidth);
  }
  if (Number.isFinite(layout.pagesPanelHeight) && panelResizer) {
    layoutState.pagesPanelHeight = panelResizer.applySize(layout.pagesPanelHeight);
  }
  if (Number.isFinite(layout.cmdlogHeight) && cmdlogEl) {
    cmdlogEl.style.height = `${Math.round(layout.cmdlogHeight)}px`;
    layoutState.cmdlogHeight = Math.round(layout.cmdlogHeight);
  }
}

if (window.mush && typeof window.mush.getSettings === 'function') {
  window.mush.getSettings()
    .then((s) => {
      applySavedLayout(s && s.layout);
      applyTheme(s && s.theme);
      soundState = normalizeSound(s && s.sound);
    })
    .catch(() => {})
    .finally(() => { layoutLoaded = true; revealLayout(); });
} else {
  layoutLoaded = true;
  revealLayout();
}
// Fallback: never leave #main hidden if the settings roundtrip stalls.
setTimeout(() => { layoutLoaded = true; revealLayout(); }, 800);

// Readline-style command history (see ../shared/input-history.js): a working
// buffer is saved into the CURRENT slot on every Up/Down, not just on the
// initial transition into history mode, so text typed mid-browse is never
// silently discarded.
const history = createInputHistory(200);

// #cmdline is a <textarea> (see index.html) that grows with its content via
// CSS `field-sizing: content`. This is the JS fallback for browsers/engines
// that don't support field-sizing yet: recompute an explicit height from
// scrollHeight, capped at the same max-height the CSS declares.
function autosizeCmdline() {
  if (!cmdlineEl) return;
  const maxPx = parseFloat(getComputedStyle(cmdlineEl).maxHeight) || Infinity;
  cmdlineEl.style.height = 'auto';
  cmdlineEl.style.height = `${Math.min(cmdlineEl.scrollHeight, maxPx)}px`;
}

function submitCurrentInput() {
  const value = cmdlineEl.value;

  if (window.mush && typeof window.mush.sendInput === 'function') {
    window.mush.sendInput(value);
  }

  if (value.length > 0 && cmdlogView) {
    cmdlogView.appendRaw(value);
  }

  history.submit(value);
  cmdlineEl.value = '';
  cmdlineEl.focus();
  autosizeCmdline();
}

if (inputFormEl) {
  inputFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCurrentInput();
  });
}

if (cmdlineEl) {
  cmdlineEl.addEventListener('input', autosizeCmdline);

  cmdlineEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitCurrentInput();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    // The textarea may be wrapped to multiple visual rows (see item 2). When
    // it's a single row, Up/Down always drive history like a classic <input>.
    // When it's wrapped, Up/Down should move the caret between wrapped rows
    // UNLESS the caret is already at the very start (Up) or very end (Down)
    // of the text, in which case they drive history instead.
    const cs = getComputedStyle(cmdlineEl);
    const lh = parseFloat(cs.lineHeight) || 18;
    const rows = Math.round(
      (cmdlineEl.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh
    );

    let drive;
    if (rows <= 1) {
      drive = true;
    } else if (event.key === 'ArrowUp') {
      drive = cmdlineEl.selectionStart === 0;
    } else {
      drive = cmdlineEl.selectionStart === cmdlineEl.value.length;
    }
    if (!drive) return; // let the caret move between wrapped rows

    event.preventDefault();
    const result =
      event.key === 'ArrowUp' ? history.up(cmdlineEl.value) : history.down(cmdlineEl.value);
    cmdlineEl.value = result;
    autosizeCmdline();
    // Move caret to end.
    requestAnimationFrame(() => {
      cmdlineEl.selectionStart = cmdlineEl.selectionEnd = cmdlineEl.value.length;
    });
  });
}

if (window.mush) {
  window.mush.onLine((text) => {
    view.appendLine(text);
    maybePlayActivity();
  });
  window.mush.onSystem((text) => view.appendRaw(text));
  window.mush.onClear(() => view.clear());

  if (pagesPanel && typeof window.mush.onPageLine === 'function') {
    window.mush.onPageLine((msg) => {
      if (!msg) return;
      noteName('page', msg.name);
      pagesPanel.appendLine(msg.key, msg.name, msg.text, msg.seq, msg.ts);
      if (msg.notify === 'page') maybePlayTab('page', msg.name, pagesPanel, msg.key);
    });
  }
  if (channelsPanel && typeof window.mush.onChannelLine === 'function') {
    window.mush.onChannelLine((msg) => {
      if (!msg) return;
      noteName('channel', msg.name);
      channelsPanel.appendLine(msg.key, msg.name, msg.text, msg.seq, msg.ts);
      if (msg.notify === 'channel') maybePlayTab('channel', msg.name, channelsPanel, msg.key);
    });
  }
  if (typeof window.mush.onSettingsChanged === 'function') {
    window.mush.onSettingsChanged((s) => {
      applyTheme(s && s.theme);
      soundState = normalizeSound(s && s.sound);
    });
  }

  window.mush.onInit((info) => {
    const name = (info && info.profileName) || 'MOO-SH';
    if (statusbarEl) {
      statusbarEl.textContent = name;
    }
    document.title = `MOO-SH — ${name}`;
  });

  window.mush.ready();
}

// When the whole window regains OS focus, clear the unread marker on
// whichever tab is currently active in each panel — the user is now looking
// at it. Tabs that aren't active keep their marker.
window.addEventListener('focus', () => {
  if (pagesPanel) pagesPanel.notifyFocused();
  if (channelsPanel) channelsPanel.notifyFocused();
});

// --- Find in page (Ctrl+F) --------------------------------------------------
// Electron doesn't ship a find-bar UI (unlike a browser's own chrome) — this
// wires a minimal one to the main-process-only webContents.findInPage API via
// the find:query/find:stop/find:result IPC (see preload.js). No per-pane
// scoping: inactive Pages/Channels tabs are `display:none` (tab-view.active
// in feed.css) and Chromium's find-in-page skips hidden content, so a plain
// whole-window search already matches only what's visible.
const findBarEl = document.getElementById('find-bar');
const findInputEl = document.getElementById('find-input');
const findCountEl = document.getElementById('find-count');
const findPrevEl = document.getElementById('find-prev');
const findNextEl = document.getElementById('find-next');
const findCloseEl = document.getElementById('find-close');

const FIND_DEBOUNCE_MS = 150;
let findDebounceTimer = null;

function showFindBar() {
  if (!findBarEl || !findInputEl) return;
  findBarEl.hidden = false;
  findInputEl.focus();
  findInputEl.select();
}

function hideFindBar() {
  if (!findBarEl || findBarEl.hidden) return;
  findBarEl.hidden = true;
  if (findCountEl) findCountEl.textContent = '';
  if (window.mush && typeof window.mush.stopFind === 'function') {
    window.mush.stopFind('clearSelection');
  }
  if (cmdlineEl) cmdlineEl.focus();
}

function runFind(forward, findNext) {
  if (!findInputEl || !window.mush || typeof window.mush.findInPage !== 'function') return;
  const text = findInputEl.value;
  if (text === '') {
    if (typeof window.mush.stopFind === 'function') window.mush.stopFind('clearSelection');
    if (findCountEl) findCountEl.textContent = '';
    return;
  }
  window.mush.findInPage(text, { forward, findNext });
}

if (findInputEl) {
  findInputEl.addEventListener('input', () => {
    clearTimeout(findDebounceTimer);
    findDebounceTimer = setTimeout(() => runFind(true, false), FIND_DEBOUNCE_MS);
  });
  findInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFind(!event.shiftKey, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideFindBar();
    }
  });
}
if (findPrevEl) findPrevEl.addEventListener('click', () => runFind(false, true));
if (findNextEl) findNextEl.addEventListener('click', () => runFind(true, true));
if (findCloseEl) findCloseEl.addEventListener('click', hideFindBar);

window.addEventListener('keydown', (event) => {
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && key === 'f') {
    event.preventDefault();
    showFindBar();
  } else if (event.key === 'Escape' && findBarEl && !findBarEl.hidden) {
    hideFindBar();
  }
});

if (window.mush && typeof window.mush.onFindResult === 'function') {
  window.mush.onFindResult((result) => {
    if (!result || !findCountEl || !result.finalUpdate) return;
    const matches = result.matches || 0;
    const ordinal = result.activeMatchOrdinal || 0;
    findCountEl.textContent = matches === 0 ? 'No results' : `${ordinal} of ${matches}`;
  });
}
