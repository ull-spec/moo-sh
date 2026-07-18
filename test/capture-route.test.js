'use strict';

/*
 * capture-log route() smoke tests — plain Node, no framework.
 * Run: node test/capture-route.test.js
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-route-test-'));
const capture = createCaptureLog({ dir, profileId: 'testworld' });

// route() writes nothing while disabled.
capture.route('[Vampire] Amanda: hey', {
  role: 'channel',
  target: { name: 'Vampire', key: 'vampire' },
  notify: 'channel',
});
const filesWhileDisabled = fs.readdirSync(dir);
ok(filesWhileDisabled.length === 0, 'route() writes nothing while capture is disabled');

capture.setEnabled(true);

capture.route('[Vampire] Amanda: hey', {
  role: 'channel',
  target: { name: 'Vampire', key: 'vampire' },
  notify: 'channel',
});
capture.route('Obvious exits: North', { role: 'feed', target: null, notify: null });
capture.route('page-to-page text\r', {
  role: 'page',
  target: { name: 'Amanda', key: 'amanda' },
  notify: null,
});

capture.close(() => {
  const files = fs.readdirSync(dir);
  ok(files.length === 1, 'route() opens exactly one dated capture file once enabled');

  const contents = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  const lines = contents.trim().split('\n');

  ok(lines.length === 3, 'wrote one ROUTE line per route() call');
  ok(
    /ROUTE role=channel target=Vampire key=vampire notify=channel line=\[Vampire\] Amanda: hey$/.test(
      lines[0]
    ),
    'channel route logs role/target/key/notify/line'
  );
  ok(
    /ROUTE role=feed target=- key=- notify=- line=Obvious exits: North$/.test(lines[1]),
    'unmatched (feed) route logs - placeholders for target/key/notify'
  );
  ok(
    /ROUTE role=page target=Amanda key=amanda notify=- line=page-to-page text\\r$/.test(lines[2]),
    'page route with null notify logs - and escapes trailing CR like line()'
  );

  fs.rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nAll capture-log route() tests passed.');
  }
});
