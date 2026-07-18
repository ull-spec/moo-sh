// Hand-rolled ANSI/SGR (Select Graphic Rendition) parser for the renderer.
//
// This is deliberately NOT a canned npm ansi-to-html package: it produces
// structured `{ text, style }` runs rather than a baked HTML string, so
// line-view.js (and future features like click-to-copy or highlighting) can
// work with structure instead of re-parsing markup. Pure browser JS, no
// Node/DOM APIs used here (this file is imported by both line-view.js in the
// renderer and directly by the Node test script).
//
// ---------------------------------------------------------------------------
// 16-color palette (SGR 30-37 / 40-47 = indices 0-7, 90-97 / 100-107 =
// indices 8-15). We use the VS Code / xterm.js default terminal scheme
// rather than the old literal CGA colors — the CGA colors (pure #00AA00
// green, etc.) are harsh and hard to read on modern LCD/OLED displays at
// typical MU* font sizes. This palette is a widely-used, readable choice.
// ---------------------------------------------------------------------------
const PALETTE_16 = [
  '#000000', // 0  black
  '#cd3131', // 1  red
  '#0dbc79', // 2  green
  '#e5e510', // 3  yellow
  '#2472c8', // 4  blue
  '#bc3fbc', // 5  magenta
  '#11a8cd', // 6  cyan
  '#e5e5e5', // 7  white
  '#666666', // 8  bright black (gray)
  '#f14c4c', // 9  bright red
  '#23d18b', // 10 bright green
  '#f5f543', // 11 bright yellow
  '#3b8eea', // 12 bright blue
  '#d670d6', // 13 bright magenta
  '#29b8db', // 14 bright cyan
  '#ffffff', // 15 bright white
];

const ESC = '\x1b';

// Hard cap on the number of style runs a single parsed line can produce.
// Pathological input (e.g. an SGR code toggled every character) would
// otherwise create one run per character with no bound — this folds any
// excess text into the final run instead of growing the array forever.
const MAX_RUNS = 2048;

// Map an xterm-256 color index (0-255) to a CSS color string.
//   0-15    -> the 16-color palette above.
//   16-231  -> the 6x6x6 color cube (standard xterm level formula).
//   232-255 -> a 24-step grayscale ramp.
function xterm256ToRgb(n) {
  n = n | 0;
  if (n < 0) n = 0;
  if (n > 255) n = 255;
  if (n < 16) return PALETTE_16[n];
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(r)}, ${level(g)}, ${level(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

// SGR state carried across the whole line; a run inherits state until a code
// changes it.
function defaultState() {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
    fg: null, // CSS color string, or null = "use default"
    bg: null,
  };
}

// Build the CSS style object for the current state. `2` (dim/faint) is
// mapped to `opacity: 0.7` — there's no native CSS "dim text" property, and
// reducing opacity is the common terminal-emulator approximation (it dims
// foreground and any background equally, which is an acceptable trade-off
// here since MU* dim text is rare and cosmetic).
function styleFromState(state) {
  const style = {};
  if (state.bold) style.fontWeight = 'bold';
  if (state.dim) style.opacity = '0.7';
  if (state.italic) style.fontStyle = 'italic';

  const decorations = [];
  if (state.underline) decorations.push('underline');
  if (state.strikethrough) decorations.push('line-through');
  if (decorations.length) style.textDecoration = decorations.join(' ');

  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    const swap = fg;
    fg = bg;
    bg = swap;
  }
  if (fg) style.color = fg;
  if (bg) style.backgroundColor = bg;

  return style;
}

function stylesEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// Apply one escape's worth of SGR parameters (already split/parsed to
// numbers) to `state` in place. Unrecognized codes are skipped silently.
function applySgr(state, params) {
  if (params.length === 0) params = [0];
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === 0) {
      Object.assign(state, defaultState());
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 7) {
      state.inverse = true;
    } else if (code === 9) {
      state.strikethrough = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 27) {
      state.inverse = false;
    } else if (code === 29) {
      state.strikethrough = false;
    } else if (code >= 30 && code <= 37) {
      state.fg = PALETTE_16[code - 30];
    } else if (code === 38) {
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        state.fg = xterm256ToRgb(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        const r = params[i + 2] || 0;
        const g = params[i + 3] || 0;
        const b = params[i + 4] || 0;
        state.fg = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
      // malformed extended-color sequence: ignore gracefully, no state change
    } else if (code === 39) {
      state.fg = null;
    } else if (code >= 40 && code <= 47) {
      state.bg = PALETTE_16[code - 40];
    } else if (code === 48) {
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        state.bg = xterm256ToRgb(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        const r = params[i + 2] || 0;
        const g = params[i + 3] || 0;
        const b = params[i + 4] || 0;
        state.bg = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
    } else if (code === 49) {
      state.bg = null;
    } else if (code >= 90 && code <= 97) {
      state.fg = PALETTE_16[8 + (code - 90)];
    } else if (code >= 100 && code <= 107) {
      state.bg = PALETTE_16[8 + (code - 100)];
    }
    // else: unrecognized/unsupported code — skip without throwing.
    i++;
  }
}

