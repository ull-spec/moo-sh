// settings.js
// GUI renderer for the Settings window. Talks to main only through the
// preload-exposed `window.mush` surface, same contract as connect.js. ES
// module so it can import the shared pure font/color/sound helpers.
//
// On load, fetches the current settings and initialises the font picker,
// color pickers, and sound toggles/rosters from it. Every control edits a
// LOCAL staged copy only (font/color changes preview live in this window via
// CSS custom properties; nothing is persisted or broadcast to other windows)
// until the Confirm button writes the whole batch. Cancel (or closing the
// window without confirming) simply discards the staged edits by reloading
// from disk — nothing was ever written, so there is nothing to undo
// elsewhere.

import { FONT_OPTIONS, DEFAULT_FONT, isCuratedFont, fontFamilyValue } from '../shared/font.js';
import { COLOR_KEYS, COLOR_VARS, DEFAULT_COLORS, isHexColor } from '../shared/color.js';
import { normalizeSound, addToRoster, isMuted, setMuted } from '../shared/sound.js';

const fontSelectEl = document.getElementById('font-select');
const resetColorsBtn = document.getElementById('btn-reset-colors');
const soundPageEl = document.getElementById('sound-page');
const soundChannelEl = document.getElementById('sound-channel');
const soundActivityEl = document.getElementById('sound-activity');
const soundChannelsListEl = document.getElementById('sound-channels-list');
const soundPagesListEl = document.getElementById('sound-pages-list');
const soundChannelsAddEl = document.getElementById('sound-channels-add');
const soundPagesAddEl = document.getElementById('sound-pages-add');
const confirmBtn = document.getElementById('btn-confirm');
const cancelBtn = document.getElementById('btn-cancel');

// Kept in sync with settings.theme so a font write never clobbers future
// color keys — we always send the COMPLETE theme object.
let themeState = {};

// Kept in sync with settings.sound, same discipline as themeState: every
// write sends the COMPLETE object because main shallow-merges.
let soundState = normalizeSound(null);

function applyFontMono(name) {
  const v = fontFamilyValue(name);
  if (v) document.documentElement.style.setProperty('--font-mono', v);
}

function saveFont(name) {
  themeState = { ...themeState, fontMono: name };
  applyFontMono(name);
}

function applyColors(colors) {
  if (!colors || typeof colors !== 'object') return;
  for (const key of COLOR_KEYS) {
    if (isHexColor(colors[key])) {
      document.documentElement.style.setProperty(COLOR_VARS[key], colors[key]);
    }
  }
}

function saveColor(key, value) {
  if (!isHexColor(value)) return;
  themeState = { ...themeState, colors: { ...(themeState.colors || {}), [key]: value } };
  applyColors({ [key]: value });
}

function resetColors() {
  themeState = { ...themeState, colors: { ...DEFAULT_COLORS } };
  applyColors(DEFAULT_COLORS);
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`color-${key}`);
    if (el) el.value = DEFAULT_COLORS[key];
  }
}

function initColorPickers(colors) {
  for (const key of COLOR_KEYS) {
    const el = document.getElementById(`color-${key}`);
    const val = isHexColor(colors && colors[key]) ? colors[key] : DEFAULT_COLORS[key];
    if (el) el.value = val;
  }
  applyColors(colors);
}

// Populate the <select> from the curated FONT_OPTIONS list (font.js is the
// single source of truth — no options are hardcoded in index.html). Only
// ever built once; re-running on a Cancel-driven reload is harmless since the
// option set never changes at runtime.
function populateFontOptions() {
  if (!fontSelectEl || fontSelectEl.options.length) return;
  for (const { value, label } of FONT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fontSelectEl.appendChild(opt);
  }
}

function initFontPicker(saved) {
  if (!fontSelectEl) return;
  populateFontOptions();
  if (typeof saved === 'string' && saved) {
    // Only curated monospace families are ever selectable. A persisted value
    // that isn't (or is no longer) one of them falls back to the default
    // curated family rather than erroring or reintroducing free text.
    const value = isCuratedFont(saved) ? saved : DEFAULT_FONT;
    fontSelectEl.value = value;
    applyFontMono(value);
  }
  // No saved font: leave the select at its default first option and persist
  // nothing.
}

