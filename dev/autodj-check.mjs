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
  // The pick triggers a list re-render; clicking into it mid-render detaches
  // the row under the pointer. Let the DOM settle first.
  await page.waitForTimeout(300);
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

/* --------------------- part 2: the transition engine --------------------- */
// Fixture B is already on deck A; put fixture A onto deck B so the pair is
// 124 vs 120 BPM (foldable, camelot-adjacent) with known structure.

await frame.locator('.track-row', { hasText: 'Alpha' }).first().locator('.load-b').click();
await frame.waitForFunction(() => {
  const d = window.__djclanker.decks.B;
  return d.status === 'ready' && d._analysisDone;
}, undefined, { timeout: 120000 });

// Planner rules, asserted pure — no audio needs to run for these.
const planner = await frame.evaluate(() => {
  const { decks, planTransition } = window.__djclanker;
  const live = decks.A;
  const idle = decks.B;
  const auto = planTransition(live, idle, { style: 'auto' });
  const savedRange = idle.tempoRange;
  idle.tempoRange = 1; // 124 vs 120 needs ~3.3% — now unreachable
  const echo = planTransition(live, idle, { style: 'auto' });
  idle.tempoRange = savedRange;
  const savedSt = idle.structure;
  idle.structure = null;
  const fady = planTransition(live, idle, { style: 'auto' });
  idle.structure = savedSt;
  return {
    auto: { style: auto.style, hasTimes: auto.startSec < auto.swapSec && auto.swapSec < auto.endSec },
    echoStyle: echo.style,
    fadeStyle: fady.style,
    fadeReason: fady.reasons.join(','),
  };
});
check('planner picks BLEND for a compatible structured pair',
  planner.auto.style === 'blend' && planner.auto.hasTimes, planner.auto.style);
check('planner degrades to ECHO when tempo is unreachable', planner.echoStyle === 'echo');
check('planner degrades to FADE without structure', planner.fadeStyle === 'fade',
  planner.fadeReason);

/**
 * Drive one automated transition. Seeks the live deck near its planned blend
 * window so the suite does not sit through whole tracks, then waits for the
 * handover and returns telemetry plus the assertions' raw material.
 */
async function runTransition({ nudgeXfMidway = false } = {}) {
  return frame.evaluate(async (nudge) => {
    const dj = window.__djclanker;
    const am = dj.automix;
    const live = am.liveDeck;
    const idle = am.idleDeck;
    // Jump to 30 bars before mix-out: enough runway for the preload (45 s to
    // mix-out), the staging analysis and a full 16-bar blend with arm lead.
    const st = live.structure;
    const barTrack = st.barLen;
    live.seek(st.mixOutSec - 30 * barTrack);
    am.plan = null;
    const t0 = performance.now();
    let armSnapshot = null;
    let phaseSnapshot = null;
    let nudged = false;
    const debug = { sawTransition: false, sawStyle: null, sawFade: false, states: [] };
    while (performance.now() - t0 < 120000) {
      await new Promise((r) => setTimeout(r, 60));
      const tr = am.transition;
      if (tr) {
        debug.sawTransition = true;
        debug.sawStyle = tr.telemetry.style;
        if (debug.states[debug.states.length - 1] !== tr.state) debug.states.push(tr.state);
      }
      if (am.fade) debug.sawFade = true;
      if (am.plan && !debug.plan) {
        debug.plan = { style: am.plan.style, reasons: am.plan.reasons.slice() };
      }
      if (!debug.snap) {
        debug.snap = {
          stale: am.staleId, idleTrack: idle.track && idle.track.title,
          idleReady: idle.status, idleDone: idle._analysisDone,
          liveConf: live.structure ? live.structure.confidence : null,
          idleConf: idle.structure ? idle.structure.confidence : null,
          liveBpm: live.bpm, idleBpm: idle.bpm, idleRange: idle.tempoRange,
        };
      }
      if (tr && !armSnapshot && idle._drop && idle._drop.plannedBy === 'automix') {
        // Same-evaluate comparison: scheduled start vs the projected boundary.
        const ctx = dj.mixer.ctx;
        const rate = Math.abs(live.currentRate || live.nominalRate) || 1;
        const projected = ctx.currentTime + (tr.plan.startSec - live.position) / rate;
        armSnapshot = { deltaMs: Math.abs(idle._drop.when - projected) * 1000 };
      }
      if (tr && tr.state === 'OVERLAP' && !phaseSnapshot && idle.playing && !idle._drop) {
        const mod = (x, m) => ((x % m) + m) % m;
        const beatL = 60 / live.effectiveBpm;
        const beatI = 60 / idle.effectiveBpm;
        let err = mod(idle.position - (idle.beatOffset || 0), beatI) / beatI
          - mod(live.position - (live.beatOffset || 0), beatL) / beatL;
        if (err > 0.5) err -= 1;
        if (err < -0.5) err += 1;
        phaseSnapshot = { errBeats: Math.abs(err), latched: idle.syncedTo === live };
      }
      if (nudge && tr && tr.state === 'OVERLAP' && !nudged && tr.telemetry.startedAt) {
        dj.mixer.setCrossfader(0.9 * (idle.id === 'A' ? -1 : 1)); // human grabs it
        nudged = true;
      }
      if (!am.transition && am.liveId === idle.id) break;
    }
    return {
      handedOver: am.liveId === idle.id,
      telemetry: am.lastTransition,
      armSnapshot,
      phaseSnapshot,
      debug,
      oldDeck: { paused: !live.playing, eqLow: live.eq.low },
      newDeck: { tempo: idle.tempo, synced: idle.syncedTo !== null, eqLow: idle.eq.low },
    };
  }, nudgeXfMidway);
}

