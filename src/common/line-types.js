'use strict';

// Shared vocabulary used by both the main process (router, window-manager) and,
// where needed, the renderer. Keep this file dependency-free and isomorphic
// (no Node or browser APIs) so it can be required in main or imported in a
// renderer module without modification.

// Window roles. A window's role is decided by the router/window-manager in the
// main process and passed to the renderer at init; a renderer never chooses its
// own role. See "Windowing" in the architecture doc.
const ROLES = Object.freeze({
  FEED: 'feed',       // the always-open main window; catch-all output
  CHANNEL: 'channel', // a spawned window bound to a specific channel name
  PAGE: 'page',       // a spawned window bound to a specific page partner
});

// Notification / sound event kinds. Router rules set `notify` to one of these
// (or null). notifier.js and the feed's sound layer map these to desktop
// notifications and per-event sounds. Not wired until Phase 4.
const EVENTS = Object.freeze({
  PAGE: 'page',
  CHANNEL: 'channel',
  ACTIVITY: 'activity',
});

module.exports = { ROLES, EVENTS };
