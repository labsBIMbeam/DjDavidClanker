/**
 * The transition engine — the part that mixes like a good DJ.
 *
 * A Transition executes ONE handover from a live deck to an idle deck, driven
 * from the automix frame loop. What it encodes:
 *
 *   - the incoming track starts SAMPLE-ACCURATELY on a phrase boundary of the
 *     outgoing deck, entering at its own mix-in point (armStartAt — the same
 *     mechanic as the DROP button, so no vinyl spin-up ramp);
 *   - bass belongs to exactly one deck: the incoming LOW is killed until the
 *     bass-swap phrase, then the two swap over ~0.3 s;
 *   - the crossfader is ridden with a smoothstep ease, not a linear ramp;
 *   - the SYNC latch keeps the phase locked during the overlap;
 *   - after the handover the incoming deck's tempo glides back to 0% — no
 *     cumulative pitch drift across a set;
 *   - the machine yields instantly, surface by surface, when a human touches
 *     a control it is driving (expected-vs-actual comparison).
 *
 * Styles: blend (the above), cut (2-beat swap on the phrase), echo (dub-echo
 * tail masks a tempo jump the sync range cannot fold), fade (the legacy
 * automix crossfade — always the fallback, never removed).
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export const TRANSITION_STYLES = ['auto', 'blend', 'cut', 'echo', 'fade'];

/** Can `idle` reach `targetBpm` with its pitch fader (same folds as syncTo)? */
function syncReachable(idle, targetBpm) {
  if (!idle.bpm || !targetBpm) return false;
  for (const t of [targetBpm, targetBpm * 2, targetBpm / 2, targetBpm * 1.5, targetBpm / 1.5]) {
    const pct = (t / idle.bpm - 1) * 100;
    if (Math.abs(pct) <= idle.tempoRange) return true;
  }
  return false;
}

/**
 * Pure planner: decide the style and the timeline for a live→idle handover.
 * Returns a plan object; style 'fade' means "use the legacy crossfade path".
 * First matching rule wins — every uncertain case degrades to fade.
 */
export function planTransition(live, idle, { style = 'auto', fadeSeconds = 12 } = {}) {
  const reasons = [];
  const fade = (why) => {
    reasons.push(why);
    return { style: 'fade', reasons, fadeSeconds };
  };

  if (live.backend !== 'buffer' || idle.backend !== 'buffer') return fade('basic backend');
  const ls = live.structure;
  const is = idle.structure;
  const liveConf = ls && ls.ok ? ls.confidence : 0;
  const idleConf = is && is.ok ? is.confidence : 0;

  if (!live.bpm || !idle.bpm || !Number.isFinite(live.beatOffset ?? NaN)
    || !syncReachable(idle, live.effectiveBpm)) {
    if (style === 'auto' || style === 'echo') {
      if (liveConf >= 0.35) return planEcho(live, idle, reasons);
    }
    return fade('tempo unreachable and no echo confidence');
  }
  if (style === 'fade') return fade('forced by config');
  if (style === 'echo') return planEcho(live, idle, reasons);
  if (liveConf < 0.35 || idleConf < 0.35) return fade('structure confidence low');

  const endsHot = ls.sections[ls.sections.length - 1].kind !== 'outro';
  if (style === 'cut' || (style === 'auto' && endsHot)) {
    if (endsHot) reasons.push('track ends hot');
    return planCut(live, idle, reasons);
  }
  return planBlend(live, idle, reasons);
}

/** Phrase boundary (in live-track seconds) at or before `sec`, clamped ≥ 0. */
function phraseFloorSec(st, sec) {
  const phraseLen = st.phraseBars * st.barLen;
  const origin = st.firstBar + st.phraseOffset * st.barLen;
  const k = Math.floor((sec - origin) / phraseLen);
  return Math.max(st.firstBar, origin + k * phraseLen);
}

function planBlend(live, idle, reasons) {
  const ls = live.structure;
  const is = idle.structure;
  // The blend ends AT the outgoing mix-out; it starts one phrase earlier
  // (clamped to what is actually left when the plan is made late).
  const endSec = ls.mixOutSec;
  let overlapBars = Math.min(ls.phraseBars, 16); // club default: 16-bar blend
  let startSec = endSec - overlapBars * ls.barLen;
  const minStart = live.position + 2 * ls.barLen;
  if (startSec < minStart) {
    startSec = phraseFloorSec(ls, Math.max(minStart, endSec - overlapBars * ls.barLen));
    while (startSec < minStart) startSec += ls.phraseBars * ls.barLen;
    overlapBars = Math.max(4, Math.round((endSec - startSec) / ls.barLen));
  }
  if (!(startSec < endSec - ls.barLen)) {
    reasons.push('no room left for a blend');
    return { style: 'fade', reasons, fadeSeconds: 6 };
  }
  const swapSec = phraseFloorSec(ls, startSec + ((endSec - startSec) / 2) + ls.barLen / 2);
  return {
    style: 'blend',
    reasons,
    startSec, // on the LIVE deck's timeline
    swapSec: clamp(swapSec, startSec + ls.barLen, endSec - ls.barLen),
    endSec,
    inOffset: idle.cuePoint || is.mixInSec, // a hand-set cue wins over analysis
    overlapBars,
  };
}

