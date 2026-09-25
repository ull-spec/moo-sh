'use strict';

/*
 * Routing-preset unit test — validates the per-profile `routingPreset` field
 * ('mush' or 'evennia', absent meaning 'mush') added to profile-store.js:
 * createProfile seeding the right preset's rules, loadProfile backfilling and
 * migrating against the profile's OWN preset history (never mixing an
 * Evennia world's rules up with the MUSH family's), setRoutingPreset's
 * write-through switch, resetRoutingRules honoring the profile's preset, and
 * discoverProfiles surfacing it. Companion to logins.test.js (which predates
 * this field and must keep passing unchanged) and evennia-routing.test.js
 * (which covers routing-legacy's preset-aware stock detection directly).
 *
 * Plain Node, no framework. Exits non-zero on any failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadProfile,
  discoverProfiles,
  createProfile,
  resetRoutingRules,
  setRoutingPreset,
  setAntiIdle,
  setColor,
} = require('../src/main/profile-store');
const presets = require('../src/main/routing-presets');
const routingLegacy = require('../src/main/routing-legacy');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-routing-preset-'));

// --- 1. createProfile with no routingPreset -> mush, no key written --------
{
  const created = createProfile(tmp, { name: 'Plain MUSH', host: 'h', port: 1 });
  const written = JSON.parse(fs.readFileSync(path.join(tmp, `${created.id}.json`), 'utf8'));
  check('createProfile default: no routingPreset key on disk', !('routingPreset' in written));
  check('createProfile default: rules deep-equal familyRules',
    JSON.stringify(written.routingRules) === JSON.stringify(presets.familyRules));
  check('createProfile default: version is ROUTING_RULES_VERSION',
    written.routingRulesVersion === routingLegacy.ROUTING_RULES_VERSION);
}

// --- 2. createProfile with routingPreset 'evennia' --------------------------
{
  const created = createProfile(tmp, { name: 'Night City', host: 'h', port: 2, routingPreset: 'evennia' });
  const written = JSON.parse(fs.readFileSync(path.join(tmp, `${created.id}.json`), 'utf8'));
  check('createProfile evennia: routingPreset written as "evennia"', written.routingPreset === 'evennia');
  check('createProfile evennia: rules deep-equal evenniaRules',
    JSON.stringify(written.routingRules) === JSON.stringify(presets.evenniaRules));
  check('createProfile evennia: version is EVENNIA_ROUTING_RULES_VERSION',
    written.routingRulesVersion === routingLegacy.EVENNIA_ROUTING_RULES_VERSION);

  const loaded = loadProfile(tmp, created.id);
  check('createProfile evennia: loadProfile gives __routingCustomized false',
    loaded.__routingCustomized === false);
}

// --- 3. createProfile with garbage routingPreset -> treated as mush --------
{
  const created = createProfile(tmp, { name: 'Garbage Preset', host: 'h', port: 3, routingPreset: 'nonsense' });
  const written = JSON.parse(fs.readFileSync(path.join(tmp, `${created.id}.json`), 'utf8'));
  check('createProfile garbage preset: no routingPreset key on disk', !('routingPreset' in written));
  check('createProfile garbage preset: rules deep-equal familyRules',
    JSON.stringify(written.routingRules) === JSON.stringify(presets.familyRules));
}

// --- 4. loadProfile backfill on an evennia profile with no routingRules ----
{
  const file = path.join(tmp, 'ev-backfill.json');
  const onDisk = {
    id: 'ev-backfill', name: 'EvBackfill', host: 'h', port: 1, routingPreset: 'evennia',
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  };
  fs.writeFileSync(file, JSON.stringify(onDisk), 'utf8');

  const loaded = loadProfile(tmp, 'ev-backfill');
  check('backfill: evennia profile with absent rules backfilled with evenniaRules',
    JSON.stringify(loaded.routingRules) === JSON.stringify(presets.evenniaRules));
  check('backfill: version stamped to EVENNIA_ROUTING_RULES_VERSION',
    loaded.routingRulesVersion === routingLegacy.EVENNIA_ROUTING_RULES_VERSION);

  const rawAfter = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('backfill: file on disk unchanged (no routingRules key written)',
    !('routingRules' in rawAfter));
}

// --- 5. loadProfile: evennia profile whose rules equal familyRules ---------
// Not evenniaRules, not a snapshot of evenniaRules's own history — comparing
// against the WRONG preset's stock would wrongly call this stock and silently
// replace it. It must read as customized instead.
{
  const file = path.join(tmp, 'ev-mush-rules.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'ev-mush-rules', name: 'EvMushRules', host: 'h', port: 1, routingPreset: 'evennia',
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: presets.familyRules,
    routingRulesVersion: 0,
  }), 'utf8');

  const loaded = loadProfile(tmp, 'ev-mush-rules');
  check('evennia w/ familyRules: left exactly as-is',
    JSON.stringify(loaded.routingRules) === JSON.stringify(presets.familyRules));
  check('evennia w/ familyRules: reads as customized (evennia only compares to evennia history)',
    loaded.__routingCustomized === true);
}

// --- 6a. loadProfile: evennia profile with hand-edited rules ---------------
{
  const customRules = [{ pattern: '^whatever', target: { role: 'feed' }, notify: null }];
  const file = path.join(tmp, 'ev-custom.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'ev-custom', name: 'EvCustom', host: 'h', port: 1, routingPreset: 'evennia',
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: customRules,
    routingRulesVersion: routingLegacy.EVENNIA_ROUTING_RULES_VERSION,
  }), 'utf8');

  const loaded = loadProfile(tmp, 'ev-custom');
  check('evennia hand-edited: rules untouched',
    JSON.stringify(loaded.routingRules) === JSON.stringify(customRules));
  check('evennia hand-edited: customized true', loaded.__routingCustomized === true);
}

// --- 6b. loadProfile: mush profile, stale version but stock familyRules ----
// Existing pre-Evennia migration behavior must still work unchanged.
{
  const file = path.join(tmp, 'mush-stale.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'mush-stale', name: 'MushStale', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: presets.familyRules,
    routingRulesVersion: 0,
  }), 'utf8');

  const loaded = loadProfile(tmp, 'mush-stale');
  check('mush stale version, stock rules: version restamped',
    loaded.routingRulesVersion === routingLegacy.ROUTING_RULES_VERSION);
  check('mush stale version, stock rules: not customized', loaded.__routingCustomized === false);
}

// --- 7. Future-upgrade simulation for the evennia preset --------------------
// Temporarily push a fake older evennia snapshot into EVENNIA_LEGACY_SNAPSHOTS
// (the exported array is the same object routing-legacy's internals read from,
// so mutating it in place here really does affect isLegacyStock/isCurrentStock
// for the duration of this block) and confirm a profile pinned to that old
// snapshot gets migrated to the current evenniaRules on load, same as the
// MUSH family's own legacy-snapshot migration.
{
  const fakeOldEvenniaRules = [
    { pattern: '^\\[(?<channel>[^\\]]+)\\]', target: { role: 'channel', nameFrom: 'channel' }, notify: 'channel' },
  ];
  routingLegacy.EVENNIA_LEGACY_SNAPSHOTS.push(fakeOldEvenniaRules);
  try {
    const file = path.join(tmp, 'ev-old-snapshot.json');
    fs.writeFileSync(file, JSON.stringify({
      id: 'ev-old-snapshot', name: 'EvOldSnapshot', host: 'h', port: 1, routingPreset: 'evennia',
      logins: [{ name: 'Default', autoLoginCommand: '' }],
      routingRules: fakeOldEvenniaRules,
      routingRulesVersion: 0,
    }), 'utf8');

    const loaded = loadProfile(tmp, 'ev-old-snapshot');
    check('evennia future-upgrade sim: old snapshot migrated to current evenniaRules',
      JSON.stringify(loaded.routingRules) === JSON.stringify(presets.evenniaRules));
    check('evennia future-upgrade sim: version stamped to EVENNIA_ROUTING_RULES_VERSION',
      loaded.routingRulesVersion === routingLegacy.EVENNIA_ROUTING_RULES_VERSION);
  } finally {
    routingLegacy.EVENNIA_LEGACY_SNAPSHOTS.pop();
  }
  check('evennia future-upgrade sim: snapshot array restored to its original state',
    routingLegacy.EVENNIA_LEGACY_SNAPSHOTS.length === 0);
}

// --- 8. loadProfile: garbage routingPreset on disk --------------------------
{
  const file = path.join(tmp, 'garbage-preset.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'garbage-preset', name: 'GarbagePreset', host: 'h', port: 1, routingPreset: 'nonsense',
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');

  const loaded = loadProfile(tmp, 'garbage-preset');
  check('garbage routingPreset: treated as mush (rules backfilled with familyRules)',
    JSON.stringify(loaded.routingRules) === JSON.stringify(presets.familyRules));
  check('garbage routingPreset: key dropped in memory', !('routingPreset' in loaded));
}

// --- 9. setRoutingPreset: mush -> evennia, preserving other fields ---------
{
  const file = path.join(tmp, 'switch-a.json');
  const before = {
    id: 'switch-a', name: 'SwitchA', host: 'h', port: 1, color: '#123456',
    antiIdle: true,
    channelAliases: { ooc: 'OOC' },
    logins: [{ name: 'Mary', autoLoginCommand: 'connect Mary x' }],
    poseLogMarkers: { open: ':', close: ':' },
  };
  fs.writeFileSync(file, JSON.stringify(before), 'utf8');

  const merged = setRoutingPreset(tmp, 'switch-a', 'evennia');
  check('switch mush->evennia: returned routingPreset is evennia', merged.routingPreset === 'evennia');
  check('switch mush->evennia: rules are evenniaRules',
    JSON.stringify(merged.routingRules) === JSON.stringify(presets.evenniaRules));
  check('switch mush->evennia: version is EVENNIA_ROUTING_RULES_VERSION',
    merged.routingRulesVersion === routingLegacy.EVENNIA_ROUTING_RULES_VERSION);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('switch mush->evennia: routingPreset written on disk', written.routingPreset === 'evennia');
  check('switch mush->evennia: color preserved', written.color === '#123456');
  check('switch mush->evennia: antiIdle preserved', written.antiIdle === true);
  check('switch mush->evennia: channelAliases preserved',
    JSON.stringify(written.channelAliases) === JSON.stringify({ ooc: 'OOC' }));
  check('switch mush->evennia: logins preserved',
    written.logins.length === 1 && written.logins[0].name === 'Mary');
  check('switch mush->evennia: custom field (poseLogMarkers) preserved',
    JSON.stringify(written.poseLogMarkers) === JSON.stringify({ open: ':', close: ':' }));

  // --- switching straight back: evennia -> mush --------------------------
  const backToMush = setRoutingPreset(tmp, 'switch-a', 'mush');
  check('switch evennia->mush: routingPreset absent in returned object',
    !('routingPreset' in backToMush));
  check('switch evennia->mush: rules are familyRules',
    JSON.stringify(backToMush.routingRules) === JSON.stringify(presets.familyRules));

  const writtenBack = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('switch evennia->mush: routingPreset key removed on disk', !('routingPreset' in writtenBack));
  check('switch evennia->mush: color still preserved', writtenBack.color === '#123456');
}

// --- 9b. setRoutingPreset replaces even hand-edited (customized) rules -----
{
  const file = path.join(tmp, 'switch-custom.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'switch-custom', name: 'SwitchCustom', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: [{ pattern: '^weird', target: { role: 'feed' }, notify: null }],
    routingRulesVersion: 0,
  }), 'utf8');

  const merged = setRoutingPreset(tmp, 'switch-custom', 'evennia');
  check('switch replaces customized rules: rules are evenniaRules',
    JSON.stringify(merged.routingRules) === JSON.stringify(presets.evenniaRules));
}

// --- 10. resetRoutingRules on an evennia profile restores evenniaRules -----
{
  const file = path.join(tmp, 'ev-reset.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'ev-reset', name: 'EvReset', host: 'h', port: 1, routingPreset: 'evennia',
    logins: [{ name: 'Default', autoLoginCommand: '' }],
    routingRules: [{ pattern: '^weird', target: { role: 'feed' }, notify: null }],
    routingRulesVersion: 0,
  }), 'utf8');

  const merged = resetRoutingRules(tmp, 'ev-reset');
  check('resetRoutingRules on evennia profile: rules are evenniaRules (not familyRules)',
    JSON.stringify(merged.routingRules) === JSON.stringify(presets.evenniaRules));
  check('resetRoutingRules on evennia profile: version is EVENNIA_ROUTING_RULES_VERSION',
    merged.routingRulesVersion === routingLegacy.EVENNIA_ROUTING_RULES_VERSION);
  check('resetRoutingRules on evennia profile: routingPreset still evennia', merged.routingPreset === 'evennia');
}

// --- 11. discoverProfiles reports routingPreset for both kinds -------------
{
  const discTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mush-routing-preset-disc-'));
  createProfile(discTmp, { name: 'Disc Mush', host: 'h', port: 1 });
  createProfile(discTmp, { name: 'Disc Evennia', host: 'h', port: 2, routingPreset: 'evennia' });

  const discovered = discoverProfiles(discTmp);
  const mushEntry = discovered.find((p) => p.name === 'Disc Mush');
  const evenniaEntry = discovered.find((p) => p.name === 'Disc Evennia');
  check('discoverProfiles: mush profile reports routingPreset "mush"',
    mushEntry && mushEntry.routingPreset === 'mush');
  check('discoverProfiles: evennia profile reports routingPreset "evennia"',
    evenniaEntry && evenniaEntry.routingPreset === 'evennia');

  fs.rmSync(discTmp, { recursive: true, force: true });
}

// --- 12. Unrelated per-profile writers never add a routingPreset key -------
{
  const file = path.join(tmp, 'never-gains-key.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'never-gains-key', name: 'NeverGainsKey', host: 'h', port: 1,
    logins: [{ name: 'Default', autoLoginCommand: '' }],
  }), 'utf8');

  setAntiIdle(tmp, 'never-gains-key', true);
  const afterAntiIdle = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('setAntiIdle: never adds a routingPreset key', !('routingPreset' in afterAntiIdle));

  setColor(tmp, 'never-gains-key', '#abcdef');
  const afterColor = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('setColor: never adds a routingPreset key', !('routingPreset' in afterColor));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('ALL TESTS PASSED');
