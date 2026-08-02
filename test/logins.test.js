'use strict';

/*
 * Logins/profile-store unit test — validates the old->new schema migration
 * (autoLoginCommand -> logins[]), real-over-example file resolution, and
 * per-named-login upsert/persist behavior in src/main/profile-store.js.
 *
 * Plain Node, no framework. Exits non-zero on any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeLogins,
  loadProfile,
  discoverProfiles,
  upsertLogin,
  persistLogin,
  setAntiIdle,
  setColor,
  slugify,
  createProfile,
  isHexColor,
  orderProfiles,
} = require('../src/main/profile-store');
const presets = require('../src/main/routing-presets');

let pass = 0;
let fail = 0;
function check(desc, cond) {
  if (cond) {
    pass += 1;
    console.log('PASS: ' + desc);
  } else {
    fail += 1;
    console.log('FAIL: ' + desc);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-'));

// --- 1. Migration: old autoLoginCommand -> logins[Default] ------------------
{
  const profile = { id: 'x', autoLoginCommand: 'connect Mary xxx' };
  normalizeLogins(profile);
  check('migration: logins has one entry',
    Array.isArray(profile.logins) && profile.logins.length === 1);
  check('migration: entry is Default with migrated cmd',
    profile.logins[0].name === 'Default' && profile.logins[0].autoLoginCommand === 'connect Mary xxx');
  check('migration: autoLoginCommand deleted', !('autoLoginCommand' in profile));
}

// --- 2. Migration empty: neither field -> Default with empty cmd -----------
{
  const profile = { id: 'y' };
  normalizeLogins(profile);
  check('migration empty: logins has one entry',
    Array.isArray(profile.logins) && profile.logins.length === 1);
  check('migration empty: Default entry with empty cmd',
    profile.logins[0].name === 'Default' && profile.logins[0].autoLoginCommand === '');
}

// --- 3. New-shape passthrough -----------------------------------------------
{
  const profile = {
    id: 'z',
    logins: [
      { name: 'Mary', autoLoginCommand: 'connect Mary a' },
      { name: 'Alt', autoLoginCommand: 'connect Alt b' },
    ],
    autoLoginCommand: 'should be dropped',
  };
  normalizeLogins(profile);
  check('passthrough: keeps both logins', profile.logins.length === 2);
  check('passthrough: Mary intact', profile.logins[0].name === 'Mary' && profile.logins[0].autoLoginCommand === 'connect Mary a');
  check('passthrough: Alt intact', profile.logins[1].name === 'Alt' && profile.logins[1].autoLoginCommand === 'connect Alt b');
  check('passthrough: autoLoginCommand dropped', !('autoLoginCommand' in profile));
}

// --- 4. Dedupe by name, first wins ------------------------------------------
{
  const profile = {
    id: 'd',
    logins: [
      { name: 'Mary', autoLoginCommand: 'first' },
      { name: 'Mary', autoLoginCommand: 'second' },
    ],
  };
  normalizeLogins(profile);
  check('dedupe: only one Mary survives', profile.logins.length === 1);
  check('dedupe: first occurrence wins', profile.logins[0].autoLoginCommand === 'first');
}

// --- 5. loadProfile real-over-example ---------------------------------------
{
  const realPath = path.join(tmp, 't.json');
  const examplePath = path.join(tmp, 't.example.json');
  fs.writeFileSync(realPath, JSON.stringify({
    id: 't', name: 'T', host: 'h', port: 1,
    logins: [{ name: 'Real', autoLoginCommand: 'connect Real x' }],
  }), 'utf8');
  fs.writeFileSync(examplePath, JSON.stringify({
    id: 't', name: 'T', host: 'h', port: 1,
    autoLoginCommand: 'connect Example y',
  }), 'utf8');

  const p = loadProfile(tmp, 't');
  check('real-over-example: returns real file logins',
    p.logins.length === 1 && p.logins[0].name === 'Real' && p.logins[0].autoLoginCommand === 'connect Real x');
  check('real-over-example: __sourceFile is the real file', p.__sourceFile === realPath);
}

// --- 6. loadProfile example-only migration ----------------------------------
{
  const examplePath = path.join(tmp, 'e.example.json');
  fs.writeFileSync(examplePath, JSON.stringify({
    id: 'e', name: 'E', host: 'h', port: 1,
    autoLoginCommand: 'connect X y',
  }), 'utf8');

  const p = loadProfile(tmp, 'e');
  check('example-only: migrated to logins[Default]',
    p.logins.length === 1 && p.logins[0].name === 'Default' && p.logins[0].autoLoginCommand === 'connect X y');
  check('example-only: __sourceFile is the example file', p.__sourceFile === examplePath);
}

// --- 6b. loadProfile routing defaults ----------------------------------------
{
  // A pre-Phase-2 profile with NO routingRules (and no channelAliases) gets
  // the family preset defaulted in memory — this is what fixes legacy
  // profiles created before this feature existed, without hand-editing them.
  const legacyPath = path.join(tmp, 'legacy.json');
  const legacyContent = JSON.stringify({
    id: 'legacy', name: 'Legacy', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  });
  fs.writeFileSync(legacyPath, legacyContent, 'utf8');

  const p = loadProfile(tmp, 'legacy');
  check('routing default: absent routingRules defaulted to presets.familyRules',
    JSON.stringify(p.routingRules) === JSON.stringify(presets.familyRules));
  check('routing default: defaulted rules are a clone, not the shared preset object',
    p.routingRules !== presets.familyRules);
  check('routing default: file on disk left untouched (in-memory only)',
    fs.readFileSync(legacyPath, 'utf8') === legacyContent);
  check('anti-idle default: absent antiIdle defaulted to false', p.antiIdle === false);

  // A profile that has genuinely opted in must survive a load unchanged —
  // the opt-in default only fills in when the field is absent/non-boolean,
  // never overriding an explicit true.
  const onPath = path.join(tmp, 'anti-on.json');
  fs.writeFileSync(onPath, JSON.stringify({
    id: 'anti-on', name: 'AntiOn', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    antiIdle: true,
  }), 'utf8');
  check('anti-idle explicit true: preserved through loadProfile unchanged',
    loadProfile(tmp, 'anti-on').antiIdle === true);

  // An explicit empty array is a deliberate opt-out and must be respected.
  fs.writeFileSync(path.join(tmp, 'optout.json'), JSON.stringify({
    id: 'optout', name: 'OptOut', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: [],
  }), 'utf8');
  const q = loadProfile(tmp, 'optout');
  check('routing opt-out: explicit routingRules [] preserved, not overwritten',
    Array.isArray(q.routingRules) && q.routingRules.length === 0);

  // Existing custom rules pass through unmodified.
  const customRules = [
    { pattern: '^custom', target: { role: 'feed' }, notify: null },
  ];
  fs.writeFileSync(path.join(tmp, 'custom.json'), JSON.stringify({
    id: 'custom', name: 'Custom', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: customRules,
  }), 'utf8');
  const r = loadProfile(tmp, 'custom');
  check('routing passthrough: existing custom rules kept verbatim',
    JSON.stringify(r.routingRules) === JSON.stringify(customRules));
}

// --- 7. discoverProfiles -----------------------------------------------------
{
  const discTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-disc-'));
  fs.writeFileSync(path.join(discTmp, 'a.json'), JSON.stringify({
    id: 'a', name: 'Alpha', host: 'h1', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');
  fs.writeFileSync(path.join(discTmp, 'a.example.json'), JSON.stringify({
    id: 'a', name: 'Alpha', host: 'h1', port: 1,
    autoLoginCommand: '',
  }), 'utf8');
  fs.writeFileSync(path.join(discTmp, 'b.example.json'), JSON.stringify({
    id: 'b', name: 'Beta', host: 'h2', port: 2,
    autoLoginCommand: 'connect Beta z',
  }), 'utf8');

  const profiles = discoverProfiles(discTmp);
  check('discover: finds 2 profiles (dedup a.json/a.example.json)', profiles.length === 2);
  check('discover: each has a non-empty logins array',
    profiles.every((p) => Array.isArray(p.logins) && p.logins.length > 0));
  check('discover: sorted by name (Alpha before Beta)',
    profiles[0].name === 'Alpha' && profiles[1].name === 'Beta');

  fs.rmSync(discTmp, { recursive: true, force: true });
}

// --- 8. upsertLogin update-in-place ------------------------------------------
{
  const logins = [
    { name: 'Mary', autoLoginCommand: 'old' },
    { name: 'Alt', autoLoginCommand: 'z' },
  ];
  const result = upsertLogin(logins, 'Mary', 'new');
  check('upsert update: Mary updated', result[0].autoLoginCommand === 'new');
  check('upsert update: Alt untouched', result[1].name === 'Alt' && result[1].autoLoginCommand === 'z');
  check('upsert update: length still 2', result.length === 2);
  check('upsert update: order preserved (Mary first)', result[0].name === 'Mary' && result[1].name === 'Alt');
  check('upsert update: returns same array (mutated)', result === logins);
}

// --- 9. upsertLogin append-new -----------------------------------------------
{
  const logins = [
    { name: 'Mary', autoLoginCommand: 'new' },
    { name: 'Alt', autoLoginCommand: 'z' },
  ];
  const result = upsertLogin(logins, 'Bob', 'b');
  check('upsert append: length 3', result.length === 3);
  check('upsert append: Bob appended last',
    result[2].name === 'Bob' && result[2].autoLoginCommand === 'b');
  check('upsert append: Mary/Alt untouched',
    result[0].name === 'Mary' && result[0].autoLoginCommand === 'new' &&
    result[1].name === 'Alt' && result[1].autoLoginCommand === 'z');
}

// --- 10. persistLogin writes new shape to REAL file only --------------------
{
  const examplePath = path.join(tmp, 'p.example.json');
  const exampleContent = JSON.stringify({
    id: 'p', name: 'P', host: 'h', port: 1,
    autoLoginCommand: '',
  }, null, 2);
  fs.writeFileSync(examplePath, exampleContent, 'utf8');

  const merged = persistLogin(tmp, 'p', 'Mary', 'connect Mary pw');

  const realPath = path.join(tmp, 'p.json');
  check('persistLogin: real file now exists', fs.existsSync(realPath));

  const written = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  check('persistLogin: written has logins with Mary entry',
    Array.isArray(written.logins) &&
    written.logins.some((l) => l.name === 'Mary' && l.autoLoginCommand === 'connect Mary pw'));
  check('persistLogin: written also has Default (migrated from example)',
    written.logins.some((l) => l.name === 'Default'));
  check('persistLogin: no top-level autoLoginCommand', !('autoLoginCommand' in written));
  check('persistLogin: no __sourceFile leaked into file', !('__sourceFile' in written));

  const exampleAfter = fs.readFileSync(examplePath, 'utf8');
  check('persistLogin: example file unchanged', exampleAfter === exampleContent);

  check('persistLogin: return value matches written file',
    merged.logins.some((l) => l.name === 'Mary' && l.autoLoginCommand === 'connect Mary pw'));
}

// --- 11. persistLogin no-clobber of existing real file ----------------------
{
  const realPath = path.join(tmp, 'q.json');
  fs.writeFileSync(realPath, JSON.stringify({
    id: 'q', name: 'Q', host: 'h', port: 1,
    logins: [
      { name: 'A', autoLoginCommand: 'a' },
      { name: 'B', autoLoginCommand: 'b' },
    ],
  }, null, 2), 'utf8');

  persistLogin(tmp, 'q', 'B', 'b2');

  const written = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  check('no-clobber: length still 2', written.logins.length === 2);
  check('no-clobber: A untouched',
    written.logins.find((l) => l.name === 'A').autoLoginCommand === 'a');
  check('no-clobber: B updated',
    written.logins.find((l) => l.name === 'B').autoLoginCommand === 'b2');
}

// --- 11b. setAntiIdle is per-profile and write-through -----------------------
{
  const aPath = path.join(tmp, 'anti-a.json');
  const bPath = path.join(tmp, 'anti-b.json');
  fs.writeFileSync(aPath, JSON.stringify({
    id: 'anti-a', name: 'A', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');
  fs.writeFileSync(bPath, JSON.stringify({
    id: 'anti-b', name: 'B', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');

  setAntiIdle(tmp, 'anti-a', true);

  const writtenA = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const writtenB = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  check('setAntiIdle: toggled profile written as true', writtenA.antiIdle === true);
  check('setAntiIdle: sibling profile untouched (defaults false on load)',
    loadProfile(tmp, 'anti-b').antiIdle === false);
}

// --- 12. slugify ------------------------------------------------------------
{
  check('slugify: lowercases + hyphenates spaces', slugify('My New MUSH') === 'my-new-mush');
  check('slugify: collapses punctuation runs', slugify('Foo!! (Bar)') === 'foo-bar');
  check('slugify: trims leading/trailing separators', slugify('  --Hello--  ') === 'hello');
  check('slugify: slug-less name falls back to "world"', slugify('!!!') === 'world');
  check('slugify: empty falls back to "world"', slugify('') === 'world');
}

// --- 13. createProfile basic creation + shape -------------------------------
{
  const cpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-cp-'));

  const created = createProfile(cpTmp, {
    name: 'My New MUSH', host: 'mush.example.net', port: '4201', charset: '',
  });
  check('create: returns generated id', created.id === 'my-new-mush');

  const file = path.join(cpTmp, 'my-new-mush.json');
  check('create: writes <id>.json', fs.existsSync(file));

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('create: name preserved', written.name === 'My New MUSH');
  check('create: host preserved', written.host === 'mush.example.net');
  check('create: port coerced to number', written.port === 4201 && typeof written.port === 'number');
  check('create: charset defaults to utf8 when empty', written.charset === 'utf8');
  check('create: logins is [Default,\'\']',
    Array.isArray(written.logins) && written.logins.length === 1 &&
    written.logins[0].name === 'Default' && written.logins[0].autoLoginCommand === '');
  check('create: no stray fields',
    Object.keys(written).sort().join(',') ===
      'antiIdle,channelAliases,charset,color,host,id,logins,name,port,routingRules,routingRulesVersion,tls,tlsAllowInsecure');
  check('create: seeded with default channelAliases and routingRules',
    Object.keys(written.channelAliases).length === 0 &&
      JSON.stringify(written.routingRules) === JSON.stringify(presets.familyRules));
  check('create: tls/tlsAllowInsecure default to false when not passed',
    written.tls === false && written.tlsAllowInsecure === false);
  check('create: color defaults to null when not passed', written.color === null);
  check('create: charset honored when provided',
    createProfile(cpTmp, { name: 'Latin World', host: 'h', port: 1, charset: 'latin1' }).charset === 'latin1');
  check('create: tls/tlsAllowInsecure honored when provided',
    createProfile(cpTmp, {
      name: 'Secure World', host: 'h', port: 1, tls: true, tlsAllowInsecure: true,
    }).tls === true &&
    createProfile(cpTmp, {
      name: 'Secure World 2', host: 'h', port: 1, tls: true, tlsAllowInsecure: true,
    }).tlsAllowInsecure === true);
  check('create: round-trips through loadProfile',
    loadProfile(cpTmp, 'my-new-mush').logins[0].name === 'Default');

  fs.rmSync(cpTmp, { recursive: true, force: true });
}

// --- 14. createProfile collision handling -----------------------------------
{
  const colTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-col-'));

  const a = createProfile(colTmp, { name: 'Dup World', host: 'h', port: 1 });
  const b = createProfile(colTmp, { name: 'Dup World', host: 'h', port: 2 });
  const c = createProfile(colTmp, { name: 'Dup World', host: 'h', port: 3 });
  check('collision: first gets base id', a.id === 'dup-world');
  check('collision: second gets -2 suffix', b.id === 'dup-world-2');
  check('collision: third gets -3 suffix', c.id === 'dup-world-3');
  check('collision: all three files exist',
    fs.existsSync(path.join(colTmp, 'dup-world.json')) &&
    fs.existsSync(path.join(colTmp, 'dup-world-2.json')) &&
    fs.existsSync(path.join(colTmp, 'dup-world-3.json')));

  // A .example.json counts as taken even though there is no real .json.
  fs.writeFileSync(path.join(colTmp, 'seeded.example.json'), JSON.stringify({
    id: 'seeded', name: 'Seeded', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');
  const d = createProfile(colTmp, { name: 'Seeded', host: 'h', port: 4 });
  check('collision: avoids an existing .example.json id', d.id === 'seeded-2');

  fs.rmSync(colTmp, { recursive: true, force: true });
}

// --- 15. loadProfile color defaulting/sanitizing -----------------------------
{
  const colorTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-color-'));

  // No color key at all -> null (non-breaking default for pre-feature profiles).
  fs.writeFileSync(path.join(colorTmp, 'nocolor.json'), JSON.stringify({
    id: 'nocolor', name: 'NoColor', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');
  check('color default: absent color defaulted to null',
    loadProfile(colorTmp, 'nocolor').color === null);

  // Garbage on disk must never survive load — it flows into a CSS custom property.
  fs.writeFileSync(path.join(colorTmp, 'badcolor.json'), JSON.stringify({
    id: 'badcolor', name: 'BadColor', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    color: 'red',
  }), 'utf8');
  check('color sanitize: invalid "red" sanitized to null',
    loadProfile(colorTmp, 'badcolor').color === null);

  fs.writeFileSync(path.join(colorTmp, 'shortcolor.json'), JSON.stringify({
    id: 'shortcolor', name: 'ShortColor', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    color: '#12',
  }), 'utf8');
  check('color sanitize: invalid short hex "#12" sanitized to null',
    loadProfile(colorTmp, 'shortcolor').color === null);

  // Valid hex passes through untouched.
  fs.writeFileSync(path.join(colorTmp, 'goodcolor.json'), JSON.stringify({
    id: 'goodcolor', name: 'GoodColor', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    color: '#ff6b6b',
  }), 'utf8');
  check('color valid: "#ff6b6b" passed through unchanged',
    loadProfile(colorTmp, 'goodcolor').color === '#ff6b6b');

  fs.rmSync(colorTmp, { recursive: true, force: true });
}

// --- 16. setColor -------------------------------------------------------------
{
  const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-setcolor-'));

  fs.writeFileSync(path.join(scTmp, 'w.json'), JSON.stringify({
    id: 'w', name: 'W', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');

  const afterSet = setColor(scTmp, 'w', '#a98bff');
  check('setColor: return value has the new color', afterSet.color === '#a98bff');
  check('setColor: persisted to disk',
    JSON.parse(fs.readFileSync(path.join(scTmp, 'w.json'), 'utf8')).color === '#a98bff');
  check('setColor: round-trips through loadProfile',
    loadProfile(scTmp, 'w').color === '#a98bff');

  const afterClear = setColor(scTmp, 'w', null);
  check('setColor: null clears the color', afterClear.color === null);
  check('setColor: clear persisted to disk',
    JSON.parse(fs.readFileSync(path.join(scTmp, 'w.json'), 'utf8')).color === null);

  // Set a valid color, then attempt invalid sets — disk must not change.
  setColor(scTmp, 'w', '#35c8b0');
  const beforeInvalid = fs.readFileSync(path.join(scTmp, 'w.json'), 'utf8');

  const afterRed = setColor(scTmp, 'w', 'red');
  check('setColor: invalid "red" rejected, returned profile unchanged', afterRed.color === '#35c8b0');
  check('setColor: invalid "red" did not touch disk',
    fs.readFileSync(path.join(scTmp, 'w.json'), 'utf8') === beforeInvalid);

  const afterBadHex = setColor(scTmp, 'w', '#GGGGGG');
  check('setColor: invalid "#GGGGGG" rejected, returned profile unchanged', afterBadHex.color === '#35c8b0');
  check('setColor: invalid "#GGGGGG" did not touch disk',
    fs.readFileSync(path.join(scTmp, 'w.json'), 'utf8') === beforeInvalid);

  // setColor on an id with only an example file forks a real one, like setAntiIdle.
  fs.writeFileSync(path.join(scTmp, 'ex.example.json'), JSON.stringify({
    id: 'ex', name: 'Ex', host: 'h', port: 1,
    autoLoginCommand: '',
  }), 'utf8');
  check('setColor: no real file exists yet for "ex"', !fs.existsSync(path.join(scTmp, 'ex.json')));
  setColor(scTmp, 'ex', '#ef78c8');
  check('setColor: forked a real "ex.json" file', fs.existsSync(path.join(scTmp, 'ex.json')));
  check('setColor: forked file has the new color',
    JSON.parse(fs.readFileSync(path.join(scTmp, 'ex.json'), 'utf8')).color === '#ef78c8');

  fs.rmSync(scTmp, { recursive: true, force: true });
}

// --- 17. discoverProfiles includes color in summaries ------------------------
{
  const dcTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-disc-color-'));
  fs.writeFileSync(path.join(dcTmp, 'alpha.json'), JSON.stringify({
    id: 'alpha', name: 'Alpha', host: 'h1', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    color: '#6fcf7f',
  }), 'utf8');
  fs.writeFileSync(path.join(dcTmp, 'beta.json'), JSON.stringify({
    id: 'beta', name: 'Beta', host: 'h2', port: 2,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');

  const profiles = discoverProfiles(dcTmp);
  const alpha = profiles.find((p) => p.id === 'alpha');
  const beta = profiles.find((p) => p.id === 'beta');
  check('discover: color present for colored profile', alpha.color === '#6fcf7f');
  check('discover: color null for uncolored profile', beta.color === null);

  fs.rmSync(dcTmp, { recursive: true, force: true });
}

// --- 18. createProfile with color option --------------------------------------
{
  const cpcTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-logins-cpcolor-'));

  const withColor = createProfile(cpcTmp, { name: 'Colored World', host: 'h', port: 1, color: '#e3c14e' });
  check('createProfile: valid color persisted', withColor.color === '#e3c14e');
  check('createProfile: valid color written to disk',
    JSON.parse(fs.readFileSync(path.join(cpcTmp, 'colored-world.json'), 'utf8')).color === '#e3c14e');

  const noColor = createProfile(cpcTmp, { name: 'Plain World', host: 'h', port: 1 });
  check('createProfile: no color yields null', noColor.color === null);

  const badColor = createProfile(cpcTmp, { name: 'Bad World', host: 'h', port: 1, color: 'not-a-color' });
  check('createProfile: invalid color yields null', badColor.color === null);

  fs.rmSync(cpcTmp, { recursive: true, force: true });
}

// --- 19. isHexColor -----------------------------------------------------------
{
  check('isHexColor: valid lowercase hex', isHexColor('#ff6b6b') === true);
  check('isHexColor: valid uppercase hex', isHexColor('#FF6B6B') === true);
  check('isHexColor: rejects short hex', isHexColor('#fff') === false);
  check('isHexColor: rejects non-hex string', isHexColor('red') === false);
  check('isHexColor: rejects null', isHexColor(null) === false);
  check('isHexColor: rejects undefined', isHexColor(undefined) === false);
}

// --- 20. orderProfiles ---------------------------------------------------------
{
  const profiles = [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
    { id: 'gamma', name: 'Gamma' },
  ];
  const order = ['gamma', 'alpha'];
  const originalProfiles = JSON.stringify(profiles);
  const originalOrder = JSON.stringify(order);

  const result = orderProfiles(profiles, order);
  check('orderProfiles: normal reorder puts order-listed ids first, in order',
    result.map((p) => p.id).join(',') === 'gamma,alpha,beta');
  check('orderProfiles: returns a new array', result !== profiles);
  check('orderProfiles: does not mutate profiles input', JSON.stringify(profiles) === originalProfiles);
  check('orderProfiles: does not mutate order input', JSON.stringify(order) === originalOrder);

  // Unknown id in order (stale/deleted world) is ignored.
  const withUnknown = orderProfiles(profiles, ['ghost', 'beta']);
  check('orderProfiles: unknown id in order ignored',
    withUnknown.map((p) => p.id).join(',') === 'beta,alpha,gamma');

  // New profile not present in order is appended last, preserving relative order.
  const withNew = orderProfiles(profiles, ['beta']);
  check('orderProfiles: profiles absent from order appended last, relative order kept',
    withNew.map((p) => p.id).join(',') === 'beta,alpha,gamma');

  // Duplicate id in order is not duplicated in the output.
  const withDup = orderProfiles(profiles, ['alpha', 'alpha', 'beta']);
  check('orderProfiles: duplicate id in order not duplicated',
    withDup.map((p) => p.id).join(',') === 'alpha,beta,gamma' &&
    withDup.filter((p) => p.id === 'alpha').length === 1);

  // Non-string entries in order are ignored.
  const withNonString = orderProfiles(profiles, [42, 'beta', null, {}]);
  check('orderProfiles: non-string order entries ignored',
    withNonString.map((p) => p.id).join(',') === 'beta,alpha,gamma');

  // Non-array order -> shallow copy of profiles, unchanged order.
  const notArrayOrder = orderProfiles(profiles, 'nope');
  check('orderProfiles: non-array order returns profiles unchanged (shallow copy)',
    notArrayOrder !== profiles && notArrayOrder.map((p) => p.id).join(',') === 'alpha,beta,gamma');

  // Non-array profiles -> [].
  check('orderProfiles: non-array profiles returns []', Array.isArray(orderProfiles('nope', order)) && orderProfiles('nope', order).length === 0);
  check('orderProfiles: null profiles returns []', orderProfiles(null, order).length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL TESTS PASSED');
