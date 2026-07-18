'use strict';

/*
 * Phase 1 core smoke tests — plain Node, no framework.
 * Run: node test/phase1-core.test.js
 * Exits non-zero if any assertion fails.
 */

const path = require('path');
const {
  createTelnetFilter,
  IAC,
  DO,
  DONT,
  WILL,
  WONT,
  SB,
  SE,
  GA,
} = require(path.join(__dirname, '..', 'src', 'main', 'telnet-negotiation'));
const { createRouter } = require(path.join(__dirname, '..', 'src', 'main', 'router'));
const { ROLES, EVENTS } = require(path.join(__dirname, '..', 'src', 'common', 'line-types'));

let failures = 0;

function ok(cond, name) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failures++;
    console.log('FAIL: ' + name);
  }
}

function eqBuf(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}

// ---------------------------------------------------------------------------
// (a) Telnet filter
// ---------------------------------------------------------------------------

// IAC DO 24 (TTYPE) -> reply IAC WONT 24; data has surrounding text only.
{
  const f = createTelnetFilter();
  const OPT = 24;
  const chunk = Buffer.from([0x68, 0x69, IAC, DO, OPT, 0x21]); // "hi" + IAC DO 24 + "!"
  const { data, reply } = f.process(chunk);
  ok(eqBuf(data, Buffer.from([0x68, 0x69, 0x21])), 'IAC DO: data strips the command, keeps "hi!"');
  ok(eqBuf(reply, Buffer.from([IAC, WONT, OPT])), 'IAC DO x -> reply IAC WONT x');
}

// IAC WILL 1 (ECHO) -> reply IAC DONT 1.
{
  const f = createTelnetFilter();
  const OPT = 1;
  const { data, reply } = f.process(Buffer.from([IAC, WILL, OPT, 0x41])); // + "A"
  ok(eqBuf(data, Buffer.from([0x41])), 'IAC WILL: data keeps trailing "A"');
  ok(eqBuf(reply, Buffer.from([IAC, DONT, OPT])), 'IAC WILL x -> reply IAC DONT x');
}

// IAC DONT / IAC WONT -> consumed, no reply.
{
  const f = createTelnetFilter();
  const { data, reply } = f.process(Buffer.from([IAC, DONT, 3, IAC, WONT, 3, 0x5a])); // + "Z"
  ok(eqBuf(data, Buffer.from([0x5a])), 'IAC DONT/WONT: only "Z" survives in data');
  ok(reply.length === 0, 'IAC DONT/WONT: no reply');
}

// IAC IAC -> single literal 0xFF in data.
{
  const f = createTelnetFilter();
  const { data, reply } = f.process(Buffer.from([0x61, IAC, IAC, 0x62])); // "a" 0xFF "b"
  ok(eqBuf(data, Buffer.from([0x61, 0xff, 0x62])), 'IAC IAC -> single 0xFF byte in data');
  ok(reply.length === 0, 'IAC IAC: no reply');
}

// IAC SB ... IAC SE -> whole subnegotiation removed, no reply.
{
  const f = createTelnetFilter();
  const chunk = Buffer.from([0x78, IAC, SB, 24, 0, 65, 66, IAC, SE, 0x79]); // "x" SB...SE "y"
  const { data, reply } = f.process(chunk);
  ok(eqBuf(data, Buffer.from([0x78, 0x79])), 'IAC SB..IAC SE: subnegotiation dropped, "xy" remain');
  ok(reply.length === 0, 'IAC SB..IAC SE: no reply');
}

// IAC GA (single-byte command) -> consumed, no reply.
{
  const f = createTelnetFilter();
  const { data, reply } = f.process(Buffer.from([0x71, IAC, GA, 0x72])); // "q" IAC GA "r"
  ok(eqBuf(data, Buffer.from([0x71, 0x72])), 'IAC GA: single-byte command dropped, "qr" remain');
  ok(reply.length === 0, 'IAC GA: no reply');
}

