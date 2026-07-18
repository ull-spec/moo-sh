// DOM rendering + scrollback management for a single output pane (the feed
// window, a channel window, a page window, ...). Purely structural: colors
// and fonts beyond what parseAnsi() already computed live in CSS, not here.
// This module uses `document`, so it is browser-only — never import it from
// a Node test.

import { parseAnsi } from './ansi.js';
import { segmentText } from './linkify.js';

const DEFAULT_MAX_LINES = 5000;
const BOTTOM_THRESHOLD_PX = 40;

function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function openExternal(url) {
  if (window.mush && typeof window.mush.openExternal === 'function') {
    window.mush.openExternal(url);
  }
}

// Shared by buildLineEl's link-segment rendering and buildImageEl's
// broken-image fallback, so the two never drift (e.g. one preserving ANSI
// `style` and the other silently dropping it).
function buildLinkSpan(url, text, style) {
  const linkEl = document.createElement('span');
  linkEl.className = 'link';
  if (style) Object.assign(linkEl.style, style);
  linkEl.textContent = text;   // textContent — never innerHTML
  linkEl.title = url;          // full URL, even if `text` is only part of it
  linkEl.addEventListener('click', () => openExternal(url));
  return linkEl;
}

// Build an inline preview <img> for an image URL. Never innerHTML — `src` is
// a resource load, not markup injection, and the URL reaching here already
// passed both URL_RE (http/https scheme only) and isImageUrl() in linkify.js.
// Falls back to a plain clickable link (buildLinkSpan, same as buildLineEl's
// link rendering) if the resource fails to load, since a `.png`-looking URL
// isn't guaranteed to actually be an image. `style` carries the ANSI style of
// the (first) run the URL appeared in, so the fallback link isn't uncolored.
function buildImageEl(url, style, onSettle) {
  const img = document.createElement('img');
  img.className = 'inline-image';
  img.src = url;
  img.alt = url;
  img.title = url;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('click', () => openExternal(url));
  img.addEventListener('load', onSettle, { once: true });
  img.addEventListener('error', () => {
    img.replaceWith(buildLinkSpan(url, url, style));
    onSettle();
  }, { once: true });
  return img;
}

function buildLineEl(text, extraClass, ts, images, onImageSettle) {
  const lineEl = document.createElement('div');
  lineEl.className = extraClass ? `line ${extraClass}` : 'line';

  if (Number.isFinite(ts)) {
    const tsEl = document.createElement('span');
    tsEl.className = 'line-ts';
    tsEl.textContent = formatTime(ts);
    lineEl.appendChild(tsEl);
  }

  const runs = parseAnsi(text);
  const runSpans = [];
  let pos = 0;
  for (const run of runs) {
    runSpans.push({ start: pos, end: pos + run.text.length, style: run.style });
    pos += run.text.length;
  }
  const fullText = runs.map((r) => r.text).join('');
  const segments = segmentText(fullText);

  let segPos = 0;
  for (const seg of segments) {
    const segStart = segPos;
    const segEnd = segStart + seg.value.length;
    segPos = segEnd;

    // Images render as a single <img> for the whole segment, never split
    // per ANSI run-piece like text/link segments below (a URL crossing a
    // color code boundary must still be exactly one image, not several).
    if (images && seg.type === 'image') {
      const firstRun = runSpans.find((rs) => rs.end > segStart && rs.start < segEnd);
      lineEl.appendChild(buildImageEl(seg.value, firstRun && firstRun.style, onImageSettle));
      continue;
    }

    for (const rs of runSpans) {
      if (rs.end <= segStart) continue;
      if (rs.start >= segEnd) break;
      const pieceStart = Math.max(rs.start, segStart);
      const pieceEnd = Math.min(rs.end, segEnd);
      const pieceText = fullText.slice(pieceStart, pieceEnd);
      if (!pieceText) continue;

      if (seg.type === 'text') {
        const span = document.createElement('span');
        Object.assign(span.style, rs.style);
        span.textContent = pieceText;
        lineEl.appendChild(span);
      } else {
        lineEl.appendChild(buildLinkSpan(seg.value, pieceText, rs.style));
      }
    }
  }

  return lineEl;
}

/**
 * Create a line-view bound to `containerEl` (the scrollable element that
 * lines are appended into).
 *
 * @param {HTMLElement} containerEl
 * @param {{maxLines?: number, images?: boolean}} [options]
 */
export function createLineView(containerEl, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const images = Boolean(options.images);

  function trim() {
    const lines = containerEl.getElementsByClassName('line');
    while (lines.length > maxLines) {
      containerEl.removeChild(lines[0]);
    }
  }

  function append(lineEl) {
    const wasAtBottom = isAtBottom(containerEl);
    containerEl.appendChild(lineEl);
    trim();
    if (wasAtBottom) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  // An inline image has no intrinsic size until it finishes loading, so it
  // can grow scrollHeight well after append()'s synchronous scroll-to-bottom.
  // Passed into buildLineEl as the image load/error settle callback — checks
  // the CURRENT scroll position (not whatever it was when the line first
  // arrived), so an image that settles after the user has since scrolled
  // away doesn't yank them back to the bottom.
  function stickToBottomIfAtBottom() {
    if (isAtBottom(containerEl)) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  function renderLine(text, extraClass, ts) {
    append(buildLineEl(text, extraClass, ts, images, stickToBottomIfAtBottom));
  }

  return {
    // Parse `text` for ANSI/SGR and append it as a normal output line. `ts`
    // (optional, epoch ms) renders a small dim timestamp before the line.
    appendLine(text, ts) {
      renderLine(text, null, ts);
    },

    // Same as appendLine, but tags the line with an extra `system` class so
    // CSS can style it differently (connection status, local input echo).
    appendRaw(text) {
      renderLine(text, 'system');
    },

    // Remove all rendered lines.
    clear() {
      containerEl.textContent = '';
    },
  };
}
