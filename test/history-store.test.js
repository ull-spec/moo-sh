'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHistoryStore } = require('../src/main/history-store');

test('record() then get() returns [{seq,text,ts}] with text preserved verbatim', () => {
  const store = createHistoryStore();
  const text = '\x1b[2m── Amanda ──\x1b[0m paged: hi there';
  const before = Date.now();
  const seq = store.record('p1', 'page:Amanda', text);
  const after = Date.now();
  assert.equal(typeof seq, 'number');
  const got = store.get('p1', 'page:Amanda');
  assert.equal(got.length, 1);
  assert.equal(got[0].seq, seq);
  assert.equal(got[0].text, text);
  assert.ok(got[0].ts >= before && got[0].ts <= after);
});

test('record() accepts an explicit ts, overriding Date.now()', () => {
  const store = createHistoryStore();
  const seq = store.record('p1', 'k', 'x', 12345);
  assert.deepEqual(store.get('p1', 'k'), [{ seq, text: 'x', ts: 12345 }]);
});

test('record() with ts explicitly null opts a line out of timestamping (e.g. a page divider)', () => {
  const store = createHistoryStore();
  const seq = store.record('p1', 'k', 'x', null);
  assert.deepEqual(store.get('p1', 'k'), [{ seq, text: 'x', ts: null }]);
  // The opt-out survives a serialize/restore round-trip, not just live get().
  const pairs = store.serializeProfile('p1');
  const store2 = createHistoryStore();
  store2.restoreProfile('p1', pairs);
  assert.deepEqual(store2.get('p1', 'k'), [{ seq, text: 'x', ts: null }]);
});

test('seq is strictly increasing across successive records', () => {
  const store = createHistoryStore();
  const s1 = store.record('p1', 'k', 'a');
  const s2 = store.record('p1', 'k', 'b');
  const s3 = store.record('p1', 'other', 'c'); // increments even across keys
  assert.ok(s1 < s2, `${s1} < ${s2}`);
  assert.ok(s2 < s3, `${s2} < ${s3}`);
});

test('record() returns null for a nullish profileId or key', () => {
  const store = createHistoryStore();
  assert.equal(store.record(null, 'k', 'x'), null);
  assert.equal(store.record('p1', null, 'x'), null);
});

test('per-profile isolation: record under a, get under b returns []', () => {
  const store = createHistoryStore();
  store.record('a', 'k', 'hello');
  assert.deepEqual(store.get('b', 'k'), []);
});

test('per-key isolation within a profile', () => {
  const store = createHistoryStore();
  store.record('p1', 'page:Amanda', 'one');
  store.record('p1', 'channel:Public', 'two');
  assert.deepEqual(store.get('p1', 'page:Amanda').map((e) => e.text), ['one']);
  assert.deepEqual(store.get('p1', 'channel:Public').map((e) => e.text), ['two']);
});

test('cap eviction: get length == cap and oldest are evicted (most-recent tail retained)', () => {
  const store = createHistoryStore({ maxLines: 3 });
  const seqs = [];
  for (let i = 0; i < 6; i++) {
    seqs.push(store.record('p1', 'k', `line-${i}`));
  }
  const got = store.get('p1', 'k');
  assert.equal(got.length, 3);
  // The retained entries are the most-recent tail: lines 3,4,5.
  assert.deepEqual(got.map((e) => e.text), ['line-3', 'line-4', 'line-5']);
  assert.deepEqual(got.map((e) => e.seq), [seqs[3], seqs[4], seqs[5]]);
});

test('get() on unknown profile or key returns []', () => {
  const store = createHistoryStore();
  assert.deepEqual(store.get('nope', 'k'), []);
  store.record('p1', 'k', 'x');
  assert.deepEqual(store.get('p1', 'missing'), []);
});

test('get() returns a copy: mutating it does not change a subsequent get', () => {
  const store = createHistoryStore();
  store.record('p1', 'k', 'x');
  const first = store.get('p1', 'k');
  first.push({ seq: 999, text: 'injected' });
  first[0].seq = -1; // mutating the array; entry object identity is shared but length is what we assert
  assert.equal(store.get('p1', 'k').length, 1);
});

test('clear(profileId) empties only that profile; clear() empties all', () => {
  const store = createHistoryStore();
  store.record('a', 'k', 'x');
  store.record('b', 'k', 'y');
  store.clear('a');
  assert.deepEqual(store.get('a', 'k'), []);
  assert.deepEqual(store.get('b', 'k').map((e) => e.text), ['y']);
  store.clear();
  assert.deepEqual(store.get('b', 'k'), []);
});

test('per-profile key cap: creating a 4th distinct key evicts the least-recently-used (k0)', () => {
  const store = createHistoryStore({ maxKeys: 3 });
  store.record('p1', 'k0', 'a');
  store.record('p1', 'k1', 'b');
  store.record('p1', 'k2', 'c');
  store.record('p1', 'k3', 'd'); // exceeds cap of 3 distinct keys -> evicts k0
  assert.deepEqual(store.get('p1', 'k0'), []);
  assert.deepEqual(store.get('p1', 'k1').map((e) => e.text), ['b']);
  assert.deepEqual(store.get('p1', 'k2').map((e) => e.text), ['c']);
  assert.deepEqual(store.get('p1', 'k3').map((e) => e.text), ['d']);
});

