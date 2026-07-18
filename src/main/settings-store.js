'use strict';

/*
 * Pure, testable settings persistence layer.
 *
 * Handles load/save/update of the client's app-wide settings.json. Mirrors
 * profile-store.js's conventions: Node built-ins only, no electron import, and
 * the file path is taken as a function argument so this can be unit-tested in
 * plain Node (`node --test`) without booting Electron.
 *
 * This is infrastructure only — DEFAULTS is deliberately minimal.
 * `layout` holds persisted feed-window panel sizes (right column width,
 * pages panel height, cmdlog height). `theme` holds font/color settings
 * (currently `fontMono`, the chosen monospace font name). `sound` holds the
 * three global sound toggles page/channel/activity, the known-name rosters
 * `pages`/`channels`, and the sparse per-name mute maps `pageMuted`/`channelMuted`.
 */

const fs = require('fs');

// Caps for appendSoundRosterEntry: a hostile server can fabricate an
// unbounded number of distinct page/channel names (or absurdly long ones) to
// force unbounded roster growth and a full settings.json read+parse+
// stringify+write on every single one — on the main thread, which also owns
// the socket. Both caps make new entries past the limit a silent no-op
// (no disk write) rather than growing forever.
const MAX_NAME_LEN = 200;
const MAX_ROSTER_SIZE = 200;

const DEFAULTS = {
  schemaVersion: 1,
  layout: {},
  theme: {},
  // Mirrors the DEFAULT_SOUND shape in src/renderer/shared/sound.js. Exactly
  // like `theme`, callers must always send the COMPLETE `sound` object in a
  // patch (updateSettings does a shallow top-level merge), or sibling fields
  // are lost.
  sound: {
    page: true,
    channel: true,
    activity: true,
    pages: [],
    channels: [],
    pageMuted: {},
    channelMuted: {},
  },
};

function loadSettings(filePath) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...parsed };
}

function saveSettings(filePath, settings) {
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return settings;
}

function updateSettings(filePath, patch) {
  const current = loadSettings(filePath);
  const safePatch = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...current, ...safePatch };
  saveSettings(filePath, merged);
  return merged;
}

// Atomically append `name` to the sound.pages or sound.channels roster,
// reading fresh from disk rather than trusting a renderer's cached copy.
//
// This exists because two windows (Feed, Settings) can both write the
// top-level `sound` key, and updateSettings()'s shallow merge means whichever
// full-object write lands last wins outright — a stale-cache roster-add from
// Feed (driven by server traffic, so its timing is out of the user's control)
// could silently clobber a mute toggle the user just made in Settings, or vice
// versa. Feed calls this instead of doing its own read-modify-write of the
// whole `sound` object, so Settings remains the only writer of full `sound`
// patches and the cross-window race is eliminated. `fs.*Sync` calls below have
// no `await` between them, so this read-modify-write is atomic with respect to
// Node's single-threaded event loop — no other IPC handler can interleave.
function appendSoundRosterEntry(filePath, kind, name) {
  const current = loadSettings(filePath);
  if (typeof name !== 'string' || name === '') return current;
  if (name.length > MAX_NAME_LEN) return current;
  const rosterKey = kind === 'page' ? 'pages' : kind === 'channel' ? 'channels' : null;
  if (!rosterKey) return current;

  const sound = current.sound && typeof current.sound === 'object' ? current.sound : {};
  const roster = Array.isArray(sound[rosterKey]) ? sound[rosterKey] : [];
  if (roster.includes(name)) return current;
  if (roster.length >= MAX_ROSTER_SIZE) return current;

  const merged = {
    ...current,
    sound: { ...DEFAULTS.sound, ...sound, [rosterKey]: [...roster, name] },
  };
  saveSettings(filePath, merged);
  return merged;
}

module.exports = { DEFAULTS, loadSettings, saveSettings, updateSettings, appendSoundRosterEntry };
