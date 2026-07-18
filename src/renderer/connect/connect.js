// connect.js
// Display-only renderer for the Connect (world chooser) window. Mirrors the
// feed renderer's contract: no networking or filesystem access here — it only
// talks to main through the preload-exposed `window.mush` surface.
//
// Flow:
//   1. ask main for the discovered profiles (connect:list-profiles); each
//      profile now carries a non-empty `logins[]` array of named entries
//      ({ name, autoLoginCommand }) instead of a single login string.
//   2. show worlds in the left list; selecting one fills host + rebuilds the
//      Character dropdown from that world's logins, plus a trailing
//      "+ New character..." option. Selecting a character fills the Login
//      field below. Selecting "+ New character..." reveals an inline text
//      input for the new character's name instead.
//   3. Connect -> window.mush.connectGo({ id, loginName, autoLoginCommand })
//      Quit    -> window.mush.connectQuit()
//
// The login string is shown in a masked (type="password") field because it
// typically carries a character name + password. In-session edits are kept
// in a local map keyed per (world, character) so switching between worlds
// and characters and back does not lose typing; they are only persisted to
// disk by main when Connect is clicked.

const listEl = document.getElementById('profile-list');
const hostportEl = document.getElementById('hostport');
const characterEl = document.getElementById('character');
const newNameEl = document.getElementById('new-name');
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
const nwTlsEl = document.getElementById('nw-tls');
const nwTlsInsecureEl = document.getElementById('nw-tls-insecure');
const nwTlsInsecureFieldEl = document.getElementById('nw-tls-insecure-field');
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

function editKey(worldId, loginName) {
  return worldId + ' ' + loginName;
}

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
    connectBtn.disabled = true;
    return;
  }

  const port = profile.port ? String(profile.port) : '(no port set)';
  hostportEl.textContent = `${profile.host || '(no host)'}:${port}${profile.tls ? ' (TLS)' : ''}`;

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

function renderList() {
  listEl.textContent = '';
  detailEl.hidden = false;

  for (const profile of profiles) {
    const li = document.createElement('li');
    li.textContent = profile.name || profile.id;
    li.dataset.id = profile.id;
    li.addEventListener('click', () => selectProfile(profile.id));
    li.addEventListener('dblclick', () => doConnect());
    listEl.appendChild(li);
  }

  // Trailing "+ New World..." entry: selecting it reveals the create-world
  // form (no dblclick-to-connect, since its fields must be filled first).
  // Always present, so a first-run user with no saved worlds can create one.
  const newWorldLi = document.createElement('li');
  newWorldLi.textContent = '+ New World...';
  newWorldLi.dataset.id = NEW_WORLD_SENTINEL;
  newWorldLi.className = 'new-world-item';
  newWorldLi.addEventListener('click', () => selectProfile(NEW_WORLD_SENTINEL));
  listEl.appendChild(newWorldLi);

  if (profiles.length > 0) {
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
    const useTls = !!(nwTlsEl && nwTlsEl.checked);
    const tlsAllowInsecure = useTls && !!(nwTlsInsecureEl && nwTlsInsecureEl.checked);
    if (!host || !port) {
      showNwError('Host and port are required.');
      return;
    }
    if (window.mush && typeof window.mush.connectGo === 'function') {
      window.mush.connectGo({
        newWorld: { name, host, port: Number(port), charset, tls: useTls, tlsAllowInsecure },
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