// Split across two process() calls: IAC DO arrives, option byte next chunk.
{
  const f = createTelnetFilter();
  const OPT = 31; // NAWS
  const r1 = f.process(Buffer.from([0x6f, IAC, DO])); // "o" + IAC DO  (option pending)
  ok(eqBuf(r1.data, Buffer.from([0x6f])), 'split: chunk1 yields "o" only');
  ok(r1.reply.length === 0, 'split: chunk1 has no reply yet (option byte pending)');

  const r2 = f.process(Buffer.from([OPT, 0x6b])); // option byte + "k"
  ok(eqBuf(r2.data, Buffer.from([0x6b])), 'split: chunk2 yields "k"');
  ok(eqBuf(r2.reply, Buffer.from([IAC, WONT, OPT])), 'split: reply IAC WONT x emitted on chunk2');
}

// Split subnegotiation: SB opens in chunk1, SE closes in chunk2.
{
  const f = createTelnetFilter();
  const r1 = f.process(Buffer.from([0x31, IAC, SB, 24, 0])); // "1" + SB start...
  ok(eqBuf(r1.data, Buffer.from([0x31])), 'split SB: chunk1 yields "1", payload buffered');
  const r2 = f.process(Buffer.from([65, IAC, SE, 0x32])); // ...payload IAC SE "2"
  ok(eqBuf(r2.data, Buffer.from([0x32])), 'split SB: chunk2 yields "2" after SE');
  ok(r2.reply.length === 0, 'split SB: no reply');
}

// Lone trailing IAC at end of chunk resumes correctly next chunk.
{
  const f = createTelnetFilter();
  const r1 = f.process(Buffer.from([0x41, IAC])); // "A" + lone IAC
  ok(eqBuf(r1.data, Buffer.from([0x41])), 'lone IAC: chunk1 yields "A", IAC pending');
  const r2 = f.process(Buffer.from([IAC, 0x42])); // IAC (escaped) + "B"
  ok(eqBuf(r2.data, Buffer.from([0xff, 0x42])), 'lone IAC: chunk2 resolves escaped 0xFF then "B"');
}

// ---------------------------------------------------------------------------
// (b) Router
// ---------------------------------------------------------------------------

// Empty rule set: every line falls through to FEED default.
{
  const r = createRouter([]);
  const res = r.route('anything at all');
  ok(res.role === ROLES.FEED, 'empty rules: role is FEED');
  ok(res.target === null, 'empty rules: target is null');
  ok(res.notify === null, 'empty rules: notify is null');
  ok(res.match === null, 'empty rules: match is null');
}

// One sample rule (string pattern) matches and routes to a channel.
{
  const rules = [
    {
      pattern: '^\\[Public\\]\\s+(\\w+)',
      flags: '',
      target: { role: ROLES.CHANNEL, name: 'Public' },
      notify: EVENTS.CHANNEL,
    },
  ];
  const r = createRouter(rules);

  const hit = r.route('[Public] Alecto says hello');
  ok(hit.role === ROLES.CHANNEL, 'sample rule: matched line routes to CHANNEL');
  ok(hit.target && hit.target.name === 'Public', 'sample rule: target name is "Public"');
  ok(hit.notify === EVENTS.CHANNEL, 'sample rule: notify is CHANNEL event');
  ok(hit.match && hit.match[1] === 'Alecto', 'sample rule: capture group 1 is "Alecto"');

  const miss = r.route('a normal feed line');
  ok(miss.role === ROLES.FEED, 'sample rule: non-matching line falls through to FEED');
  ok(miss.match === null, 'sample rule: non-matching line has null match');
}

// setRules replaces the rule set (RegExp pattern this time).
{
  const r = createRouter([]);
  r.setRules([
    { pattern: /^page: /, target: { role: ROLES.PAGE, name: 'inbox' }, notify: EVENTS.PAGE },
  ]);
  const res = r.route('page: from Riley');
  ok(res.role === ROLES.PAGE, 'setRules: new rule takes effect, routes to PAGE');
  ok(res.notify === EVENTS.PAGE, 'setRules: notify is PAGE event');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + ' TEST(S) FAILED');
  process.exit(1);
}
