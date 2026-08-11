/**
 * E2E for the Macro FX (one-knob combos) and the channel-filter models.
 *
 * Everything is asserted against the live audio graph — node types, sweep
 * frequencies, feedback levels, scheduled automation — plus a few audible
 * facts (echo tail rings after pause, noise sounds without a playing track,
 * gate modulates the level). Runs against the dev shell like the others:
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/macro-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/macro';

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
await frame.waitForSelector('.track-row', { timeout: 30000 });
await frame.locator('.tab').first().click();
await frame.locator('.track-row').nth(0).locator('.load-a').click();
await frame.waitForFunction(() => document.querySelectorAll('.deck-A .badge-mode.ok').length >= 1,
  undefined, { timeout: 90000 });

const dj = (fn, arg) => frame.evaluate(fn, arg);

/* ------------------------------ defaults ------------------------------ */

const defaults = await dj(() => {
  const A = window.__djclanker.decks.A;
  const m = A._graph.macro;
  return {
    type: A.macro.type, value: A.macro.value,
    sweepType: m.sweep.type, sweepFreq: m.sweep.frequency.value,
    wet: m.wetOut.gain.value, filterModel: A.filterModel,
  };
});
check('macro defaults to a neutral DUB ECHO', defaults.type === 'echo' && defaults.value === 0
  && defaults.sweepType === 'lowpass' && defaults.sweepFreq > 20000 && defaults.wet < 0.01,
  `sweep=${defaults.sweepFreq.toFixed(0)}Hz wet=${defaults.wet.toFixed(3)}`);

/* ------------------------------- echo ------------------------------- */

await dj(() => {
  const A = window.__djclanker.decks.A;
  window.__djclanker.mixer.setCrossfader(-1);
  window.__djclanker.mixer.resumeAudio();
  A.play();
  A.setMacroValue(-0.8);
});
await page.waitForTimeout(1500);

const echo = await dj(() => {
  const A = window.__djclanker.decks.A;
  const m = A._graph.macro;
  const beat = 60 / (A.liveBpm || A.effectiveBpm || 120);
  return {
    sweepType: m.sweep.type, sweepFreq: m.sweep.frequency.value,
    wet: m.wetOut.gain.value, fb: m._echo.fbA.gain.value,
    delay: m._echo.dA.delayTime.value, dotted: beat * 0.75,
  };
});
check('ECHO left: lowpass sweep engaged', echo.sweepType === 'lowpass' && echo.sweepFreq < 1500,
  `${echo.sweepFreq.toFixed(0)} Hz`);
check('ECHO: wet and ping-pong feedback up', echo.wet > 0.25 && echo.fb > 0.5,
  `wet=${echo.wet.toFixed(2)} fb=${echo.fb.toFixed(2)}`);
check('ECHO: delay is a dotted eighth of the live BPM',
  Math.abs(echo.delay - echo.dotted) / echo.dotted < 0.12,
  `${(echo.delay * 1000).toFixed(0)} ms vs ${(echo.dotted * 1000).toFixed(0)} ms`);

// The tail must ring on after the track pauses — that is what an echo is for.
await dj(() => window.__djclanker.decks.A.pause());
const tail = await dj(async () => {
  const mx = window.__djclanker.mixer;
  let peak = 0;
  for (let i = 0; i < 25; i++) {
    peak = Math.max(peak, mx.masterLevel());
    await new Promise((r) => setTimeout(r, 25));
  }
  return peak;
});
check('ECHO: tail rings after pause', tail > 0.004, `peak=${tail.toFixed(3)}`);

/* ------------------------------- space ------------------------------- */

await dj(() => {
  const A = window.__djclanker.decks.A;
  A.setMacroValue(0);
  A.setMacroType('space');
  A.setMacroValue(0.7);
});
// setTargetAtTime approaches its target asymptotically — give it a few time
// constants before reading, or the getter reports the mid-glide value.
await page.waitForTimeout(300);
const space = await dj(() => {
  const m = window.__djclanker.decks.A._graph.macro;
  return {
    sweepType: m.sweep.type, sweepFreq: m.sweep.frequency.value,
    wet: m.wetOut.gain.value, impulseSecs: m._space.conv.buffer.duration,
  };
});
check('SPACE right: highpass sweep engaged', space.sweepType === 'highpass' && space.sweepFreq > 250,
  `${space.sweepFreq.toFixed(0)} Hz`);
