/**
 * Automix — the deck keeps running when you walk away.
 *
 * It drives the two decks the way a person would: keep one deck live, load the
 * next track onto the idle one well ahead of time, beat-match it, then ride the
 * crossfader across during the outro. Nothing here reaches into the audio
 * graph; it only calls the same public Deck and Mixer methods the buttons do,
 * so a human can grab any control mid-mix and the state stays coherent.
 *
 * Driven from the frame loop via `tick(dt)` — no timers of its own.
 */

import { TRANSITIONS, Transition, pickTransition, minSecondsFor } from './transitions.js';
import { pickNextIndex } from './harmony.js';
import { compatibility } from './key.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Automix {
  /**
   * @param {import('./engine.js').Mixer} mixer
   * @param {object} hooks
   * @param {(v:number)=>void} hooks.onCrossfade  keep the UI fader in step
   * @param {(t:object)=>void} [hooks.onTrack]    a track just went live
   * @param {()=>Array}       [hooks.refill]      called when the queue empties
   * @param {(s:string)=>void}[hooks.onStatus]
   * @param {import('./harmony.js').TrackKeys} [hooks.keys] remembered analysis,
   *   which is what lets the next track be chosen for its key before it is
   *   loaded rather than argued with afterwards.
   */
  constructor(mixer, { onCrossfade, onTrack, refill, onStatus, keys } = {}) {
    this.mixer = mixer;
    this.onCrossfade = onCrossfade || (() => {});
    this.onTrack = onTrack || (() => {});
    this.refill = refill || (() => []);
    this.onStatus = onStatus || (() => {});
    this.keys = keys || null;

    this.enabled = false;
    /**
     * Runway handed to a transition, not its length — the chosen flow decides
     * how long it actually wants. Generous by default: the common complaint is
     * a mix that feels rushed, and every flow here reads better with room.
     */
    this.fadeSeconds = 26;
    this.syncTempo = true;
    this.shuffle = false;

    /**
     * Choose the next track for its key as well as its place in the list.
     *
     * Harmonic mixing on a rig without key lock has to happen at selection
     * time: once a track is loaded, the only way to move its key is to move
     * its speed, and losing the beat-match is worse than the clash. So the
     * queue is read a few entries ahead and the one that fits is brought
     * forward — never dropped, and never deferred indefinitely.
     */
    this.harmonic = true;
    this.harmonyWindow = 6;

    /** How many times each track id has been passed over for its key. */
    this._deferrals = new Map();

    /** Last handover's key relation, for the UI. */
    this.harmony = null;

    /**
     * How often a handover is allowed an audible seam (cut, echo out, spinback)
     * rather than an invisible blend. All blends goes flat, all cuts is
     * exhausting; a quarter marked is roughly what a set sounds like. Climaxes
     * are not in this budget — they are earned by the music, see pickTransition.
     */
    this.markedRate = 0.25;

    /** Recently used flows, so the same move does not come round twice. */
    this._recentFlows = [];
    this.lastFlow = '';

    /**
     * Normally exactly one deck is live and a second running deck is stopped,
     * because two uncoordinated tracks is just a mess. The performer sets this
     * while it is deliberately blending both decks together, which is the one
     * case where two decks playing at once is the intent rather than a fault.
     */
    this.allowBoth = false;

    /** How early to start loading the next track. Decoding an mp3 is slow. */
    this.preloadLead = 35;

    this.queue = [];
    this.cursor = 0;
    this.history = [];

    this.liveId = null; // 'A' | 'B'
    this.fade = null; // a Transition while a handover is in flight
    this.busy = false; // a load is in flight
    this.pending = null; // track staged on the idle deck
    this.lastError = '';

    /**
     * Decks holding a track that has already been played out. A deck coming off
     * a transition still has its finished track loaded and `status === 'ready'`
     * with the playhead at the end, which looks exactly like a staged next
     * track — so without this the stager skips it, the mix fades back into a
     * deck parked on the last sample, and nothing comes out.
     */
    this._spent = new Set();
  }

  /* ------------------------------ queue ------------------------------ */

  setQueue(tracks, { keepPosition = false } = {}) {
    this.queue = (tracks || []).filter(Boolean);
    if (!keepPosition) this.cursor = 0;
    this._deferrals.clear();
    this.onStatus('queue');
  }

  get remainingInQueue() {
    return Math.max(0, this.queue.length - this.cursor);
  }

  _takeNext() {
    if (this.cursor >= this.queue.length) {
      const more = this.refill() || [];
      if (more.length) {
        this.queue = more;
        this.cursor = 0;
      } else if (this.queue.length) {
        this.cursor = 0; // loop the list rather than stopping dead
      } else {
        return null;
      }
    }
    if (this.shuffle && this.queue.length > 1) {
      // Pick at random but never the track that is already live. With harmony
      // on, the random draw becomes a shortlist and the best-fitting of them
      // is taken — still shuffled, just not tone-deaf about it.
      const liveId = this.liveId && this.mixer.decks[this.liveId].track && this.mixer.decks[this.liveId].track.id;
      const shortlist = [];
      for (let i = 0; i < 8; i++) {
        const c = this.queue[Math.floor(Math.random() * this.queue.length)];
        if (c && c.id !== liveId && !shortlist.includes(c)) shortlist.push(c);
      }
      if (!shortlist.length) return this.queue[this.cursor++] || null;
      const chosen = this._harmonicPick(shortlist, 0);
      return shortlist[chosen.index];
    }

    const pick = this._harmonicPick(this.queue, this.cursor);
    const track = this.queue[pick.index] || null;
    if (track && pick.index !== this.cursor) {
      // Move it to the front of what is left rather than dropping the entries
      // it jumped: everything still plays, just in a better order.
      this.queue.splice(pick.index, 1);
      this.queue.splice(this.cursor, 0, track);
    }
    this.cursor++;
    if (track) this._deferrals.delete(track.id);
    return track;
  }

  /**
   * Which of `list` from `from` onward should go next, by key.
   *
   * Falls straight through to the head of the list when harmony is off, when
   * nothing has been analysed yet, or when the live deck's own key is unknown
   * — a guess dressed up as harmonic mixing is worse than plain running order.
   */
  _harmonicPick(list, from) {
    if (!this.harmonic || !this.keys) return { index: from, score: null, relation: '' };
    const live = this.liveDeck;
    if (!live) return { index: from, score: null, relation: '' };
    return pickNextIndex(list, from, {
      liveKey: live.soundingKey,
      liveBpm: live.effectiveBpm || live.bpm || 0,
      keys: this.keys,
      // Reordering can wrap a short queue round onto the record that is
      // playing, which plain list order never could.
      excludeId: (live.track && live.track.id) || '',
      window: this.harmonyWindow,
      deferrals: this._deferrals,
    });
  }

  /* ------------------------------ control ------------------------------ */

  /**
   * Turning Automix on mid-set adopts whatever is already playing rather than
   * restarting from a cold deck, and silences a second running deck so the
   * machine has a clean live/idle pair to work with.
   */
  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.lastError = '';

    const { A, B } = this.mixer.decks;
    const running = [A, B].filter((d) => d.playing && d.status === 'ready');
    if (running.length) {
      const preferred = this.mixer.crossfader <= 0 ? 'A' : 'B';
      const pick = running.find((d) => d.id === preferred) || running[0];
      this.liveId = pick.id;
      this.mixer.setCrossfader(pick.id === 'A' ? -1 : 1);
      this.onCrossfade(this.mixer.crossfader);
      if (!this.allowBoth) for (const d of running) if (d.id !== pick.id) d.pause();
      if (pick.track) {
        this.history.push(pick.track);
        this.onTrack(pick.track);
      }
    }
    this.onStatus('on');
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    // Switching automix off mid-flow must not strand an EQ or a filter where
    // the transition left it — hand the controls back before letting go.
    if (this.fade) this.fade.finish();
    this.fade = null;
    this._coldStart = false;
    this.onStatus('off');
  }

  toggle() {
    this.enabled ? this.stop() : this.start();
  }

  /** Force the transition now instead of waiting for the outro. */
  skip() {
    if (!this.enabled || this.fade) return false;
    const live = this.liveDeck;
    const idle = this.idleDeck;
    if (!live || !idle || idle.status !== 'ready') return false;
    this._beginFade(live, idle, Math.min(this.fadeSeconds, 6));
    return true;
  }

  get liveDeck() {
    return this.liveId ? this.mixer.decks[this.liveId] : null;
  }

  get idleDeck() {
    return this.liveId ? this.mixer.decks[this.liveId === 'A' ? 'B' : 'A'] : this.mixer.decks.A;
  }

  /** Wall-clock seconds left on a deck, i.e. corrected for its tempo. */
  static remainingOf(deck) {
    if (!deck || !deck.duration) return Infinity;
    const rate = Math.max(0.1, Math.abs(deck.nominalRate || 1));
    return (deck.duration - deck.position) / rate;
  }

  get remaining() {
    return Automix.remainingOf(this.liveDeck);
  }

  /* ------------------------------ engine ------------------------------ */

  /**
   * Pull the idle deck onto the live deck's tempo and phase.
   *
   * BPM detection finishes asynchronously after the decode, so at the moment a
   * track is staged its `bpm` is usually still 0. Sync is therefore attempted
   * repeatedly — on load, at the top of the fade, and on every fade tick —
   * until it takes, rather than once at a moment the answer may not exist yet.
   */
  _ensureSync(live, idle) {
    if (!this.syncTempo || !live || !idle) return false;
    if (!idle.bpm || !live.effectiveBpm) return false;
    if (idle.syncedTo === live.id) return true;
    // matchTempoTo, not syncTo: a pair further apart than ±8% is common and
    // must widen the fader rather than silently leaving the decks unmatched.
    //
    // preferKey costs nothing: where a track can be locked to the beat at more
    // than one metrical level — half time, double time, three-halves — those
    // are all exact matches sounding in different keys, so the one that fits
    // the live deck is taken. No tempo accuracy is traded for it.
    if (!idle.matchTempoTo(live, undefined, { preferKey: live.soundingKey })) return false;
    return true;
  }

  /**
   * How the two decks' keys sit right now, and how much they may overlap.
   *
   * Unknown keys are not treated as a clash — most of a first pass through a
   * fresh library is unknown, and refusing to blend any of it would make the
   * mix sound broken to avoid a clash that may not exist.
   */
  _harmonyFor(live, idle) {
    const a = live && live.soundingKey;
    const b = idle && idle.soundingKey;
    if (!a || !b) return { known: false, ok: true, score: null, relation: 'key unknown', maxOverlap: 'full' };
    const c = compatibility(a, b);
    // ok           — blend as long as you like.
    // two steps    — passable in passing, not for thirty-two bars.
    // anything else— the two must not be heard together at all.
    const maxOverlap = c.ok ? 'full' : c.score >= 0.4 ? 'brief' : 'none';
    return { known: true, ok: c.ok, score: c.score, relation: c.relation, maxOverlap, pair: `${a.camelot}→${b.camelot}` };
  }

  async _loadInto(deck, track) {
    this.busy = true;
    this.pending = track;
    this._spent.delete(deck.id);
    this.onStatus('loading');
    try {
      await deck.load(track);
      if (deck.status !== 'ready') {
        this.lastError = deck.error || 'track failed to load';
        this.pending = null;
        // A dead track must not stall the mix — move on to the next one.
        this.onStatus('skip-error');
      }
    } catch (e) {
      this.lastError = e.message || String(e);
      this.pending = null;
    } finally {
      this.busy = false;
      this.onStatus('loaded');
    }
  }

  /**
   * Start a handover.
   *
   * `dur` is the runway available, not the length of the move: the chosen flow
   * declares how many bars it wants and we give it that much if it fits, so a
   * 32-bar blend does not get compressed into six frantic seconds. If the flow
   * is shorter than the runway the transition simply starts later, which is
   * what a person does.
   */
  _beginFade(live, idle, dur, forceKey) {
    this._ensureSync(live, idle);
    // A deck coming off a transition sits at the end of its track. Playing it
    // from there is silence, so rewind to the cue before the fader opens.
    if (idle.position >= idle.duration - 0.25) idle.seek(idle.cuePoint || 0);
    if (!idle.playing) idle.play();

    const runway = Math.max(1, dur);
    // Keys are read after the sync above, because the sync is what decides
    // them: these decks pitch-shift by resampling, so the tempo the incoming
    // deck was just pulled onto IS its key.
    const harmony = this._harmonyFor(live, idle);
    this.harmony = harmony;
    const key = forceKey || pickTransition({
      liveBpm: live.effectiveBpm || live.bpm || 0,
      idleBpm: idle.effectiveBpm || idle.bpm || 0,
      seconds: runway,
      recent: this._recentFlows,
      markedRate: this.markedRate,
      maxOverlap: harmony.maxOverlap,
    });

    const want = minSecondsFor(TRANSITIONS[key] || TRANSITIONS.longBlend, live.effectiveBpm || live.bpm || 0);
    this.fade = new Transition(key, {
      live,
      idle,
      dur: Math.min(runway, want),
      from: this.mixer.crossfader,
      to: idle.id === 'A' ? -1 : 1,
      setXf: (v) => {
        this.mixer.setCrossfader(v);
        this.onCrossfade(v);
      },
    });

    this._recentFlows.push(key);
    if (this._recentFlows.length > 4) this._recentFlows.shift();
    this.lastFlow = key;
    this.onStatus('fading');
  }

  _finishFade(live, idle) {
    // finish() hands back every EQ and filter the flow borrowed. Without it a
    // transition that ends mid-sweep leaves a deck parked under a low-pass.
    this.fade.finish();
    this.mixer.setCrossfader(this.fade.to);
    this.onCrossfade(this.fade.to);
    this.fade = null;
    live.pause();
    this._spent.add(live.id); // its track is done; it needs a fresh one staged
    this.liveId = idle.id;
    if (idle.track) {
      this.history.push(idle.track);
      this.onTrack(idle.track);
    }
    this.pending = null;
    this.onStatus('live');
  }

  tick(dt) {
    if (!this.enabled || this.busy) return;
    const decks = this.mixer.decks;

    // Cold start: nothing is live yet.
    if (!this.liveId) {
      // `busy` is cleared when the load finishes, but `liveId` is not set until
      // the continuation runs a microtask later. A tick landing in that gap
      // used to start a second cold start, which put a track on each deck and
      // played both at once.
      if (this._coldStart) return;
      // Prefer a deck that is genuinely free; B is the fallback so a track the
      // user already has cued on A is not clobbered on the way in.
      const free = !decks.A.track || decks.A.status !== 'ready' ? decks.A : decks.B;
      const track = this._takeNext();
      if (!track) {
        this.onStatus('empty');
        return;
      }
      this._coldStart = true;
      this._loadInto(free, track).then(() => {
        this._coldStart = false;
        if (!this.enabled || free.status !== 'ready') return;
        this.mixer.setCrossfader(free.id === 'A' ? -1 : 1);
        this.onCrossfade(this.mixer.crossfader);
        free.play();
        this.liveId = free.id;
        this.history.push(free.track);
        this.onTrack(free.track);
        this.onStatus('live');
      });
      return;
    }

    const live = this.liveDeck;
    const idle = this.idleDeck;

    // Mid-transition: the flow owns the fader and the EQs until it is done.
    if (this.fade) {
      const done = this.fade.tick(dt);
      this._ensureSync(idle, live) || this._ensureSync(live, idle);
      if (done) this._finishFade(live, idle);
      return;
    }

    if (!live || live.status !== 'ready') return;

    // The live deck ran out (or someone stopped it) — hand over immediately.
    if (!live.playing && live.position >= live.duration - 0.25) {
      if (idle.status === 'ready') {
        this._beginFade(live, idle, 1.5);
      } else {
        this.liveId = null;
      }
      return;
    }

    const left = Automix.remainingOf(live);

    // A second deck left running would block every transition, so it gets
    // stopped rather than skipped over — silently stalling is the worse bug.
    // Unless a blend is deliberately in progress, in which case both playing
    // is the point and the transition below copes with it.
    if (idle.playing && !this.allowBoth) {
      idle.pause();
      return;
    }

    // Stage the next track early: fetching and decoding takes real seconds.
    // A track someone already cued on the idle deck is kept and played next,
    // but one this mix has already played out is not — that is a spent deck.
    const needsTrack = !idle.track || idle.status !== 'ready' || this._spent.has(idle.id);
    if (!this.busy && left < this.preloadLead && needsTrack) {
      const track = this._takeNext();
      if (!track) return;
      // Only advance past a track once it is actually going somewhere;
      // dropping it here would silently eat an entry from the queue.
      if (idle.track && idle.track.id === track.id && !this._spent.has(idle.id)) {
        this._spent.delete(idle.id);
        return;
      }
      this._loadInto(idle, track);
      return;
    }

    // Keep pulling the staged deck onto tempo while it waits — BPM detection
    // usually lands well after the load, and by fade time it must be right.
    this._ensureSync(live, idle);

    // `idle.playing` is deliberately not required: during a blend the next deck
    // is already running, and the transition still has to happen on time.
    if (idle.status === 'ready' && !this._spent.has(idle.id) && left <= this.fadeSeconds) {
      // Never fade longer than what is actually left, or the outro runs out
      // from under the transition.
      this._beginFade(live, idle, Math.min(this.fadeSeconds, Math.max(1.5, left)));
    }
  }

  /**
   * How the next handover's keys look, from where the mix stands right now.
   * During a transition this is the pair the running flow was chosen for;
   * otherwise it is read live off the staged deck, so the bar shows a clash
   * coming rather than only reporting it afterwards.
   */
  get harmonyNow() {
    if (this.fade) return this.harmony;
    const live = this.liveDeck;
    const idle = this.idleDeck;
    if (!live || !idle || idle.status !== 'ready' || this._spent.has(idle.id)) return null;
    return this._harmonyFor(live, idle);
  }

  /** Human-readable state for the UI bar. */
  describe() {
    const harmony = this.enabled ? this.harmonyNow : null;
    const key = harmony && harmony.known
      ? { text: `${harmony.pair} ${harmony.relation}`, ok: harmony.ok }
      : null;
    if (!this.enabled) return { label: 'OFF', detail: '', key: null };
    if (this.busy) return { label: 'LOADING', detail: this.pending ? `${this.pending.artist} – ${this.pending.title}` : '', key };
    if (this.fade) {
      const d = this.fade.describe();
      return { label: d.label.toUpperCase(), detail: `${d.remaining.toFixed(0)} s`, key };
    }
    if (!this.liveId) return { label: 'READY', detail: `${this.remainingInQueue} tracks queued`, key };
    const idle = this.idleDeck;
    const left = this.remaining;
    const next = idle && idle.track ? `${idle.track.artist} – ${idle.track.title}` : 'next track pending';
    const untilFade = Math.max(0, left - this.fadeSeconds);
    return {
      label: 'LIVE',
      detail: `${next} · transition in ${untilFade > 3600 ? '—' : `${Math.round(untilFade)} s`}`,
      key,
    };
  }
}
