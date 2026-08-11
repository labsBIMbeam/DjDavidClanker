/**
 * Transition flows, headless.
 *
 * The automix suite cannot cover these: its fake tracks are short, so the only
 * flow that ever fits the runway is `cut`. This drives every flow end to end
 * against a deck fake that records each parameter change, and asserts the thing
 * the flows actually exist to guarantee — that a smooth transition is smooth.
 *
 * "Smooth" is measured, not asserted by eye: the per-frame delta of every
 * continuous parameter (crossfader, EQ bands, filter) must stay under a
 * threshold. A flow that steps the crossfader from -1 to 1 in one frame is
 * exactly the hectic feeling this is meant to prevent, and it fails here.
 *
 *   node dev/transitions-check.mjs
 */

import { TRANSITIONS, TRANSITION_KEYS, Transition, pickTransition, minSecondsFor } from '../src/audio/transitions.js';

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

class FakeDeck {
  constructor(id) {
    this.id = id;
    this.eq = { low: 0, mid: 0, high: 0 };
    this.filter = 0;
    this.canVinyl = true;
    this.rewinding = false;
    this.fx = {};
    this.loopBeats = 0;
    this.calls = [];
  }

  setEq(band, db) {
    this.eq[band] = db;
    this.calls.push(['eq', band, db]);
  }

  setFilter(v) {
    this.filter = v;
    this.calls.push(['filter', v]);
  }

  toggleFx(unit, on) {
    this.fx[unit] = on;
    this.calls.push(['fx', unit, on]);
  }

  setFx(unit, params) {
    this.calls.push(['fxset', unit, params]);
  }

  setLoopBeats(b) {
    this.loopBeats = b;
    this.calls.push(['loop', b]);
  }

  exitLoop() {
    this.loopBeats = 0;
    this.calls.push(['unloop']);
  }

  startRewind() {
    this.rewinding = true;
    this.calls.push(['rewind']);
  }

  stopRewind() {
    this.rewinding = false;
    this.calls.push(['unrewind']);
  }
}

const DT = 1 / 60;

/** Run a flow to completion, sampling every continuous parameter per frame. */
function run(key, { dur = null } = {}) {
  const live = new FakeDeck('A');
  const idle = new FakeDeck('B');
  const seconds = dur || minSecondsFor(TRANSITIONS[key], 128);
  let xf = -1;
  const frames = [];

  const t = new Transition(key, {
    live, idle, dur: seconds, from: -1, to: 1, setXf: (v) => { xf = v; },
  });

  let guard = 0;
  while (!t.done && guard++ < 100000) {
    t.tick(DT);
    frames.push({ xf, lowA: live.eq.low, midA: live.eq.mid, highA: live.eq.high, filtA: live.filter,
      lowB: idle.eq.low, filtB: idle.filter });
  }
  return { t, live, idle, frames, seconds };
}

/** Largest single-frame change of any sampled parameter, normalised. */
function maxStep(frames, keys, scale) {
  let worst = 0;
  let where = '';
  for (let i = 1; i < frames.length; i++) {
    for (const k of keys) {
      const d = Math.abs(frames[i][k] - frames[i - 1][k]) / scale[k];
      if (d > worst) {
        worst = d;
        where = k;
      }
    }
  }
  return { worst, where };
}

// Crossfader spans 2 units, EQ 26 dB, filter 2 units — normalise so one
// threshold means the same thing for all of them.
const SCALE = { xf: 2, lowA: 26, midA: 26, highA: 26, filtA: 2, lowB: 26, filtB: 2 };
const CONT = Object.keys(SCALE);

/* --------------------------- every flow runs --------------------------- */

for (const key of TRANSITION_KEYS) {
  const { t, frames } = run(key);
  check(`${key}: completes`, t.done && frames.length > 4, `${frames.length} frames`);
}

/* ------------------------- smooth means smooth ------------------------- */

// Everything except the low bands must ride: 2% of a parameter's full range per
// frame at 60fps means a full sweep takes no less than ~0.8s. Faster is a jump.
const RIDDEN = CONT.filter((k) => k !== 'lowA' && k !== 'lowB');

for (const key of TRANSITION_KEYS.filter((k) => TRANSITIONS[k].energy === 'smooth')) {
  const { frames } = run(key);
  const { worst, where } = maxStep(frames, RIDDEN, SCALE);
  check(`${key}: fader, filter and mids/highs all ride`, worst < 0.02,
    `worst ${(worst * 100).toFixed(2)}%/frame on ${where}`);
}

// The lows are the one exception, and only in a specific shape: trading
// basslines on the downbeat is standard practice and does not read as a jolt,
// because one bassline replaces the other at the same instant. A low that steps
// on its own — leaving a gap, or two basslines at once — is a real fault.
for (const key of TRANSITION_KEYS.filter((k) => TRANSITIONS[k].energy === 'smooth')) {
  const { frames } = run(key);
  let lone = 0;
  let swaps = 0;
  for (let i = 1; i < frames.length; i++) {
    const dA = frames[i].lowA - frames[i - 1].lowA;
    const dB = frames[i].lowB - frames[i - 1].lowB;
    const bigA = Math.abs(dA) / 26 > 0.02;
    const bigB = Math.abs(dB) / 26 > 0.02;
    if (bigA && bigB && Math.sign(dA) !== Math.sign(dB)) swaps++;
    else if (bigA || bigB) lone++;
  }
  check(`${key}: lows only ever trade, never step alone`, lone === 0,
    `${swaps} swap(s), ${lone} lone step(s)`);
}

