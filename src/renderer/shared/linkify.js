// linkify.js
// Pure URL-detection helper used to split rendered text into plain-text and
// link segments for display. This module has no imports and touches no DOM
// at module top level, so it is importable in plain Node for tests.
//
// IMPORTANT: `link` classification is DISPLAY-ONLY detection. It decides
// what looks clickable in the UI; it is NOT a security boundary — the real
// gate for links is the scheme allowlist in src/common/url-safety.js,
// enforced in the main process before shell.openExternal is ever called
// (a link only ever loads on explicit click). Never trust this regex's
// `link` output as a safety check.
//
// `image` classification is DIFFERENT: unlike a link, an image segment
// causes an automatic, unclicked network fetch the moment it's rendered
// (see line-view.js's buildImageEl), so isImageUrl() below DOES double as a
// real security boundary — it's what keeps a private/loopback host out of
// an <img src>. Treat any change to isImageUrl()'s host check as a security
// change, not just a display tweak.

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;          // explicit http(s) scheme only
const TRAIL_RE = /[.,;:!?)\]}'"]+$/;               // strip trailing punctuation from a match
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s]*)?$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Best-effort guard against a server/player using an inline image preview as
// an SSRF/LAN-probe primitive: image previews auto-fetch with zero user
// interaction (unlike ordinary links, which only ever open on click via the
// scheme-gated shell.openExternal), so a URL pointing at the READER's own
// loopback/private-network address must never reach an <img src>. Checked
// against `new URL(url).hostname`, which normalizes octal/hex/short-form IPv4
// obfuscation (e.g. 0x7f000001, 017700000001, 127.1) to plain dotted-quad —
// so this catches those without needing to parse them itself.
// NOT a defense against DNS rebinding (a public hostname resolving to a
// private IP at actual fetch time) — that would need a main-process network
// hook, out of scope for a literal hostname/IP check.
function isPrivateOrLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return true;   // fail closed
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes('::ffff:')) return true;   // IPv4-mapped IPv6 — block outright, don't decode
  if (/^\[?f[cd][0-9a-f]{2}:/.test(h)) return true;      // IPv6 ULA, fc00::/7
  if (/^\[?fe[89ab][0-9a-f]:/.test(h)) return true;       // IPv6 link-local, fe80::/10
  if (h === '[::1]' || h === '::1') return true;          // IPv6 loopback

  const m = IPV4_RE.exec(h);
  if (m) {
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;         // malformed — fail closed
    const [a, b] = octets;
    if (a === 127) return true;                            // loopback, 127.0.0.0/8
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                // link-local + cloud metadata, 169.254.0.0/16
    if (a === 0) return true;                                // 0.0.0.0/8
  }
  return false;
}

// A URL already matched by URL_RE (so http(s) only) that also looks like it
// points at a raster image by file extension, optionally followed by a query
// string or fragment (e.g. `.../cat.png?w=200`) — AND whose host isn't a
// private/loopback address (see isPrivateOrLoopbackHost above).
export function isImageUrl(url) {
  if (typeof url !== 'string' || !IMAGE_EXT_RE.test(url)) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return !isPrivateOrLoopbackHost(hostname);
}

// Split `text` into an ordered array of segments
// `{ type: 'text'|'link'|'image', value }`. `image` segments are a strict
// subset of what would otherwise be `link` — same http(s)-only scheme gate,
// just further narrowed by isImageUrl(). Callers that don't care about the
// distinction can treat 'image' the same as 'link'.
// The regex is intentionally linear (`[^\s<>"'`]+`, no nested quantifiers) so
// it cannot ReDoS on adversarial server text — keep it that way.
export function segmentText(text) {
  const segments = [];
  if (typeof text !== 'string' || text.length === 0) return segments;
  let lastIndex = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0];
    const start = m.index;
    const trail = TRAIL_RE.exec(url);
    if (trail) url = url.slice(0, url.length - trail[0].length);
    if (url.length === 0) { URL_RE.lastIndex = start + 1; continue; }   // safety, avoid infinite loop
    const end = start + url.length;
    if (start > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, start) });
    segments.push({ type: isImageUrl(url) ? 'image' : 'link', value: url });
    lastIndex = end;
    URL_RE.lastIndex = end;   // resume AFTER the trimmed url so trimmed punctuation rejoins following text
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}
