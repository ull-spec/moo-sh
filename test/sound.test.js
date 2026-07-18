const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// sound.js is a browser ES module living under a project whose package.json
// declares "type": "commonjs". A plain import() of the file by path is
// resolved as CommonJS by Node and fails on the `export` syntax. Reading the
// source and importing it as a data: URL with an explicit text/javascript MIME
// type sidesteps that package.json-based module-type detection. sound.js has
// no imports of its own, so this is safe. Mirrors test/color.test.js.
async function loadSoundModule() {
  const soundPath = path.join(__dirname, '..', 'src', 'renderer', 'shared', 'sound.js');
  const source = fs.readFileSync(soundPath, 'utf8');
  const dataUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
  return import(dataUrl);
}

test('SOUND_EVENTS / DEFAULT_SOUND shape', async () => {
  const { SOUND_EVENTS, DEFAULT_SOUND } = await loadSoundModule();
  assert.deepStrictEqual(SOUND_EVENTS, ['page', 'channel', 'activity']);
  assert.deepStrictEqual(DEFAULT_SOUND, {
    page: true,
    channel: true,
    activity: true,
    pages: [],
    channels: [],
    pageMuted: {},
    channelMuted: {},
  });
});

test('normalizeSound() - undefined/null yields full default shape', async () => {
  const { normalizeSound, DEFAULT_SOUND } = await loadSoundModule();
  assert.deepStrictEqual(normalizeSound(undefined), DEFAULT_SOUND);
  assert.deepStrictEqual(normalizeSound(null), DEFAULT_SOUND);
  assert.deepStrictEqual(normalizeSound({}), DEFAULT_SOUND);
});

test('normalizeSound() - partial input fills missing keys', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({ page: false });
  assert.deepStrictEqual(result, {
    page: false,
    channel: true,
    activity: true,
    pages: [],
    channels: [],
    pageMuted: {},
    channelMuted: {},
  });
});

test('normalizeSound() - explicit false toggles are preserved', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({ page: false, channel: false, activity: false });
  assert.strictEqual(result.page, false);
  assert.strictEqual(result.channel, false);
  assert.strictEqual(result.activity, false);
});

test('normalizeSound() - non-boolean toggle values become true', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({ page: 'yes', channel: 0, activity: 1 });
  assert.strictEqual(result.page, true);
  assert.strictEqual(result.channel, true);
  assert.strictEqual(result.activity, true);
});

test('normalizeSound() - rosters drop empties/non-strings and dedupe preserving order', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({
    pages: ['alice', '', 'bob', 42, null, 'alice', 'carol'],
    channels: [7, 'ooc', 'ooc', '', 'chat'],
  });
  assert.deepStrictEqual(result.pages, ['alice', 'bob', 'carol']);
  assert.deepStrictEqual(result.channels, ['ooc', 'chat']);
});

test('normalizeSound() - non-array roster input becomes []', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({ pages: 'not-an-array', channels: null });
  assert.deepStrictEqual(result.pages, []);
  assert.deepStrictEqual(result.channels, []);
});

test('normalizeSound() - mute maps drop non-true values', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({
    pageMuted: { a: true, b: false, c: 'x', d: 1, e: null },
    channelMuted: { ooc: true, chat: 0 },
  });
  assert.deepStrictEqual(result.pageMuted, { a: true });
  assert.deepStrictEqual(result.channelMuted, { ooc: true });
});

test('normalizeSound() - non-object mute map input becomes {}', async () => {
  const { normalizeSound } = await loadSoundModule();
  const result = normalizeSound({ pageMuted: 'nope', channelMuted: [1, 2] });
  // Arrays are typeof 'object', but should end up with no own true-valued keys.
  assert.deepStrictEqual(result.pageMuted, {});
  assert.deepStrictEqual(result.channelMuted, {});
});

