// font.js — pure helpers for building the --font-mono CSS value from a chosen
// font name. No DOM/imports, so it is unit-testable in plain Node.
//
// FONT_OPTIONS is the single source of truth for the Settings font picker:
// a curated, monospace-only list. There is deliberately no free-text entry
// point — every value here (or the CSS generic "monospace" keyword itself)
// preserves the feed's fixed-width column alignment; a proportional font
// would break it.
export const FONT_OPTIONS = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'JetBrainsMono Nerd Font', label: 'JetBrainsMono Nerd Font' },
  { value: 'DejaVu Sans Mono', label: 'DejaVu Sans Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'monospace', label: 'monospace (system default)' },
];

// First curated entry — used as the fallback when a persisted font value
// isn't (or is no longer) one of the curated options.
export const DEFAULT_FONT = FONT_OPTIONS[0].value;

// True if `name` is one of the curated monospace families.
export function isCuratedFont(name) {
  return FONT_OPTIONS.some((opt) => opt.value === name);
}

export function sanitizeFontName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[^a-zA-Z0-9 \-]/g, '').trim();
}
export function fontFamilyValue(name) {
  const clean = sanitizeFontName(name);
  if (!clean) return '';
  // "monospace" is the generic CSS keyword — never quote it. Otherwise quote
  // the family and append the generic keyword as a guaranteed fallback.
  return clean === 'monospace' ? 'monospace' : `"${clean}", monospace`;
}