function renderSoundList(container, names, mutedMap, kind) {
  if (!container) return;
  container.textContent = '';
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'sound-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'sound-row-name';
    nameSpan.textContent = name;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isMuted(mutedMap, name);
    cb.addEventListener('change', () => {
      const muted = !cb.checked;
      if (kind === 'channel') {
        soundState = { ...soundState, channelMuted: setMuted(soundState.channelMuted, name, muted) };
      } else {
        soundState = { ...soundState, pageMuted: setMuted(soundState.pageMuted, name, muted) };
      }
    });

    row.appendChild(nameSpan);
    row.appendChild(cb);
    container.appendChild(row);
  }
}

// Only rebuilds the row containers, never the add-input elements, so a
// re-render (e.g. from onSettingsChanged) never steals focus from a
// half-typed name.
function renderSound() {
  if (soundPageEl) soundPageEl.checked = soundState.page;
  if (soundChannelEl) soundChannelEl.checked = soundState.channel;
  if (soundActivityEl) soundActivityEl.checked = soundState.activity;
  renderSoundList(soundChannelsListEl, soundState.channels, soundState.channelMuted, 'channel');
  renderSoundList(soundPagesListEl, soundState.pages, soundState.pageMuted, 'page');
}

// Strip every locally-previewed CSS custom property (colors + font) off the
// <html> inline style so the stylesheet defaults show through again. Called at
// the top of load() so a Cancel-driven reload is a TRUE revert: applyColors /
// applyFontMono only write keys that are present-and-valid, so a color/font the
// user previewed but never saved to disk would otherwise linger as a stale
// inline override. Clearing first, then re-applying only the on-disk values,
// guarantees unsaved previews go away. Harmless no-op on the initial page load
// (no overrides set yet).
function clearThemePreview() {
  for (const key of COLOR_KEYS) {
    document.documentElement.style.removeProperty(COLOR_VARS[key]);
  }
  document.documentElement.style.removeProperty('--font-mono');
}

async function load() {
  clearThemePreview();
  if (!window.mush || typeof window.mush.getSettings !== 'function') return;
  try {
    const settings = await window.mush.getSettings();
    themeState = (settings && settings.theme) || {};
    initFontPicker(themeState.fontMono);
    initColorPickers(themeState.colors);
    soundState = normalizeSound(settings && settings.sound);
    renderSound();
  } catch (e) {
    // Settings window has no fallback view; leave controls at their defaults.
  }
}

// Cancel discards every staged edit by reloading from disk (clearThemePreview
// inside load() strips any unsaved color/font preview), then closes the window.
// Nothing was ever persisted, so there is nothing to revert anywhere else.
// Closing goes through main because a sandboxed renderer can't close its own
// top-level BrowserWindow. The revert-then-close ordering means that if
// closeSettings is somehow unavailable, the window at least reverts in place.
function cancelChanges() {
  load();
  if (window.mush && typeof window.mush.closeSettings === 'function') {
    window.mush.closeSettings();
  }
}

