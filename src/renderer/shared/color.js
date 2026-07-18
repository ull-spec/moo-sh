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
