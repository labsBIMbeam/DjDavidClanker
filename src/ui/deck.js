import { h, clear, fmtTime, fader } from './dom.js';
import { setImage } from '../lib/artwork.js';
import { SEC_PER_REV, FX_TYPES, FILTER_MODELS, MACRO_TYPES, MACRO_LABELS } from '../audio/engine.js';
import { Platter } from './platter.js';
import { LevelMeter } from './meter.js';

const DIVISIONS = [
  ['1/4', 1],
  ['1/8', 0.5],
  ['1/16', 0.25],
  ['1/32', 0.125],
];

/**
 * One deck panel. Owns its own canvas cache: the static waveform is rendered
 * once into an offscreen canvas on `peaks`, then blitted each frame with the
 * playhead drawn over it, so the rAF loop stays cheap.
 */
export function DeckPanel(deck, { onZap, onEject, accent }) {
  const wave = h('canvas', { class: 'wave', height: 120 });

  /* Zoom: ×1 = whole track (cached overview); beyond that a playhead-centered
     window rendered live from the fine peak set. */
  const view = { zoom: 1 };
  const zoomOut = h('button', { class: 'btn btn-mini zoom-out', title: 'Zoom the waveform out' }, '−');
  const zoomLabel = h('button', { class: 'btn btn-mini zoom-fit', title: 'Reset zoom (whole track)' }, '×1');
  const zoomIn = h('button', { class: 'btn btn-mini zoom-in', title: 'Zoom the waveform in' }, '+');
  const zoomBox = h('div', { class: 'wave-zoom' }, zoomOut, zoomLabel, zoomIn);
  const waveWrap = h('div', { class: 'wave-wrap' }, wave, zoomBox, h('div', { class: 'wave-empty' }, 'No track loaded'));

  function setZoom(z) {
    view.zoom = Math.max(1, Math.min(64, z));
    const zl = view.zoom;
    zoomLabel.textContent = zl < 1.05 ? '×1' : zl < 10 ? `×${zl.toFixed(1)}` : `×${Math.round(zl)}`;
    waveWrap.dataset.zoom = String(Math.round(zl * 100) / 100);
  }
  zoomIn.addEventListener('click', () => setZoom(view.zoom * 1.5));
  zoomOut.addEventListener('click', () => setZoom(view.zoom / 1.5));
  zoomLabel.addEventListener('click', () => setZoom(1));
  waveWrap.addEventListener('wheel', (e) => {
    if (!deck.peaks) return;
    e.preventDefault();
    setZoom(view.zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3));
  }, { passive: false });
  setZoom(1);

  /** Visible track window: whole track at ×1, else centered on the playhead. */
  function viewWindow() {
    const dur = deck.duration || 1;
    const span = dur / view.zoom;
    let t0 = deck.position - span / 2;
    t0 = Math.max(0, Math.min(dur - span, t0));
    return { t0, span };
  }

  const art = h('div', { class: 'deck-art' }, h('div', { class: 'deck-art-ph' }, '⏻'));
  const title = h('div', { class: 'deck-title' }, '—');
  const artist = h('div', { class: 'deck-artist' }, 'Deck ' + deck.id + ' empty');
  const timeCur = h('span', { class: 'time-cur' }, '0:00');
  const timeRem = h('span', { class: 'time-rem' }, '-0:00');
  const badge = h('span', { class: 'badge badge-mode' }, '');
  const badgeKey = h('span', { class: 'badge badge-key', style: { display: 'none' } }, '');

  const LOOP_BEATS = [1, 2, 4, 8];
  const btnLoopIn = h('button', { class: 'btn btn-mini btn-loopin', title: 'Set the loop-in point', onclick: () => deck.loopIn() }, 'IN');
  const btnLoopOut = h('button', { class: 'btn btn-mini btn-loopout', title: 'Close the loop here', onclick: () => deck.loopOut() }, 'OUT');
  const beatLoopBtns = LOOP_BEATS.map((b) =>
    h('button', {
      class: 'btn btn-mini btn-loopbeat',
      title: `${b}-beat loop on the grid`,
      onclick: () => deck.setLoopBeats(b),
    }, String(b)));
  const btnLoopExit = h('button', { class: 'btn btn-mini btn-loopexit', title: 'Exit the loop', onclick: () => deck.exitLoop() }, 'EXIT');
  const loopRow = h('div', { class: 'loop-row' },
    h('span', { class: 'lbl-sub' }, 'LOOP'), btnLoopIn, btnLoopOut,
    h('span', { class: 'loop-sep' }), ...beatLoopBtns, btnLoopExit,
  );

  const record = Platter(deck, { accent, size: 132 });
  const platter = record.root;
  const jogHint = h('div', { class: 'jog-hint' }, 'VINYL');

  const SCRATCH_PATTERNS = [
    ['BABY', 'baby'],
    ['SCRB', 'scribble'],
    ['CHRP', 'chirp'],
    ['TRNS', 'transformer'],
    ['BSPN', 'backspin'],
  ];
  const scratchBtns = SCRATCH_PATTERNS.map(([label, id]) =>
    h('button', {
      class: 'btn btn-mini btn-scratch',
      title: `Auto-scratch: ${id} (beat-synced, runs a couple of bars)`,
      onclick: () => deck.toggleAutoScratch(id),
    }, label));
  const scratchRow = h('div', { class: 'scratch-row' }, ...scratchBtns);

  // Classic channel meter under the wave — level with red overshoot,
  // replacing the old oscilloscope view.
  const meter = LevelMeter(() => deck.level(), { orient: 'h', length: 560, thickness: 14 });

  // Filter readout, readable from across the room: a bipolar bar that fills
  // from the centre (left = lowpass, right = highpass) plus the live corner
  // frequency. Big enough to glance at while a knob is doing the driving.
  const fltFill = h('div', { class: 'flt-fill' });
  const fltText = h('span', { class: 'flt-text' }, '—');
  const fltScope = h('div', { class: 'flt-scope', title: 'Channel filter position' },
    h('span', { class: 'flt-side' }, 'LP'),
    h('div', { class: 'flt-track' }, fltFill),
    h('span', { class: 'flt-side' }, 'HP'),
    fltText,
  );
  const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`);

  function tickFilter() {
    const v = deck.filter;
    const x = Math.abs(v);
    if (x <= 0.02) {
      fltFill.style.width = '0%';
      if (fltText.textContent !== '—') fltText.textContent = '—';
      fltScope.classList.remove('hot');
      return;
    }
    fltFill.style.width = `${Math.round(x * 50)}%`;
    fltFill.style.left = v < 0 ? `${50 - x * 50}%` : '50%';
    fltScope.classList.add('hot');
    // Same corner-frequency mapping as the engine's ChannelFilter.
    const freq = v < 0 ? 22050 * Math.pow(180 / 22050, x) : 20 * Math.pow(8000 / 20, x);
    const label = `${v < 0 ? 'LP' : 'HP'} ${fmtHz(freq)}`;
    if (fltText.textContent !== label) fltText.textContent = label;
  }

  const meterRow = h('div', { class: 'deck-meter' },
    h('span', { class: 'lbl-sub' }, 'LEVEL'), meter.canvas, fltScope);

  const btnPlay = h('button', { class: 'btn btn-play', title: 'Play / pause (space)' }, '▶');
  const btnCue = h('button', { class: 'btn btn-cue', title: 'Set cue / jump to cue' }, 'CUE');
  const btnRew = h('button', {
    class: 'btn btn-rew',
    title: 'Rewind — hold it, the longer you hold the faster it spins',
  }, '◀◀');
  const btnEject = h('button', { class: 'btn btn-ghost', title: 'Clear the deck', onclick: () => onEject(deck) }, '⏏');
  const btnZap = h('button', { class: 'btn btn-zap', title: 'Value4Value zap to the artist' }, '⚡ ZAP');

  const btnVinyl = h('button', {
    class: 'btn btn-mini btn-vinyl',
    title: 'Vinyl: scratch, brake, spin-up · CDJ: instant start, jog = pitchbend',
    onclick: () => {
      deck.vinylMode = !deck.vinylMode;
      deck.emit('mode');
    },
  }, 'VINYL');

  const bpmField = h('input', {
    class: 'bpm-input',
    type: 'number',
    step: '0.1',
    min: '40',
    max: '220',
    value: '',
    'aria-label': `BPM Deck ${deck.id}`,
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        deck.bpm = v;
        deck.bpmManual = true;
        deck.emit('bpm');
      }
    },
  });
  const bpmLive = h('span', { class: 'bpm-live' }, '—');
  const btnTap = h('button', {
    class: 'btn btn-mini btn-tap',
    title: 'Tap tempo: hit this on every beat — from the 4th tap BPM and beat grid are set for the whole track',
    onclick: () => deck.tapBeat(),
  }, 'TAP');
  const btnSync = h('button', { class: 'btn btn-sync', title: 'Latch tempo and beat phase onto the other deck' }, 'SYNC');
  const btnDrop = h('button', {
    class: 'btn btn-mini btn-drop',
    title: 'Start on the other deck\'s next bar-1 — tempo synced, entry from cue snapped to your own 1. Press again to cancel',
    onclick: () => deck.emit('drop-request'),
  }, 'DROP');

  const tempoVal = h('span', { class: 'pitch-val' }, '0.0%');
  const tempoFader = fader({
    min: -8, max: 8, step: 0.02, value: 0, orient: 'v', label: `Tempo Deck ${deck.id}`,
    className: 'pitch',
    onInput: (v) => deck.setTempo(v),
  });
  const btnTempoRange = h('button', {
    class: 'btn btn-mini',
    title: 'Cycle the tempo range',
    onclick: () => {
      const ranges = [8, 16, 50];
      const next = ranges[(ranges.indexOf(deck.tempoRange) + 1) % ranges.length];
      deck.tempoRange = next;
      tempoFader.min = String(-next);
      tempoFader.max = String(next);
      deck.setTempo(deck.tempo);
      render();
    },
  }, '±8');
  const btnTempoReset = h('button', {
    class: 'btn btn-mini', title: 'Reset tempo to 0',
    onclick: () => { deck.setTempo(0); tempoFader.value = '0'; },
  }, '0');

  const eqRow = (band, label) => {
    const f = fader({
      min: -26, max: 6, step: 0.5, value: 0, orient: 'v', label: `EQ ${label} Deck ${deck.id}`,
      className: 'eq',
      onInput: (v) => deck.setEq(band, v),
    });
    const kill = h('button', {
      class: 'btn btn-kill', title: `${label} killen`,
      onclick: () => {
        const killed = deck.eq[band] <= -25;
        deck.setEq(band, killed ? 0 : -26);
        f.value = String(deck.eq[band]);
        kill.classList.toggle('on', !killed);
      },
    }, label);
    return { wrap: h('div', { class: 'eq-strip' }, f, kill), f };
  };
  const eqHigh = eqRow('high', 'HI');
  const eqMid = eqRow('mid', 'MID');
  const eqLow = eqRow('low', 'LOW');

  const filterFader = fader({
    min: -1, max: 1, step: 0.01, value: 0, orient: 'h', label: `Filter Deck ${deck.id}`,
    className: 'filter',
    onInput: (v) => deck.setFilter(v),
  });
  const btnFilterReset = h('button', {
    class: 'btn btn-mini', title: 'Filter to neutral',
    onclick: () => { deck.setFilter(0); filterFader.value = '0'; },
  }, 'FLT');
  const FILTER_MODEL_LABELS = { clean: 'CLN', djm: 'DJM', xone: 'XONE' };
  const btnFilterModel = h('button', {
    class: 'btn btn-mini btn-fltmodel',
    title: 'Filter model: CLN transparent · DJM soft resonance · XONE 4-pole VCF with crunch',
    onclick: () => {
      const next = FILTER_MODELS[(FILTER_MODELS.indexOf(deck.filterModel) + 1) % FILTER_MODELS.length];
      deck.setFilterModel(next);
      btnFilterModel.textContent = FILTER_MODEL_LABELS[next];
    },
  }, FILTER_MODEL_LABELS[deck.filterModel]);


  const volFader = fader({
    min: 0, max: 1, step: 0.01, value: 1, orient: 'v', label: `Volume deck ${deck.id}`,
    className: 'chan',
    onInput: (v) => deck.setVolume(v),
  });
  const vu = h('div', { class: 'vu' }, h('div', { class: 'vu-fill' }));
  const btnPfl = h('button', {
    class: 'btn btn-mini btn-pfl',
    title: 'Pre-listen: route this deck onto the headphone bus (pre-fader)',
    onclick: () => deck.setCue(),
  }, '🎧');

  /* ------------------------------ FX ------------------------------ */

  const fxKnob = (label, opts) =>
    h('div', { class: 'fx-knob' },
      h('span', { class: 'fx-lbl' }, label),
      fader({ ...opts, orient: 'h', className: 'fx' }),
    );

  const FX_LABELS = { flanger: 'FLANGER', phaser: 'PHASER', gater: 'GATER', echo: 'ECHO', reverb: 'REVERB' };
  const ECHO_DIVISIONS = [
    ['1/16', 0.25],
    ['1/8', 0.5],
    ['3/16', 0.75],
    ['1/4', 1],
  ];

  const divRow = (values, get, set) => {
    const btns = values.map(([label, value]) =>
      h('button', { class: 'btn btn-mini btn-div', onclick: () => set(value) }, label));
    return {
      el: h('div', { class: 'fx-knob' }, h('span', { class: 'fx-lbl' }, 'Div'), h('div', { class: 'div-row' }, ...btns)),
      sync: () => btns.forEach((b, i) => b.classList.toggle('on', values[i][1] === get())),
    };
  };

  /** Parameter body for one effect type. Rebuilt whenever the slot switches. */
  function fxBody(type) {
    if (type.startsWith('macro:')) {
      // A macro is one bipolar amount: left = combo over lowpass, right =
      // combo over highpass, centre = off.
      const amount = fader({
        min: -1, max: 1, step: 0.01, value: deck.macro.value, orient: 'h',
        label: `Macro amount deck ${deck.id}`, className: 'macro',
        onInput: (v) => deck.setMacroValue(v),
      });
      return {
        el: h('div', { class: 'fx-body fx-body-macro' },
          h('span', { class: 'macro-side' }, 'LP'),
          amount,
          h('span', { class: 'macro-side' }, 'HP'),
        ),
        sync: () => {
          if (document.activeElement !== amount) amount.value = String(deck.macro.value);
        },
      };
    }
    const set = (params) => deck.setFx(type, params);
    const p = deck.fx[type];
    if (type === 'flanger' || type === 'phaser') {
      const depth = type === 'flanger'
        ? fxKnob('Depth', { min: 0, max: 0.006, step: 0.0001, value: p.depth, label: `${type} Depth`, onInput: (v) => set({ depth: v }) })
        : fxKnob('Depth', { min: 0, max: 1, step: 0.01, value: p.depth, label: `${type} Depth`, onInput: (v) => set({ depth: v }) });
      return {
        el: h('div', { class: 'fx-body' },
          fxKnob('Rate', { min: 0.05, max: 6, step: 0.01, value: p.rate, label: `${type} Rate`, onInput: (v) => set({ rate: v }) }),
          depth,
          fxKnob('Fdbk', { min: 0, max: 0.9, step: 0.01, value: p.feedback, label: `${type} Feedback`, onInput: (v) => set({ feedback: v }) }),
          fxKnob('Mix', { min: 0, max: 1, step: 0.01, value: p.mix, label: `${type} Mix`, onInput: (v) => set({ mix: v }) }),
        ),
        sync: () => {},
      };
    }
    if (type === 'gater') {
      const div = divRow(DIVISIONS, () => deck.fx.gater.division, (v) => set({ division: v }));
      return {
        el: h('div', { class: 'fx-body' },
          div.el,
          fxKnob('Duty', { min: 0.05, max: 0.95, step: 0.01, value: p.duty, label: 'Gater Duty', onInput: (v) => set({ duty: v }) }),
          fxKnob('Depth', { min: 0, max: 1, step: 0.01, value: p.depth, label: 'Gater Depth', onInput: (v) => set({ depth: v }) }),
          fxKnob('Soft', { min: 0, max: 1, step: 0.01, value: p.smooth, label: 'Gater Smoothing', onInput: (v) => set({ smooth: v }) }),
        ),
        sync: div.sync,
      };
    }
    if (type === 'echo') {
      const div = divRow(ECHO_DIVISIONS, () => deck.fx.echo.division, (v) => set({ division: v }));
      return {
        el: h('div', { class: 'fx-body' },
          div.el,
          fxKnob('Fdbk', { min: 0, max: 0.85, step: 0.01, value: p.feedback, label: 'Echo Feedback', onInput: (v) => set({ feedback: v }) }),
          fxKnob('Mix', { min: 0, max: 1, step: 0.01, value: p.mix, label: 'Echo Mix', onInput: (v) => set({ mix: v }) }),
        ),
        sync: div.sync,
      };
    }
    return {
      el: h('div', { class: 'fx-body' },
        fxKnob('Decay', { min: 0.3, max: 4, step: 0.1, value: p.decay, label: 'Reverb Decay', onInput: (v) => set({ decay: v }) }),
        fxKnob('Tone', { min: 800, max: 12000, step: 50, value: p.tone, label: 'Reverb Tone', onInput: (v) => set({ tone: v }) }),
        fxKnob('Mix', { min: 0, max: 1, step: 0.01, value: p.mix, label: 'Reverb Mix', onInput: (v) => set({ mix: v }) }),
      ),
      sync: () => {},
    };
  }

  /** One of the two switchable FX slots: effect picker + on/off + params. */
  function fxSlot(i) {
    const sel = h('select', {
      class: 'fx-sel',
      'aria-label': `Effect for slot ${i + 1}, deck ${deck.id}`,
      onchange: (e) => deck.setFxSlot(i, e.target.value),
    },
    ...FX_TYPES.map((t) => h('option', { value: t }, FX_LABELS[t])),
    h('optgroup', { label: 'MACRO — one-knob combos' },
      ...MACRO_TYPES.map((t) => h('option', { value: `macro:${t}` }, MACRO_LABELS[t]))),
    );
    const btn = h('button', {
      class: 'btn btn-fx',
      title: 'Effect on/off (macros punch to the last amount)',
      onclick: () => deck.toggleFx(deck.fxSlots[i]),
    }, '');
    const bodyWrap = h('div');
    let shown = null;
    let body = { sync: () => {} };
    const sync = () => {
      const type = deck.fxSlots[i];
      sel.value = type;
      const isMacro = type.startsWith('macro:');
      btn.textContent = isMacro ? MACRO_LABELS[type.slice(6)] : FX_LABELS[type];
      btn.classList.toggle('on', isMacro
        ? Math.abs(deck.macro.value) >= 0.06 : deck.fx[type].on);
      if (shown !== type) {
        clear(bodyWrap);
        body = fxBody(type);
        bodyWrap.appendChild(body.el);
        shown = type;
      }
      body.sync();
    };
    return { el: h('div', { class: 'fx-unit' }, h('div', { class: 'fx-head' }, sel, btn), bodyWrap), sync };
  }

  const fxSlots = [fxSlot(0), fxSlot(1)];
  const fxSection = h('div', { class: 'deck-fx' }, fxSlots[0].el, fxSlots[1].el);

  btnPlay.addEventListener('click', () => deck.toggle());
  btnCue.addEventListener('click', () => deck.cue());
  btnZap.addEventListener('click', () => onZap(deck));
  btnSync.addEventListener('click', () => deck.emit('sync-request'));

  /* Rewind: hold to spin back, release to catch. */
  const rewDown = (e) => {
    if (e.pointerId !== undefined) btnRew.setPointerCapture(e.pointerId);
    btnRew.classList.add('on');
    deck.startRewind();
    e.preventDefault();
  };
  const rewUp = () => {
    btnRew.classList.remove('on');
    deck.stopRewind();
  };
  btnRew.addEventListener('pointerdown', rewDown);
  btnRew.addEventListener('pointerup', rewUp);
  btnRew.addEventListener('pointercancel', rewUp);
  btnRew.addEventListener('pointerleave', rewUp);

  waveWrap.addEventListener('click', (e) => {
    if (!deck.duration || e.target.closest('.wave-zoom')) return;
    const r = wave.getBoundingClientRect();
    const { t0, span } = viewWindow();
    deck.seek(t0 + ((e.clientX - r.left) / r.width) * span);
  });

  /* ------------------------------ platter ------------------------------ */

  // Angle-based, so the gesture matches a real record: how far around you drag
  // is how much audio time passes, regardless of where on the disc you grab it.
  let grab = null;

  const angleAt = (e) => {
    const r = platter.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };

  platter.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (deck.status !== 'ready') return;
    platter.setPointerCapture(e.pointerId);
    platter.classList.add('dragging');
    grab = { id: e.pointerId, angle: angleAt(e), x: e.clientX, t: performance.now(), vinyl: deck.vinylMode && deck.canVinyl };
    if (grab.vinyl) deck.touchPlatter();
    e.preventDefault();
  });

  platter.addEventListener('pointermove', (e) => {
    if (!grab || e.pointerId !== grab.id) return;
    const now = performance.now();
    const dt = Math.max(0.001, (now - grab.t) / 1000);
    if (grab.vinyl) {
      let da = angleAt(e) - grab.angle;
      // Unwrap across the ±π seam so a full turn does not read as a jump back.
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      deck.movePlatter((da / (2 * Math.PI)) * SEC_PER_REV, dt);
      grab.angle = angleAt(e);
    } else {
      deck.setNudge(Math.max(-0.25, Math.min(0.25, (e.clientX - grab.x) / 600)));
    }
    grab.t = now;
  });

  const platterUp = (e) => {
    if (!grab || (e.pointerId !== undefined && e.pointerId !== grab.id)) return;
    platter.classList.remove('dragging');
    if (grab.vinyl) deck.releasePlatter();
    else deck.setNudge(0);
    grab = null;
  };
  platter.addEventListener('pointerup', platterUp);
  platter.addEventListener('pointercancel', platterUp);

  // The deck is mounted as two fragments so the app can run the crossfader
  // full-width between top (head/FX/wave/meter) and bottom (jog/tempo).
  // EQ and channel strip are exposed separately — they live in the middle
  // mixer column, like on a real 2-channel battle mixer.
  const top = h('div', { class: `deck deck-top deck-${deck.id}`, dataset: { accent } },
    h('div', { class: 'deck-head' },
      art,
      h('div', { class: 'deck-meta' },
        h('div', { class: 'deck-id' }, `DECK ${deck.id}`, badge, badgeKey),
        title,
        artist,
        h('div', { class: 'deck-times' }, timeCur, h('span', { class: 'sep' }, '/'), timeRem),
      ),
      h('div', { class: 'deck-head-actions' }, btnZap, btnEject),
    ),
    fxSection,
    waveWrap,
    meterRow,
  );

  const bottom = h('div', { class: `deck deck-bottom deck-${deck.id}`, dataset: { accent } },
    h('div', { class: 'deck-body' },
      h('div', { class: 'deck-jog' }, platter, jogHint,
        h('div', { class: 'transport' }, btnRew, btnCue, btnPlay),
        loopRow,
        btnVinyl,
        scratchRow,
      ),
      h('div', { class: 'deck-tempo' },
        h('div', { class: 'bpm-box' },
          h('label', { class: 'lbl' }, 'BPM'),
          h('div', { class: 'bpm-live-wrap', title: 'Effective BPM — follows the tempo fader' }, bpmLive),
          h('div', { class: 'bpm-base-row' }, h('span', { class: 'lbl-sub' }, 'BASE'), bpmField, btnTap),
        ),
        btnSync,
        btnDrop,
        h('div', { class: 'pitch-box' },
          h('label', { class: 'lbl' }, 'Tempo'),
          tempoFader,
          tempoVal,
          h('div', { class: 'pitch-btns' }, btnTempoRange, btnTempoReset),
        ),
      ),
    ),
  );

  // Channel strip for the middle mixer column.
  const channelStrip = h('div', { class: `deck channel-strip deck-${deck.id}`, dataset: { accent } },
    h('div', { class: 'lbl' }, `CH ${deck.id}`),
    h('div', { class: 'deck-eq' },
      h('div', { class: 'eq-row' }, eqHigh.wrap, eqMid.wrap, eqLow.wrap),
      h('div', { class: 'filter-row' }, btnFilterReset, filterFader, btnFilterModel),
    ),
    h('div', { class: 'deck-chan' }, h('label', { class: 'lbl' }, 'VOL'), h('div', { class: 'chan-row' }, volFader, vu), btnPfl),
  );

  const root = top; // dnd + legacy callers get the top fragment
  const roots = [top, bottom, channelStrip];

  /* ------------------------- rendering ------------------------- */

  let staticWave = null;

  function drawStaticWave() {
    const w = wave.clientWidth || 600;
    const hgt = 120;
    wave.width = Math.floor(w * (window.devicePixelRatio || 1));
    wave.height = Math.floor(hgt * (window.devicePixelRatio || 1));
    const c = document.createElement('canvas');
    c.width = wave.width;
    c.height = wave.height;
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hgt);

    const peaks = deck.peaks;
    const mid = hgt / 2;
    if (peaks) {
      const n = peaks.length / 2;
      const grad = g.createLinearGradient(0, 0, 0, hgt);
      grad.addColorStop(0, accent === 'a' ? '#f7931a' : '#f3c244');
      grad.addColorStop(0.5, accent === 'a' ? '#8a5410' : '#8a6f22');
      grad.addColorStop(1, accent === 'a' ? '#f7931a' : '#f3c244');
      g.fillStyle = grad;
      for (let i = 0; i < n; i++) {
        const x = (i / n) * w;
        const bw = Math.max(1, w / n - 0.4);
        const min = peaks[i * 2];
        const max = peaks[i * 2 + 1];
        const y0 = mid - max * mid * 0.95;
        const y1 = mid - min * mid * 0.95;
        g.fillRect(x, y0, bw, Math.max(1, y1 - y0));
      }
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();

    drawBeatGrid(g, w, hgt, 0, deck.duration || 1);
    staticWave = c;
  }

  /**
   * Beat grid for a visible window [t0, t0+span]. Beat lines only while they
   * resolve on screen (≥3 px); bar-1 lines — anchored on the detected downbeat
   * when there is one — stay stronger and survive one zoom level further out.
   */
  function drawBeatGrid(g, w, hgt, t0, span) {
    if (!deck.bpm || !Number.isFinite(deck.beatOffset) || !deck.duration) return;
    const beatLen = 60 / deck.bpm;
    const anchor = Number.isFinite(deck.barOffset) ? deck.barOffset : deck.beatOffset;
    const beatPx = (beatLen / span) * w;
    const step = beatPx >= 3 ? 1 : beatPx * 4 >= 3 ? 4 : 0;
    if (!step) return;
    const mod = (x, m) => ((x % m) + m) % m;
    const st = deck.structure && deck.structure.ok ? deck.structure : null;
    let t = t0 - mod(t0 - anchor, beatLen);
    if (t < t0 - 0.001) t += beatLen;
    for (; t < t0 + span; t += beatLen) {
      const k = Math.round(mod(t - anchor, 4 * beatLen) / beatLen) % 4;
      if (step === 4 && k !== 0) continue;
      const x = ((t - t0) / span) * w;
      // Phrase starts get the strongest line — that is where a DJ acts.
      const barIdx = st ? Math.round((t - st.firstBar) / st.barLen) : -1;
      const phrase = st && k === 0 && mod(barIdx - st.phraseOffset, st.phraseBars) === 0;
      g.fillStyle = phrase ? 'rgba(255,210,63,0.4)'
        : k === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
      g.fillRect(x, 0, phrase ? 2 : k === 0 ? 2 : 1, hgt);
    }
    drawStructure(g, w, hgt, t0, span);
  }

  const SECTION_COLORS = {
    intro: 'rgba(255,247,236,0.10)',
    steady: 'rgba(247,147,26,0.16)',
    high: 'rgba(255,106,0,0.30)',
    breakdown: 'rgba(243,194,68,0.14)',
    outro: 'rgba(255,247,236,0.10)',
  };

  /** Section strip along the bottom edge plus the two planned mix points. */
  function drawStructure(g, w, hgt, t0, span) {
    const st = deck.structure;
    if (!st || !st.ok) return;
    const x = (t) => ((t - t0) / span) * w;
    const y = hgt - 8;
    for (const s of st.sections) {
      const a = st.firstBar + s.startBar * st.barLen;
      const b = st.firstBar + s.endBar * st.barLen;
      if (b < t0 || a > t0 + span) continue;
      g.fillStyle = SECTION_COLORS[s.kind] || SECTION_COLORS.steady;
      const left = x(Math.max(a, t0));
      g.fillRect(left, y, x(Math.min(b, t0 + span)) - left, 8);
    }
    for (const [t, glyph] of [[st.mixInSec, '▸'], [st.mixOutSec, '◂']]) {
      if (t < t0 || t > t0 + span) continue;
      const px = x(t);
      g.strokeStyle = 'rgba(255,210,63,0.75)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, hgt);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd23f';
      g.font = '10px monospace';
      g.fillText(glyph, px + (glyph === '▸' ? 3 : -9), 10);
    }
  }

  /** Live bars for the zoomed window, from the fine peak set. */
  function drawWindowBars(g, w, hgt, t0, span) {
    const pk = deck.peaksHi || deck.peaks;
    if (!pk) return;
    const mid = hgt / 2;
    const N = pk.length / 2;
    const dur = deck.duration || 1;
    const i0 = Math.max(0, Math.floor((t0 / dur) * N));
    const i1 = Math.min(N, Math.ceil(((t0 + span) / dur) * N));
    const count = Math.max(1, i1 - i0);
    const stride = Math.max(1, Math.floor(count / w));
    const grad = g.createLinearGradient(0, 0, 0, hgt);
    grad.addColorStop(0, accent === 'a' ? '#f7931a' : '#f3c244');
    grad.addColorStop(0.5, accent === 'a' ? '#8a5410' : '#8a6f22');
    grad.addColorStop(1, accent === 'a' ? '#f7931a' : '#f3c244');
    g.fillStyle = grad;
    const bw = Math.max(1, (w / count) * stride - 0.4);
    for (let i = i0; i < i1; i += stride) {
      const x = (((i / N) * dur - t0) / span) * w;
      const y0 = mid - pk[i * 2 + 1] * mid * 0.95;
      const y1 = mid - pk[i * 2] * mid * 0.95;
      g.fillRect(x, y0, bw, Math.max(1, y1 - y0));
    }
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();
    drawBeatGrid(g, w, hgt, t0, span);
  }

  function drawWave() {
    const ctx2d = wave.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = wave.width / dpr;
    const hgt = wave.height / dpr;
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, wave.width, wave.height);
    const zoomed = view.zoom > 1.001;
    if (!zoomed && staticWave) ctx2d.drawImage(staticWave, 0, 0);
    ctx2d.scale(dpr, dpr);

    if (!deck.duration) return;
    const { t0, span } = viewWindow();
    if (zoomed) drawWindowBars(ctx2d, w, hgt, t0, span);
    const x = (t) => ((t - t0) / span) * w;

    ctx2d.fillStyle = 'rgba(0,0,0,0.45)';
    ctx2d.fillRect(0, 0, Math.max(0, Math.min(w, x(deck.position))), hgt);

    if (deck.loop.active && deck.loop.end > t0 && deck.loop.start < t0 + span) {
      const x0 = Math.max(0, x(deck.loop.start));
      const x1 = Math.min(w, x(deck.loop.end));
      ctx2d.fillStyle = 'rgba(255,106,0,0.14)';
      ctx2d.fillRect(x0, 0, Math.max(1, x1 - x0), hgt);
      ctx2d.fillStyle = '#ff6a00';
      ctx2d.fillRect(x0 - 1, 0, 2, hgt);
      ctx2d.fillRect(x1 - 1, 0, 2, hgt);
    }

    if (deck.cuePoint > 0 && deck.cuePoint >= t0 && deck.cuePoint <= t0 + span) {
      const cx = x(deck.cuePoint);
      ctx2d.fillStyle = '#ffd23f';
      ctx2d.fillRect(cx - 1, 0, 2, hgt);
      ctx2d.fillRect(cx - 5, 0, 10, 5);
    }

    ctx2d.fillStyle = '#fff';
    ctx2d.fillRect(Math.max(0, Math.min(w - 1, x(deck.position))) - 1, 0, 2, hgt);
  }

  function render() {
    const t = deck.track;
    if (t) {
      title.textContent = t.title;
      artist.textContent = t.artist + (t.albumTitle ? ` · ${t.albumTitle}` : '');
      clear(art);
      if (t.artworkUrl) art.appendChild(setImage(h('img', { alt: '' }), t.artworkUrl));
      else art.appendChild(h('div', { class: 'deck-art-ph' }, '♪'));
      waveWrap.classList.toggle('has-track', true);
    } else {
      title.textContent = '—';
      artist.textContent = `Deck ${deck.id} empty`;
      clear(art).appendChild(h('div', { class: 'deck-art-ph' }, '⏻'));
      waveWrap.classList.remove('has-track');
    }

    badge.textContent =
      deck.status === 'loading' ? 'LOADING…'
      : deck.status === 'error' ? 'ERROR'
      : deck.backend === 'element' ? 'BASIC'
      : deck.backend === 'buffer' ? 'FULL'
      : '';
    badge.className = `badge badge-mode ${
      deck.status === 'error' ? 'bad'
      : deck.status === 'loading' ? 'busy'
      : deck.backend === 'element' ? 'warn'
      : deck.backend === 'buffer' ? 'ok'
      : ''
    }`;

    const key = deck.musicalKey;
    badgeKey.style.display = key ? '' : 'none';
    if (key) {
      badgeKey.textContent = key.camelot;
      badgeKey.title = `${key.name} · key confidence ${Math.round(key.confidence * 100)}%`;
      badgeKey.classList.toggle('dim', key.confidence < 0.4);
    }
    badge.title = deck.status === 'error' ? deck.error
      : deck.backend === 'element' ? 'Basic mode: volume crossfade and tempo only — no EQ/filter/FX/scratch'
      : deck.backend === 'buffer' ? 'Full WebAudio path: EQ, filter, FX, waveform, scratch' : '';

    btnPlay.textContent = deck.playing ? '❚❚' : '▶';
    btnPlay.classList.toggle('on', deck.playing);
    btnPlay.disabled = deck.status !== 'ready';
    btnCue.disabled = deck.status !== 'ready';
    btnRew.disabled = !deck.canVinyl;
    btnZap.disabled = !t;

    btnPfl.classList.toggle('on', deck.cueOn);
    btnPfl.disabled = deck.backend !== 'buffer';
    btnSync.classList.toggle('on', Boolean(deck.syncedTo));
    btnDrop.classList.toggle('on', Boolean(deck._drop));
    btnDrop.disabled = deck.backend !== 'buffer' || deck.status !== 'ready';

    for (const [b] of [[zoomIn], [zoomOut], [zoomLabel]]) b.disabled = !deck.peaks;

    const loopReady = deck.backend === 'buffer' && deck.status === 'ready';
    for (const b of [btnLoopIn, btnLoopOut, ...beatLoopBtns, btnLoopExit]) b.disabled = !loopReady;
    btnLoopOut.disabled = !loopReady || deck.loop.active;

    const scratchReady = deck.canVinyl && Boolean(deck._reverse) && deck.bpm > 0;
    scratchBtns.forEach((b, i) => {
      b.disabled = !scratchReady;
      b.classList.toggle('on', deck.autoScratch === SCRATCH_PATTERNS[i][1]);
    });
    btnTap.disabled = deck.backend !== 'buffer';
    beatLoopBtns.forEach((b, i) => b.classList.toggle('on', deck.loop.active && deck.loop.beats === LOOP_BEATS[i]));
    btnLoopExit.classList.toggle('on', deck.loop.active);
    btnLoopIn.classList.toggle('on', !deck.loop.active && deck.loop.start > 0 && deck.loop.end === 0);

    const vinyl = deck.vinylMode && deck.canVinyl;
    btnVinyl.textContent = deck.vinylMode ? 'VINYL' : 'CDJ';
    btnVinyl.classList.toggle('on', deck.vinylMode);
    btnVinyl.disabled = !deck.canVinyl;
    jogHint.textContent = vinyl ? 'SCRATCH' : 'JOG';
    platter.classList.toggle('vinyl', vinyl);
    platter.title = vinyl ? 'Vinyl: drag to scratch' : 'Jog: drag for pitchbend';

    bpmField.value = deck.bpm ? deck.bpm.toFixed(1) : '';
    bpmField.classList.toggle('guess', !deck.bpmManual && deck.bpmConfidence > 0 && deck.bpmConfidence < 0.35);
    tempoVal.textContent = `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(1)}%`;
    btnTempoRange.textContent = `±${deck.tempoRange}`;

    const limited = deck.backend === 'element';
    for (const el of [eqHigh.f, eqMid.f, eqLow.f, filterFader, btnFilterModel]) el.disabled = limited;
    for (const el of fxSection.querySelectorAll('input, button, select')) el.disabled = limited;
    root.classList.toggle('limited', limited);

    fxSlots.forEach((s) => s.sync());

    drawStaticWave();
    drawWave();
  }

  /** Called from the global rAF loop. */
  function tick() {
    if (deck.duration) {
      timeCur.textContent = fmtTime(deck.position);
      timeRem.textContent = `-${fmtTime(Math.max(0, deck.duration - deck.position))}`;
    } else {
      timeCur.textContent = '0:00';
      timeRem.textContent = '-0:00';
    }
    const rate = deck.currentRate;
    bpmLive.textContent = deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '—';

    // The disc is drawn from the real rate, so brake, backspin and
    // hand-scratch all read correctly instead of a fixed CSS spin.
    record.draw();
    meter.draw();
    tickFilter();
    platter.classList.toggle('reverse', rate < -0.05);
    platter.classList.toggle('scratching', deck.scratching || deck.rewinding);
    platter.classList.toggle('spinning', Math.abs(rate) > 0.05);

    const lv = deck.level();
    vu.firstChild.style.height = `${Math.round(Math.min(1, lv * 1.25) * 100)}%`;
    vu.classList.toggle('clip', lv > 0.98);
    drawWave();
  }

  deck.on((what) => {
    if (what === 'peaks' || what === 'load' || what === 'ready' || what === 'error'
      || what === 'bpm' || what === 'structure') {
      staticWave = null;
      record.invalidate();
    }
    if (what === 'load') setZoom(1);
    if (what === 'tap') {
      const n = deck._taps.length;
      btnTap.textContent = n > 0 && n < 4 ? `TAP ${n}` : 'TAP';
      btnTap.classList.add('on');
      setTimeout(() => btnTap.classList.remove('on'), 120);
    }
    render();
  });

  const ro = new ResizeObserver(() => {
    staticWave = null;
    render();
  });
  ro.observe(waveWrap);

  render();
  return { root, roots, top, bottom, channelStrip, render, tick, tempoFader, pitchFader: tempoFader, volFader };
}