// Scan one CSI sequence starting at `text[start]` === ESC, `text[start+1]`
// === '['. Returns { end, final, params } where `end` is the index just
// past the sequence (i.e. past the final byte), or null if the escape is
// unterminated (runs off the end of the string — best-effort: caller drops
// the remainder).
function scanCsi(text, start) {
  const len = text.length;
  let j = start + 2;
  while (j < len) {
    const code = text.charCodeAt(j);
    if (code >= 0x40 && code <= 0x7e) break;
    j++;
  }
  if (j >= len) return null;
  return { end: j + 1, final: text[j], paramStr: text.slice(start + 2, j) };
}

// Scan one OSC (Operating System Command) sequence starting at `text[start]`
// === ESC, `text[start+1]` === ']'. OSC sequences (e.g. `ESC ] 0 ; title BEL`
// for window-title changes) are terminated by BEL (\x07) or ST (ESC \\), and
// carry no visible payload for this client — they're scanned and dropped
// wholesale, mirroring how scanCsi's sequence is dropped. Returns { end }
// (index just past the terminator, or past end-of-string if unterminated —
// same "drop the remainder" convention as an unterminated CSI).
function scanOsc(text, start) {
  const len = text.length;
  let k = start + 2;
  while (k < len) {
    if (text[k] === '\x07') return { end: k + 1 };
    if (text[k] === ESC && text[k + 1] === '\\') return { end: k + 2 };
    k++;
  }
  return { end: len };
}

/**
 * Parse one line of text (which may contain ESC[...m SGR sequences and other
 * CSI sequences) into an array of `{ text, style }` runs. `style` is a plain
 * object of camelCase CSS properties suitable for
 * `Object.assign(el.style, run.style)`. Consecutive characters that end up
 * with the same style are coalesced into a single run. Non-SGR CSI
 * sequences (cursor moves, etc.) are stripped from the output without
 * emitting visible characters. Text with no escapes at all returns a single
 * run with an empty style object.
 *
 * @param {string} text
 * @returns {Array<{text: string, style: object}>}
 */
export function parseAnsi(text) {
  const runs = [];
  const state = defaultState();
  let currentStyle = styleFromState(state);
  let currentText = '';

  function flush() {
    if (currentText.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && stylesEqual(last.style, currentStyle)) {
      last.text += currentText;
    } else if (runs.length >= MAX_RUNS && last) {
      last.text += currentText; // capped: fold into final run, never drop text
    } else {
      runs.push({ text: currentText, style: currentStyle });
    }
    currentText = '';
  }

  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === ESC && text[i + 1] === '[') {
      const csi = scanCsi(text, i);
      if (!csi) {
        // Unterminated escape at end of line — drop the remainder.
        break;
      }
      if (csi.final === 'm') {
        const params = csi.paramStr.length
          ? csi.paramStr.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)))
          : [0];
        flush();
        applySgr(state, params);
        currentStyle = styleFromState(state);
      }
      // Any other final byte (A, B, C, D, H, J, K, ...) is a non-SGR CSI
      // sequence (cursor movement, erase, etc.) — strip silently.
      i = csi.end;
      continue;
    } else if (ch === ESC && text[i + 1] === ']') {
      // OSC (window title, etc.) — no visible payload, strip silently.
      const osc = scanOsc(text, i);
      i = osc.end;
      continue;
    } else if (ch === ESC) {
      // Lone/unrecognized escape not followed by '[' — drop just the ESC.
      i++;
      continue;
    } else {
      currentText += ch;
      i++;
    }
  }
  flush();

  if (runs.length === 0) {
    return [{ text: '', style: {} }];
  }
  return runs;
}

/**
 * Return `text` with all ANSI/CSI escape sequences removed. Useful for
 * logging, measuring, or search where styling is irrelevant.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  let result = '';
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === ESC && text[i + 1] === '[') {
      const csi = scanCsi(text, i);
      if (!csi) break;
      i = csi.end;
      continue;
    } else if (ch === ESC && text[i + 1] === ']') {
      const osc = scanOsc(text, i);
      i = osc.end;
      continue;
    } else if (ch === ESC) {
      i++;
      continue;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}