// Set up: adopt deck A as live, queue the two locals, switch automix on.
await frame.evaluate(() => {
  const dj = window.__djclanker;
  dj.mixer.resumeAudio();
  dj.decks.B.pause();
  dj.decks.A.play({ instant: true });
  // Reversed so the second cycle stages Beta while Alpha is live — a real
  // A→B→A rotation instead of the same file on both decks.
  dj.automix.setQueue([...dj.browser.currentItems()].reverse());
  if (!dj.automix.enabled) dj.automix.toggle();
});

const t1 = await runTransition();
check('transition 1: hands over on the blend', t1.handedOver
  && t1.telemetry && t1.telemetry.style === 'blend', t1.telemetry && t1.telemetry.style);
check('transition 1: arm is sample-scheduled on the boundary (<5 ms)',
  t1.armSnapshot && t1.armSnapshot.deltaMs < 5,
  t1.armSnapshot ? `${t1.armSnapshot.deltaMs.toFixed(2)} ms` : 'never armed');
check('transition 1: phase locked during overlap (<0.05 beat, latch on)',
  t1.phaseSnapshot && t1.phaseSnapshot.errBeats < 0.05 && t1.phaseSnapshot.latched,
  t1.phaseSnapshot ? `${t1.phaseSnapshot.errBeats.toFixed(3)} beats` : 'no snapshot');
check('transition 1: bass swap ran to completion', t1.telemetry
  && t1.telemetry.swapDoneAt > 0 && t1.newDeck.eqLow >= -0.5,
  `in LOW=${t1.newDeck.eqLow}`);
check('transition 1: outgoing paused with its LOW restored',
  t1.oldDeck.paused && t1.oldDeck.eqLow >= -0.5, `LOW=${t1.oldDeck.eqLow}`);

await frame.waitForFunction(() => {
  const am = window.__djclanker.automix;
  const d = am.liveDeck;
  return d && Math.abs(d.tempo) < 0.5 && d.syncedTo === null;
}, undefined, { timeout: 30000 });
check('transition 1: tempo released back toward 0% and latch dropped', true);

// Second cycle — the automix-check lesson: a bug on handover N=2 hides
// behind a green N=1. Also grabs the crossfader mid-overlap (yield test).
// The idle deck counts as staged only once the preload REFILLED it: the old
// track is stale by definition, however 'ready' it still looks.
await frame.waitForFunction(() => {
  const am = window.__djclanker.automix;
  const idle = am.idleDeck;
  return idle && idle.status === 'ready' && idle._analysisDone && !am.busy
    && am.staleId !== idle.id;
}, undefined, { timeout: 180000 });
const t2 = await runTransition({ nudgeXfMidway: true });
check('transition 2: hands over again (second cycle)', t2.handedOver);
check('transition 2: crossfader yielded to the human hand',
  t2.telemetry && t2.telemetry.yielded.xf === true,
  JSON.stringify(t2.debug));
