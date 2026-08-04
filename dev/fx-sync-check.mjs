/**
 * E2E for the Traktor-round: FX slots (5 effects, 2 switchable per deck),
 * effective-BPM display driven by the tempofader, beat-grid SYNC from the
 * v2 detector, and the cue (headphone) bus.
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/fx-sync-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/fxsync';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.deck-A', { timeout: 15000 });
await frame.waitForSelector('.track-row', { timeout: 25000 });
await frame.locator('.tab').first().click();

// Same track on both decks — that makes the sync ground truth exact.
await frame.locator('.track-row').nth(0).locator('.load-a').click();
await frame.locator('.track-row').nth(0).locator('.load-b').click();
await frame.waitForFunction(
  () => document.querySelectorAll('.deck .badge-mode.ok').length >= 2,
  undefined,
  { timeout: 120000 },
);
await frame.waitForFunction(() => {
  const { A, B } = window.__djclanker.decks;
  return A.bpm > 40 && B.bpm > 40;
}, undefined, { timeout: 60000 });

/* ------------------------- BPM detector v2 ------------------------- */

const det = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  return { bpmA: A.bpm, bpmB: B.bpm, offA: A.beatOffset, offB: B.beatOffset, confA: A.bpmConfidence };
});
check('detector yields sub-0.5-BPM precision', Math.abs(det.bpmA * 100 - Math.round(det.bpmA * 100)) < 1e-6 && det.bpmA > 40,
  `bpm=${det.bpmA}`);
check('detector agrees with itself across decks', Math.abs(det.bpmA - det.bpmB) < 0.05,
  `A=${det.bpmA} B=${det.bpmB}`);
check('beat grid detected (beatOffset)', Number.isFinite(det.offA) && Number.isFinite(det.offB),
  `offA=${det.offA && det.offA.toFixed(3)}s offB=${det.offB && det.offB.toFixed(3)}s`);
check('same track → same grid phase', Math.abs(det.offA - det.offB) < 0.05 ||
  Math.abs(Math.abs(det.offA - det.offB) % (60 / det.bpmA)) < 0.05, `Δoff=${Math.abs(det.offA - det.offB).toFixed(3)}s`);

/* --------------------- BPM display ↔ tempofader --------------------- */

await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(1500);
const liveBefore = parseFloat(await frame.locator('.deck-A .bpm-live').textContent());
await frame.evaluate(() => {
  const f = document.querySelector('.deck-A input.pitch');
  f.value = '5';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const liveAfter = parseFloat(await frame.locator('.deck-A .bpm-live').textContent());
const pitchTxt = (await frame.locator('.deck-A .pitch-val').textContent()).trim();
check('BPM display follows the tempofader', Math.abs(liveAfter - liveBefore * 1.05) < 0.3,
  `${liveBefore} → ${liveAfter} (+5 %) ${pitchTxt}`);
const baseShown = parseFloat(await frame.locator('.deck-A .bpm-input').inputValue());
check('base BPM field stays at track tempo', Math.abs(baseShown - det.bpmA) < 0.06, `base=${baseShown}`);

/* ---------------------------- waveform zoom ---------------------------- */

await frame.locator('.deck-A .zoom-in').click();
await frame.locator('.deck-A .zoom-in').click();
const z1 = parseFloat(await frame.locator('.deck-A .wave-wrap').getAttribute('data-zoom'));
check('waveform zooms via buttons', z1 > 2, `×${z1}`);

const wb = await frame.locator('.deck-A .wave-wrap').boundingBox();
await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(200);
const z2 = parseFloat(await frame.locator('.deck-A .wave-wrap').getAttribute('data-zoom'));
check('mouse wheel zooms the waveform', z2 > z1, `×${z1} → ×${z2}`);

const seekInfo = await frame.evaluate(() => ({
  pos: window.__djclanker.decks.A.position,
  dur: window.__djclanker.decks.A.duration,
}));
const zspan = seekInfo.dur / z2;
const zt0 = Math.max(0, Math.min(seekInfo.dur - zspan, seekInfo.pos - zspan / 2));
await frame.locator('.deck-A .wave-wrap').click({ position: { x: wb.width * 0.3, y: 60 } });
await page.waitForTimeout(250);
const seekAfter = await frame.evaluate(() => window.__djclanker.decks.A.position);
check('click seeks inside the zoom window', Math.abs(seekAfter - (zt0 + 0.3 * zspan)) < Math.max(0.6, zspan * 0.08),
  `pos=${seekAfter.toFixed(1)}s ≈ ${(zt0 + 0.3 * zspan).toFixed(1)}s`);

await frame.locator('.deck-A .zoom-fit').click();
const z3 = parseFloat(await frame.locator('.deck-A .wave-wrap').getAttribute('data-zoom'));
check('×1 resets to the full overview', z3 === 1, `×${z3}`);
await frame.evaluate(() => {
  const f = document.querySelector('.deck-A input.pitch');
  f.value = '0';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});

/* ------------------------------ FX slots ------------------------------ */

const slots0 = await frame.evaluate(() => window.__djclanker.decks.A.fxSlots.slice());
check('default slots are flanger + gater', slots0[0] === 'flanger' && slots0[1] === 'gater', slots0.join('+'));

await frame.locator('.deck-A .fx-sel').first().selectOption('echo');
await page.waitForTimeout(200);
const afterSel = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { slots: d.fxSlots.slice(), hasUnits: Boolean(d._graph.echo && d._graph.reverb && d._graph.phaser) };
});
check('slot 1 switched to echo', afterSel.slots[0] === 'echo', afterSel.slots.join('+'));
check('all five FX units live in the graph', afterSel.hasUnits);

