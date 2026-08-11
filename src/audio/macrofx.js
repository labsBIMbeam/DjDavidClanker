import { Gater } from './fx.js';

/**
 * Macro FX — Traktor-style "Mixer FX" / Pioneer "Color FX": ONE bipolar knob
 * per channel that drives a curated combination of effect parameters plus a
 * sweep filter. Centre is a hard bypass detent; turning left blends the
 * effect in over a lowpass sweep, turning right over a highpass sweep. The
 * point of the macro is the tuning: every knob position is a combination
 * someone would actually play, which is why one knob sounds better than five.
 *
 * Sits after the insert FX chain and before the channel gain, so the cue bus
 * hears it and the crossfader does not change its character.
 *
 * Types:
 *   echo    ping-pong dub delay, dotted-eighth synced, darkened feedback
 *   space   plate-style convolution reverb with progressive damping
 *   noise   filtered white-noise riser (up on the right, down on the left)
 *   gate    1/16 tempo gate, depth on the knob
 *   barber  barber-pole flanger: two crossfaded voices whose comb notches
 *           sweep forever upward (right) or downward (left)
 */

export const MACRO_TYPES = ['echo', 'space', 'noise', 'gate', 'barber'];

export const MACRO_LABELS = {
  echo: 'DUB ECHO',
  space: 'SPACE',
  noise: 'NOISE',
  gate: 'GATE',
  barber: 'BARBER',
};

