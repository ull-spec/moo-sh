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
 * still attempted rather than aborting the whole migration pass — and,
 * since the "already migrated" check is per-filename rather than
 * per-directory, a failed file is retried on the next launch instead of
 * being permanently stranded just because its siblings made it across.
 */

const fs = require('fs');
const path = require('path');

function listJsonFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'));
}

// Copies every top-level *.json file from legacyDir into userDataProfilesDir
// whose name isn't already present there. Per-filename (not per-directory)
// idempotency: a name already in userDataProfilesDir — whether from a prior
// migration or a user-created profile — is never overwritten, but that does
// not block *other* legacy names from being copied, so a partially-failed
// migration keeps retrying just the names that never made it across on
// every subsequent launch. Never throws; any failure is swallowed and []
// is returned.
function migrateProfiles(legacyDir, userDataProfilesDir) {
  try {
    if (typeof userDataProfilesDir !== 'string' || !userDataProfilesDir) return [];
    if (typeof legacyDir !== 'string' || !legacyDir) return [];
    if (!fs.existsSync(legacyDir)) return [];

    const legacyJson = listJsonFiles(legacyDir);
    if (legacyJson.length === 0) return [];

    const existing = fs.existsSync(userDataProfilesDir)
      ? new Set(listJsonFiles(userDataProfilesDir))
      : new Set();

    fs.mkdirSync(userDataProfilesDir, { recursive: true });

    const copied = [];
    for (const name of legacyJson) {
      if (existing.has(name)) continue;
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
