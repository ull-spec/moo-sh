'use strict';

/*
 * Telnet SB abandon-after-length-cap tests.
 * Plain Node, no framework, matching test/phase1-core.test.js conventions.
 * Run: node test/telnet-sb-cap.test.js
 * Exits non-zero if any assertion fails.
 */

const path = require('path');
const {
  createTelnetFilter,
  IAC,
  SB,
  SE,
} = require(path.join(__dirname, '..', 'src', 'main', 'telnet-negotiation'));

const MAX_SB_LEN = 4096;

let failures = 0;

function ok(cond, name) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    failures++;
    console.log('FAIL: ' + name);
  }
}

function eqBuf(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}

// ---------------------------------------------------------------------------
// 1. Normal, well-terminated SB (well under the cap) still fully dropped;
//    surrounding S_DATA bytes in the same chunk pass through unaffected.
// ---------------------------------------------------------------------------
{
  const f = createTelnetFilter();
  const OPT = 24;
  const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]); // 8 bytes, well under 4096
  const chunk = Buffer.concat([
    Buffer.from([0x78]), // "x"
    Buffer.from([IAC, SB, OPT]),
    payload,
    Buffer.from([IAC, SE]),
    Buffer.from([0x79]), // "y"
  ]);
  const { data, reply } = f.process(chunk);
  ok(eqBuf(data, Buffer.from([0x78, 0x79])), 'normal SB: subnegotiation dropped, "xy" remain');
  ok(reply.length === 0, 'normal SB: no reply');
}

// ---------------------------------------------------------------------------
// 2. Unterminated SB exceeding MAX_SB_LEN recovers to S_DATA: trailing
//    ordinary text (no IAC bytes at all) shows up in cumulative output.
// ---------------------------------------------------------------------------
{
  const f = createTelnetFilter();
  const OPT = 24;
  const garbage = Buffer.alloc(MAX_SB_LEN + 500, 0x41); // 'A' * (cap + 500), never IAC SE
  const trailing = Buffer.from('hello\r\n', 'ascii');
  const chunk = Buffer.concat([Buffer.from([IAC, SB, OPT]), garbage, trailing]);

  const { data } = f.process(chunk);
  const cumulative = data.toString('ascii');
  ok(
    cumulative.includes('hello\r\n'),
    'unterminated SB over cap: parser recovers, trailing "hello\\r\\n" reaches output'
  );
}

// ---------------------------------------------------------------------------
// 3. Unterminated SB split across TWO process() calls, total length over the
//    cap: sbLen persists across chunk boundaries and recovery still happens.
// ---------------------------------------------------------------------------
{
  const f = createTelnetFilter();
  const OPT = 24;
  const half = Math.floor((MAX_SB_LEN + 500) / 2);

  const r1 = f.process(Buffer.concat([Buffer.from([IAC, SB, OPT]), Buffer.alloc(half, 0x42)]));
  ok(r1.data.length === 0, 'split unterminated SB: chunk1 yields no data (still inside SB)');

  const r2 = f.process(
    Buffer.concat([Buffer.alloc(half, 0x42), Buffer.from('world\r\n', 'ascii')])
  );
  ok(
    r2.data.toString('ascii').includes('world\r\n'),
    'split unterminated SB: chunk2 shows recovery, "world\\r\\n" reaches output'
  );
}

// ---------------------------------------------------------------------------
// 4. Cap does not falsely trigger across many back-to-back legitimate SBs:
//    sbLen must reset to 0 on a normal, successful IAC SE termination too.
// ---------------------------------------------------------------------------
{
  const f = createTelnetFilter();
  const OPT = 24;
  const smallPayload = Buffer.alloc(10, 0x43); // 10 bytes, far under cap
  let allData = Buffer.alloc(0);

  for (let n = 0; n < 100; n++) {
    const chunk = Buffer.concat([
      Buffer.from([0x30 + (n % 10)]), // a distinct-ish marker byte before
      Buffer.from([IAC, SB, OPT]),
      smallPayload,
      Buffer.from([IAC, SE]),
      Buffer.from([0x7a]), // "z" marker after
    ]);
    const { data, reply } = f.process(chunk);
    allData = Buffer.concat([allData, data]);
    ok(reply.length === 0, 'legitimate SB #' + n + ': no reply');
  }

  // Every iteration contributes exactly 2 surviving bytes (marker + "z");
  // if the cap had falsely triggered partway through, some iteration's SB
  // payload bytes would leak into `data` too, making this longer than 200.
  ok(
    allData.length === 200,
    '100 back-to-back legitimate SBs: sbLen resets on real IAC SE, no false cap trigger (got ' +
      allData.length +
      ' bytes, expected 200)'
  );
}

// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(failures + ' TEST(S) FAILED');
  process.exit(1);
}