// Confirm re-fetches the CURRENT on-disk settings (not the copy this window
// loaded when it opened) so a concurrent write elsewhere — e.g. the Feed
// window auto-adding a new page/channel correspondent to the sound roster
// while this window sat open unconfirmed — is never clobbered. Font/colors
// are exclusively written from this window, so they apply directly; sound
// roster membership is union-merged (only ever additive) rather than
// replaced outright, same discipline as the roster-add race fix.
async function confirmChanges() {
  if (!window.mush || typeof window.mush.getSettings !== 'function') return;
  if (typeof window.mush.setSettings !== 'function') return;
  try {
    const fresh = await window.mush.getSettings();
    const freshTheme = (fresh && fresh.theme) || {};
    const newTheme = {
      ...freshTheme,
      fontMono: themeState.fontMono,
      colors: { ...(freshTheme.colors || {}), ...(themeState.colors || {}) },
    };

    const freshSound = normalizeSound(fresh && fresh.sound);
    let channels = freshSound.channels;
    for (const name of soundState.channels) channels = addToRoster(channels, name);
    let pages = freshSound.pages;
    for (const name of soundState.pages) pages = addToRoster(pages, name);
    const newSound = {
      page: soundState.page,
      channel: soundState.channel,
      activity: soundState.activity,
      channels,
      pages,
      channelMuted: { ...soundState.channelMuted },
      pageMuted: { ...soundState.pageMuted },
    };

    const merged = await window.mush.setSettings({ theme: newTheme, sound: newSound });
    themeState = (merged && merged.theme) || newTheme;
    soundState = normalizeSound(merged && merged.sound);
    renderSound();
    // Apply + close, standard OK/Cancel dialog behavior. Both action buttons
    // dismiss the window, so no separate Close button is needed (see the doc
    // note on why Close was consolidated into Cancel/Confirm rather than added).
    if (window.mush && typeof window.mush.closeSettings === 'function') {
      window.mush.closeSettings();
    }
  } catch (e) {
    // Leave the staged (unsaved) edits in place and the window open; the user
    // can retry Confirm.
  }
}

if (fontSelectEl) {
  fontSelectEl.addEventListener('change', () => {
    saveFont(fontSelectEl.value);
  });
}

for (const key of COLOR_KEYS) {
  const el = document.getElementById(`color-${key}`);
  // 'change' fires once when the native picker commits, avoiding a flood of
  // setSettings writes (unlike 'input', which fires continuously while
  // dragging inside the picker).
  if (el) el.addEventListener('change', () => saveColor(key, el.value));
}

if (resetColorsBtn) resetColorsBtn.addEventListener('click', resetColors);

if (soundPageEl) {
  soundPageEl.addEventListener('change', () => {
    soundState = { ...soundState, page: soundPageEl.checked };
  });
}
if (soundChannelEl) {
  soundChannelEl.addEventListener('change', () => {
    soundState = { ...soundState, channel: soundChannelEl.checked };
  });
}
if (soundActivityEl) {
  soundActivityEl.addEventListener('change', () => {
    soundState = { ...soundState, activity: soundActivityEl.checked };
  });
}

if (soundChannelsAddEl) {
  soundChannelsAddEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const name = soundChannelsAddEl.value.trim();
      if (name) {
        soundState = { ...soundState, channels: addToRoster(soundState.channels, name) };
        soundChannelsAddEl.value = '';
        renderSound();
      }
    }
  });
}
if (soundPagesAddEl) {
  soundPagesAddEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const name = soundPagesAddEl.value.trim();
      if (name) {
        soundState = { ...soundState, pages: addToRoster(soundState.pages, name) };
        soundPagesAddEl.value = '';
        renderSound();
      }
    }
  });
}

if (confirmBtn) confirmBtn.addEventListener('click', confirmChanges);
if (cancelBtn) cancelBtn.addEventListener('click', cancelChanges);

// Reflect OTHER windows' writes (currently only the Feed window's atomic
// roster-add for live-discovered correspondents/channels) without clobbering
// this window's own unconfirmed staged edits. Only ever unions in new roster
// names — never touches theme (Settings is its sole writer) or the user's
// in-progress toggle/mute choices.
if (window.mush && typeof window.mush.onSettingsChanged === 'function') {
  window.mush.onSettingsChanged((s) => {
    const incoming = normalizeSound(s && s.sound);
    let channels = soundState.channels;
    for (const name of incoming.channels) channels = addToRoster(channels, name);
    let pages = soundState.pages;
    for (const name of incoming.pages) pages = addToRoster(pages, name);
    // addToRoster ALWAYS allocates a fresh array (even when nothing is added),
    // so a reference check would always be "changed". It only ever appends,
    // never removes/reorders, so a strictly longer array is the true signal
    // that a new name actually arrived — re-render only then.
    if (channels.length !== soundState.channels.length || pages.length !== soundState.pages.length) {
      soundState = { ...soundState, channels, pages };
      renderSound();
    }
  });
}

load();
