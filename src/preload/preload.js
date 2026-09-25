'use strict';

/*
 * Preload — the ONLY bridge between the display-only renderer and the main
 * process. Runs with contextIsolation on and sandbox on, so the renderer sees
 * exactly the `window.mush` surface defined here and nothing else (no Node,
 * no ipcRenderer directly).
 *
 * IPC contract (channels are an internal detail; the renderer only uses the
 * wrapped methods below):
 *   main -> renderer:
 *     'feed:init'    payload { role, target, profileName, color }  (sent once,
 *                    on ready; color is a validated #rrggbb hex or null)
 *     'feed:line'    payload string  (a decoded server line, may contain ANSI;
 *                    deliberately untimestamped — see main/index.js, timestamps
 *                    are reserved for Pages/Channels, not the main-feed firehose)
 *     'feed:system'  payload string  (status / local echo, styled as system)
 *     'feed:clear'                    (clear the pane)
 *     'pages:line'   payload { key, name, text, seq, notify, ts }  (a Pages-panel
 *                    tab line; notify is null for the echo of your own outgoing
 *                    page, 'page' for a genuinely incoming one; ts is persisted
 *                    via history-store, so rehydrated tabs keep their timestamps)
 *     'channel:line' payload { key, name, text, seq, notify, ts }  (a Channels-panel
 *                    tab line; notify is the router's notify value, e.g. 'channel')
 *   renderer -> main:
 *     'renderer:ready'                (renderer asks main to send init)
 *     'input:send'  payload string    (user submitted an input line)
 *     'shell:open-external' payload string url (a link detected in server text;
 *                    main validates http/https scheme before shell.openExternal)
 *     'find:query'  payload { text, forward, findNext } (custom find bar ->
 *                    main relays to webContents.findInPage/stopFindInPage,
 *                    since that API is main-process only)
 *     'find:stop'   payload string action ('clearSelection' | 'keepSelection'
 *                    | 'activateSelection')
 *   main -> renderer:
 *     'find:result' payload { matches, activeMatchOrdinal, finalUpdate }
 *                    (relayed from the webContents 'found-in-page' event)
 *
 * Connect (world chooser) window — same preload, extra methods:
 *   renderer -> main:
 *     'connect:list-profiles' (invoke) -> [{ id, name, host, port, color,
 *                    logins:[{name,autoLoginCommand}] }]  (list arrives already
 *                    sorted into the user's persisted worldOrder; worlds not
 *                    yet ordered trail alphabetically after the ordered ones)
 *     'connect:go'   payload { id, loginName, autoLoginCommand }  (existing world)
 *                 or payload { newWorld:{name,host,port,charset,tls,tlsAllowInsecure,color,routingPreset}, loginName, autoLoginCommand }
 *                    (create + connect a brand-new world; routingPreset is
 *                    'mush' or 'evennia', defaulting to 'mush')
 *     'connect:set-profile-order' (invoke) payload array of profile-id strings
 *                    -> the persisted array (app-wide Worlds-list order; see
 *                    settings-store.js's worldOrder)
 *     'connect:quit'                    (user clicked Quit)
 *   main -> renderer:
 *     'connect:error' payload string  (session start failed after Connect was
 *                    clicked, e.g. the profile vanished on disk; safe, non-
 *                    sensitive message only — no stack traces or file paths)
 *
 * Settings window — same preload, extra methods:
 *   renderer -> main:
 *     'settings:get' (invoke) -> settings object (DEFAULTS merged with persisted)
 *     'settings:set' (invoke) payload patch object -> merged settings object
 *                 (main shallow-merges patch over current settings and persists)
 *     'settings:sound-roster-add' (invoke) payload { kind: 'page'|'channel', name }
 *                 -> merged settings object (atomic disk-fresh append, used by
 *                 the Feed window instead of a full `sound` object write, so it
 *                 can't race/clobber a concurrent edit from the Settings window)
 *     'settings:close' (send)          (Cancel/Confirm ask main to close the
 *                 Settings window; a sandboxed renderer can't close its own)
 *     'history:get' (invoke) payload { kind:'page'|'channel', key } -> array of
 *                 { seq, text, ts } (in-memory per-key scrollback for tab
 *                 rehydration; ts is null for entries persisted before
 *                 timestamps existed)
 *     'profile:get-anti-idle' (invoke) -> boolean (current session's profile,
 *                 or false if no session)
 *     'profile:set-anti-idle' (invoke) payload boolean -> the boolean applied
 *                 (per-profile, scoped to the active session; see
 *                 profile-store.js's setAntiIdle)
 *     'profile:get-routing' (invoke) -> { customized, routingPreset, selfNames, loginName }
 *                 (per-profile; `customized` means this world's routing rules
 *                 were hand-edited and so were NOT auto-migrated to the current
 *                 preset, which is what the reset action below is for;
 *                 `routingPreset` is 'mush' or 'evennia', absent on disk
 *                 normalized to 'mush')
 *     'profile:reset-routing-rules' (invoke) -> boolean (writes the current
 *                 preset over this profile's routingRules, leaving every other
 *                 profile field untouched, and live-applies it to the router)
 *     'profile:set-routing-preset' (invoke) payload 'mush'|'evennia' -> the
 *                 preset actually applied (per-profile; switches which rule
 *                 set a world uses, always replacing routingRules with that
 *                 preset's current defaults, and live-applies it to the router;
 *                 an unrecognised value is a no-op that returns the current
 *                 preset unchanged)
 *     'profile:set-self-names' (invoke) payload string|string[] -> the
 *                 normalized string[] actually stored (your own character
 *                 name(s), used to keep both sides of a group page in one tab)
 *     'profile:set-color' (invoke) payload { id, color } -> the normalized
 *                 color actually stored (#rrggbb or null), so the renderer can
 *                 reconcile optimistic UI against what was really written.
 *                 Addressed BY PROFILE ID rather than the active session,
 *                 because colors are set from the Connect window before any
 *                 session exists (see main/index.js for the full reasoning)
 *   main -> renderer:
 *     'settings:changed' payload = full merged settings object (broadcast to
 *                 ALL open windows after any settings write, so every renderer
 *                 can re-apply theme/font live)
 */

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  // Return an unsubscribe handle.
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mush', {
  // main -> renderer subscriptions
  onInit: (cb) => on('feed:init', cb),
  onLine: (cb) => on('feed:line', cb),
  onSystem: (cb) => on('feed:system', cb),
  onClear: (cb) => on('feed:clear', cb),
  onPageLine: (cb) => on('pages:line', cb),
  onChannelLine: (cb) => on('channel:line', cb),
  onSettingsChanged: (cb) => on('settings:changed', cb),

  // renderer -> main (feed)
  ready: () => ipcRenderer.send('renderer:ready'),
  sendInput: (text) => ipcRenderer.send('input:send', String(text == null ? '' : text)),
  openExternal: (url) => ipcRenderer.send('shell:open-external', String(url == null ? '' : url)),

  // Find-in-page (custom find bar in feed.js)
  findInPage: (text, opts) =>
    ipcRenderer.send('find:query', {
      text: String(text == null ? '' : text),
      forward: !(opts && opts.forward === false),
      findNext: !!(opts && opts.findNext),
    }),
  stopFind: (action) => ipcRenderer.send('find:stop', String(action == null ? 'clearSelection' : action)),
  onFindResult: (cb) => on('find:result', cb),

  // Connect (world chooser) window
  listProfiles: () => ipcRenderer.invoke('connect:list-profiles'),
  setProfileOrder: (ids) =>
    ipcRenderer.invoke(
      'connect:set-profile-order',
      Array.isArray(ids) ? ids.map((v) => String(v == null ? '' : v)) : []
    ),
  onConnectError: (cb) => on('connect:error', cb),
  connectGo: (payload) => {
    const msg = {
      id: String(payload && payload.id != null ? payload.id : ''),
      loginName: String(payload && payload.loginName != null ? payload.loginName : ''),
      autoLoginCommand: String(
        payload && payload.autoLoginCommand != null ? payload.autoLoginCommand : ''
      ),
    };
    // Optional: create-and-connect a brand-new world. Sanitized to a fixed
    // shape here so the renderer can never smuggle extra fields into main.
    if (payload && payload.newWorld && typeof payload.newWorld === 'object') {
      const nw = payload.newWorld;
      msg.newWorld = {
        name: String(nw.name != null ? nw.name : ''),
        host: String(nw.host != null ? nw.host : ''),
        port: Number(nw.port) || 0,
        charset: String(nw.charset != null ? nw.charset : ''),
        tls: !!nw.tls,
        tlsAllowInsecure: !!nw.tlsAllowInsecure,
        // Not hex-validated here on purpose: profileStore.createProfile in
        // main is the single validation point and already rejects anything
        // malformed (falls back to null), so duplicating that check here
        // would just be a second place to keep in sync.
        color: typeof nw.color === 'string' ? nw.color : null,
        routingPreset: nw.routingPreset === 'evennia' ? 'evennia' : 'mush',
      };
    }
    ipcRenderer.send('connect:go', msg);
  },
  connectQuit: () => ipcRenderer.send('connect:quit'),

  // Settings window
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch && typeof patch === 'object' ? patch : {}),
  appendSoundRoster: (kind, name) =>
    ipcRenderer.invoke('settings:sound-roster-add', {
      kind: String(kind == null ? '' : kind),
      name: String(name == null ? '' : name),
    }),
  getHistory: (kind, key) =>
    ipcRenderer.invoke('history:get', {
      kind: String(kind == null ? '' : kind),
      key: String(key == null ? '' : key),
    }),
  closeSettings: () => ipcRenderer.send('settings:close'),

  // Per-profile (not app-wide) — see profile-store.js's setAntiIdle.
  getProfileAntiIdle: () => ipcRenderer.invoke('profile:get-anti-idle'),
  setProfileAntiIdle: (value) => ipcRenderer.invoke('profile:set-anti-idle', !!value),

  // Per-profile routing, scoped to the active session like anti-idle above.
  getProfileRouting: () => ipcRenderer.invoke('profile:get-routing'),
  resetProfileRoutingRules: () => ipcRenderer.invoke('profile:reset-routing-rules'),
  setProfileRoutingPreset: (preset) =>
    ipcRenderer.invoke('profile:set-routing-preset', preset === 'evennia' ? 'evennia' : 'mush'),
  setProfileSelfNames: (names) =>
    ipcRenderer.invoke(
      'profile:set-self-names',
      Array.isArray(names)
        ? names.map((v) => String(v == null ? '' : v))
        : String(names == null ? '' : names)
    ),

  // Per-profile, addressed BY ID rather than the active session, because the
  // Connect window sets colors before any session exists (see main/index.js).
  setProfileColor: (id, hexOrNull) =>
    ipcRenderer.invoke('profile:set-color', {
      id: String(id == null ? '' : id),
      color: typeof hexOrNull === 'string' ? hexOrNull : null,
    }),
});
