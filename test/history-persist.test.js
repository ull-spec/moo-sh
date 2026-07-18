'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadHistorySnapshot,
  saveHistorySnapshotSync,
  createHistoryPersistence,
} = require('../src/main/history-persist');
const { createHistoryStore } = require('../src/main/history-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mush-history-'));
}

test('loadHistorySnapshot() on a missing file returns []', () => {
  const file = path.join(tmpDir(), 'nope.json');
  assert.deepEqual(loadHistorySnapshot(file), []);
});

test('loadHistorySnapshot() on invalid JSON returns []', () => {
  const file = path.join(tmpDir(), 'bad.json');
  fs.writeFileSync(file, 'not json {{{');
  assert.deepEqual(loadHistorySnapshot(file), []);
});

test('loadHistorySnapshot() on a JSON object (not array) returns []', () => {
  const file = path.join(tmpDir(), 'obj.json');
  fs.writeFileSync(file, JSON.stringify({ foo: 'bar' }));
  assert.deepEqual(loadHistorySnapshot(file), []);
});

test('saveHistorySnapshotSync() then loadHistorySnapshot() round-trips pairs', () => {
  const file = path.join(tmpDir(), 'p1.json');
  const pairs = [['k1', [{ seq: 1, text: 'hi' }]], ['k2', [{ seq: 2, text: 'yo' }]]];
  saveHistorySnapshotSync(file, pairs);
  assert.deepEqual(loadHistorySnapshot(file), pairs);
});

test('saveHistorySnapshotSync() creates parent directories that do not yet exist', () => {
  const base = tmpDir();
  const file = path.join(base, 'history', 'sub', 'p1.json');
  const pairs = [['k', [{ seq: 1, text: 'x' }]]];
  saveHistorySnapshotSync(file, pairs);
  assert.deepEqual(loadHistorySnapshot(file), pairs);
});

test('createHistoryPersistence().load() populates the store via restoreProfile', () => {
  const file = path.join(tmpDir(), 'p1.json');
  const pairs = [['page:Amanda', [{ seq: 1, text: 'hi' }, { seq: 2, text: 'there' }]]];
  fs.writeFileSync(file, JSON.stringify(pairs));

  const store = createHistoryStore();
  const persist = createHistoryPersistence({ filePath: file, store, profileId: 'p1' });
  persist.load();

  // The hand-crafted snapshot above predates timestamps (no `ts` field) —
  // restoreProfile() must default those to null, not fabricate a fake one.
  assert.deepEqual(store.get('p1', 'page:Amanda'), [
    { seq: 1, text: 'hi', ts: null },
    { seq: 2, text: 'there', ts: null },
  ]);
});

test('flushNow() synchronously writes the store\'s current contents to disk', () => {
  const file = path.join(tmpDir(), 'p1.json');
  const store = createHistoryStore();
  store.record('p1', 'channel:Public', 'hello world');

  const persist = createHistoryPersistence({ filePath: file, store, profileId: 'p1' });
  persist.flushNow();

  assert.deepEqual(loadHistorySnapshot(file), store.serializeProfile('p1'));
});

test('scheduleFlush() debounces bursts into a single eventual write', async () => {
  const file = path.join(tmpDir(), 'p1.json');
  const store = createHistoryStore();
  const persist = createHistoryPersistence({ filePath: file, store, profileId: 'p1', debounceMs: 20 });

  store.record('p1', 'k', 'line-1');
  persist.scheduleFlush();
  persist.scheduleFlush();
  persist.scheduleFlush();
  store.record('p1', 'k', 'line-2');
  persist.scheduleFlush(); // still coalesced into the same pending timer

  // Nothing should be on disk yet (or at least not reflecting final state).
  assert.deepEqual(loadHistorySnapshot(file), []);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(loadHistorySnapshot(file), store.serializeProfile('p1'));
});

test('flushNow() calls onError instead of throwing when the target path is unwritable', () => {
  const base = tmpDir();
  const blockerFile = path.join(base, 'blocker'); // a FILE, not a directory
  fs.writeFileSync(blockerFile, 'im a file, not a dir');
  const unwritablePath = path.join(blockerFile, 'sub', 'p1.json'); // mkdirSync(dirname) will fail

  const store = createHistoryStore();
  store.record('p1', 'k', 'x');

  let caughtErr = null;
  const persist = createHistoryPersistence({
    filePath: unwritablePath,
    store,
    profileId: 'p1',
    onError: (err) => { caughtErr = err; },
  });

  assert.doesNotThrow(() => persist.flushNow());
  assert.ok(caughtErr, 'expected onError to have been called');
});
