/**
 * Offline analysis of a decoded AudioBuffer: waveform peaks, tempo estimate,
 * song structure (sections, phrases, mix points) and musical key. All of it
 * only runs on the WebAudio path (i.e. when we actually hold the samples).
 */

const SR = 22050; // analysis sample rate for all offline renders
const HOP = 256; // envelope hop → ~86 envelope frames per second

/**
 * Min/max envelope, `buckets` columns wide, for waveform drawing.
 * @returns {Float32Array} interleaved [min0, max0, min1, max1, ...]
 */
export function waveformPeaks(buffer, buckets = 900) {
  const chans = Math.min(buffer.numberOfChannels, 2);
  const len = buffer.length;
  const out = new Float32Array(buckets * 2);
  const step = Math.max(1, Math.floor(len / buckets));
  const data = [];
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));

  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(len, start + step);
    let min = 0;
    let max = 0;
    // Stride within the bucket: a full scan of every sample buys no visible
    // accuracy for a ~900px waveform and costs real time on long tracks.
    const stride = Math.max(1, Math.floor((end - start) / 400));
    for (let i = start; i < end; i += stride) {
      let v = 0;
      for (let c = 0; c < chans; c++) v += data[c][i];
      v /= chans;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/** Integrated loudness proxy (RMS) — used for auto-gain / trim suggestion. */
export function rms(buffer) {
  const d = buffer.getChannelData(0);
  const stride = Math.max(1, Math.floor(d.length / 200_000));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += stride) {
    sum += d[i] * d[i];
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * Tempo + beat-phase estimate.
 *
 * Pipeline: onset envelope from two band renders (kick band 30–150 Hz plus a
 * bright band above 1.5 kHz for snares/hats) → autocorrelation with a harmonic
 * comb over 60–180 BPM → fine period search (~0.02 BPM) by projecting the
 * envelope onto fractional beat grids, which yields the grid phase for free.
 * `beatOffset` is the absolute track time (seconds) of a detected beat, so
 * SYNC can align two decks on their real grids instead of guessing from t=0.
 *
 * @returns {Promise<{bpm:number, confidence:number, beatOffset:number|null, candidates:Array}>}
 */
/**
 * Two-band onset envelopes (kick 30–150 Hz + brightness > 1.5 kHz), shared by
 * the tempo detector (short window) and the structure analysis (full track).
 * @returns {Promise<{env:Float32Array, envLo:Float32Array, envRate:number,
 *   n:number, skip:number}|null>}
 */
async function bandEnvelopes(buffer, { skip = 0, dur = buffer.duration } = {}) {
  const frames = Math.floor(dur * SR);
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx || frames < SR * 4) return null;

  const renderBand = async (build) => {
    const off = new OfflineCtx(1, frames, SR);
    const src = off.createBufferSource();
    src.buffer = buffer;
    let node = src;
    for (const next of build(off)) {
      node.connect(next);
      node = next;
    }
    node.connect(off.destination);
    src.start(0, skip);
    return (await off.startRendering()).getChannelData(0);
  };

  const [lowBand, highBand] = await Promise.all([
    renderBand((off) => {
      const lp = off.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 150;
      lp.Q.value = 1;
      const hp = off.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 30;
      hp.Q.value = 1;
      return [lp, hp];
    }),
    renderBand((off) => {
      const hp = off.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      hp.Q.value = 0.7;
      return [hp];
    }),
  ]);

  // Onset envelope: per-frame energy, half-wave rectified delta (spectral-flux
  // style, but per band in the time domain — cheap and good enough here).
  const envRate = SR / HOP;
  const n = Math.floor(lowBand.length / HOP) - 1;
  if (n < envRate * 8) return null;
  const env = new Float32Array(n);
  const envLo = new Float32Array(n); // kick-only flux, for the downbeat vote
  let prevLo = 0;
  let prevHi = 0;
  for (let f = 0; f < n; f++) {
    const o = f * HOP;
    let elo = 0;
    let ehi = 0;
    for (let i = 0; i < HOP; i++) {
      const a = lowBand[o + i];
      elo += a * a;
      const b = highBand[o + i];
      ehi += b * b;
    }
    envLo[f] = Math.max(0, elo - prevLo);
    env[f] = envLo[f] + 0.6 * Math.max(0, ehi - prevHi);
    prevLo = elo;
    prevHi = ehi;
  }
  let maxE = 0;
  let maxLo = 0;
  for (let f = 0; f < n; f++) {
    if (env[f] > maxE) maxE = env[f];
    if (envLo[f] > maxLo) maxLo = envLo[f];
  }
  if (maxE <= 0) return null;
  // sqrt compression: one monster hit must not outvote the steady grid.
  for (let f = 0; f < n; f++) {
    env[f] = Math.sqrt(env[f] / maxE);
    envLo[f] = maxLo > 0 ? Math.sqrt(envLo[f] / maxLo) : 0;
  }
  return { env, envLo, envRate, n, skip };
}

export async function detectBpm(buffer) {
  const empty = { bpm: 0, confidence: 0, beatOffset: null, candidates: [] };
  if (!buffer || buffer.length < buffer.sampleRate * 4) return empty;

  // Analyse at most 90 s from 10 % in — skips intros and keeps it fast.
  const skip = Math.floor(buffer.duration * 0.1);
  const dur = Math.min(90, Math.max(10, buffer.duration - skip));
  const bands = await bandEnvelopes(buffer, { skip, dur });
  if (!bands) return empty;
  const { env, envLo, envRate, n } = bands;

  // Autocorrelation, extended to 3× the base lag so the comb can look at
  // harmonics without falling off the end of the array.
  const lagMin = Math.max(2, Math.floor((envRate * 60) / 180));
  const lagMax = Math.ceil((envRate * 60) / 60);
  const lagTop = Math.min(n - 1, lagMax * 3 + 2);
  const ac = new Float32Array(lagTop + 1);
  for (let lag = lagMin; lag <= lagTop; lag++) {
    let s = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) s += env[i] * env[i + lag];
    ac[lag] = m > 0 ? s / m : 0;
  }

  // Mild log-normal prior around 120 BPM — a nudge, not a straitjacket.
  const prior = (bpm) => Math.exp(-Math.pow(Math.log2(bpm / 120), 2) / (2 * 0.75 * 0.75));
  const combAt = (lag) => (ac[lag] || 0) + 0.5 * (ac[lag * 2] || 0) + 0.33 * (ac[lag * 3] || 0);

  let bestLag = 0;
  let bestScore = -1;
  const scored = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * envRate) / lag;
    const s = combAt(lag) * prior(bpm);
    scored.push({ bpm, s });
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (!bestLag) return empty;

  // Fold the coarse candidate into the DJ-typical window before refining.
  let coarse = (60 * envRate) / bestLag;
  while (coarse < 75) coarse *= 2;
  while (coarse > 170) coarse /= 2;

  // Fine search: project the envelope onto beat grids of fractional period,
  // best mean onset energy wins. Gives sub-0.05-BPM period and the phase.
  const envAt = (x) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= n) return 0;
    const fr = x - i;
    return env[i] * (1 - fr) + env[i + 1] * fr;
  };
  const gridScore = (periodFrames) => {
    const beats = Math.floor((n - 1) / periodFrames);
    if (beats < 8) return { energy: 0, phase: 0 };
    const phases = 32;
    let bestE = 0;
    let bestP = 0;
    for (let p = 0; p < phases; p++) {
      const off = (p / phases) * periodFrames;
      let s = 0;
      for (let k = 0; k < beats; k++) s += envAt(off + k * periodFrames);
      if (s > bestE) {
        bestE = s;
        bestP = off;
      }
    }
    return { energy: bestE / beats, phase: bestP };
  };

  let best = { bpm: coarse, energy: -1, phase: 0 };
  for (let bpm = coarse - 1.2; bpm <= coarse + 1.2; bpm += 0.02) {
    const { energy, phase } = gridScore((envRate * 60) / bpm);
    if (energy > best.energy) best = { bpm, energy, phase };
  }

  // Metrical-relative check on the refined value: half/double catches octave
  // errors, the 2:3 pair catches shuffle/dotted grids (92.5 vs 138.75 BPM).
  // Only switch when clearly better — sparser grids score a higher mean by
  // construction, so the margin is the guard against always halving.
  for (const factor of [0.5, 2, 2 / 3, 1.5]) {
    const alt = best.bpm * factor;
    if (alt < 75 || alt > 170) continue;
    const fine = gridScore((envRate * 60) / alt);
    if (fine.energy > best.energy * 1.12) best = { bpm: alt, energy: fine.energy, phase: fine.phase };
  }

  let globalMean = 0;
  for (let f = 0; f < n; f++) globalMean += env[f];
  globalMean /= n;
  const ratio = globalMean > 0 ? best.energy / globalMean : 0;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 3));

  // Downbeat vote: of the four beat phase classes, bar-1 is the one carrying
  // the most kick energy. Crude but right more often than a coin for 4/4
  // electronic material; the DROP still lands on *a* grid line either way.
  const periodF = (envRate * 60) / best.bpm;
  const loAt = (x) => {
    const i = Math.floor(x);
    if (i < 0 || i + 1 >= n) return 0;
    const fr = x - i;
    return envLo[i] * (1 - fr) + envLo[i + 1] * fr;
  };
  const clsSum = [0, 0, 0, 0];
  const clsCount = [0, 0, 0, 0];
  for (let k = 0; best.phase + k * periodF < n; k++) {
    clsSum[k % 4] += loAt(best.phase + k * periodF);
    clsCount[k % 4]++;
  }
  let downbeatClass = 0;
  let bestCls = -1;
  for (let c = 0; c < 4; c++) {
    const v = clsCount[c] ? clsSum[c] / clsCount[c] : 0;
    if (v > bestCls) {
      bestCls = v;
      downbeatClass = c;
    }
  }

  // v4: dynamic-programming beat tracking (Ellis-style) on top of the comb
  // estimate. The comb+fine search nails a single static tempo; the DP walks
  // the envelope beat by beat, so drifting material (live recordings, vinyl
  // rips) yields real beat TIMES and a drift measure instead of a lie.
  // (`periodF` is the downbeat vote's period, declared above.)
  const beatFrames = dpBeats(env, periodF);
  const beatTimes = beatFrames.map((f) => skip + (f * HOP) / SR);
  // Drift = |slope| of a least-squares line over the beat intervals, scaled
  // to the whole window. Intervals are quantized to whole envelope frames
  // (a 41.67-frame period reads as mixed 41s and 42s), so percentile spread
  // would report ~2.4% on a rock-steady track; the regression slope averages
  // that zero-mean noise away and captures the monotonic glide that matters.
  let driftPct = 0;
  if (beatFrames.length > 16) {
    const iv = [];
    for (let i = 1; i < beatFrames.length; i++) iv.push(beatFrames[i] - beatFrames[i - 1]);
    const m = iv.length;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < m; i++) {
      mx += i;
      my += iv[i];
    }
    mx /= m;
    my /= m;
    let num = 0;
    let den = 0;
    for (let i = 0; i < m; i++) {
      num += (i - mx) * (iv[i] - my);
      den += (i - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    if (my > 0) driftPct = Math.round(Math.abs((slope * (m - 1)) / my) * 1000) / 10;
  }

  const beatOffset = skip + (best.phase * HOP) / SR;
  const candidates = scored
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map(({ bpm, s }) => ({ bpm: Math.round(bpm * 2) / 2, count: s }));

  return {
    bpm: Math.round(best.bpm * 100) / 100,
    confidence,
    beatOffset,
    barOffset: beatOffset + downbeatClass * (60 / best.bpm),
    candidates,
    beatTimes,
    driftPct,
  };
}

