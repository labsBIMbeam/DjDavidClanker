/**
 * The bit that actually performs.
 *
 * Automix keeps tracks coming and the crossfader honest; this is what does
 * something interesting with them. It runs on the live deck's bar grid and on
 * every bar decides whether to throw a scratch, a loop roll, an effect, a
 * filter sweep or a band kill at the mix, then takes it back off again when
 * the hold expires.
 *
 * Two rules make it safe to leave running:
 *
 *   - Every gesture is a pair. Nothing is switched on without an undo closure
 *     recorded alongside it and a bar count after which it fires, so the mix
 *     always returns to neutral instead of silting up with six effects on.
 *   - It never touches a deck a human has hold of, and it stays off the
 *     crossfader while automix is mid-transition. Whatever you grab, you win.
 *
 * Like automix it only calls public Deck/Mixer methods, and it is driven from
 * the frame loop rather than owning a timer.
 */

import { FX_TYPES } from './engine.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Scratch routines worth throwing mid-mix, loosely ordered by aggression. */
const SCRATCH_SET = ['baby', 'forward', 'stab', 'chirp', 'flare1', 'flare2', 'flare3', 'crab', 'orbit', 'transformer', 'military', 'scribble', 'tear2', 'uzi'];

const LOOP_BEATS = [4, 2, 1, 1, 0.5, 0.5, 0.25];

/**
 * Moods — how busy the performer is while a track plays, and with what.
 *
 * One is chosen per track and held for its duration, which is what stops the
 * mix feeling like a slot machine: a track gets a character and keeps it,
 * instead of every bar rolling independently across the whole gesture set.
 *
 * `intensity` is the chance a given bar gets anything at all, `holds` the
 * ceiling on concurrent gestures. The weights are relative, not percentages.
 *
 * Deliberately weighted toward the quiet end. `busy` and `peak` exist so a long
 * set has somewhere to go, but they are rare by design — see pickMood().
 */
export const MOODS = {
  minimal: {
    label: 'Minimal', intensity: 0.1, holds: 1,
    weights: { blend: 3, fadeRide: 1, filterSweep: 2, bandIsolate: 1 },
  },
  breathe: {
    label: 'Breathe', intensity: 0.16, holds: 1,
    weights: { blend: 4, filterSweep: 3, bandIsolate: 1, fadeRide: 1 },
  },
  filterDrift: {
    label: 'Filter drift', intensity: 0.22, holds: 1,
    weights: { filterSweep: 6, blend: 3, bandIsolate: 1 },
  },
  dubEcho: {
    label: 'Dub echo', intensity: 0.24, holds: 2,
    weights: { fxBurst: 5, filterSweep: 2, blend: 2, bandIsolate: 1 },
  },
  bandPlay: {
    label: 'Band play', intensity: 0.26, holds: 2,
    weights: { bandIsolate: 5, blend: 3, filterSweep: 2 },
  },
  blendFocus: {
    label: 'Blend focus', intensity: 0.28, holds: 2,
    weights: { blend: 6, fadeRide: 3, filterSweep: 1 },
  },
  loopPlay: {
    label: 'Loop play', intensity: 0.3, holds: 2,
    weights: { loopRoll: 4, blend: 3, filterSweep: 2, fxBurst: 1 },
  },
  faderRide: {
    label: 'Fader ride', intensity: 0.32, holds: 2,
    weights: { fadeRide: 4, faderChop: 3, blend: 3, filterSweep: 1 },
  },
  busy: {
    label: 'Busy', intensity: 0.45, holds: 2,
    weights: { blend: 3, fadeRide: 2, faderChop: 2, filterSweep: 2, bandIsolate: 2, fxBurst: 2, loopRoll: 1 },
  },
  peak: {
    label: 'Peak', intensity: 0.6, holds: 3,
    weights: { faderChop: 3, loopRoll: 3, fxBurst: 3, scratchBurst: 2, bandIsolate: 2, blend: 2, fadeRide: 1 },
  },
};

