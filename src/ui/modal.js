import { h, clear } from './dom.js';

let host = null;

function ensureHost() {
  if (!host) {
    host = h('div', { class: 'modal-host' });
    document.body.appendChild(host);
  }
  return host;
}

export function openModal({ title, body, actions = [], onClose }) {
  const root = ensureHost();
  clear(root);
  const close = () => {
    clear(root);
    root.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const bodyEl = h('div', { class: 'modal-body' }, body);
  const panel = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' },
      h('div', { class: 'modal-title' }, title),
      h('button', { class: 'btn btn-mini', onclick: close, 'aria-label': 'Close' }, '×'),
    ),
    bodyEl,
    actions.length ? h('div', { class: 'modal-actions' }, ...actions.map((a) =>
      h('button', { class: `btn ${a.primary ? 'btn-primary' : 'btn-ghost'}`, onclick: () => a.onClick(close) }, a.label),
    )) : null,
  );

  root.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
  root.appendChild(panel);
  root.classList.add('open');
  return { close, setBody: (next) => clear(bodyEl).appendChild(next) };
}

export function toast(message, kind = 'info', ms = 4000) {
  let bar = document.querySelector('.toast-host');
  if (!bar) {
    bar = h('div', { class: 'toast-host' });
    document.body.appendChild(bar);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  bar.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}
