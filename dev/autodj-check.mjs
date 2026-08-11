/**
 * E2E for the Auto-DJ layer: analysis v2 (structure, phrases, key, cache).
 *
 * Runs on synthetic WAV fixtures with KNOWN structure and key, so every
 * assertion has a ground truth: quiet chord-only intro/outro, a kicking body
 * with a hat-pattern change every 16 bars (gives the phrase estimator its
 * periodicity), an accented beat 1 (pins the downbeat vote).
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/autodj-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/autodj';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/**
 * Structured test track: intro (quiet chords, no kick) → body (kick on
 * quarters with an accented 1, hats whose density flips every 16 bars,
 * chords) → outro (quiet chords). Root is a pitch class (C=0); major triads.
 */
function makeStructuredWav({ bpm = 124, introBars = 8, bodyBars = 48, outroBars = 8,
  root = 0, sr = 44100 } = {}) {
  const beat = 60 / bpm;
  const barLen = 4 * beat;
  const totalBars = introBars + bodyBars + outroBars;
  const n = Math.floor(totalBars * barLen * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);

  // Triad root around octave 4 — deliberately ABOVE the detector's 30-150 Hz
  // kick band, so steady chord tones cannot contaminate the tempo comb.
  const f0 = 261.63 * Math.pow(2, root / 12);
  const triad = [0, 4, 7].map((st) => f0 * Math.pow(2, st / 12));

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bar = Math.floor(t / barLen);
    const beatIdx = Math.floor(t / beat) % 4;
    const tin = t % beat;
    const inBody = bar >= introBars && bar < introBars + bodyBars;
    let v = 0;
    const amp = inBody ? 0.1 : 0.06;
    for (const f of triad) v += amp * Math.sin(2 * Math.PI * f * t);
    v += (inBody ? 0.08 : 0.05) * Math.sin(2 * Math.PI * f0 * 2 * t);
    if (inBody) {
      if (tin < 0.09) {
        const kickAmp = beatIdx === 0 ? 1.0 : 0.7; // accent bar-1 for the downbeat vote
        v += Math.sin(2 * Math.PI * 60 * tin) * Math.exp(-tin * 40) * kickAmp;
      }
      const bodyBar = bar - introBars;
      const hatRate = Math.floor(bodyBar / 16) % 2 === 0 ? 2 : 4; // per beat
      const hin = t % (beat / hatRate);
      if (hin < 0.012) v += (Math.random() * 2 - 1) * Math.exp(-hin * 400) * 0.25;
    }
    buf.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, 44 + i * 2);
  }
  return buf;
}

const FIX_A = { name: 'KeyC - Alpha.wav', bpm: 124, root: 0, camelot: '8B' };
const FIX_B = { name: 'KeyG - Beta.wav', bpm: 120, root: 7, camelot: '9B' };

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.deck-A', { timeout: 15000 });
await frame.locator('.tab').first().click();

/** Load a fixture onto deck A via the local-file input and await analysis. */
async function loadFixture(fix) {
  await frame.locator('input.local-input').setInputFiles({
    name: fix.name,
    mimeType: 'audio/wav',
    buffer: makeStructuredWav({ bpm: fix.bpm, root: fix.root }),
  });
  await frame.locator('.track-row', { hasText: fix.name.replace('.wav', '').split(' - ')[1] })
    .first().locator('.load-a').click();
  await frame.waitForFunction(() => {
    const d = window.__djclanker.decks.A;
    return d.status === 'ready' && d.backend === 'buffer' && d.structure !== null
      && d.musicalKey !== null;
  }, undefined, { timeout: 120000 });
  return frame.evaluate(() => {
    const d = window.__djclanker.decks.A;
    return {
      bpm: d.bpm,
      barOffset: d.barOffset,
      fromCache: d._analysisFromCache,
      key: d.musicalKey,
      s: {
        ok: d.structure.ok,
        firstBar: d.structure.firstBar,
        barLen: d.structure.barLen,
        barCount: d.structure.barCount,
        phraseBars: d.structure.phraseBars,
        phraseOffset: d.structure.phraseOffset,
        mixInBar: d.structure.mixInBar,
        mixInSec: d.structure.mixInSec,
        mixOutBar: d.structure.mixOutBar,
        energyIn: d.structure.energyIn,
        energyOut: d.structure.energyOut,
        confidence: d.structure.confidence,
        kinds: d.structure.sections.map((x) => x.kind),
      },
    };
  });
}

/* ------------------------- fixture A: analysis ------------------------- */

const a = await loadFixture(FIX_A);
check('fixture loads in FULL mode with structure and key', a.s.ok === true);
check('BPM detected within ±0.15', Math.abs(a.bpm - FIX_A.bpm) <= 0.15, `${a.bpm}`);
check('key is C major / 8B', a.key.camelot === FIX_A.camelot && a.key.mode === 'major',
  `${a.key.name} (${a.key.camelot})`);
check('key confidence usable', a.key.confidence > 0.25, a.key.confidence.toFixed(2));
check('structure confidence clears the blend gate', a.s.confidence > 0.35,
  a.s.confidence.toFixed(2));
check('phrase length is 16 bars', a.s.phraseBars === 16, `${a.s.phraseBars}`);
check('sections read intro → … → outro with a high middle',
  a.s.kinds[0] === 'intro' && a.s.kinds[a.s.kinds.length - 1] === 'outro'
  && a.s.kinds.includes('high'), a.s.kinds.join(' → '));
check('mix-in sits at/near the top (8-bar intro is the ramp)', a.s.mixInBar <= 1,
  `bar ${a.s.mixInBar}`);
check('mix-out lands on the outro phrase (bar 56 ± 1)', Math.abs(a.s.mixOutBar - 56) <= 1,
  `bar ${a.s.mixOutBar}`);
const snap = ((a.s.mixInSec - a.s.firstBar) % a.s.barLen + a.s.barLen) % a.s.barLen;
check('mix-in is bar-snapped on the grid', snap < 0.001 || a.s.barLen - snap < 0.001,
  `${(snap * 1000).toFixed(2)} ms off`);
check('energy rises from mix-in to mix-out', a.s.energyIn < a.s.energyOut,
  `${a.s.energyIn.toFixed(2)} → ${a.s.energyOut.toFixed(2)}`);

/* --------------------------- cache round-trip --------------------------- */

const cachedBefore = await frame.evaluate(() =>
  window.__djclanker.decks.A._analysisFromCache);
check('first analysis ran fresh (not from cache)', cachedBefore === false);

const a2 = await loadFixture(FIX_A); // same name+size → same cache id
check('reload hits the analysis cache', a2.fromCache === true);
check('cached BPM and key survive the round-trip',
  Math.abs(a2.bpm - FIX_A.bpm) <= 0.15 && a2.key.camelot === FIX_A.camelot,
  `${a2.bpm} · ${a2.key.camelot}`);

/* ------------------------- fixture B: second key ------------------------- */

const b = await loadFixture(FIX_B);
check('second fixture: BPM 120 and G major / 9B',
  Math.abs(b.bpm - FIX_B.bpm) <= 0.15 && b.key.camelot === FIX_B.camelot,
  `${b.bpm} · ${b.key.name} (${b.key.camelot})`);

await frame.evaluate(() => window.__djclanker.decks.A.pause());
await page.screenshot({ path: `${OUT}-analysis.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
