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
// `<ChannelName> Someone says/poses ...` (RhostMUSH). Two separate rules
// rather than one alternation, each declaring its own `channel` named group
// exactly once — reusing the same named group across alternation branches
// works on recent V8 but silently fails to compile on older engines (e.g.
// Node 20), which would make the rule compile to nothing and drop out of
// routing without a loud error. Splitting into two rules is behaviorally
// identical (the two bracket styles can never both match one line) and
// portable everywhere. The negative lookaheads keep each rule from firing on
// `[-- divider --]` / `<-- divider -->` style separators (`(?!N?-)`) and on
// bracketed/angled numbers like timestamps/counters `[10]` (`(?!\d)`). The
// `^` anchor also keeps it off inline `[OOC Area]` room-header text, which
// does not start at column 0. Verified against a real captured log: matches
// the guest channel lines and nothing else.
const channelRules = [
  {
    pattern: '^\\[(?!N?-)(?!\\d)(?<channel>[^\\]]+)\\]',
    target: { role: 'channel', nameFrom: 'channel' },
    notify: 'channel',
  },
  {
    pattern: '^<(?!N?-)(?!\\d)(?<channel>[^>]+)>',
    target: { role: 'channel', nameFrom: 'channel' },
    notify: 'channel',
  },
];

// --- Multi-word names ------------------------------------------------------
// MUSH names are frequently two or three words ("Bob Roe", "Carol Doe"), which
// an earlier version of these rules did not allow: a `[^ (]+` sender group
// stops at the first space, so "Bob Roe(br) pages: hi" either failed to match
// entirely (falling through to the feed) or keyed the window on "Bob" only.
// Fixed 2026-08-01 against a real captured session; the constructions below are
// the load-bearing part, do not "simplify" them back:
//
//   * The alias parenthesis is the only RELIABLE right-hand boundary of a
//     multi-word name, so each affected rule is SPLIT into an alias-form
//     (`(?<sender>[^(]+?)\([^)]*\)`, multi-word) and a bare form. Merging them
//     into one rule with an OPTIONAL alias group re-breaks it: the non-greedy
//     sender then stops at the first space, and "From afar, Bob Roe(br)"
//     silently captures "Bob" again.
//   * The bare (aliasless) forms accept extra words only when CAPITALIZED
//     (`(?: [A-Z][^ (]*){0,2}`). That is a strict superset of a single-word
//     name, so it costs nothing, while still refusing to match prose like
//     "600 pages, and ..." at the start of a wrapped line.
//   * A page partner must key to the SAME window whether they are the sender or
//     the recipient, so every rule below is widened together — widening only
//     the incoming side would key "bob roe" against an outgoing "bob" and
//     split one conversation across two tabs.
const NAME_ALIASED = '(?<sender>[^(]+?)\\([^)]*\\)';
const NAME_BARE = '(?<sender>[^ (]+(?: [A-Z][^ (]*){0,2})';
// Recipient list of a group page: a run of either non-paren characters or a
// WHOLE balanced "(alias)" group, so the list can only end at a `)` that is
// genuinely unbalanced — i.e. the one closing the list itself. A plain
// `[^)]+` stops at the first `)` in the line, which for
// "(To: Carol Doe(cd) and Dave(dv))" is the one closing an embedded alias,
// desyncing the whole match.
const PARTNER_LIST = '(?<partners>(?:[^()]|\\([^()]*\\))+)';

