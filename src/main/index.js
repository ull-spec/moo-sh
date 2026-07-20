'use strict';

/*
 * Main process entry point (Phase 1 MVP).
 *
 * Owns the network and all routing; the renderer is display-only. Pipeline:
 *   connection 'raw'  -> capture.raw()               (verbatim debug log)
 *   connection 'line' -> capture.line() + router.route() -> feed window
 *   renderer 'input:send' -> connection.send()
 *
 * Phase 1: a single feed window; the router only has the FEED catch-all, so
 * every line goes to the feed. Real per-MUSH routing rules and channel/page
 * windows arrive in Phases 2-3.
 */

const fs = require('fs');
const path = require('path');
const { app, Menu, ipcMain, shell } = require('electron');

const { createConnection } = require('./connection');
const { createRouter } = require('./router');
const { createCaptureLog } = require('./capture-log');
const { createPoseLog } = require('./pose-log');
const { createWindowManager } = require('./window-manager');
const { createHistoryStore } = require('./history-store');
const { createHistoryPersistence } = require('./history-persist');
const { ROLES } = require('../common/line-types');
const { stripAnsi } = require('../common/ansi');
const { isSafeExternalUrl } = require('../common/url-safety');
const profileStore = require('./profile-store');
const settingsStore = require('./settings-store');
const storage = require('./storage');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
// Legacy in-repo location, used only as the source for the one-time
// migration into userData (see storage.js). Never read/written at runtime.
const LEGACY_PROFILES_DIR = path.join(PROJECT_ROOT, 'config', 'profiles');
// Matches every id profileStore.slugify() can ever produce (lowercase
// alphanumeric + hyphens). Used to reject a crafted 'connect:go' id before it
// reaches path.join() in profile-store.js.
const SAFE_PROFILE_ID_RE = /^[a-z0-9-]+$/;

// app.getPath('userData') is only valid after app is ready, so these are all
// resolved lazily (inside init()/IPC handlers below), never at module top
// level. The packaged app install dir is read-only, so profiles and captures
// must live under userData, not PROJECT_ROOT.
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function profilesDir() {
  return path.join(app.getPath('userData'), 'profiles');
}
function capturesDir() {
  return path.join(app.getPath('userData'), 'captures');
}
function poseLogsDir() {
  return path.join(app.getPath('userData'), 'pose-logs');
}
function historyDir() {
  return path.join(app.getPath('userData'), 'personal-history');
}

let wm = null;
let connection = null;
let router = null;
let capture = null;
// Only created when the connected profile defines poseLogMarkers (currently
// Liberation-only) — see profile-store's loadProfile and pose-log.js.
let poseLog = null;
let profile = null;
let history = null;
let historyPersist = null;
// Set true when the user clicks Connect in the Connect window, so the feed's
// renderer:ready handler connects immediately regardless of profile.autoConnect.
let pendingConnect = false;
// The autoLoginCommand of the named login the user picked in the Connect
// window, resolved in startSession() and sent once the socket connects.
let activeLoginCommand = '';
// The display name of the login the user picked. Used as the speaker label on
// the divider before the user's OWN (outgoing) page lines.
let activeLoginName = '';
// Pending setTimeout handle for an auto-reconnect attempt, or null if none is
// scheduled. See scheduleReconnect()/doDisconnect()/doConnect().
let reconnectTimer = null;
// True only while the user's own Disconnect action is in flight, so the
// 'close' handler can tell "the user asked for this" apart from "the
// connection failed or the server dropped us" — only the latter retries.
let intentionalDisconnect = false;
const RECONNECT_DELAY_MS = 30000;
// True only while the socket is actually up (set on 'connect', cleared on
// 'close'), independent of the antiIdleTimer itself — lets the settings:set
// handler below know whether flipping the toggle mid-session should start the
// timer immediately or just update the persisted preference for next time.
let socketUp = false;
// Pending setInterval handle for the anti-idle keepalive, or null if none is
// running. See startAntiIdle()/stopAntiIdle().
let antiIdleTimer = null;
// Blank command cadence while connected, so the MUSH's own idle-timeout logic
// never fires during a long AFK stretch. A blank line is a silent no-op on
// PennMUSH/TinyMUSH/RhostMUSH-family servers (no output, no pose) but still
// counts as input, which is what resets the per-connection idle clock.
const ANTI_IDLE_INTERVAL_MS = 10 * 60 * 1000;

