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
  slugify,
  createProfile,
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
      'channelAliases,charset,host,id,logins,name,port,routingRules,tls,tlsAllowInsecure');
  check('create: seeded with default channelAliases and routingRules',
    Object.keys(written.channelAliases).length === 0 &&
      JSON.stringify(written.routingRules) === JSON.stringify(presets.familyRules));
  check('create: tls/tlsAllowInsecure default to false when not passed',
    written.tls === false && written.tlsAllowInsecure === false);
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL TESTS PASSED');
