/**
 * Musical key detection, and what to do about it.
 *
 * Two tracks playing together sit well or clash depending on their keys, and
 * the DJ convention for reasoning about that is the Camelot wheel: keys are
 * numbered 1–12 around the circle of fifths with A for minor and B for major,
 * and the compatible neighbours of a key are the same number in the other
 * mode, and one step either way around the wheel.
 *
 * Detection is a chromagram scored against the Krumhansl–Schmuckler key
 * profiles. That is the standard approach and it is good but not infallible —
 * roughly the accuracy a decent DJ library gets, which is why `confidence` is
 * reported and the UI never presents a key as certain.
 *
 * The important caveat for this app: the decks pitch-shift by resampling, so
 * changing tempo changes key. `keyAtRate` exists because a track's key at
 * +6 % is not the key it was detected at.
 */

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Krumhansl–Schmuckler profiles, major and minor. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Camelot codes indexed by pitch class, for major and minor.
 * 8B is C major, 8A is A minor — the usual anchors.
 */
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

const mod = (x, m) => ((x % m) + m) % m;

/** Pearson correlation of a chroma vector against a rotated profile. */
function score(chroma, profile, rotation) {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 12; i++) {
    sx += chroma[i];
    sy += profile[i];
  }
  const mx = sx / 12;
  const my = sy / 12;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < 12; i++) {
    const a = chroma[mod(i + rotation, 12)] - mx;
    const b = profile[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : 0;
}

/**
 * Detect the musical key of a decoded buffer.
 * @returns {Promise<{pc:number, minor:boolean, name:string, camelot:string, confidence:number}|null>}
 */
export async function detectKey(buffer) {
  if (!buffer || buffer.length < buffer.sampleRate * 4) return null;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return null;

  // 11 kHz is plenty: everything that defines the key lives well below 5 kHz,
  // and halving the rate halves the FFT work.
  const sr = 11025;
  const skip = Math.floor(buffer.duration * 0.1);
  const dur = Math.min(120, Math.max(10, buffer.duration - skip));
  const frames = Math.floor(dur * sr);

  const off = new OfflineCtx(1, frames, sr);
  const src = off.createBufferSource();
  src.buffer = buffer;
  // Bandpass roughly to the range where pitch is unambiguous: below ~80 Hz the
  // bass fundamental smears, above ~5 kHz it is mostly cymbals.
  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80;
  const lp = off.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5000;
  src.connect(hp).connect(lp).connect(off.destination);
  src.start(0, skip);
  const data = (await off.startRendering()).getChannelData(0);

  // Goertzel over the twelve pitch classes across five octaves. Cheaper and
  // far less code than a full FFT plus binning, and we only want 12 numbers.
  const chroma = new Float32Array(12);
  const WIN = 4096;
  const HOP = 2048;
  const A4 = 440;

  const freqs = [];
  for (let pc = 0; pc < 12; pc++) {
    for (let oct = 2; oct <= 6; oct++) {
      // MIDI note for this pitch class in this octave; 60 = C4.
      const midi = 12 * (oct + 1) + pc;
      const f = A4 * Math.pow(2, (midi - 69) / 12);
      if (f > 80 && f < sr / 2.5) freqs.push({ pc, f });
    }
  }

  for (let start = 0; start + WIN <= data.length; start += HOP) {
    for (const { pc, f } of freqs) {
      const k = (2 * Math.PI * f) / sr;
      const coeff = 2 * Math.cos(k);
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < WIN; i++) {
        s0 = data[start + i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      chroma[pc] += power > 0 ? Math.sqrt(power) : 0;
    }
  }

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total <= 0) return null;
  for (let i = 0; i < 12; i++) chroma[i] /= total;

  let best = null;
  let runnerUp = -Infinity;
  for (let pc = 0; pc < 12; pc++) {
    for (const minor of [false, true]) {
      const s = score(chroma, minor ? MINOR : MAJOR, pc);
      if (!best || s > best.s) {
        if (best) runnerUp = Math.max(runnerUp, best.s);
        best = { pc, minor, s };
      } else if (s > runnerUp) {
        runnerUp = s;
      }
    }
  }
  if (!best) return null;

  // Confidence is the margin over the next-best candidate, not the raw
  // correlation — a track that scores 0.8 for two different keys is not a
  // confident detection however high the number looks.
  const confidence = Math.max(0, Math.min(1, (best.s - runnerUp) * 4));
  return {
    pc: best.pc,
    minor: best.minor,
    name: `${NAMES[best.pc]} ${best.minor ? 'min' : 'maj'}`,
    camelot: (best.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[best.pc],
    confidence,
  };
}

/** The same key transposed by `semitones`, for a deck running off-speed. */
export function transpose(key, semitones) {
  if (!key) return null;
  const n = Math.round(semitones);
  if (!n) return key;
  const pc = mod(key.pc + n, 12);
  return {
    ...key,
    pc,
    name: `${NAMES[pc]} ${key.minor ? 'min' : 'maj'}`,
    camelot: (key.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pc],
  };
}

/** Semitones of pitch shift produced by a playback rate. */
export const semitonesForRate = (rate) => 12 * Math.log2(Math.max(0.01, rate));

/** The key a deck is actually sounding at, given its playback rate. */
export function keyAtRate(key, rate) {
  return transpose(key, semitonesForRate(rate));
}

/**
 * How well two keys sit together.
 * @returns {{ok:boolean, score:number, relation:string}}
 */
export function compatibility(a, b) {
  if (!a || !b) return { ok: false, score: 0, relation: 'unknown' };
  if (a.pc === b.pc && a.minor === b.minor) return { ok: true, score: 1, relation: 'same key' };
  if (a.pc === b.pc) return { ok: true, score: 0.85, relation: 'same root, other mode' };

  const num = (k) => parseInt(k.camelot, 10);
  const da = num(a);
  const db = num(b);
  const step = Math.min(mod(da - db, 12), mod(db - da, 12));

  // Relative major/minor is the same wheel number in the other mode.
  if (step === 0 && a.minor !== b.minor) return { ok: true, score: 0.9, relation: 'relative major/minor' };
  if (step === 1 && a.minor === b.minor) return { ok: true, score: 0.8, relation: 'adjacent on the wheel' };
  if (step === 2 && a.minor === b.minor) return { ok: false, score: 0.45, relation: 'two steps apart' };
  return { ok: false, score: Math.max(0, 0.4 - step * 0.05), relation: `${step} steps apart` };
}

/** Human-readable summary for the UI. */
export function describePair(a, b) {
  const c = compatibility(a, b);
  if (!a || !b) return 'key unknown';
  return `${a.camelot} + ${b.camelot} — ${c.relation}`;
}

/**
 * Work out what, if anything, to do about two decks' keys.
 *
 * The hard constraint is that these decks pitch-shift by resampling: there is
 * no key lock, so the only way to move a track's key is to change its speed,
 * and moving a key by one semitone costs about 6 % tempo. Beat-matching and
 * key-matching therefore pull against each other, and any honest "auto tune"
 * has to say which one it is giving up.
 *
 * This returns a plan rather than acting, so the caller can apply it, show it,
 * or refuse it. `tempoPercent` is an absolute tempo-fader position for the
 * deck being adjusted, not a delta.
 *
 * @param {object} liveKey     sounding key of the deck being matched to
 * @param {object} otherKey    detected key of the deck to adjust
 * @param {object} opts
 * @param {number} opts.matchedPercent tempo % that beat-matches the two decks
 * @param {number} opts.tempoRange     the deck's ± tempo fader range
 * @param {number} [opts.bpmTolerance] how much beat-match drift is acceptable,
 *   in percent. Below ~1 % two tracks audibly drift apart within a phrase.
 */
export function planKeyMatch(liveKey, otherKey, { matchedPercent, tempoRange, bpmTolerance = 1.5 }) {
  if (!liveKey || !otherKey) {
    return { action: 'none', reason: 'key not detected on both decks', tempoPercent: matchedPercent };
  }

  const atMatched = transpose(otherKey, semitonesForRate(1 + matchedPercent / 100));
  const already = compatibility(liveKey, atMatched);
  if (already.ok) {
    return {
      action: 'none',
      reason: `already ${already.relation} at the matched tempo`,
      tempoPercent: matchedPercent,
      relation: already.relation,
    };
  }

  // Try each whole-semitone shift the fader can actually reach, nearest first.
  const options = [];
  for (let n = -2; n <= 2; n++) {
    if (!n) continue;
    const rate = (1 + matchedPercent / 100) * Math.pow(2, n / 12);
    const percent = (rate - 1) * 100;
    if (Math.abs(percent) > tempoRange) continue;
    const c = compatibility(liveKey, transpose(otherKey, semitonesForRate(rate)));
    if (!c.ok) continue;
    options.push({ n, percent, cost: Math.abs(percent - matchedPercent), relation: c.relation, score: c.score });
  }
  options.sort((a, b) => a.cost - b.cost || b.score - a.score);
  const best = options[0];

  if (!best) {
    return {
      action: 'none',
      reason: `no compatible key within ±${tempoRange}% — ${already.relation}`,
      tempoPercent: matchedPercent,
      relation: already.relation,
    };
  }

  // A shift big enough to break the beat-match is offered, never applied
  // silently: losing the beat is far more audible than a key clash.
  if (best.cost > bpmTolerance) {
    return {
      action: 'offer',
      reason: `${best.relation} needs ${best.cost.toFixed(1)}% tempo — that would break the beat-match`,
      tempoPercent: matchedPercent,
      offerPercent: best.percent,
      relation: best.relation,
      cost: best.cost,
    };
  }

  return {
    action: 'retune',
    reason: `nudged ${best.cost.toFixed(2)}% to reach ${best.relation}`,
    tempoPercent: best.percent,
    relation: best.relation,
    cost: best.cost,
  };
}
