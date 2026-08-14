/**
 * Automated turntablism. Ported from Zazawowow's PR #8 and adapted to this
 * engine's deck internals (thanks — the pattern library and the analytic
 * motion model are his).
 *
 * A scratch is two independent signals: what the record does, and what the
 * crossfader does. Every named scratch in the tradition is a particular
 * pairing of the two — a flare and a transformer move the record the same way
 * and sound nothing alike, because the fader is doing something different.
 * So a pattern here is a list of record MOVES, each carrying its own fader
 * GATE schedule expressed in that move's own normalised time.
 *
 * Motion is computed analytically rather than integrated frame by frame: for
 * every instant we know both the velocity and the exact displacement from the
 * anchor, so the record always lands back where it started and no drift can
 * accumulate over a few hundred cycles. The `auto` flag on a move solves its
 * peak velocity so the cycle nets zero displacement, which is what keeps the
 * sample from walking off the cue point.
 *
 * The fader is a real AudioParam ramp scheduled ahead of time (sample
 * accurate) on the deck's scratchGate node, while record motion is pushed at
 * tick rate into the granular Turntable. Those two paths have different
 * latencies — see LATENCY.
 *
 * This is the one module that owns a timer (5 ms): the gates are scheduled
 * against the audio clock and must keep running while a hidden tab stalls
 * rAF. The rest of the app stays frame-loop driven.
 */

import { GRAIN_LATENCY } from './scratch.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The Turntable fills its grain queue ahead of the clock, so a position we
 * write now is not heard until roughly a queue's depth later. The fader is a
 * gain node with no such delay. Without this offset every fader click lands
 * early and flares turn to mush.
 */
const LATENCY = GRAIN_LATENCY;

/** Battle-mixer fader cut-in. A Rane/Vestax cuts in within about a millimetre. */
const CUT_MS = 0.0018;

const LOOKAHEAD = 0.12; // schedule fader events this far ahead
const TICK_MS = 5;

/* ------------------------------------------------------------------ *
 * Motion shapes
 *
 * A hand does not move at a constant speed — it accelerates, peaks and
 * decelerates. 'sine' is that, and it is what makes an automated scratch stop
 * sounding like a stepper motor. 'flat' is a constant-speed drag with eased
 * ends, for the slower techniques where the record really does just travel.
 * ------------------------------------------------------------------ */

/** Velocity at normalised move-time u, for unit peak. */
function shapeVel(shape, u) {
  if (shape === 'flat') {
    const e = 0.15; // eased ends, otherwise the grain player clicks
    if (u < e) return Math.sin((Math.PI * u) / (2 * e));
    if (u > 1 - e) return Math.sin((Math.PI * (1 - u)) / (2 * e));
    return 1;
  }
  return Math.sin(Math.PI * u);
}

/** Displacement from move start to normalised time u, for unit peak, in units of T. */
function shapeDisp(shape, u) {
  if (shape === 'flat') {
    const e = 0.15;
    const headFull = (2 * e) / Math.PI; // area under a full eased head
    if (u < e) return ((2 * e) / Math.PI) * (1 - Math.cos((Math.PI * u) / (2 * e)));
    if (u <= 1 - e) return headFull + (u - e);
    const tail = ((2 * e) / Math.PI) * (1 - Math.cos((Math.PI * (1 - u)) / (2 * e)));
    return headFull + (1 - 2 * e) + (headFull - tail);
  }
  return (1 - Math.cos(Math.PI * u)) / Math.PI;
}

/** Total displacement of a whole move, for unit peak, in units of T. */
const shapeTotal = (shape) => shapeDisp(shape, 1);

/* ------------------------------------------------------------------ *
 * Pattern library
 *
 * move: { d: beats, v: peak rate multiple (sign = direction), shape,
 *         auto: solve v so the cycle nets zero, g: gate schedule }
 * gate: [{ at: normalised move-time, open: 0|1 }] — omitted means "stay as is",
 *       and a move with no gate entry inherits the state it was handed.
 * ------------------------------------------------------------------ */

/** Evenly spaced fader clicks across a move: n closed windows, `duty` open. */
function clicks(n, { start = 0.06, end = 0.97, duty = 0.5, open = 1 } = {}) {
  const out = [{ at: 0, open }];
  const span = (end - start) / n;
  for (let i = 0; i < n; i++) {
    const a = start + i * span;
    out.push({ at: a, open: open ? 0 : 1 });
    out.push({ at: a + span * duty, open });
  }
  return out;
}

