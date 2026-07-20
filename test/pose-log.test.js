'use strict';

/*
 * pose-log state machine tests — plain Node, no framework.
 * Run: node test/pose-log.test.js
 * Exits non-zero if any assertion fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPoseLog } = require(path.join(__dirname, '..', 'src', 'main', 'pose-log'));

let failures = 0;

function ok(cond, name) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failures++;
    console.log('FAIL: ' + name);
  }
}

function readSoleFile(dir) {
  const files = fs.readdirSync(dir);
  return fs.readFileSync(path.join(dir, files[0]), 'utf8');
}

// Declared before the test blocks below run: test3's poseLog is never
// enabled, so its close() callback fires SYNCHRONOUSLY (no stream was ever
// opened) — if `pending` were declared after the test blocks (as a bare
// `let` at module bottom), that synchronous finish() call would hit it while
// still in the temporal dead zone.
let pending = 5;
function finish() {
  pending--;
  if (pending > 0) return;
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nAll pose-log tests passed.');
  }
}

const OPEN = '^--<(?<sender>.+)>--$';
const CLOSE = '^--+$';

// --- Test 1: a complete open -> body -> close block is written verbatim. ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-log-test-1-'));
  const poseLog = createPoseLog({ dir, profileId: 'liberation', openPattern: OPEN, closePattern: CLOSE });
  poseLog.setEnabled(true);

  poseLog.line('some room text that is not a pose');
  poseLog.line('--<Carol>--');
  poseLog.line('He says something.');
  poseLog.line('And a second line.');
  poseLog.line('----------');
  poseLog.line('more unrelated room text');

  poseLog.close(() => {
    const contents = readSoleFile(dir);
    ok(!/not a pose/.test(contents), 'test1: text before the open marker is not written');
    ok(!/unrelated room text/.test(contents), 'test1: text after the close marker is not written');
    ok(contents.includes('--<Carol>--'), 'test1: open marker line is written');
    ok(contents.includes('He says something.'), 'test1: pose body line 1 is written');
    ok(contents.includes('And a second line.'), 'test1: pose body line 2 is written');
    ok(contents.includes('----------'), 'test1: close marker line is written');
    // Order preserved.
    const idxOpen = contents.indexOf('--<Carol>--');
    const idxBody = contents.indexOf('He says something.');
    const idxClose = contents.indexOf('----------');
    ok(idxOpen < idxBody && idxBody < idxClose, 'test1: block written in order (open, body, close)');
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 2: turning the log off mid-block flushes the partial block. -----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-log-test-2-'));
  const poseLog = createPoseLog({ dir, profileId: 'liberation', openPattern: OPEN, closePattern: CLOSE });
  poseLog.setEnabled(true);

  poseLog.line('--<Amanda>--');
  poseLog.line('She starts to say something but is cut off.');
  poseLog.setEnabled(false); // no close marker was ever seen

  poseLog.close(() => {
    const contents = readSoleFile(dir);
    ok(contents.includes('--<Amanda>--'), 'test2: partial block open marker was flushed on disable');
    ok(
      contents.includes('She starts to say something but is cut off.'),
      'test2: partial block body was flushed on disable'
    );
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 3: lines while disabled are ignored entirely. --------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-log-test-3-'));
  const poseLog = createPoseLog({ dir, profileId: 'liberation', openPattern: OPEN, closePattern: CLOSE });
  // Never enabled.
  poseLog.line('--<Dave>--');
  poseLog.line('This should never be recorded.');
  poseLog.line('----------');

  poseLog.close(() => {
    const files = fs.readdirSync(dir);
    ok(files.length === 0, 'test3: no file is created when the pose log was never enabled');
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 4: a new open marker before a close flushes the prior block ------
// --- without a synthetic closer, then starts the new one. ------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-log-test-4-'));
  const poseLog = createPoseLog({ dir, profileId: 'liberation', openPattern: OPEN, closePattern: CLOSE });
  poseLog.setEnabled(true);

  poseLog.line('--<Erin>--');
  poseLog.line('Erin poses without a proper close.');
  poseLog.line('--<Dave>--'); // new open, no close seen for Erin's block
  poseLog.line('Dave poses properly.');
  poseLog.line('----------');

  poseLog.close(() => {
    const contents = readSoleFile(dir);
    ok(contents.includes('--<Erin>--'), 'test4: first block open marker flushed');
    ok(contents.includes('Erin poses without a proper close.'), 'test4: first block body flushed');
    ok(contents.includes('--<Dave>--'), 'test4: second block open marker flushed');
    ok(contents.includes('Dave poses properly.'), 'test4: second block body flushed');
    // The first block's flush must not have injected a synthetic close line
    // between Erin's body and Dave's open marker.
    const betweenBlocks = contents.split('Erin poses without a proper close.')[1].split('--<Dave>--')[0];
    ok(!/^-+$/m.test(betweenBlocks.trim()), 'test4: no synthetic close marker injected for the unterminated block');
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 5: an unterminated block that never closes is force-flushed ------
// --- once it exceeds MAX_BLOCK_LINES, instead of buffering forever. --------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-log-test-5-'));
  const poseLog = createPoseLog({ dir, profileId: 'liberation', openPattern: OPEN, closePattern: CLOSE });
  poseLog.setEnabled(true);

  poseLog.line('--<Runaway>--');
  // One more than MAX_BLOCK_LINES (4000) worth of body lines, no close marker.
  for (let i = 0; i < 4001; i++) {
    poseLog.line('body line ' + i);
  }
  // A line arriving right after the forced flush must be treated as OUTSIDE
  // any block (buffer was reset to null), not silently appended to it.
  poseLog.line('this is not a pose and must not appear in the log');

  poseLog.close(() => {
    const contents = readSoleFile(dir);
    ok(contents.includes('--<Runaway>--'), 'test5: runaway block open marker was flushed');
    ok(contents.includes('body line 0'), 'test5: runaway block body was flushed');
    ok(/flushed early/.test(contents), 'test5: a truncation notice is written when the line cap is hit');
    ok(
      !contents.includes('this is not a pose and must not appear in the log'),
      'test5: a line after the forced flush is not treated as pose content'
    );
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}