export const MOOD_KEYS = Object.keys(MOODS);

/** The calm ones, which is nearly all of them. */
const CALM_MOODS = MOOD_KEYS.filter((k) => MOODS[k].intensity <= 0.32);

/**
 * Pick a mood for a track. Busy and peak only come out when the track itself is
 * driving harder than what came before — the same rule the transitions use, so
 * the energy of the set is decided by the music rather than by dice.
 */
export function pickMood({ bpm = 0, prevBpm = 0, recent = [], rng = Math.random } = {}) {
  const lively = bpm > 0 && prevBpm > 0 && bpm - prevBpm >= 4;
  const pool = lively && rng() < 0.6 ? ['busy', 'peak'] : CALM_MOODS;
  const fresh = pool.filter((k) => !recent.includes(k));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rng() * from.length) % from.length];
}

export class Performer {
  /**
   * @param {import('./engine.js').Mixer} mixer
   * @param {{automix?: object, onStatus?: (s: string) => void}} [hooks]
   */
  constructor(mixer, { automix = null, onStatus = () => {}, onCrossfade = () => {} } = {}) {
    this.mixer = mixer;
    this.automix = automix;
    this.onStatus = onStatus;
    this.onCrossfade = onCrossfade; // keep the visible fader in step

    this.enabled = false;
    /**
     * Global scale on top of the mood, 0..1. The mood decides the character;
     * this is the master "how much" if you want the whole thing quieter still.
     */
    this.intensity = 1;

    /** Current mood, re-picked whenever the live track changes. */
    this.mood = 'breathe';
    this._recentMoods = [];
    this._moodTrackId = null;
    this._moodBar = 0;
    this._prevBpm = 0;

    this._clock = 0;
    this._nextBar = 0;
    this._holds = [];
    this._bar = 0;
    this.lastAction = '';
  }

  /* ------------------------------ control ------------------------------ */

  start({ opener = true } = {}) {
    if (this.enabled) return;
    this.enabled = true;
    this._clock = 0;
    this._nextBar = 0;
    this._bar = 0;
    this.onStatus('on');
    // Do something audible immediately rather than waiting for the first bar
    // line — the whole point is that it bites the moment it is switched on.
    if (opener) this._opener();
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    this._releaseAll();
    this.onStatus('off');
  }

  toggle() {
    this.enabled ? this.stop() : this.start();
  }

  /* ------------------------------ helpers ------------------------------ */

  /** The deck the audience can actually hear most of. */
  get liveDeck() {
    if (this.automix && this.automix.liveDeck) return this.automix.liveDeck;
    const { A, B } = this.mixer.decks;
    const gain = (d) => this.mixer.crossValue(d.id) * (d.playing ? 1 : 0);
    return gain(B) > gain(A) ? B : A;
  }

  get otherDeck() {
    const live = this.liveDeck;
    return this.mixer.decks[live.id === 'A' ? 'B' : 'A'];
  }

  /** A deck is fair game unless a hand is on it or it has nothing loaded. */
  _usable(deck) {
    if (!deck || deck.status !== 'ready' || !deck.canVinyl) return false;
    if (deck.scratching && !deck.autoScratching) return false; // human has it
    if (deck.rewinding) return false;
    return true;
  }

  get beatDuration() {
    const bpm = this.liveDeck.effectiveBpm || this.liveDeck.bpm || 120;
    return 60 / clamp(bpm, 40, 300);
  }

  /**
   * Is a gesture of this kind already running?
   *
   * This matters more than it looks. Every gesture captures the value it is
   * about to move ("filter was at 0") so it can put it back. If a second
   * gesture of the same kind starts while the first is mid-sweep, it captures
   * the swept value as its idea of "original" and restores to that — so the
   * mix ratchets a little further from neutral on every overlap and never
   * comes home. Exclusivity by tag is what stops that.
   */
  _has(tag) {
    return this._holds.some((h) => h.tag === tag);
  }

