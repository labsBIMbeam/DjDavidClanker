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

/* ------------------------- linked wave-lane zoom ------------------------- */

// One shared beat-window drives BOTH lanes: wheel or button on either lane
// moves the pair, and beats keep the same pixel width across decks.
const beatsOf = () => frame.evaluate(() => [
  parseFloat(document.querySelector('.deck-A .wave-wrap').dataset.beats),
  parseFloat(document.querySelector('.deck-B .wave-wrap').dataset.beats),
]);

// Page coordinates for the raw wheel gesture: iframe rect + in-frame rect
// (boundingBox on sandboxed-iframe elements is frame-relative here; the
// iframe offset is measured now, after the shell log has grown).
const frameEl = await page.locator('#frame').boundingBox();
await frame.locator('.deck-A .wave-wrap').scrollIntoViewIfNeeded();
const wb = await frame.evaluate(() => {
  const b = document.querySelector('.deck-A .wave-wrap').getBoundingClientRect();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});
const b0 = await beatsOf();
await page.mouse.move(frameEl.x + wb.x + wb.width / 2, frameEl.y + wb.y + wb.height / 2);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(250);
const b1 = await beatsOf();
check('mouse wheel zooms BOTH lanes (shared beat-view)',
  b1[0] < b0[0] && Math.abs(b1[0] - b1[1]) < 0.01,
  `${b0[0]} beats → A=${b1[0]} B=${b1[1]}`);

await frame.locator('.deck-A .zoom-in').click();
await page.waitForTimeout(250);
const b2 = await beatsOf();
check('one zoom button drives both decks', b2[0] < b1[0] && Math.abs(b2[0] - b2[1]) < 0.01,
  `A=${b2[0]} B=${b2[1]} beats`);

const seekInfo = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { pos: A.position, dur: A.duration, bpm: A.effectiveBpm || A.bpm || 120 };
});
const zspan = Math.min(seekInfo.dur, b2[0] * (60 / seekInfo.bpm));
const zt0 = Math.max(0, Math.min(seekInfo.dur - zspan, seekInfo.pos - zspan / 2));
await frame.locator('.deck-A .wave-wrap').click({ position: { x: wb.width * 0.3, y: 60 } });
await page.waitForTimeout(250);
const seekAfter = await frame.evaluate(() => window.__djclanker.decks.A.position);
check('click seeks inside the zoom window', Math.abs(seekAfter - (zt0 + 0.3 * zspan)) < Math.max(0.6, zspan * 0.08),
  `pos=${seekAfter.toFixed(1)}s ≈ ${(zt0 + 0.3 * zspan).toFixed(1)}s`);

await frame.locator('.deck-A .zoom-fit').click();
await page.waitForTimeout(250);
const b3 = await beatsOf();
check('reset returns both lanes to 8 bars', b3[0] === 32 && b3[1] === 32, `${b3.join('/')} beats`);
await frame.evaluate(() => {
  const f = document.querySelector('.deck-A input.pitch');
  f.value = '0';
  f.dispatchEvent(new Event('input', { bubbles: true }));
});

/* ------------------------------ FX slots ------------------------------ */

const slots0 = await frame.evaluate(() => window.__djclanker.decks.A.fxSlots.slice());
check('default slots are barber + gater (MIDI knob live from boot)',
  slots0[0] === 'barber' && slots0[1] === 'gater', slots0.join('+'));

// Swap slot 1 away and back — the dropdown must drive the engine both ways.
await frame.locator('.deck-A .fx-sel').first().selectOption('flanger');
await page.waitForTimeout(200);
const swapAway = await frame.evaluate(() => window.__djclanker.decks.A.fxSlots.slice());
await frame.locator('.deck-A .fx-sel').first().selectOption('barber');
await page.waitForTimeout(200);
const afterSel = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { slots: d.fxSlots.slice(), hasUnits: Boolean(d._graph.echo && d._graph.reverb && d._graph.barber) };
});
check('slot 1 swaps to another unit and back', swapAway[0] === 'flanger' && afterSel.slots[0] === 'barber',
  `${swapAway.join('+')} → ${afterSel.slots.join('+')}`);
check('all five FX units live in the graph', afterSel.hasUnits);