test('normalizeSound() - does not mutate input', async () => {
  const { normalizeSound } = await loadSoundModule();
  const input = {
    page: false,
    pages: ['alice', 'alice', ''],
    pageMuted: { alice: true, bob: false },
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  normalizeSound(input);
  assert.deepStrictEqual(input, snapshot);
});

test('addToRoster() - appends when missing', async () => {
  const { addToRoster } = await loadSoundModule();
  const result = addToRoster(['alice'], 'bob');
  assert.deepStrictEqual(result, ['alice', 'bob']);
});

test('addToRoster() - returns unchanged copy when already present', async () => {
  const { addToRoster } = await loadSoundModule();
  const input = ['alice', 'bob'];
  const result = addToRoster(input, 'bob');
  assert.deepStrictEqual(result, ['alice', 'bob']);
  assert.notStrictEqual(result, input);
});

test('addToRoster() - ignores empty string / non-string name', async () => {
  const { addToRoster } = await loadSoundModule();
  assert.deepStrictEqual(addToRoster(['alice'], ''), ['alice']);
  assert.deepStrictEqual(addToRoster(['alice'], null), ['alice']);
  assert.deepStrictEqual(addToRoster(['alice'], 42), ['alice']);
  assert.deepStrictEqual(addToRoster(['alice'], undefined), ['alice']);
});

test('addToRoster() - treats non-array roster as []', async () => {
  const { addToRoster } = await loadSoundModule();
  assert.deepStrictEqual(addToRoster(null, 'bob'), ['bob']);
  assert.deepStrictEqual(addToRoster(undefined, 'bob'), ['bob']);
  assert.deepStrictEqual(addToRoster('nope', 'bob'), ['bob']);
});

test('addToRoster() - does not mutate input array', async () => {
  const { addToRoster } = await loadSoundModule();
  const input = ['alice'];
  addToRoster(input, 'bob');
  assert.deepStrictEqual(input, ['alice']);
});

test('isMuted() - true only for value strictly true', async () => {
  const { isMuted } = await loadSoundModule();
  assert.strictEqual(isMuted({ alice: true }, 'alice'), true);
  assert.strictEqual(isMuted({ alice: 'true' }, 'alice'), false);
  assert.strictEqual(isMuted({ alice: 1 }, 'alice'), false);
});

test('isMuted() - false for missing key, non-object map, value false', async () => {
  const { isMuted } = await loadSoundModule();
  assert.strictEqual(isMuted({}, 'alice'), false);
  assert.strictEqual(isMuted({ bob: true }, 'alice'), false);
  assert.strictEqual(isMuted(null, 'alice'), false);
  assert.strictEqual(isMuted(undefined, 'alice'), false);
  assert.strictEqual(isMuted('nope', 'alice'), false);
  assert.strictEqual(isMuted({ alice: false }, 'alice'), false);
});

test('setMuted() - sets true', async () => {
  const { setMuted } = await loadSoundModule();
  const result = setMuted({}, 'alice', true);
  assert.deepStrictEqual(result, { alice: true });
});

test('setMuted() - unmuting deletes the key entirely', async () => {
  const { setMuted } = await loadSoundModule();
  const result = setMuted({ alice: true, bob: true }, 'alice', false);
  assert.deepStrictEqual(result, { bob: true });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'alice'), false);
});

test('setMuted() - never stores false', async () => {
  const { setMuted } = await loadSoundModule();
  const result = setMuted({}, 'alice', false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'alice'), false);
  assert.deepStrictEqual(result, {});
});

test('setMuted() - ignores non-string/empty name, returns copy unchanged', async () => {
  const { setMuted } = await loadSoundModule();
  const input = { alice: true };
  assert.deepStrictEqual(setMuted(input, '', true), { alice: true });
  assert.deepStrictEqual(setMuted(input, null, true), { alice: true });
  assert.deepStrictEqual(setMuted(input, 42, true), { alice: true });
});

test('setMuted() - does not mutate input map', async () => {
  const { setMuted } = await loadSoundModule();
  const input = { alice: true };
  setMuted(input, 'bob', true);
  setMuted(input, 'alice', false);
  assert.deepStrictEqual(input, { alice: true });
});

test('setMuted() - treats non-object map as {}', async () => {
  const { setMuted } = await loadSoundModule();
  assert.deepStrictEqual(setMuted(null, 'alice', true), { alice: true });
  assert.deepStrictEqual(setMuted(undefined, 'alice', true), { alice: true });
});

test('soundEnabledFor() - page honors global toggle and per-name mute', async () => {
  const { soundEnabledFor } = await loadSoundModule();
  const sound = { page: true, pageMuted: { alice: true } };
  assert.strictEqual(soundEnabledFor(sound, 'page', 'bob'), true);
  assert.strictEqual(soundEnabledFor(sound, 'page', 'alice'), false);
  const soundOff = { page: false, pageMuted: {} };
  assert.strictEqual(soundEnabledFor(soundOff, 'page', 'bob'), false);
});

test('soundEnabledFor() - channel honors global toggle and per-name mute', async () => {
  const { soundEnabledFor } = await loadSoundModule();
  const sound = { channel: true, channelMuted: { ooc: true } };
  assert.strictEqual(soundEnabledFor(sound, 'channel', 'chat'), true);
  assert.strictEqual(soundEnabledFor(sound, 'channel', 'ooc'), false);
  const soundOff = { channel: false, channelMuted: {} };
  assert.strictEqual(soundEnabledFor(soundOff, 'channel', 'chat'), false);
});

test('soundEnabledFor() - activity honors only the global toggle', async () => {
  const { soundEnabledFor } = await loadSoundModule();
  assert.strictEqual(soundEnabledFor({ activity: true }, 'activity', 'anything'), true);
  assert.strictEqual(soundEnabledFor({ activity: false }, 'activity', 'anything'), false);
  assert.strictEqual(soundEnabledFor({ activity: true }, 'activity'), true);
});

test('soundEnabledFor() - unknown kind returns false', async () => {
  const { soundEnabledFor } = await loadSoundModule();
  assert.strictEqual(soundEnabledFor({ page: true, channel: true, activity: true }, 'bogus', 'x'), false);
});
