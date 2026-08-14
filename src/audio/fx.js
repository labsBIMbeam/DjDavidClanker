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
 * Channel filter with selectable models — the DJ-mixer "one knob, LP left,
 * HP right" sweep, but with the personality switchable:
 *
 *   clean  transparent 2-pole, constant low Q — the original behaviour
 *   djm    2-pole whose Q rises gently toward the ends — the Pioneer feel
 *   xone   Allen & Heath Xone:92-style VCF: 4-pole (two cascaded biquads),
 *          pronounced resonance that grows with the sweep, and a soft
 *          saturation stage for the analog crunch
 *
 * The chain is fixed (f1 → f2 → drive → shaper → post); models that need
 * less of it make the extra stages transparent (peaking @ 0 dB, null curve),
 * so switching models never rewires the graph mid-signal.
 */
export const FILTER_MODELS = ['clean', 'djm', 'xone'];

export class ChannelFilter {
  constructor(ctx) {
    this.ctx = ctx;
    this.model = 'clean';
    this.position = 0;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.f1 = ctx.createBiquadFilter();
    this.f2 = ctx.createBiquadFilter();
    this.drive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.post = ctx.createGain();

    this.f1.type = 'lowpass';
    this.f1.frequency.value = 22050;
    this.f1.Q.value = 0.7;
    this.f2.type = 'peaking';
    this.f2.frequency.value = 1000;
    this.f2.gain.value = 0;

    // tanh soft clipper, normalized so full drive stays inside ±1.
    const N = 1024;
    const curve = new Float32Array(N);
    const K = 2.2;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(K * x) / Math.tanh(K);
    }
    this._curve = curve;
    this.shaper.curve = null; // identity until the xone model wants crunch

    this.input.connect(this.f1).connect(this.f2).connect(this.drive)
      .connect(this.shaper).connect(this.post).connect(this.output);
  }

  setModel(model) {
    if (!FILTER_MODELS.includes(model)) return;
    this.model = model;
    this._apply();
  }

  setPosition(v) {
    this.position = clamp(v, -1, 1);
    this._apply();
  }

  _apply() {
    const v = this.position;
    const x = Math.abs(v);
    const neutral = x <= 0.02;
    const xone = this.model === 'xone';

    // Frequency mapping shared by all models (the original sweep curve).
    let type = 'lowpass';
    let freq = 22050;
    if (!neutral && v < 0) freq = 22050 * Math.pow(180 / 22050, x);
    if (!neutral && v > 0) {
      type = 'highpass';
      freq = 20 * Math.pow(8000 / 20, x);
    }

    const q = neutral || this.model === 'clean' ? 0.7
      : this.model === 'djm' ? 0.7 + 0.8 * Math.pow(x, 1.3)
      : 0.55 + 1.5 * Math.pow(x, 0.9); // xone: resonance rides the sweep

    this.f1.type = type;
    this.f1.frequency.value = freq;
    this.f1.Q.value = q;

    if (xone && !neutral) {
      // Second pole pair at the same corner → 24 dB/oct with a resonant hump.
      this.f2.type = type;
      this.f2.frequency.value = freq;
      this.f2.Q.value = q * 0.8;
      this.shaper.curve = this._curve;
      this.drive.gain.value = 1 + 1.6 * x;
      this.post.gain.value = 1 / (1 + 0.6 * x);
    } else {
      this.f2.type = 'peaking';
      this.f2.frequency.value = 1000;
      this.f2.Q.value = 0.7;
      this.f2.gain.value = 0;
      this.shaper.curve = null;
      this.drive.gain.value = 1;
      this.post.gain.value = 1;
    }
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
      let lp = 0;
      for (let i = 0; i < len; i++) {
        // -60 dB by the end of the tail, with progressive damping: a one-pole
        // lowpass that closes along the tail, the way air eats the highs of a
        // real room. Bare white noise reads as "fizz", not as space.
        const white = Math.random() * 2 - 1;
        const a = 0.1 + 0.8 * (i / len);
        lp += (white - lp) * (1 - a);
        d[i] = lp * Math.pow(10, (-3 * i) / len) * 2.2;
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

/**
 * Dual-voice chorus: two 16/22 ms delays, one LFO true and one slightly
 * detuned against it — the classic lush widening without flanger metal.
 */
export class Chorus {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 0.6;
    this.depth = 0.004;
    this.mix = 0.5;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.d1 = ctx.createDelay(0.08);
    this.d2 = ctx.createDelay(0.08);
    this.d1.delayTime.value = 0.016;
    this.d2.delayTime.value = 0.022;
    this.lfo1 = ctx.createOscillator();
    this.lfo2 = ctx.createOscillator();
    this.g1 = ctx.createGain();
    this.g2 = ctx.createGain();
    this.lfo1.frequency.value = this.rate;
    this.lfo2.frequency.value = this.rate * 1.17; // detune = lush, not metallic
    this.g1.gain.value = this.depth;
    this.g2.gain.value = this.depth;

    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.d1).connect(this.wet);
    this.input.connect(this.d2).connect(this.wet);
    this.wet.connect(this.output);
    this.lfo1.connect(this.g1).connect(this.d1.delayTime);
    this.lfo2.connect(this.g2).connect(this.d2.delayTime);
    this.lfo1.start();
    this.lfo2.start();
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.05, 4);
    if (params.depth !== undefined) this.depth = clamp(params.depth, 0, 0.008);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet * 0.6, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.35, t, 0.02);
    this.lfo1.frequency.setTargetAtTime(this.rate, t, 0.02);
    this.lfo2.frequency.setTargetAtTime(this.rate * 1.17, t, 0.02);
    this.g1.gain.setTargetAtTime(this.on ? this.depth : 0, t, 0.02);
    this.g2.gain.setTargetAtTime(this.on ? this.depth : 0, t, 0.02);
  }

  dispose() { try { this.lfo1.stop(); this.lfo2.stop(); } catch { /* stopped */ } }
}

