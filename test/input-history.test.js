const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// input-history.js is a browser ES module living under a project whose
// package.json declares "type": "commonjs". A plain import() of the file by
// path is resolved as CommonJS by Node and fails on the `export` syntax.
// Reading the source and importing it as a data: URL with an explicit
// text/javascript MIME type sidesteps that package.json-based module-type
// detection. input-history.js has no imports of its own, so this is safe.
// Mirrors test/sound.test.js.
async function loadInputHistoryModule() {
  const modPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'input-history.js');
  const source = fs.readFileSync(modPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('empty history: up() returns current unchanged, down() does nothing', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  assert.strictEqual(h.up('abc'), 'abc');
  assert.strictEqual(h.down('abc'), 'abc');
  assert.strictEqual(h.size(), 0);
});

test('simple: draft is preserved when browsing back down to it', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('cmd1');
  // user has typed a partial draft, not yet submitted
  assert.strictEqual(h.up('hello wor'), 'cmd1');
  assert.strictEqual(h.down('cmd1'), 'hello wor'); // draft restored
});

test('THE BUG: text typed while already browsing history is preserved on up/down', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('cmdA');
  h.submit('cmdB');

  // First Up: draft (empty) is saved, land on the newest entry.
  assert.strictEqual(h.up(''), 'cmdB');

  // Round-trip down/up without editing carries the value correctly.
  assert.strictEqual(h.down('cmdB'), ''); // draft slot, still empty
  assert.strictEqual(h.up(''), 'cmdB'); // back to the cmdB slot

  // Now the user types over 'cmdB' at this slot, then navigates away and
  // back. The old inline feed.js logic only captured `draft` on the initial
  // transition into history mode and would have discarded this text.
  assert.strictEqual(h.up('hello wor'), 'cmdA');
  assert.strictEqual(h.down('cmdA'), 'hello wor'); // typed text preserved, not lost
  assert.strictEqual(h.down('hello wor'), ''); // draft slot
});

test('submit resets idx so a later up() starts fresh', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('cmdA');
  h.up(''); // now browsing, idx points at 'cmdA'
  h.submit('cmdB'); // submit mid-browse should reset session
  assert.strictEqual(h.size(), 2);
  // Fresh session: up() should land on the newest entry again, not continue
  // from wherever the previous session left off.
  assert.strictEqual(h.up(''), 'cmdB');
});

test('submit() ignores empty input and never pushes an empty entry', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('');
  assert.strictEqual(h.size(), 0);
  h.submit('real');
  h.submit('');
  assert.strictEqual(h.size(), 1);
});

test('submit() caps history at max, dropping oldest entries', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory(2);
  h.submit('one');
  h.submit('two');
  h.submit('three');
  assert.strictEqual(h.size(), 2);
  // 'one' should have been dropped; newest-first walk should hit 'three' then 'two'.
  assert.strictEqual(h.up(''), 'three');
  assert.strictEqual(h.up('three'), 'two');
});

test('deep round-trip: edits at multiple slots all survive walking away and back', async () => {
  // Simulates the reported real-world sequence more closely: a longer
  // history, editing text at more than one slot during a single browsing
  // session, walking further away from each edit (not just one step), and
  // confirming every edited slot's text reappears exactly, not just the
  // most-recently-touched one.
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('cmdA');
  h.submit('cmdB');
  h.submit('cmdC');

  // Walk all the way up to the oldest entry, rewriting the box by hand at
  // each stop along the way (as if the user paused and typed at each slot).
  assert.strictEqual(h.up(''), 'cmdC'); // idx -> cmdC (newest)
  assert.strictEqual(h.up('edited-C'), 'cmdB'); // idx -> cmdB, saved edited-C at cmdC's slot
  assert.strictEqual(h.up('edited-B'), 'cmdA'); // idx -> cmdA, saved edited-B at cmdB's slot
  assert.strictEqual(h.up('cmdA'), 'cmdA'); // already oldest; Up again is a no-op position-wise

  // Now walk all the way back down, confirming every edited slot restores.
  assert.strictEqual(h.down('cmdA'), 'edited-B'); // idx -> cmdB slot
  assert.strictEqual(h.down('edited-B'), 'edited-C'); // idx -> cmdC slot
  assert.strictEqual(h.down('edited-C'), ''); // idx -> draft slot, original empty draft
});

test('draft edited mid-session is preserved even after visiting multiple history slots', async () => {
  // The exact shape of the user's bug report: typing a partial line, going
  // Up into history more than once, then coming back Down all the way to
  // the bottom must restore the originally-typed draft, not an empty string
  // or a stale intermediate value.
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('look');
  h.submit('inventory');

  const draft = 'say hello there everyo';
  assert.strictEqual(h.up(draft), 'inventory'); // draft slot now holds `draft`
  assert.strictEqual(h.up('inventory'), 'look'); // walk further back, unedited
  assert.strictEqual(h.down('look'), 'inventory'); // walk back down, unedited
  assert.strictEqual(h.down('inventory'), draft); // back at the bottom: original draft intact
});

test('reset() clears an in-progress browsing session', async () => {
  const { createInputHistory } = await loadInputHistoryModule();
  const h = createInputHistory();
  h.submit('cmdA');
  h.up(''); // now browsing, idx points at 'cmdA'
  h.reset();
  // A fresh up() after reset() must start a brand-new session at the draft
  // slot again, not continue from wherever reset() was called.
  assert.strictEqual(h.up('typing again'), 'cmdA');
  assert.strictEqual(h.down('cmdA'), 'typing again');
});
