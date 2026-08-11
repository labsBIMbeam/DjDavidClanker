/**
 * Transitions — the ten ways this rig gets from one track to the next.
 *
 * Each flow is pure parameter automation over the handover window: crossfader,
 * EQ, filter, FX, loops. Nothing here inspects the music, so every flow works
 * on any pair of tracks — that is the point. What varies is the *shape* of the
 * move, not the material it is applied to.
 *
 * A flow is declared, not scripted:
 *
 *   enter  — the opening state, applied before the fader moves. A lane that
 *            begins at a value the parameter is not already sitting at will
 *            *step* to it when the lane opens, so anything a lane ramps FROM
 *            has to be established here first. This is also just what a DJ
 *            does: the incoming channel's bass is cut before it is brought up,
 *            not yanked down halfway through the blend.
 *   lanes  — continuous ramps. `{a, b}` is the sub-window of the transition
 *            (0..1) the ramp occupies, `ease` its curve. Evaluated every tick,
 *            so the parameter always arrives smoothly.
 *   events — one-shot moments (`at`), for the things that are supposed to be
 *            abrupt: a bass swap landing on the 1, a cut, a loop closing.
 *
 * Anything that should sound smooth belongs in a lane. Only put it in an event
 * if the abruptness IS the gesture.
 *
 * Energy classes:
 *   smooth  — invisible. Two tracks become one, nobody looks up. The default.
 *   marked  — audible seam, deliberately. Signals a change without a build.
 *   climax  — build and release. Only used when the incoming track is stepping
 *             the energy up; see pickTransition().
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, k) => a + (b - a) * k;

/** Full EQ cut. The engine floors at -26 dB, which is inaudible under a mix. */
const KILL = -26;

export const EASE = {
  linear: (k) => k,
  /** Smoothstep — no velocity discontinuity at either end. The default. */
  smooth: (k) => k * k * (3 - 2 * k),
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  /** Fast departure, long tail — for things that should get out of the way. */
  away: (k) => 1 - Math.pow(1 - k, 3),
  /** Slow start, late rush — builds. */
  build: (k) => Math.pow(k, 2.4),
};

/* --------------------------- lane helpers --------------------------- */

const lane = (a, b, ease, fn) => ({ a, b, ease: EASE[ease] || EASE.smooth, fn });
const at = (p, fn) => ({ at: p, fn });

/** Crossfader from its starting position to fully on the incoming deck. */
const xfade = (a, b, ease = 'smooth') =>
  lane(a, b, ease, (k, c) => c.setXf(lerp(c.from, c.to, k)));

const eqTo = (who, band, from, to, a, b, ease = 'smooth') =>
  lane(a, b, ease, (k, c) => c[who].setEq(band, lerp(from, to, k)));

const filterTo = (who, from, to, a, b, ease = 'smooth') =>
  lane(a, b, ease, (k, c) => c[who].setFilter(lerp(from, to, k)));

/* ------------------------------ the flows ------------------------------ */

