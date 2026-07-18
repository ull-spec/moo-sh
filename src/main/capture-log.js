'use strict';

/*
 * Raw-capture debug logger.
 *
 * When enabled, this appends every raw chunk (as received off the socket,
 * BEFORE telnet stripping) and every decoded output line, verbatim, to
 *   <dir>/<profileId>-<YYYY-MM-DD>.log
 * The intent is to mine these captures later to author the routing regex for a
 * given MUSH (channel/page/pose patterns), so fidelity matters: raw bytes are
 * escaped so control/high bytes survive round-tripping into a single text
 * line, and decoded lines are written exactly as the router will see them.
 *
 * `dir` (typically "captures/") is gitignored by the project.
 *
 * PHASE 1 NOTE ON THE FILENAME DATE: the dated filename is computed ONCE, when
 * the append stream is first opened (i.e. the first time capture is enabled).
 * If a capture session spans midnight the file keeps the date it was opened
 * with. That is acceptable for Phase 1; a future phase can roll the file on a
 * date change if needed.
 *
 * Writes only happen while enabled. Disk errors never throw out of this module
 * — they are swallowed with a console.warn so a logging failure can never take
 * down the connection.
 */

const fs = require('fs');
const path = require('path');

// Cap on how large a single capture file is allowed to grow. This is a
// forensic debug log the user opts into for a play session; without a cap a
// long session (or a flooding server) could grow it unbounded on disk.
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

/**
 * @param {{ dir: string, profileId: string, maxBytes?: number }} opts
 * `maxBytes` is optional (defaults to MAX_CAPTURE_BYTES / 50MB) and exists
 * mainly so tests can exercise the cap without writing 50MB of data.
 */
function createCaptureLog({ dir, profileId, maxBytes = MAX_CAPTURE_BYTES }) {
  let enabled = false;
  let stream = null;
  let filePath = null;
  let bytesWritten = 0;
  let capped = false;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function datedFilename() {
    const d = new Date();
    const stamp =
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return `${profileId}-${stamp}.log`;
  }

  // Escape an arbitrary byte buffer into a single printable line. Printable
  // ASCII (0x20..0x7e) passes through except backslash (escaped so the format
  // is unambiguous); everything else becomes \xNN.
  function escapeBytes(buf) {
    let s = '';
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b === 0x5c) {
        s += '\\\\';
      } else if (b >= 0x20 && b <= 0x7e) {
        s += String.fromCharCode(b);
      } else {
        s += '\\x' + b.toString(16).padStart(2, '0');
      }
    }
    return s;
  }

  // Lazily open the append stream. Returns true if a usable stream exists.
  function ensureStream() {
    if (stream) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, datedFilename());
      stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', (err) => {
        // Never let a stream error propagate; disable further writes.
        console.warn('[capture-log] stream error:', err && err.message);
        stream = null;
      });
      // Seed the byte counter from what's already on disk: the 'a' (append)
      // flag means a capture toggled off/on again within the same day reuses
      // the same dated file, which may already be large from earlier today.
      try {
        bytesWritten = fs.statSync(filePath).size;
      } catch (err) {
        bytesWritten = 0;
      }
      return true;
    } catch (err) {
      console.warn('[capture-log] could not open capture file:', err && err.message);
      stream = null;
      return false;
    }
  }

  function write(text) {
    if (!enabled) return;
    if (capped) return;
    if (!ensureStream()) return;
    const len = Buffer.byteLength(text, 'utf8');
    if (bytesWritten + len > maxBytes) {
      try {
        stream.write(
          `${new Date().toISOString()} *** capture log size cap reached (${maxBytes} bytes) — further writes suppressed ***\n`
        );
      } catch (err) {
        console.warn('[capture-log] write failed:', err && err.message);
      }
      capped = true;
      return;
    }
    try {
      stream.write(text);
      bytesWritten += len;
    } catch (err) {
      console.warn('[capture-log] write failed:', err && err.message);
    }
  }

  function setEnabled(flag) {
    const next = !!flag;
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      // Open eagerly so a bad `dir` surfaces immediately (still non-throwing).
      ensureStream();
    }
    // When disabling we intentionally keep the stream open (cheap) but stop
    // writing; close() releases it.
  }

  function isEnabled() {
    return enabled;
  }

  function isCapped() {
    return capped;
  }

  // Raw bytes off the socket, pre-telnet-strip.
  function raw(buffer) {
    if (!enabled) return;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    write(`${new Date().toISOString()} RAW ${escapeBytes(buf)}\n`);
  }

  // A decoded line. Kept verbatim because routing regex matches against it;
  // only a trailing CR is escaped so it stays visible on one line.
  function line(str) {
    if (!enabled) return;
    let text = str == null ? '' : String(str);
    if (text.endsWith('\r')) {
      text = text.slice(0, -1) + '\\r';
    }
    write(`${new Date().toISOString()} OUT ${text}\n`);
  }

  // The router's decision for a decoded line: role/target/notify, alongside
  // the same line text so ROUTE and OUT entries can be cross-read. Written
  // right after the OUT entry for the same line, so mining a capture file
  // later (e.g. to author/validate routing regex for a MUSH) shows both what
  // the server sent and how the router classified it.
  function route(str, result) {
    if (!enabled) return;
    let text = str == null ? '' : String(str);
    if (text.endsWith('\r')) {
      text = text.slice(0, -1) + '\\r';
    }
    const r = result || {};
    const role = r.role || 'feed';
    const target = r.target && r.target.name != null ? r.target.name : '-';
    const key = r.target && r.target.key != null ? r.target.key : '-';
    const notify = r.notify == null ? '-' : r.notify;
    write(
      `${new Date().toISOString()} ROUTE role=${role} target=${target} key=${key} notify=${notify} line=${text}\n`
    );
  }

  // `cb`, if given, fires once the underlying file write stream has actually
  // flushed to disk (its 'finish' event) — useful for tests/tooling that need
  // to read the file back immediately after closing.
  function close(cb) {
    if (stream) {
      const s = stream;
      try {
        if (cb) s.once('finish', cb);
        s.end();
      } catch (err) {
        console.warn('[capture-log] close failed:', err && err.message);
        if (cb) cb();
      }
      stream = null;
    } else if (cb) {
      cb();
    }
  }

  return { setEnabled, isEnabled, isCapped, raw, line, route, close };
}

module.exports = { createCaptureLog };