  /**
   * Register a gesture and the undo that ends it.
   *
   * `deck` is what the gesture writes to; if a hand lands on it mid-hold the
   * gesture releases early rather than carrying on underneath the user.
   * `tag` is its exclusivity key — see `_has`.
   */
  _hold({ label, tag, bars, undo, update, deck }) {
    this._holds.push({
      label,
      tag: tag || label,
      until: this._clock + bars * 4 * this.beatDuration,
      undo,
      update,
      deck,
      born: this._clock,
    });
    this.lastAction = label;
    this.onStatus('action');
  }

  _releaseAll() {
    for (const h of this._holds) {
      try {
        h.undo();
      } catch {
        /* the deck may have been ejected under us */
      }
    }
    this._holds = [];
  }

  /* ------------------------------ gestures ------------------------------ */

  _opener() {
    const live = this.liveDeck;
    if (!this._usable(live)) return;
    // Open by bringing the second deck up against the first — that is the
    // sound of a mix starting, rather than a trick being performed.
    this._align();
    this._blend(4);
    this._filterSweep(live, 2);
  }

  _scratchBurst(deck, bars, pattern) {
    if (!this._usable(deck) || deck.autoScratching) return;
    deck.toggleAutoScratch(pattern || pick(SCRATCH_SET));
    this._hold({
      label: `scratch ${deck.id}`, tag: `scratch:${deck.id}`, bars, deck,
      undo: () => deck.stopAutoScratch(),
    });
  }

  _loopRoll(deck, bars) {
    if (!this._usable(deck) || !deck.bpm || deck.loop.active) return;
    const beats = pick(LOOP_BEATS);
    deck.setLoopBeats(beats);
    this._hold({
      label: `loop ${beats}b ${deck.id}`, tag: `loop:${deck.id}`, bars, deck,
      undo: () => deck.exitLoop(),
    });
  }

  _fxBurst(deck, bars) {
    if (!this._usable(deck)) return;
    const unit = pick(FX_TYPES);
    if (deck.fx[unit] && deck.fx[unit].on) return; // already running
    deck.toggleFx(unit, true);
    this._hold({
      label: `fx ${unit} ${deck.id}`, tag: `fx:${deck.id}:${unit}`, bars, deck,
      undo: () => deck.toggleFx(unit, false),
    });
  }

  _filterSweep(deck, bars) {
    if (!this._usable(deck) || this._has(`filter:${deck.id}`)) return;
    const from = deck.filter;
    // Sweep out and back inside the hold, so it lands where it started.
    const to = Math.random() < 0.5 ? -0.85 : 0.7;
    this._hold({
      label: `filter ${deck.id}`, tag: `filter:${deck.id}`, bars, deck,
      undo: () => deck.setFilter(from),
      update: (k) => deck.setFilter(from + (to - from) * Math.sin(Math.PI * k)),
    });
  }

  /**
   * Band isolation — the honest version of "stem focus" for a stereo mix.
   * Killing the lows on one deck while the other keeps its bottom end is how
   * two tracks are actually made to sit together live; no source separation
   * is involved and none is claimed.
   */
  _bandIsolate(bars) {
    const live = this.liveDeck;
    const other = this.otherDeck;
    if (!this._usable(live) || !this._usable(other) || !other.playing) return;
    if (this._has('isolate')) return;
    const band = pick(['low', 'high']);
    const wasLive = live.eq[band];
    const wasOther = other.eq[band === 'low' ? 'high' : 'low'];
    live.setEq(band, -26);
    other.setEq(band === 'low' ? 'high' : 'low', -26);
    this._hold({
      label: `isolate ${band}`, tag: 'isolate', bars, deck: live,
      undo: () => {
        live.setEq(band, wasLive);
        other.setEq(band === 'low' ? 'high' : 'low', wasOther);
      },
    });
  }

