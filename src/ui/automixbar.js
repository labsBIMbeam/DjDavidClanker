import { h, fader } from './dom.js';

/** Control strip for the Automix: on/off, skip, fade length, sync, shuffle. */
export function AutomixBar(automix, { onQueueFromBrowser, performer = null }) {
  const btnPerf = h('button', {
    class: 'btn btn-perf',
    title: 'Performer: bar-synced scratches, loop rolls, FX bursts and blends over the running mix — every gesture undoes itself, and your hand always wins',
    onclick: () => { if (performer) performer.toggle(); },
    style: performer ? {} : { display: 'none' },
  }, '✦ PERFORM');
  const perfInfo = h('span', { class: 'perf-info' }, '');
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
    class: 'btn btn-mixnow',
    title: 'Transition now (N)',
    onclick: () => automix.skip(),
  }, 'MIX NOW');

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

  const STYLES = ['auto', 'blend', 'cut', 'echo', 'spinback', 'fade'];
  const btnStyle = h('button', {
    class: 'btn btn-mini',
    title: 'Transition style: AUTO picks per pair (with a seam budget) · BLEND phrase-aligned bass swap · CUT on the phrase · ECHO tail exit · SPINBACK hard rewind exit · FADE legacy crossfade',
    onclick: () => {
      automix.transitionStyle = STYLES[(STYLES.indexOf(automix.transitionStyle) + 1) % STYLES.length];
      render();
    },
  }, 'AUTO');

  const ORDER_LABELS = { list: 'LIST', shuffle: 'SHUF', smart: 'SMART' };
  const ORDERS = ['list', 'shuffle', 'smart'];
  const btnOrder = h('button', {
    class: 'btn btn-mini',
    title: 'Track order: LIST as queued · SHUF random · SMART picks by key/BPM/energy continuity',
    onclick: () => {
      automix.order = ORDERS[(ORDERS.indexOf(automix.order) + 1) % ORDERS.length];
      render();
    },
  }, ORDER_LABELS[automix.order] || 'LIST');

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
      btnStyle,
      btnSync,
      btnOrder,
      btnPerf,
      perfInfo,
    ),
  );

  function render() {
    btnOn.classList.toggle('on', automix.enabled);
    btnOn.textContent = automix.enabled ? '■ AUTOMIX' : '▶▶ AUTOMIX';
    btnNext.disabled = !automix.enabled;
    btnSync._sync();
    btnStyle.textContent = (automix.transitionStyle || 'auto').toUpperCase();
    btnStyle.classList.toggle('on', automix.transitionStyle !== 'auto');
    btnOrder.textContent = ORDER_LABELS[automix.order] || 'LIST';
    btnOrder.classList.toggle('on', automix.order !== 'list');
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

    if (performer) {
      btnPerf.classList.toggle('on', performer.enabled);
      const info = performer.enabled
        ? `${(performer.mood || '').toUpperCase()}${performer.lastAction ? ' · ' + performer.lastAction : ''}`
        : '';
      if (perfInfo.textContent !== info) perfInfo.textContent = info;
    }
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
