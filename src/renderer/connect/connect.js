// connect.js
// Display-only renderer for the Connect (world chooser) window. Mirrors the
// feed renderer's contract: no networking or filesystem access here — it only
// talks to main through the preload-exposed `window.mush` surface.
//
// Flow:
//   1. ask main for the discovered profiles (connect:list-profiles); each
//      profile now carries a non-empty `logins[]` array of named entries
//      ({ name, autoLoginCommand }) instead of a single login string, plus
//      an optional `color` (#rrggbb or null). listProfiles() already returns
//      them in the user's persisted display order — never sort in here.
//   2. show worlds in the left list; selecting one fills host + rebuilds the
//      Character dropdown from that world's logins, plus a trailing
//      "+ New character..." option. Selecting a character fills the Login
//      field below. Selecting "+ New character..." reveals an inline text
//      input for the new character's name instead.
//   3. Each world's detail pane also shows a row of color swatches (the fixed
//      PROFILE_COLORS palette, plus a "none" control). Picking one updates the
//      in-memory profile + its list dot immediately, then persists via
//      window.mush.setProfileColor(id, hex) and reconciles with whatever
//      value actually got stored (main may reject/normalize it). A brand-new
//      world has no profile id yet, so its chosen color is held in
//      `newWorldColor` and only reaches disk indirectly, riding along inside
//      the `connectGo({ newWorld: { ..., color } })` payload.
//   4. The world list itself is drag-and-drop reorderable (standard HTML5
//      dragstart/dragover/drop/dragend). A drop splices `profiles` into the
//      new order, re-renders, and persists the whole order app-wide via
//      window.mush.setProfileOrder(ids). The trailing "+ New World..." row is
//      not draggable and never a drop target — it lives outside `profiles`.
//   5. Connect -> window.mush.connectGo({ id, loginName, autoLoginCommand })
//      Quit    -> window.mush.connectQuit()
//
// The login string is shown in a masked (type="password") field because it
// typically carries a character name + password. In-session edits are kept
// in a local map keyed per (world, character) so switching between worlds
// and characters and back does not lose typing; they are only persisted to
// disk by main when Connect is clicked.

import { PROFILE_COLORS } from '../shared/color.js';

const listEl = document.getElementById('profile-list');
const hostportEl = document.getElementById('hostport');
const characterEl = document.getElementById('character');
const newNameEl = document.getElementById('new-name');
const colorSwatchesEl = document.getElementById('color-swatches');
const loginEl = document.getElementById('login');
const detailEl = document.getElementById('detail');
const connectBtn = document.getElementById('btn-connect');
const quitBtn = document.getElementById('btn-quit');
const connectErrorEl = document.getElementById('connect-error');

// New-world form (revealed when the "+ New World..." list entry is selected).
const existingDetailEl = document.getElementById('existing-detail');
const newWorldEl = document.getElementById('new-world');
const nwNameEl = document.getElementById('nw-name');
const nwHostEl = document.getElementById('nw-host');
const nwPortEl = document.getElementById('nw-port');
const nwCharsetEl = document.getElementById('nw-charset');
const nwServerTypeEl = document.getElementById('nw-server-type');
const nwTlsEl = document.getElementById('nw-tls');
const nwTlsInsecureEl = document.getElementById('nw-tls-insecure');
const nwTlsInsecureFieldEl = document.getElementById('nw-tls-insecure-field');
const nwColorSwatchesEl = document.getElementById('nw-color-swatches');
const nwErrorEl = document.getElementById('nw-error');

// Sentinel option value for "+ New character...". A leading space makes it
// impossible for a real (trimmed) character name to collide with it.
const NEW_SENTINEL = ' NEW';
// Sentinel world-list id for "+ New World...". Leading space => cannot collide
// with a real profile id (ids are lowercase alnum/hyphen slugs, never spaced).
const NEW_WORLD_SENTINEL = ' NEWWORLD';

let profiles = [];
let selectedId = null;
let selectedLogin = null; // character name string, or NEW_SENTINEL, or null
// "world id + character name" -> in-session edited login string (overrides
// the on-disk value shown).
const edits = new Map();

