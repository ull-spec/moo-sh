'use strict';

/*
 * Routing presets — candidate, family-generic routing rules for the
 * PennMUSH/TinyMUSH/TinyMUX server family. Authored in Phase 2 from (a) a real,
 * long-running client trigger config and (b) an actual captured session log,
 * then validated with test/routing-dryrun.js against that log BEFORE being
 * wired into any live profile.
 *
 * These are candidates: this module is NOT auto-loaded by index.js. A profile
 * opts in by copying the relevant rules into its own `routingRules` (and
 * supplying its own `channelAliases`). Order matters — first match wins.
 *
 * Rule schema (see router.js): { pattern, flags?, target:{role,name?,nameFrom?}, notify }
 *   - Patterns are STRINGS so they can be copied verbatim into profile JSON.
 *   - `nameFrom` names a capture group that isolates the dynamic target: the
 *     channel name, or the page partner (sender for incoming, recipient for the
 *     local echo of an outgoing page — both collapse to one per-partner window).
 *
 * COVERAGE NOTE: pages/channels/announcements/mail/BBS are covered here (the
 * event types the BeipMU config documented). Pose/say/emit/OOC routing is NOT
 * covered yet — those need fresh capture data (say/pose stays in the feed in
 * the meantime, which is the correct default).
 */

// --- Channel messages ------------------------------------------------------
// `[ChannelName] Someone says/poses ...` (PennMUSH/TinyMUSH/TinyMUX) or
// `<ChannelName> Someone says/poses ...` (RhostMUSH). One pattern, two
// alternatives sharing the same `channel` named group (supported: duplicate
// named groups across alternation branches). The negative lookaheads keep the
// rule from firing on `[-- divider --]` / `<-- divider -->` style separators
// (`(?!N?-)`) and on bracketed/angled numbers like timestamps/counters `[10]`
// (`(?!\d)`). The `^` anchor also keeps it off inline `[OOC Area]` room-header
// text, which does not start at column 0. Verified against a real captured
// log: matches the guest channel lines and nothing else.
const channelRules = [
  {
    pattern:
      '^(?:\\[(?!N?-)(?!\\d)(?<channel>[^\\]]+)\\]|<(?!N?-)(?!\\d)(?<channel>[^>]+)>)',
    target: { role: 'channel', nameFrom: 'channel' },
    notify: 'channel',
  },
];

// --- Incoming pages (someone paging YOU) -----------------------------------
// The partner window is keyed on the SENDER.
const incomingPageRules = [
  // "Alice pages: hi"  /  'Alice pages, "hi"'  /  "Alice pages (to Bob, You): hi"
  // The sender group stops at `(` as well as space, with the alias suffix
  // consumed by an optional NON-captured group: PennMUSH-family servers can
  // suffix the sender's alias as "Alice(ally) pages: hi", and swallowing the
  // suffix into the sender would key a DIFFERENT window than the outgoing echo
  // ("You paged Alice ..."), splitting one conversation across two tabs.
  {
    pattern: '^(?<sender>[^ (]+)(?:\\([^)]*\\))? pages(?: \\([^)]*\\))?[:,] ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  // Page-poses: "From afar, Alice waves."  /  "From afar, Alice pages: hi"
  {
    pattern: '^From afar, (?<sender>[^ (]+)(?:\\([^)]*\\))? ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
];

// --- Outgoing page echoes (YOUR own pages, echoed back) --------------------
// Same partner window as the incoming side, keyed on the RECIPIENT. notify is
// null — you don't want to be pinged for your own outgoing message.
const outgoingPageRules = [
  // "You paged Alice with 'hi'."  (also first name of "You paged Alice, Bob ...")
  {
    pattern: '^You paged (?<partner>[^ ,]+)',
    target: { role: 'page', nameFrom: 'partner' },
    notify: null,
  },
  // TinyMUX outgoing: "Long distance to Alice: hi"
  {
    pattern: '^Long distance to (?<partner>[^ :,]+)[:,] ',
    target: { role: 'page', nameFrom: 'partner' },
    notify: null,
  },
  // Parenthesized echo: "(To: Alice) hi"
  {
    pattern: '^\\(To: (?<partner>[^)]+)\\)',
    target: { role: 'page', nameFrom: 'partner' },
    notify: null,
  },
];

// --- Announcements / mail / bboard -----------------------------------------
// These are not per-partner conversations, so they stay in the FEED window but
// carry a notify so Phase 4 can ping. Kept deliberately narrow: only the "new
// item" phrasings ping, not routine "you have no mail" status.
const noticeRules = [
  { pattern: '^Announcement: ', target: { role: 'feed' }, notify: 'activity' },
  { pattern: '^MAIL: You have a new', target: { role: 'feed' }, notify: 'activity' },
  { pattern: '^BBS: New BB message', target: { role: 'feed' }, notify: 'activity' },
];

// Full ordered preset. No overlap between the groups (each anchors on a
// distinct prefix), so group order is not load-bearing — but channels are most
// frequent, so they lead.
const familyRules = [
  ...channelRules,
  ...incomingPageRules,
  ...outgoingPageRules,
  ...noticeRules,
];

module.exports = {
  familyRules,
  channelRules,
  incomingPageRules,
  outgoingPageRules,
  noticeRules,
};
