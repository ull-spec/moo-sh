'use strict';

/*
 * Line router — DATA, not code.
 *
 * The router runs in the main process on every complete decoded line before it
 * is fanned out to windows. Its behaviour is defined entirely by an ORDERED
 * array of rule objects; the code here just walks that array and returns the
 * first match. First match wins. If nothing matches, the line falls through to
 * the FEED default (the always-open catch-all window).
 *
 * A rule is shaped:
 *   {
 *     pattern: RegExp | string,   // string is compiled with `flags`
 *     flags:   string,            // optional, only used when pattern is a string
 *     target:  { role, name?, nameFrom? },
 *     notify:  one of EVENTS | null
 *   }
 *   - role     : one of ROLES (feed | channel | page).
 *   - name     : a STATIC target name (used when the target is fixed).
 *   - nameFrom : derive the target name DYNAMICALLY from the regex match — a
 *                named capture group (string, e.g. 'channel' / 'sender') or a
 *                numeric group index. This is how one channel rule serves every
 *                channel and one page rule serves every partner. If nameFrom is
 *                set but the group is absent/empty, falls back to `name`.
 *   - combineFrom : like nameFrom, but for a target identifying a GROUP
 *                conversation spread across several capture groups (e.g. a
 *                group page's recipient list AND its sender). An array of
 *                named capture groups; each is split on ", "/" and " into
 *                individual names, the whole set is deduped and sorted, and
 *                joined back into one stable name — so the same conversation
 *                keys to the same target no matter who is currently speaking.
 *                Takes precedence over nameFrom when both are present.
 *
 * For channel targets the derived/static name is passed through the profile's
 * channelAliases map (see common/channels.resolveChannelName) so different
 * aliases for the same channel (e.g. `[vam]` and `[Vampire]`) collapse to one
 * canonical target. Every matched result also carries a `target.key`
 * (normalizeTarget of the canonical name) — the stable window-map key Phase 3
 * uses to spawn/reuse a window.
 */

const { ROLES } = require('../common/line-types');
const { normalizeTarget, resolveChannelName } = require('../common/channels');

// Upper bound on a derived target name's length (H1: a hostile/buggy MUSH
// server could send an absurdly long "channel name" or "page sender name" via
// a regex capture, which then gets used as a window-map key, roster entry,
// tab title, etc. downstream). Applied to both the nameFrom-capture path and
// the static-name fallback path.
const MAX_NAME_LEN = 200;

// Compile one rule's pattern into a RegExp (leaving RegExps untouched). Never
// throws: a user-hand-edited profile JSON can contain an invalid pattern
// string (e.g. unbalanced parens), and one bad rule must not take down the
// whole router (M4). On failure, returns regex: null so route()'s
// `if (!rule.regex) continue;` guard skips it, same as a missing pattern.
function compileRule(rule) {
  if (!rule || rule.pattern == null) {
    return { ...rule, regex: null };
  }
  if (rule.pattern instanceof RegExp) {
    return { ...rule, regex: rule.pattern };
  }
  try {
    const regex = new RegExp(String(rule.pattern), rule.flags || '');
    return { ...rule, regex };
  } catch (err) {
    return { ...rule, regex: null, compileError: err.message };
  }
}

// Compile a rules array, reporting (via onWarning, if provided) any rule that
// failed to compile. onWarning is called once per bad rule with a message
// naming its index in the array, so it's locatable in the profile JSON.
function compileRules(rules, onWarning) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule, index) => {
    const compiled = compileRule(rule);
    if (!compiled.regex && rule && rule.pattern != null && typeof onWarning === 'function') {
      const reason = compiled.compileError || 'invalid pattern';
      onWarning(`Routing rule ${index} skipped (invalid pattern): ${reason}`);
    }
    return compiled;
  });
}

