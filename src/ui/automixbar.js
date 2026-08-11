import { h, fader } from './dom.js';

/** Control strip for the Automix: on/off, skip, fade length, sync, shuffle. */
export function AutomixBar(automix, { onQueueFromBrowser }) {
  const btnOn = h('button', {
    class: 'btn btn-automix',
    title: 'Automix: loads, beatmatches and crossfades on its own (X)',
    onclick: () => {
      if (!automix.enabled && !automix.queue.length) onQueueFromBrowser();
      automix.toggle();
      render();
    },
  }, '▶▶ AUTOMIX');

  const btnNext = h('button', {
    class: 'btn btn-mini',
    title: 'Crossfade now (N)',
    onclick: () => automix.skip(),
  }, '⏭');

  const btnLoad = h('button', {
    class: 'btn btn-mini',
    title: 'Take the current browser list as the automix queue',
    onclick: () => { onQueueFromBrowser(); render(); },
  }, '⤓ List');

  const label = h('span', { class: 'am-label' }, 'OFF');
  const detail = h('span', { class: 'am-detail' }, '');

  const fadeVal = h('span', { class: 'am-num' }, `${automix.fadeSeconds}s`);
  const fadeFader = fader({
    min: 2, max: 45, step: 1, value: automix.fadeSeconds, orient: 'h', label: 'Crossfade length',
    className: 'am-fade',
    onInput: (v) => {
      automix.fadeSeconds = v;
      fadeVal.textContent = `${v}s`;
    },
  });

  const toggle = (text, get, set, title) => {
    const b = h('button', { class: 'btn btn-mini', title, onclick: () => { set(!get()); render(); } }, text);
    b._sync = () => b.classList.toggle('on', get());
    return b;
  };
  const btnSync = toggle('SYNC', () => automix.syncTempo, (v) => { automix.syncTempo = v; }, 'Pull the next deck onto the BPM before the transition');
  const btnShuffle = toggle('SHUFFLE', () => automix.shuffle, (v) => { automix.shuffle = v; }, 'Random order instead of list order');

  const meter = h('div', { class: 'am-meter' }, h('div', { class: 'am-meter-fill' }));

  const root = h('div', { class: 'automix' },
    btnOn,
    h('div', { class: 'am-status' },
      h('div', { class: 'am-line' }, label, detail),
      meter,
    ),
    h('div', { class: 'am-controls' },
      btnNext,
      btnLoad,
      h('div', { class: 'am-fade-box' }, h('span', { class: 'fx-lbl' }, 'Fade'), fadeFader, fadeVal),
      btnSync,
      btnShuffle,
    ),
  );

  function render() {
    btnOn.classList.toggle('on', automix.enabled);
    btnOn.textContent = automix.enabled ? '■ AUTOMIX' : '▶▶ AUTOMIX';
    btnNext.disabled = !automix.enabled;
    btnSync._sync();
    btnShuffle._sync();
    root.classList.toggle('active', automix.enabled);
  }

  /** Called each frame; cheap string/width updates only. */
  function tick() {
    const d = automix.describe();
    if (label.textContent !== d.label) label.textContent = d.label;
    if (detail.textContent !== d.detail) detail.textContent = d.detail;

    // The meter fills as the live track approaches its transition point.
    let pct = 0;
    if (automix.fade || automix.transition) pct = 100;
    else if (automix.enabled && automix.liveId) {
      const left = automix.remaining;
      if (Number.isFinite(left)) {
        const deck = automix.liveDeck;
        const total = deck && deck.duration ? deck.duration : 0;
        pct = total ? Math.min(100, (1 - Math.max(0, left - automix.fadeSeconds) / total) * 100) : 0;
      }
    }
    meter.firstChild.style.width = `${pct}%`;
    meter.classList.toggle('hot', Boolean(automix.fade || automix.transition));
  }

  // Chain onto whatever hook the caller already installed rather than
  // replacing it — the app also listens for status changes.
  const prevStatus = automix.onStatus;
  automix.onStatus = (s) => {
    if (prevStatus) prevStatus(s);
    render();
  };

  render();
  return { root, render, tick };
}
