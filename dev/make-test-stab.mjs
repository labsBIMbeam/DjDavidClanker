/**
 * Writes a synthetic scratch sample into ./scratch-lab.
 *
 * Not music — a placeholder so the platter and the scratch routines have
 * something with a hard transient to chew on before you have dropped a real
 * sample in. Scratching wants an attack: the classic battle records are vocal
 * and horn stabs precisely because the ear tracks the pitch bend off a sharp
 * onset. A pad would tell you nothing about whether a flare is landing.
 *
 *   node dev/make-test-stab.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RATE = 44100;
const DUR = 1.8;
const OUT = resolve(process.cwd(), 'scratch-lab', 'Test Tone - Scratch Stab.wav');

const n = Math.floor(RATE * DUR);
const data = new Float32Array(n);

/** One stab: hard attack, short decay, a couple of harmonics and some grit. */
function stab(at, freq, len, level) {
  const start = Math.floor(at * RATE);
  const count = Math.floor(len * RATE);
  for (let i = 0; i < count && start + i < n; i++) {
    const t = i / RATE;
    // 2 ms attack, exponential decay — the transient is the whole point.
    const attack = Math.min(1, t / 0.002);
    const env = attack * Math.exp(-t * (3.2 / len));
    const body =
      Math.sin(2 * Math.PI * freq * t) * 0.6 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * freq * 3 * t) * 0.12;
    // A little noise in the attack gives the grain player some high-frequency
    // detail to smear, which is where scratch artefacts show up first.
    const grit = (Math.random() * 2 - 1) * Math.exp(-t * 90) * 0.35;
    data[start + i] += (body + grit) * env * level;
  }
}

stab(0.02, 220, 0.55, 0.85);
stab(0.62, 330, 0.45, 0.7);
stab(1.1, 165, 0.62, 0.8);

let peak = 0;
for (const v of data) peak = Math.max(peak, Math.abs(v));
const norm = peak > 0 ? 0.89 / peak : 1;

const bytes = Buffer.alloc(44 + n * 2);
bytes.write('RIFF', 0);
bytes.writeUInt32LE(36 + n * 2, 4);
bytes.write('WAVE', 8);
bytes.write('fmt ', 12);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); // PCM
bytes.writeUInt16LE(1, 22); // mono
bytes.writeUInt32LE(RATE, 24);
bytes.writeUInt32LE(RATE * 2, 28);
bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34);
bytes.write('data', 36);
bytes.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) {
  const v = Math.max(-1, Math.min(1, data[i] * norm));
  bytes.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}

mkdirSync(resolve(process.cwd(), 'scratch-lab'), { recursive: true });
writeFileSync(OUT, bytes);
console.log(`wrote ${OUT} (${DUR}s, ${(bytes.length / 1024).toFixed(0)} kB)`);