/** Alternating chop across a move — the transformer/military family. */
function chop(n, { open = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n * 2; i++) out.push({ at: i / (n * 2), open: i % 2 === 0 ? open : 1 - open });
  return out;
}

const OPEN = [{ at: 0, open: 1 }];
const SHUT = [{ at: 0, open: 0 }];

export const SCRATCHES = {
  /* ---------------- open-fader family: the record does all the work -------- */

  baby: {
    label: 'Baby',
    family: 'Foundation',
    blurb: 'Forward and back at even speed, fader never moves. The first scratch anyone learns.',
    beats: 1,
    moves: [
      { d: 0.5, v: 1.9, g: OPEN },
      { d: 0.5, auto: true, g: OPEN },
    ],
  },

  drag: {
    label: 'Drag',
    family: 'Foundation',
    blurb: 'A baby scratch taken well below record speed — slow, heavy, pitched down.',
    beats: 2,
    moves: [
      { d: 1, v: 0.42, shape: 'flat', g: OPEN },
      { d: 1, auto: true, shape: 'flat', g: OPEN },
    ],
  },

  scribble: {
    label: 'Scribble',
    family: 'Foundation',
    blurb: 'Tiny, very fast back-and-forth driven from a tensed forearm. Fader stays open.',
    beats: 1,
    moves: Array.from({ length: 12 }, (_, i) => ({
      d: 1 / 12,
      v: i % 2 === 0 ? 3.1 : -3.1,
      g: OPEN,
    })),
  },

  tear2: {
    label: 'Tear (2-click)',
    family: 'Foundation',
    blurb: 'Push forward, then break the return into two speeds so it tears into two sounds.',
    beats: 1,
    moves: [
      { d: 0.42, v: 2.0, g: OPEN },
      { d: 0.24, v: -2.6, g: OPEN },
      { d: 0.34, auto: true, g: OPEN },
    ],
  },

  tear3: {
    label: 'Tear (3-click)',
    family: 'Foundation',
    blurb: 'Same idea, return broken into three steps — three distinct sounds off one push.',
    beats: 1,
    moves: [
      { d: 0.4, v: 2.1, g: OPEN },
      { d: 0.2, v: -2.8, g: OPEN },
      { d: 0.2, v: -1.1, g: OPEN },
      { d: 0.2, auto: true, g: OPEN },
    ],
  },

  hydroplane: {
    label: 'Hydroplane',
    family: 'Foundation',
    blurb: 'Record pushed against a fingertip resting on it — the slip flutters the pitch.',
    beats: 1,
    flutter: { rate: 46, depth: 0.5 },
    moves: [
      { d: 0.5, v: 1.5, shape: 'flat', g: OPEN },
      { d: 0.5, auto: true, shape: 'flat', g: OPEN },
    ],
  },

  backspin: {
    label: 'Backspin',
    family: 'Foundation',
    blurb: 'One hard spin backwards and let it run — the classic rewind punctuation.',
    beats: 2,
    free: true, // no anchor return: the record ends up where the spin leaves it
    moves: [{ d: 2, v: -3.2, g: OPEN }],
  },

  /* ---------------- cut family: the fader hides the return ---------------- */

  forward: {
    label: 'Forward',
    family: 'Cuts',
    blurb: 'Only the forward push is heard; the fader shuts for the pull back.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.0, g: OPEN },
      { d: 0.5, auto: true, g: SHUT },
    ],
  },

  stab: {
    label: 'Stab / Chop',
    family: 'Cuts',
    blurb: 'A short violent forward jab, cut off dead. The classic horn stab.',
    beats: 1,
    moves: [
      { d: 0.22, v: 3.4, g: OPEN },
      { d: 0.78, auto: true, g: SHUT },
    ],
  },

  chirp: {
    label: 'Chirp',
    family: 'Cuts',
    blurb: 'Fader closes as each motion ends, so both directions keep only their attack.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.0, g: [{ at: 0, open: 1 }, { at: 0.55, open: 0 }] },
      { d: 0.5, auto: true, g: [{ at: 0, open: 1 }, { at: 0.55, open: 0 }] },
    ],
  },

  /* ---------------- click family: fader interrupts a continuous motion ----- */

  transformer: {
    label: 'Transformer',
    family: 'Clicks',
    blurb: 'Record travels slowly and evenly while the fader chops it into bursts.',
    beats: 2,
    moves: [
      { d: 1, v: 1.0, shape: 'flat', g: chop(4, { open: 0 }) },
      { d: 1, auto: true, shape: 'flat', g: chop(4, { open: 0 }) },
    ],
  },

  military: {
    label: 'Military',
    family: 'Clicks',
    blurb: 'Transformer at machine-gun rate — even, relentless, no gaps in the pattern.',
    beats: 1,
    moves: [
      { d: 0.5, v: 1.2, shape: 'flat', g: chop(6, { open: 0 }) },
      { d: 0.5, auto: true, shape: 'flat', g: chop(6, { open: 0 }) },
    ],
  },

  flare1: {
    label: 'Flare (1-click)',
    family: 'Clicks',
    blurb: 'Fader starts open and is interrupted once per motion. The click is a hole, not a hit.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.0, g: clicks(1, { duty: 0.34 }) },
      { d: 0.5, auto: true, g: clicks(1, { duty: 0.34 }) },
    ],
  },

  flare2: {
    label: 'Flare (2-click)',
    family: 'Clicks',
    blurb: 'Two interruptions per motion — the workhorse of modern battle routines.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.1, g: clicks(2, { duty: 0.4 }) },
      { d: 0.5, auto: true, g: clicks(2, { duty: 0.4 }) },
    ],
  },

  flare3: {
    label: 'Flare (3-click)',
    family: 'Clicks',
    blurb: 'Three per motion. Past this the wrist gives out and you are into crab territory.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.2, g: clicks(3, { duty: 0.42 }) },
      { d: 0.5, auto: true, g: clicks(3, { duty: 0.42 }) },
    ],
  },

  crab: {
    label: 'Crab',
    family: 'Clicks',
    blurb: 'Four clicks a motion, thumb-and-four-fingers. Each finger fires slightly loose — that unevenness is the sound.',
    beats: 1,
    // A crab is a 4-click flare in every respect a machine can measure. What
    // separates it on a real mixer is that four fingers release against a
    // thumb, so the clicks are never quite evenly spaced. Reproducing it
    // "perfectly" evenly is the one way to get it wrong, hence fingerJitter.
    fingerJitter: 0.16,
    moves: [
      { d: 0.5, v: 2.2, g: clicks(4, { duty: 0.44 }) },
      { d: 0.5, auto: true, g: clicks(4, { duty: 0.44 }) },
    ],
  },

  orbit: {
    label: 'Orbit',
    family: 'Clicks',
    blurb: 'A 2-click flare carried identically through both directions, so it never resets.',
    beats: 1,
    moves: [
      { d: 0.5, v: 2.0, g: clicks(2, { duty: 0.4 }) },
      { d: 0.5, auto: true, g: clicks(2, { duty: 0.4 }) },
    ],
  },

  reverseOrbit: {
    label: 'Reverse orbit',
    family: 'Clicks',
    blurb: 'The same orbit entered backwards — the pull leads instead of the push.',
    beats: 1,
    moves: [
      { d: 0.5, v: -2.0, g: clicks(2, { duty: 0.4 }) },
      { d: 0.5, auto: true, g: clicks(2, { duty: 0.4 }) },
    ],
  },

  uzi: {
    label: 'Uzi',
    family: 'Clicks',
    blurb: 'One-handed transformer run at flare speed — a burst, not a groove.',
    beats: 1,
    moves: [
      { d: 0.5, v: 1.6, g: chop(5, { open: 0 }) },
      { d: 0.5, auto: true, g: clicks(3, { duty: 0.4 }) },
    ],
  },

  dragTear: {
    label: 'Drag tear',
    family: 'Clicks',
    blurb: 'A tear performed at drag speed with a click in the return. Slow and mean.',
    beats: 2,
    moves: [
      { d: 0.8, v: 0.6, shape: 'flat', g: OPEN },
      { d: 0.5, v: -0.9, g: clicks(1, { duty: 0.3 }) },
      { d: 0.7, auto: true, g: OPEN },
    ],
  },
};