/** Tremolo: an LFO riding the channel gain. Full-path — no wet/dry needed. */
export class Tremolo {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 5;
    this.depth = 0.7;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.amp = ctx.createGain();
    this.lfo = ctx.createOscillator();
    this.lfoDepth = ctx.createGain();
    this.amp.gain.value = 1;
    this.lfoDepth.gain.value = 0;
    this.lfo.frequency.value = this.rate;
    this.input.connect(this.amp).connect(this.output);
    this.lfo.connect(this.lfoDepth).connect(this.amp.gain);
    this.lfo.start();
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.3, 16);
    if (params.depth !== undefined) this.depth = clamp(params.depth, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const d = this.on ? this.depth : 0;
    this.amp.gain.setTargetAtTime(1 - d / 2, t, 0.02);
    this.lfoDepth.gain.setTargetAtTime(d / 2, t, 0.02);
    this.lfo.frequency.setTargetAtTime(this.rate, t, 0.02);
  }

  dispose() { try { this.lfo.stop(); } catch { /* stopped */ } }
}

/** Autopan: an LFO sweeping the stereo field. */
export class AutoPan {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 1;
    this.width = 0.8;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.lfo = ctx.createOscillator();
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.frequency.value = this.rate;
    this.input.connect(this.pan).connect(this.output);
    this.lfo.connect(this.lfoDepth).connect(this.pan.pan);
    this.lfo.start();
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.05, 8);
    if (params.width !== undefined) this.width = clamp(params.width, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    this.lfoDepth.gain.setTargetAtTime(this.on ? this.width : 0, t, 0.02);
    this.lfo.frequency.setTargetAtTime(this.rate, t, 0.02);
  }

  dispose() { try { this.lfo.stop(); } catch { /* stopped */ } }
}

/** Drive: tanh waveshaper with a tone lowpass and level makeup. */
export class Drive {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.drive = 0.5;
    this.tone = 6500;
    this.mix = 0.8;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = this.tone;
    this.makeup = ctx.createGain();

    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.shaper).connect(this.lp).connect(this.makeup)
      .connect(this.wet).connect(this.output);
    this._curve();
  }

  _curve() {
    const k = 1 + this.drive * 30;
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    this.shaper.curve = curve;
    this.makeup.gain.value = 1 / (1 + this.drive * 0.6);
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.drive !== undefined) { this.drive = clamp(params.drive, 0, 1); this._curve(); }
    if (params.tone !== undefined) this.tone = clamp(params.tone, 1200, 16000);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.lp.frequency.setTargetAtTime(this.tone, t, 0.02);
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.7, t, 0.02);
  }
}