/**
 * Ellis-style dynamic-programming beat tracker: every envelope frame scores
 * as onset strength plus the best predecessor half to one-and-a-half periods
 * back, minus a log-squared penalty for deviating from the nominal period.
 * Backtracking from the best endpoint yields the beat frame sequence. The
 * penalty weight is tuned so a few-percent glide costs less than a weak
 * onset (drift is followed) while octave jumps stay prohibitive.
 */
function dpBeats(env, periodF) {
  const n = env.length;
  const lo = Math.max(2, Math.floor(periodF * 0.5));
  const hi = Math.min(n - 1, Math.ceil(periodF * 1.5));
  if (n < hi + 2) return [];
  const ALPHA = 120;
  const score = new Float32Array(n);
  const from = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) score[i] = env[i];
  for (let i = lo; i < n; i++) {
    let bestS = -Infinity;
    let bestJ = -1;
    const a = Math.max(0, i - hi);
    const b = i - lo;
    for (let j = a; j <= b; j++) {
      const dev = Math.log((i - j) / periodF);
      const s = score[j] - ALPHA * dev * dev;
      if (s > bestS) {
        bestS = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && bestS > 0) {
      score[i] = env[i] + bestS;
      from[i] = bestJ;
    }
  }
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - 2 * Math.ceil(periodF)); i < n; i++) {
    if (score[i] > bestEnd) {
      bestEnd = score[i];
      end = i;
    }
  }
  const beats = [];
  for (let i = end; i >= 0; i = from[i]) {
    beats.push(i);
    if (from[i] < 0) break;
  }
  return beats.reverse();
}

