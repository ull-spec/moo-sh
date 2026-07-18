// input-history.js
// Pure, DOM-free readline-style command-history model for the feed window's
// input box. No imports, no `document` — unit-testable in plain Node.
//
// Slots: index 0..entries.length-1 are committed history entries (oldest ->
// newest, index N = entries.length is a virtual "draft" slot holding
// whatever is currently being typed and not yet submitted.
//
// `edits` remembers whatever was on-screen at EVERY slot visited during the
// CURRENT browsing session (keyed by slot index), so navigating away from a
// slot and back never discards text the user typed there — including the
// draft slot itself. This fixes a bug where text typed while already
// browsing history (i.e. not just on the very first Up press) was silently
// dropped: the old inline implementation only captured the draft once, on
// the transition into history mode, and never again.
export function createInputHistory(max = 200) {
  const entries = [];
  let idx = null; // null = not currently browsing; otherwise 0..entries.length
  let edits = {}; // slot index -> last-seen text for this browsing session

  function valueAt(i) {
    if (edits[i] !== undefined) return edits[i];
    return i === entries.length ? '' : entries[i];
  }

  function up(current) {
    if (entries.length === 0) return current;
    if (idx === null) {
      idx = entries.length; // begin a session at the draft slot
      edits = {};
    }
    edits[idx] = current; // always save what's on screen now, every step
    if (idx > 0) idx -= 1;
    return valueAt(idx);
  }

  function down(current) {
    if (idx === null) return current;
    edits[idx] = current;
    if (idx < entries.length) idx += 1;
    return valueAt(idx);
  }

  function submit(value) {
    if (value.length > 0) {
      entries.push(value);
      if (entries.length > max) entries.shift();
    }
    idx = null;
    edits = {};
  }

  function reset() {
    idx = null;
    edits = {};
  }

  function size() {
    return entries.length;
  }

  return { up, down, submit, valueAt, reset, size };
}