// Color chosen for a brand-new world (no profile id exists yet, so it can't
// be sent via setProfileColor — it rides along in the connectGo payload
// instead). Reset to null whenever the new-world form is (re)opened.
let newWorldColor = null;

// id of the world currently being dragged in the world list, or null.
let dragId = null;

function editKey(worldId, loginName) {
  return worldId + ' ' + loginName;
}

// Builds one color-swatch row (a "none" control plus one button per
// PROFILE_COLORS entry) into containerEl. Shared by the existing-world row
// and the new-world row so the markup/behavior can't drift between them.
// Real <button>s (not <div>s) so Enter/Space activation and tab focus come
// for free; type="button" so these never behave as an implicit form submit.
function buildSwatches(containerEl, onPick) {
  if (!containerEl) return;
  containerEl.textContent = '';

  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'swatch none';
  noneBtn.dataset.hex = '';
  noneBtn.title = 'No color';
  noneBtn.setAttribute('role', 'radio');
  noneBtn.setAttribute('aria-label', 'No color');
  noneBtn.setAttribute('aria-checked', 'false');
  noneBtn.addEventListener('click', () => onPick(null));
  containerEl.appendChild(noneBtn);

  for (const { hex, name } of PROFILE_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.hex = hex;
    btn.title = name;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', name);
    btn.setAttribute('aria-checked', 'false');
    // Only ever assigned via the style property from a fixed, curated palette
    // (never string-concatenated into markup) — see PROFILE_COLORS in color.js.
    btn.style.backgroundColor = hex;
    btn.addEventListener('click', () => onPick(hex));
    containerEl.appendChild(btn);
  }
}

// Marks exactly the control matching hexOrNull as selected (the "none"
// control's data-hex is '', matched when hexOrNull is null/falsy).
function markSelected(containerEl, hexOrNull) {
  if (!containerEl) return;
  const target = hexOrNull || '';
  for (const btn of containerEl.children) {
    const match = btn.dataset.hex === target;
    btn.classList.toggle('selected', match);
    btn.setAttribute('aria-checked', match ? 'true' : 'false');
  }
}

// Updates just one world's list dot in place. Deliberately NOT a full
// renderList(): renderList() re-runs selectProfile(), which rebuilds the
// Character dropdown back to the world's first login — fine after a drag
// reorder, but wrong here, since it would silently discard whichever
// character the user had picked while they were merely clicking a swatch.
function updateListDot(id) {
  let li = null;
  for (const child of listEl.children) {
    if (child.dataset.id === id) { li = child; break; }
  }
  if (!li) return;
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;

  let dot = li.querySelector('.world-dot');
  if (profile.color) {
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'world-dot';
      li.insertBefore(dot, li.firstChild);
    }
    dot.style.backgroundColor = profile.color;
  } else if (dot) {
    dot.remove();
  }
}

// Click handler for the existing-world color row (buildSwatches' onPick).
function pickExistingColor(hex) {
  if (selectedId == null || selectedId === NEW_WORLD_SENTINEL) return;
  const id = selectedId;
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;

  // Optimistic UI: reflect the pick instantly, then reconcile once the write
  // to disk resolves (main normalizes/validates, and resolves null if the
  // write was rejected or failed — that must not leave the UI showing a
  // color that was never actually persisted).
  profile.color = hex;
  markSelected(colorSwatchesEl, hex);
  updateListDot(id);

  if (window.mush && typeof window.mush.setProfileColor === 'function') {
    window.mush.setProfileColor(id, hex)
      .then((resolved) => {
        const p = profiles.find((pp) => pp.id === id);
        if (!p || p.color === resolved) return;
        p.color = resolved;
        if (selectedId === id) markSelected(colorSwatchesEl, resolved);
        updateListDot(id);
      })
      .catch(() => {});
  }
}

// Click handler for the new-world color row.
function pickNewWorldColor(hex) {
  newWorldColor = hex;
  markSelected(nwColorSwatchesEl, hex);
}

buildSwatches(colorSwatchesEl, pickExistingColor);
buildSwatches(nwColorSwatchesEl, pickNewWorldColor);