/**
 * Song structure on the bar grid: per-bar energy, sections, phrase length and
 * the two points a DJ actually needs — where to mix IN to this track and
 * where to mix OUT of it. Everything is bar-snapped on the track's own grid.
 * Heuristics for 4/4 electronic material; `confidence` gates all downstream
 * use, so a wrong guess degrades to today's fixed-offset behaviour.
 */
export async function analyzeStructure(buffer, { bpm, beatOffset, barOffset } = {}) {
  const none = { ok: false };
  if (!buffer || !(bpm > 40) || !Number.isFinite(beatOffset ?? NaN)) return none;
  const bands = await bandEnvelopes(buffer, { skip: 0, dur: buffer.duration });
  if (!bands) return none;
  const { env, envLo, envRate, n } = bands;

  const barLen = 4 * (60 / bpm);
  const anchorRaw = Number.isFinite(barOffset) ? barOffset : beatOffset;
  const firstBar = anchorRaw - Math.floor(anchorRaw / barLen) * barLen;
  const barCount = Math.floor((buffer.duration - firstBar) / barLen);
  if (barCount < 12) return none;

  // Per-bar mean of both envelopes, then a 4-bar moving average — structure
  // lives at the bar scale, individual hits are noise here.
  const eBar = new Float32Array(barCount);
  const eLoBar = new Float32Array(barCount);
  for (let b = 0; b < barCount; b++) {
    const f0 = Math.max(0, Math.floor((firstBar + b * barLen) * envRate));
    const f1 = Math.min(n, Math.floor((firstBar + (b + 1) * barLen) * envRate));
    let s = 0;
    let sLo = 0;
    let m = 0;
    for (let f = f0; f < f1; f++) {
      s += env[f];
      sLo += envLo[f];
      m++;
    }
    eBar[b] = m ? s / m : 0;
    eLoBar[b] = m ? sLo / m : 0;
  }
  // Symmetric 3-bar smoothing: enough to kill per-bar noise without smearing
  // section boundaries off the phrase grid (an asymmetric window shifts them).
  const smooth = (a) => {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0;
      let m = 0;
      for (let k = -1; k <= 1; k++) {
        const j = i + k;
        if (j >= 0 && j < a.length) {
          s += a[j];
          m++;
        }
      }
      out[i] = m ? s / m : 0;
    }
    return out;
  };
  const quantile = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  };
  const norm = (arr) => {
    const hi = quantile(arr, 0.95) || 1;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Math.min(1, arr[i] / hi);
    return out;
  };
  const NE = norm(smooth(eBar));
  const NLo = norm(smooth(eLoBar));

  // Classify bars by kick presence and overall energy, then merge short runs.
  const hiThr = quantile(NLo, 0.6);
  const quietThr = quantile(NE, 0.25);
  const kindOf = (b) =>
    NE[b] < quietThr * 1.05 ? 'quiet' : NLo[b] >= hiThr ? 'high' : 'steady';
  const runs = [];
  for (let b = 0; b < barCount; b++) {
    const kind = kindOf(b);
    if (runs.length && runs[runs.length - 1].kind === kind) runs[runs.length - 1].endBar = b + 1;
    else runs.push({ startBar: b, endBar: b + 1, kind });
  }
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].endBar - runs[i].startBar >= 4 || runs.length === 1) continue;
    const into = i > 0 ? runs[i - 1] : runs[i + 1];
    into.startBar = Math.min(into.startBar, runs[i].startBar);
    into.endBar = Math.max(into.endBar, runs[i].endBar);
    runs.splice(i, 1);
    if (i > 0 && i < runs.length && runs[i - 1].kind === runs[i].kind) {
      runs[i - 1].endBar = runs[i].endBar;
      runs.splice(i, 1);
    }
  }
  const sections = runs.map((r) => ({ ...r }));
  for (const s of sections) {
    if (s.kind !== 'quiet') continue;
    if (s.startBar === 0) s.kind = 'intro';
    else if (s.endBar >= barCount) s.kind = 'outro';
    else s.kind = 'breakdown';
  }

  // Phrase grid from bar-novelty: where the arrangement changes, energy jumps.
  const nov = new Float32Array(barCount);
  for (let b = 1; b < barCount; b++) {
    nov[b] = Math.max(0, NE[b] - NE[b - 1]) + 0.5 * Math.max(0, NLo[b] - NLo[b - 1]);
  }
  const novAc = (lag) => {
    let s = 0;
    let m = 0;
    for (let b = 0; b + lag < barCount; b++) {
      s += nov[b] * nov[b + lag];
      m++;
    }
    let e = 0;
    for (let b = 0; b < barCount; b++) e += nov[b] * nov[b];
    return m && e ? s / m / (e / barCount) : 0;
  };
  const r16 = novAc(16);
  const r32 = barCount >= 48 ? novAc(32) : 0;
  const phraseBars = r32 > r16 * 1.15 ? 32 : 16;
  let phraseOffset = 0;
  let bestNov = -1;
  for (let o = 0; o < phraseBars; o++) {
    let s = 0;
    let m = 0;
    for (let b = o; b < barCount; b += phraseBars) {
      s += nov[b];
      m++;
    }
    const v = m ? s / m : 0;
    if (v > bestNov) {
      bestNov = v;
      phraseOffset = o;
    }
  }
  const phraseFloor = (bar) =>
    Math.max(0, phraseOffset + Math.floor((bar - phraseOffset) / phraseBars) * phraseBars);
  const phraseRound = (bar) =>
    Math.max(0, phraseOffset + Math.round((bar - phraseOffset) / phraseBars) * phraseBars);

  // Mix points. IN: one phrase before the first high section, so a blend runs
  // through the build and lands the energy right as the old track leaves.
  // OUT: the phrase boundary at the outro — ride the outro, not the last drop.
  const firstHigh = sections.find((s) => s.kind === 'high');
  const intro = sections[0].kind === 'intro' ? sections[0] : null;
  let mixInBar = 0;
  if (firstHigh) mixInBar = phraseFloor(Math.max(0, firstHigh.startBar - phraseBars));
  else if (intro) mixInBar = Math.min(barCount - 1, intro.endBar);
  const outro = sections[sections.length - 1].kind === 'outro'
    ? sections[sections.length - 1] : null;
  let mixOutBar = outro ? phraseRound(outro.startBar) : 0;
  const fallbackOut = Math.max(0, barCount - Math.ceil(12 / barLen));
  if (!outro || mixOutBar <= mixInBar + phraseBars / 2 || mixOutBar >= barCount) {
    mixOutBar = Math.max(mixInBar + 1, fallbackOut);
  }

  const meanRange = (arr, a, b) => {
    let s = 0;
    let m = 0;
    for (let i = Math.max(0, a); i < Math.min(arr.length, b); i++) {
      s += arr[i];
      m++;
    }
    return m ? s / m : 0;
  };
  const energyIn = meanRange(NE, mixInBar, mixInBar + 4);
  const energyOut = meanRange(NE, mixOutBar - 4, mixOutBar);

  // Confidence: does the track HAVE contrasting sections, and does the
  // arrangement repeat on a phrase grid? Flat or free-form material scores
  // low and every consumer falls back to the fixed-offset behaviour.
  const contrast = Math.max(0, Math.min(1, (quantile(NLo, 0.75) - quantile(NLo, 0.25)) * 2.5));
  const phraseStrength = Math.max(0, Math.min(1, Math.max(r16, r32)));
  const confidence = Math.max(0, Math.min(1, 0.6 * contrast + 0.4 * phraseStrength));

  return {
    ok: true,
    barLen,
    firstBar,
    barCount,
    energy: NE,
    energyLo: NLo,
    sections,
    phraseBars,
    phraseOffset,
    mixInBar,
    mixInSec: firstBar + mixInBar * barLen,
    mixOutBar,
    mixOutSec: firstBar + mixOutBar * barLen,
    energyIn,
    energyOut,
    confidence,
  };
}

