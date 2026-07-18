// resizer.js
// Drag-to-resize gutter helper for layout panels. `clamp()` is pure and safe
// to import from Node (used by the unit test). `makeResizer()` uses
// `document`/`window`/pointer APIs and is browser-only — never call it from
// a Node test. No DOM/window access happens at module top level, only
// inside the functions below, so this file is importable in plain Node.

export function clamp(value, min, max) {
  if (typeof max === 'number' && max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function makeResizer(opts) {
  const {
    gutterEl,
    axis,
    direction = 1,
    getSize,
    setSize,
    min = 0,
    max,
    onCommit,
  } = opts;

  if (!gutterEl) return undefined;

  function resolveMax() {
    const resolved = typeof max === 'function' ? max() : max;
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : Infinity;
  }

  let startPos = 0;
  let startSize = 0;
  let lastSize = 0;
  let dragging = false;

  function onPointerMove(e) {
    if (!dragging) return;
    const pos = axis === 'x' ? e.clientX : e.clientY;
    const delta = (pos - startPos) * direction;
    const size = clamp(startSize + delta, min, resolveMax());
    lastSize = size;
    setSize(size);
  }

  function onPointerUp(e) {
    dragging = false;
    try {
      gutterEl.releasePointerCapture(e.pointerId);
    } catch (err) {
      // ignore — pointer capture may already be released
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    document.body.classList.remove('resizing');
    if (typeof onCommit === 'function') onCommit(lastSize);
  }

  function onPointerDown(e) {
    e.preventDefault();
    startPos = axis === 'x' ? e.clientX : e.clientY;
    startSize = getSize();
    lastSize = startSize;
    dragging = true;
    try {
      gutterEl.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore — pointer capture is best-effort
    }
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  gutterEl.addEventListener('pointerdown', onPointerDown);

  return {
    applySize(px) {
      const size = clamp(px, min, resolveMax());
      setSize(size);
      return size;
    },
  };
}