// The echo block below needs echo IN slot 1 — put it there explicitly.
await frame.locator('.deck-A .fx-sel').first().selectOption('echo');
await page.waitForTimeout(200);

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
  d.setFxSlot(0, 'barber'); // back to the boot default
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
  // Engage = tempo match + latch. Phase is BENT in by the latch over a few
  // seconds now (never seeked — a seek is an audible beat jump).
  B.syncTo(A);
  B.setSynced(A);
});
await page.waitForTimeout(8500);
const sync = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const mod = (x, m) => ((x % m) + m) % m;
  // Track-grid phase: 60/BASE bpm against track positions, same as the engine.
  const beatA = 60 / A.bpm;
  const beatB = 60 / B.bpm;
  const pa = mod(A.position - (A.beatOffset || 0), beatA) / beatA;
  const pb = mod(B.position - (B.beatOffset || 0), beatB) / beatB;
  let err = Math.abs(pa - pb);
  if (err > 0.5) err = 1 - err;
  // Nudge-free effective bpm: the latch is still bending the phase in, and
  // the momentary rate must not read as a tempo mismatch.
  return { tempoB: B.tempo, err, bpmA: A.effectiveBpm, bpmB: B.bpm * (1 + B.tempo / 100) };
});
check('sync matched the tempo', Math.abs(sync.bpmA - sync.bpmB) < 0.05, `${sync.bpmA.toFixed(2)} vs ${sync.bpmB.toFixed(2)}`);
check('sync bends onto the beat grid (no seek)', sync.err < 0.08, `phase error ${(sync.err * 100).toFixed(1)} % of a beat`);
await frame.evaluate(() => {
  const B = window.__djclanker.decks.B;
  B.setSynced(null);
  B.setNudge(0);
});

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
// Bend-only recovery: 0.31 of a beat rides in over several seconds.
await page.waitForTimeout(7000);
const caught = await frame.evaluate(() => {
  const { A, B } = window.__djclanker.decks;
  const mod = (x, m) => ((x % m) + m) % m;
  const beatA = 60 / A.bpm;
  const beatB = 60 / B.bpm;
  const pa = mod(A.position - (A.beatOffset || 0), beatA) / beatA;
  const pb = mod(B.position - (B.beatOffset || 0), beatB) / beatB;
  let err = Math.abs(pa - pb);
  if (err > 0.5) err = 1 - err;
  return err;
});
check('latch re-catches a perturbed deck by bending', caught < 0.08, `error ${(caught * 100).toFixed(1)} % of a beat`);

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

// Assert the loop against the playhead positions the two clicks actually saw,
// not against wall-clock: the gap between two Playwright clicks includes
// actionability and scroll overhead, so a fixed upper bound turns any DOM
// growth into a false failure.
await frame.locator('.deck-A .btn-loopin').click();
const posIn = await frame.evaluate(() => window.__djclanker.decks.A.position);
await page.waitForTimeout(900);
await frame.locator('.deck-A .btn-loopout').click();
const manual = await frame.evaluate(() => window.__djclanker.decks.A.loop);
const span = manual.end - manual.start;
check('manual IN/OUT loop closes on the in-point', manual.active && span > 0.4
  && Math.abs(manual.start - posIn) < 0.35, `${span.toFixed(2)}s, in-point off by ${(manual.start - posIn).toFixed(2)}s`);
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
// Tap in-page and score the detector against the tempo that was ACTUALLY
// tapped, not against the nominal 500 ms: a busy page fires setTimeout late,
// the detector faithfully reports the slower tempo, and asserting "≈120 BPM"
// would fail the feature for the timer's inaccuracy.
await page.waitForTimeout(600);
const tapped = await frame.evaluate(async () => {
  const A = window.__djclanker.decks.A;
  const at = [];
  for (let i = 0; i < 6; i++) {
    at.push(A.position);
    A.tapBeat();
    await new Promise((r) => setTimeout(r, 500));
  }
  const deltas = [];
  for (let i = 1; i < at.length; i++) deltas.push(at[i] - at[i - 1]);
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return { bpm: A.bpm, tappedBpm: 60 / median, manual: A.bpmManual, off: A.beatOffset };
});
check('tap tempo matches the tempo actually tapped', Math.abs(tapped.bpm - tapped.tappedBpm) < 1.5,
  `detected ${tapped.bpm.toFixed(1)} vs tapped ${tapped.tappedBpm.toFixed(1)} BPM`);
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