await frame.locator('.deck-A .btn-fx').first().click();
await page.waitForTimeout(1200);
const echoState = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { on: d.fx.echo.on, delay: d._graph.echo.delay.delayTime.value, level: window.__djclanker.mixer.masterLevel() };
});
const expectedDelay = (60 / (det.bpmA * 1.0)) * 0.5;
check('echo engages via slot button', echoState.on);
check('echo delay is tempo-synced (1/8)', Math.abs(echoState.delay - expectedDelay) < 0.05,
  `${(echoState.delay * 1000).toFixed(0)}ms ≈ ${(expectedDelay * 1000).toFixed(0)}ms`);
check('audio flows through the new chain', echoState.level > 0.005, `master=${echoState.level.toFixed(3)}`);

// Choosing a type the other slot holds swaps the two slots.
await frame.locator('.deck-A .fx-sel').nth(1).selectOption('echo');
await page.waitForTimeout(200);
const swapped = await frame.evaluate(() => window.__djclanker.decks.A.fxSlots.slice());
check('duplicate choice swaps the slots', swapped[0] === 'gater' && swapped[1] === 'echo', swapped.join('+'));

await page.keyboard.press('f');
await page.waitForTimeout(200);
const kbd = await frame.evaluate(() => window.__djclanker.decks.A.fx.gater.on);
check('keyboard F toggles slot 1 effect', kbd === true);
await page.keyboard.press('f');
await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  d.toggleFx('echo', false);
  d.setFxSlot(0, 'flanger');
  d.setFxSlot(1, 'gater');
});

/* ------------------------------- SYNC ------------------------------- */

await frame.locator('.deck-B .btn-play').click();
await page.waitForTimeout(1200);
await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  B.setTempo(3);
  const beat = 60 / A.effectiveBpm;
  B.seek(A.position + 0.37 * beat);
});
await page.waitForTimeout(600);
await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  B.syncTo(A);
});
await page.waitForTimeout(800);
const sync = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const mod = (x, m) => ((x % m) + m) % m;
  const beatA = 60 / A.effectiveBpm;
  const beatB = 60 / B.effectiveBpm;
  const pa = mod(A.position - (A.beatOffset || 0), beatA) / beatA;
  const pb = mod(B.position - (B.beatOffset || 0), beatB) / beatB;
  let err = Math.abs(pa - pb);
  if (err > 0.5) err = 1 - err;
  return { tempoB: B.tempo, err, bpmA: A.effectiveBpm, bpmB: B.effectiveBpm };
});
check('sync matched the tempo', Math.abs(sync.bpmA - sync.bpmB) < 0.05, `${sync.bpmA.toFixed(2)} vs ${sync.bpmB.toFixed(2)}`);
check('sync landed on the beat grid', sync.err < 0.06, `phase error ${(sync.err * 100).toFixed(1)} % of a beat`);

