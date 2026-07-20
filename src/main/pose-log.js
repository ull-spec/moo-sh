'use strict';

/*
 * Pose log — a toggleable, world-specific transcript of pose blocks only.
 *
 * Some MUSHes (Liberation is the first) wrap every pose/say in a divider
 * built from their own softcode: an OPEN marker line naming the poser
 * ("──<Name>──────────────────"), the pose text itself (one or more lines),
 * then a CLOSE marker line of pure dashes. This module is a small state
 * machine that watches the decoded line stream for those markers (supplied
 * per-profile as `open`/`close` regex source strings — see
 * profile.poseLogMarkers, e.g. config/profiles/liberation.json) and, only
 * while enabled, writes out COMPLETE pose blocks — nothing else — to
 *   <dir>/<profileId>-poses-<YYYY-MM-DD>.log
 *
 * Unlike capture-log.js (which logs everything, always, for regex-mining),
 * this is a real user-facing recording control: it captures only what
 * happens between the moment it's switched on and the moment it's switched
 * off, and any pose block still open at that off-switch moment (or at
 * shutdown) is flushed as-is rather than discarded, so a mid-scene toggle
 * never silently drops text.
 *
 * `dir` is a userData-scoped directory (see main/index.js's poseLogsDir()).
 * Writes only happen while enabled; disk errors never throw out of this
 * module, mirroring capture-log.js's discipline.
 */

const fs = require('fs');
const path = require('path');

// Same rationale as capture-log.js's MAX_CAPTURE_BYTES: this is an opt-in
// per-session recording, but without a cap a long scene could still grow the
// file unbounded on disk.
const MAX_POSE_LOG_BYTES = 50 * 1024 * 1024;

// Hard cap on how many lines an IN-PROGRESS block may accumulate before its
// close marker arrives. Mirrors line-splitter.js's maxAcc guard: a malformed
// poseLogMarkers.close (or a scene that simply never emits the closing
// dashes) would otherwise let `buffer` grow one string per incoming line for
// the rest of the session with no eviction — unbounded memory growth, not
// just unbounded disk growth (which MAX_POSE_LOG_BYTES already covers).
const MAX_BLOCK_LINES = 4000;

/**
 * @param {{ dir: string, profileId: string, openPattern: string, closePattern: string, maxBytes?: number }} opts
 */
function createPoseLog({ dir, profileId, openPattern, closePattern, maxBytes = MAX_POSE_LOG_BYTES }) {
  let enabled = false;
  let stream = null;
  let bytesWritten = 0;
  let capped = false;

  // In-progress block being accumulated between an open marker and its close
  // marker (or the next open marker, if no close was seen).
  let buffer = null; // string[] | null

  let openRe = null;
  let closeRe = null;
  try {
    openRe = new RegExp(openPattern);
  } catch (err) {
    console.warn('[pose-log] invalid open pattern:', err && err.message);
  }
  try {
    closeRe = new RegExp(closePattern);
  } catch (err) {
    console.warn('[pose-log] invalid close pattern:', err && err.message);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function datedFilename() {
    const d = new Date();
    const stamp =
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return `${profileId}-poses-${stamp}.log`;
  }

  function ensureStream() {
    if (stream) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, datedFilename());
      stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', (err) => {
        console.warn('[pose-log] stream error:', err && err.message);
        stream = null;
      });
      try {
        bytesWritten = fs.statSync(filePath).size;
      } catch (err) {
        bytesWritten = 0;
      }
      return true;
    } catch (err) {
      console.warn('[pose-log] could not open pose log file:', err && err.message);
      stream = null;
      return false;
    }
  }

  function write(text) {
    if (capped) return;
    if (!ensureStream()) return;
    const len = Buffer.byteLength(text, 'utf8');
    if (bytesWritten + len > maxBytes) {
      try {
        stream.write(
          `*** pose log size cap reached (${maxBytes} bytes) — further writes suppressed ***\n`
        );
      } catch (err) {
        console.warn('[pose-log] write failed:', err && err.message);
      }
      capped = true;
      return;
    }
    try {
      stream.write(text);
      bytesWritten += len;
    } catch (err) {
      console.warn('[pose-log] write failed:', err && err.message);
    }
  }

  // Flush the currently-buffered block (if any) to disk, followed by a blank
  // line separating it from the next one, then clear the buffer.
  function flushBuffer() {
    if (!buffer || buffer.length === 0) {
      buffer = null;
      return;
    }
    write(buffer.join('\n') + '\n\n');
    buffer = null;
  }

  // One decoded, ANSI-stripped server line.
  function line(str) {
    if (!enabled) return;
    if (!openRe || !closeRe) return; // bad profile config; fail safe, log nothing
    const text = str == null ? '' : String(str);

    if (buffer == null) {
      // Not currently inside a block: only an open marker matters.
      const m = openRe.exec(text);
      if (m) buffer = [text];
      return;
    }

    // Inside a block: a close marker ends it.
    if (closeRe.exec(text)) {
      buffer.push(text);
      flushBuffer();
      return;
    }

    // A new open marker with no close seen yet: flush what we have (no
    // synthetic closer) and start the new block.
    const m = openRe.exec(text);
    if (m) {
      flushBuffer();
      buffer = [text];
      return;
    }

    buffer.push(text);
    if (buffer.length > MAX_BLOCK_LINES) {
      // No close marker in sight after MAX_BLOCK_LINES — stop waiting for
      // one, flush what we have with a note, and fall back to "not in a
      // block" so accumulation can't run away for the rest of the session.
      buffer.push(
        `*** pose log: block exceeded ${MAX_BLOCK_LINES} lines without a close marker — flushed early ***`
      );
      flushBuffer();
    }
  }

  function setEnabled(flag) {
    const next = !!flag;
    if (next === enabled) return;
    if (!next) {
      // Switching off mid-block must not silently drop the partial pose.
      flushBuffer();
    }
    enabled = next;
    if (enabled) ensureStream();
  }

  function isEnabled() {
    return enabled;
  }

  function close(cb) {
    flushBuffer();
    if (stream) {
      const s = stream;
      try {
        if (cb) s.once('finish', cb);
        s.end();
      } catch (err) {
        console.warn('[pose-log] close failed:', err && err.message);
        if (cb) cb();
      }
      stream = null;
    } else if (cb) {
      cb();
    }
  }

  return { setEnabled, isEnabled, line, close };
}

module.exports = { createPoseLog };