check('SPACE: reverb wet up on a long impulse', space.wet > 0.3 && space.impulseSecs > 2.5,
  `wet=${space.wet.toFixed(2)} impulse=${space.impulseSecs.toFixed(1)}s`);

/* ------------------------------- noise ------------------------------- */

await dj(() => {
  const A = window.__djclanker.decks.A;
  A.setMacroType('noise');
  A.setMacroValue(0.8);
});
await page.waitForTimeout(400);
const noiseOn = await dj(async () => {
  const mx = window.__djclanker.mixer;
  let peak = 0;
  for (let i = 0; i < 15; i++) {
    peak = Math.max(peak, mx.masterLevel());
    await new Promise((r) => setTimeout(r, 25));
  }
  return peak;
});
await dj(() => window.__djclanker.decks.A.setMacroValue(0));
await page.waitForTimeout(500);
const noiseOff = await dj(() => window.__djclanker.mixer.masterLevel());
check('NOISE: riser audible with the deck paused', noiseOn > 0.006, `peak=${noiseOn.toFixed(3)}`);
check('NOISE: silent again at the detent', noiseOff < noiseOn / 2,
  `${noiseOff.toFixed(4)} vs ${noiseOn.toFixed(3)}`);

/* -------------------------------- gate -------------------------------- */

await dj(() => {
  const A = window.__djclanker.decks.A;
  A.play();
  A.setMacroType('gate');
  A.setMacroValue(0.9);
});
await page.waitForTimeout(900);
// Assert on the gate's own gain automation, not on the music: track dynamics
// make a master-level comparison flaky, the scheduled param is deterministic.
const gate = await dj(async () => {
  const m = window.__djclanker.decks.A._graph.macro;
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < 60; i++) {
    const g = m.gate.gain.gain.value;
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
    await new Promise((r) => setTimeout(r, 8));
  }
  return { lo, hi, on: m.gate.on };
});
await dj(() => window.__djclanker.decks.A.setMacroValue(0));
await page.waitForTimeout(300);
const gateOff = await dj(() => window.__djclanker.decks.A._graph.macro.gate.on);
check('GATE: gain automation chops between open and closed', gate.on && gate.lo < 0.15 && gate.hi > 0.85,
  `lo=${gate.lo.toFixed(2)} hi=${gate.hi.toFixed(2)}`);
check('GATE: releases at the detent', gateOff === false);

/* ------------------------------- barber ------------------------------- */

await dj(() => {
  const A = window.__djclanker.decks.A;
  A.setMacroType('barber');
  A.setMacroValue(0.6);
});
await page.waitForTimeout(400);
const barberA = await dj(() => window.__djclanker.decks.A._graph.macro._voices[0].delay.delayTime.value);
await page.waitForTimeout(400);
const barber = await dj((prev) => {
  const m = window.__djclanker.decks.A._graph.macro;
  return {
    moved: Math.abs(m._voices[0].delay.delayTime.value - prev),
    wet: m.wetOut.gain.value, dirUp: m._dirUp,
  };
}, barberA);
check('BARBER: voice delay sweeps over time', barber.moved > 0.0004 && barber.wet > 0.15,
  `Δ=${(barber.moved * 1000).toFixed(2)} ms wet=${barber.wet.toFixed(2)}`);
const barberFlip = await dj(() => {
  const A = window.__djclanker.decks.A;
  A.setMacroValue(-0.6);
  return A._graph.macro._dirUp;
});
check('BARBER: left turn reverses the sweep direction', barberFlip === false);
await dj(() => { const A = window.__djclanker.decks.A; A.setMacroValue(0); A.pause(); });

/* --------------------------- filter models --------------------------- */