  /**
   * Lock the other deck to the live one — tempo, then beat phase. Cheap, and
   * worth doing far more often than it looks, because both decks drift: the
   * pitch fader is analogue-ish and a scratch or a loop exit moves the
   * playhead. Re-aligning on a bar line is what keeps a long blend tight.
   */
  _align() {
    const live = this.liveDeck;
    const other = this.otherDeck;
    if (!this._usable(live) || !this._usable(other)) return false;
    if (!other.bpm || !live.effectiveBpm) return false;
    if (!other.matchTempoTo(live)) return false; // unreachable — leave it be
    other.setSynced(live);
    this.lastAction = `align ${other.id}→${live.id}`;
    this.onStatus('action');
    return true;
  }

  /**
   * Bring the other deck up alongside the live one and ride the crossfader
   * between them, both audible, then come back. This is the gesture that
   * actually sounds like two records being mixed rather than one record being
   * messed with, so it is weighted heavily.
   */
  _blend(bars) {
    const live = this.liveDeck;
    const other = this.otherDeck;
    if (!this._usable(live) || !this._usable(other)) return;
    // One gesture on the crossfader at a time — see `_has`.
    if (this.automix && this.automix.fade) return; // the fader is spoken for
    if (this._has('fader')) return;

    this._align();
    const wasPlaying = other.playing;
    if (!wasPlaying) {
      other.seek(other.cuePoint || 0);
      other.play();
    }
    // Automix stops a second running deck by default; this is the exception.
    const automix = this.automix;
    const hadAllowBoth = automix ? automix.allowBoth : false;
    if (automix) automix.allowBoth = true;

    const from = this.mixer.crossfader;
    // Ride to a genuine two-deck position rather than all the way across —
    // the point is to hear both, not to swap one for the other.
    const toward = other.id === 'A' ? -0.35 : 0.35;
    const set = (v) => {
      this.mixer.setCrossfader(v);
      this.onCrossfade(this.mixer.crossfader);
    };

    this._hold({
      label: `blend ${live.id}+${other.id}`, tag: 'fader', bars, deck: live,
      undo: () => {
        set(from);
        if (automix) automix.allowBoth = hadAllowBoth;
        if (!wasPlaying && !(automix && automix.liveDeck === other)) other.pause();
      },
      update: (k) => {
        set(from + (toward - from) * Math.sin(Math.PI * k));
        // Drift correction partway through — a blend that starts locked and
        // ends flamming is worse than one that never happened.
        if (!this._alignedAt || k - this._alignedAt > 0.45) {
          this._alignedAt = k;
          if (k < 0.9) this._align();
        }
        if (k >= 0.999) this._alignedAt = 0;
      },
    });
  }

  /** A long crossfade out and back, one deck to the other and home again. */
  _fadeRide(bars) {
    if (this.automix && this.automix.fade) return;
    if (this._has('fader')) return;
    const from = this.mixer.crossfader;
    const to = clamp(from <= 0 ? from + 0.75 : from - 0.75, -1, 1);
    const set = (v) => {
      this.mixer.setCrossfader(v);
      this.onCrossfade(this.mixer.crossfader);
    };
    this._hold({
      label: 'fade ride', tag: 'fader', bars,
      undo: () => set(from),
      update: (k) => set(from + (to - from) * Math.sin(Math.PI * k)),
    });
  }

  /** Crossfader stabs. Skipped while automix owns the fader for a transition. */
  _faderChop(bars) {
    if (this.automix && this.automix.fade) return;
    if (this._has('fader')) return;
    const from = this.mixer.crossfader;
    const away = clamp(from + (from <= 0 ? 0.9 : -0.9), -1, 1);
    const set = (v) => {
      this.mixer.setCrossfader(v);
      this.onCrossfade(this.mixer.crossfader);
    };
    this._hold({
      label: 'fader chop', tag: 'fader', bars,
      undo: () => set(from),
      update: (k) => {
        // Square wave on eighths — a cut, not a fade.
        const on = Math.floor(k * bars * 8) % 2 === 0;
        set(on ? from : away);
      },
    });
  }

