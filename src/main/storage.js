'use strict';

/*
 * Legacy -> userData profile migration.
 *
 * Once packaged, the app install directory is read-only, so per-world
 * profiles (and captures) must live under app.getPath('userData') instead of
 * the in-repo config/profiles/ used during development. migrateProfiles()
 * performs a one-time, idempotent COPY (never a move) of any existing
 * profiles from the legacy location into the userData location the first
 * time the app runs post-upgrade.
 *
 * Node built-ins only (fs, path) — no electron import, so this is directly
 * unit-testable without a running app.
 *
 * Individual file-copy failures are isolated: if one legacy file fails to
 * copy (e.g. a transient disk/permission issue), the rest of the batch is
 * still attempted rather than aborting the whole migration pass.
 */

const fs = require('fs');
const path = require('path');

function listJsonFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'));
}

// Copies every top-level *.json file from legacyDir into userDataProfilesDir,
// once. If userDataProfilesDir already has any .json file, this is a no-op
// (idempotent — a prior migration, or user-created profiles, are never
// overwritten). Never throws; any failure is swallowed and [] is returned.
function migrateProfiles(legacyDir, userDataProfilesDir) {
  try {
    if (typeof userDataProfilesDir !== 'string' || !userDataProfilesDir) return [];

    if (fs.existsSync(userDataProfilesDir)) {
      const existing = listJsonFiles(userDataProfilesDir);
      if (existing.length > 0) return [];
    }

    if (typeof legacyDir !== 'string' || !legacyDir) return [];
    if (!fs.existsSync(legacyDir)) return [];

    const legacyJson = listJsonFiles(legacyDir);
    if (legacyJson.length === 0) return [];

    fs.mkdirSync(userDataProfilesDir, { recursive: true });

    const copied = [];
    for (const name of legacyJson) {
      try {
        fs.copyFileSync(path.join(legacyDir, name), path.join(userDataProfilesDir, name));
        copied.push(name);
      } catch (err) {
        console.warn('[storage] failed to migrate profile ' + name + ':', err && err.message);
      }
    }
    return copied;
  } catch (e) {
    return [];
  }
}

module.exports = { migrateProfiles };