export const TRANSITIONS = {
  /* ---------------------------- smooth ---------------------------- */

  longBlend: {
    label: 'Long blend',
    energy: 'smooth',
    bars: 32,
    blurb: 'Thirty-two bars of two tracks living together. Nobody notices the seam.',
    enter: (c) => c.idle.setEq('low', KILL),
    lanes: [
      xfade(0, 1, 'smooth'),
      // Incoming arrives with its bottom end out of the way, and takes it back
      // over the second half — two basslines at once is the one thing that
      // always sounds like a mistake.
      eqTo('idle', 'low', KILL, 0, 0.45, 0.8),
      eqTo('live', 'low', 0, KILL, 0.45, 0.8),
      eqTo('live', 'high', 0, -9, 0.7, 1),
    ],
  },

  eqBlend: {
    label: 'EQ blend',
    energy: 'smooth',
    bars: 24,
    blurb: 'Mids and highs interleave first, then the bass changes hands in one move.',
    enter: (c) => {
      c.idle.setEq('low', KILL);
      c.idle.setEq('high', -6);
    },
    lanes: [
      xfade(0, 0.75, 'smooth'),
      eqTo('idle', 'high', -6, 0, 0.1, 0.5),
      eqTo('live', 'mid', 0, -7, 0.6, 1),
      eqTo('live', 'high', 0, KILL, 0.65, 1),
    ],
    events: [
      // The swap itself is meant to be felt. Everything around it is not.
      at(0.55, (c) => {
        c.idle.setEq('low', 0);
        c.live.setEq('low', KILL);
      }),
    ],
  },

  bassSwap: {
    label: 'Bass swap',
    energy: 'smooth',
    bars: 16,
    blurb: 'Both tracks up, lows traded on the downbeat. The workhorse.',
    enter: (c) => c.idle.setEq('low', KILL),
    lanes: [
      xfade(0, 1, 'smooth'),
      eqTo('live', 'mid', 0, -5, 0.55, 1),
    ],
    events: [
      at(0.5, (c) => {
        c.idle.setEq('low', 0);
        c.live.setEq('low', KILL);
      }),
    ],
  },

  filterFade: {
    label: 'Filter fade',
    energy: 'smooth',
    bars: 20,
    blurb: 'Outgoing track sinks under a low-pass while the incoming opens up.',
    enter: (c) => {
      c.idle.setFilter(0.55);
      c.idle.setEq('low', -14);
    },
    lanes: [
      xfade(0.15, 0.9, 'smooth'),
      filterTo('live', 0, -0.92, 0.1, 1, 'smooth'),
      filterTo('idle', 0.55, 0, 0.15, 0.75, 'out'),
      eqTo('idle', 'low', -14, 0, 0.2, 0.6),
      eqTo('live', 'low', 0, KILL, 0.5, 0.85),
    ],
  },

  driftUnder: {
    label: 'Drift under',
    energy: 'smooth',
    bars: 28,
    blurb: 'The new track slides in underneath and is simply there when the old one leaves.',
    enter: (c) => {
      c.idle.setEq('low', KILL);
      c.idle.setEq('mid', -10);
    },
    lanes: [
      xfade(0.2, 1, 'linear'),
      eqTo('idle', 'low', KILL, 0, 0.5, 0.9),
      eqTo('idle', 'mid', -10, 0, 0.15, 0.6),
      eqTo('live', 'low', 0, KILL, 0.5, 0.9),
      eqTo('live', 'mid', 0, -6, 0.75, 1),
      filterTo('live', 0, -0.4, 0.8, 1, 'in'),
    ],
  },

  /* ---------------------------- marked ---------------------------- */

  echoOut: {
    label: 'Echo out',
    energy: 'marked',
    bars: 12,
    blurb: 'Delay catches the last phrase and the outgoing channel steps away under it.',
    enter: (c) => c.idle.setEq('low', KILL),
    lanes: [
      xfade(0.55, 0.85, 'smooth'),
      eqTo('idle', 'low', KILL, 0, 0.55, 0.85),
    ],
    events: [
      at(0.5, (c) => c.live.toggleFx('echo', true)),
      at(0.52, (c) => c.live.setFx('echo', { feedback: 0.62, mix: 0.6, division: 0.5 })),
      // The source goes; the tail is what carries the seam.
      at(0.72, (c) => c.live.setEq('low', KILL)),
      at(0.86, (c) => c.live.setEq('mid', KILL)),
    ],
    cleanup: (c) => c.live.toggleFx('echo', false),
  },

  loopRoll: {
    label: 'Loop roll',
    energy: 'marked',
    bars: 12,
    blurb: 'Outgoing track folds into a tightening loop and hands over on the release.',
    enter: (c) => c.idle.setEq('low', KILL),
    lanes: [
      xfade(0.82, 0.95, 'smooth'),
      eqTo('idle', 'low', KILL, 0, 0.8, 0.95),
    ],
    events: [
      at(0.55, (c) => c.live.setLoopBeats(4)),
      at(0.7, (c) => c.live.setLoopBeats(2)),
      at(0.8, (c) => c.live.setLoopBeats(1)),
      at(0.94, (c) => c.live.exitLoop()),
    ],
    cleanup: (c) => c.live.exitLoop(),
  },

  cut: {
    label: 'Cut',
    energy: 'marked',
    bars: 2,
    blurb: 'Straight swap on the downbeat. Momentum, no ceremony.',
    lanes: [
      // Short enough to read as a cut, ramped enough not to click.
      xfade(0.45, 0.55, 'smooth'),
    ],
    events: [
      at(0.45, (c) => c.idle.setEq('low', 0)),
      at(0.55, (c) => c.live.setEq('low', KILL)),
    ],
  },

  spinback: {
    label: 'Spinback',
    energy: 'marked',
    bars: 8,
    blurb: 'The record is pulled back and the next one is already there.',
    lanes: [xfade(0.78, 0.9, 'out')],
    events: [
      at(0.7, (c) => {
        if (c.live.canVinyl) c.live.startRewind();
      }),
      at(0.86, (c) => {
        if (c.live.rewinding) c.live.stopRewind();
        c.idle.setEq('low', 0);
      }),
    ],
    cleanup: (c) => {
      if (c.live.rewinding) c.live.stopRewind();
    },
  },

  /* ---------------------------- climax ---------------------------- */

  dropSwap: {
    label: 'Drop swap',
    energy: 'climax',
    bars: 16,
    blurb: 'High-pass build, a beat of daylight, and the new track lands on the 1.',
    lanes: [
      // The build: everything narrows and lifts.
      filterTo('live', 0, 0.86, 0.15, 0.82, 'build'),
      eqTo('live', 'low', 0, KILL, 0.55, 0.82),
      // No crossfader lane on purpose: the incoming track is not heard at all
      // until the drop event throws the fader across on the 1.
    ],
    events: [
      at(0.6, (c) => c.live.toggleFx('echo', true)),
      // A beat of space. Silence is what makes the next bar hit.
      at(0.86, (c) => {
        c.live.setEq('mid', KILL);
        c.live.setEq('high', KILL);
      }),
      at(0.9, (c) => {
        c.setXf(c.to);
        c.live.toggleFx('echo', false);
        c.idle.setEq('low', 0);
        c.idle.setEq('mid', 0);
        c.idle.setEq('high', 0);
        c.idle.setFilter(0);
      }),
    ],
    cleanup: (c) => {
      c.live.toggleFx('echo', false);
      c.live.setFilter(0);
    },
  },

  buildRelease: {
    label: 'Build & release',
    energy: 'climax',
    bars: 24,
    blurb: 'A long lift on the outgoing track that breaks open into the new one.',
    enter: (c) => {
      c.idle.setEq('low', KILL);
      c.idle.setFilter(0.35);
    },
    lanes: [
      filterTo('live', 0, 0.78, 0.2, 0.85, 'build'),
      eqTo('live', 'low', 0, KILL, 0.5, 0.85),
      xfade(0.7, 0.92, 'in'),
      eqTo('idle', 'low', KILL, 0, 0.82, 0.95),
      filterTo('idle', 0.35, 0, 0.7, 0.95, 'out'),
    ],
    events: [
      at(0.55, (c) => c.live.toggleFx('gater', true)),
      at(0.55, (c) => c.live.setFx('gater', { division: 0.5, duty: 0.6, depth: 0.8 })),
      at(0.75, (c) => c.live.setFx('gater', { division: 0.25, duty: 0.5, depth: 1 })),
      at(0.86, (c) => c.live.toggleFx('gater', false)),
    ],
    cleanup: (c) => {
      c.live.toggleFx('gater', false);
      c.live.setFilter(0);
    },
  },
};