// --- Group pages (a page sent to several people at once) -------------------
// "(To: Carol Doe(cd) and Dave(dv)) Judy(jd) pages: Coming to the event?"
// Keyed on the whole conversation (recipients + sender combined, self removed
// by the router — see deriveCombinedName) so every participant's messages land
// in one window. Ordered BEFORE the plain "(To: ...)" echo below, which would
// otherwise swallow these lines and key them on a truncated recipient list.
const groupPageRules = [
  {
    pattern: '^\\(To: ' + PARTNER_LIST + '\\) ' + NAME_ALIASED + ' pages(?: \\([^)]*\\))?[:,] ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  {
    pattern: '^\\(To: ' + PARTNER_LIST + '\\) ' + NAME_BARE + ' pages(?: \\([^)]*\\))?[:,] ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  // Group page-pose: "(To: A(a) and B(b)) From afar, Peggy(peg) waggles ..."
  {
    pattern: '^\\(To: ' + PARTNER_LIST + '\\) From afar, ' + NAME_ALIASED + ' ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  {
    pattern: '^\\(To: ' + PARTNER_LIST + '\\) From afar, (?<sender>[^ (]+) ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
];

// --- Incoming pages (someone paging YOU) -----------------------------------
// The partner window is keyed on the SENDER.
const incomingPageRules = [
  // "Alice pages: hi"  /  'Alice pages, "hi"'  /  "Alice pages (to Bob, You): hi"
  // The sender group excludes the alias suffix: PennMUSH-family servers suffix
  // the sender's alias as "Alice(ally) pages: hi", and swallowing the suffix
  // into the sender would key a DIFFERENT window than the outgoing echo
  // ("You paged Alice ..."), splitting one conversation across two tabs.
  {
    pattern: '^' + NAME_ALIASED + ' pages(?: \\([^)]*\\))?[:,] ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  {
    pattern: '^' + NAME_BARE + ' pages(?: \\([^)]*\\))?[:,] ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  // Page-poses: "From afar, Alice(ally) waves."  /  "From afar, Alice waves."
  // The aliasless form stays SINGLE-word on purpose: with no alias to bound the
  // end of the name, "From afar, Carol Doe waves" is genuinely ambiguous between
  // name "Carol" + verb phrase "Doe waves" and name "Carol Doe" + verb "waves",
  // and guessing wrong would mis-key the window on every pose.
  {
    pattern: '^From afar, ' + NAME_ALIASED + ' ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  {
    pattern: '^From afar, (?<sender>[^ (]+) ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
];

// --- Outgoing page echoes (YOUR own pages, echoed back) --------------------
// Same partner window as the incoming side, keyed on the RECIPIENT. notify is
// null — you don't want to be pinged for your own outgoing message.
const outgoingPageRules = [
  // "You paged Alice with 'hi'."  /  "You paged Alice and Bob with 'hi'."
  // The literal " with '" is the recipient list's right boundary (every one of
  // the 498 outgoing pages in the captured corpus uses that form), which is
  // what lets the list hold multi-word names. combineFrom then normalizes the
  // list, so "Alice and Bob" and "Bob and Alice" key to one window.
  {
    pattern: "^You paged (?<partners>.+?) with '",
    target: { role: 'page', combineFrom: ['partners'] },
    notify: null,
  },
  // TinyMUX outgoing: "Long distance to Alice: hi" / "Long distance to Carol Doe: hi"
  {
    pattern: '^Long distance to (?<partners>[^:]+):',
    target: { role: 'page', combineFrom: ['partners'] },
    notify: null,
  },
  // Parenthesized echo: "(To: Alice) hi" / "(To: Alice and Bob) hi". Must stay
  // LAST of the page rules: the groupPageRules above are strictly more specific
  // forms of the same prefix and have to be tried first.
  {
    pattern: '^\\(To: ' + PARTNER_LIST + '\\) ',
    target: { role: 'page', combineFrom: ['partners'] },
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

// Full ordered preset. Channels lead because they are the most frequent. Group
// order IS load-bearing from there on: groupPageRules must precede the plain
// "(To: ...)" echo in outgoingPageRules, which anchors on the same prefix and
// would otherwise swallow group pages (keying them on the recipients alone,
// with no notify, so an incoming page would never ping).
const familyRules = [
  ...channelRules,
  ...groupPageRules,
  ...incomingPageRules,
  ...outgoingPageRules,
  ...noticeRules,
];

module.exports = {
  familyRules,
  channelRules,
  groupPageRules,
  incomingPageRules,
  outgoingPageRules,
  noticeRules,
};
