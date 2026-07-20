// Reusable tabbed panel for the feed window's right column. Instantiated twice
// (Pages, Channels): both are structurally identical — a tab strip plus a
// content area where each tab is backed by its own createLineView scrollback.
// Browser-only (uses `document`); never import from a Node test.
//
// Tab lifecycle (see the client's design notes):
//   - Lazy: a tab is created on the first line for its key (person / channel).
//   - If the panel was empty, the new tab becomes active. Otherwise it is
//     created inactive with an `unread` marker so background traffic never
//     steals focus; the marker clears when the user activates the tab.
//   - Tabs are user-closeable; closing tears down the line-view (no hidden
//     retention). A later line for a closed key lazily creates a fresh tab —
//     which, when a `hydrate` hook is supplied, rehydrates from the
//     main-process in-memory history store (seq-deduped) instead of starting
//     blank. Without a hydrate hook it comes back empty, like the first
//     message ever.
//   - A panel with zero tabs shows its empty-state placeholder.
//   - Tab count is capped at `maxTabs` (default 50): once the cap is hit, the
//     least-recently-active tab (never the currently active one) is evicted
//     via closeTab() to make room for a genuinely new key.

import { createLineView } from './line-view.js';

/**
 * @param {{ stripEl: HTMLElement, bodyEl: HTMLElement, emptyEl?: HTMLElement,
 *           maxLines?: number, maxTabs?: number, images?: boolean,
 *           hydrate?: (key: string) => Promise<Array<{seq:number,text:string}>> }} opts
 */
