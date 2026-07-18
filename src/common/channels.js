'use strict';

// Channel/target helpers shared across the app. In Phase 1 this is intentionally
// minimal — the real channel roster for a given server is unknown until
// capture data is mined in Phase 2. It exists now so router.js and
// window-manager.js have a stable place to normalize target identifiers.

// Normalize a raw channel or partner name into a stable window-target key.
// Used to map many routed lines to a single window (e.g. all "Public" channel
// lines to one window). Case-folded and trimmed; safe for use as a Map key.
function normalizeTarget(name) {
  if (name == null) return null;
  return String(name).trim().toLowerCase();
}

// Resolve a raw channel name (as it appeared on the wire, possibly an alias the
// user set with `addcom`) to its canonical channel name, using a per-profile
// alias map. This is what makes different aliases for the SAME channel route to
// ONE window: e.g. with aliases { "vam": "Vampire", "pub": "Public" }, both a
// line tagged `[vam]` and one tagged `[Vampire]` resolve to "Vampire".
//
// Lookup is case-insensitive on the alias key. The returned value preserves the
// canonical DISPLAY casing (either the alias map's value, or the raw name
// unchanged when there is no alias) — callers that need a Map key should pass
// the result through normalizeTarget().
//
// @param {string} raw      the channel name as captured from the line
// @param {object} aliases  { <alias>: <canonicalName> }, may be empty/undefined
// @returns {string|null}
function resolveChannelName(raw, aliases) {
  if (raw == null) return null;
  const name = String(raw).trim();
  if (!aliases || typeof aliases !== 'object') return name;

  // Direct (case-sensitive) hit first, then case-insensitive.
  if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name];
  const key = name.toLowerCase();
  for (const alias of Object.keys(aliases)) {
    if (alias.toLowerCase() === key) return aliases[alias];
  }
  return name;
}

module.exports = { normalizeTarget, resolveChannelName };
