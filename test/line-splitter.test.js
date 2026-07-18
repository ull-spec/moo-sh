'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLineSplitter } = require('../src/main/line-splitter');

function toStrings(bufs) {
  return bufs.map((b) => b.toString('latin1'));
}

test('basic: splits complete lines and retains an incomplete trailing line', () => {
  const splitter = createLineSplitter();
  const lines = splitter.push(Buffer.from('a\nb\n'));
  assert.deepEqual(toStrings(lines), ['a', 'b']);

  const partial = splitter.push(Buffer.from('c'));
  assert.deepEqual(partial, []);

  const completed = splitter.push(Buffer.from('d\n'));
  assert.deepEqual(toStrings(completed), ['cd']);
});

test('CR retained: trailing \\r is left in the returned line bytes', () => {
  const splitter = createLineSplitter();
  const lines = splitter.push(Buffer.from('x\r\n'));
  assert.equal(lines.length, 1);
  assert.ok(Buffer.compare(lines[0], Buffer.from('x\r')) === 0);
});

test('chunk boundary: a line split across two push() calls is reassembled', () => {
  const splitter = createLineSplitter();
  const first = splitter.push(Buffer.from('hel'));
  assert.deepEqual(first, []);

  const second = splitter.push(Buffer.from('lo\n'));
  assert.deepEqual(toStrings(second), ['hello']);
});

test('multiple lines in one push are returned in order', () => {
  const splitter = createLineSplitter();
  const lines = splitter.push(Buffer.from('one\ntwo\nthree\n'));
  assert.deepEqual(toStrings(lines), ['one', 'two', 'three']);
});

test('empty push returns an empty array', () => {
  const splitter = createLineSplitter();
  const lines = splitter.push(Buffer.alloc(0));
  assert.deepEqual(lines, []);
});

test('maxLine truncation: an overlong line is truncated to maxLine bytes', () => {
  const splitter = createLineSplitter({ maxLine: 4 });
  const lines = splitter.push(Buffer.from('0123456789\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 4);
  assert.ok(Buffer.compare(lines[0], Buffer.from('0123')) === 0);
});

test('maxAcc overflow: pending bytes with no newline force a boundary and are cleared', () => {
  // maxLine is also capped here so the forced-boundary buffer's length is
  // checkable against a cap (the overflow guard itself only forces a
  // boundary at maxAcc; the emitted buffer's size is bounded by maxLine).
  const splitter = createLineSplitter({ maxAcc: 8, maxLine: 8 });
  const forced = splitter.push(Buffer.from('01234567890123456789')); // 20 bytes, no \n
  assert.ok(Array.isArray(forced));
  assert.ok(forced.length > 0);
  for (const buf of forced) {
    assert.ok(buf.length <= 8);
  }

  // Pending bytes were cleared by the overflow guard, so a later push('\n')
  // must not re-emit any of the old bytes (it just yields an empty line).
  const after = splitter.push(Buffer.from('\n'));
  assert.deepEqual(toStrings(after), ['']);
});

test('reset(): clears pending bytes so a later push() does not include them', () => {
  const splitter = createLineSplitter();
  const partial = splitter.push(Buffer.from('leftover'));
  assert.deepEqual(partial, []);

  splitter.reset();

  const lines = splitter.push(Buffer.from('\n'));
  assert.deepEqual(toStrings(lines), ['']);
});
