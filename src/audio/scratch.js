/**
 * Virtual turntable.
 *
 * Normal playback uses one long AudioBufferSourceNode — solid, no artefacts.
 * That node cannot change direction (`playbackRate` may not go negative) and
 * cannot be dragged around, so anything vinyl-like runs through this engine
 * instead: a granular player that reads short overlapping slices from the
 * buffer at whatever rate the platter currently has, forwards or backwards.
 *
 * Backwards playback reads from a pre-reversed copy of the buffer — the
 * standard trick, and the reason `reversedBuffer()` is worth its memory.
 *
 * The deck switches in here for scratching, braking, spin-up and the rewind
 * button, then hands control back to the plain source node.
 */

const GRAIN = 0.024; // seconds of output per grain
const HOP = GRAIN / 2; // 50 % overlap — two grains always sound at once
const AHEAD = 0.045; // how far ahead of the clock to keep the queue filled
const MAX_RATE = 16;

/**
 * A position written into the Turntable now is heard roughly a queue's depth
 * later. Anything that schedules against the audio clock on top of the grain
 * player (the autoscratch fader gates) must offset by this.
 */
export const GRAIN_LATENCY = AHEAD;

/**
 * Equal-power grain window (half-sine). At 50 % overlap sin² + cos² = 1, so
 * the summed power through the seams is constant — this is what killed the
 * 45 Hz amplitude chatter the old butt-jointed grains had.
 */
const WINDOW = new Float32Array(48);
for (let i = 0; i < WINDOW.length; i++) WINDOW[i] = Math.sin((Math.PI * i) / (WINDOW.length - 1));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Sample-reversed copy of a buffer, for negative playback rates. */
export function reversedBuffer(ctx, buffer) {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    const n = src.length;
    for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return out;
}

export class Turntable {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  head of the deck's insert chain
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.forward = null;
    this.reverse = null;
    this.duration = 0;

    this.active = false;
    this.position = 0;
    this.rate = 0;
    /**
     * Who owns the position. With the motor driving (brake, spin-up, backspin)
     * the grain scheduler advances it. With a hand on the record the deck sets
     * it from the pointer, and self-advancing would double-count the movement.
     */
    this.autoAdvance = true;

    this._nextGrainAt = 0;
    this._timer = null;
    this._live = new Set();
    this._lastGrainSpeed = 0;
  }

  setBuffers(forward, reverse) {
    this.forward = forward;
    this.reverse = reverse;
    this.duration = forward ? forward.duration : 0;
  }

  start(position, rate) {
    if (!this.forward || this.active) return;
    this.active = true;
    this.position = clamp(position, 0, this.duration);
    this.rate = clamp(rate, -MAX_RATE, MAX_RATE);
    this._nextGrainAt = this.ctx.currentTime + 0.01;
    // A dedicated timer rather than rAF: grain scheduling must survive a
    // throttled or backgrounded animation frame.
    this._timer = setInterval(() => this.tick(), 10);
    this.tick();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this._timer);
    this._timer = null;
    const now = this.ctx.currentTime;
    for (const { src, gain } of this._live) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.008);
        src.stop(now + 0.02);
      } catch {
        /* already finished */
      }
    }
    this._live.clear();
  }

  setRate(rate) {
    this.rate = clamp(rate, -MAX_RATE, MAX_RATE);
  }

  setPosition(p) {
    this.position = clamp(p, 0, this.duration);
  }

  /** Fill the grain queue up to AHEAD seconds beyond the clock. */
  tick() {
    if (!this.active || !this.forward) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this._nextGrainAt < now) this._nextGrainAt = now + 0.005;

    let guard = 0;
    while (this._nextGrainAt < now + AHEAD && guard++ < 48) {
      this._scheduleGrain(this._nextGrainAt);
      this._nextGrainAt += HOP;
    }
  }

  _scheduleGrain(when) {
    const rate = this.rate;
    const speed = Math.abs(rate);
    const pos = this.position;

    if (this.autoAdvance) {
      // Grains are spawned every HOP, so each spawn advances by one hop's
      // worth of audio — the overlapping halves must not double-count.
      this.position = clamp(pos + rate * HOP, 0, this.duration);
    }

    // A stationary platter still touches the needle, but it should not sing:
    // fade out below ~0.15x rather than pitching down to a drone.
    const level = speed < 0.15 ? speed / 0.15 : 1;
    const fromSpeed = Math.max(0.02, this._lastGrainSpeed);
    this._lastGrainSpeed = Math.max(0.02, speed);
    if (level <= 0.01 || this.duration <= 0) return;

    const buffer = rate >= 0 ? this.forward : this.reverse || this.forward;
    if (!buffer) return;

    // The reversed buffer's timeline runs the other way.
    let offset = rate >= 0 ? pos : this.duration - pos;
    const maxSpeed = Math.max(fromSpeed, speed);
    const consumed = Math.max(0.002, maxSpeed * GRAIN * 1.35 + 0.005);
    offset = clamp(offset, 0, Math.max(0, buffer.duration - consumed - 0.001));

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Glide the rate across the grain instead of stepping it once per grain:
    // fast gestures used to quantize into audible 22 ms pitch stairs.
    src.playbackRate.setValueAtTime(fromSpeed, when);
    src.playbackRate.linearRampToValueAtTime(Math.max(0.02, speed), when + GRAIN);

    // Equal-power half-sine window over the whole grain (see WINDOW above).
    const gain = ctx.createGain();
    if (level >= 1) {
      gain.gain.setValueCurveAtTime(WINDOW, when, GRAIN);
    } else {
      const scaled = new Float32Array(WINDOW.length);
      for (let i = 0; i < WINDOW.length; i++) scaled[i] = WINDOW[i] * level;
      gain.gain.setValueCurveAtTime(scaled, when, GRAIN);
    }

    src.connect(gain).connect(this.destination);
    src.start(when, offset, consumed);
    src.stop(when + GRAIN + 0.01);

    const entry = { src, gain };
    this._live.add(entry);
    src.onended = () => {
      this._live.delete(entry);
      try {
        gain.disconnect();
      } catch {
        /* fine */
      }
    };
  }
}
