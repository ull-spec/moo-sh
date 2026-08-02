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
const antiIdleEl = document.getElementById('anti-idle');
const selfNamesEl = document.getElementById('self-names');
const routingNoticeEl = document.getElementById('routing-notice');
const resetRoutingBtn = document.getElementById('btn-reset-routing');
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

// A plain boolean top-level setting, unlike theme/sound — no partial-object
// merge risk, so it's just sent as-is on Confirm. Matches the checkbox's
// HTML default (unchecked) and the profile-store default (opt-in, off).
let antiIdleState = false;

// Per-profile routing state, staged exactly like everything else in this
// window: the reset button only ARMS the reset, and Confirm is what actually
// performs it. Resetting immediately on click would break the window's
// Cancel-means-nothing-happened contract for the one action here that can't be
// undone by reloading from disk.
let routingState = { customized: false, selfNames: [], inferred: false, loginName: '' };
let routingResetArmed = false;

// Exact text load() put in the self-names field, so Confirm can tell an
// untouched field from an edited one. Confirm must NOT write back an untouched
// value: when it was only inferred from the login command, persisting it
// freezes the guess, and a world with several named logins would keep using
// the wrong character's name after reconnecting as somebody else. Comparing
// text (rather than trusting a 'did this element ever fire input') keeps
// type-then-undo correctly classified as untouched.
let selfNamesLoadedText = '';

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

// The notice appears only for a world whose routing rules were hand-edited:
// stock rules are silently brought up to date by the profile loader, so there
// is nothing for the user to decide about those. Once the reset is armed the
// same element becomes the confirmation of what Confirm will do, which keeps
// this field to a single line of state instead of two competing messages.
// Populating the text field is deliberately NOT part of renderRouting: that
// runs on every reset-button click too, and re-assigning .value there would
// wipe out whatever the user was halfway through typing. Only load() and a
// successful Confirm — the two moments the field's contents are genuinely
// authoritative again — call this.
function renderSelfNamesField() {
  if (!selfNamesEl) return;
  selfNamesEl.value = routingState.selfNames.join(', ');
  selfNamesLoadedText = selfNamesEl.value;
  selfNamesEl.placeholder = routingState.loginName || 'Default';
  // An inferred value looks identical to a stored one in the field, so say
  // which it is on hover. Confirming without editing leaves an inferred value
  // inferred — see confirmChanges.
  selfNamesEl.title = routingState.inferred
    ? 'Guessed from this world’s login command. Edit and Confirm to set it explicitly.'
    : '';
}

function renderRouting() {
  if (resetRoutingBtn) {
    resetRoutingBtn.disabled = routingResetArmed;
    resetRoutingBtn.textContent = routingResetArmed
      ? 'Will reset on Confirm'
      : 'Reset routing rules to defaults';
  }
  if (!routingNoticeEl) return;
  if (routingResetArmed) {
    routingNoticeEl.hidden = false;
    routingNoticeEl.textContent =
      'Routing rules for this world will be replaced with the current defaults when you press Confirm.';
  } else if (routingState.customized) {
    routingNoticeEl.hidden = false;
    routingNoticeEl.textContent =
      "This world's routing rules were customized and predate the multi-word name fix, " +
      'so they were left as they are. Pages from names like "Bob Roe" may land in the ' +
      'main feed instead of their own tab until you reset them.';
  } else {
    routingNoticeEl.hidden = true;
    routingNoticeEl.textContent = '';
  }
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
  if (window.mush && typeof window.mush.getSettings === 'function') {
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
  // Per-profile, not part of the app-wide settings object above — see
  // preload.js/profile-store.js's setAntiIdle.
  if (window.mush && typeof window.mush.getProfileAntiIdle === 'function') {
    try {
      antiIdleState = await window.mush.getProfileAntiIdle();
      if (antiIdleEl) antiIdleEl.checked = antiIdleState;
    } catch (e) {
      // getProfileAntiIdle rejected: fall back to whatever the checkbox
      // shows (its HTML default is unchecked, matching antiIdleState's own
      // module default) so an untouched Confirm click persists the same
      // value the box displays.
      antiIdleState = antiIdleEl ? antiIdleEl.checked : false;
    }
  }
  // Also per-profile. A pending (armed but unconfirmed) reset is dropped here,
  // which is exactly what makes Cancel a true revert for this field too.
  routingResetArmed = false;
  if (window.mush && typeof window.mush.getProfileRouting === 'function') {
    try {
      const routing = await window.mush.getProfileRouting();
      routingState = {
        customized: !!(routing && routing.customized),
        selfNames: Array.isArray(routing && routing.selfNames) ? routing.selfNames : [],
        inferred: !!(routing && routing.selfNamesInferred),
        loginName: (routing && routing.loginName) || '',
      };
    } catch (e) {
      routingState = { customized: false, selfNames: [], inferred: false, loginName: '' };
    }
  }
  renderSelfNamesField();
  renderRouting();
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

    // Per-profile, written through its own channel — see load()'s comment.
    if (window.mush && typeof window.mush.setProfileAntiIdle === 'function') {
      antiIdleState = await window.mush.setProfileAntiIdle(antiIdleState);
      if (antiIdleEl) antiIdleEl.checked = antiIdleState;
    }
    // Per-profile routing, same as anti-idle. Ordered AFTER the reset so a
    // single Confirm that does both ends with the user's names applied on top
    // of the freshly-reset rules.
    if (routingResetArmed && window.mush && typeof window.mush.resetProfileRoutingRules === 'function') {
      await window.mush.resetProfileRoutingRules();
      routingResetArmed = false;
      routingState = { ...routingState, customized: false };
    }
    // Only written when the field was ACTUALLY edited. Confirming an untouched
    // field must be a no-op: the displayed value may be a guess inferred from
    // the login command, and writing it back would freeze it, so a world with
    // several named logins would keep stripping the wrong character's name
    // from group pages after reconnecting as somebody else. Leaving it alone
    // keeps it re-inferred per session, tracking whoever is logged in. Sent as
    // the raw comma-separated text; main normalizes it and returns what it
    // really stored, which is what the field is then re-rendered from.
    const selfNamesEdited = selfNamesEl && selfNamesEl.value !== selfNamesLoadedText;
    if (selfNamesEdited && window.mush && typeof window.mush.setProfileSelfNames === 'function') {
      const stored = await window.mush.setProfileSelfNames(selfNamesEl.value);
      routingState = {
        ...routingState,
        selfNames: Array.isArray(stored) ? stored : [],
        inferred: false,
      };
      renderSelfNamesField();
    }
    renderRouting();

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

if (antiIdleEl) {
  antiIdleEl.addEventListener('change', () => {
    antiIdleState = antiIdleEl.checked;
  });
}

if (resetRoutingBtn) {
  resetRoutingBtn.addEventListener('click', () => {
    routingResetArmed = true;
    renderRouting();
  });
}

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
