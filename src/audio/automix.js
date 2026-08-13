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

import { planTransition, Transition } from './transition.js';
import { scoreCandidate, summaryFor } from './selection.js';
import { trackCacheId } from '../lib/analysiscache.js';

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
    /**
     * Track order: 'list' plays the queue as-is, 'shuffle' draws randomly,
     * 'smart' scores candidates on key/BPM/energy continuity against the
     * live deck (cached analysis; a cold cache degrades to list order).
     */
    this.order = 'smart';
    /** 'auto' | 'blend' | 'cut' | 'echo' | 'fade' — what the planner may pick. */
    this.transitionStyle = 'auto';
    /** Off = always the legacy crossfade, whatever the analysis says. */
    this.phraseAlign = true;

    /**
     * How early to start loading the next track, measured to the point the
     * NEXT transition needs it — the live deck's mix-out when structure is
     * known, the track end otherwise. A 16-bar blend at 124 BPM plus two bars
     * of arm lead is ~35 s, and load+analysis costs seconds on top: 45 keeps
     * a full phrase of headroom. (Measured to the raw end, 35 systematically
     * starved every track with a real outro into the fade fallback.)
     */
    this.preloadLead = 45;

    this.queue = [];
    this.cursor = 0;
    this.history = [];

    this.liveId = null; // 'A' | 'B'
    this.fade = null; // { t, dur, from, to } — the legacy crossfade
    this.plan = null; // planTransition() result for the staged idle deck
    this.transition = null; // a running Transition instance
    this.lastTransition = null; // telemetry of the last completed one
    /**
     * Seam budget (idea from PR #8): the share of auto handovers allowed an
     * audible style (cut/echo/spinback) instead of an invisible blend. The
     * last two seams are remembered so the same move never comes round twice.
     */
    this.markedRate = 0.25;
    this._recentFlows = [];
    this.busy = false; // a load is in flight
    this.pending = null; // track staged on the idle deck
    this.lastError = '';
    this._planTempo = 0;
    this._lastLivePos = 0;

    /**
     * The deck that just handed over. It still holds its played-out track at
     * status 'ready', which is indistinguishable from a deck a human cued on
     * purpose — and the preload below deliberately keeps those. Without this
     * marker the mix ping-pongs between the same two tracks forever.
     */
    this.staleId = null;
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

  /** Kept for callers of the old boolean API. */
  get shuffle() {
    return this.order === 'shuffle';
  }

  set shuffle(v) {
    this.order = v ? 'shuffle' : 'list';
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
    if (this.order === 'smart') {
      const pick = this._takeSmart();
      if (pick) return pick;
    }
    if (this.order === 'shuffle' && this.queue.length > 1) {
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

  /**
   * Choose the best continuation among the next candidates. Highest score
   * wins, ties go to the earlier queue position — so with nothing analyzed
   * every score is identical and this IS list order.
   */
  _takeSmart() {
    const live = this.liveDeck;
    if (!live || !live.bpm) return null; // cold start: the list head is fine
    const liveSummary = {
      bpm: live.bpm,
      camelot: live.musicalKey ? live.musicalKey.camelot : '',
      energyOut: live.structure && live.structure.ok ? live.structure.energyOut : NaN,
    };
    const recent = this.history.slice(-20).map((t) => t.id);
    let bestIdx = -1;
    let bestScore = -Infinity;
    const window = Math.min(12, this.queue.length - this.cursor);
    for (let i = 0; i < window; i++) {
      const cand = this.queue[this.cursor + i];
      if (!cand) continue;
      const s = scoreCandidate(liveSummary, summaryFor(cand), recent, trackCacheId(cand));
      if (s > bestScore + 1e-9) {
        bestScore = s;
        bestIdx = this.cursor + i;
      }
    }
    if (bestIdx < 0) return null;
    const [pick] = this.queue.splice(bestIdx, 1);
    return pick || null;
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
    if (this.transition) {
      this.transition.cancel();
      this.transition = null;
    }
    this.plan = null;
    this.onStatus('off');
  }

  toggle() {
    this.enabled ? this.stop() : this.start();
  }

  /** Force the transition now instead of waiting for the outro. */
  skip() {
    if (!this.enabled || this.fade || this.transition) return false;
    const live = this.liveDeck;
    const idle = this.idleDeck;
    if (!live || !idle || idle.status !== 'ready') return false;
    this.plan = null; // a forced skip is a quick fade, not a planned blend
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
    if (this.staleId === deck.id) this.staleId = null; // it's being refilled
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
    if (this.syncTempo && idle.bpm && live.effectiveBpm) idle.syncTo(live);
    // instant: a programmed entrance must not carry the vinyl spin-up ramp.
    if (!idle.playing) idle.play({ instant: true });
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
    this._completeHandover(live, idle);
  }

  /** Bookkeeping shared by the legacy fade and the transition engine. */
  _completeHandover(live, idle) {
    this.staleId = live.id; // played out — free to be refilled
    this.liveId = idle.id;
    if (idle.track) {
      this.history.push(idle.track);
      this.onTrack(idle.track);
    }
    this.pending = null;
    this.plan = null;
    this.onStatus('live');
  }

  tick(dt) {
    if (!this.enabled || this.busy) return;
    const decks = this.mixer.decks;

    // Cold start: nothing is live yet. Prefer an empty deck so a track a
    // human cued by hand survives; fall back to A when both are occupied.
    if (!this.liveId) {
      const free = !decks.A.track ? decks.A : (!decks.B.track ? decks.B : decks.A);
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

    // A running Transition owns both decks and the crossfader.
    if (this.transition) {
      this.transition.tick(dt);
      return;
    }

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
    // A track someone already cued on the idle deck is kept and played next —
    // unless this deck is the one that just handed over, whose track has
    // already been played (see `staleId`). The lead is measured to where the
    // next transition actually starts: the mix-out point, not the track end.
    const stale = this.staleId === idle.id;
    const rate = Math.max(0.1, Math.abs(live.nominalRate || 1));
    const stageLeft = this.phraseAlign && live.structure && live.structure.ok
      ? Math.min(left, Math.max(0, live.structure.mixOutSec - live.position) / rate)
      : left;
    if (!this.busy && stageLeft < this.preloadLead && (stale || !idle.track || idle.status !== 'ready')) {
      const track = this._takeNext();
      if (track && (stale || !idle.track || idle.track.id !== track.id)) this._loadInto(idle, track);
      return;
    }

    const idleStaged = idle.status === 'ready' && !idle.playing && !stale && idle.track;

    // Plan a phrase-aligned transition once the staged deck is analyzed. A
    // user-armed DROP on the idle deck means a human prepared this handover —
    // the machine stays on the legacy fader ride and out of the way.
    const userDrop = idle._drop && idle._drop.plannedBy === 'user';
    if (this.plan) {
      // Invalidate on a seek or a tempo grab — the timeline moved under us.
      if (Math.abs(live.position - this._lastLivePos) > 3
        || Math.abs(live.tempo - this._planTempo) > 0.5
        || live.position > this.plan.endSec) {
        this.plan = null;
      }
    }
    this._lastLivePos = live.position;
    if (!this.plan && this.phraseAlign && idleStaged && idle._analysisDone && !userDrop) {
      this.plan = planTransition(live, idle, {
        style: this.transitionStyle, fadeSeconds: this.fadeSeconds,
        markedRate: this.markedRate, recentFlows: this._recentFlows,
      });
      this._planTempo = live.tempo;
      this.onStatus('plan');
    }

    if (this.plan && this.plan.style !== 'fade' && idleStaged) {
      // Construct two live-bars ahead of the scheduled start, so the arm has
      // comfortable lead and the drift re-check has something to work with.
      const barTrack = 4 * (60 / (live.bpm || 120));
      if (live.position >= this.plan.startSec - 2 * barTrack) {
        this.transition = new Transition(this.mixer, live, idle, this.plan, {
          onCrossfade: this.onCrossfade,
          onDone: (telemetry) => {
            this.lastTransition = telemetry;
            if (['cut', 'echo', 'spinback'].includes(telemetry.style)) {
              this._recentFlows.push(telemetry.style);
              if (this._recentFlows.length > 2) this._recentFlows.shift();
            }
            this.transition = null;
            this._completeHandover(live, idle);
          },
        });
        this.onStatus('transition');
      }
      return;
    }

    if (idleStaged && left <= this.fadeSeconds) {
      // Never fade longer than what is actually left, or the outro runs out
      // from under the transition.
      this._beginFade(live, idle, Math.min(this.fadeSeconds, Math.max(1.5, left)));
    }
  }

  /** Human-readable state for the UI bar. */
  describe() {
    if (!this.enabled) return { label: 'OFF', detail: '' };
    if (this.busy) return { label: 'LOADING', detail: this.pending ? `${this.pending.artist} – ${this.pending.title}` : '' };
    if (this.transition) {
      return {
        label: this.transition.telemetry.style.toUpperCase(),
        detail: this.transition.state === 'RELEASE' ? 'releasing tempo' : 'riding the phrase',
      };
    }
    if (this.fade) return { label: 'CROSSFADING', detail: `${Math.max(0, this.fade.dur - this.fade.t).toFixed(0)} s` };
    if (!this.liveId) return { label: 'READY', detail: `${this.remainingInQueue} tracks queued` };
    const live = this.liveDeck;
    const idle = this.idleDeck;
    const next = idle && idle.track ? `${idle.track.artist} – ${idle.track.title}` : 'next track pending';
    if (this.plan && this.plan.style !== 'fade' && live) {
      const rate = Math.abs(live.nominalRate) || 1;
      const until = Math.max(0, (this.plan.startSec - live.position) / rate);
      const keys = live.musicalKey && idle && idle.musicalKey
        ? ` · ${live.musicalKey.camelot}→${idle.musicalKey.camelot}` : '';
      return {
        label: 'LIVE',
        detail: `${next} · ${this.plan.style.toUpperCase()} in ${until > 3600 ? '—' : `${Math.round(until)} s`}${keys}`,
      };
    }
    const untilFade = Math.max(0, this.remaining - this.fadeSeconds);
    return {
      label: 'LIVE',
      detail: `${next} · transition in ${untilFade > 3600 ? '—' : `${Math.round(untilFade)} s`}`,
    };
  }
}
