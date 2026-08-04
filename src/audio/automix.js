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
      for (const d of running) if (d.id !== pick.id) d.pause();
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

  async _loadInto(deck, track) {
    this.busy = true;
    this.pending = track;
    this.onStatus('loading');
    try {
      await deck.load(track);
      if (deck.status !== 'ready') {
        this.lastError = deck.error || 'Track nicht ladbar';
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
    if (this.syncTempo && idle.bpm && live.effectiveBpm) idle.syncTo(live);
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
      const free = decks.A.status === 'ready' && !decks.A.playing ? decks.A : decks.A;
      const track = this._takeNext();
      if (!track) {
        this.onStatus('empty');
        return;
      }
      this._loadInto(free, track).then(() => {
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
    if (idle.playing) {
      idle.pause();
      return;
    }

    // Stage the next track early: fetching and decoding takes real seconds.
    // A track someone already cued on the idle deck is kept and played next.
    if (!this.busy && left < this.preloadLead && (!idle.track || idle.status !== 'ready')) {
      const track = this._takeNext();
      if (track && (!idle.track || idle.track.id !== track.id)) this._loadInto(idle, track);
      return;
    }

    if (idle.status === 'ready' && !idle.playing && left <= this.fadeSeconds) {
      // Never fade longer than what is actually left, or the outro runs out
      // from under the transition.
      this._beginFade(live, idle, Math.min(this.fadeSeconds, Math.max(1.5, left)));
    }
  }

  /** Human-readable state for the UI bar. */
  describe() {
    if (!this.enabled) return { label: 'AUS', detail: '' };
    if (this.busy) return { label: 'LADEN', detail: this.pending ? `${this.pending.artist} – ${this.pending.title}` : '' };
    if (this.fade) return { label: 'ÜBERBLENDEN', detail: `${Math.max(0, this.fade.dur - this.fade.t).toFixed(0)} s` };
    if (!this.liveId) return { label: 'BEREIT', detail: `${this.remainingInQueue} Tracks in der Liste` };
    const idle = this.idleDeck;
    const left = this.remaining;
    const next = idle && idle.track ? `${idle.track.artist} – ${idle.track.title}` : 'nächster Track folgt';
    const untilFade = Math.max(0, left - this.fadeSeconds);
    return {
      label: 'LÄUFT',
      detail: `${next} · Übergang in ${untilFade > 3600 ? '—' : `${Math.round(untilFade)} s`}`,
    };
  }
}
