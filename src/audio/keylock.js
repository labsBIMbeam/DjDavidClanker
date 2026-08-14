/**
 * Keylock — tempo without the chipmunk.
 *
 * The deck keeps driving tempo through playbackRate (which colours pitch,
 * like vinyl); with keylock on, this worklet CORRECTS the pitch back by the
 * inverse ratio. Classic dual-tap granular shifter: a delay line whose read
 * taps drift at (1 - ratio) per sample and wrap over a ~93 ms grain, two
 * taps half a grain apart under a cos² window so the wrap is inaudible.
 * ratio 1 short-circuits to a plain copy.
 *
 * The processor source ships as a string and loads through a Blob URL — the
 * napplet is a single file, there is nothing to fetch. Scratching stays
 * vinyl on purpose: the platter path never runs through this node.
 */

const PROCESSOR = `
class ClankerKeylock extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.G = Math.round(sampleRate * 0.093); // grain in samples
    this.size = 1 << Math.ceil(Math.log2(this.G * 3));
    this.mask = this.size - 1;
    this.ring = [new Float32Array(this.size), new Float32Array(this.size)];
    this.w = 0;
    this.phase = 0;
  }
  read(ch, delay) {
    const pos = this.w - delay;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const r = this.ring[ch];
    const a = r[i0 & this.mask];
    const b = r[(i0 + 1) & this.mask];
    return a + (b - a) * frac;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    if (!inp || !inp.length) return true;
    const ratio = params.ratio[0];
    const n = inp[0].length;
    const chs = Math.min(out.length, 2);

    if (Math.abs(ratio - 1) < 0.001) {
      for (let c = 0; c < chs; c++) out[c].set(inp[Math.min(c, inp.length - 1)]);
      // Keep the ring warm so engaging keylock has history to read.
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          this.ring[c][(this.w + i) & this.mask] = inp[Math.min(c, inp.length - 1)][i];
        }
      }
      this.w += n;
      return true;
    }

    const G = this.G;
    const drift = 1 - ratio; // per-sample growth of the read delay
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        this.ring[c][(this.w) & this.mask] = inp[Math.min(c, inp.length - 1)][i];
      }
      this.w++;
      this.phase += drift;
      // Wrap the saw into [0, G) whichever way it drifts.
      if (this.phase >= G) this.phase -= G;
      if (this.phase < 0) this.phase += G;
      const dA = this.phase;
      const dB = (this.phase + G / 2) % G;
      // cos² windows peak where the other tap wraps — the crossfade.
      const gA = 0.5 - 0.5 * Math.cos((2 * Math.PI * dA) / G);
      const gB = 0.5 - 0.5 * Math.cos((2 * Math.PI * dB) / G);
      for (let c = 0; c < chs; c++) {
        const cc = Math.min(c, 1);
        out[c][i] = this.read(cc, 2 + dA) * gA + this.read(cc, 2 + dB) * gB;
      }
    }
    return true;
  }
}
registerProcessor('clanker-keylock', ClankerKeylock);
`;

let loaded = false;

/** Load the processor once per context. Resolves false where worklets die. */
export async function loadKeylock(ctx) {
  if (loaded) return true;
  if (!ctx || !ctx.audioWorklet) return false;
  try {
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    loaded = true;
    return true;
  } catch {
    return false;
  }
}

export function createKeylockNode(ctx) {
  return new AudioWorkletNode(ctx, 'clanker-keylock', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}
