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

  // Profiles written before the Phase 2 routing feature have no routingRules
  // field at all; default them (in memory only — like normalizeLogins, nothing
  // is written back to disk here) to the generic family preset so page/channel
  // routing works out of the box. An explicit `routingRules: []` is a
  // deliberate per-world opt-out and is respected, so only a genuinely
  // absent/non-array field is defaulted. Deep-cloned so a caller mutating one
  // profile's rules can never corrupt the shared preset module.
  if (!Array.isArray(parsed.routingRules)) {
    parsed.routingRules = JSON.parse(JSON.stringify(presets.familyRules));
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
      logins: p.logins,
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
  delete merged.__sourceFile;
  upsertLogin(merged.logins, name, autoLoginCommand);

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
// Seeded with the generic family routingRules preset (channels/pages/notices)
// so a brand-new world gets working tab routing immediately, without the user
// hand-editing profile JSON first — the preset's channel rule matches both the
// `[Name]` (PennMUSH/TinyMUSH/TinyMUX) and `<Name>` (RhostMUSH) tag styles.
function createProfile(profilesDir, { name, host, port, charset, tls, tlsAllowInsecure } = {}) {
  const displayName = String(name == null ? '' : name).trim();
  const base = slugify(displayName);

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
    routingRules: presets.familyRules,
  };

  const realFile = path.join(profilesDir, `${id}.json`);
  fs.writeFileSync(realFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return profile;
}

module.exports = {
  normalizeLogins,
  loadProfile,
  discoverProfiles,
  upsertLogin,
  persistLogin,
  slugify,
  createProfile,
};
