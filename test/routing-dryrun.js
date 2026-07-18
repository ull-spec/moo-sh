'use strict';

/*
 * Routing dry-run harness.
 *
 * Replays a capture log's decoded (OUT) lines through a router built from
 * candidate rules and reports how each line would route — WITHOUT touching any
 * live profile or connection. This is the "dry-run against captured logs before
 * wiring anything live" step from the build plan.
 *
 * Usage:
 *   node test/routing-dryrun.js [logFile] [--rules=family] [--aliases=<profileId>]
 *
 * Defaults: newest *.log across both the app's userData captures dir
 * (~/.config/<app name>/captures, matching capturesDir() in src/main/index.js)
 * and the legacy in-repo captures/ dir, plus the familyRules preset and no
 * channel aliases. This script is a standalone Node CLI (no Electron `app`
 * module), so it replicates the userData path by hand instead of calling
 * app.getPath('userData'). With --aliases=<profileId> it loads channelAliases
 * from the profile JSON, checking the userData profiles dir first and the
 * legacy repo config/profiles/ dir last.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRouter } = require('../src/main/router');
const presets = require('../src/main/routing-presets');

const ROOT = path.join(__dirname, '..');
const APP_NAME = require(path.join(ROOT, 'package.json')).name;
const USERDATA_DIR = path.join(os.homedir(), '.config', APP_NAME);
const USERDATA_CAPTURES_DIR = path.join(USERDATA_DIR, 'captures');
const USERDATA_PROFILES_DIR = path.join(USERDATA_DIR, 'profiles');
const LEGACY_CAPTURES_DIR = path.join(ROOT, 'captures');
const LEGACY_PROFILES_DIR = path.join(ROOT, 'config', 'profiles');

// --- args ------------------------------------------------------------------
const args = process.argv.slice(2);
let logFile = null;
let aliasesProfile = null;
for (const a of args) {
  if (a.startsWith('--aliases=')) aliasesProfile = a.slice('--aliases='.length);
  else if (a.startsWith('--rules=')) {
    // reserved for future preset selection; only 'family' exists today
  } else if (!a.startsWith('--')) {
    logFile = a;
  }
}

function listLogs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => path.join(dir, f));
}

function newestLog() {
  const logs = [...listLogs(USERDATA_CAPTURES_DIR), ...listLogs(LEGACY_CAPTURES_DIR)].sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
  );
  return logs[0] || null;
}

if (!logFile) logFile = newestLog();
if (!logFile || !fs.existsSync(logFile)) {
  console.error('No log file found. Pass a path or capture a session first.');
  process.exit(2);
}

function loadAliases(profileId) {
  if (!profileId) return {};
  // Priority: real userData profile, then a migrated .example.json copy in
  // userData, then the committed repo template as a last resort for a fresh
  // checkout where the app has never been launched (so userData/profiles
  // doesn't exist yet).
  const candidates = [
    path.join(USERDATA_PROFILES_DIR, `${profileId}.json`),
    path.join(USERDATA_PROFILES_DIR, `${profileId}.example.json`),
    path.join(LEGACY_PROFILES_DIR, `${profileId}.example.json`),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return {};
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return p.channelAliases || {};
  } catch (e) {
    return {};
  }
}

const channelAliases = loadAliases(aliasesProfile);

// --- helpers ---------------------------------------------------------------
// Strip ANSI/CSI/OSC escape sequences (the log stores decoded text verbatim,
// including ESC bytes). Mirrors src/common/ansi.js's stripAnsi (full 0x40-0x7E
// CSI final-byte range + OSC), kept as an inline copy since this script has no
// module resolution against src/ set up.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
}

// Recover the server line payload from a capture "OUT" record:
//   "2026-07-11T00:12:41.931Z OUT [Guest] Alice says, ..."
function outPayload(logLine) {
  const m = /^\S+ OUT (.*)$/.exec(logLine);
  if (!m) return null;
  return stripAnsi(m[1]);
}

// --- run -------------------------------------------------------------------
const router = createRouter(presets.familyRules, { channelAliases });

const raw = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
const byRole = { feed: 0, channel: 0, page: 0 };
const targets = new Map(); // "role:key" -> { role, name, count, notify }
const matchedSamples = []; // matched (non-feed OR notify) lines to display
let outTotal = 0;

for (const logLine of raw) {
  const payload = outPayload(logLine);
  if (payload == null) continue; // not an OUT record
  outTotal += 1;

  const r = router.route(payload);
  byRole[r.role] = (byRole[r.role] || 0) + 1;

  const isNoticeFeed = r.role === 'feed' && r.notify != null;
  if (r.role !== 'feed' || isNoticeFeed) {
    const key = `${r.role}:${(r.target && r.target.key) || '-'}`;
    const entry = targets.get(key) || {
      role: r.role,
      name: r.target && r.target.name,
      notify: r.notify,
      count: 0,
    };
    entry.count += 1;
    targets.set(key, entry);
    if (matchedSamples.length < 40) {
      matchedSamples.push({ role: r.role, name: r.target && r.target.name, notify: r.notify, text: payload });
    }
  }
}

// --- report ----------------------------------------------------------------
console.log('Routing dry-run');
console.log('  log     :', path.relative(ROOT, logFile));
console.log('  rules   : familyRules (', presets.familyRules.length, 'rules )');
console.log('  aliases :', aliasesProfile ? `${aliasesProfile} -> ${JSON.stringify(channelAliases)}` : '(none)');
console.log('');
console.log(`OUT lines processed: ${outTotal}`);
console.log(`  feed (fallthrough): ${byRole.feed || 0}`);
console.log(`  channel           : ${byRole.channel || 0}`);
console.log(`  page              : ${byRole.page || 0}`);
console.log('');

console.log('Resolved targets:');
if (targets.size === 0) {
  console.log('  (none — every line fell through to feed)');
} else {
  for (const [key, e] of targets) {
    console.log(`  ${key.padEnd(22)} name=${JSON.stringify(e.name)} notify=${JSON.stringify(e.notify)} count=${e.count}`);
  }
}
console.log('');

console.log('Matched line samples (up to 40):');
if (matchedSamples.length === 0) {
  console.log('  (none)');
} else {
  for (const s of matchedSamples) {
    console.log(`  [${s.role}${s.name ? '/' + s.name : ''}${s.notify ? ' !' + s.notify : ''}] ${s.text}`);
  }
}
console.log('');

// A page match on a log with no expected pages is a red flag worth surfacing.
console.log('False-positive watch:');
console.log(`  page-role matches on this log: ${byRole.page || 0} (expected 0 for a session with no pages received/sent)`);