function selectProfile(id) {
  // Remember any edit to the field we are leaving.
  if (
    selectedId != null &&
    selectedId !== NEW_WORLD_SENTINEL &&
    selectedLogin != null &&
    selectedLogin !== NEW_SENTINEL
  ) {
    edits.set(editKey(selectedId, selectedLogin), loginEl.value);
  }

  // Whether the new-world form was ALREADY open before this call. A drag
  // reorder re-renders the list and re-selects whatever was selected, which
  // can land back here with the form already open and half-filled — that is a
  // re-selection, not a fresh open, and must not discard anything the user
  // typed or picked.
  const wasNewWorld = selectedId === NEW_WORLD_SENTINEL;

  selectedId = id;

  for (const li of listEl.children) {
    li.classList.toggle('selected', li.dataset.id === id);
  }

  // "+ New World..." selected: reveal the create-world form instead of the
  // normal connection detail. Connect stays disabled until host + port filled.
  if (id === NEW_WORLD_SENTINEL) {
    existingDetailEl.hidden = true;
    newWorldEl.hidden = false;
    nwErrorEl.hidden = true;
    selectedLogin = null;
    // A previously-abandoned new-world color choice must not leak into the
    // next new world — but only clear it when the form is genuinely being
    // opened. The name/host/port inputs are plain DOM and survive a
    // re-selection untouched, so silently wiping just the color would be
    // both inconsistent and invisible to the user. Server type gets the same
    // treatment: it's a plain <select> that would otherwise keep showing
    // whatever the last abandoned new-world form left it on.
    if (!wasNewWorld) {
      newWorldColor = null;
      if (nwServerTypeEl) nwServerTypeEl.value = 'mush';
    }
    markSelected(nwColorSwatchesEl, newWorldColor);
    updateNewWorldValidity();
    nwNameEl.focus();
    return;
  }

  // A real world: ensure the normal detail is showing, hide the new-world form.
  existingDetailEl.hidden = false;
  newWorldEl.hidden = true;

  const profile = profiles.find((p) => p.id === id);

  if (!profile) {
    hostportEl.textContent = '—';
    characterEl.textContent = '';
    newNameEl.hidden = true;
    loginEl.value = '';
    selectedLogin = null;
    markSelected(colorSwatchesEl, null);
    connectBtn.disabled = true;
    return;
  }

  const port = profile.port ? String(profile.port) : '(no port set)';
  hostportEl.textContent = `${profile.host || '(no host)'}:${port}${profile.tls ? ' (TLS)' : ''}`;
  markSelected(colorSwatchesEl, profile.color || null);

  // Rebuild the Character dropdown from this world's logins.
  characterEl.textContent = '';
  const logins = Array.isArray(profile.logins) ? profile.logins : [];
  for (const login of logins) {
    const opt = document.createElement('option');
    opt.value = login.name;
    opt.textContent = login.name;
    characterEl.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = NEW_SENTINEL;
  newOpt.textContent = '+ New character...';
  characterEl.appendChild(newOpt);

  newNameEl.hidden = true;
  // The edit-save above already handled the world we left; clear
  // selectedLogin so selectCharacter() below does not try to re-save it
  // under the new world's id.
  selectedLogin = null;

  const firstName = logins.length > 0 ? logins[0].name : NEW_SENTINEL;
  characterEl.value = firstName;
  selectCharacter(firstName);

  connectBtn.disabled = false;
}

function selectCharacter(name) {
  if (name === NEW_SENTINEL) {
    selectedLogin = NEW_SENTINEL;
    loginEl.value = '';
    newNameEl.hidden = false;
    newNameEl.value = '';
    newNameEl.focus();
    return;
  }

  // Remember any edit to the field we are leaving (only for real characters;
  // the "new character" state is never persisted under the sentinel).
  if (selectedId != null && selectedLogin != null && selectedLogin !== NEW_SENTINEL) {
    edits.set(editKey(selectedId, selectedLogin), loginEl.value);
  }

  selectedLogin = name;
  newNameEl.hidden = true;

  const profile = profiles.find((p) => p.id === selectedId);
  const logins = profile && Array.isArray(profile.logins) ? profile.logins : [];
  const match = logins.find((l) => l.name === name);
  const onDisk = match && typeof match.autoLoginCommand === 'string' ? match.autoLoginCommand : '';

  const key = editKey(selectedId, name);
  loginEl.value = edits.has(key) ? edits.get(key) : onDisk;
}

// dragover fires continuously while hovering; preventDefault is required on
// it (not just on drop) for the browser to allow a drop at all.
function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function onDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

function onDragStart(event, id) {
  dragId = id;
  event.dataTransfer.effectAllowed = 'move';
  // Chromium requires some data to be set for a drag to reliably start; the
  // value itself isn't read back (the reorder logic uses the closed-over id).
  event.dataTransfer.setData('text/plain', id);
  event.currentTarget.classList.add('dragging');
}

function onDrop(event, targetId) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if (dragId == null || dragId === targetId) return;

  const fromIndex = profiles.findIndex((p) => p.id === dragId);
  const toIndex = profiles.findIndex((p) => p.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;

  const [moved] = profiles.splice(fromIndex, 1);
  profiles.splice(toIndex, 0, moved);

  // Preserve whatever was selected before the reorder — a drop must not
  // reset the detail pane back to the first world.
  renderList({ preserveSelection: true });

  if (window.mush && typeof window.mush.setProfileOrder === 'function') {
    window.mush.setProfileOrder(profiles.map((p) => p.id)).catch(() => {});
  }
}

function onDragEnd() {
  dragId = null;
  for (const li of listEl.children) {
    li.classList.remove('dragging', 'drag-over');
  }
}

// `preserveSelection: true` re-applies whatever was selected before this
// render (used after a drag-and-drop reorder) instead of resetting to the
// first world. The auto-select-first/new-world-form behavior is otherwise
// only meant for the very first render after load().
function renderList(options) {
  const preserveSelection = !!(options && options.preserveSelection);
  const previousSelectedId = selectedId;

  listEl.textContent = '';
  detailEl.hidden = false;

  for (const profile of profiles) {
    const li = document.createElement('li');

    // Omit the dot entirely when there's no color — no placeholder swatch.
    if (profile.color) {
      const dot = document.createElement('span');
      dot.className = 'world-dot';
      dot.style.backgroundColor = profile.color;
      li.appendChild(dot);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'world-name';
    nameEl.textContent = profile.name || profile.id;
    li.appendChild(nameEl);

    li.dataset.id = profile.id;
    li.draggable = true;
    li.addEventListener('click', () => selectProfile(profile.id));
    li.addEventListener('dblclick', () => doConnect());
    li.addEventListener('dragstart', (event) => onDragStart(event, profile.id));
    li.addEventListener('dragover', onDragOver);
    li.addEventListener('dragleave', onDragLeave);
    li.addEventListener('drop', (event) => onDrop(event, profile.id));
    li.addEventListener('dragend', onDragEnd);
    listEl.appendChild(li);
  }

  // Trailing "+ New World..." entry: selecting it reveals the create-world
  // form (no dblclick-to-connect, since its fields must be filled first).
  // Always present, so a first-run user with no saved worlds can create one.
  // Not draggable and never a drop target — it isn't part of `profiles` and
  // must always stay last, so it gets none of the drag/drop listeners above.
  const newWorldLi = document.createElement('li');
  newWorldLi.textContent = '+ New World...';
  newWorldLi.dataset.id = NEW_WORLD_SENTINEL;
  newWorldLi.className = 'new-world-item';
  newWorldLi.addEventListener('click', () => selectProfile(NEW_WORLD_SENTINEL));
  listEl.appendChild(newWorldLi);

  if (preserveSelection && previousSelectedId != null) {
    selectProfile(previousSelectedId);
  } else if (profiles.length > 0) {
    // Auto-select the first world so Connect is immediately usable.
    selectProfile(profiles[0].id);
  } else {
    // First run: no saved worlds yet. Open the create-world form straight
    // away so the whole onboarding path is "+ New World..." with no JSON.
    selectProfile(NEW_WORLD_SENTINEL);
  }
}

function showNwError(msg) {
  nwErrorEl.textContent = msg;
  nwErrorEl.hidden = false;
}

// Enable Connect only once the new-world form has a host and a port. Mirrors
// the spirit of index.js's "No port set for..." guard, but pre-persistence.
function updateNewWorldValidity() {
  const ok = nwHostEl.value.trim() !== '' && nwPortEl.value.trim() !== '';
  connectBtn.disabled = !ok;
  if (ok) nwErrorEl.hidden = true;
}

function doConnect() {
  // Clear any error from a previous failed attempt so a retry doesn't show a
  // stale message alongside the new one.
  if (connectErrorEl) connectErrorEl.hidden = true;

  if (selectedId == null) return;

  // Create-and-connect a brand-new world.
  if (selectedId === NEW_WORLD_SENTINEL) {
    const name = nwNameEl.value.trim();
    const host = nwHostEl.value.trim();
    const port = nwPortEl.value.trim();
    const charset = nwCharsetEl.value || 'utf8';
    const routingPreset = nwServerTypeEl && nwServerTypeEl.value === 'evennia' ? 'evennia' : 'mush';
    const useTls = !!(nwTlsEl && nwTlsEl.checked);
    const tlsAllowInsecure = useTls && !!(nwTlsInsecureEl && nwTlsInsecureEl.checked);
    if (!host || !port) {
      showNwError('Host and port are required.');
      return;
    }
    if (window.mush && typeof window.mush.connectGo === 'function') {
      window.mush.connectGo({
        newWorld: {
          name,
          host,
          port: Number(port),
          charset,
          tls: useTls,
          tlsAllowInsecure,
          color: newWorldColor,
          routingPreset,
        },
        loginName: 'Default',
        autoLoginCommand: '',
      });
    }
    return;
  }

  let loginName;
  if (selectedLogin === NEW_SENTINEL) {
    const name = newNameEl.value.trim();
    if (!name) return; // a new character needs a name
    loginName = name;
  } else {
    loginName = selectedLogin;
  }

  const login = loginEl.value;
  edits.set(editKey(selectedId, loginName), login);

  if (window.mush && typeof window.mush.connectGo === 'function') {
    window.mush.connectGo({ id: selectedId, loginName, autoLoginCommand: login });
  }
}

if (characterEl) {
  characterEl.addEventListener('change', () => selectCharacter(characterEl.value));
}

if (newNameEl) {
  newNameEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      doConnect();
    }
  });
}

