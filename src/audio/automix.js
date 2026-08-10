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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Automix {
  /**
   * @param {import('./engine.js').Mixer} mixer
   * @param {object} hooks
   * @param {(v:number)=>void} hooks.onCrossfade  keep the UI fader in step
   * @param {(t:object)=>void} [hooks.onTrack]    a track just went live
   * @param {()=>Array}       [hooks.refill]      called when the queue empties
   * @param {(s:string)=>void}[hooks.onStatus]
   */
  constructor(mixer, { onCrossfade, onTrack, refill, onStatus } = {}) {
    this.mixer = mixer;
    this.onCrossfade = onCrossfade || (() => {});
    this.onTrack = onTrack || (() => {});
    this.refill = refill || (() => []);
    this.onStatus = onStatus || (() => {});

    this.enabled = false;
    this.fadeSeconds = 12;
    this.syncTempo = true;
    this.shuffle = false;

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
    this.fade = null; // { t, dur, from, to }
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
      // Pick at random but never the track that is already live.
      const liveId = this.liveId && this.mixer.decks[this.liveId].track && this.mixer.decks[this.liveId].track.id;
      let pick = null;
      for (let i = 0; i < 8 && !pick; i++) {
        const c = this.queue[Math.floor(Math.random() * this.queue.length)];
        if (c && c.id !== liveId) pick = c;
      }
      return pick || this.queue[this.cursor++];
    }
    return this.queue[this.cursor++] || null;
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
    if (!idle.matchTempoTo(live)) return false;
    return true;
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

  _beginFade(live, idle, dur) {
    this._ensureSync(live, idle);
    // A deck coming off a transition sits at the end of its track. Playing it
    // from there is silence, so rewind to the cue before the fader opens.
    if (idle.position >= idle.duration - 0.25) idle.seek(idle.cuePoint || 0);
    if (!idle.playing) idle.play();
    this.fade = {
      t: 0,
      dur: Math.max(1, dur),
      from: this.mixer.crossfader,
      to: idle.id === 'A' ? -1 : 1,
    };
    this.onStatus('fading');
  }

  _finishFade(live, idle) {
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

    // Mid-transition: ride the crossfader.
    if (this.fade) {
      this.fade.t += dt;
      const k = clamp(this.fade.t / this.fade.dur, 0, 1);
      const v = this.fade.from + (this.fade.to - this.fade.from) * k;
      this.mixer.setCrossfader(v);
      this.onCrossfade(v);
      this._ensureSync(idle, live) || this._ensureSync(live, idle);
      if (k >= 1) this._finishFade(live, idle);
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

  /** Human-readable state for the UI bar. */
  describe() {
    if (!this.enabled) return { label: 'OFF', detail: '' };
    if (this.busy) return { label: 'LOADING', detail: this.pending ? `${this.pending.artist} – ${this.pending.title}` : '' };
    if (this.fade) return { label: 'CROSSFADING', detail: `${Math.max(0, this.fade.dur - this.fade.t).toFixed(0)} s` };
    if (!this.liveId) return { label: 'READY', detail: `${this.remainingInQueue} tracks queued` };
    const idle = this.idleDeck;
    const left = this.remaining;
    const next = idle && idle.track ? `${idle.track.artist} – ${idle.track.title}` : 'next track pending';
    const untilFade = Math.max(0, left - this.fadeSeconds);
    return {
      label: 'LIVE',
      detail: `${next} · transition in ${untilFade > 3600 ? '—' : `${Math.round(untilFade)} s`}`,
    };
  }
}