export function createTabbedPanel(opts = {}) {
  const { stripEl, bodyEl, emptyEl, maxLines, maxTabs = 50, images, hydrate } = opts;
  // key -> { key, name, tabEl, viewEl, view, seen, hydrating, buffer }
  const tabs = new Map();
  let activeKey = null;

  function updateEmpty() {
    if (emptyEl) emptyEl.hidden = tabs.size > 0;
  }

  function activate(key) {
    const target = tabs.get(key);
    if (!target) return;
    // Move to the MRU end of the Map so iteration order reflects recency;
    // this keeps activeKey's entry last while active, protecting it from
    // the LRU eviction scan in createTab.
    tabs.delete(key);
    tabs.set(key, target);
    activeKey = key;
    for (const [k, t] of tabs) {
      const on = k === key;
      t.tabEl.classList.toggle('active', on);
      t.viewEl.classList.toggle('active', on);
      if (on) {
        t.tabEl.classList.remove('unread');
        // Lines may have arrived while this view was hidden (scroll math is a
        // no-op on a display:none element); snap it to the bottom on show.
        t.viewEl.scrollTop = t.viewEl.scrollHeight;
      }
    }
  }

  function closeTab(key) {
    const t = tabs.get(key);
    if (!t) return;
    t.tabEl.remove();
    t.viewEl.remove();
    tabs.delete(key);
    if (activeKey === key) {
      activeKey = null;
      const next = tabs.keys().next();
      if (!next.done) activate(next.value);
    }
    updateEmpty();
  }

  function createTab(key, name) {
    if (tabs.size >= maxTabs) {
      // Evict the least-recently-active tab to make room. Map iteration
      // order = recency (see activate()/appendLine()'s delete+set idiom), so
      // the first entry is the oldest-touched. Never evict activeKey — skip
      // it explicitly even though it should already be at the MRU end.
      for (const k of tabs.keys()) {
        if (k === activeKey) continue;
        closeTab(k);
        break;
      }
      // If eviction didn't free a slot for some edge case, proceed anyway —
      // never refuse to render a genuinely new incoming line.
    }
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.key = key;

    const labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    labelEl.textContent = name;
    tabEl.appendChild(labelEl);

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.textContent = '×'; // ×
    closeEl.title = 'Close tab';
    tabEl.appendChild(closeEl);

    const viewEl = document.createElement('div');
    viewEl.className = 'tab-view';

    tabEl.addEventListener('click', () => activate(key));
    closeEl.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(key);
    });

    stripEl.appendChild(tabEl);
    bodyEl.appendChild(viewEl);

    const view = createLineView(viewEl, { maxLines, images });
    const entry = { key, name, tabEl, viewEl, view, seen: new Set(), hydrating: false, buffer: [] };
    tabs.set(key, entry);
    return entry;
  }

  function renderOne(t, text, seq, ts) {
    if (seq != null && t.seen) {
      if (t.seen.has(seq)) return;   // dedupe (already rendered from history)
      t.seen.add(seq);
    }
    t.view.appendLine(text, ts);
    // Mark unread if this isn't the active tab, OR if the whole window is
    // OS-unfocused — a line arriving while the user isn't looking at the
    // window at all should still mark even the tab that's nominally active.
    if (t.key !== activeKey || !document.hasFocus()) t.tabEl.classList.add('unread');
  }

  // Called when hydrate() resolves: render historical lines (oldest-first,
  // above), skipping any seq already seen, then flush live lines that arrived
  // (and were buffered) during the round-trip, in arrival order.
  function renderHydration(t, hist) {
    if (Array.isArray(hist)) {
      for (const h of hist) {
        if (h == null) continue;
        renderOne(t, h.text, h.seq, h.ts);
      }
    }
    const buffered = t.buffer;
    t.buffer = [];
    t.hydrating = false;
    for (const b of buffered) renderOne(t, b.text, b.seq, b.ts);
    // Hydration (history + buffered live lines) is now fully flushed — the
    // seq-dedupe Set is never needed again for this tab's lifetime, so drop
    // it rather than let it grow unbounded for as long as the tab lives.
    t.seen = null;
    if (t.key === activeKey) t.viewEl.scrollTop = t.viewEl.scrollHeight;
  }

  // Append `text` (may contain ANSI) to the tab identified by `key`, creating
  // the tab (labelled `name`) lazily if needed. `seq` (optional) is the
  // main-process history sequence number, used to dedupe against hydrated
  // history during the async round-trip. `ts` (optional) is the epoch-ms
  // moment the line was recorded, rendered as a small timestamp.
  function appendLine(key, name, text, seq, ts) {
    let t = tabs.get(key);
    if (t) {
      // Existing tab is being touched by a new line — refresh its recency so
      // an active/recently-busy conversation is never the LRU eviction
      // target, even without an explicit activate() call.
      tabs.delete(key);
      tabs.set(key, t);
    }
    if (!t) {
      const wasEmpty = tabs.size === 0;
      t = createTab(key, name);
      updateEmpty();
      if (wasEmpty) activate(key);   // synchronous, so isActive(key) is correct immediately
      if (typeof hydrate === 'function') {
        // Defer the triggering line and any that arrive mid-round-trip; render
        // them after history so scrollback is chronological and deduped.
        t.hydrating = true;
        t.buffer.push({ text, seq, ts });
        if (key !== activeKey || !document.hasFocus()) t.tabEl.classList.add('unread');
        Promise.resolve()
          .then(() => hydrate(key))
          .then((hist) => renderHydration(t, hist))
          .catch(() => renderHydration(t, []));  // failure still flushes the buffer
        return;
      }
      // No hydrate: fall through to synchronous render below.
    }
    if (t.hydrating) {
      t.buffer.push({ text, seq, ts });
      if (key !== activeKey || !document.hasFocus()) t.tabEl.classList.add('unread');
      return;
    }
    renderOne(t, text, seq, ts);
  }

  // Called when the whole window regains OS focus: clears the unread marker
  // on the currently-active tab only, since the user is now looking at it.
  // Background tabs keep their marker until the user actually activates them.
  function notifyFocused() {
    const t = tabs.get(activeKey);
    if (t) t.tabEl.classList.remove('unread');
  }

  updateEmpty();

  return {
    appendLine,
    activate,
    closeTab,
    notifyFocused,
    has: (key) => tabs.has(key),
    size: () => tabs.size,
    // Exposes the internal activeKey so callers (e.g. sound gating) can tell
    // whether a given tab is the one currently visible to the user.
    isActive: (key) => key === activeKey,
  };
}