const DETENT = 0.06; // |value| below this is a hard bypass
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class MacroFX {
  constructor(ctx) {
    this.ctx = ctx;
    this.type = 'echo';
    this.value = 0;
    this.bpm = 120;

    /* Fixed skeleton: input → gate → dry → sum; input → wetIn → (type
       chain) → wetOut → sum; sum → sweep → output. The gate unit doubles as
       the dry path — transparent unless the GATE macro drives it. */
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.gate = new Gater(ctx);
    this.dry = ctx.createGain();
    this.wetIn = ctx.createGain();
    this.wetOut = ctx.createGain();
    this.sum = ctx.createGain();
    this.sweep = ctx.createBiquadFilter();
    this.sweep.type = 'lowpass';
    this.sweep.frequency.value = 22050;
    this.sweep.Q.value = 0.7;

    this.input.connect(this.gate.input);
    this.gate.output.connect(this.dry).connect(this.sum);
    this.input.connect(this.wetIn);
    this.wetOut.connect(this.sum);
    this.sum.connect(this.sweep).connect(this.output);

    this.wetIn.gain.value = 1;
    this.wetOut.gain.value = 0;

    /* Generated once, reused across type switches. */
    this._impulse = this._buildImpulse(3.2);
    this._noiseBuf = this._buildNoise(2);

    this._chain = [];
    this._noiseSrc = null;
    this._voices = null;
    this._dirUp = true;
    this._buildChain();
  }

  /* ------------------------- generated buffers ------------------------- */

  /** Stereo plate-style impulse: exponential decay with progressive damping
      (a one-pole lowpass that closes along the tail, like air absorption). */
  _buildImpulse(seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        const a = 0.12 + 0.8 * (i / len); // smoother (darker) later in the tail
        lp += (white - lp) * (1 - a);
        d[i] = lp * Math.pow(10, (-3 * i) / len) * 2.4;
      }
    }
    return buf;
  }

  _buildNoise(seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ------------------------------ chains ------------------------------ */

  _teardownChain() {
    for (const node of this._chain) {
      try { node.disconnect(); } catch { /* already gone */ }
    }
    if (this._noiseSrc) {
      try { this._noiseSrc.stop(); } catch { /* never started */ }
      this._noiseSrc = null;
    }
    this._voices = null;
    this._chain = [];
    this.gate.setEnabled(false);
    this.wetOut.gain.cancelScheduledValues(this.ctx.currentTime);
    this.wetOut.gain.value = 0;
  }

  _buildChain() {
    const ctx = this.ctx;
    this._teardownChain();

    if (this.type === 'echo') {
      // Ping-pong: two cross-coupled delays, dub tone shaping in the loop.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 150;
      const dA = ctx.createDelay(4);
      const dB = ctx.createDelay(4);
      const toneA = ctx.createBiquadFilter();
      const toneB = ctx.createBiquadFilter();
      for (const t of [toneA, toneB]) { t.type = 'lowpass'; t.frequency.value = 2600; }
      const fbA = ctx.createGain();
      const fbB = ctx.createGain();
      fbA.gain.value = 0;
      fbB.gain.value = 0;
      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.value = -0.55;
      panR.pan.value = 0.55;

      this.wetIn.connect(hp).connect(dA);
      dA.connect(toneA).connect(fbA).connect(dB);
      dB.connect(toneB).connect(fbB).connect(dA);
      dA.connect(panL).connect(this.wetOut);
      dB.connect(panR).connect(this.wetOut);

      this._echo = { dA, dB, fbA, fbB };
      this._chain = [hp, dA, dB, toneA, toneB, fbA, fbB, panL, panR];
    } else if (this.type === 'space') {
      const pre = ctx.createDelay(0.05);
      pre.delayTime.value = 0.018;
      const conv = ctx.createConvolver();
      conv.buffer = this._impulse;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 6500;
      this.wetIn.connect(pre).connect(conv).connect(damp).connect(this.wetOut);
      this._space = { conv, damp };
      this._chain = [pre, conv, damp];
    } else if (this.type === 'noise') {
      // Self-generating: the riser is audible with the channel open even
      // before the track plays — that is the Pioneer NOISE behaviour.
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 0.85;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.wetOut);
      src.start();
      this._noiseSrc = src;
      this._noise = { bp, g };
      this._chain = [bp, g];
    } else if (this.type === 'barber') {
      // Two flanger voices with triangle windows at 50% offset (their sum is
      // exactly 1). Each voice sweeps its delay across the whole range inside
      // its window, so the comb notches appear to climb forever.
      const voices = [0, 1].map(() => {
        const delay = ctx.createDelay(0.05);
        delay.delayTime.value = 0.004;
        const win = ctx.createGain();
        win.gain.value = 0;
        const fb = ctx.createGain();
        fb.gain.value = 0;
        this.wetIn.connect(delay);
        delay.connect(win).connect(this.wetOut);
        delay.connect(fb).connect(delay);
        return { delay, win, fb, next: 0 };
      });
      this._voices = voices;
      this._chain = voices.flatMap((v) => [v.delay, v.win, v.fb]);
      this._anchorBarber();
    }
    // 'gate' needs no wet chain — it drives the dry-path gater directly.

    this._applyValue();
  }

  _anchorBarber() {
    const T = MacroFX.BARBER_PERIOD;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this._voices.length; i++) {
      const v = this._voices[i];
      v.delay.delayTime.cancelScheduledValues(now);
      v.win.gain.cancelScheduledValues(now);
      v.win.gain.setValueAtTime(0, now + 0.01);
      v.next = now + 0.02 + (i * T) / 2;
    }
  }

  /* ------------------------------ control ------------------------------ */

  setType(type) {
    if (!MACRO_TYPES.includes(type) || type === this.type) return;
    this.type = type;
    this._buildChain();
  }

  setValue(v) {
    const prev = this.value;
    this.value = clamp(v, -1, 1);
    if (this.type === 'barber' && Math.sign(this.value) !== Math.sign(prev)
      && Math.abs(this.value) >= DETENT && this._voices) {
      this._dirUp = this.value > 0;
      this._anchorBarber();
    }
    this._applyValue();
  }

  _applyValue() {
    const t = this.ctx.currentTime;
    const v = Math.abs(this.value) < DETENT ? 0 : this.value;
    const x = Math.abs(v);

    // Sweep filter on the summed signal: LP down on the left, HP up on the
    // right, transparent at the detent.
    if (v < 0) {
      this.sweep.type = 'lowpass';
      this.sweep.frequency.setTargetAtTime(22050 * Math.pow(140 / 22050, Math.pow(x, 1.1)), t, 0.02);
      this.sweep.Q.setTargetAtTime(0.9, t, 0.02);
    } else if (v > 0) {
      this.sweep.type = 'highpass';
      this.sweep.frequency.setTargetAtTime(20 * Math.pow(3600 / 20, Math.pow(x, 1.1)), t, 0.02);
      this.sweep.Q.setTargetAtTime(0.9, t, 0.02);
    } else {
      this.sweep.type = 'lowpass';
      this.sweep.frequency.setTargetAtTime(22050, t, 0.02);
      this.sweep.Q.setTargetAtTime(0.7, t, 0.02);
    }

    const wet = this.wetOut.gain;
    const dry = this.dry.gain;

    if (this.type === 'echo' && this._echo) {
      wet.setTargetAtTime(0.62 * Math.pow(x, 0.85), t, 0.03);
      dry.setTargetAtTime(1, t, 0.03);
      const fb = x ? clamp(0.3 + 0.55 * x, 0, 0.85) : 0;
      this._echo.fbA.gain.setTargetAtTime(fb, t, 0.05);
      this._echo.fbB.gain.setTargetAtTime(fb, t, 0.05);
    } else if (this.type === 'space' && this._space) {
      wet.setTargetAtTime(0.75 * Math.pow(x, 1.15), t, 0.03);
      dry.setTargetAtTime(1 - 0.25 * x, t, 0.03);
      this._space.damp.frequency.setTargetAtTime(6500 - 3500 * x, t, 0.03);
    } else if (this.type === 'noise' && this._noise) {
      wet.setTargetAtTime(1, t, 0.03); // level lives on the noise gain
      dry.setTargetAtTime(1, t, 0.03);
      this._noise.g.gain.setTargetAtTime(0.4 * Math.pow(x, 1.7), t, 0.03);
      // Right: riser sweeping up. Left: falling sweep.
      const freq = v > 0 ? 500 * Math.pow(16, x) : v < 0 ? 2600 * Math.pow(0.08, x) : 1200;
      this._noise.bp.frequency.setTargetAtTime(freq, t, 0.05);
    } else if (this.type === 'gate') {
      wet.setTargetAtTime(0, t, 0.03);
      dry.setTargetAtTime(1, t, 0.03);
      const wantOn = x > 0;
      if (wantOn !== this.gate.on) this.gate.setEnabled(wantOn);
      if (wantOn) {
        this.gate.set({ division: 0.25, duty: 0.55, depth: Math.min(1, x * 1.15), smooth: 0.3, bpm: this.bpm });
      }
    } else if (this.type === 'barber' && this._voices) {
      wet.setTargetAtTime(0.55 * Math.pow(x, 0.9), t, 0.03);
      dry.setTargetAtTime(1 - 0.2 * x, t, 0.03);
      const fb = x ? 0.12 + 0.3 * x : 0;
      for (const voice of this._voices) voice.fb.gain.setTargetAtTime(fb, t, 0.05);
    }
  }

  /** Frame-loop driver: tempo sync and look-ahead automation. */
  tick(bpm) {
    if (bpm > 20) this.bpm = bpm;
    const active = Math.abs(this.value) >= DETENT;

    if (this.type === 'echo' && this._echo) {
      const secs = clamp((60 / this.bpm) * 0.75, 0.06, 2.5); // dotted eighth
      const t = this.ctx.currentTime;
      this._echo.dA.delayTime.setTargetAtTime(secs, t, 0.08);
      this._echo.dB.delayTime.setTargetAtTime(secs, t, 0.08);
    } else if (this.type === 'gate') {
      if (this.gate.on) this.gate.set({ bpm: this.bpm });
      this.gate.tick();
    } else if (this.type === 'barber' && this._voices && active) {
      this._tickBarber();
    }
  }

  _tickBarber() {
    const T = MacroFX.BARBER_PERIOD;
    const now = this.ctx.currentTime;
    const [d0, d1] = this._dirUp ? [0.0072, 0.0008] : [0.0008, 0.0072];
    for (const v of this._voices) {
      if (v.next < now - T) v.next = now + 0.02; // fell behind (hidden tab)
      let guard = 0;
      while (v.next < now + 0.9 && guard++ < 4) {
        const s = v.next;
        v.delay.delayTime.setValueAtTime(d0, s);
        v.delay.delayTime.linearRampToValueAtTime(d1, s + T);
        v.win.gain.setValueAtTime(0, s);
        v.win.gain.linearRampToValueAtTime(1, s + T / 2);
        v.win.gain.linearRampToValueAtTime(0, s + T);
        v.next = s + T;
      }
    }
  }

  dispose() {
    this._teardownChain();
  }
}

MacroFX.BARBER_PERIOD = 2.8;