/** Bitcrusher: a stepped waveshaper — lo-fi grit without a worklet. */
export class Crush {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.bits = 6;
    this.mix = 0.8;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.shaper).connect(this.wet).connect(this.output);
    this._curve();
  }

  _curve() {
    const steps = Math.pow(2, this.bits);
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    this.shaper.curve = curve;
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.bits !== undefined) { this.bits = clamp(Math.round(params.bits), 2, 12); this._curve(); }
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.8, t, 0.02);
  }
}

/**
 * Ping-pong delay: cross-fed L/R delays on the deck BPM, like the echo —
 * division in beats, so it stays musical when the tempo fader moves.
 */
export class PingPong {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.division = 0.75; // dotted eighth — THE delay
    this.feedback = 0.45;
    this.mix = 0.4;
    this.bpm = 120;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wetL = ctx.createGain();
    this.wetR = ctx.createGain();
    this.dl = ctx.createDelay(3);
    this.dr = ctx.createDelay(3);
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    this.panL = ctx.createStereoPanner();
    this.panR = ctx.createStereoPanner();
    this.panL.pan.value = -0.85;
    this.panR.pan.value = 0.85;
    this.dry.gain.value = 1;
    this.wetL.gain.value = 0;
    this.wetR.gain.value = 0;
    this.fbL.gain.value = 0;
    this.fbR.gain.value = 0;

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.dl);
    this.dl.connect(this.panL).connect(this.wetL).connect(this.output);
    this.dl.connect(this.fbL).connect(this.dr);
    this.dr.connect(this.panR).connect(this.wetR).connect(this.output);
    this.dr.connect(this.fbR).connect(this.dl);
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.division !== undefined) this.division = clamp(params.division, 0.125, 2);
    if (params.feedback !== undefined) this.feedback = clamp(params.feedback, 0, 0.9);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    if (params.bpm !== undefined && params.bpm > 0) this.bpm = params.bpm;
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const beat = 60 / clamp(this.bpm, 40, 300);
    const time = clamp(this.division * beat, 0.02, 2.5);
    this.dl.delayTime.setTargetAtTime(time, t, 0.05);
    this.dr.delayTime.setTargetAtTime(time, t, 0.05);
    const wet = this.on ? this.mix : 0;
    this.wetL.gain.setTargetAtTime(wet, t, 0.02);
    this.wetR.gain.setTargetAtTime(wet, t, 0.02);
    this.fbL.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.02);
    this.fbR.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.02);
  }
}

/** Telephone: a hard band stack — everything but the midrange dies. */
export class Telephone {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.width = 0.5; // 0 = narrowest slit, 1 = small-radio wide

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.hp1 = ctx.createBiquadFilter();
    this.hp2 = ctx.createBiquadFilter();
    this.lp1 = ctx.createBiquadFilter();
    this.lp2 = ctx.createBiquadFilter();
    for (const f of [this.hp1, this.hp2]) { f.type = 'highpass'; f.frequency.value = 640; }
    for (const f of [this.lp1, this.lp2]) { f.type = 'lowpass'; f.frequency.value = 2400; }
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.hp1).connect(this.hp2).connect(this.lp1).connect(this.lp2)
      .connect(this.wet).connect(this.output);
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.width !== undefined) this.width = clamp(params.width, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const lo = 780 - this.width * 320; // 780..460
    const hi = 1900 + this.width * 1700; // 1900..3600
    for (const f of [this.hp1, this.hp2]) f.frequency.setTargetAtTime(lo, t, 0.02);
    for (const f of [this.lp1, this.lp2]) f.frequency.setTargetAtTime(hi, t, 0.02);
    // Telephone reads as a takeover, not a blend.
    this.wet.gain.setTargetAtTime(this.on ? 1.25 : 0, t, 0.02);
    this.dry.gain.setTargetAtTime(this.on ? 0 : 1, t, 0.02);
  }
}

