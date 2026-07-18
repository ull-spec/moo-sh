const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// resizer.js is a browser ES module living under a project whose
// package.json declares "type": "commonjs". A plain `import()` of the file
// by path (even via pathToFileURL) is resolved as CommonJS by Node and
// fails on the `export` syntax, regardless of how this test file itself is
// loaded — see test/phase1-ansi.test.js for the same issue with ansi.js.
// Reading the source and importing it as a data: URL with an explicit
// text/javascript MIME type sidesteps that package.json-based module-type
// detection. resizer.js has no imports of its own, so this is safe.
async function loadResizerModule() {
  const resizerPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'resizer.js');
  const source = fs.readFileSync(resizerPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('resizer clamp()', async () => {
  const { clamp } = await loadResizerModule();
  assert.strictEqual(clamp(5, 0, 10), 5);
  assert.strictEqual(clamp(-3, 0, 10), 0);
  assert.strictEqual(clamp(50, 0, 10), 10);
  assert.strictEqual(clamp(5, 10, 0), 10);          // max < min -> min
  assert.strictEqual(clamp(5, 0, Infinity), 5);     // unbounded max
});
