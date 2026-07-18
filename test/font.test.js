const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// font.js is a browser ES module living under a project whose package.json
// declares "type": "commonjs". A plain import() of the file by path is
// resolved as CommonJS by Node and fails on the `export` syntax. Reading the
// source and importing it as a data: URL with an explicit text/javascript MIME
// type sidesteps that package.json-based module-type detection. font.js has no
// imports of its own, so this is safe. Mirrors test/resizer-clamp.test.js.
async function loadFontModule() {
  const fontPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'font.js');
  const source = fs.readFileSync(fontPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('sanitizeFontName()', async () => {
  const { sanitizeFontName } = await loadFontModule();
  assert.strictEqual(sanitizeFontName('JetBrains Mono'), 'JetBrains Mono');
  assert.strictEqual(sanitizeFontName('  Fira Code  '), 'Fira Code');
  // Bad chars (" ; { }) stripped — proves CSS-injection chars are removed.
  // `}body{x` collapses to `bodyx` because the removed braces leave no space.
  assert.strictEqual(sanitizeFontName('Evil"; }body{x'), 'Evil bodyx');
  assert.strictEqual(sanitizeFontName(null), '');
});

test('fontFamilyValue()', async () => {
  const { fontFamilyValue } = await loadFontModule();
  assert.strictEqual(fontFamilyValue('JetBrains Mono'), '"JetBrains Mono", monospace');
  assert.strictEqual(fontFamilyValue('monospace'), 'monospace'); // generic keyword unquoted
  assert.strictEqual(fontFamilyValue(''), '');
  assert.strictEqual(fontFamilyValue(null), '');
  // Quotes stripped by sanitize, so the value can't break out of the family.
  assert.strictEqual(fontFamilyValue('Ev"il'), '"Evil", monospace');
});

test('FONT_OPTIONS is a curated, monospace-only list', async () => {
  const { FONT_OPTIONS, DEFAULT_FONT } = await loadFontModule();
  assert.ok(Array.isArray(FONT_OPTIONS));
  assert.ok(FONT_OPTIONS.length > 0);
  const knownMonospace = [
    'JetBrains Mono',
    'JetBrainsMono Nerd Font',
    'DejaVu Sans Mono',
    'Consolas',
    'Cascadia Code',
    'Fira Code',
    'Source Code Pro',
    'monospace',
  ];
  for (const opt of FONT_OPTIONS) {
    assert.ok(typeof opt.value === 'string' && opt.value, 'option has a non-empty value');
    assert.ok(typeof opt.label === 'string' && opt.label, 'option has a non-empty label');
    assert.ok(knownMonospace.includes(opt.value), `${opt.value} is a known monospace family`);
  }
  // No escape hatch: nothing resembling a free-text "Custom..." entry.
  assert.ok(!FONT_OPTIONS.some((opt) => /custom/i.test(opt.value) || /custom/i.test(opt.label)));
  assert.strictEqual(DEFAULT_FONT, FONT_OPTIONS[0].value);
});

test('isCuratedFont()', async () => {
  const { isCuratedFont, FONT_OPTIONS } = await loadFontModule();
  for (const opt of FONT_OPTIONS) {
    assert.strictEqual(isCuratedFont(opt.value), true);
  }
  assert.strictEqual(isCuratedFont('Comic Sans MS'), false);
  assert.strictEqual(isCuratedFont('Arial'), false);
  assert.strictEqual(isCuratedFont(''), false);
  assert.strictEqual(isCuratedFont(null), false);
  assert.strictEqual(isCuratedFont(undefined), false);
});
