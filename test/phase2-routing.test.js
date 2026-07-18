'use strict';

/*
 * Phase 2 routing unit test — TRUE-positive validation of the familyRules
 * preset against synthetic but canonical TinyMUX/PennMUSH line formats, plus
 * channel-alias collapsing and negative-lookahead guards. Complements
 * routing-dryrun.js (which validates NON-false-positives against the real log).
 *
 * Plain Node, no framework. Exits non-zero on any failure.
 */

const { createRouter } = require('../src/main/router');
const presets = require('../src/main/routing-presets');

let pass = 0;
let fail = 0;
function check(desc, cond) {
  if (cond) {
    pass += 1;
    console.log('PASS: ' + desc);
  } else {
    fail += 1;
    console.log('FAIL: ' + desc);
  }
}

// Router with example aliases: two aliases for one canonical channel.
const aliases = { vam: 'Vampire', vampire: 'Vampire', pub: 'Public' };
const router = createRouter(presets.familyRules, { channelAliases: aliases });
const r = (line) => router.route(line);

// --- Channels --------------------------------------------------------------
{
  const x = r('[Public] Alice says, "hi"');
  check('channel: [Public] -> channel role', x.role === 'channel');
  check('channel: [Public] -> name Public', x.target.name === 'Public');
  check('channel: [Public] -> key public', x.target.key === 'public');
  check('channel: [Public] -> notify channel', x.notify === 'channel');
}

// Alias collapsing: [vam] and [Vampire] must resolve to the same key.
{
  const a = r('[vam] Bob poses something');
  const b = r('[Vampire] Cindy says, "yo"');
  check('alias: [vam] -> canonical Vampire', a.target.name === 'Vampire');
  check('alias: [vam] key = vampire', a.target.key === 'vampire');
  check('alias: [Vampire] key = vampire', b.target.key === 'vampire');
  check('alias: [vam] and [Vampire] collapse to one key', a.target.key === b.target.key);
}

// Negative lookaheads: dividers and bracketed numbers are NOT channels.
{
  check('guard: [-- OOC --] is not a channel', r('[-- OOC --] divider').role === 'feed');
  check('guard: [N-Something] is not a channel', r('[N-foo] x').role === 'feed');
  check('guard: [10] bracketed number is not a channel', r('[10] 21:33 log').role === 'feed');
}

// RhostMUSH-style angle-bracket channel tags, captured
// 2026-07-18: "<Public> Jess has disconnected." Same rule, second alternative.
{
  const x = r('<Public> Alice says, "hi"');
  check('channel: <Public> -> channel role', x.role === 'channel');
  check('channel: <Public> -> name Public', x.target.name === 'Public');
  check('channel: <Public> -> key public', x.target.key === 'public');
  check('channel: <Public> -> notify channel', x.notify === 'channel');

  const a = r('<pub> Bob poses something');
  const b = r('<Vampire> Cindy says, "yo"');
  check('alias: <pub> -> canonical Public', a.target.name === 'Public');
  check('angle+square: <Vampire> and [Vampire] share a key',
    b.target.key === r('[Vampire] Cindy says, "yo"').target.key);
}

// Negative lookaheads apply to the angle-bracket alternative too.
{
  check('guard: <-- OOC --> is not a channel', r('<-- OOC --> divider').role === 'feed');
  check('guard: <N-Something> is not a channel', r('<N-foo> x').role === 'feed');
  check('guard: <10> angle-bracketed number is not a channel', r('<10> 21:33 log').role === 'feed');
}

// --- Incoming pages --------------------------------------------------------
{
  check('page in: "Alice pages: hi" -> page/Alice',
    r('Alice pages: hi').role === 'page' && r('Alice pages: hi').target.name === 'Alice');
  check('page in: quoted form -> page/Bob',
    r('Bob pages, "hello there"').target.name === 'Bob');
  check('page in: multi "(to You, Dave)" -> page/Carol',
    r('Carol pages (to You, Dave): hey').target.name === 'Carol');
  check('page in: notify page',
    r('Alice pages: hi').notify === 'page');
}

// From-afar page poses.
{
  const x = r('From afar, Eve waves.');
  check('page in: "From afar, Eve waves." -> page/Eve', x.role === 'page' && x.target.name === 'Eve');
}

// --- Outgoing page echoes (partner keyed, no self-notify) ------------------
{
  const a = r("You paged Frank with 'yo'.");
  check('page out: "You paged Frank" -> page/Frank', a.role === 'page' && a.target.name === 'Frank');
  check('page out: no self-notify', a.notify === null);
  check('page out: "Long distance to Grace:" -> page/Grace',
    r('Long distance to Grace: hi').target.name === 'Grace');
  check('page out: "(To: Heidi)" -> page/Heidi',
    r('(To: Heidi) hi there').target.name === 'Heidi');
}

// Incoming + outgoing for the same partner collapse to one window key.
{
  const inc = r('Ivan pages: hi');
  const out = r("You paged Ivan with 'hey'.");
  check('page: incoming & outgoing for Ivan share a key',
    inc.target.key === out.target.key && inc.target.key === 'ivan');
}

// Alias-suffixed incoming pages (a real captured format, 2026-07-12):
// "Amanda(mandy) pages: ..." — the sender group must stop at the `(` so the
// alias suffix is NOT part of the name, otherwise the incoming key
// ("amanda(mandy)") diverges from the outgoing echo's key ("amanda") and one
// conversation splits across two tabs. The key-equality check IS the bug.
{
  const inc = r('Amanda(mandy) pages: Hooray! Great news!');
  const out = r("You paged Amanda with 'hi'.");
  check('page in: alias suffix "Amanda(mandy)" -> name Amanda (suffix dropped)',
    inc.role === 'page' && inc.target.name === 'Amanda');
  check('page: alias-suffixed incoming & bare outgoing share key amanda',
    inc.target.key === out.target.key && inc.target.key === 'amanda');
  const afar = r('From afar, Amanda(mandy) waves.');
  check('page in: "From afar, Amanda(mandy)" -> name Amanda (suffix dropped)',
    afar.role === 'page' && afar.target.name === 'Amanda' && afar.target.key === 'amanda');
}

// --- Notices ---------------------------------------------------------------
{
  check('notice: "Announcement:" -> feed + activity',
    r('Announcement: Reset in 5').role === 'feed' && r('Announcement: Reset in 5').notify === 'activity');
  check('notice: new mail pings',
    r('MAIL: You have a new message from Alice.').notify === 'activity');
  check('notice: "no mail" does NOT ping (falls through)',
    r('MAIL: You have no mail.').role === 'feed' && r('MAIL: You have no mail.').notify === null);
}

// --- Plain content stays in feed ------------------------------------------
{
  check('feed: room description stays in feed',
    r('A dim alley stretches north.').role === 'feed');
  check('feed: local say stays in feed (not yet routed)',
    r('Alice says, "hello"').role === 'feed');
  check('feed: pose stays in feed (not yet routed)',
    r('Alice waves to everyone.').role === 'feed');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL TESTS PASSED');
