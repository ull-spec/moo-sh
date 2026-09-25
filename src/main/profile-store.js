'use strict';

/*
 * Pure, testable profile persistence layer.
 *
 * Handles world-profile loading, discovery, and per-named-login upsert for
 * the MU / MUSH client. Migrates the OLD single `autoLoginCommand: string`
 * schema to the NEW `logins: [{ name, autoLoginCommand }]` schema in memory
 * on load, and writes new profiles using only the new shape. Also implements
 * real-over-example resolution: a gitignored `<id>.json` wins over the
 * committed `<id>.example.json` template when both exist.
 *
 * Extracted out of src/main/index.js (which requires 'electron' and thus
 * cannot be unit-tested in plain Node) so this logic can be exercised with
 * plain `node test/logins.test.js`. Node built-ins only, no electron import.
 */

const fs = require('fs');
const path = require('path');

const presets = require('./routing-presets');
const routingLegacy = require('./routing-legacy');

// Fields loadProfile derives at runtime and that must never reach disk. Every
// writer below round-trips the WHOLE profile object through JSON.stringify, so
// anything the loader adds for the session's benefit has to be stripped first
// or it gets silently persisted. `__`-prefixed by convention (see __sourceFile).
//
// selfNames is the subtle one, because it isn't `__`-prefixed: it's a REAL
// profile field that the loader sometimes fills in with a GUESS (inferred from
// the login command) when the key is absent. Persisting that guess would be a
// silent one-way door — this loader's contract is that an absent key is
// re-inferred on every load, so it tracks whichever character the user is
// currently logged in as, while any present value (even []) is frozen forever.
// Baking the guess in via an unrelated write (a colour change, an anti-idle
// toggle, a routing reset) would pin a multi-login world to whichever
// character happened to be active at that moment, and reconnecting as a
// different one would silently stop stripping the right name from group-page
// recipient lists — the exact tab-splitting bug selfNames exists to prevent.
// So: an inferred value is dropped on write, and only setSelfNames (which
// clears the marker) ever commits one to disk.
function stripRuntimeFields(profile) {
  delete profile.__sourceFile;
  delete profile.__routingCustomized;
  if (profile.__selfNamesInferred) delete profile.selfNames;
  delete profile.__selfNamesInferred;
  return profile;
}