const models = await dj(() => {
  const A = window.__djclanker.decks.A;
  const f = A._graph.filter;
  const grab = () => ({
    type: f.f1.type, freq: f.f1.frequency.value, q1: f.f1.Q.value,
    f2type: f.f2.type, q2: f.f2.Q.value,
    shaper: f.shaper.curve !== null, drive: f.drive.gain.value,
  });
  A.setFilterModel('clean');
  A.setFilter(-0.6);
  const clean = grab();
  A.setFilterModel('xone');
  const xone = grab();
  A.setFilterModel('djm');
  const djm = grab();
  A.setFilterModel('clean');
  A.setFilter(0);
  const neutral = grab();
  return { clean, xone, djm, neutral };
});
check('CLEAN: 2-pole, low Q, no crunch', models.clean.type === 'lowpass' && models.clean.freq < 2000
  && models.clean.q1 < 0.8 && models.clean.f2type === 'peaking' && !models.clean.shaper,
  `f=${models.clean.freq.toFixed(0)}Hz Q=${models.clean.q1.toFixed(2)}`);
check('XONE: 4-pole with resonance and saturation', models.xone.f2type === 'lowpass'
  && models.xone.q1 > 1.2 && models.xone.shaper && models.xone.drive > 1.5,
  `Q1=${models.xone.q1.toFixed(2)} Q2=${models.xone.q2.toFixed(2)} drive=${models.xone.drive.toFixed(2)}`);
check('DJM: 2-pole with raised Q, no crunch', models.djm.f2type === 'peaking'
  && models.djm.q1 > 0.9 && models.djm.q1 < 1.6 && !models.djm.shaper,
  `Q=${models.djm.q1.toFixed(2)}`);
check('neutral position is transparent again', models.neutral.freq > 20000
  && models.neutral.q1 < 0.8 && !models.neutral.shaper);

/* --------------------------------- UI --------------------------------- */

// The macros live in the standard FX slots: the slot select lists them, the
// slot body becomes one bipolar amount fader, the slot button punches.
await frame.locator('.deck-top.deck-A .fx-sel').first().selectOption('macro:echo');
const slotSel = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  const sel = document.querySelector('.deck-top.deck-A .fx-sel');
  return {
    slot0: d.fxSlots[0], engineType: d.macro.type,
    macroOptions: [...sel.options].filter((o) => o.value.startsWith('macro:')).length,
  };
});
check('slot select lists the five macro combos', slotSel.macroOptions === 5,
  `${slotSel.macroOptions} options`);
check('selecting a macro in a slot drives the engine',
  slotSel.slot0 === 'macro:echo' && slotSel.engineType === 'echo',
  `slot=${slotSel.slot0} type=${slotSel.engineType}`);

const uiAmount = await frame.evaluate(() => {
  const fdr = document.querySelector('.deck-top.deck-A .fx-body-macro input.macro');
  if (!fdr) return { present: false };
  fdr.value = '-0.5';
  fdr.dispatchEvent(new Event('input', { bubbles: true }));
  return { present: true, value: window.__djclanker.decks.A.macro.value };
});
check('slot body is one bipolar amount fader that drives the deck',
  uiAmount.present && Math.abs(uiAmount.value + 0.5) < 0.01, `value=${uiAmount.value}`);

const punch = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  d.toggleFx('macro:echo'); // punch out (was -0.5)
  const out = d.macro.value;
  d.toggleFx('macro:echo'); // punch back in to the remembered amount
  const back = d.macro.value;
  return { out, back };
});
check('slot button punches out and back to the last amount',
  punch.out === 0 && Math.abs(punch.back + 0.5) < 0.01,
  `out=${punch.out} back=${punch.back}`);

const collision = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  d.setFxSlot(1, 'macro:noise'); // only ONE macro engine — slots must swap
  const r = { slots: d.fxSlots.slice(), type: d.macro.type };
  d.setMacroValue(0);
  d.setFxSlot(0, 'flanger');
  d.setFxSlot(1, 'gater');
  return r;
});
check('second macro slot swaps — one macro engine per deck',
  collision.slots[0] === 'gater' && collision.slots[1] === 'macro:noise'
  && collision.type === 'noise', collision.slots.join(' | '));

const strip = await frame.evaluate(() => ({
  macroRows: document.querySelectorAll('.macro-row').length,
  modelBtn: (document.querySelector('.channel-strip.deck-A .btn-fltmodel') || {}).textContent,
}));
check('channel strip carries no extra macro menu anymore', strip.macroRows === 0,
  `${strip.macroRows} rows`);
check('filter-model button present', strip.modelBtn === 'CLN', `label=${strip.modelBtn}`);

await frame.evaluate(() => window.__djclanker.decks.A.setMacroValue(0));
await page.screenshot({ path: `${OUT}-macro.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