check('no cumulative pitch drift after two transitions', Math.abs(t2.newDeck.tempo) < 3.5,
  `tempo=${t2.newDeck.tempo.toFixed(2)}%`);

await frame.evaluate(() => {
  const dj = window.__djclanker;
  if (dj.automix.enabled) dj.automix.toggle();
  dj.decks.A.pause();
  dj.decks.B.pause();
});

/* ---------------------- part 3: smart selection ---------------------- */

const scores = await frame.evaluate(() => {
  const s = window.__djclanker.selection;
  return {
    same: s.camelotScore('8B', '8B'),
    neighbour: s.camelotScore('8B', '9B'),
    relative: s.camelotScore('8B', '8A'),
    far: s.camelotScore('8B', '3B'),
    unknown: s.camelotScore('8B', ''),
    foldExact: s.bpmFoldScore(124, 62), // half-time fold lands at 0%
    foldFar: s.bpmFoldScore(124, 95),
    energyNear: s.energyScore(0.8, 0.75),
  };
});
check('camelot scoring orders same > neighbour > relative > far',
  scores.same === 1 && scores.neighbour === 0.9 && scores.relative === 0.85
  && scores.far < 0.3 && scores.unknown === 0.6, JSON.stringify(scores));
check('bpm fold scoring: octave fold is perfect, 95-vs-124 is out of range',
  scores.foldExact > 0.99 && scores.foldFar === 0, `${scores.foldExact} / ${scores.foldFar}`);

// A third fixture, harmonically and tempo-wise FAR from Alpha: 95 BPM, C# major.
await frame.locator('input.local-input').setInputFiles({
  name: 'KeyCis - Gamma.wav',
  mimeType: 'audio/wav',
  buffer: makeStructuredWav({ bpm: 95, root: 1 }),
});
await page.waitForTimeout(300);
await frame.locator('.track-row', { hasText: 'Gamma' }).first().locator('.load-b').click();
await frame.waitForFunction(() => {
  const d = window.__djclanker.decks.B;
  return d.status === 'ready' && d._analysisDone && d.track && d.track.title === 'Gamma';
}, undefined, { timeout: 120000 });

const smart = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const am = dj.automix;
  // Live basis: deck A holds Beta (120 BPM, 9B) from the transition cycles.
  am.liveId = 'A';
  am.order = 'smart';
  am.history = [];
  const items = dj.browser.currentItems();
  const gamma = items.find((t) => t.title === 'Gamma');
  const alpha = items.find((t) => t.title === 'Alpha');
  am.setQueue([gamma, alpha]); // the far track sits FIRST in the list
  const pick1 = am._takeNext();
  am.setQueue([{ id: 'u1', title: 'u1' }, { id: 'u2', title: 'u2' }]);
  const pick2 = am._takeNext();
  am.order = 'smart';
  return { smartPick: pick1 && pick1.title, neutralPick: pick2 && pick2.id };
});
check('smart order picks the compatible track over the list head',
  smart.smartPick === 'Alpha', `picked ${smart.smartPick}`);
check('uncached candidates degrade to list order', smart.neutralPick === 'u1');