export const SCRATCH_KEYS = Object.keys(SCRATCHES);

/** Patterns grouped by family, for building a menu. */
export function scratchFamilies() {
  const out = new Map();
  for (const key of SCRATCH_KEYS) {
    const p = SCRATCHES[key];
    if (!out.has(p.family)) out.set(p.family, []);
    out.get(p.family).push({ key, ...p });
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * Resolve a pattern into concrete moves for one cycle: beats become seconds,
 * `auto` peaks get solved, and humanise jitter is applied fresh each cycle so
 * no two repeats are bit-identical.
 */
function buildCycle(pattern, beatDur, humanize) {
  const jit = (amt) => (humanize <= 0 ? 0 : (Math.random() * 2 - 1) * amt * humanize);

  const moves = pattern.moves.map((m) => ({
    shape: m.shape || 'sine',
    dur: Math.max(0.012, m.d * beatDur * (1 + jit(0.05))),
    v: m.v,
    auto: Boolean(m.auto),
    g: m.g || null,
  }));

  // Solve every `auto` move so the cycle returns to the anchor exactly.
  let fixed = 0;
  let autoWeight = 0;
  for (const m of moves) {
    const span = shapeTotal(m.shape) * m.dur;
    if (m.auto) autoWeight += span;
    else fixed += m.v * span;
  }
  for (const m of moves) {
    if (!m.auto) continue;
    m.v = autoWeight > 1e-9 ? -fixed / autoWeight : 0;
  }
  for (const m of moves) m.v *= 1 + jit(0.04);

  // Absolute timing within the cycle, plus each move's starting displacement.
  let t = 0;
  let disp = 0;
  for (const m of moves) {
    m.t0 = t;
    m.disp0 = disp;
    t += m.dur;
    disp += m.v * shapeTotal(m.shape) * m.dur;
  }
  return { moves, dur: t };
}

export class AutoScratch {
  /** @param {import('./engine.js').Deck} deck */
  constructor(deck) {
    this.deck = deck;
    this.running = false;
    this.pattern = 'baby';
    this.humanize = 0.35;
    this.intensity = 1; // scales every peak velocity
    this.anchor = 0;

    this._timer = null;
    this._cycles = [];
    this._nextCycleAt = 0;
    this._schedState = 1; // fader value the last scheduled event left behind
    this._flutterPhase = 0;
    this._lastTick = 0;
  }

  get gateParam() {
    const g = this.deck._graph;
    return g && g.scratchGate ? g.scratchGate.gain : null;
  }

  /** Seconds per beat at the deck's current playing tempo. */
  beatDuration() {
    const d = this.deck;
    const bpm = (d.bpm || 120) * (d.nominalRate || 1);
    return 60 / clamp(bpm, 40, 300);
  }

  start(name, opts = {}) {
    const d = this.deck;
    if (!d.canVinyl) return false;
    if (name && SCRATCHES[name]) this.pattern = name;
    if (opts.humanize !== undefined) this.humanize = clamp(opts.humanize, 0, 1);
    if (opts.intensity !== undefined) this.intensity = clamp(opts.intensity, 0.25, 2.5);

    // Scratch around the cue point when one is set — that is where the sample's
    // transient lives and it is what a DJ has their hand on.
    const cue = d.cuePoint || 0;
    const here = d.position;
    this.anchor = clamp(Math.abs(here - cue) < 0.02 ? cue : here, 0, d.duration);

    if (this.running) return true;
    this.running = true;
    d._afterMotor = null;
    d._enterPlatter(0);
    d._turntable.autoAdvance = false; // we own the position, exactly as a hand does
    d.scratching = true;

    this._cycles = [];
    this._nextCycleAt = d.mixer.ctx.currentTime + 0.03;
    this._flutterPhase = 0;
    this._lastTick = d.mixer.ctx.currentTime;
    this._setGateNow(1);

    this._timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    d.emit('autoscratch');
    d.emit('scratch');
    return true;
  }

  stop() {
    if (!this.running) return;
    const d = this.deck;
    const spec = SCRATCHES[this.pattern] || SCRATCHES.baby;
    this.running = false;
    clearInterval(this._timer);
    this._timer = null;
    this._cycles = [];
    this._setGateNow(1);

    d.scratching = false;
    if (d._turntable) {
      d._turntable.autoAdvance = true;
      // Free patterns (backspin) end wherever the record lands; everything
      // else snaps home so the loop of cycles never walks off the sample.
      if (!spec.free) d._turntable.setPosition(this.anchor);
    }
    // Hand the record back to the motor the same way a release does.
    if (d.playing) d._motorTo(d.nominalRate, 0.2, () => d._enterSource(d._turntable.position));
    else d._motorTo(0, 0.22, () => d._enterIdle());
    d.emit('autoscratch');
    d.emit('scratch');
  }

  toggle(name, opts) {
    if (this.running && (!name || name === this.pattern)) {
      this.stop();
      return false;
    }
    if (this.running) {
      // Switching pattern live: swap it in at the next cycle boundary rather
      // than cutting the current one off mid-motion.
      this.pattern = SCRATCHES[name] ? name : this.pattern;
      this.deck.emit('autoscratch');
      return true;
    }
    return this.start(name, opts);
  }

  _setGateNow(v) {
    const p = this.gateParam;
    this._schedState = v;
    if (!p) return;
    const now = this.deck.mixer.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(v, now + CUT_MS);
  }

  tick() {
    if (!this.running) return;
    const d = this.deck;
    if (!d.canVinyl || d._mode !== 'platter') {
      this.stop();
      return;
    }
    const ctx = d.mixer.ctx;
    const now = ctx.currentTime;
    const dt = clamp(now - this._lastTick, 0, 0.1);
    this._lastTick = now;

    const spec = SCRATCHES[this.pattern] || SCRATCHES.baby;
    const beat = this.beatDuration();

    /* -------- schedule fader events for any cycle entering the window ------ */
    while (this._nextCycleAt < now + LOOKAHEAD) {
      const cycle = buildCycle(spec, beat, this.humanize);
      cycle.start = this._nextCycleAt;
      this._scheduleGates(cycle, spec);
      this._cycles.push(cycle);
      this._nextCycleAt += cycle.dur;
    }
    while (this._cycles.length > 1 && this._cycles[0].start + this._cycles[0].dur < now - 0.05) {
      this._cycles.shift();
    }

    /* ------------------------- drive the record --------------------------- */
    const cycle = this._cycles.find((c) => now >= c.start && now < c.start + c.dur) || this._cycles[0];
    if (!cycle) return;

    const local = clamp(now - cycle.start, 0, cycle.dur);
    let move = cycle.moves[0];
    for (const m of cycle.moves) if (local >= m.t0) move = m;

    const u = clamp((local - move.t0) / move.dur, 0, 1);
    let vel = move.v * shapeVel(move.shape, u) * this.intensity;
    const disp = move.disp0 + move.v * shapeDisp(move.shape, u) * move.dur * this.intensity;

    // Hydroplane's stutter is a fast modulation of the record's speed, not of
    // the fader — the finger keeps catching and releasing the vinyl.
    if (spec.flutter) {
      this._flutterPhase += dt * spec.flutter.rate * Math.PI * 2;
      const f = 1 - spec.flutter.depth * (0.5 + 0.5 * Math.sin(this._flutterPhase));
      vel *= f;
    }

    const pos = clamp(this.anchor + disp, 0, d.duration);
    d._turntable.setPosition(pos);
    d._turntable.setRate(clamp(vel, -16, 16));
    d._platterRate = clamp(vel, -16, 16);
  }

  _scheduleGates(cycle, spec) {
    const p = this.gateParam;
    if (!p) return;
    const jitter = spec.fingerJitter || 0;
    const h = this.humanize;

    for (const move of cycle.moves) {
      if (!move.g) continue;
      for (const ev of move.g) {
        const target = ev.open ? 1 : 0;
        // A move that opens while already open must not be scheduled: holding
        // the value then ramping to it again would punch a 2 ms hole in the
        // audio, and a pattern full of those is just noise.
        if (target === this._schedState) continue;

        let at = ev.at;
        if (jitter > 0 && at > 0) at = clamp(at + (Math.random() * 2 - 1) * jitter * 0.06 * (1 + h), 0, 1);
        // +LATENCY: the fader acts on audio the grain queue emitted a moment ago.
        const when = Math.max(cycle.start + move.t0 + at * move.dur + LATENCY, CUT_MS);
        try {
          p.setValueAtTime(this._schedState, when - CUT_MS);
          p.linearRampToValueAtTime(target, when);
        } catch {
          /* param scheduling raced a stop */
        }
        this._schedState = target;
      }
    }
  }
}