export const TRANSITION_KEYS = Object.keys(TRANSITIONS);

export const transitionsByEnergy = (energy) =>
  TRANSITION_KEYS.filter((k) => TRANSITIONS[k].energy === energy);

/**
 * Choose the flow for a handover.
 *
 * Climaxes are earned, not rolled for: they only come out when the incoming
 * track is genuinely stepping the energy up, which is the one moment a build
 * actually reads as a build rather than as noise. Everything else stays smooth,
 * with the occasional marked seam so a long set does not go flat — all cuts is
 * frantic, all blends is wallpaper.
 *
 * @param {object}   o
 * @param {number}   o.liveBpm      effective BPM of the outgoing deck
 * @param {number}   o.idleBpm      effective BPM of the incoming deck
 * @param {number}   o.seconds      how much runway the transition actually has
 * @param {string[]} [o.recent]     keys used recently, avoided where possible
 * @param {number}   [o.markedRate] 0..1 chance of a marked seam (default 0.25)
 * @param {() => number} [o.rng]
 */
export function pickTransition({ liveBpm, idleBpm, seconds, recent = [], markedRate = 0.25, rng = Math.random } = {}) {
  const jump = (idleBpm || 0) - (liveBpm || 0);
  // A clear step up in tempo is the cue for a build. Below that, a climax would
  // be arriving unannounced and just sounds like the mix tripped over.
  const wantsClimax = liveBpm > 0 && idleBpm > 0 && jump >= 4;

  let pool = wantsClimax
    ? transitionsByEnergy('climax')
    : rng() < markedRate
      ? transitionsByEnergy('marked')
      : transitionsByEnergy('smooth');

  // Never pick a flow that does not fit in the runway — a 32-bar blend crammed
  // into 6 seconds is where the hectic feeling comes from.
  const fits = (k) => !seconds || minSecondsFor(TRANSITIONS[k], liveBpm) <= seconds;
  const fitting = pool.filter(fits);
  if (fitting.length) pool = fitting;
  else pool = TRANSITION_KEYS.filter(fits);
  // Nothing fits: take the shortest thing there is rather than stalling.
  if (!pool.length) pool = ['cut'];

  const fresh = pool.filter((k) => !recent.includes(k));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rng() * from.length) % from.length];
}

