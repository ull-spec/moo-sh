const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// color.js is a browser ES module living under a project whose package.json
// declares "type": "commonjs". A plain import() of the file by path is
// resolved as CommonJS by Node and fails on the `export` syntax. Reading the
// source and importing it as a data: URL with an explicit text/javascript MIME
// type sidesteps that package.json-based module-type detection. color.js has
// no imports of its own, so this is safe. Mirrors test/font.test.js.
async function loadColorModule() {
  const colorPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'color.js');
  const source = fs.readFileSync(colorPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('isHexColor()', async () => {
  const { isHexColor } = await loadColorModule();
  // Valid.
  assert.strictEqual(isHexColor('#12141a'), true);
  assert.strictEqual(isHexColor('#FFFFFF'), true);
  assert.strictEqual(isHexColor('#abcdef'), true);
  // Invalid.
  assert.strictEqual(isHexColor('#abc'), false);            // short
  assert.strictEqual(isHexColor('#1234567'), false);        // too long
  assert.strictEqual(isHexColor('12141a'), false);           // no #
  assert.strictEqual(isHexColor('#12g41a'), false);          // bad char
  assert.strictEqual(isHexColor('red'), false);
  assert.strictEqual(isHexColor('javascript:alert(1)'), false);
  assert.strictEqual(isHexColor('#12141a; }body{background:url(x)}'), false); // injection attempt
  assert.strictEqual(isHexColor(''), false);
  assert.strictEqual(isHexColor(null), false);
  assert.strictEqual(isHexColor(undefined), false);
});

test('DEFAULT_COLORS', async () => {
  const { DEFAULT_COLORS, COLOR_KEYS, isHexColor } = await loadColorModule();
  for (const key of COLOR_KEYS) {
    assert.strictEqual(isHexColor(DEFAULT_COLORS[key]), true, `DEFAULT_COLORS.${key} should be a valid hex color`);
  }
  assert.deepStrictEqual(Object.keys(DEFAULT_COLORS).sort(), [...COLOR_KEYS].sort());
});

test('COLOR_KEYS / COLOR_VARS', async () => {
  const { COLOR_KEYS, COLOR_VARS } = await loadColorModule();
  assert.strictEqual(COLOR_KEYS.length, 6);
  for (const key of COLOR_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(COLOR_VARS, key), `COLOR_VARS should have an entry for ${key}`);
  }
});
