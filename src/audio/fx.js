/**
 * Per-deck insert FX: flanger, phaser, gater, echo, reverb.
 *
 * All sit between the filter and the channel gain, so they are affected by EQ
 * and filter but not by the crossfader — the same place a hardware insert sits.
 * Each is fully bypassable; when off, a unit's wet path is silent and any
 * automation is cancelled, so an unused unit costs nothing but a few idle
 * nodes. The deck exposes two "slots" that pick which units the FX buttons
 * drive — the audio chain itself is fixed-order and always present.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Classic feedback flanger: a short modulated delay summed with the dry signal.
 * Sweeping 1–10 ms produces the moving comb notches; feedback sharpens them.
 */
export class Flanger {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 0.35; // Hz
    this.depth = 0.0022; // seconds of sweep
    this.feedback = 0.55;
    this.mix = 0.6;
    this.baseDelay = 0.0035;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(0.05);
    this.fb = ctx.createGain();
    this.lfo = ctx.createOscillator();
    this.lfoDepth = ctx.createGain();

    this.delay.delayTime.value = this.baseDelay;
    this.fb.gain.value = 0;
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this.rate;
    this.lfoDepth.gain.value = this.depth;

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wet).connect(this.output);
    this.delay.connect(this.fb).connect(this.delay);
    this.lfo.connect(this.lfoDepth).connect(this.delay.delayTime);
    this.lfo.start();
  }

  setEnabled(on) {
    this.on = Boolean(on);
    this._apply();
  }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.02, 8);
    if (params.depth !== undefined) this.depth = clamp(params.depth, 0, 0.006);
    if (params.feedback !== undefined) this.feedback = clamp(params.feedback, 0, 0.92);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    // Equal-power-ish blend so switching the unit in does not jump in level.
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.5, t, 0.02);
    this.fb.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.02);
    this.lfo.frequency.setTargetAtTime(this.rate, t, 0.02);
    this.lfoDepth.gain.setTargetAtTime(this.depth, t, 0.02);
  }

  dispose() {
    try {
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
  }
}

/**
 * Tempo-synced gater.
 *
 * A plain gain node whose automation is scheduled a short way ahead of the
 * clock, in beat divisions taken from the deck's own BPM. Scheduling ahead
 * (rather than toggling from a timer) is what keeps the edges sample-accurate
 * and immune to main-thread jitter.
 */
export class Gater {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.division = 0.5; // beats per gate cycle: 1 = 1/4 note, 0.5 = 1/8, ...
    this.duty = 0.5; // fraction of the cycle the gate is open
    this.depth = 1; // 1 = fully closed between hits
    this.smooth = 0.25; // 0 = hard chop, 1 = triangle
    this.bpm = 120;

    this.input = ctx.createGain();
    this.gain = ctx.createGain();
    this.output = this.gain;
    this.input.connect(this.gain);

    this._next = 0;
  }

  setEnabled(on) {
    this.on = Boolean(on);
    const p = this.gain.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    if (!this.on) {
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(1, now + 0.02);
    } else {
      this._next = now + 0.02;
    }
  }

  set(params = {}) {
    let dirty = false;
    for (const k of ['division', 'duty', 'depth', 'smooth', 'bpm']) {
      if (params[k] !== undefined && params[k] !== this[k]) {
        this[k] = params[k];
        dirty = true;
      }
    }
    this.duty = clamp(this.duty, 0.05, 0.95);
    this.depth = clamp(this.depth, 0, 1);
    this.smooth = clamp(this.smooth, 0, 1);
    if (dirty && this.on) this._reschedule();
  }

  _reschedule() {
    const now = this.ctx.currentTime;
    const p = this.gain.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    this._next = now + 0.02;
  }

  /** Called from the frame loop; fills the automation queue ~0.4 s ahead. */
  tick() {
    if (!this.on) return;
    const now = this.ctx.currentTime;
    const bpm = this.bpm > 20 ? this.bpm : 120;
    const period = (60 / bpm) * this.division;
    if (!(period > 0.01)) return;

    if (this._next < now) this._next = now + 0.01;
    const p = this.gain.gain;
    const closed = 1 - this.depth;
    const edge = Math.max(0.0015, period * 0.25 * this.smooth);

    let guard = 0;
    while (this._next < now + 0.4 && guard++ < 64) {
      const openAt = this._next;
      const closeAt = openAt + period * this.duty;
      if (edge <= 0.002) {
        p.setValueAtTime(1, openAt);
        p.setValueAtTime(closed, closeAt);
      } else {
        p.setValueAtTime(closed, openAt);
        p.linearRampToValueAtTime(1, openAt + edge);
        p.setValueAtTime(1, Math.max(openAt + edge, closeAt - edge));
        p.linearRampToValueAtTime(closed, closeAt);
      }
      this._next = openAt + period;
    }
  }
}