test('per-profile key cap is LRU-by-touch, not LRU-by-creation-order', () => {
  const store = createHistoryStore({ maxKeys: 3 });
  store.record('p1', 'k0', 'a');
  store.record('p1', 'k1', 'b');
  store.record('p1', 'k2', 'c');
  store.record('p1', 'k0', 'a2'); // touch k0 again -> k0 becomes most-recently-used
  store.record('p1', 'k3', 'd'); // exceeds cap -> k1 is now least-recently-used, gets evicted
  assert.deepEqual(store.get('p1', 'k1'), []);
  assert.deepEqual(store.get('p1', 'k0').map((e) => e.text), ['a', 'a2']);
  assert.deepEqual(store.get('p1', 'k2').map((e) => e.text), ['c']);
  assert.deepEqual(store.get('p1', 'k3').map((e) => e.text), ['d']);
});

test('serializeProfile() on an empty/unknown profile returns []', () => {
  const store = createHistoryStore();
  assert.deepEqual(store.serializeProfile('nope'), []);
});

test('serializeProfile() reflects recorded keys/entries in touch (LRU) order', () => {
  const store = createHistoryStore();
  const s1 = store.record('p1', 'k1', 'a');
  const s2 = store.record('p1', 'k2', 'b');
  const s3 = store.record('p1', 'k1', 'c'); // re-touch k1 -> moves to MRU end
  const pairs = store.serializeProfile('p1');
  // Strip the (nondeterministic, wall-clock) ts before asserting shape/order.
  const stripped = pairs.map(([k, arr]) => [k, arr.map(({ seq, text }) => ({ seq, text }))]);
  assert.deepEqual(stripped, [
    ['k2', [{ seq: s2, text: 'b' }]],
    ['k1', [{ seq: s1, text: 'a' }, { seq: s3, text: 'c' }]],
  ]);
});

test('serializeProfile() -> restoreProfile() round-trips entries into a second store', () => {
  const store1 = createHistoryStore();
  store1.record('p1', 'page:Amanda', 'hi');
  store1.record('p1', 'channel:Public', 'yo');
  store1.record('p1', 'page:Amanda', 'again');
  const pairs = store1.serializeProfile('p1');

  const store2 = createHistoryStore();
  store2.restoreProfile('p1', pairs);
  assert.deepEqual(store2.get('p1', 'page:Amanda'), store1.get('p1', 'page:Amanda'));
  assert.deepEqual(store2.get('p1', 'channel:Public'), store1.get('p1', 'channel:Public'));
});

test('restoreProfile() bumps seqCounter so a subsequent record() never collides with restored seqs', () => {
  const store = createHistoryStore();
  const pairs = [
    ['k', [{ seq: 500, text: 'a' }, { seq: 501, text: 'b' }, { seq: 502, text: 'c' }]],
  ];
  store.restoreProfile('p1', pairs);
  const nextSeq = store.record('p1', 'k', 'new-line');
  assert.ok(nextSeq > 502, `expected ${nextSeq} > 502`);
});

test('restoreProfile() respects maxLines: only the tail survives', () => {
  const store = createHistoryStore({ maxLines: 3 });
  const pairs = [
    [
      'k',
      [0, 1, 2, 3, 4, 5].map((i) => ({ seq: i + 1, text: `line-${i}` })),
    ],
  ];
  store.restoreProfile('p1', pairs);
  const got = store.get('p1', 'k');
  assert.deepEqual(got.map((e) => e.text), ['line-3', 'line-4', 'line-5']);
});

test('restoreProfile() respects maxKeys: only the last-inserted keys survive', () => {
  const store = createHistoryStore({ maxKeys: 2 });
  const pairs = [
    ['k0', [{ seq: 1, text: 'a' }]],
    ['k1', [{ seq: 2, text: 'b' }]],
    ['k2', [{ seq: 3, text: 'c' }]],
  ];
  store.restoreProfile('p1', pairs);
  assert.deepEqual(store.get('p1', 'k0'), []);
  assert.deepEqual(store.get('p1', 'k1').map((e) => e.text), ['b']);
  assert.deepEqual(store.get('p1', 'k2').map((e) => e.text), ['c']);
});

test('restoreProfile() never throws on malformed input and skips garbage entries', () => {
  const store = createHistoryStore();
  assert.doesNotThrow(() => store.restoreProfile('p1', null));
  assert.doesNotThrow(() => store.restoreProfile('p1', undefined));
  assert.doesNotThrow(() => store.restoreProfile('p1', 'not-an-array'));
  assert.doesNotThrow(() => store.restoreProfile('p1', [123]));
  assert.doesNotThrow(() => store.restoreProfile('p1', [['key', 'not-an-array']]));
  assert.doesNotThrow(() => store.restoreProfile('p1', [['key', [{ text: 'no seq' }]]]));
  assert.doesNotThrow(() => store.restoreProfile('p1', [[null, []]]));

  // None of the above should have left any usable data behind.
  assert.deepEqual(store.get('p1', 'key'), []);

  // Also confirm a profileId of null/undefined is a true no-op (does not throw
  // and does not create a 'null'/'undefined' profile entry).
  assert.doesNotThrow(() => store.restoreProfile(null, [['k', [{ seq: 1, text: 'x' }]]]));
  assert.doesNotThrow(() => store.restoreProfile(undefined, [['k', [{ seq: 1, text: 'x' }]]]));
});
