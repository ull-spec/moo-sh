'use strict';

// Minimal ANSI/CSI/OSC escape stripper for the ROUTING path. Some servers
// colorize channel/page tags — e.g. the literal bytes
// `\x1b[35m[\x1b[0m\x1b[35mPublic\x1b[0m...` — which breaks every
// `^`-anchored routing regex, since the line no longer starts with the visible
// character. Routing therefore classifies a STRIPPED copy of each line, while
// the original (colored) text still flows to the renderer for display.
// OSC sequences (e.g. window-title changes, `\x1b]0;title\x07`) are stripped
// too, so they don't leak into routed/logged text as literal garbage bytes.
//
// This is deliberately NOT the renderer's style-run parser
// (src/renderer/shared/ansi.js, an ES module): routing only needs the escapes
// gone, not decoded.

// One CSI sequence: ESC [ , parameter bytes 0x30-0x3F, intermediate bytes
// 0x20-0x2F, one final byte 0x40-0x7E. Covers SGR (`\x1b[35m`, `\x1b[0m`,
// truecolor `\x1b[38;2;r;g;bm`) and cursor/erase sequences alike.
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

// One OSC (Operating System Command) sequence: ESC ] , any run of bytes that
// are neither BEL nor ESC (so we never run past a following escape
// sequence), then an optional terminator — either a lone BEL (\x07) or ST
// (ESC \\). The terminator is optional so an OSC left unterminated at
// end-of-string still matches and gets fully consumed, matching how an
// unterminated CSI is handled (best-effort: drop the remainder).
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

function stripAnsi(text) {
  if (text == null) return '';
  return String(text).replace(CSI_RE, '').replace(OSC_RE, '');
}

module.exports = { stripAnsi };