// Autoscratch loops until toggled off (a DJ decides how long a scratch runs,
// not a bar counter). Let it cycle a couple of bars, stop it, and it must
// hand back to normal playback near the anchor — no drift over the cycles.
const barMs = await frame.evaluate(() => (60 / window.__djclanker.decks.A.effectiveBpm) * 4 * 1000);
await page.waitForTimeout(Math.ceil(barMs * 2 + 400));
const asLoop = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { pattern: A.autoScratch, scratching: A.autoScratching };
});
check('auto-scratch keeps looping until toggled', asLoop.pattern === 'baby' && asLoop.scratching,
  `pattern=${asLoop.pattern}`);
const asEnd = await frame.evaluate(async () => {
  const A = window.__djclanker.decks.A;
  A.stopAutoScratch();
  await new Promise((r) => setTimeout(r, 600)); // motor hand-back
  return { pattern: A.autoScratch, mode: A._mode, playing: A.playing, pos: A.position };
});
check('auto-scratch stop hands back to playback', asEnd.pattern === null && asEnd.mode === 'source' && asEnd.playing,
  `mode=${asEnd.mode}`);
check('baby scratch stays near its spot', Math.abs(asEnd.pos - asStart.posBefore) < 4,
  `drift ${(asEnd.pos - asStart.posBefore).toFixed(2)}s`);

// Keylock: the worklet must correct pitch by the inverse of the actual rate.
const key = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  const A = dj.decks.A;
  for (let i = 0; i < 20 && !dj.mixer.keylockReady; i++) await new Promise((r) => setTimeout(r, 250));
  if (!dj.mixer.keylockReady) return { ready: false };
  if (!A.playing) A.toggle();
  A.setKeylock(true);
  A.setTempo(8);
  await new Promise((r) => setTimeout(r, 600));
  const ratioOn = A._keylockNode.parameters.get('ratio').value;
  const expected = 1 / A.currentRate;
  A.setKeylock(false);
  await new Promise((r) => setTimeout(r, 400));
  const ratioOff = A._keylockNode.parameters.get('ratio').value;
  A.setTempo(0);
  A.pause();
  return { ready: true, ratioOn, expected, ratioOff };
});
check('keylock corrects pitch by the inverse playback rate',
  key.ready && Math.abs(key.ratioOn - key.expected) < 0.002,
  key.ready ? `${key.ratioOn.toFixed(4)} vs ${key.expected.toFixed(4)}` : 'worklet unavailable');
check('keylock off returns the worklet to plain copy',
  key.ready && Math.abs(key.ratioOff - 1) < 0.002, key.ready ? `${key.ratioOff}` : 'n/a');

// Deck B has never been cued by hand in this suite — its cue must sit on the
// analysis default: the first downbeat, not 0:00.
const cueDef = await frame.evaluate(() => {
  const B = window.__djclanker.decks.B;
  const anchor = Number.isFinite(B.barOffset) ? B.barOffset : B.beatOffset;
  return { cue: B.cuePoint, anchor, manual: B._cueManual };
});
check('untouched deck parks its cue on the first downbeat', !cueDef.manual
  && Number.isFinite(cueDef.anchor) && cueDef.cue > 0 && Math.abs(cueDef.cue - cueDef.anchor) < 0.01,
  `cue=${cueDef.cue.toFixed(3)}s, bar-1=${cueDef.anchor && cueDef.anchor.toFixed(3)}s`);

// Deck B's own SCRATCH button — the suite used to cover deck A only, and a
// B-side UI break sailed straight through the board.
const bScr = await frame.evaluate(async () => {
  const B = window.__djclanker.decks.B;
  if (!B.playing) B.toggle();
  const btn = document.querySelector('.deck-B .btn-scratch-go')
    || document.querySelectorAll('.btn-scratch-go')[1];
  btn.click();
  await new Promise((r) => setTimeout(r, 800));
  const during = { auto: B.autoScratching, mode: B._mode };
  btn.click();
  await new Promise((r) => setTimeout(r, 500));
  B.pause();
  return { during, after: B.autoScratching };
});
check('deck B scratch fires from its UI button',
  bScr.during.auto && bScr.during.mode === 'platter' && !bScr.after,
  `during=${bScr.during.mode} stopped=${!bScr.after}`);

/* ------------------------------ hot cues ------------------------------ */

