/** Render an original four-bar mono loop. All samples are generated locally. */
export function renderLoop({ bpm = 120, root = 36, seed = 21, sampleRate = 44100 } = {}) {
  for (const [name, value, min, max] of [['tempo', bpm, 80, 160], ['root', root, 24, 60],
    ['seed', seed, 0, 4294967295], ['sample rate', sampleRate, 8000, 48000]]) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}`);
    }
  }
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const scale = [0, 3, 5, 7, 10, 12];
  const notes = Array.from({ length: 64 }, (_, step) => ({
    frequency: 440 * 2 ** ((root + scale[Math.floor(random() * scale.length)] - 69) / 12),
    bass: step % 4 === 0 || random() > 0.35,
    hat: step % 2 === 0 || random() > 0.7,
  }));
  const samples = new Float32Array(Math.round(sampleRate * 16 * 60 / bpm));
  const stepSeconds = 60 / bpm / 4;
  const tau = Math.PI * 2;
  for (let i = 0; i < samples.length; i++) {
    const seconds = i / sampleRate;
    const step = Math.min(63, Math.floor(seconds / stepSeconds));
    const t = seconds - step * stepSeconds;
    const note = notes[step];
    const attack = Math.min(1, t / 0.004);
    const bass = note.bass ? (Math.sin(tau * note.frequency * t)
      + 0.25 * Math.sin(tau * note.frequency * 2 * t)) * Math.exp(-t * 18) * attack : 0;
    const beatTime = seconds % (60 / bpm);
    const kick = Math.sin(tau * (42 * beatTime + 95 / 28 * (1 - Math.exp(-28 * beatTime))))
      * Math.exp(-beatTime * 13) * Math.min(1, beatTime / 0.002);
    const noise = random() * 2 - 1;
    const hat = note.hat ? noise * Math.exp(-t * 90) * attack : 0;
    const snareTime = seconds % (120 / bpm) - 60 / bpm;
    const snare = snareTime >= 0 ? noise * Math.exp(-snareTime * 25) : 0;
    const edge = Math.min(1, i / (sampleRate * 0.004),
      (samples.length - 1 - i) / (sampleRate * 0.004));
    samples[i] = Math.tanh(bass * 0.5 + kick * 0.65 + hat * 0.12 + snare * 0.18) * edge;
  }
  return samples;
}

/** Encode bounded mono samples as a portable 16-bit PCM WAV file. */
export function encodeWav(samples, sampleRate = 44100) {
  if (!(samples instanceof Float32Array) || samples.length > 576000
    || !samples.every(Number.isFinite) || !Number.isInteger(sampleRate)
    || sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid WAV input');
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  });
  return bytes;
}
