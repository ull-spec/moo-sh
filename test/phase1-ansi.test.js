'use strict';

// Plain Node script (no test runner/framework) exercising the hand-rolled
// SGR parser in src/renderer/shared/ansi.js. That file is an ES module, and
// this package's package.json declares "type": "commonjs", so we pull it in
// via dynamic import() rather than a top-level `import` statement. Only
// parseAnsi/stripAnsi are exercised here — line-view.js touches `document`
// and has no place in a Node test.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ESC = '\x1b';

// ansi.js is a browser ES module living under a project whose package.json
// declares "type": "commonjs" (the main process is CommonJS). A plain
// `import()` of the file by path would therefore be resolved as CommonJS by
// Node and fail on the `export` syntax, regardless of how this test file
// itself is loaded. Reading the source and importing it as a data: URL with
// an explicit text/javascript MIME type sidesteps that package.json-based
// module-type detection without needing to add/modify any other project
// file (ansi.js has no imports of its own, so this is safe).
async function loadAnsiModule() {
  const ansiPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'ansi.js');
  const source = fs.readFileSync(ansiPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

async function main() {
  const { parseAnsi, stripAnsi } = await loadAnsiModule();

  let failures = 0;
  function check(name, fn) {
    try {
      fn();
      console.log(`PASS: ${name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL: ${name}`);
      console.log(`  ${err.message}`);
    }
  }

  // (a) plain text -> single empty-style run
  check('plain text yields a single run with empty style', () => {
    const runs = parseAnsi('hello world');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].text, 'hello world');
    assert.deepStrictEqual(runs[0].style, {});
  });

  // (b) ESC[31m produces a red `color`
  check('ESC[31m produces a red foreground color', () => {
    const runs = parseAnsi(`${ESC}[31mred text`);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].text, 'red text');
    assert.strictEqual(runs[0].style.color, '#cd3131');
  });

  // (c) ESC[1;32m produces bold + green
  check('ESC[1;32m produces bold + green foreground', () => {
    const runs = parseAnsi(`${ESC}[1;32mgreen bold`);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].style.fontWeight, 'bold');
    assert.strictEqual(runs[0].style.color, '#0dbc79');
  });

  // (d) ESC[38;5;196m produces a red-ish rgb
  check('ESC[38;5;196m (xterm-256) produces a red-ish rgb color', () => {
    const runs = parseAnsi(`${ESC}[38;5;196mxterm red`);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].style.color, 'rgb(255, 0, 0)');
  });

  // (e) ESC[38;2;10;20;30m produces rgb(10, 20, 30) or equivalent
  check('ESC[38;2;10;20;30m (truecolor) produces rgb(10, 20, 30)', () => {
    const runs = parseAnsi(`${ESC}[38;2;10;20;30mtruecolor`);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].style.color, 'rgb(10, 20, 30)');
  });

  // (f) stripAnsi removes all escapes
  check('stripAnsi removes SGR and other CSI escapes', () => {
    const input = `${ESC}[1;31mbold red${ESC}[0m plain ${ESC}[2Ktrailing`;
    const stripped = stripAnsi(input);
    assert.strictEqual(stripped, 'bold red plain trailing');
    assert.ok(!stripped.includes(ESC));
  });

  // A few extra sanity checks on things the spec calls out explicitly.
  check('multiple codes in one escape combine (bold + underline + blue bg)', () => {
    const runs = parseAnsi(`${ESC}[1;4;44mstyled`);
    assert.strictEqual(runs[0].style.fontWeight, 'bold');
    assert.strictEqual(runs[0].style.textDecoration, 'underline');
    assert.strictEqual(runs[0].style.backgroundColor, '#2472c8');
  });

  check('code 2 (dim) maps to opacity 0.7', () => {
    const runs = parseAnsi(`${ESC}[2mdim`);
    assert.strictEqual(runs[0].style.opacity, '0.7');
  });

  check('code 7 (inverse) swaps fg/bg', () => {
    const runs = parseAnsi(`${ESC}[31;44;7mswapped`);
    // fg was red (#cd3131), bg was blue (#2472c8); inverse swaps them.
    assert.strictEqual(runs[0].style.color, '#2472c8');
    assert.strictEqual(runs[0].style.backgroundColor, '#cd3131');
  });

  check('reset (ESC[0m) clears style back to empty', () => {
    const runs = parseAnsi(`${ESC}[1;31mred bold${ESC}[0m plain`);
    assert.strictEqual(runs.length, 2);
    assert.deepStrictEqual(runs[1].style, {});
    assert.strictEqual(runs[1].text, ' plain');
  });

  check('consecutive same-style characters coalesce into one run', () => {
    const runs = parseAnsi(`${ESC}[31ma${ESC}[31mb${ESC}[31mc`);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].text, 'abc');
  });

  check('bright colors (90-97 / 100-107) use the bright palette entries', () => {
    const runs = parseAnsi(`${ESC}[91;103mbright`);
    assert.strictEqual(runs[0].style.color, '#f14c4c');
    assert.strictEqual(runs[0].style.backgroundColor, '#f5f543');
  });

  check('unrecognized SGR codes are ignored without throwing', () => {
    assert.doesNotThrow(() => parseAnsi(`${ESC}[58mweird${ESC}[31mred`));
    const runs = parseAnsi(`${ESC}[58mweird${ESC}[31mred`);
    assert.strictEqual(runs[runs.length - 1].style.color, '#cd3131');
  });

  console.log('');
  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`);
    process.exit(1);
  } else {
    console.log('PASS: all checks passed');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('FAIL: uncaught error running tests');
  console.error(err);
  process.exit(1);
});
