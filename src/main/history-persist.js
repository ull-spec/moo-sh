'use strict';

/*
 * Pure, testable disk persistence for history-store.js.
 *
 * Mirrors settings-store.js's conventions: Node built-ins only (fs, path), no
 * electron import, and every file path is taken as a function argument so
 * this can be unit-tested in plain Node (`node --test`) without booting
 * Electron.
 *
 * WHY DEBOUNCED, unlike settings-store.js's write-through-per-change policy:
 * settings.json is only rewritten on rare explicit user actions (a few KB).
 * History, in contrast, is appended on effectively every routed page/channel
 * line during active play — a write-through-per-line policy would mean a full
 * JSON stringify+write of up to 200 keys x 500 lines on every single chat
 * message, a real and unnecessary perf cost this app doesn't currently pay
 * anywhere else. A short trailing debounce coalesces a burst of traffic into
 * one write while keeping the on-disk copy within ~2s of current.
 *
 * PERSONAL / LOCAL-ONLY DATA: this module writes real page/channel chat
 * content — the same sensitivity tier as the connection profile JSON in
 * config/profiles/*.json. It must never be committed, published, or synced
 * anywhere public. See the "PERSONAL / LOCAL-ONLY DATA" banner in .gitignore.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 2000;

// Read + JSON.parse the array-of-pairs snapshot at filePath. Never throws:
// a missing file, unreadable file, invalid JSON, or a parsed value that
// isn't an array all fall back to [] (the shape restoreProfile() expects,
// and also a safe "nothing to restore" default).
function loadHistorySnapshot(filePath) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

// Write `pairs` to filePath, creating parent directories as needed. This CAN
// throw (a caller-facing low-level primitive, like settings-store.js's
// saveSettings) — createHistoryPersistence below is the layer that catches.
function saveHistorySnapshotSync(filePath, pairs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(pairs, null, 2) + '\n', 'utf8');
}

// Wires a history-store instance to a single on-disk snapshot file for one
// profileId. `store` must expose serializeProfile(profileId) and
// restoreProfile(profileId, pairs) (see history-store.js).
function createHistoryPersistence({ filePath, store, profileId, debounceMs = DEFAULT_DEBOUNCE_MS, onError }) {
  let timer = null;

  // Load whatever snapshot exists on disk into the store. Never throws (both
  // callees already don't throw). Call once, before any traffic/record()s for
  // this profileId — see restoreProfile()'s "replaces, doesn't merge" contract.
  function load() {
    const snapshot = loadHistorySnapshot(filePath);
    store.restoreProfile(profileId, snapshot);
  }

  // Synchronously write the store's CURRENT contents for profileId to disk
  // right now, cancelling any pending debounced flush (its job is already
  // done by this call). Never throws: disk errors go to onError if provided,
  // otherwise are swallowed (mirrors capture-log.js's "never let a disk error
  // propagate" discipline).
  function flushNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      saveHistorySnapshotSync(filePath, store.serializeProfile(profileId));
    } catch (err) {
      if (typeof onError === 'function') onError(err);
    }
  }

  // Schedule a trailing debounced flush. If one is already pending, this call
  // is a no-op — the pending timer's eventual firing already covers it, which
  // is what makes this a coalescing trailing debounce rather than a leading
  // one (a burst of N calls produces exactly one write, not N).
  //
  // NOTE: this alone does NOT guarantee a write before process exit. The
  // timer is .unref()'d (where supported) so it can never by itself keep the
  // Node process alive — that's defense-in-depth only. The real
  // shutdown-safety net is that callers MUST call flushNow() explicitly
  // before quitting (see index.js's window-all-closed handler).
  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  return { load, scheduleFlush, flushNow };
}

module.exports = {
  loadHistorySnapshot,
  saveHistorySnapshotSync,
  createHistoryPersistence,
  DEFAULT_DEBOUNCE_MS,
};