function startAntiIdle() {
  if (antiIdleTimer) return;
  antiIdleTimer = setInterval(() => {
    if (connection) connection.send('');
  }, ANTI_IDLE_INTERVAL_MS);
  // Never by itself keep the process alive — same discipline as
  // reconnectTimer/historyPersist's debounce timer.
  if (antiIdleTimer.unref) antiIdleTimer.unref();
}

function stopAntiIdle() {
  if (!antiIdleTimer) return;
  clearInterval(antiIdleTimer);
  antiIdleTimer = null;
}

// Begin a session for the chosen profile id. Called once, from the Connect
// window's 'connect:go' handler, after the login string has been persisted.
// Loads the (now-updated) profile, wires the network + router + capture +
// menu, opens the feed window, and closes the Connect window. Connection
// itself happens from the feed's renderer:ready handler (which needs the feed
// window to exist first); pendingConnect forces it regardless of autoConnect.
function startSession(id, loginName) {
  try {
    profile = profileStore.loadProfile(profilesDir(), id);

    const chosen = (profile.logins || []).find((l) => l.name === loginName);
    activeLoginCommand = chosen ? chosen.autoLoginCommand : '';
    activeLoginName = loginName || '';

    capture = createCaptureLog({ dir: capturesDir(), profileId: profile.id });
    capture.setEnabled(!!profile.capture);

    poseLog = profile.poseLogMarkers
      ? createPoseLog({
          dir: poseLogsDir(),
          profileId: profile.id,
          openPattern: profile.poseLogMarkers.open,
          closePattern: profile.poseLogMarkers.close,
        })
      : null;

    history = createHistoryStore({ maxLines: 500 });
    historyPersist = createHistoryPersistence({
      filePath: path.join(historyDir(), profile.id + '.json'),
      store: history,
      profileId: profile.id,
      onError: (err) => console.warn('[history-persist] error:', err && err.message),
    });
    historyPersist.load();

    router = createRouter(profile.routingRules || [], {
      channelAliases: profile.channelAliases || {},
      onWarning: (msg) => toFeed('feed:system', `* ${msg}`),
    });

    setupConnection();
    buildMenu();

    pendingConnect = true;
    // Create the feed window BEFORE closing Connect so the app never transiently
    // has zero windows (which would trigger window-all-closed -> quit).
    wm.createFeedWindow({ profileName: profile.name });
    wm.closeConnectWindow();
  } catch (err) {
    // Reset all module-level session state back to a clean pre-session slate
    // so the 'connect:go' handler's `if (profile) return;` guard doesn't
    // permanently block a retry after a failed attempt (e.g. the profile file
    // vanished on disk between the Connect window listing it and the click).
    profile = null;
    capture = null;
    poseLog = null;
    history = null;
    historyPersist = null;
    router = null;
    connection = null;
    activeLoginCommand = '';
    activeLoginName = '';

    // The Connect window is still open at this point: wm.closeConnectWindow()
    // is only ever reached on the success path above (as the last statement),
    // so on any earlier throw it hasn't run yet. Tell the user why nothing
    // happened, without leaking stack traces or local file paths.
    const cw = wm && typeof wm.getConnectWindow === 'function' ? wm.getConnectWindow() : null;
    if (cw && !cw.isDestroyed()) {
      const message = 'Could not start session: ' + (err && err.message ? err.message : 'unknown error');
      cw.webContents.send('connect:error', message);
    }
    // Do not re-throw: this runs inside an IPC handler, and an uncaught throw
    // here would leave Electron's IPC dispatch for this turn in a broken state.
  }
}