/* ----------------------------- cue bus ----------------------------- */

const cue = await frame.evaluate(async () => {
  const m = window.__djclanker.mixer;
  const A = window.__djclanker.decks.A;
  A.setCue(true);
  await new Promise((r) => setTimeout(r, 250));
  return {
    available: m.cueAvailable,
    sendGain: A._graph.cueSend.gain.value,
    hasStream: Boolean(m.cueDest && m.cueDest.stream.getAudioTracks().length === 1),
    secondCtx: Boolean(m.cueCtx),
    sinkApi: Boolean(m.cueCtx && typeof m.cueCtx.setSinkId === 'function'),
  };
});
check('cue bus is available', cue.available && cue.secondCtx);
check('deck A routes onto the cue bus', cue.sendGain > 0.5, `send=${cue.sendGain.toFixed(2)}`);
check('cue bridge carries one audio stream', cue.hasStream);
check('device selection API present (setSinkId)', cue.sinkApi);
const pflOn = await frame.locator('.deck-A .btn-pfl').evaluate((el) => el.classList.contains('on'));
check('🎧 button reflects cue state', pflOn === true);
await frame.evaluate(() => window.__djclanker.decks.A.setCue(false));

// Output-device policy: the shell must delegate device permissions into the
// sandboxed frame (microphone gates "Reveal device names"; speaker-selection
// where the browser knows it), and setSinkId must actually resolve there.
const policy = await frame.evaluate(async () => {
  const fp = document.featurePolicy || document.permissionsPolicy;
  const known = fp && fp.features ? fp.features() : [];
  const feature = (name) => (known.includes(name) ? fp.allowsFeature(name) : 'n/a');
  const ok = await window.__djclanker.mixer.setOutputDevice('cue', '');
  return { mic: feature('microphone'), spk: feature('speaker-selection'), ok };
});
check('device policies reach the napplet',
  (policy.mic === true || policy.mic === 'n/a') && policy.spk !== false,
  `microphone=${policy.mic} speaker-selection=${policy.spk}`);
check('setSinkId resolves inside the sandbox', policy.ok === true);

/* --------------------------- SYNC latch --------------------------- */

// Cross-metrical tempo match: detector levels 92.5 vs 138.75 must sync to ~0 %.
const metrical = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const saved = B.bpm;
  B.bpm = A.bpm * 1.5;
  B.bpmManual = true;
  const ok = B.syncTo(A);
  const t = B.tempo;
  B.bpm = saved;
  B.bpmManual = false;
  B.setTempo(0);
  return { ok, t };
});
check('sync bridges 2:3 metrical levels', metrical.ok && Math.abs(metrical.t) < 0.5, `tempo=${metrical.t.toFixed(2)}%`);

await frame.locator('.deck-B .btn-sync').click();
await page.waitForTimeout(400);
const latched = await frame.evaluate(() => Boolean(window.__djclanker.decks.B.syncedTo));
const syncBtnOn = await frame.locator('.deck-B .btn-sync').evaluate((el) => el.classList.contains('on'));
check('SYNC latches on', latched && syncBtnOn);

// Knock deck B a third of a beat off the grid — the latch must catch it
// without another click.
await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  B.seek(B.position + 0.31 * (60 / A.effectiveBpm));
});
await page.waitForTimeout(3500);
const caught = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const mod = (x, m) => ((x % m) + m) % m;
  const beatA = 60 / A.effectiveBpm;
  const beatB = 60 / B.effectiveBpm;
  const pa = mod(A.position - (A.beatOffset || 0), beatA) / beatA;
  const pb = mod(B.position - (B.beatOffset || 0), beatB) / beatB;
  let err = Math.abs(pa - pb);
  if (err > 0.5) err = 1 - err;
  return err;
});
check('latch re-catches a perturbed deck', caught < 0.06, `error ${(caught * 100).toFixed(1)} % of a beat`);