/* ------------------------------- key ------------------------------- */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
// Krumhansl-Kessler tonal profiles — the standard template for key finding.
const KRUM_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUM_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function camelotFor(pitchClass, mode) {
  if (!(pitchClass >= 0 && pitchClass < 12)) return '';
  return (mode === 'major' ? CAMELOT_MAJOR : CAMELOT_MINOR)[pitchClass];
}

/** Rebuild the full key object from its cached tuple. */
export function keyObject(pitchClass, mode, confidence) {
  return {
    pitchClass,
    mode,
    camelot: camelotFor(pitchClass, mode),
    name: `${NOTE_NAMES[pitchClass]} ${mode}`,
    confidence,
  };
}

/**
 * Musical key via a Goertzel chromagram: ~60 s from 25 % in, Hann-windowed
 * 4096-sample frames, the 36 semitone frequencies C2–B4 folded into 12 pitch
 * classes, correlated against the Krumhansl profiles in all 24 rotations.
 * The frame loop yields to the event loop every few frames — this runs on
 * the main thread and must not starve the UI.
 */
export async function detectKey(buffer) {
  const none = { pitchClass: -1, mode: '', camelot: '', name: '', confidence: 0 };
  if (!buffer || buffer.duration < 15 || buffer.duration > 720) return none;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return none;

  const skip = buffer.duration * 0.25;
  const dur = Math.min(60, buffer.duration - skip);
  const off = new OfflineCtx(1, Math.floor(dur * SR), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0, skip);
  const data = (await off.startRendering()).getChannelData(0);

  const N = 4096;
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const coef = [];
  for (let st = 0; st < 36; st++) {
    const f = 65.406 * Math.pow(2, st / 12); // C2 … B4
    coef.push(2 * Math.cos((2 * Math.PI * f) / SR));
  }

  const chroma = new Float64Array(12);
  const win = new Float32Array(N);
  const frames = Math.floor(data.length / N);
  if (frames < 4) return none;
  for (let fr = 0; fr < frames; fr++) {
    const o = fr * N;
    for (let i = 0; i < N; i++) win[i] = data[o + i] * hann[i];
    for (let k = 0; k < 36; k++) {
      const c = coef[k];
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < N; i++) {
        const s0 = win[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - c * s1 * s2;
      chroma[k % 12] += Math.sqrt(Math.max(0, power));
    }
    if ((fr & 15) === 15) await new Promise((r) => setTimeout(r, 0));
  }

  const pearson = (a, b) => {
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < 12; i++) {
      ma += a[i];
      mb += b[i];
    }
    ma /= 12;
    mb /= 12;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    const den = Math.sqrt(da * db);
    return den > 0 ? num / den : 0;
  };

  let best = { corr: -2, pitchClass: -1, mode: '' };
  let second = -2;
  const rotated = new Float64Array(12);
  for (const [mode, prof] of [['major', KRUM_MAJOR], ['minor', KRUM_MINOR]]) {
    for (let rot = 0; rot < 12; rot++) {
      for (let i = 0; i < 12; i++) rotated[i] = prof[(i - rot + 12) % 12];
      const c = pearson(chroma, rotated);
      if (c > best.corr) {
        second = best.corr;
        best = { corr: c, pitchClass: rot, mode };
      } else if (c > second) {
        second = c;
      }
    }
  }
  if (best.pitchClass < 0) return none;
  const confidence = Math.max(0, Math.min(1, (best.corr - second) * 5));
  return keyObject(best.pitchClass, best.mode, confidence);
}