  /* ------------------------------ engine ------------------------------ */

  tick(dt) {
    if (!this.enabled) return;
    const step = clamp(dt, 0, 0.25);
    this._clock += step;

    // Run and expire holds.
    for (let i = this._holds.length - 1; i >= 0; i--) {
      const hold = this._holds[i];
      const seized = hold.deck && !this._usable(hold.deck);
      if (seized || this._clock >= hold.until) {
        this._holds.splice(i, 1);
        try {
          hold.undo();
        } catch {
          /* deck gone */
        }
      } else if (hold.update) {
        const k = (this._clock - hold.born) / Math.max(0.001, hold.until - hold.born);
        try {
          hold.update(clamp(k, 0, 1));
        } catch {
          /* deck gone */
        }
      }
    }

    if (this._clock < this._nextBar) return;
    const bar = 4 * this.beatDuration;
    this._nextBar = this._clock + bar;
    this._bar++;

    const live = this.liveDeck;
    if (!this._usable(live)) return;

    this._syncMood(live);
    const mood = MOODS[this.mood] || MOODS.breathe;

    // Keep the decks locked to each other every couple of bars regardless of
    // what else happens — alignment is upkeep, not a gesture.
    if (this._bar % 2 === 0) this._align();

    // The mood decides how often anything happens at all. This is the single
    // biggest lever on whether the mix feels composed or frantic.
    if (Math.random() > mood.intensity * this.intensity) return;
    if (this._holds.length >= mood.holds) return;

    // Never start a gesture on top of a handover — the transition is already
    // the event, and piling a scratch onto it is exactly the hectic feeling.
    if (this.automix && this.automix.fade) return;

    const gesture = this._rollGesture(mood.weights);
    switch (gesture) {
      case 'blend': return this._blend(8);
      case 'fadeRide': return this._fadeRide(8);
      case 'faderChop': return this._faderChop(1);
      case 'filterSweep': return this._filterSweep(live, 4);
      case 'bandIsolate': return this._bandIsolate(2);
      case 'fxBurst': return this._fxBurst(Math.random() < 0.6 ? live : this.otherDeck, 4);
      case 'loopRoll': return this._loopRoll(live, 1);
      case 'scratchBurst': return this._scratchBurst(live, 1);
      default: return undefined;
    }
  }

  /**
   * Re-pick the mood when the live track changes, and hold it for that track —
   * a track keeps one character instead of every bar rolling independently.
   *
   * Falls back to a bar timer when the deck has no track identity, so the
   * performer can never end up locked in a single mood for a whole set.
   */
  _syncMood(live) {
    const id = live.track && live.track.id;
    const changed = id ? id !== this._moodTrackId : this._bar - this._moodBar >= 32;
    if (!changed) return;
    const bpm = live.effectiveBpm || live.bpm || 0;
    this.mood = pickMood({ bpm, prevBpm: this._prevBpm, recent: this._recentMoods });
    this._recentMoods.push(this.mood);
    if (this._recentMoods.length > 3) this._recentMoods.shift();
    this._moodTrackId = id || null;
    this._moodBar = this._bar;
    this._prevBpm = bpm;
  }

  /** Weighted choice over the mood's gesture table. */
  _rollGesture(weights) {
    const keys = Object.keys(weights);
    let total = 0;
    for (const k of keys) total += weights[k];
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) return k;
    }
    return keys[keys.length - 1];
  }

  describe() {
    if (!this.enabled) return { label: 'OFF', detail: '' };
    const now = this._holds.map((h) => h.label).join(' + ');
    const mood = (MOODS[this.mood] || MOODS.breathe).label;
    return { label: mood.toUpperCase(), detail: now || `bar ${this._bar}` };
  }
}