/** Auto-wah: a resonant bandpass swept by its own LFO. Special filter #1. */
export class AutoWah {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.rate = 1.2;
    this.res = 8;
    this.range = 0.6; // how far up the sweep reaches
    this.mix = 0.85;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 600;
    this.bp.Q.value = this.res;
    this.lfo = ctx.createOscillator();
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfo.frequency.value = this.rate;
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.bp).connect(this.wet).connect(this.output);
    this.lfo.connect(this.lfoDepth).connect(this.bp.frequency);
    this.lfo.start();
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.rate !== undefined) this.rate = clamp(params.rate, 0.05, 8);
    if (params.res !== undefined) this.res = clamp(params.res, 1, 18);
    if (params.range !== undefined) this.range = clamp(params.range, 0, 1);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const center = 350 + this.range * 900;
    const sweep = this.on ? center * 0.8 : 0;
    this.bp.frequency.setTargetAtTime(center, t, 0.02);
    this.bp.Q.setTargetAtTime(this.res, t, 0.02);
    this.lfoDepth.gain.setTargetAtTime(sweep, t, 0.02);
    this.lfo.frequency.setTargetAtTime(this.rate, t, 0.02);
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet * 1.4, t, 0.02); // BP eats level — makeup
    this.dry.gain.setTargetAtTime(1 - wet * 0.75, t, 0.02);
  }

  dispose() { try { this.lfo.stop(); } catch { /* stopped */ } }
}

/**
 * Vowel filter: three parallel formant bandpasses morphing A→E→I→O→U.
 * Special filter #2 — the talkbox-ish one.
 */
export class Vowel {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.vowel = 0; // 0..1 morphs across A E I O U
    this.res = 9;
    this.mix = 0.9;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.f = [0, 1, 2].map(() => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = this.res;
      return bp;
    });
    this.g = [1.0, 0.7, 0.35].map((v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    });
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    for (let i = 0; i < 3; i++) {
      this.input.connect(this.f[i]).connect(this.g[i]).connect(this.wet);
    }
    this.wet.connect(this.output);
    this._formants();
  }

  static VOWELS = [
    [800, 1150, 2900], // A
    [400, 1600, 2700], // E
    [250, 1750, 3600], // I
    [400, 800, 2600],  // O
    [350, 600, 2700],  // U
  ];

  _formants() {
    const pos = this.vowel * (Vowel.VOWELS.length - 1);
    const i = Math.min(Vowel.VOWELS.length - 2, Math.floor(pos));
    const k = pos - i;
    const t = this.ctx.currentTime;
    for (let n = 0; n < 3; n++) {
      const hz = Vowel.VOWELS[i][n] * (1 - k) + Vowel.VOWELS[i + 1][n] * k;
      this.f[n].frequency.setTargetAtTime(hz, t, 0.03);
      this.f[n].Q.setTargetAtTime(this.res, t, 0.03);
    }
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.vowel !== undefined) this.vowel = clamp(params.vowel, 0, 1);
    if (params.res !== undefined) this.res = clamp(params.res, 2, 16);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._formants();
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet * 1.6, t, 0.02); // formant stack is quiet
    this.dry.gain.setTargetAtTime(1 - wet * 0.8, t, 0.02);
  }
}

/**
 * Comb filter: a few milliseconds of high-feedback delay — metallic
 * resonance tuned like a note. Special filter #3.
 */
export class Comb {
  constructor(ctx) {
    this.ctx = ctx;
    this.on = false;
    this.freq = 220; // resonant pitch in Hz (delay = 1/freq)
    this.feedback = 0.8;
    this.mix = 0.5;

    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(0.05);
    this.fb = ctx.createGain();
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.damp.frequency.value = 6000; // keeps the ring from going glassy
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.fb.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay).connect(this.wet).connect(this.output);
    this.delay.connect(this.damp).connect(this.fb).connect(this.delay);
    this._tune();
  }

  _tune() {
    this.delay.delayTime.setTargetAtTime(1 / clamp(this.freq, 40, 1500), this.ctx.currentTime, 0.02);
  }

  setEnabled(on) { this.on = Boolean(on); this._apply(); }

  set(params = {}) {
    if (params.freq !== undefined) { this.freq = clamp(params.freq, 40, 1500); this._tune(); }
    if (params.feedback !== undefined) this.feedback = clamp(params.feedback, 0, 0.95);
    if (params.mix !== undefined) this.mix = clamp(params.mix, 0, 1);
    this._apply();
  }

  _apply() {
    const t = this.ctx.currentTime;
    const wet = this.on ? this.mix : 0;
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.5, t, 0.02);
    this.fb.gain.setTargetAtTime(this.on ? this.feedback : 0, t, 0.02);
  }
}