/* --------------------- marked flows are allowed a seam ------------------ */

const markedKeys = TRANSITION_KEYS.filter((k) => TRANSITIONS[k].energy === 'marked');
check('marked flows exist', markedKeys.length >= 3, markedKeys.join(', '));

// ...but even a cut must ramp the fader rather than teleport it, or it clicks.
{
  const { frames } = run('cut');
  const { worst } = maxStep(frames, ['xf'], SCALE);
  check('cut ramps the fader rather than stepping it', worst < 0.35,
    `worst ${(worst * 100).toFixed(1)}%/frame`);
}

/* --------------------------- state is handed back ---------------------- */

for (const key of TRANSITION_KEYS) {
  const { t, live, idle } = run(key);
  t.finish();
  const clean = live.eq.low === 0 && live.eq.mid === 0 && live.eq.high === 0 && live.filter === 0
    && idle.eq.low === 0 && idle.eq.mid === 0 && idle.eq.high === 0 && idle.filter === 0;
  check(`${key}: restores EQ and filter on finish`, clean,
    `A eq=${JSON.stringify(live.eq)} filt=${live.filter} · B eq=${JSON.stringify(idle.eq)} filt=${idle.filter}`);
}

// Abandoning a flow part-way is the dangerous case — that is what happens when
// automix is switched off mid-transition.
{
  const live = new FakeDeck('A');
  const idle = new FakeDeck('B');
  const t = new Transition('filterFade', { live, idle, dur: 10, from: -1, to: 1, setXf: () => {} });
  for (let i = 0; i < 300; i++) t.tick(DT); // ~5s in, mid-sweep
  const midFilter = live.filter;
  t.finish();
  check('abandoned flow still hands the controls back',
    live.filter === 0 && live.eq.low === 0 && idle.eq.low === 0,
    `was mid-sweep at filter=${midFilter.toFixed(2)}`);
}

/* --------------------------- flows clean up FX ------------------------- */

for (const key of TRANSITION_KEYS.filter((k) => TRANSITIONS[k].cleanup)) {
  const { t, live } = run(key);
  t.finish();
  const stuck = Object.entries(live.fx).filter(([, on]) => on).map(([u]) => u);
  check(`${key}: leaves no FX latched`, stuck.length === 0, stuck.join(', ') || 'clean');
}

{
  const { t, live } = run('loopRoll');
  t.finish();
  check('loopRoll leaves no loop latched', live.loopBeats === 0, `beats=${live.loopBeats}`);
}

{
  const { t, live } = run('spinback');
  t.finish();
  check('spinback leaves the platter released', live.rewinding === false);
}

/* ------------------------------ selection ------------------------------ */

{
  // A clear step up in tempo is what earns a climax.
  const climax = pickTransition({ liveBpm: 124, idleBpm: 132, seconds: 600, rng: () => 0.5 });
  check('a tempo jump earns a climax', TRANSITIONS[climax].energy === 'climax', climax);

  const flat = pickTransition({ liveBpm: 124, idleBpm: 125, seconds: 600, rng: () => 0.9 });
  check('a flat pairing does not', TRANSITIONS[flat].energy !== 'climax', flat);

  // rng below markedRate selects the marked pool, above it the smooth one.
  const smooth = pickTransition({ liveBpm: 124, idleBpm: 124, seconds: 600, markedRate: 0.25, rng: () => 0.9 });
  check('most handovers are smooth', TRANSITIONS[smooth].energy === 'smooth', smooth);

  const marked = pickTransition({ liveBpm: 124, idleBpm: 124, seconds: 600, markedRate: 0.25, rng: () => 0.1 });
  check('some handovers are marked', TRANSITIONS[marked].energy === 'marked', marked);
}

{
  // The runway rule: never pick a flow that does not fit, because cramming a
  // 32-bar blend into a few seconds is precisely what feels rushed.
  let ok = true;
  let bad = '';
  for (let i = 0; i < 400; i++) {
    const secs = 3 + (i % 40);
    const key = pickTransition({ liveBpm: 128, idleBpm: 128, seconds: secs, rng: Math.random });
    const need = minSecondsFor(TRANSITIONS[key], 128);
    // `cut` is the deliberate last resort when literally nothing fits.
    if (need > secs && key !== 'cut') {
      ok = false;
      bad = `${key} needs ${need.toFixed(1)}s but had ${secs}s`;
    }
  }
  check('never picks a flow that will not fit the runway', ok, bad || 'checked 400 runways');
}

{
  // Variety: over a long set the picker must not sit on one flow.
  const seen = new Set();
  const recent = [];
  for (let i = 0; i < 200; i++) {
    const key = pickTransition({ liveBpm: 124, idleBpm: 124 + (i % 9), seconds: 600, recent });
    seen.add(key);
    recent.push(key);
    if (recent.length > 4) recent.shift();
  }
  check('a long set uses most of the flows', seen.size >= 8, `${seen.size}/${TRANSITION_KEYS.length} used`);
}

{
  // ...and never twice in a row, which is what the recent list is for.
  const recent = [];
  let repeats = 0;
  let prev = '';
  for (let i = 0; i < 300; i++) {
    const key = pickTransition({ liveBpm: 124, idleBpm: 124, seconds: 600, recent });
    if (key === prev) repeats++;
    prev = key;
    recent.push(key);
    if (recent.length > 4) recent.shift();
  }
  check('the same flow never lands twice in a row', repeats === 0, `${repeats} repeats`);
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
