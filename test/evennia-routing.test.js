'use strict';

/*
 * Evennia routing unit test — validates the evenniaRules preset (Night City
 * MUX) against synthetic but canonical Evennia line formats: pages, group
 * pages, texts, channels, and the bracketed notices that only look like
 * channels. Companion to phase2-routing.test.js, which covers the MUSH
 * family preset the same way.
 *
 * Plain Node, no framework. Exits non-zero on any failure.
 */

const { createRouter } = require('../src/main/router');
const presets = require('../src/main/routing-presets');
const routingLegacy = require('../src/main/routing-legacy');

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

const router = createRouter(presets.evenniaRules);
const r = (line) => router.route(line);

const me = createRouter(presets.evenniaRules, { selfNames: ['Vex'] });

// --- 1:1 pages ---------------------------------------------------------------
{
  const a = r('From afar, Jack Vance(jv) pages: hey');
  check('page in: aliased multi-word "pages:" -> page/Jack Vance',
    a.role === 'page' && a.target.name === 'Jack Vance' && a.notify === 'page');

  const b = r('From afar, Jack Vance pages: hey');
  check('page in: aliasless multi-word "pages:" -> page/Jack Vance',
    b.role === 'page' && b.target.name === 'Jack Vance' && b.notify === 'page');

  const c = r('From afar, Jack(jv) waves.');
  check('page in: aliased pose -> page/Jack',
    c.role === 'page' && c.target.name === 'Jack' && c.notify === 'page');

  const d = r('From afar, Jack waves.');
  check('page in: aliasless pose -> page/Jack', d.role === 'page' && d.target.name === 'Jack');

  const e = r('From afar, Jack waves (brb) at you.');
  check('page in: pose with parens in the text itself does not become an alias',
    e.role === 'page' && e.target.name === 'Jack');

  const f = r('From afar, Jack pages: see (this) now');
  check('page in: "pages:" text containing parens still keys on the sender',
    f.role === 'page' && f.target.name === 'Jack');
}

{
  const inKey = r('From afar, Jack Vance(jv) pages: hey').target.key;

  const a = r("You paged Jack Vance(jv) with: 'hey'");
  check('page out: aliased "you paged" -> page/Jack Vance, no self-notify',
    a.role === 'page' && a.target.name === 'Jack Vance' && a.notify === null);
  check('page out: aliased "you paged" key matches incoming', a.target.key === inKey);

  const b = r("You paged Jack with: 'hey'");
  check('page out: aliasless "you paged" -> page/Jack', b.role === 'page' && b.target.name === 'Jack');
}

{
  const a = r('Long distance to Jack Vance(jv): Vex waves.');
  check('page out: "Long distance to" pose echo -> page/Jack Vance, no self-notify',
    a.role === 'page' && a.target.name === 'Jack Vance' && a.notify === null);
}

{
  const a = r('Idle response from Jack Vance: afk');
  check('page in: idle auto-reply -> page/Jack Vance, notify page (not your own echo)',
    a.role === 'page' && a.target.name === 'Jack Vance' && a.notify === 'page');
}

// --- Group pages -------------------------------------------------------------
{
  const inA = me.route('From afar, (To Vex(vx) and Jack Vance(jv)), Rook(rk) pages: meet up?');
  check('group page in: role/notify', inA.role === 'page' && inA.notify === 'page');
  check('group page in: self dropped, aliases stripped, sorted',
    inA.target.name === 'Jack Vance, Rook');

  const inB = me.route('From afar, (To Vex and Jack Vance, Rook and Zed), Mika pages: hi');
  check('group page in: "A, B and C" recipient list parses and routes',
    inB.role === 'page' && inB.notify === 'page');
  check('group page in: "A, B and C" list splits into every name, self dropped',
    inB.target.name === 'Jack Vance, Mika, Rook, Zed');

  const inPose = me.route('From afar, (To Vex(vx) and Jack(jv)), Rook(rk) nods.');
  check('group pose in: role/notify', inPose.role === 'page' && inPose.notify === 'page');
  check('group pose in: self dropped, aliases stripped', inPose.target.name === 'Jack, Rook');

  const outA = me.route("To (Jack Vance(jv), Rook(rk)) you paged: 'meet up?'");
  check('group page out: role, no self-notify', outA.role === 'page' && outA.notify === null);
  check('group page out: matches incoming key for the same participant set',
    outA.target.key === inA.target.key);

  const outB = me.route('To (Jack Vance(jv), Rook(rk)): Vex nods.');
  check('group pose out: role, no self-notify', outB.role === 'page' && outB.notify === null);
  check('group pose out: matches the group page-out key (same recipients)',
    outB.target.key === outA.target.key);
}

