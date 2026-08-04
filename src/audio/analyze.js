/**
 * Offline analysis of a decoded AudioBuffer: waveform peaks + tempo estimate.
 * Both only run on the WebAudio path (i.e. when we actually hold the samples).
 */

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
export async function detectBpm(buffer) {
  const empty = { bpm: 0, confidence: 0, beatOffset: null, candidates: [] };
  if (!buffer || buffer.length < buffer.sampleRate * 4) return empty;

  // Analyse at most 90 s from 10 % in — skips intros and keeps it fast.
  const sr = 22050;
  const skip = Math.floor(buffer.duration * 0.1);
  const dur = Math.min(90, Math.max(10, buffer.duration - skip));
  const frames = Math.floor(dur * sr);

  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return empty;

  const renderBand = async (build) => {
    const off = new OfflineCtx(1, frames, sr);
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
  const HOP = 256;
  const envRate = sr / HOP;
  const n = Math.floor(lowBand.length / HOP) - 1;
  if (n < envRate * 8) return empty;
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
  if (maxE <= 0) return empty;
  // sqrt compression: one monster hit must not outvote the steady grid.
  for (let f = 0; f < n; f++) {
    env[f] = Math.sqrt(env[f] / maxE);
    envLo[f] = maxLo > 0 ? Math.sqrt(envLo[f] / maxLo) : 0;
  }

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

  const beatOffset = skip + (best.phase * HOP) / sr;
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
  };
}
