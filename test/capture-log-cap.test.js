'use strict';

/*
 * capture-log MAX_CAPTURE_BYTES size-cap tests — plain Node, no framework.
 * Run: node test/capture-log-cap.test.js
 * Exits non-zero if any assertion fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCaptureLog } = require(path.join(__dirname, '..', 'src', 'main', 'capture-log'));

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

// --- Test 1: writing well under the cap never triggers the marker. -------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cap-test-1-'));
  const capture = createCaptureLog({ dir, profileId: 'underworld', maxBytes: 10000 });
  capture.setEnabled(true);

  capture.line('short line one');
  capture.line('short line two');
  capture.line('short line three');

  capture.close(() => {
    const contents = readSoleFile(dir);
    const lines = contents.trim().split('\n');
    ok(lines.length === 3, 'test1: exactly the 3 written lines are present');
    ok(!/cap reached/.test(contents), 'test1: no cap marker present when well under the cap');
    ok(!capture.isCapped(), 'test1: isCapped() is false when under the cap');
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 2: crossing the cap writes one marker then stops writing. ------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cap-test-2-'));
  // Small cap so a handful of lines cross it without writing tons of data.
  const capture = createCaptureLog({ dir, profileId: 'capworld', maxBytes: 200 });
  capture.setEnabled(true);

  // Each line is short; write several 50-char-ish lines so the cap of 200
  // bytes gets crossed partway through, leaving some lines before the cap
  // and some (rejected) after.
  const chunk = 'x'.repeat(50);
  for (let i = 0; i < 10; i++) {
    capture.line(`${chunk}-${i}`);
  }

  ok(capture.isCapped(), 'test2: isCapped() is true after crossing the cap');

  // A few more calls after capped — must NOT appear in the final file.
  capture.line('post-cap-1');
  capture.line('post-cap-2');

  capture.close(() => {
    const contents = readSoleFile(dir);
    const lines = contents.trim().split('\n');

    const markerLines = lines.filter((l) => /cap reached/.test(l));
    ok(markerLines.length === 1, 'test2: exactly one marker line appears');

    ok(!/post-cap-1/.test(contents), 'test2: writes after the marker are dropped (post-cap-1)');
    ok(!/post-cap-2/.test(contents), 'test2: writes after the marker are dropped (post-cap-2)');

    // Every OUT line present should be one of the pre-cap lines, verbatim.
    const outLines = lines.filter((l) => / OUT /.test(l));
    ok(outLines.length > 0, 'test2: at least one pre-cap OUT line survived');
    ok(
      outLines.every((l, idx) => l.endsWith(`${chunk}-${idx}`)),
      'test2: surviving OUT lines are verbatim and in order'
    );

    // Marker must be the very last line.
    ok(/cap reached/.test(lines[lines.length - 1]), 'test2: marker is the last line in the file');

    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
}

// --- Test 3: byte counter is seeded from existing on-disk file size. -----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cap-test-3-'));

  const first = createCaptureLog({ dir, profileId: 'seedworld', maxBytes: 100000 });
  first.setEnabled(true);
  first.line('some pre-existing content that takes up real space on disk');
  first.close(() => {
    const existingSize = fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).size;
    ok(existingSize > 0, 'test3: first instance wrote a non-empty file');

    // Second instance, same dir/profileId => same dated file, reopened with
    // the 'a' flag. Set maxBytes smaller than what's already on disk so the
    // very first write on this instance should immediately trip the cap.
    const second = createCaptureLog({
      dir,
      profileId: 'seedworld',
      maxBytes: Math.max(1, existingSize - 1),
    });
    second.setEnabled(true);
    second.line('this line should trigger the cap immediately');

    ok(second.isCapped(), 'test3: second instance is capped on its very first write');

    second.close(() => {
      const contents = readSoleFile(dir);
      ok(
        !/this line should trigger the cap immediately/.test(contents),
        'test3: the triggering line itself was not written'
      );
      const markerLines = contents.trim().split('\n').filter((l) => /cap reached/.test(l));
      ok(markerLines.length === 1, 'test3: exactly one marker line appears');

      fs.rmSync(dir, { recursive: true, force: true });
      finish();
    });
  });
}

let pending = 3;
function finish() {
  pending--;
  if (pending > 0) return;
  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nAll capture-log cap tests passed.');
  }
}
