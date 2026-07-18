'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSettings, appendSoundRosterEntry, DEFAULTS } = require('../src/main/settings-store');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mush-settings-')), 'settings.json');
}

test('appendSoundRosterEntry() - appends a new channel name and persists it', () => {
  const file = tmpFile();
  const merged = appendSoundRosterEntry(file, 'channel', 'Cam+Anarchs');
  assert.deepEqual(merged.sound.channels, ['Cam+Anarchs']);
  assert.deepEqual(loadSettings(file).sound.channels, ['Cam+Anarchs']);
});

test('appendSoundRosterEntry() - appends a new page name into pages, not channels', () => {
  const file = tmpFile();
  const merged = appendSoundRosterEntry(file, 'page', 'Amanda');
  assert.deepEqual(merged.sound.pages, ['Amanda']);
  assert.deepEqual(merged.sound.channels, []);
});

test('appendSoundRosterEntry() - is a no-op when the name is already present', () => {
  const file = tmpFile();
  appendSoundRosterEntry(file, 'channel', 'Public');
  const before = fs.readFileSync(file, 'utf8');
  const merged = appendSoundRosterEntry(file, 'channel', 'Public');
  assert.deepEqual(merged.sound.channels, ['Public']);
  assert.equal(fs.readFileSync(file, 'utf8'), before); // did not re-write the file
});

test('appendSoundRosterEntry() - ignores an unknown kind or empty name', () => {
  const file = tmpFile();
  appendSoundRosterEntry(file, 'bogus', 'X');
  appendSoundRosterEntry(file, 'channel', '');
  assert.deepEqual(loadSettings(file).sound, DEFAULTS.sound);
});

test('appendSoundRosterEntry() - preserves sibling sound fields (mute maps, toggles)', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      sound: { page: false, channel: true, activity: true, pages: [], channels: [], pageMuted: { Bob: true }, channelMuted: {} },
    })
  );
  const merged = appendSoundRosterEntry(file, 'page', 'Alice');
  assert.equal(merged.sound.page, false);
  assert.deepEqual(merged.sound.pageMuted, { Bob: true });
  assert.deepEqual(merged.sound.pages, ['Alice']);
});

test('appendSoundRosterEntry() - preserves unrelated top-level settings keys (layout, theme)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, layout: { rightColWidth: 300 }, theme: { fontMono: 'Consolas' } }));
  const merged = appendSoundRosterEntry(file, 'channel', 'Newbie');
  assert.deepEqual(merged.layout, { rightColWidth: 300 });
  assert.deepEqual(merged.theme, { fontMono: 'Consolas' });
});

test('appendSoundRosterEntry() - ignores a name longer than 200 chars (no growth, no rewrite)', () => {
  const file = tmpFile();
  appendSoundRosterEntry(file, 'channel', 'seed'); // establish a baseline file on disk
  const before = fs.readFileSync(file, 'utf8');
  const longName = 'x'.repeat(201);
  const merged = appendSoundRosterEntry(file, 'channel', longName);
  assert.deepEqual(merged.sound.channels, ['seed']);
  assert.equal(fs.readFileSync(file, 'utf8'), before); // did not re-write the file
});

test('appendSoundRosterEntry() - ignores a 201st name once the roster already has 200 entries', () => {
  const file = tmpFile();
  const fullChannels = Array.from({ length: 200 }, (_, i) => `chan${i}`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      sound: { page: true, channel: true, activity: true, pages: [], channels: fullChannels, pageMuted: {}, channelMuted: {} },
    })
  );
  const before = fs.readFileSync(file, 'utf8');
  const merged = appendSoundRosterEntry(file, 'channel', 'chan200');
  assert.equal(merged.sound.channels.length, 200);
  assert.ok(!merged.sound.channels.includes('chan200'));
  assert.equal(fs.readFileSync(file, 'utf8'), before); // did not re-write the file
});