function planCut(live, idle, reasons) {
  const ls = live.structure;
  const is = idle.structure;
  const endSec = Math.min(ls.mixOutSec, live.duration - 2);
  const cutSec = Math.max(live.position + 2 * ls.barLen, phraseFloorSec(ls, endSec));
  return {
    style: 'cut',
    reasons,
    startSec: cutSec,
    endSec: cutSec + 2 * (60 / live.effectiveBpm), // 2-beat swap
    inOffset: idle.cuePoint || is.mixInSec,
  };
}

function planEcho(live, idle, reasons) {
  const ls = live.structure && live.structure.ok ? live.structure : null;
  const barLen = ls ? ls.barLen : 4 * (60 / (live.effectiveBpm || 120));
  const cutSec = ls
    ? Math.max(live.position + 2 * barLen, phraseFloorSec(ls, ls.mixOutSec))
    : Math.max(live.position + 2 * barLen, live.duration - 10);
  const is = idle.structure && idle.structure.ok ? idle.structure : null;
  return {
    style: 'echo',
    reasons,
    rampSec: cutSec - barLen, // macro echo rises over the last bar
    startSec: cutSec,
    endSec: cutSec + barLen, // outgoing pauses a bar later so the tail rings
    inOffset: idle.cuePoint || (is ? is.mixInSec : 0),
  };
}

/** Track-time on `live` → absolute ctx wall-clock time. */
function wallTimeAt(live, ctx, sec) {
  const rate = Math.abs(live.currentRate || live.nominalRate) || 1;
  return ctx.currentTime + (sec - live.position) / rate;
}

export class Transition {
  constructor(mixer, live, idle, plan, { onCrossfade, onDone } = {}) {
    this.mixer = mixer;
    this.live = live;
    this.idle = idle;
    this.plan = plan;
    this.onCrossfade = onCrossfade || (() => {});
    this.onDone = onDone || (() => {});

    this.state = 'ARMED';
    this.telemetry = {
      style: plan.style,
      armedAt: 0,
      startedAt: 0,
      swapDoneAt: 0,
      finishedAt: 0,
      rearms: 0,
      yielded: { xf: false, eqLive: false, eqIdle: false, tempo: false },
    };
    this._expected = { xf: null, eqLive: null, eqIdle: null, tempo: null };
    this._liveLowBefore = live.eq.low;
    this._macroBefore = null;
    this._swapT = 0;
    this._releaseFrom = 0;
    this._releaseLeft = 0;

    const ctx = mixer.ctx;
    if (plan.style === 'blend') this.idle.syncTo(live.effectiveBpm);
    if (plan.style === 'blend' || plan.style === 'cut') {
      this.idle.setEq('low', -26); // bass belongs to the live deck until the swap
      this._expected.eqIdle = -26;
    }
    this._arm(ctx);
  }

  _arm(ctx) {
    const when = wallTimeAt(this.live, ctx, this.plan.startSec);
    if (!(when > ctx.currentTime + 0.05)) return; // tick will retry / degrade
    const armed = this.idle.armStartAt(when, this.plan.inOffset, { plannedBy: 'automix' });
    if (armed) {
      this._when = when;
      this.telemetry.armedAt = ctx.currentTime;
    }
  }

  /** Yield a surface for good the moment the human's hand differs from ours. */
  _checkYield(surface, actual) {
    const exp = this._expected[surface];
    if (exp === null || this.telemetry.yielded[surface]) return this.telemetry.yielded[surface];
    const eps = surface === 'xf' ? 0.03 : surface === 'tempo' ? 0.05 : 1;
    if (Math.abs(actual - exp) > eps) this.telemetry.yielded[surface] = true;
    return this.telemetry.yielded[surface];
  }

  _setXf(v) {
    if (this._checkYield('xf', this.mixer.crossfader)) return;
    this.mixer.setCrossfader(v);
    this._expected.xf = this.mixer.crossfader;
    this.onCrossfade(this.mixer.crossfader);
  }