await frame.locator('.deck-B .btn-sync').click();
await page.waitForTimeout(300);
const released = await frame.evaluate(() => {
  const B = window.__djclanker.decks.B;
  return { latched: Boolean(B.syncedTo), nudge: B.nudgeAmount };
});
check('SYNC releases on second click', !released.latched && released.nudge === 0);

/* ------------------------------ loops ------------------------------ */

await frame.locator('.deck-A .btn-loopbeat', { hasText: /^4$/ }).click();
await page.waitForTimeout(200);
const loop4 = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { ...A.loop, bpm: A.bpm, off: A.beatOffset, pos: A.position };
});
const beatLen = 60 / loop4.bpm;
const gridErr = Math.abs(((loop4.start - loop4.off) % beatLen + beatLen) % beatLen);
check('4-beat loop engages', loop4.active && loop4.beats === 4);
check('loop length is exactly 4 beats', Math.abs(loop4.end - loop4.start - 4 * beatLen) < 0.01,
  `${(loop4.end - loop4.start).toFixed(3)}s ≈ ${(4 * beatLen).toFixed(3)}s`);
check('loop start snaps to the beat grid', Math.min(gridErr, beatLen - gridErr) < 0.01,
  `Δ=${Math.min(gridErr, beatLen - gridErr).toFixed(4)}s`);

const loopSpan = loop4.end - loop4.start;
await page.waitForTimeout(Math.ceil((loopSpan + 0.8) * 1000));
const wrapped = await frame.evaluate(() => window.__djclanker.decks.A.position);
check('playhead wraps inside the loop', wrapped > loop4.start - 0.05 && wrapped < loop4.end + 0.05,
  `pos=${wrapped.toFixed(2)}s in [${loop4.start.toFixed(2)}, ${loop4.end.toFixed(2)}]`);

await frame.locator('.deck-A .btn-loopexit').click();
await page.waitForTimeout(Math.ceil((loopSpan + 0.6) * 1000));
const escaped = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { active: A.loop.active, pos: A.position };
});
check('EXIT leaves the loop', !escaped.active && escaped.pos > loop4.end,
  `pos=${escaped.pos.toFixed(2)}s > ${loop4.end.toFixed(2)}s`);

await frame.locator('.deck-A .btn-loopin').click();
await page.waitForTimeout(900);
await frame.locator('.deck-A .btn-loopout').click();
await page.waitForTimeout(150);
const manual = await frame.evaluate(() => window.__djclanker.decks.A.loop);
check('manual IN/OUT loop closes', manual.active && manual.end - manual.start > 0.5 && manual.end - manual.start < 1.6,
  `${(manual.end - manual.start).toFixed(2)}s`);
await frame.evaluate(() => window.__djclanker.decks.A.exitLoop());

/* --------------------------- downbeat + DROP --------------------------- */

const bars = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  return { barA: A.barOffset, barB: B.barOffset, beatA: A.beatOffset };
});
check('downbeat (bar-1) detected', Number.isFinite(bars.barA) && Number.isFinite(bars.barB),
  `barA=${bars.barA && bars.barA.toFixed(3)}s`);
check('bar-1 sits on the beat grid', Number.isFinite(bars.barA)
  && Math.abs(((bars.barA - bars.beatA) / (60 / det.bpmA)) % 1) < 0.02,
  `${((bars.barA - bars.beatA) / (60 / det.bpmA)).toFixed(2)} beats above beatOffset`);

// Deck B stopped, deck A playing — DROP must arm, then fire on A's next bar-1.
await frame.evaluate(() => {
  const B = window.__djclanker.decks.B;
  B.pause();
  B.setTempo(0);
});
await page.waitForTimeout(1200);
await frame.locator('.deck-B .btn-drop').click();
await page.waitForTimeout(60);
// If the other deck's bar-1 was imminent, the drop may have fired already —
// both are correct outcomes of arming.
const armState = await frame.evaluate(() => {
  const B = window.__djclanker.decks.B;
  return { armed: Boolean(B._drop), playing: B.playing, mode: B._mode };
});
check('DROP arms on a stopped deck', armState.armed || (armState.playing && armState.mode === 'source'),
  armState.armed ? 'armed' : 'fired instantly');

