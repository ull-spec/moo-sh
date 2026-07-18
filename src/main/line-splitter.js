'use strict';

// Stateful, byte-level line splitter for a MU* socket. Accumulates filtered
// bytes and yields complete lines (split on 0x0A), with two hard caps that
// protect against a malicious/broken server:
//   - maxLine: a single line longer than this many bytes is truncated (the
//     excess up to the next \n is discarded). Bounds one line's render cost.
//   - maxAcc:  if pending bytes with NO newline exceed this, we force a line
//     boundary (emit the capped buffer, drop the rest of the pending bytes) so
//     a server that never sends \n can't grow the accumulator unboundedly (OOM).
// Returned line buffers EXCLUDE the trailing \n; a trailing CR is left in place
// (the caller's decode step strips it, matching the pre-existing behavior).
const NL = 0x0a;

function createLineSplitter({ maxLine = 16 * 1024, maxAcc = 64 * 1024 } = {}) {
  let acc = Buffer.alloc(0);

  function capLine(buf) {
    return buf.length > maxLine ? buf.subarray(0, maxLine) : buf;
  }

  // Feed a filtered buffer; returns an array of complete line Buffers (possibly
  // empty). Any incomplete trailing line is retained for the next call.
  function push(data) {
    const out = [];
    if (data && data.length) {
      acc = acc.length === 0 ? Buffer.from(data) : Buffer.concat([acc, data]);
    }
    let start = 0;
    for (let i = 0; i < acc.length; i++) {
      if (acc[i] === NL) {
        out.push(capLine(acc.subarray(start, i)));
        start = i + 1;
      }
    }
    acc = start >= acc.length ? Buffer.alloc(0) : acc.subarray(start);
    // Overflow guard: no newline in sight but the pending buffer is too big.
    if (acc.length > maxAcc) {
      out.push(capLine(acc));
      acc = Buffer.alloc(0);
    }
    return out;
  }

  function reset() { acc = Buffer.alloc(0); }

  return { push, reset };
}

module.exports = { createLineSplitter };