// Best-effort guess at the character name a login command logs in as, used to
// seed `selfNames` for a profile that has never had one set (see loadProfile).
// MUSH-family login commands are `connect <name> <password>` with the name
// quoted when it contains spaces — `connect "Mary Ann" hunter2` — which is the
// only place this app already knows the user's actual character name.
//
// Deliberately conservative: only the leading connect verb is recognised, and
// only the FIRST token/quoted string after it is taken. Everything after the
// name is the password and is never read, never returned, and never logged.
// Returns [] when nothing can be inferred, which is a normal outcome (a
// profile with no auto-login) and simply leaves selfNames empty.
const CONNECT_RE = /^\s*(?:connect|conn|con|co|cd|ch)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i;
function inferSelfNames(profile) {
  const names = [];
  const seen = new Set();
  for (const login of (profile && profile.logins) || []) {
    const cmd = login && typeof login.autoLoginCommand === 'string' ? login.autoLoginCommand : '';
    const m = CONNECT_RE.exec(cmd);
    if (!m) continue;
    const name = String(m[1] || m[2] || m[3] || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

// Normalize a user-supplied selfNames value (from the Settings GUI or from
// disk) into a deduped array of non-empty trimmed strings. Anything that isn't
// a string or array of strings collapses to [], which is the same as "not set".
function normalizeSelfNames(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const name = String(entry == null ? '' : entry).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Reimplemented rather than imported from src/renderer/shared/color.js: that
// file is a browser ES module and this one is a pure CommonJS Node module
// (see the file banner above), the same reason slugify() below doesn't reach
// into renderer code either. Keep this regex identical to color.js's.
function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function normalizeLogins(profile) {
  let logins = null;

  if (Array.isArray(profile.logins) && profile.logins.length > 0) {
    const cleaned = [];
    for (const entry of profile.logins) {
      if (!entry || typeof entry !== 'object') continue;
      cleaned.push({
        name: String(entry.name || 'Default'),
        autoLoginCommand: typeof entry.autoLoginCommand === 'string' ? entry.autoLoginCommand : '',
      });
    }
    if (cleaned.length > 0) logins = cleaned;
  }

  if (!logins) {
    if (typeof profile.autoLoginCommand === 'string') {
      logins = [{ name: 'Default', autoLoginCommand: profile.autoLoginCommand }];
    } else {
      logins = [{ name: 'Default', autoLoginCommand: '' }];
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const login of logins) {
    if (seen.has(login.name)) continue;
    seen.add(login.name);
    deduped.push(login);
  }

  profile.logins = deduped;
  delete profile.autoLoginCommand;
  return profile;
}

function loadProfile(profilesDir, id) {
  const realFile = path.join(profilesDir, `${id}.json`);
  const exampleFile = path.join(profilesDir, `${id}.example.json`);
  const file = fs.existsSync(realFile) ? realFile : exampleFile;

  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.__sourceFile = file;
  normalizeLogins(parsed);

  // Which routing preset this world uses (the MUSH family, or Evennia).
  // Anything other than the exact stored string 'evennia' normalizes to
  // 'mush', including garbage a hand-edit might have left behind — and when
  // that happens the bad value is dropped from the in-memory profile rather
  // than round-tripped, the same "never persist garbage" discipline the color
  // field below already follows. The key itself is never written here; an
  // absent field stays absent until something actually opts the world into
  // Evennia (see createProfile/setRoutingPreset).
  const preset = routingLegacy.normalizePresetId(parsed.routingPreset);
  if (parsed.routingPreset !== undefined && parsed.routingPreset !== 'mush' && parsed.routingPreset !== 'evennia') {
    delete parsed.routingPreset;
  }

  // Profiles written before the Phase 2 routing feature have no routingRules
  // field at all; default them (in memory only — like normalizeLogins, nothing
  // is written back to disk here) to the world's own preset so page/channel
  // routing works out of the box. An explicit `routingRules: []` is a
  // deliberate per-world opt-out and is respected, so only a genuinely
  // absent/non-array field is defaulted. Deep-cloned so a caller mutating one
  // profile's rules can never corrupt the shared preset module.
  if (!Array.isArray(parsed.routingRules)) {
    parsed.routingRules = routingLegacy.currentRulesClone(preset);
    parsed.routingRulesVersion = routingLegacy.rulesVersion(preset);
  }

  // ...but a profile that already HAS routingRules used to be frozen forever:
  // index.js builds the router from this array, not from routing-presets.js, so
  // every later fix to the preset module (e.g. the 2026-08-01 multi-word-name
  // fix) reached brand-new profiles only and silently missed every existing
  // one. Migrate here instead, in memory, on the same terms as everything else
  // in this loader — nothing is written to disk until some other operation
  // persists the profile anyway.
  //
  // Only rules that are a VERBATIM copy of an older generation of THIS
  // profile's own preset are replaced: those were written by this app
  // (createProfile, or the backfill above), so there is nothing of the user's
  // in them to lose. An evennia profile is only ever compared against evennia
  // history, never against familyRules, so a MUSH-family rule set living on an
  // Evennia world (however it got there) reads as customized rather than
  // being silently overwritten with unrelated defaults. Rules that match no
  // generation of the profile's own preset have been hand-edited and are left
  // exactly as they are — flagged with a runtime-only marker instead, so the
  // Settings window can offer an explicit, user-driven reset (see
  // resetRoutingRules). The version stamp short-circuits the comparison on
  // every subsequent load.
  else if (parsed.routingRulesVersion !== routingLegacy.rulesVersion(preset)) {
    if (routingLegacy.isLegacyStock(parsed.routingRules, preset)) {
      parsed.routingRules = routingLegacy.currentRulesClone(preset);
      parsed.routingRulesVersion = routingLegacy.rulesVersion(preset);
    } else if (routingLegacy.isCurrentStock(parsed.routingRules, preset)) {
      parsed.routingRulesVersion = routingLegacy.rulesVersion(preset);
    }
  }
  parsed.__routingCustomized = routingLegacy.isCustomized(parsed.routingRules, preset);

  // Who "you" are, for the router's group-page self-name stripping: a group
  // page's incoming recipient list includes you, its outgoing echo doesn't, and
  // without dropping your own name the two sides of one conversation key to two
  // different tabs (see router.js's deriveCombinedName). index.js used to fall
  // back to the active LOGIN name, which is literally "Default" on most
  // profiles here and therefore matched nobody. Seed it from the login command
  // instead — that's where the real character name already lives — so the
  // fallback is right out of the box; the Settings window can override it.
  // Absent means "never configured" and is seeded from the login command; an
  // explicit (even empty) value on disk is the user's own choice and is only
  // normalized, never re-seeded — the same absent-vs-explicit distinction
  // routingRules already draws for its `[]` opt-out.
  // __selfNamesInferred marks the value as a guess rather than the user's
  // stated choice. stripRuntimeFields drops a guess before any write, and the
  // Settings window uses it to avoid committing an untouched field.
  if (Array.isArray(parsed.selfNames) || typeof parsed.selfNames === 'string') {
    parsed.selfNames = normalizeSelfNames(parsed.selfNames);
    parsed.__selfNamesInferred = false;
  } else {
    parsed.selfNames = inferSelfNames(parsed);
    parsed.__selfNamesInferred = true;
  }

  // Anti-idle keepalive (see index.js's startAntiIdle) is per-world: one
  // server's idle-timeout policy has nothing to do with another's, and two
  // instances of this client connected to two different profiles must not
  // share a single on/off switch. Opt-in: absent means off, so a profile
  // that predates the toggle (or one the user has never visited Settings
  // for) doesn't silently start sending keepalive traffic.
  if (typeof parsed.antiIdle !== 'boolean') {
    parsed.antiIdle = false;
  }

  // Same non-breaking default as antiIdle above for profiles written before
  // this feature (absent -> null). But this field also doubles as a
  // sanitizer: color flows straight to a renderer that feeds it into a CSS
  // custom property, so a hand-edited or otherwise garbage value on disk must
  // never survive load. isHexColor already rejects null/undefined/non-strings,
  // so no separate typeof guard is needed here.
  if (!isHexColor(parsed.color)) {
    parsed.color = null;
  }

  return parsed;
}

function discoverProfiles(profilesDir) {
  let files;
  try {
    files = fs.readdirSync(profilesDir);
  } catch (err) {
    return [];
  }

  const ids = new Set();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let id = f;
    if (id.endsWith('.example.json')) {
      id = id.slice(0, -'.example.json'.length);
    } else if (id.endsWith('.json')) {
      id = id.slice(0, -'.json'.length);
    }
    ids.add(id);
  }

  const profiles = [];
  for (const id of ids) {
    let p;
    try {
      p = loadProfile(profilesDir, id);
    } catch (err) {
      continue;
    }
    profiles.push({
      id,
      name: p.name || id,
      host: p.host || '',
      port: p.port || 0,
      tls: !!p.tls,
      color: p.color || null,
      logins: p.logins,
      routingPreset: routingLegacy.normalizePresetId(p.routingPreset),
    });
  }

  profiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return profiles;
}

function upsertLogin(logins, name, autoLoginCommand) {
  const finalName = String(name || 'Default');
  const finalCmd = typeof autoLoginCommand === 'string' ? autoLoginCommand : '';

  const existing = logins.find((l) => l.name === finalName);
  if (existing) {
    existing.autoLoginCommand = finalCmd;
  } else {
    logins.push({ name: finalName, autoLoginCommand: finalCmd });
  }
  return logins;
}

function persistLogin(profilesDir, id, name, autoLoginCommand) {
  const merged = loadProfile(profilesDir, id);
  stripRuntimeFields(merged);
  upsertLogin(merged.logins, name, autoLoginCommand);

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Same write-through-to-the-real-file pattern as persistLogin: reads the
// current profile (real file if present, else the .example.json template),
// flips just the antiIdle field, and always writes the REAL `<id>.json` —
// so toggling anti-idle on a profile that only had an example file on disk
// forks it into a real one, same as any other per-profile edit.
function setAntiIdle(profilesDir, id, value) {
  const merged = loadProfile(profilesDir, id);
  stripRuntimeFields(merged);
  merged.antiIdle = !!value;

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Same write-through-to-the-real-file pattern as setAntiIdle, but with no
// coercion: unlike antiIdle's !!value, there is no sensible coercion of a
// malformed color, and a silently-wrong color is worse than no color at all.
// null/undefined both mean "clear it" and persist as null; anything else that
// isn't a valid #rrggbb hex is rejected outright — nothing is written, and the
// profile is returned exactly as it stands on disk. This never throws: every
// caller is an Electron IPC handler, and this codebase's IPC handlers never
// throw, so an invalid value is a silent no-op rather than an error.
function setColor(profilesDir, id, hexOrNull) {
  const merged = loadProfile(profilesDir, id);
  stripRuntimeFields(merged);

  if (hexOrNull === null || hexOrNull === undefined) {
    merged.color = null;
  } else if (isHexColor(hexOrNull)) {
    merged.color = hexOrNull;
  } else {
    return merged;
  }

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Explicit, user-driven reset of a profile's routing rules to the current
// preset — the world's OWN preset (routingPreset, absent meaning 'mush'), not
// necessarily the MUSH family one. Same write-through pattern as
// setAntiIdle/setColor, and deliberately the ONLY way a hand-edited rule set
// is ever replaced — loadProfile's migration refuses to touch those on its
// own (see its comment). Writes just the routingRules + version keys; every
// other field the profile carries (poseLogMarkers, sounds, capture,
// channelAliases, autoConnect, colour, ...) is round-tripped untouched,
// because `merged` is the whole loaded profile.
function resetRoutingRules(profilesDir, id) {
  const merged = loadProfile(profilesDir, id);
  const preset = routingLegacy.normalizePresetId(merged.routingPreset);
  stripRuntimeFields(merged);
  merged.routingRules = routingLegacy.currentRulesClone(preset);
  merged.routingRulesVersion = routingLegacy.rulesVersion(preset);

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Switch a world between the MUSH-family and Evennia routing presets. Same
// write-through pattern as everything else in this section: load, strip the
// runtime-only fields, mutate, write the real file, return the merged result.
// Unlike resetRoutingRules (which restores the CURRENT preset's rules), this
// also changes WHICH preset a world uses, so a hand-edited rule set is always
// replaced here — switching families means the old rules are for the wrong
// server entirely, there is nothing worth preserving. 'evennia' is stored
// explicitly; 'mush' is represented by the key's absence, same as every other
// absent-means-default field in this store, so a plain MUSH-family world's
// file never grows a key it didn't need before this feature existed.
function setRoutingPreset(profilesDir, id, preset) {
  const merged = loadProfile(profilesDir, id);
  const normalized = routingLegacy.normalizePresetId(preset);
  stripRuntimeFields(merged);

  if (normalized === 'evennia') {
    merged.routingPreset = 'evennia';
  } else {
    delete merged.routingPreset;
  }
  merged.routingRules = routingLegacy.currentRulesClone(normalized);
  merged.routingRulesVersion = routingLegacy.rulesVersion(normalized);

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Persist the profile's own name(s) for the router's group-page self-stripping.
// Accepts an array or a comma-separated string (what the Settings text field
// hands over) and normalizes either into a deduped array; an empty result is
// stored as [] rather than deleted, so "I cleared this on purpose" survives a
// reload instead of being re-seeded from the login command by loadProfile.
function setSelfNames(profilesDir, id, value) {
  const merged = loadProfile(profilesDir, id);
  stripRuntimeFields(merged);
  merged.selfNames = normalizeSelfNames(value);

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Turn a human world name into a filesystem/id slug:
// lowercase, non-alphanumeric runs collapsed to single hyphens, ends trimmed.
// "My New MUSH" -> "my-new-mush". Empty/slug-less names fall back to "world".
function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'world';
}

// Create a brand-new world profile file and return the created profile object
// (including its generated id). The id is slugified from `name`, then made
// unique against ALL discovered ids (a `<id>.example.json` counts too) by
// appending -2, -3, ... The file is written with the new logins[] shape so it
// round-trips cleanly through loadProfile/normalizeLogins with no special case.
//
// Seeded with the new world's chosen routingPreset (channels/pages/notices for
// the MUSH family, or Evennia's own set) so a brand-new world gets working tab
// routing immediately, without the user hand-editing profile JSON first — the
// MUSH preset's channel rule matches both the `[Name]` (PennMUSH/TinyMUSH/
// TinyMUX) and `<Name>` (RhostMUSH) tag styles.
function createProfile(profilesDir, { name, host, port, charset, tls, tlsAllowInsecure, color, routingPreset } = {}) {
  const displayName = String(name == null ? '' : name).trim();
  const base = slugify(displayName);
  const preset = routingLegacy.normalizePresetId(routingPreset);

  const taken = new Set(discoverProfiles(profilesDir).map((p) => p.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }

  const profile = {
    id,
    name: displayName || id,
    host: String(host == null ? '' : host),
    port: Number(port) || 0,
    charset: String(charset == null ? '' : charset).trim() || 'utf8',
    tls: !!tls,
    tlsAllowInsecure: !!tlsAllowInsecure,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    channelAliases: {},
    // 'mush' is the default and is represented by the key's absence (same
    // discipline as every other absent-means-default field here), so a plain
    // MUSH-family world's file never grows a key it didn't need before this
    // feature existed — and the pre-existing exact-key-set test for a default
    // new world keeps passing unchanged.
    ...(preset === 'evennia' ? { routingPreset: 'evennia' } : {}),
    routingRules: routingLegacy.currentRulesClone(preset),
    // Stamped so loadProfile's migration can short-circuit on an integer
    // compare instead of re-serializing the whole rule set on every load.
    routingRulesVersion: routingLegacy.rulesVersion(preset),
    // selfNames is deliberately NOT written here. A brand-new world has no
    // login command yet (connect:go persists that immediately afterwards), so
    // there is nothing to infer from at this moment; leaving the key absent
    // lets loadProfile seed it from that command on the very next load, which
    // an explicit `[]` here would permanently suppress.
    antiIdle: false,
    // Absent/invalid color yields null so a brand-new world is never created
    // with a bad color baked in.
    color: isHexColor(color) ? color : null,
  };

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return profile;
}

// Apply a user-chosen world ordering to the alphabetically-sorted list
// discoverProfiles returns, without making discoverProfiles itself order-aware
// — it stays pure and alphabetical, and this is a separate pure function
// (unit-testable on its own) rather than logic folded into the IPC handler.
// Ids in `order` come first in `order`'s sequence (first occurrence of a
// duplicate wins, non-string entries ignored, unmatched ids ignored); any
// profile not mentioned in `order` is appended afterwards in its original
// (alphabetical) relative order, which is how a newly created world shows up
// at the end instead of vanishing. Never mutates either argument.
function orderProfiles(profiles, order) {
  if (!Array.isArray(profiles)) return [];
  if (!Array.isArray(order)) return profiles.slice();

  const byId = new Map(profiles.map((p) => [p && p.id, p]));
  const used = new Set();
  const head = [];

  for (const id of order) {
    if (typeof id !== 'string') continue;
    if (used.has(id)) continue;
    if (!byId.has(id)) continue;
    used.add(id);
    head.push(byId.get(id));
  }

  const tail = profiles.filter((p) => !(p && used.has(p.id)));
  return head.concat(tail);
}

module.exports = {
  normalizeLogins,
  normalizeSelfNames,
  inferSelfNames,
  loadProfile,
  discoverProfiles,
  upsertLogin,
  persistLogin,
  setAntiIdle,
  setColor,
  resetRoutingRules,
  setRoutingPreset,
  setSelfNames,
  slugify,
  createProfile,
  isHexColor,
  orderProfiles,
};
