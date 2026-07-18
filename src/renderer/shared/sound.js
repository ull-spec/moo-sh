// sound.js — pure helpers + constants for sound-notification settings (page,
// channel, activity pings). No DOM/imports, so it is unit-testable in plain
// Node. The DOM layer is responsible for actually playing audio and for
// window-focus / active-tab gating; this module only decides whether the
// user's settings allow a sound for a given event.
//
// pageMuted / channelMuted are SPARSE maps: they hold ONLY the names that are
// exceptions to the default-on behavior, e.g. { alice: true } means "alice is
// muted", and any name absent from the map is NOT muted. This keeps the
// on-disk settings object small instead of storing `false` for every known
// correspondent/channel.
export const SOUND_EVENTS = ['page', 'channel', 'activity'];

export const DEFAULT_SOUND = {
  page: true,
  channel: true,
  activity: true,
  pages: [],
  channels: [],
  pageMuted: {},
  channelMuted: {},
};

// Coerce any possibly-undefined / partial / malformed input into a complete,
// valid sound object shaped exactly like DEFAULT_SOUND. Never mutates input.
export function normalizeSound(sound) {
  const input = sound && typeof sound === 'object' ? sound : {};
  return {
    page: typeof input.page === 'boolean' ? input.page : true,
    channel: typeof input.channel === 'boolean' ? input.channel : true,
    activity: typeof input.activity === 'boolean' ? input.activity : true,
    pages: normalizeRoster(input.pages),
    channels: normalizeRoster(input.channels),
    pageMuted: normalizeMuted(input.pageMuted),
    channelMuted: normalizeMuted(input.channelMuted),
  };
}

function normalizeRoster(list) {
  const source = Array.isArray(list) ? list : [];
  const seen = new Set();
  const result = [];
  for (const entry of source) {
    if (typeof entry === 'string' && entry !== '' && !seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function normalizeMuted(map) {
  const source = map && typeof map === 'object' ? map : {};
  const result = {};
  for (const key of Object.keys(source)) {
    if (source[key] === true) result[key] = true;
  }
  return result;
}

// Return a new array equal to `roster` with `name` appended if it is a
// non-empty string not already present. Otherwise return a copy unchanged.
// Never mutates the input array.
export function addToRoster(roster, name) {
  const source = Array.isArray(roster) ? roster : [];
  if (typeof name !== 'string' || name === '' || source.includes(name)) {
    return [...source];
  }
  return [...source, name];
}

// Default is NOT muted: only an explicit `true` entry counts as muted.
export function isMuted(mutedMap, name) {
  return !!(mutedMap && typeof mutedMap === 'object' && mutedMap[name] === true);
}

// Return a new sparse mute map with `name` set/unset. Unmuting deletes the
// key entirely rather than storing `false`, keeping the map sparse. Never
// mutates the input.
export function setMuted(mutedMap, name, muted) {
  const source = mutedMap && typeof mutedMap === 'object' ? mutedMap : {};
  const result = { ...source };
  if (typeof name !== 'string' || name === '') return result;
  if (muted) {
    result[name] = true;
  } else {
    delete result[name];
  }
  return result;
}

// The pure decision of whether per-event + per-name settings allow a sound.
// Does NOT account for window focus / active-tab gating — that's the DOM
// layer's job.
export function soundEnabledFor(sound, kind, name) {
  const s = normalizeSound(sound);
  if (kind === 'page') return s.page === true && !isMuted(s.pageMuted, name);
  if (kind === 'channel') return s.channel === true && !isMuted(s.channelMuted, name);
  if (kind === 'activity') return s.activity === true;
  return false;
}
