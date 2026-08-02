// color.js — pure helpers + constants for the six customizable interface
// (chrome) colors. No DOM/imports, so it is unit-testable in plain Node.
// Message-content colors (page divider, channel tags) are intentionally NOT here.
export const COLOR_KEYS = ['bg', 'bgElevated', 'fg', 'fgMuted', 'accent', 'border'];

export const COLOR_VARS = {
  bg: '--bg',
  bgElevated: '--bg-elevated',
  fg: '--fg',
  fgMuted: '--fg-muted',
  accent: '--accent',
  border: '--border',
};

// theme.css defaults — used to initialise the pickers and to Reset.
export const DEFAULT_COLORS = {
  bg: '#12141a',
  bgElevated: '#1b1e27',
  fg: '#e8e6e3',
  fgMuted: '#7c8092',
  accent: '#5fb3ff',
  border: '#2a2e3a',
};

// The trusted validator: only a 6-digit #rrggbb hex may ever reach setProperty.
export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// Curated preset swatches for per-world color coding (deliberately a fixed
// palette, not a free-form picker — the user explicitly chose this). Each hex
// is picked to stay legible against the app's dark `bg` (#12141a above) and to
// stay clear of the default `accent` (#5fb3ff) so a world's color dot is never
// confused with the UI's own selection highlight. "No color" is represented
// as null, rendered by the UI as a separate clear/none control rather than as
// a palette entry here.
export const PROFILE_COLORS = [
  { hex: '#ff6b6b', name: 'Red' },
  { hex: '#f0883e', name: 'Orange' },
  { hex: '#e3c14e', name: 'Amber' },
  { hex: '#6fcf7f', name: 'Green' },
  { hex: '#35c8b0', name: 'Teal' },
  { hex: '#a98bff', name: 'Violet' },
  { hex: '#ef78c8', name: 'Pink' },
  { hex: '#c08b5c', name: 'Tan' },
  { hex: '#d8dee9', name: 'Silver' },
];
