/**
 * Measure the BPM the app would detect, from the command line.
 *
 * detectBpm runs in an OfflineAudioContext, so it cannot be imported here.
 * This reimplements the same approach — onset envelope, autocorrelation over
 * a plausible tempo range — against PCM piped out of ffmpeg, which is enough
 * to answer the question that actually matters when a match fails: what are
 * the two tempos, and is the gap even reachable inside the pitch range?
 *
 *   node dev/bpm-probe.mjs scratch-lab/*.mp3
 */

import { execFileSync } from 'node:child_process';

const SR = 11025;
const MIN_BPM = 70;
const MAX_BPM = 180;

function decode(path) {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
}

/** Spectral-flux-ish onset envelope: rectified energy rise per short frame. */
function onsetEnvelope(pcm) {
  const WIN = 256;
  const frames = Math.floor(pcm.length / WIN);
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < WIN; i++) {
      const v = pcm[f * WIN + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / WIN);
  }
  const env = new Float32Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, energy[f] - energy[f - 1]);
  // Normalise so autocorrelation peaks are comparable across tracks.
  let mean = 0;
  for (const v of env) mean += v;
  mean /= frames || 1;
  for (let f = 0; f < frames; f++) env[f] -= mean;
  return { env, frameRate: SR / WIN };
}

function bestTempo(env, frameRate) {
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let n = 0;
    // Sum several multiples of the lag: a real tempo lines up at 1x, 2x, 3x,
    // which is what separates the beat from an arbitrary periodicity.
    for (const mult of [1, 2, 3, 4]) {
      const l = lag * mult;
      for (let i = 0; i + l < env.length; i++) {
        sum += env[i] * env[i + l];
        n++;
      }
    }
    scores.push({ bpm: (60 * frameRate) / lag, score: n ? sum / n : 0 });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const runnerUp = scores.find((s) => Math.abs(s.bpm - top.bpm) > 4);
  return {
    bpm: top.bpm,
    confidence: runnerUp && top.score > 0 ? Math.max(0, 1 - runnerUp.score / top.score) : 0,
  };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node dev/bpm-probe.mjs <audio files…>');
  process.exit(1);
}

const found = [];
for (const path of files) {
  try {
    const pcm = decode(path);
    const { env, frameRate } = onsetEnvelope(pcm);
    const { bpm, confidence } = bestTempo(env, frameRate);
    const name = path.split('/').pop();
    found.push({ name, bpm });
    console.log(`${bpm.toFixed(1).padStart(6)} BPM  (conf ${confidence.toFixed(2)})  ${name}  [${(pcm.length / SR).toFixed(0)}s]`);
  } catch (e) {
    console.log(`     ?  BPM  ${path} — ${e.message.split('\n')[0]}`);
  }
}

/* Can the deck's ±8% pitch fader actually bridge each pair? */
if (found.length >= 2) {
  console.log('\nReachable within the ±8% pitch range?');
  const RANGE = 8;
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const a = found[i];
      const b = found[j];
      // Same set of relations the engine's syncTo tries.
      let best = null;
      for (const t of [a.bpm, a.bpm * 2, a.bpm / 2, a.bpm * 1.5, a.bpm / 1.5]) {
        const pct = (t / b.bpm - 1) * 100;
        if (Math.abs(pct) <= RANGE && (!best || Math.abs(pct) < Math.abs(best))) best = pct;
      }
      const verdict = best === null
        ? `NO — nearest relation is ${(((a.bpm / b.bpm) - 1) * 100).toFixed(1)}%`
        : `yes, ${best >= 0 ? '+' : ''}${best.toFixed(2)}%`;
      console.log(`  ${a.name.slice(0, 28).padEnd(30)} ↔ ${b.name.slice(0, 28).padEnd(30)} ${verdict}`);
    }
  }
}
