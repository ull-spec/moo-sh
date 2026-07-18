'use strict';

/*
 * storage.js unit test — validates the one-time, idempotent legacy ->
 * userData profile migration (migrateProfiles). Node's built-in test runner,
 * temp dirs via fs.mkdtempSync (same pattern as test/logins.test.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { migrateProfiles } = require('../src/main/storage');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('migrates when userData dir is empty/absent and legacy has .json files', () => {
  const legacy = mkTmp('mush-storage-legacy-');
  const userData = path.join(mkTmp('mush-storage-user-'), 'profiles'); // absent subdir

  fs.writeFileSync(path.join(legacy, 'a.json'), JSON.stringify({ id: 'a' }), 'utf8');
  fs.writeFileSync(path.join(legacy, 'b.json'), JSON.stringify({ id: 'b' }), 'utf8');

  const copied = migrateProfiles(legacy, userData);

  assert.deepEqual(copied.sort(), ['a.json', 'b.json']);
  assert.ok(fs.existsSync(path.join(userData, 'a.json')));
  assert.ok(fs.existsSync(path.join(userData, 'b.json')));
  // Originals still present (copy, not move).
  assert.ok(fs.existsSync(path.join(legacy, 'a.json')));
  assert.ok(fs.existsSync(path.join(legacy, 'b.json')));

  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(path.dirname(userData), { recursive: true, force: true });
});

test('no-op when userData dir already has a .json (never overwrites)', () => {
  const legacy = mkTmp('mush-storage-legacy-');
  const userData = mkTmp('mush-storage-user-');

  fs.writeFileSync(path.join(userData, 'existing.json'), JSON.stringify({ id: 'existing' }), 'utf8');
  fs.writeFileSync(path.join(legacy, 'other.json'), JSON.stringify({ id: 'other' }), 'utf8');

  const copied = migrateProfiles(legacy, userData);

  assert.deepEqual(copied, []);
  assert.ok(!fs.existsSync(path.join(userData, 'other.json')));

  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

test('no-op when legacyDir does not exist', () => {
  const userData = path.join(mkTmp('mush-storage-user-'), 'profiles');
  const missingLegacy = path.join(os.tmpdir(), 'mush-storage-does-not-exist-' + Date.now());

  const copied = migrateProfiles(missingLegacy, userData);

  assert.deepEqual(copied, []);
  assert.ok(!fs.existsSync(userData));

  fs.rmSync(path.dirname(userData), { recursive: true, force: true });
});

test('never throws on garbage input', () => {
  assert.deepEqual(migrateProfiles(null, null), []);
  assert.deepEqual(migrateProfiles(undefined, undefined), []);
  assert.deepEqual(migrateProfiles(123, {}), []);
  assert.deepEqual(migrateProfiles('/some/legacy', null), []);
});

test('one failed copy does not abort migrating the rest of the batch', () => {
  const legacy = mkTmp('mush-storage-legacy-');
  const userData = path.join(mkTmp('mush-storage-user-'), 'profiles'); // absent subdir, so the "already has files" guard does not apply

  fs.writeFileSync(path.join(legacy, 'a.json'), JSON.stringify({ id: 'a' }), 'utf8');
  fs.mkdirSync(path.join(legacy, 'b.json')); // a DIRECTORY named b.json — forces copyFileSync to throw for this entry
  fs.writeFileSync(path.join(legacy, 'c.json'), JSON.stringify({ id: 'c' }), 'utf8');

  const copied = migrateProfiles(legacy, userData);

  assert.deepEqual(copied.sort(), ['a.json', 'c.json']); // b.json failed, a and c still succeeded
  assert.ok(fs.existsSync(path.join(userData, 'a.json')));
  assert.ok(fs.existsSync(path.join(userData, 'c.json')));
  assert.ok(!fs.existsSync(path.join(userData, 'b.json'))); // never copied (source was a directory)

  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(path.dirname(userData), { recursive: true, force: true });
});
