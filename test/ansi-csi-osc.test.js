'use strict';

// Regression tests for two bugs fixed together:
//   Bug 1 (M2): the renderer's scanCsi() treated any letter as the CSI final
//     byte instead of the full 0x40-0x7E range, so a CSI like `\x1b[2~`
//     (Delete/Home/End key playback) would eat past the `~` and swallow real
//     displayed text looking for the next letter.
//   Bug 2 (L1): OSC (Operating System Command) sequences (`ESC ] ... BEL` or
//     `ESC ] ... ESC \`) were not recognized by either ansi.js and leaked
//     into visible/routed text as literal garbage bytes.
//
// src/renderer/shared/ansi.js is a browser ES module living under a project
// whose package.json declares "type": "commonjs", so a top-level `import` of
// it from this file would fail. Loaded via the same dynamic-import()-via-
// data-URL pattern used in test/phase1-ansi.test.js and
// test/ansi-runcap.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { stripAnsi: stripAnsiCommon } = require('../src/common/ansi');

const ESC = '\x1b';

async function loadRendererAnsiModule() {
  const ansiPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'ansi.js');
  const source = fs.readFileSync(ansiPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

// --- Bug 1 (M2): scanCsi final-byte range ----------------------------------

test('parseAnsi: CSI with ~ final byte (Delete key, \\x1b[2~) does not eat following text', async () => {
  const { parseAnsi } = await loadRendererAnsiModule();
  const runs = parseAnsi(`${ESC}[2~Hello world`);
  const joined = runs.map((r) => r.text).join('');
  assert.equal(joined, 'Hello world');
});

test('stripAnsi (renderer): CSI with ~ final byte does not eat following text', async () => {
  const { stripAnsi } = await loadRendererAnsiModule();
  assert.equal(stripAnsi(`${ESC}[2~Hello world`), 'Hello world');
});

test('parseAnsi/stripAnsi (renderer): other non-letter final bytes (e.g. \\x1b[1~, \\x1b[3~) are also handled', async () => {
  const { parseAnsi, stripAnsi } = await loadRendererAnsiModule();
  assert.equal(stripAnsi(`${ESC}[1~Home text`), 'Home text');
  assert.equal(stripAnsi(`${ESC}[3~Delete text`), 'Delete text');
  const joined = parseAnsi(`${ESC}[3~Delete text`).map((r) => r.text).join('');
  assert.equal(joined, 'Delete text');
});

// --- Bug 2 (L1): OSC sequences ----------------------------------------------

test('OSC terminated by BEL is stripped in src/common/ansi.js stripAnsi', () => {
  const input = `before${ESC}]0;title\x07after`;
  assert.equal(stripAnsiCommon(input), 'beforeafter');
});

test('OSC terminated by BEL is stripped in renderer stripAnsi', async () => {
  const { stripAnsi } = await loadRendererAnsiModule();
  const input = `before${ESC}]0;title\x07after`;
  assert.equal(stripAnsi(input), 'beforeafter');
});

test('OSC terminated by BEL produces no visible run text in renderer parseAnsi', async () => {
  const { parseAnsi } = await loadRendererAnsiModule();
  const input = `before${ESC}]0;title\x07after`;
  const joined = parseAnsi(input).map((r) => r.text).join('');
  assert.equal(joined, 'beforeafter');
});

test('OSC terminated by ST (ESC \\\\) is stripped in src/common/ansi.js stripAnsi', () => {
  const input = `before${ESC}]0;title${ESC}\\after`;
  assert.equal(stripAnsiCommon(input), 'beforeafter');
});

test('OSC terminated by ST (ESC \\\\) is stripped in renderer stripAnsi/parseAnsi', async () => {
  const { parseAnsi, stripAnsi } = await loadRendererAnsiModule();
  const input = `before${ESC}]0;title${ESC}\\after`;
  assert.equal(stripAnsi(input), 'beforeafter');
  const joined = parseAnsi(input).map((r) => r.text).join('');
  assert.equal(joined, 'beforeafter');
});

test('unterminated OSC at end-of-string does not throw/hang and drops the dangling content, in src/common/ansi.js', () => {
  const input = `before${ESC}]0;title`;
  assert.doesNotThrow(() => stripAnsiCommon(input));
  assert.equal(stripAnsiCommon(input), 'before');
});

test('unterminated OSC at end-of-string does not throw/hang and drops the dangling content, in renderer ansi.js', async () => {
  const { parseAnsi, stripAnsi } = await loadRendererAnsiModule();
  const input = `before${ESC}]0;title`;
  assert.doesNotThrow(() => stripAnsi(input));
  assert.equal(stripAnsi(input), 'before');
  assert.doesNotThrow(() => parseAnsi(input));
  const joined = parseAnsi(input).map((r) => r.text).join('');
  assert.equal(joined, 'before');
});

// --- Regression: plain CSI/SGR still works after the scanCsi range fix -----

test('regression: SGR sequences are still parsed correctly after the scanCsi fix', async () => {
  const { parseAnsi, stripAnsi } = await loadRendererAnsiModule();
  const runs = parseAnsi(`${ESC}[1;31mred bold${ESC}[0m plain`);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].style.fontWeight, 'bold');
  assert.equal(runs[0].style.color, '#cd3131');
  assert.deepEqual(runs[1].style, {});
  assert.equal(stripAnsi(`${ESC}[1;31mred bold${ESC}[0m plain`), 'red bold plain');
});

test('regression: src/common/ansi.js CAM_RAW capture still strips byte-for-byte correctly', () => {
  const CAM_RAW =
    '\x1b[35m[\x1b[0m\x1b[35mCam+Anarchs\x1b[0m\x1b[35m]\x1b[0m Failure Riley says, "o//"\x1b[0m';
  const CAM_CLEAN = '[Cam+Anarchs] Failure Riley says, "o//"';
  assert.equal(stripAnsiCommon(CAM_RAW), CAM_CLEAN);
});