// Resolve the target name for a matched rule: a nameFrom capture group (named
// or numeric) if present, otherwise the static name. Capped to MAX_NAME_LEN.
function deriveName(target, match) {
  if (target.nameFrom != null) {
    let raw;
    if (typeof target.nameFrom === 'number') {
      raw = match[target.nameFrom];
    } else if (match.groups) {
      raw = match.groups[target.nameFrom];
    }
    if (raw != null) return String(raw).slice(0, MAX_NAME_LEN);
  }
  return target.name != null ? String(target.name).slice(0, MAX_NAME_LEN) : null;
}

// Split a raw captured name list ("Bob, Alice, and Joe" / "Bob and Alice" /
// "Bob") into individual trimmed names. Handles a plain Oxford-comma list, a
// bare "X and Y" pair, and a lone name, since a matched line may carry any of
// those shapes depending on how many names it lists.
function splitNameList(raw) {
  if (raw == null) return [];
  // The Oxford-comma alternative (", and ") must be tried before the plain
  // comma one: at "X, and Y", a plain-comma-first match would consume only
  // ", " and leave a dangling "and Y" in the next piece.
  return String(raw)
    .split(/\s*,\s*and\s+|\s*,\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Like deriveName, but for a target that identifies a GROUP conversation
// spread across multiple capture groups (e.g. a page's recipient list AND its
// sender) rather than a single name. Gathers every group named in
// target.combineFrom, splits each into individual names, dedupes
// case-insensitively (keeping first-seen casing), sorts case-insensitively so
// the result is stable no matter which participant's line is being routed
// (whoever is speaking is excluded from their own "To:" list, so without this
// the derived name would otherwise shift per message), and joins with ", ".
function deriveCombinedName(target, match) {
  const names = [];
  for (const groupName of target.combineFrom) {
    const raw = match.groups ? match.groups[groupName] : undefined;
    if (raw != null) names.push(...splitNameList(raw));
  }
  const seen = new Map();
  for (const n of names) {
    const key = n.toLowerCase();
    if (!seen.has(key)) seen.set(key, n);
  }
  if (seen.size === 0) return null;
  const combined = [...seen.values()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .join(', ');
  return combined.slice(0, MAX_NAME_LEN);
}

/**
 * @param {Array<object>} rules
 * @param {{ channelAliases?: object, onWarning?: (message: string) => void }} [options]
 */
function createRouter(rules, options = {}) {
  const onWarning = options && typeof options.onWarning === 'function' ? options.onWarning : null;
  let compiled = compileRules(rules, onWarning);
  let channelAliases = (options && options.channelAliases) || {};

  function defaultResult() {
    return { role: ROLES.FEED, target: null, notify: null, match: null };
  }

  /**
   * @param {string} line
   * @returns {{ role: string, target: object|null, notify: string|null, match: RegExpExecArray|null }}
   */
  function route(line) {
    const text = line == null ? '' : String(line);
    for (let i = 0; i < compiled.length; i++) {
      const rule = compiled[i];
      if (!rule.regex) continue;
      // Use exec so callers get capture groups; reset lastIndex defensively in
      // case a rule's RegExp carries the /g or /y flag.
      rule.regex.lastIndex = 0;
      const match = rule.regex.exec(text);
      if (!match) continue;

      const t = rule.target || {};
      const role = t.role || ROLES.FEED;

      let name =
        Array.isArray(t.combineFrom) && t.combineFrom.length > 0
          ? deriveCombinedName(t, match)
          : deriveName(t, match);
      if (role === ROLES.CHANNEL && name != null) {
        name = resolveChannelName(name, channelAliases);
      }
      const key = name != null ? normalizeTarget(name) : null;

      return {
        role,
        target: { role, name: name == null ? null : name, key },
        notify: rule.notify == null ? null : rule.notify,
        match,
      };
    }
    return defaultResult();
  }

  function setRules(newRules) {
    compiled = compileRules(newRules, onWarning);
  }

  function setChannelAliases(aliases) {
    channelAliases = aliases || {};
  }

  return { route, setRules, setChannelAliases };
}

module.exports = { createRouter };
