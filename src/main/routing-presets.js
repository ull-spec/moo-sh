'use strict';

/*
 * Routing presets — candidate routing rule sets for the server families this
 * client talks to. Two presets live here:
 *
 *   - familyRules  : PennMUSH/TinyMUSH/TinyMUX/RhostMUSH. Authored in Phase 2
 *     from (a) a real, long-running client trigger config and (b) an actual
 *     captured session log, then validated with test/routing-dryrun.js
 *     against that log BEFORE being wired into any live profile.
 *   - evenniaRules : Evennia (Night City MUX). Evennia's page/text/channel
 *     output shapes are unrelated to the MUSH family's, so it gets its own
 *     independent rule set rather than trying to bolt onto familyRules.
 *
 * These are candidates: this module is NOT auto-loaded by index.js. A profile
 * opts in by copying the relevant rules into its own `routingRules` (and
 * supplying its own `channelAliases`). Order matters — first match wins.
 *
 * Rule schema (see router.js): { pattern, flags?, target:{role,name?,nameFrom?,combineFrom?,namePrefix?}, notify }
 *   - Patterns are STRINGS so they can be copied verbatim into profile JSON.
 *   - `nameFrom` names a capture group that isolates the dynamic target: the
 *     channel name, or the page partner (sender for incoming, recipient for the
 *     local echo of an outgoing page — both collapse to one per-partner window).
 *
 * COVERAGE NOTE (familyRules): pages/channels/announcements/mail/BBS are
 * covered here (the event types the BeipMU config documented). Pose/say/emit/
 * OOC routing is NOT covered yet — those need fresh capture data (say/pose
 * stays in the feed in the meantime, which is the correct default).
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

// =============================================================================
// Evennia preset (Night City MUX)
// =============================================================================
//
// Evennia's paging/texting/channel system is a different codebase with its own
// output shapes — none of the constructions above apply. Authored directly
// from the server's own message templates (ANSI is already stripped before a
// line reaches the router, so none of these patterns need to account for it).

// A sender name with its alias glued on: Evennia writes "Name(alias)" with no
// space before the paren, unlike the MUSH family's own alias suffix. The name
// itself must not end in a space and must not contain ":" or "(" — that keeps
// this from firing on a pose or page line that merely happens to contain
// parentheses further along, e.g. "From afar, Jack waves (brb)" (the "sender"
// here would otherwise swallow "Jack waves " and the trailing "(brb)" would
// look like an alias) or "From afar, Jack pages: see (this) now".
const EV_NAME_ALIASED = '(?<sender>[^(:]*[^(: ])\\([^()]*\\)';

// --- Notices -----------------------------------------------------------------
// A server-wide "player approved" announcement pings; every other bracketed
// banner (space-padded `[ HANGOUT ] ...`, `[ HUSTLE ] ...`, the MOTD banner) or
// direct system notice (`[Watch]`, `[DEBUG]`, `[ELO]`, `[Mystery Solved]`) is
// noise that stays in the feed without a ping. These have to run BEFORE the
// channel rule below: Evennia channel lines are `[Name] ` with no space after
// the bracket, so a space-padded banner can never collide with a real channel,
// but `[Watch]`/`[DEBUG]`/etc. have exactly the same shape as a channel tag and
// would otherwise be mistaken for one.
const evenniaNoticeRules = [
  { pattern: '^\\[ NIGHT CITY \\] ', target: { role: 'feed' }, notify: 'activity' },
  { pattern: '^\\[ ', target: { role: 'feed' }, notify: null },
  { pattern: '^\\[(?:Watch|DEBUG|ELO|Mystery Solved)\\]', target: { role: 'feed' }, notify: null },
  // New in-game mail arriving while you're online. The Evennia counterpart of
  // the family preset's "MAIL: You have a new ..." notice: stays in the feed,
  // but pings.
  { pattern: '^You have received a new mail from ', target: { role: 'feed' }, notify: 'activity' },
];

// --- Channel messages ----------------------------------------------------------
// "[Public] Jack: hello" / "[Jobs] [Job System] Job #12 created". Same shape
// and same guards as the MUSH family's `[Name]` rule (see channelRules above),
// kept as its own object here rather than shared since the two presets must be
// able to diverge independently.
const evenniaChannelRules = [
  {
    pattern: '^\\[(?!N?-)(?!\\d)(?<channel>[^\\]]+)\\]',
    target: { role: 'channel', nameFrom: 'channel' },
    notify: 'channel',
  },
];

// --- Group pages (a page sent to several people at once) -------------------
// Incoming: "From afar, (To Vex(vx) and Jack(jv)), Rook(rk) pages: meet up?"
// — the recipient list header names EVERY recipient including you, mirroring
// the family preset's group-page shape (see PARTNER_LIST above, reused as-is).
// Ordered before the 1:1 page rules and before the plain group-page echo below
// it, which anchors on the same "To (...)" prefix and would otherwise swallow
// these lines.
const evenniaGroupPageRules = [
  {
    pattern: '^From afar, \\(To ' + PARTNER_LIST + '\\), ' + EV_NAME_ALIASED + ' ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  {
    pattern: '^From afar, \\(To ' + PARTNER_LIST + '\\), (?<sender>[^(:]+?) pages: ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  // Aliasless group pose: single-word fallback, same ambiguity as the family
  // preset's own aliasless pose rule — with no alias to bound the name there is
  // no reliable way to tell a multi-word name from a name plus the start of a
  // verb phrase.
  {
    pattern: '^From afar, \\(To ' + PARTNER_LIST + '\\), (?<sender>[^ (]+) ',
    target: { role: 'page', combineFrom: ['partners', 'sender'] },
    notify: 'page',
  },
  // Outgoing group-page echo: "To (Jack Vance(jv), Rook(rk)) you paged: 'meet up?'"
  {
    pattern: '^To \\(' + PARTNER_LIST + '\\) you paged: \'',
    target: { role: 'page', combineFrom: ['partners'] },
    notify: null,
  },
  // Outgoing group-pose echo: "To (Jack Vance(jv), Rook(rk)): Vex nods."
  {
    pattern: '^To \\(' + PARTNER_LIST + '\\): ',
    target: { role: 'page', combineFrom: ['partners'] },
    notify: null,
  },
];

// --- 1:1 pages ---------------------------------------------------------------
const evenniaPageRules = [
  // Incoming page/pose: "From afar, Jack Vance(jv) pages: hey" /
  // "From afar, Jack(jv) waves."
  {
    pattern: '^From afar, ' + EV_NAME_ALIASED + ' ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  // Aliasless page: bounded by the literal " pages: ", so a multi-word name is
  // safe here (unlike the pose fallback below, there's a hard right edge).
  {
    pattern: '^From afar, (?<sender>[^(:]+?) pages: ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  // Aliasless pose: single-word fallback only, for the same reason as the
  // group pose above — no alias, no reliable right edge for a multi-word name.
  {
    pattern: '^From afar, (?<sender>[^ (]+) ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
  // Outgoing echoes. notify is null except the idle auto-reply, which is a
  // message FROM the other person (their client auto-answering your page), not
  // something you sent — index.js treats a null-notify page line as your own
  // outgoing echo when labelling the speaker, so this one has to carry a real
  // notify or it would be mislabelled as your own message.
  {
    pattern: '^You paged (?<partner>[^(]+?)(?:\\([^()]*\\))? with: \'',
    target: { role: 'page', nameFrom: 'partner' },
    notify: null,
  },
  {
    pattern: '^Long distance to (?<partner>[^(:]+?)(?:\\([^()]*\\))?: ',
    target: { role: 'page', nameFrom: 'partner' },
    notify: null,
  },
  {
    pattern: '^Idle response from (?<sender>[^(:]+?)(?:\\([^()]*\\))?: ',
    target: { role: 'page', nameFrom: 'sender' },
    notify: 'page',
  },
];

// --- Texts -------------------------------------------------------------------
// Evennia's text/SMS-flavoured messaging system, distinct from paging: plain
// names only (no aliases), and a group text chat has no per-message membership
// list to key on. Every text rule carries namePrefix 'Text: ' so a text
// conversation with someone gets its own tab, separate from any page
// conversation with that same person.
const evenniaTextRules = [
  {
    pattern: '^In a text group chat, you text, "',
    target: { role: 'page', name: 'Group chat', namePrefix: 'Text: ' },
    notify: null,
  },
  {
    pattern: '^In a text group chat, you send the following picture: ',
    target: { role: 'page', name: 'Group chat', namePrefix: 'Text: ' },
    notify: null,
  },
  {
    pattern: '^In a group chat, you receive an image from ',
    target: { role: 'page', name: 'Group chat', namePrefix: 'Text: ' },
    notify: 'page',
  },
  // Incoming group texts carry no recipient list, so a group conversation
  // can't be keyed per membership the way a group page can — every group-text
  // line, from whoever sent it, shares the one "Group chat" tab.
  {
    pattern: '^In a text group chat, .+? texts, "',
    target: { role: 'page', name: 'Group chat', namePrefix: 'Text: ' },
    notify: 'page',
  },
  {
    pattern: '^(?<sender>[^"(:]+?) sends you a text that reads, "',
    target: { role: 'page', nameFrom: 'sender', namePrefix: 'Text: ' },
    notify: 'page',
  },
  {
    pattern: '^You receive a picture via text from (?<sender>[^:]+?): ',
    target: { role: 'page', nameFrom: 'sender', namePrefix: 'Text: ' },
    notify: 'page',
  },
  // Outgoing text: the greedy ".*" anchors on the LAST '" to ', so a message
  // that itself contains the substring '" to ' still keys on the real
  // recipient rather than an early false boundary.
  {
    pattern: '^You text, ".*" to (?<partner>[^"]+?)\\.\\s*$',
    target: { role: 'page', nameFrom: 'partner', namePrefix: 'Text: ' },
    notify: null,
  },
  {
    pattern: '^You send the following picture to (?<partner>[^:]+?): ',
    target: { role: 'page', nameFrom: 'partner', namePrefix: 'Text: ' },
    notify: null,
  },
];

// Full ordered Evennia preset. Notices first (they overlap in shape with
// channel tags and must be ruled out before the channel rule runs), then
// channels, then group pages before 1:1 pages (same reasoning as the family
// preset — the group forms are strictly more specific prefixes), then texts
// last.
const evenniaRules = [
  ...evenniaNoticeRules,
  ...evenniaChannelRules,
  ...evenniaGroupPageRules,
  ...evenniaPageRules,
  ...evenniaTextRules,
];

module.exports = {
  familyRules,
  channelRules,
  groupPageRules,
  incomingPageRules,
  outgoingPageRules,
  noticeRules,
  evenniaRules,
  evenniaNoticeRules,
  evenniaChannelRules,
  evenniaGroupPageRules,
  evenniaPageRules,
  evenniaTextRules,
};
