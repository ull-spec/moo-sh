'use strict';

// In-memory, session-scoped per-key scrollback history. Keyed by
// (profileId, key); `key` is an opaque caller-composed string. Entries are
// { seq, text } where seq is a store-wide monotonically increasing integer
// used by the renderer to dedupe during the async hydration round-trip.
// Capped per key (oldest evicted first). Also capped per profile on the
// number of distinct KEYS (oldest-touched evicted first, LRU-by-touch), so a
// hostile server can't force unbounded Map growth by fabricating an
// unbounded number of distinct channel/page names. Purpose-built and
// independent of capture-log.js: history is always-on and never touches
// disk, whereas the capture log is opt-in forensic output.
function createHistoryStore({ maxLines = 500, maxKeys = 200 } = {}) {
  // Map<profileId, Map<key, Array<{seq,text}>>>
  // Each inner Map's iteration order doubles as an LRU-by-touch order: a
  // record() on an existing key deletes and re-inserts it so it moves to the
  // most-recently-used (end) position; the least-recently-used key is
  // therefore always the first one yielded by the Map's iterator.
  const byProfile = new Map();
  let seqCounter = 0;

  // Append `text` under (profileId, key); returns its assigned seq (or null
  // if profileId/key is nullish). `ts` (epoch ms) is caller-supplied: omit it
  // to auto-stamp Date.now() (the common case), or pass `null` explicitly to
  // record a line with NO timestamp (e.g. a page's synthetic speaker divider,
  // which is client chrome, not a message) — that opt-out survives into
  // serializeProfile()/restoreProfile() same as any other stored ts.
  function record(profileId, key, text, ts) {
    if (profileId == null || key == null) return null;
    let keys = byProfile.get(profileId);
    if (!keys) { keys = new Map(); byProfile.set(profileId, keys); }
    let arr = keys.get(key);
    if (!arr) {
      if (keys.size >= maxKeys) keys.delete(keys.keys().next().value);
      arr = [];
      keys.set(key, arr);
    } else {
      // Touch: move this key to the most-recently-used end.
      keys.delete(key);
      keys.set(key, arr);
    }
    const seq = ++seqCounter;
    const stamped = ts === undefined ? Date.now() : (Number.isFinite(ts) ? ts : null);
    arr.push({ seq, text: String(text == null ? '' : text), ts: stamped });
    if (arr.length > maxLines) arr.splice(0, arr.length - maxLines);
    return seq;
  }

  // Return a shallow COPY of the {seq,text} array for (profileId, key), oldest
  // first; [] if none. Copy so callers can't mutate the store's internal array.
  function get(profileId, key) {
    const keys = byProfile.get(profileId);
    if (!keys) return [];
    const arr = keys.get(key);
    return arr ? arr.slice() : [];
  }

  // clear(profileId) drops one profile; clear() drops everything.
  function clear(profileId) {
    if (profileId === undefined) byProfile.clear();
    else byProfile.delete(profileId);
  }

  // Snapshot one profile's history as an array of [key, entries] pairs, in the
  // live Map's iteration order (LRU-by-touch, oldest-touched first). Deliberately
  // NOT a plain object: object keys that look like array indices (e.g. a channel
  // literally named "123") get silently reordered by V8 regardless of insertion
  // order, which would corrupt the LRU order this store depends on. An array of
  // pairs sidesteps that and round-trips through JSON.stringify/parse exactly.
  // Returns a copy (fresh arrays/objects) so callers can't mutate the store's
  // internals; [] if profileId has no entry.
  function serializeProfile(profileId) {
    const keys = byProfile.get(profileId);
    if (!keys) return [];
    return Array.from(keys.entries()).map(([key, arr]) => [
      key,
      arr.map((e) => ({ seq: e.seq, text: e.text, ts: e.ts })),
    ]);
  }

  // Populate this store for profileId from `pairs` (the shape serializeProfile
  // produces), treating it as untrusted/possibly hand-edited disk data: never
  // throws, silently skips anything malformed.
  //
  // ASSUMPTION: this REPLACES any existing in-memory data for profileId rather
  // than merging with it. restoreProfile is only ever meant to be called once,
  // immediately after a fresh createHistoryStore(), before any record() calls
  // for this profileId — so in practice there is nothing to merge with.
  function restoreProfile(profileId, pairs) {
    if (profileId == null) return;
    if (!Array.isArray(pairs)) return;

    const newMap = new Map();
    // Sentinel: -1 means "no valid entry seen yet" (record()'s real seqs are
    // always >= 1, since seqCounter starts at 0 and is pre-incremented).
    let maxSeenSeq = -1;

    for (const entry of pairs) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const key = entry[0];
      const rawEntries = entry[1];
      if (typeof key !== 'string' || key === '') continue;
      if (!Array.isArray(rawEntries)) continue;

      const cleaned = [];
      for (const item of rawEntries) {
        if (item == null || typeof item !== 'object') continue;
        const seqNum = Number(item.seq);
        if (!Number.isFinite(seqNum)) continue;
        const text = String(item.text == null ? '' : item.text);
        // Older snapshots (written before timestamps existed) have no `ts` —
        // fall back to null rather than fabricating a fake Date.now(), so the
        // renderer can tell "no timestamp recorded" from a real one.
        // Checked by type, not coerced with Number(): Number(null) === 0,
        // which would silently turn an intentional "no timestamp" (null,
        // e.g. a page divider) into the real epoch-0 instant.
        const rawTs = item.ts;
        const ts = typeof rawTs === 'number' && Number.isFinite(rawTs) ? rawTs : null;
        cleaned.push({ seq: seqNum, text, ts });
        if (seqNum > maxSeenSeq) maxSeenSeq = seqNum;
      }
      if (cleaned.length === 0) continue;

      // Mirror live record()'s trim: keep only the most-recent tail.
      const trimmed =
        cleaned.length > maxLines ? cleaned.slice(cleaned.length - maxLines) : cleaned;

      newMap.set(key, trimmed);
      // Mirror live per-profile key-cap eviction, one key at a time so the
      // Map never exceeds the cap by more than 1 mid-loop.
      if (newMap.size > maxKeys) newMap.delete(newMap.keys().next().value);
    }

    byProfile.set(profileId, newMap);

    // Ensure the NEXT record() (for any key, any profile in this store) produces
    // a seq strictly greater than every seq just loaded from disk. Without this,
    // a freshly recorded line during this session could collide with an old
    // persisted seq for the same key, and the renderer's per-tab dedupe (which
    // dedupes hydrated history against live lines purely by numeric seq
    // equality) would silently treat the new line as an already-seen duplicate.
    if (maxSeenSeq >= 0 && maxSeenSeq > seqCounter) seqCounter = maxSeenSeq;
  }

  return { record, get, clear, serializeProfile, restoreProfile };
}

module.exports = { createHistoryStore };
