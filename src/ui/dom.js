/** Tiny hyperscript. No templating, no eval — CSP-safe by construction. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtSats(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Pointer-drag helper for faders and the jog wheel.
 * `onMove` gets (dx, dy, event) in CSS pixels from the drag origin.
 */
export function drag(el, { onStart, onMove, onEnd } = {}) {
  let active = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    active = { x: e.clientX, y: e.clientY, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    if (onStart) onStart(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return;
    if (onMove) onMove(e.clientX - active.x, e.clientY - active.y, e);
  });
  const stop = (e) => {
    if (!active || (e.pointerId !== undefined && e.pointerId !== active.id)) return;
    active = null;
    el.classList.remove('dragging');
    if (onEnd) onEnd(e);
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

/** Vertical or horizontal fader built on a range input, styled by CSS. */
export function fader({ min, max, step, value, orient = 'h', label, onInput, className = '' }) {
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    class: `fader fader-${orient} ${className}`,
    'aria-label': label || '',
    oninput: (e) => onInput(parseFloat(e.target.value), e),
  });
  return input;
}