if (loginEl) {
  loginEl.addEventListener('input', () => {
    // Only persist edits for real (non-new) characters; the "new character"
    // value is simply read from the field at Connect time.
    if (selectedId != null && selectedLogin != null && selectedLogin !== NEW_SENTINEL) {
      edits.set(editKey(selectedId, selectedLogin), loginEl.value);
    }
  });
  loginEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      doConnect();
    }
  });
}

// New-world form: live-validate Connect on host/port, Enter to connect.
for (const el of [nwHostEl, nwPortEl]) {
  if (el) el.addEventListener('input', updateNewWorldValidity);
}

// The "allow self-signed / unverified certificate" opt-out only makes sense
// once TLS itself is on — keep it hidden (and unchecked-equivalent, since
// doConnect() reads useTls && insecureEl.checked) otherwise.
if (nwTlsEl && nwTlsInsecureFieldEl) {
  nwTlsEl.addEventListener('change', () => {
    nwTlsInsecureFieldEl.hidden = !nwTlsEl.checked;
  });
}
for (const el of [nwNameEl, nwHostEl, nwPortEl]) {
  if (el) {
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        doConnect();
      }
    });
  }
}

if (connectBtn) connectBtn.addEventListener('click', doConnect);
if (quitBtn) {
  quitBtn.addEventListener('click', () => {
    if (window.mush && typeof window.mush.connectQuit === 'function') {
      window.mush.connectQuit();
    }
  });
}

// Main reports a failed session start (e.g. the profile vanished on disk
// between listing it and clicking Connect). Show it so the user isn't left
// looking at an unresponsive window with no feedback.
if (window.mush && typeof window.mush.onConnectError === 'function') {
  window.mush.onConnectError((msg) => {
    if (!connectErrorEl) return;
    connectErrorEl.textContent = String(msg || 'Connection failed.');
    connectErrorEl.hidden = false;
  });
}

async function load() {
  if (!window.mush || typeof window.mush.listProfiles !== 'function') return;
  try {
    profiles = await window.mush.listProfiles();
  } catch (e) {
    profiles = [];
  }
  if (!Array.isArray(profiles)) profiles = [];
  renderList();
}

load();