/**
 * Four-stage allpass phaser. The LFO sweeps all stage frequencies together;
 * feedback from the last stage into the first deepens the notches.
 */
export class Phaser {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 0.4; // Hz
    this.depth = 0.7; // 0..1 of the sweep range
    this.feedback = 0.35;
    this.mix = 0.7;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.fb = ctx.createGain();

    this.stages = [350, 700, 1100, 1600].map((f) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = f;
      ap.Q.value = 0.6;
      return ap;
    });

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this.rate;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;

    this.input.connect(this.dry).connect(this.output);
    let node = this.input;
    for (const ap of this.stages) {
      node.connect(ap);
      node = ap;
      this.lfo.connect(this.lfoDepth).connect(ap.frequency);
    }
    node.connect(this.wet).connect(this.output);
    node.connect(this.fb).connect(this.stages[0]);

    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.fb.gain.value = 0;
    this.lfo.start();
  }

  setEnabled(on) {
    this.on = Boolean(on);
    this._apply();
  }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.02, 8);
    if (params.depth !== undefined) this.depth = clamp(params.depth, 0, 1);
    if (params.feedback !== undefined) this.feedback = clamp(params.feedback, 0, 0.9);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.5, t, 0.02);
    this.fb.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.02);
    this.lfo.frequency.setTargetAtTime(this.rate, t, 0.02);
    // Sweep amplitude in Hz around each stage's base frequency.
    this.lfoDepth.gain.setTargetAtTime(this.on ? this.depth * 550 : 0, t, 0.02);
  }

  dispose() {
    try {
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
  }
}

/**
 * Tempo-synced feedback delay. `division` is in beats (0.5 = 1/8 note); the
 * deck feeds the live BPM in from its tick, like the gater. A lowpass in the
 * feedback loop darkens each repeat the way an analog echo does.
 */
export class Echo {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.division = 0.5; // beats per repeat
    this.feedback = 0.45;
    this.mix = 0.5;
    this.bpm = 120;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.fb = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 4500;

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.wet).connect(this.output);
    this.delay.connect(this.tone).connect(this.fb).connect(this.delay);

    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.fb.gain.value = 0;
    this._applyTime();
  }

  setEnabled(on) {
    this.on = Boolean(on);
    this._apply();
  }

  set(params = {}) {
    if (params.division !== undefined) this.division = clamp(params.division, 0.125, 2);
    if (params.feedback !== undefined) this.feedback = clamp(params.feedback, 0, 0.85);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    if (params.bpm !== undefined) this.bpm = clamp(params.bpm, 40, 220);
    this._applyTime();
    this._apply();
  }

  _applyTime() {
    const secs = clamp((60 / (this.bpm || 120)) * this.division, 0.02, 3.8);
    // Glide, don't jump: a hard delayTime step would click on every BPM tick.
    this.delay.delayTime.setTargetAtTime(secs, this.ctx.currentTime, 0.08);
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.35, t, 0.02);
    // Feedback stays live only while on, so the tail dies out on bypass.
    this.fb.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.05);
  }
}

/**
 * Convolution reverb on a generated exponential-decay noise impulse — no
 * sample assets, which matters in a single-file napplet.
 */
export class Reverb {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.decay = 1.6; // seconds
    this.tone = 5000; // lowpass on the wet path
    this.mix = 0.35;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = this.tone;

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.conv).connect(this.lp).connect(this.wet).connect(this.output);

    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this._impulseFor = 0;
    this._buildImpulse();
  }

  _buildImpulse() {
    if (Math.abs(this._impulseFor - this.decay) < 0.05) return;
    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * this.decay));
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        // -60 dB by the end of the tail.
        d[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * i) / len);
      }
    }
    this.conv.buffer = buf;
    this._impulseFor = this.decay;
  }

  setEnabled(on) {
    this.on = Boolean(on);
    this._apply();
  }

  set(params = {}) {
    if (params.decay !== undefined) this.decay = clamp(params.decay, 0.3, 4);
    if (params.tone !== undefined) this.tone = clamp(params.tone, 800, 12000);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._buildImpulse();
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.lp.frequency.setTargetAtTime(this.tone, t, 0.02);
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.3, t, 0.02);
  }
}