function toFeed(channel, payload) {
  const w = wm && wm.getFeedWindow();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// Build a synthetic client-generated divider line naming the SPEAKER,
// e.g. "── Amanda ──", in the app's amber brand accent (#E8A33D) via a
// truecolor SGR escape and combined with the "dim" SGR (code 2 -> opacity 0.7
// in ansi.js) so it reads as quiet client chrome, not loud server output. The
// renderer's parseAnsi() decodes both escapes like any other server line.
const PAGE_DIVIDER_DASHES = '─'.repeat(4); // box-drawing horizontal, x4
const PAGE_DIVIDER_STYLE = '\x1b[2m\x1b[38;2;232;163;61m'; // dim + amber truecolor
const PAGE_DIVIDER_RESET = '\x1b[0m';
function pageDivider(name) {
  return `${PAGE_DIVIDER_STYLE}${PAGE_DIVIDER_DASHES} ${name} ${PAGE_DIVIDER_DASHES}${PAGE_DIVIDER_RESET}`;
}

// History storage key: namespace by kind so a page correspondent and a channel
// that normalize to the same key don't share one history bucket.
function histKey(kind, key) { return `${kind}:${key}`; }

function setupConnection() {
  connection = createConnection({
    host: profile.host,
    port: profile.port,
    charset: profile.charset,
    tls: !!profile.tls,
    tlsAllowInsecure: !!profile.tlsAllowInsecure,
  });

  connection.on('raw', (chunk) => capture.raw(chunk));

  connection.on('line', (line) => {
    capture.line(line);
    // Route (and ROUTE-log) a stripped copy: servers colorize channel/page
    // tags, and the escape bytes break the routing regexes' `^` anchors. The
    // ORIGINAL line still goes to the renderer below so display keeps color;
    // the ROUTE capture shows exactly the text the regexes saw.
    const routeText = stripAnsi(line);
    const result = router.route(routeText);
    capture.route(routeText, result);
    if (poseLog) poseLog.line(routeText);
    const target = result.target;
    // One timestamp per incoming line, reused for every payload/history entry
    // derived from it (e.g. a page's synthetic divider AND its message line
    // share this moment) so they never drift apart by IPC/history-write jitter.
    const ts = Date.now();

    // PAGE role -> the right column's Pages tabbed panel, one tab per
    // correspondent (both directions of a conversation share the tab, since the
    // router keys incoming/outgoing to the same target). A synthetic amber
    // divider naming the actual SPEAKER precedes each line: our own login name
    // on outgoing lines, the correspondent on incoming ones. Direction is read
    // from notify — incoming page rules carry notify 'page', while the local
    // echoes of our OWN outgoing pages carry notify null (by design: you are
    // not pinged for your own message). The divider is client chrome and is
    // never captured; capture.line() above already logged the real server line.
    if (result.role === ROLES.PAGE && target && target.name) {
      const key = target.key || target.name;
      const outgoing = result.notify == null;
      const speaker = outgoing ? activeLoginName || 'You' : target.name;
      const hkey = histKey('page', key);
      const dividerText = pageDivider(speaker);
      // The divider names the SPEAKER (client chrome); no timestamp on it —
      // only the actual message line below gets one.
      const dseq = history.record(profile.id, hkey, dividerText, null);
      toFeed('pages:line', { key, name: target.name, text: dividerText, seq: dseq, notify: null });
      const lseq = history.record(profile.id, hkey, line, ts);
      toFeed('pages:line', { key, name: target.name, text: line, seq: lseq, notify: result.notify, ts });
      if (historyPersist) historyPersist.scheduleFlush();
      return;
    }

    // CHANNEL role -> the right column's Channels tabbed panel, one tab per
    // canonical channel (the router already collapsed aliases to target.key /
    // target.name). MUSH channel lines already name their speaker natively, so
    // there is no divider — the classified line is piped through as-is.
    if (result.role === ROLES.CHANNEL && target && target.name) {
      const key = target.key || target.name;
      const hkey = histKey('channel', key);
      const cseq = history.record(profile.id, hkey, line, ts);
      toFeed('channel:line', { key, name: target.name, text: line, seq: cseq, notify: result.notify, ts });
      if (historyPersist) historyPersist.scheduleFlush();
      return;
    }

    // Everything else stays in the main feed (left column) — untimestamped
    // by design: it's the firehose of ordinary server output (room
    // descriptions, bboard reads, look/who spam), where a timestamp on every
    // line is noise rather than signal. Timestamps are reserved for Pages
    // and Channels, where "when did they say that" is actually useful.
    toFeed('feed:line', line);
  });

  connection.on('connect', () => {
    toFeed('feed:system', `* Connected to ${profile.host}:${profile.port}.`);
    // Auto-login: send the profile's login command once the socket is up.
    // Fires on every connect (including reconnects), independently of
    // autoConnect (which only controls whether we connect at all). The command
    // text is NOT echoed to the feed/capture — it may contain a password.
    const cmd = activeLoginCommand;
    if (typeof cmd === 'string' && cmd.trim() !== '') {
      connection.send(cmd);
      toFeed('feed:system', '* Sent auto-login command.');
    }
    socketUp = true;
    if (!profile || profile.antiIdle !== false) startAntiIdle();
  });
  connection.on('close', () => {
    socketUp = false;
    stopAntiIdle();
    toFeed('feed:system', '* Connection closed.');
    // A drop the user didn't ask for (server restart, network blip, a
    // failed connect attempt) retries automatically; Disconnect/Quit does not.
    if (!intentionalDisconnect) scheduleReconnect();
  });
  connection.on('error', (err) =>
    toFeed('feed:system', `* Connection error: ${err && err.message}`)
  );
}

// Schedule one auto-reconnect attempt RECONNECT_DELAY_MS from now. A no-op if
// one is already pending (a failed retry re-schedules itself via the same
// 'close' -> here path, so this only ever needs one live timer at a time).
function scheduleReconnect() {
  if (reconnectTimer) return;
  toFeed('feed:system', `* Retrying in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connection) return; // session was torn down (e.g. app quitting)
    toFeed('feed:system', '* Reconnecting...');
    connection.connect();
  }, RECONNECT_DELAY_MS);
  // Never by itself keep the process alive — same discipline as
  // history-persist.js's debounce timer.
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function cancelReconnect() {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function doConnect() {
  intentionalDisconnect = false;
  cancelReconnect();
  if (!profile.port) {
    toFeed(
      'feed:system',
      `* No port set for "${profile.name}". Edit ${profile.__sourceFile} (or create ${path.join(
        profilesDir(),
        profile.id + '.json'
      )}) with a real port, then reconnect.`
    );
    return;
  }
  toFeed(
    'feed:system',
    `* Connecting to ${profile.host}:${profile.port}${profile.tls ? ' (TLS)' : ''} ...`
  );
  connection.connect();
}

function doDisconnect() {
  intentionalDisconnect = true;
  cancelReconnect();
  if (connection) connection.disconnect();
}

function buildMenu() {
  const connectionSubmenu = [
    { label: 'Connect', accelerator: 'CmdOrCtrl+K', click: doConnect },
    { label: 'Disconnect', accelerator: 'CmdOrCtrl+D', click: doDisconnect },
  ];

  // Pose log toggle is only meaningful (and only shown) for a profile that
  // defines poseLogMarkers — currently Liberation. Unlike the Debug menu's
  // raw-capture toggle below, this is a real user feature, not a dev tool, so
  // it's available in packaged builds too.
  if (poseLog) {
    connectionSubmenu.push(
      { type: 'separator' },
      {
        id: 'toggle-pose-log',
        label: 'Pose log',
        type: 'checkbox',
        checked: poseLog.isEnabled(),
        click: (item) => {
          poseLog.setEnabled(item.checked);
          toFeed(
            'feed:system',
            item.checked
              ? `* Pose log ON -> ${path.join(poseLogsDir(), profile.id + '-poses-<date>.log')}`
              : '* Pose log OFF.'
          );
        },
      }
    );
  }

  connectionSubmenu.push({ type: 'separator' }, { role: 'quit' });

  const template = [
    {
      label: 'Connection',
      submenu: connectionSubmenu,
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Open Settings', accelerator: 'CmdOrCtrl+,', click: () => wm.createSettingsWindow() },
      ],
    },
  ];

  // Debug menu (raw-capture toggle, DevTools, reload) is a real user-facing
  // risk surface once strangers install and run this app: DevTools console
  // can invoke arbitrary window.mush.* calls (e.g. crafted connectGo
  // payloads). Only expose it in dev (npm start), never in a packaged build.
  if (!app.isPackaged) {
    template.push({
      label: 'Debug',
      submenu: [
        {
          id: 'toggle-capture',
          label: 'Raw capture logging',
          type: 'checkbox',
          checked: !!(capture && capture.isEnabled()),
          click: (item) => {
            capture.setEnabled(item.checked);
            toFeed(
              'feed:system',
              item.checked
                ? `* Raw capture ON -> ${path.join(capturesDir(), profile.id + '-<date>.log')}`
                : '* Raw capture OFF.'
            );
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function init() {
  // One-time, idempotent migration of any profiles from the legacy in-repo
  // location into userData (see storage.js), then ensure the userData
  // profiles dir exists (migrateProfiles only mkdirs when it actually copies
  // something). Must run before the Connect window is created, since it
  // lists profiles from profilesDir().
  const target = profilesDir();
  storage.migrateProfiles(LEGACY_PROFILES_DIR, target);
  fs.mkdirSync(target, { recursive: true });

  // Startup gate: the Connect (world chooser) window. It lists discovered
  // profiles and lets the user view/edit the login string per world before
  // connecting. A profile is loaded and the session wired only once the user
  // clicks Connect (see the 'connect:go' handler -> startSession). Even a
  // single profile shows this window so its login string is visible/editable.
  wm = createWindowManager();
  wm.createConnectWindow();
}

// Connect window asks for the list of discovered profiles (display-only data;
// discovery + the real-over-example preference live in main, never the
// renderer). Each profile's logins[] is included so the Character dropdown
// and login field can be pre-filled.
ipcMain.handle('connect:list-profiles', () => profileStore.discoverProfiles(profilesDir()));

// User clicked Connect in the Connect window. Persist the (possibly edited)
// login string to the real profile file, then start the session. The login
// string is never logged or echoed. Ignored if a session already started.
ipcMain.on('connect:go', (_event, payload) => {
  // Second layer of defense (belt-and-suspenders) around the whole handler,
  // in case something outside startSession() throws that isn't already
  // individually guarded below (createProfile and persistLogin already have
  // their own try/catches). Mirrors startSession()'s own catch: never
  // re-throw inside an IPC handler.
  try {
    if (profile) return; // a session is already running; ignore stray clicks

    // Two shapes: an existing world (payload.id), or a brand-new world
    // (payload.newWorld) which we create on disk first, then connect to exactly
    // like any other world. The renderer already validated host/port for a new
    // world, but createProfile also coerces/defaults defensively.
    let id;
    if (payload && payload.newWorld && typeof payload.newWorld === 'object') {
      let created;
      try {
        created = profileStore.createProfile(profilesDir(), payload.newWorld);
      } catch (e) {
        return; // creation failed; nothing to start
      }
      id = created.id;
    } else {
      id = payload && typeof payload.id === 'string' ? payload.id : '';
      // Real ids only ever come from profileStore.slugify() (see profile-store.js),
      // which guarantees this exact charset. DevTools is reachable from every
      // window's Debug menu, so a crafted id (e.g. a path-traversal sequence)
      // could otherwise reach path.join() in profile-store.js via the console.
      if (id && !SAFE_PROFILE_ID_RE.test(id)) return;
    }

    const loginName =
      payload && typeof payload.loginName === 'string' && payload.loginName.trim() !== ''
        ? payload.loginName
        : 'Default';
    const login =
      payload && typeof payload.autoLoginCommand === 'string' ? payload.autoLoginCommand : '';
    if (!id) return;
    try {
      profileStore.persistLogin(profilesDir(), id, loginName, login);
    } catch (e) {
      // If the write fails, still try to start the session from whatever loads;
      // the login just won't be persisted. Surface nothing sensitive.
    }
    startSession(id, loginName);
  } catch (err) {
    const cw = wm && typeof wm.getConnectWindow === 'function' ? wm.getConnectWindow() : null;
    if (cw && !cw.isDestroyed()) {
      const message = 'Could not start session: ' + (err && err.message ? err.message : 'unknown error');
      cw.webContents.send('connect:error', message);
    }
  }
});

// User clicked Quit in the Connect window.
ipcMain.on('connect:quit', () => app.quit());

// Settings window: get the persisted settings (merged over DEFAULTS), or
// apply a shallow-merge patch and return the merged result. Persistence
// itself lives in settings-store.js (pure, unit-tested in plain Node); this
// is just the electron IPC wiring around it.
ipcMain.handle('settings:get', () => settingsStore.loadSettings(settingsFile()));
ipcMain.handle('settings:set', (_event, patch) => {
  const merged = settingsStore.updateSettings(settingsFile(), patch && typeof patch === 'object' ? patch : {});
  if (wm && typeof wm.broadcastToAll === 'function') {
    wm.broadcastToAll('settings:changed', merged);
  }
  return merged;
});

// Anti-idle keepalive is a PER-PROFILE setting (unlike theme/sound above,
// which are intentionally app-wide) — see profile-store.js's setAntiIdle for
// why: two instances of this client connected to two different worlds must
// not share one on/off switch. Scoped to `profile`/`profilesDir()`, both of
// which are this instance's own in-memory session state, so a sibling
// instance connected elsewhere never sees or affects this toggle.
ipcMain.handle('profile:get-anti-idle', () => (!profile || profile.antiIdle !== false));
ipcMain.handle('profile:set-anti-idle', (_event, value) => {
  const v = !!value;
  if (profile) {
    profile.antiIdle = v;
    try {
      profileStore.setAntiIdle(profilesDir(), profile.id, v);
    } catch (err) {
      // Profile file may be unwritable; the in-memory value still governs
      // this session even if the preference doesn't survive a restart.
    }
  }
  // Live-apply without requiring a reconnect, same reasoning as before: only
  // meaningful while a socket is actually up.
  if (socketUp) {
    if (v === false) stopAntiIdle();
    else startAntiIdle();
  }
  return v;
});

// Atomic, disk-fresh roster append — see appendSoundRosterEntry's comment in
// settings-store.js for why this exists instead of the Feed window sending a
// full (and possibly stale) `sound` object like Settings does.
ipcMain.handle('settings:sound-roster-add', (_event, payload) => {
  const kind = payload && typeof payload.kind === 'string' ? payload.kind : '';
  const name = payload && typeof payload.name === 'string' ? payload.name : '';
  const merged = settingsStore.appendSoundRosterEntry(settingsFile(), kind, name);
  if (wm && typeof wm.broadcastToAll === 'function') {
    wm.broadcastToAll('settings:changed', merged);
  }
  return merged;
});

// Renderer requests a Pages/Channels key's in-memory history to rehydrate a
// (re)opened tab. kind is 'page' | 'channel'; namespaced by the active profile.
ipcMain.handle('history:get', (_event, payload) => {
  if (!history || !profile) return [];
  const kind = payload && typeof payload.kind === 'string' ? payload.kind : '';
  const key = payload && payload.key != null ? String(payload.key) : '';
  if (!key) return [];
  return history.get(profile.id, histKey(kind, key));
});

// Close the Settings window on request. A sandboxed renderer can't reliably
// close its own top-level BrowserWindow, so Cancel/Confirm send this instead
// of calling window.close(). Closes only the Settings window (unlike
// 'connect:quit', which quits the whole app).
ipcMain.on('settings:close', () => {
  if (wm && typeof wm.closeSettingsWindow === 'function') wm.closeSettingsWindow();
});

// Renderer signals it is ready to receive init + status. There is a single
// feed window (its right-column Pages/Channels panels are in-renderer, not
// separate windows), so this is a straight init of that one window.
ipcMain.on('renderer:ready', () => {
  if (!profile) return; // no session yet
  toFeed('feed:init', {
    role: ROLES.FEED,
    target: null,
    profileName: profile.name,
  });
  toFeed(
    'feed:system',
    `* Profile: ${profile.name} (${profile.host}:${profile.port || 'no port set'}).`
  );
  toFeed(
    'feed:system',
    capture.isEnabled() ? '* Raw capture is ON.' : '* Raw capture is OFF.'
  );
  if (poseLog) {
    toFeed(
      'feed:system',
      poseLog.isEnabled()
        ? '* Pose log is ON.'
        : '* Pose log is OFF. Use Connection > Pose log to start recording poses.'
    );
  }
  toFeed('feed:system', '* Use Connection > Connect (Ctrl+K) to connect.');
  if (profile.autoConnect || pendingConnect) {
    pendingConnect = false;
    doConnect();
  }
});

// User submitted an input line. NOT echoed to the feed — the renderer's
// #cmdlog mirror pane is the record of what the user typed; the feed shows
// only server output.
ipcMain.on('input:send', (_event, text) => {
  if (connection) connection.send(text);
});

// Renderer asks to open a URL detected in server text. The scheme allowlist
// (http/https only, via url-safety.js) is the trusted gate — the renderer's
// detection regex is display-only. shell.openExternal delegates to the OS
// default browser (Linux: xdg-open, respecting xdg-settings/$BROWSER); no
// browser-specific code, portable if this is open-sourced.
ipcMain.on('shell:open-external', (_event, url) => {
  if (typeof url === 'string' && isSafeExternalUrl(url)) {
    shell.openExternal(url);
  }
});

// Find-in-page: the feed's custom find bar (Ctrl+F) relays queries here since
// webContents.findInPage/stopFindInPage are main-process-only APIs. Text is
// length-capped defensively even though this channel is only reachable from
// the sandboxed feed renderer, never from server-controlled content.
const FIND_TEXT_MAX_LEN = 500;
const FIND_STOP_ACTIONS = new Set(['clearSelection', 'keepSelection', 'activateSelection']);

ipcMain.on('find:query', (_event, payload) => {
  const win = wm && wm.getFeedWindow();
  if (!win || win.isDestroyed()) return;
  const text =
    payload && typeof payload.text === 'string' ? payload.text.slice(0, FIND_TEXT_MAX_LEN) : '';
  if (text === '') {
    win.webContents.stopFindInPage('clearSelection');
    return;
  }
  win.webContents.findInPage(text, {
    forward: !(payload && payload.forward === false),
    findNext: !!(payload && payload.findNext),
  });
});

ipcMain.on('find:stop', (_event, action) => {
  const win = wm && wm.getFeedWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.stopFindInPage(FIND_STOP_ACTIONS.has(action) ? action : 'clearSelection');
});

app.whenReady().then(() => {
  init();

  app.on('activate', () => {
    // Only recreate the feed window once a session exists; before that the
    // Connect window is the active surface.
    if (profile && wm && !wm.getFeedWindow()) {
      wm.createFeedWindow({ profileName: profile.name });
    }
  });
});

app.on('window-all-closed', () => {
  cancelReconnect();
  stopAntiIdle();
  if (capture) capture.close();
  if (poseLog) poseLog.close();
  if (historyPersist) historyPersist.flushNow();
  if (connection) connection.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
