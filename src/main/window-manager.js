'use strict';

/*
 * Window manager — the single source of truth for window identity.
 *
 * Holds a registry mapping a BrowserWindow's id to { role, target }. A renderer
 * never self-declares its identity: main creates the window already knowing its
 * role/target and passes that in at init (see ipc 'feed:init'). See "Windowing"
 * in the architecture doc.
 *
 * The always-open feed window and the startup Connect window are created here.
 * As of Phase 3 the feed is a single two-column window: the left column is the
 * main scrollback/input, and the right column hosts in-renderer tabbed Pages
 * and Channels panels (see src/renderer/shared/tabbed-panel.js). Pages and
 * channels are therefore NOT separate BrowserWindows — main routes their lines
 * to the feed window over dedicated IPC channels. The registry still keys
 * windowId -> { role, target } for forward compatibility.
 */

const path = require('path');
const { BrowserWindow } = require('electron');
const { ROLES } = require('../common/line-types');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const FEED_HTML = path.join(__dirname, '..', 'renderer', 'feed', 'index.html');
const CONNECT_HTML = path.join(__dirname, '..', 'renderer', 'connect', 'index.html');
const SETTINGS_HTML = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');

function createWindowManager() {
  // windowId -> { role, target }
  const registry = new Map();
  let feedId = null;
  // The Connect (world chooser) window is startup chrome, not a routed target,
  // so it is tracked by id but kept out of the role/target registry.
  let connectId = null;
  // The Settings window is also chrome, like Connect: tracked by id, kept out
  // of the registry, and singleton (focus the existing one instead of opening
  // a second).
  let settingsId = null;

  function createConnectWindow() {
    const win = new BrowserWindow({
      width: 640,
      height: 460,
      title: 'MOO-SH — Connect',
      backgroundColor: '#12141a',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    connectId = win.id;
    win.on('closed', () => {
      if (connectId === win.id) connectId = null;
    });

    win.loadFile(CONNECT_HTML);
    return win;
  }

  function getConnectWindow() {
    if (connectId == null) return null;
    return BrowserWindow.fromId(connectId) || null;
  }

  function closeConnectWindow() {
    const w = getConnectWindow();
    if (w && !w.isDestroyed()) w.close();
  }

  function createSettingsWindow() {
    const existing = getSettingsWindow();
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }

    // parent (transient-for) tells the window manager this is a dialog
    // belonging to the feed window, not a peer window. resizable:false is
    // the actual signal most tiling WMs (Hyprland included) key their
    // auto-float-dialogs heuristic on — min size == max size — parent alone
    // isn't enough since a resizable window looks like any other tileable
    // toplevel. Non-modal so it never blocks input to the parent feed window
    // (the user plays there); the Confirm-triggered settings:changed broadcast
    // reaches the feed regardless, and Cancel/Confirm close this window via the
    // 'settings:close' IPC rather than the renderer closing itself.
    const win = new BrowserWindow({
      width: 560,
      height: 620,
      resizable: false,
      title: 'MOO-SH — Settings',
      backgroundColor: '#12141a',
      parent: getFeedWindow() || undefined,
      modal: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    settingsId = win.id;
    win.on('closed', () => {
      if (settingsId === win.id) settingsId = null;
    });

    win.loadFile(SETTINGS_HTML);
    return win;
  }

  function getSettingsWindow() {
    if (settingsId == null) return null;
    return BrowserWindow.fromId(settingsId) || null;
  }

  // Close the Settings window on the renderer's behalf. A sandboxed renderer
  // cannot reliably close its own top-level BrowserWindow, so the Settings
  // window's Cancel/Confirm buttons ask main to do it (via the 'settings:close'
  // IPC), mirroring how the Connect window's Quit routes through main.
  function closeSettingsWindow() {
    const w = getSettingsWindow();
    if (w && !w.isDestroyed()) w.close();
  }

  function createFeedWindow({ profileName }) {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: profileName ? `MOO-SH — ${profileName}` : 'MOO-SH',
      backgroundColor: '#12141a',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const entry = { role: ROLES.FEED, target: null };
    registry.set(win.id, entry);
    feedId = win.id;

    win.on('closed', () => {
      registry.delete(win.id);
      if (feedId === win.id) feedId = null;
    });

    // Relay findInPage match results back to the renderer's find bar (see
    // the 'find:query'/'find:stop' IPC handlers in main/index.js).
    win.webContents.on('found-in-page', (_event, result) => {
      if (win.isDestroyed()) return;
      win.webContents.send('find:result', {
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        finalUpdate: result.finalUpdate,
      });
    });

    win.loadFile(FEED_HTML);
    return win;
  }

  function getFeedWindow() {
    if (feedId == null) return null;
    return BrowserWindow.fromId(feedId) || null;
  }

  function getRole(windowId) {
    const entry = registry.get(windowId);
    return entry ? entry.role : null;
  }

  // Find the live BrowserWindow(s) whose registry entry matches a routed
  // target. Phase 1: only feed exists, so a feed-role result returns the feed
  // window. Kept generic for Phase 3 (channel/page windows keyed by target).
  function windowsForRole(role) {
    const out = [];
    for (const [id, entry] of registry) {
      if (entry.role === role) {
        const w = BrowserWindow.fromId(id);
        if (w) out.push(w);
      }
    }
    return out;
  }

  // Send a channel/payload to EVERY open window (feed, connect, settings, ...).
  // Unlike toFeed's unicast, this is for app-wide notifications such as a
  // settings change that all renderers may want to react to.
  function broadcastToAll(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  return {
    createConnectWindow,
    getConnectWindow,
    closeConnectWindow,
    createSettingsWindow,
    getSettingsWindow,
    closeSettingsWindow,
    createFeedWindow,
    getFeedWindow,
    getRole,
    windowsForRole,
    broadcastToAll,
    registry, // exposed read-only-ish for debugging / Phase 3
  };
}

module.exports = { createWindowManager };