const hc = await frame.evaluate(async () => {
  const A = window.__djclanker.decks.A;
  A.pause();
  A.seek(30);
  A.hotCue(0); // empty pad stores
  const stored = A.hotCues[0];
  const cueArmed = Math.abs(A.cuePoint - stored) < 0.01; // storing arms the main cue
  A.seek(60);
  A.hotCue(0); // set pad JUMPS — and only jumps, no autostart (booth rule)
  await new Promise((r) => setTimeout(r, 300)); // let the seek + a UI tick land
  const jumped = Math.abs(A.position - stored) < 1.5;
  const playing = A.playing;
  const uiSet = document.querySelector('.deck-top.deck-A .btn-hotcue').classList.contains('set');
  A.clearHotCue(0);
  const cleared = A.hotCues[0] === null;
  A.pause();
  return { stored, cueArmed, jumped, playing, uiSet, cleared };
});
check('storing a hot cue arms the main cue', hc.cueArmed, `cue rides at ${hc.stored}s`);
check('hot cue: empty pad stores the position', typeof hc.stored === 'number' && Math.abs(hc.stored - 30) < 0.5,
  `stored=${hc.stored}`);
check('hot cue: set pad jumps WITHOUT autostarting', hc.jumped && !hc.playing,
  `jumped=${hc.jumped} stayedStopped=${!hc.playing}`);
check('hot cue: pad lights while set, clear empties it', hc.uiSet && hc.cleared,
  `ui=${hc.uiSet} cleared=${hc.cleared}`);

// CUE while playing must come back to the armed mark — never to 0:00.
const cueRet = await frame.evaluate(async () => {
  const A = window.__djclanker.decks.A;
  A.pause();
  A.seek(24);
  A.hotCue(1); // store → arms the main cue here
  const armed = A.cuePoint;
  A.play({ instant: true });
  await new Promise((r) => setTimeout(r, 1200));
  const wandered = A.position;
  A.cue(); // playing → pause + return
  const back = !A.playing && Math.abs(A.position - armed) < 0.05;
  A.clearHotCue(1);
  return { armed, wandered, back, pos: A.position };
});
check('CUE returns to the hot-cue mark, not 0:00',
  cueRet.back && Math.abs(cueRet.armed - 24) < 0.5,
  `wandered to ${cueRet.wandered.toFixed(1)}s, CUE → ${cueRet.pos.toFixed(2)}s`);

// The ⧉ 2ND pop-out needs a real window context; in the plain napplet
// sandbox it must refuse politely instead of crashing or half-opening.
const pop = await frame.evaluate(() => {
  const btn = document.querySelector('.btn-pop');
  if (!btn) return { present: false };
  btn.click();
  return { present: true, alive: Boolean(window.__djclanker), on: btn.classList.contains('on') };
});
check('visuals pop-out gates gracefully in the plain sandbox',
  pop.present && pop.alive && !pop.on,
  pop.present ? `blocked cleanly, app alive=${pop.alive}` : 'button missing');

// Barber: the boot-default riser must actually sweep — two staggered voices,
// sweep depth live when on, silent when off.
const barber = await frame.evaluate(async () => {
  const A = window.__djclanker.decks.A;
  A.toggleFx('barber', true);
  await new Promise((r) => setTimeout(r, 250));
  const u = A._graph.barber;
  const on = { voices: u.voices.length, sweep: u.voices[0].sweep.gain.value, wet: u.wet.gain.value };
  A.toggleFx('barber', false);
  await new Promise((r) => setTimeout(r, 250));
  return { on, offSweep: u.voices[0].sweep.gain.value };
});
check('barber sweeps with two staggered voices', barber.on.voices === 2
  && barber.on.sweep > 300 && barber.on.wet > 0.3 && barber.offSweep < 60,
  `voices=${barber.on.voices} sweep=${barber.on.sweep.toFixed(0)}Hz wet=${barber.on.wet.toFixed(2)}`);

// Stage view arms the visualizer WITH the 600 head loaded.
const vz = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  document.querySelector('.btn-stage').click();
  for (let i = 0; i < 20 && !(dj.vis.active && dj.vis.logoReady); i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const state = { active: dj.vis.active, logo: dj.vis.logoReady };
  document.querySelector('.btn-stage').click();
  return state;
});
check('stage visualizer arms with the 600 head', vz.active && vz.logo,
  `active=${vz.active} logoReady=${vz.logo}`);

await page.screenshot({ path: `${OUT}-decks.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