  tick(dt) {
    const ctx = this.mixer.ctx;
    const { plan, live, idle } = this;
    const now = ctx.currentTime;
    const xfTo = idle.id === 'A' ? -1 : 1;

    if (this.state === 'ARMED') {
      if (!this._when) {
        this._arm(ctx);
        if (!this._when && live.position > plan.startSec) {
          // Could not arm in time (seek raced us) — degrade to an instant start.
          idle.play({ instant: true });
          this._when = now;
        }
        return;
      }
      // The host may have been seeked or scratched: re-project the boundary.
      const projected = wallTimeAt(live, ctx, plan.startSec);
      if (Math.abs(projected - this._when) > 0.025 && this._when - now > 0.15) {
        idle.cancelDrop();
        this._when = null;
        this.telemetry.rearms++;
        this._arm(ctx);
        return;
      }
      if (now >= this._when && idle.playing) {
        this.state = 'OVERLAP';
        this.telemetry.startedAt = now;
        this._expected.xf = this.mixer.crossfader;
        if (plan.style === 'blend') idle.setSynced(live); // latch only once audible
        if (plan.style === 'echo') this._beginEchoRamp();
      }
      if (plan.style === 'echo' && live.position >= plan.rampSec) this._rampEcho();
      return;
    }

    if (this.state === 'OVERLAP') {
      const from = plan.style === 'blend' ? plan.startSec : plan.startSec;
      const p = clamp((live.position - from) / Math.max(0.1, plan.endSec - from), 0, 1);
      const ease = plan.style === 'blend' ? smoothstep(p) : p;
      const xfFrom = idle.id === 'A' ? 1 : -1;
      this._setXf(xfFrom + (xfTo - xfFrom) * ease);

      if (plan.style === 'blend' && live.position >= plan.swapSec) this._stepBassSwap(dt);
      if (plan.style === 'echo') this._rampEcho();

      const liveDone = !live.playing && live.position >= live.duration - 0.3;
      if (p >= 1 || liveDone) this._finish(now);
      return;
    }

    if (this.state === 'RELEASE') {
      // Glide the incoming deck's tempo back to 0% over ~4 bars, unless a
      // human moved the fader (expected-vs-actual, like every other surface).
      if (this.telemetry.yielded.tempo) return this._done(now);
      if (Math.abs(idle.tempo - (this._expected.tempo ?? idle.tempo)) > 0.05) {
        this.telemetry.yielded.tempo = true;
        return this._done(now);
      }
      const barWall = (4 * (60 / (idle.effectiveBpm || 120)));
      const step = (Math.abs(this._releaseFrom) * dt) / (4 * barWall);
      const next = idle.tempo > 0 ? Math.max(0, idle.tempo - step) : Math.min(0, idle.tempo + step);
      idle.setTempo(next);
      this._expected.tempo = idle.tempo;
      if (Math.abs(idle.tempo) < 0.05) {
        idle.setTempo(0);
        this._done(now);
      }
    }
  }

  _beginEchoRamp() {
    if (this._macroBefore) return;
    this._macroBefore = { type: this.live.macro.type, value: this.live.macro.value };
    this.live.setMacroType('echo');
  }

  _rampEcho() {
    this._beginEchoRamp();
    const { plan, live } = this;
    const p = clamp((live.position - plan.rampSec) / Math.max(0.1, plan.startSec - plan.rampSec), 0, 1);
    live.setMacroValue(-0.6 * p); // left turn: dub echo over a lowpass
  }

  _stepBassSwap(dt) {
    const stepDb = 26 * (dt / 0.3);
    if (!this._checkYield('eqLive', this.live.eq.low)) {
      this.live.setEq('low', Math.max(-26, this.live.eq.low - stepDb));
      this._expected.eqLive = this.live.eq.low;
    }
    if (!this._checkYield('eqIdle', this.idle.eq.low)) {
      this.idle.setEq('low', Math.min(this._liveLowBefore, this.idle.eq.low + stepDb));
      this._expected.eqIdle = this.idle.eq.low;
    }
    if (this.idle.eq.low >= this._liveLowBefore && !this.telemetry.swapDoneAt) {
      this.telemetry.swapDoneAt = this.mixer.ctx.currentTime;
    }
  }

  _finish(now) {
    const { plan, live, idle } = this;
    this._setXf(idle.id === 'A' ? -1 : 1);
    if (plan.style === 'echo') {
      // Leave the graph connected; the dub tail rings out of the paused deck.
      live.pause();
      setTimeout(() => {
        live.setMacroValue(this._macroBefore ? this._macroBefore.value : 0);
        if (this._macroBefore) live.setMacroType(this._macroBefore.type);
      }, 3000);
    } else {
      live.pause();
    }
    if (!this.telemetry.yielded.eqLive) live.setEq('low', this._liveLowBefore);
    if (!this.telemetry.yielded.eqIdle) idle.setEq('low', this._liveLowBefore);
    idle.setSynced(null);
    this.telemetry.finishedAt = now;

    if (plan.style === 'blend' && Math.abs(idle.tempo) >= 0.05) {
      this.state = 'RELEASE';
      this._releaseFrom = idle.tempo;
      this._expected.tempo = idle.tempo;
    } else {
      this._done(now);
    }
  }

  _done(now) {
    if (this.state === 'DONE') return;
    this.state = 'DONE';
    if (!this.telemetry.finishedAt) this.telemetry.finishedAt = now;
    this.onDone(this.telemetry);
  }

  cancel() {
    if (this.idle._drop && this.idle._drop.plannedBy === 'automix') this.idle.cancelDrop();
    this.idle.setSynced(null);
    this._done(this.mixer.ctx ? this.mixer.ctx.currentTime : 0);
  }
}
