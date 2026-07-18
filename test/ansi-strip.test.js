'use strict';

/*
 * stripAnsi routing-path tests — plain Node, no framework.
 * Run: node test/ansi-strip.test.js
 * Exits non-zero if any assertion fails.
 *
 * Covers a 2026-07-12 capture bug: the server wraps the channel
 * tag's `[`, name, and `]` EACH in their own SGR color codes, so the line
 * starts with an ESC byte and the channel rule's `^\[` anchor never fires.
 * Routing must therefore classify a stripped copy of the line.
 */

const { stripAnsi } = require('../src/common/ansi');
const { createRouter } = require('../src/main/router');
const { channelRules } = require('../src/main/routing-presets');

let failures = 0;

function ok(cond, name) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failures++;
    console.log('FAIL: ' + name);
  }
}

// The real captured Cam+Anarchs line, byte-for-byte.
const CAM_RAW =
  '\x1b[35m[\x1b[0m\x1b[35mCam+Anarchs\x1b[0m\x1b[35m]\x1b[0m Failure Riley says, "o//"\x1b[0m';
const CAM_CLEAN = '[Cam+Anarchs] Failure Riley says, "o//"';

// --- stripAnsi unit ----------------------------------------------------------
ok(stripAnsi('plain text, no escapes') === 'plain text, no escapes',
  'plain text passes through unchanged');
ok(stripAnsi('\x1b[35mpurple\x1b[0m') === 'purple',
  'single SGR open+reset stripped');
ok(stripAnsi('\x1b[1mbold\x1b[0m \x1b[36mcyan\x1b[0m') === 'bold cyan',
  'bold and cyan SGR codes stripped');
ok(stripAnsi('\x1b[2m\x1b[38;2;232;163;61mamber\x1b[0m') === 'amber',
  'dim + truecolor SGR codes stripped');
ok(stripAnsi(CAM_RAW) === CAM_CLEAN,
  'real Cam+Anarchs capture strips to clean channel line');
ok(stripAnsi(null) === '' && stripAnsi(undefined) === '',
  'null/undefined return empty string');

// --- Routing integration -----------------------------------------------------
// The real channelRules preset, as index.js wires it. The raw (colored) line
// must NOT match — that IS the bug — while the stripped copy must route to the
// Cam+Anarchs channel tab.
const router = createRouter(channelRules, { channelAliases: {} });

const rawResult = router.route(CAM_RAW);
ok(rawResult.role !== 'channel',
  'unstripped colored line does NOT match the channel rule (documents the bug)');

const cleanResult = router.route(stripAnsi(CAM_RAW));
ok(cleanResult.role === 'channel',
  'stripped line routes with role channel');
ok(cleanResult.target && cleanResult.target.name === 'Cam+Anarchs',
  'stripped line routes to target name Cam+Anarchs');

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nAll ansi-strip tests passed.');
}
