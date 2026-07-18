'use strict';

// Scheme allowlist for opening external links. This is the trusted gate: the
// renderer's detection regex is display-only. Only http/https may be opened.
function isSafeExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

module.exports = { isSafeExternalUrl };