// --- Notices / bracketed banners ---------------------------------------------
{
  check('room OOC stays in feed', r('<OOC> Jack says, "brb"').role === 'feed');

  check('[Watch] -> feed, no notify',
    r('[Watch] Jack has connected.').role === 'feed' && r('[Watch] Jack has connected.').notify === null);
  check('[ HANGOUT ] -> feed, no notify',
    r('[ HANGOUT ] You earn 5 IP').role === 'feed' && r('[ HANGOUT ] You earn 5 IP').notify === null);
  check('[DEBUG] -> feed, no notify',
    r('[DEBUG] x').role === 'feed' && r('[DEBUG] x').notify === null);
  check('[ELO] -> feed, no notify',
    r('[ELO] Afterlife Bar').role === 'feed' && r('[ELO] Afterlife Bar').notify === null);
  check('[ HUSTLE ] -> feed, no notify',
    r('[ HUSTLE ] Jack just rolled 100').role === 'feed' && r('[ HUSTLE ] Jack just rolled 100').notify === null);
  check('[ NIGHT CITY MUSH -- WELCOME ] -> feed, no notify',
    r('[ NIGHT CITY MUSH -- WELCOME ]').role === 'feed' && r('[ NIGHT CITY MUSH -- WELCOME ]').notify === null);

  const approved = r('[ NIGHT CITY ] Jack is approved for play!');
  const mail = r('You have received a new mail from Jack Vance with subject: hi');
  check('new-mail notice -> feed, notify activity', mail.role === 'feed' && mail.notify === 'activity');
  check('[ NIGHT CITY ] approval banner -> feed, notify activity',
    approved.role === 'feed' && approved.notify === 'activity');
}

// --- Channels ------------------------------------------------------------------
{
  const a = r('[Public] Jack: hello');
  check('channel: [Public] -> channel/Public, notify channel',
    a.role === 'channel' && a.target.name === 'Public' && a.notify === 'channel');

  const b = r('[Jobs] [Job System] Job #12 created');
  check('channel: [Jobs] [...] -> channel/Jobs', b.role === 'channel' && b.target.name === 'Jobs');
}

// --- Texts ---------------------------------------------------------------------
{
  const inc = r('Jack Vance sends you a text that reads, "yo."');
  check('text in: sends-a-text -> page "Text: Jack Vance"',
    inc.role === 'page' && inc.target.name === 'Text: Jack Vance' && inc.target.key === 'text: jack vance');
  check('text in: notify page', inc.notify === 'page');

  const out = r('You text, "yo" to Jack Vance.');
  check('text out: same key as incoming', out.target.key === inc.target.key);
  check('text out: no self-notify', out.notify === null);

  const outEmbedded = r('You text, "meet me" to the bar" to Jack Vance.');
  check('text out: message containing \'" to \' still keys on the real recipient',
    outEmbedded.target.name === 'Text: Jack Vance');

  const picIn = r('You receive a picture via text from Jack Vance: http://x/y.png');
  check('text in: picture -> page "Text: Jack Vance", notify page',
    picIn.role === 'page' && picIn.target.name === 'Text: Jack Vance' && picIn.notify === 'page');

  const picOut = r('You send the following picture to Jack Vance: http://x/y.png');
  check('text out: picture -> same key, no self-notify',
    picOut.target.key === inc.target.key && picOut.notify === null);

  // A text tab must never collide with a page tab for the same person.
  const pageKey = r('From afar, Jack Vance(jv) pages: hey').target.key;
  check('text key differs from page key for the same person', inc.target.key !== pageKey);
}

// --- Group texts -----------------------------------------------------------
{
  const inA = r('In a text group chat, Jack texts, "hi"');
  check('group text in: -> page "Text: Group chat", notify page',
    inA.role === 'page' && inA.target.name === 'Text: Group chat' && inA.notify === 'page');

  const inB = r('In a group chat, you receive an image from Jack: http://x');
  check('group text in: picture -> page "Text: Group chat", notify page',
    inB.role === 'page' && inB.target.name === 'Text: Group chat' && inB.notify === 'page');

  const outA = r('In a text group chat, you text, "hi" to Jack and Rook.');
  check('group text out: -> page "Text: Group chat", no self-notify',
    outA.role === 'page' && outA.target.name === 'Text: Group chat' && outA.notify === null);

  const outB = r('In a text group chat, you send the following picture: http://x');
  check('group text out: picture -> page "Text: Group chat", no self-notify',
    outB.role === 'page' && outB.target.name === 'Text: Group chat' && outB.notify === null);

  check('all four group-text forms share one key',
    inA.target.key === inB.target.key && inB.target.key === outA.target.key && outA.target.key === outB.target.key);
}

