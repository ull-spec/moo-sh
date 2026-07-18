'use strict';

// ansi.js is a browser ES module living under a project whose package.json
// declares "type": "commonjs" (the main process is CommonJS). A plain
// `import()` of the file by path would therefore be resolved as CommonJS by
// Node and fail on the `export` syntax, regardless of how this test file
// itself is loaded. Reading the source and importing it as a data: URL with
// an explicit text/javascript MIME type sidesteps that package.json-based
// module-type detection without needing to add/modify any other project
// file (ansi.js has no imports of its own, so this is safe). Pattern copied
// from test/phase1-ansi.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ESC = '\x1b';

async function loadAnsiModule() {
  const ansiPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'ansi.js');
  const source = fs.readFileSync(ansiPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('MAX_RUNS cap: pathological SGR-toggle-per-character input stays bounded', async () => {
  const { parseAnsi } = await loadAnsiModule();

  let input = '';
  for (let i = 0; i < 5000; i++) {
    input += `${ESC}[31mX${ESC}[32mY`;
  }

  const runs = parseAnsi(input);
  assert.ok(runs.length <= 2048, `expected runs.length <= 2048, got ${runs.length}`);
});

test('MAX_RUNS cap: no text is lost once the cap kicks in', async () => {
  const { parseAnsi, stripAnsi } = await loadAnsiModule();

  let input = '';
  for (let i = 0; i < 5000; i++) {
    input += `${ESC}[31mX${ESC}[32mY`;
  }

  const runs = parseAnsi(input);
  const joined = runs.map((r) => r.text).join('');
  assert.equal(joined, stripAnsi(input));
});

test('normal small input is unaffected by the cap', async () => {
  const { parseAnsi, stripAnsi } = await loadAnsiModule();

  const input = `${ESC}[31mred${ESC}[0m plain`;
  const runs = parseAnsi(input);

  assert.ok(runs.length <= 3, `expected runs.length <= 3, got ${runs.length}`);
  const joined = runs.map((r) => r.text).join('');
  assert.equal(joined, stripAnsi(input));
});