/** How long this flow needs at a given tempo, in seconds. */
export function minSecondsFor(flow, bpm) {
  const beat = 60 / (bpm > 0 ? bpm : 120);
  return flow.bars * 4 * beat;
}

/**
 * A flow in progress.
 *
 * Owns every parameter it touches and puts all of them back on `finish()`,
 * including when it is abandoned part-way — a transition that leaves an EQ
 * killed or a filter parked is how a mix quietly dies.
 */
export class Transition {
  /**
   * @param {string} key            flow name from TRANSITIONS
   * @param {object} o
   * @param {object} o.live         outgoing deck
   * @param {object} o.idle         incoming deck
   * @param {number} o.dur          seconds
   * @param {number} o.from         crossfader position now
   * @param {number} o.to           crossfader position when done
   * @param {(v:number)=>void} o.setXf
   */
  constructor(key, { live, idle, dur, from, to, setXf }) {
    this.key = TRANSITIONS[key] ? key : 'longBlend';
    this.flow = TRANSITIONS[this.key];
    this.label = this.flow.label;
    this.t = 0;
    this.dur = Math.max(0.5, dur);
    this.from = from;
    this.to = to;
    this.done = false;
    this._fired = new Set();

    this.ctx = { live, idle, from, to, setXf };

    // Snapshot everything a flow is allowed to touch, so finish() can restore
    // exactly what was there rather than guessing at neutral values.
    this._restore = [live, idle].map((d) => ({
      deck: d,
      eq: { ...d.eq },
      filter: d.filter,
    }));

    // Establish the opening state before the first frame. Snapshot first, so
    // finish() still restores what was there before the flow touched anything.
    if (this.flow.enter) {
      try {
        this.flow.enter(this.ctx);
      } catch {
        /* deck went away before it started */
      }
    }
  }

  get progress() {
    return clamp(this.t / this.dur, 0, 1);
  }

  tick(dt) {
    if (this.done) return true;
    this.t += dt;
    const p = this.progress;

    for (const l of this.flow.lanes || []) {
      if (p < l.a) continue;
      const k = l.b > l.a ? clamp((p - l.a) / (l.b - l.a), 0, 1) : 1;
      try {
        l.fn(l.ease(k), this.ctx);
      } catch {
        // A deck ejected mid-flow must not take the mix down with it: lanes
        // run every frame, so an unguarded throw here stops automix dead.
      }
    }

    for (let i = 0; i < (this.flow.events || []).length; i++) {
      const e = this.flow.events[i];
      if (p >= e.at && !this._fired.has(i)) {
        this._fired.add(i);
        try {
          e.fn(this.ctx);
        } catch {
          /* deck went away mid-flow */
        }
      }
    }

    if (p >= 1) this.done = true;
    return this.done;
  }

  /** Land the fader and put every borrowed control back where it was. */
  finish() {
    try {
      if (this.flow.cleanup) this.flow.cleanup(this.ctx);
    } catch {
      /* deck went away */
    }
    for (const s of this._restore) {
      try {
        s.deck.setEq('low', s.eq.low);
        s.deck.setEq('mid', s.eq.mid);
        s.deck.setEq('high', s.eq.high);
        s.deck.setFilter(s.filter);
      } catch {
        /* deck went away */
      }
    }
    this.done = true;
  }

  describe() {
    return { label: this.label, remaining: Math.max(0, this.dur - this.t) };
  }
}