// Preanalyzer: a NEVER-loaded fixture gets analyzed in the background, and
// no deck is touched to do it.
await frame.locator('input.local-input').setInputFiles({
  name: 'KeyF - Delta.wav',
  mimeType: 'audio/wav',
  buffer: makeStructuredWav({ bpm: 100, root: 5 }),
});
await page.waitForTimeout(300);
const preSetup = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const delta = dj.browser.currentItems().find((t) => t.title === 'Delta');
  dj.automix.setQueue([delta]);
  dj.automix.order = 'smart';
  const before = {
    cached: Boolean(dj.analysisCache.getAnalysis(dj.analysisCache.trackCacheId(delta))),
    deckA: dj.decks.A.track && dj.decks.A.track.title,
    deckB: dj.decks.B.track && dj.decks.B.track.title,
  };
  dj.preanalyzer.poke(true);
  return before;
});
check('delta starts uncached', preSetup.cached === false);
await frame.waitForFunction(() => {
  const dj = window.__djclanker;
  const delta = dj.automix.queue[0];
  const e = dj.analysisCache.getAnalysis(dj.analysisCache.trackCacheId(delta));
  return Boolean(e && e.bpm > 0);
}, undefined, { timeout: 120000 });
const pre = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const delta = dj.automix.queue[0];
  const e = dj.analysisCache.getAnalysis(dj.analysisCache.trackCacheId(delta));
  return {
    bpm: e.bpm,
    camelot: e.k ? true : false,
    deckA: dj.decks.A.track && dj.decks.A.track.title,
    deckB: dj.decks.B.track && dj.decks.B.track.title,
  };
});
check('preanalyzer caches BPM and key without touching a deck',
  Math.abs(pre.bpm - 100) <= 0.2 && pre.camelot
  && pre.deckA === preSetup.deckA && pre.deckB === preSetup.deckB,
  `bpm=${pre.bpm} decks ${pre.deckA}/${pre.deckB}`);

/* ----------------------------- part 4: UI ----------------------------- */

const ui = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const keyA = document.querySelector('.deck-top.deck-A .badge-key');
  const styleBtns = [...document.querySelectorAll('.automix .btn-mini')];
  const styleBtn = styleBtns.find((b) => b.textContent === 'AUTO');
  const before = dj.automix.transitionStyle;
  if (styleBtn) styleBtn.click();
  const after = dj.automix.transitionStyle;
  dj.automix.transitionStyle = 'auto';
  const orderBtn = styleBtns.find((b) => ['LIST', 'SHUF', 'SMART'].includes(b.textContent));
  return {
    keyBadge: keyA ? keyA.textContent : null,
    keyVisible: keyA ? keyA.style.display !== 'none' : false,
    styleBefore: before,
    styleAfter: after,
    orderLabel: orderBtn ? orderBtn.textContent : null,
  };
});
check('deck head shows the Camelot key badge', ui.keyVisible && ui.keyBadge === '8B',
  `${ui.keyBadge}`);
check('transition style button cycles AUTO → BLEND',
  ui.styleBefore === 'auto' && ui.styleAfter === 'blend');
check('order button reflects the SMART default', ui.orderLabel === 'SMART',
  `${ui.orderLabel}`);

// Cached tracks get a "BPM · key" chip once the list re-renders.
await frame.locator('.tab', { hasText: 'Crate' }).click();
await frame.locator('.side-group .btn-ghost', { hasText: 'Show local files' }).click();
const chip = await frame.evaluate(() => {
  const rows = [...document.querySelectorAll('.track-row')];
  const alpha = rows.find((r) => r.textContent.includes('Alpha'));
  const el = alpha && alpha.querySelector('.row-keybpm');
  return el ? el.textContent : null;
});
check('browser row carries the analyzed BPM · key chip', chip === '124 · 8B', `${chip}`);

/* ------------------------- hidden-tab fallback ------------------------- */
// Faked `document.hidden` + a manual visibilitychange: asserts the branch
// logic (instant start, interval up/down), not real browser throttling —
// headless does not throttle rAF the way a real background tab does.

const bg = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  dj.decks.A.pause();
  await new Promise((r) => setTimeout(r, 700)); // let the brake settle
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  dj.decks.A.play(); // vinyl mode is on, but hidden must start like a CDJ
  const modeAtStart = dj.decks.A._mode;
  const t0 = dj.mixer.bgTicks || 0;
  await new Promise((r) => setTimeout(r, 500));
  const ticked = (dj.mixer.bgTicks || 0) - t0;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  const frozen = dj.mixer.bgTicks;
  await new Promise((r) => setTimeout(r, 300));
  dj.decks.A.pause();
  return { modeAtStart, ticked, stopped: dj.mixer.bgTicks === frozen };
});
check('hidden tab: vinyl play starts instantly instead of stalling at rate 0',
  bg.modeAtStart === 'source');
check('hidden tab: fallback interval drives the audio state machines',
  bg.ticked >= 3, `${bg.ticked} ticks in 500 ms`);
check('visible again: fallback stops and rAF takes over', bg.stopped === true);

await page.screenshot({ path: `${OUT}-analysis.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