await frame.waitForFunction(() => {
  const B = window.__djclanker.decks.B;
  return B.playing && !B._drop && B._mode === 'source';
}, undefined, { timeout: 10000 });
await page.waitForTimeout(600);
const dropped = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const mod = (x, m) => ((x % m) + m) % m;
  const barA = 4 * (60 / A.effectiveBpm);
  const barB = 4 * (60 / B.effectiveBpm);
  const pa = mod(A.position - (A.barOffset || 0), barA) / barA;
  const pb = mod(B.position - (B.barOffset || 0), barB) / barB;
  let err = Math.abs(pa - pb);
  if (err > 0.5) err = 1 - err;
  return { err, bpmA: A.effectiveBpm, bpmB: B.effectiveBpm };
});
check('DROP matched the tempo', Math.abs(dropped.bpmA - dropped.bpmB) < 0.05,
  `${dropped.bpmA.toFixed(2)} vs ${dropped.bpmB.toFixed(2)}`);
check('DROP landed 1-on-1 (bar phase)', dropped.err < 0.03,
  `bar error ${(dropped.err * 100).toFixed(1)} % of a 4/4 bar`);
await frame.evaluate(() => window.__djclanker.decks.B.pause());

/* ---------------------------- tap tempo ---------------------------- */

const savedGrid = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  if (!A.playing) A.play();
  return { bpm: A.bpm, beatOffset: A.beatOffset, barOffset: A.barOffset };
});
await page.waitForTimeout(600);
for (let i = 0; i < 6; i++) {
  await frame.evaluate(() => window.__djclanker.decks.A.tapBeat());
  await page.waitForTimeout(500);
}
const tapped = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { bpm: A.bpm, manual: A.bpmManual, off: A.beatOffset };
});
check('tap tempo sets BPM from the taps', Math.abs(tapped.bpm - 120) < 8, `${tapped.bpm} BPM from ~500 ms taps`);
check('tapped BPM is marked manual', tapped.manual === true);
check('taps anchor the beat grid', Number.isFinite(tapped.off), `beatOffset=${tapped.off && tapped.off.toFixed(3)}s`);
await frame.evaluate((g) => {
  const A = window.__djclanker.decks.A;
  A.bpm = g.bpm;
  A.beatOffset = g.beatOffset;
  A.barOffset = g.barOffset;
  A.bpmManual = false;
  A._taps = [];
  A.emit('bpm');
}, savedGrid);

/* ---------------------------- auto-scratch ---------------------------- */

const asStart = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  const posBefore = A.position;
  const ok = A.startAutoScratch('baby');
  return { ok, posBefore };
});
await page.waitForTimeout(400);
const asMid = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { pattern: A.autoScratch, mode: A._mode, scratching: A.scratching };
});
check('auto-scratch engages the platter', asStart.ok && asMid.pattern === 'baby'
  && asMid.mode === 'platter' && asMid.scratching, `pattern=${asMid.pattern} mode=${asMid.mode}`);

// Two bars at the current tempo, then it must hand back to normal playback.
const barMs = await frame.evaluate(() => (60 / window.__djclanker.decks.A.effectiveBpm) * 4 * 1000);
await page.waitForTimeout(Math.ceil(barMs * 2 + 900));
const asEnd = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { pattern: A.autoScratch, mode: A._mode, playing: A.playing, pos: A.position };
});
check('auto-scratch auto-stops after its bars', asEnd.pattern === null && asEnd.mode === 'source' && asEnd.playing,
  `mode=${asEnd.mode}`);
check('baby scratch stays near its spot', Math.abs(asEnd.pos - asStart.posBefore) < 4,
  `drift ${(asEnd.pos - asStart.posBefore).toFixed(2)}s`);

await page.screenshot({ path: `${OUT}-decks.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