// --- namePrefix (router.js unit behaviour) ------------------------------------
{
  const rules = [
    { pattern: '^nameFrom (?<who>\\w+)', target: { role: 'page', nameFrom: 'who', namePrefix: 'Text: ' }, notify: null },
    { pattern: '^static line', target: { role: 'page', name: 'Fixed', namePrefix: 'Text: ' }, notify: null },
    { pattern: '^channel \\[(?<channel>[^\\]]+)\\]', target: { role: 'channel', nameFrom: 'channel', namePrefix: 'Pfx: ' }, notify: null },
    { pattern: '^unprefixed (?<who>\\w+)', target: { role: 'page', nameFrom: 'who' }, notify: null },
    { pattern: '^capped', target: { role: 'page', name: 'x'.repeat(250), namePrefix: 'y'.repeat(250) }, notify: null },
  ];
  const pr = createRouter(rules, { channelAliases: { chan: 'Canonical' } });

  const a = pr.route('nameFrom Bob');
  check('namePrefix: applies to nameFrom-derived name', a.target.name === 'Text: Bob');

  const b = pr.route('static line');
  check('namePrefix: applies to a static name', b.target.name === 'Text: Fixed');

  const c = pr.route('channel [chan]');
  check('namePrefix: applies after channel alias resolution', c.target.name === 'Pfx: Canonical');
  check('namePrefix: key reflects the prefixed name', c.target.key === 'pfx: canonical');

  const d = pr.route('unprefixed Bob');
  check('namePrefix: rule without namePrefix is unchanged', d.target.name === 'Bob');

  const e = pr.route('capped');
  check('namePrefix: result capped at 200 chars', e.target.name.length === 200);
}

// --- routing-legacy: preset-aware stock detection -----------------------------
{
  check('isCurrentStock(evenniaRules, "evennia") is true',
    routingLegacy.isCurrentStock(presets.evenniaRules, 'evennia') === true);
  check('isCurrentStock(evenniaRules) (mush default) is false',
    routingLegacy.isCurrentStock(presets.evenniaRules) === false);
  check('isCustomized(familyRules, "evennia") is true',
    routingLegacy.isCustomized(presets.familyRules, 'evennia') === true);
  check('isCustomized(familyRules) (mush default) is false',
    routingLegacy.isCustomized(presets.familyRules) === false);

  const clone = routingLegacy.currentRulesClone('evennia');
  check('currentRulesClone("evennia") deep-equals evenniaRules',
    JSON.stringify(clone) === JSON.stringify(presets.evenniaRules));
  check('currentRulesClone("evennia") is not the same object', clone !== presets.evenniaRules);

  check('normalizePresetId: "evennia" -> evennia', routingLegacy.normalizePresetId('evennia') === 'evennia');
  check('normalizePresetId: "Evennia " (case/whitespace) -> evennia',
    routingLegacy.normalizePresetId('  Evennia  ') === 'evennia');
  check('normalizePresetId: "mush" -> mush', routingLegacy.normalizePresetId('mush') === 'mush');
  check('normalizePresetId: absent -> mush', routingLegacy.normalizePresetId(undefined) === 'mush');
  check('normalizePresetId: garbage -> mush', routingLegacy.normalizePresetId('nonsense') === 'mush');
  check('normalizePresetId: null -> mush', routingLegacy.normalizePresetId(null) === 'mush');

  const withoutPrefix = [{ pattern: '^x', target: { role: 'page', name: 'X' }, notify: null }];
  const withPrefix = [{ pattern: '^x', target: { role: 'page', name: 'X', namePrefix: 'Text: ' }, notify: null }];
  check('serializeRules: differs when only namePrefix differs',
    routingLegacy.serializeRules(withoutPrefix) !== routingLegacy.serializeRules(withPrefix));
}

// --- Sanity: every pattern compiles -------------------------------------------
{
  let allCompile = true;
  for (const rule of presets.evenniaRules) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern);
    } catch (e) {
      allCompile = false;
      console.log('  compile error:', rule.pattern, e.message);
    }
  }
  check('every evenniaRules pattern compiles as a RegExp', allCompile);
}

// --- Why Evennia needs its own preset -----------------------------------------
// The MUSH family's channel rule (`<Name> ...`) would otherwise swallow this
// same line, mis-filing Evennia's room OOC chat as a channel.
{
  const familyRouter = createRouter(presets.familyRules);
  const x = familyRouter.route('<OOC> Jack says, "brb"');
  check('familyRules still routes <OOC> ... as channel/OOC (documents why Evennia needs its own preset)',
    x.role === 'channel' && x.target.name === 'OOC');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL TESTS PASSED');
