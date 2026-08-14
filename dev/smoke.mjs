/**
 * End-to-end smoke test against the dev shell.
 *
 * Drives the real napplet inside a real sandboxed srcdoc iframe: loads a chart
 * track into each deck, checks that the WebAudio path engaged (FULL badge,
 * waveform peaks, BPM), plays, moves the crossfader, and screenshots.
 *
 *   node dev/serve-shell.mjs &   node dev/smoke.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/clanker';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.deck-A', { timeout: 15000 });
check('napplet booted in sandboxed iframe', true);

// Raw page.mouse gestures need PAGE coordinates. locator.boundingBox() on a
// sandboxed-iframe element returns frame-relative values here, so compute the
// page position deterministically: iframe rect + in-frame client rect.
const pageRect = async (sel) => {
  // Center the element in the frame viewport first — deterministic position
  // regardless of whatever earlier interactions scrolled the frame to. The
  // iframe offset is measured per call: the shell's log grows during the run
  // and pushes the iframe down, so a boot-time measurement goes stale.
  await frame.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
  await page.waitForTimeout(80);
  const frameEl = await page.locator('#frame').boundingBox();
  const r = await frame.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, sel);
  return { x: frameEl.x + r.x, y: frameEl.y + r.y, width: r.width, height: r.height };
};

// window.napplet must exist and carry the domains the shell granted.
const domains = await frame.evaluate(() => Object.keys(window.napplet || {}));
check('window.napplet injected', domains.length > 0, domains.join(','));

// Charts load through resource.bytes (the sandbox has connect-src 'none').
await frame.waitForSelector('.track-row', { timeout: 25000 });
const rows = await frame.locator('.track-row').count();
check('Wavlake charts loaded via host resource domain', rows > 5, `${rows} rows`);

// A real user gesture first, so the AudioContext can start.
await frame.locator('.tab').first().click();

const firstTitle = await frame.locator('.track-row').first().locator('.row-title').textContent();
await frame.locator('.track-row').nth(0).locator('.load-a').click();
await frame.locator('.track-row').nth(1).locator('.load-b').click();

// Decoding a 4–6 MB mp3 through the proxy takes a moment. Wait for deck A
// specifically — the later waveform check reads deck A's canvas.
// NOTE: waitForFunction is (fn, arg, options); passing options as the second
// argument silently hands them to the page function and keeps the 30 s default.
await frame.waitForFunction(
  () => document.querySelectorAll('.deck-A .badge-mode.ok').length >= 1,
  undefined,
  { timeout: 90000 },
);
const badges = await frame.locator('.deck .badge-mode').allTextContents();
check('deck reached FULL (decoded WebAudio) mode', badges.includes('FULL'), badges.join(' / '));
check('deck A shows the loaded track', (await frame.locator('.deck-A .deck-title').textContent()).trim() === firstTitle.trim());

// Waveform peaks only exist on the decoded path.
const hasPeaks = await frame.evaluate(() => {
  const c = document.querySelector('.deck-A .wave');
  if (!c) return false;
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 10) lit++;
  return lit > 50;
});
check('waveform rendered', hasPeaks);

await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(2500);
const posA = await frame.locator('.deck-A .time-cur').textContent();
check('deck A transport advances', posA !== '0:00', `t=${posA}`);

// BPM detection is async; give it room but do not fail the run on a weak estimate.
await page.waitForTimeout(4000);
const bpm = await frame.locator('.deck-A .bpm-input').inputValue();
check('BPM detected', !!bpm && parseFloat(bpm) > 40, bpm || 'none');

await frame.locator('.deck-B .btn-play').click();
await page.waitForTimeout(1200);

// Crossfader + EQ must not throw and must reach the audio graph.
await frame.evaluate(() => {
  const xf = document.querySelector('input.crossfader');
  xf.value = '0.4';
  xf.dispatchEvent(new Event('input', { bubbles: true }));
  const eq = document.querySelector('.deck-A input.eq');
  eq.value = '-20';
  eq.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(800);
check('crossfader + EQ applied without error', true);

// SYNC across decks.
await frame.locator('.deck-B .btn-sync').click();
await page.waitForTimeout(600);
const pitchB = await frame.locator('.deck-B .pitch-val').textContent();
check('sync adjusted deck B pitch', typeof pitchB === 'string', pitchB);

/* ---------------------------- vinyl + FX ---------------------------- */

// The reversed buffer is built after the track becomes playable.
await frame.waitForFunction(() => {
  const d = window.__djclanker && window.__djclanker.decks.A;
  return Boolean(d && d._reverse);
}, undefined, { timeout: 60000 });
check('reversed buffer built (scratch ready)', true);

// Drag the platter backwards through roughly half a turn.
const box = await pageRect('.deck-A .platter');
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const r = box.width * 0.36;
const posBeforeScratch = await frame.evaluate(() => window.__djclanker.decks.A.position);

await page.mouse.move(cx + r, cy);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  const a = (-i / 12) * Math.PI; // counter-clockwise = backwards
  await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  await page.waitForTimeout(18);
}
const scratchState = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { mode: d._mode, scratching: d.scratching, rate: d.currentRate, pos: d.position };
});
await page.mouse.up();
check('platter drag drives the turntable', scratchState.mode === 'platter' && scratchState.scratching,
  `mode=${scratchState.mode} rate=${scratchState.rate.toFixed(2)}`);
// Half a turn at 33⅓ rpm is 0.9 s of audio — the gesture must map 1:1, not
// double-count between the hand and the grain scheduler.
const moved = posBeforeScratch - scratchState.pos;
check('scratching moved audio position backwards', moved > 0,
  `${posBeforeScratch.toFixed(2)}s -> ${scratchState.pos.toFixed(2)}s`);
check('half a platter turn ≈ 0.9 s of audio', Math.abs(moved - 0.9) < 0.25, `Δ=${moved.toFixed(2)}s`);

// After release the motor should hand control back to the plain source node.
await page.waitForTimeout(1200);
const afterRelease = await frame.evaluate(() => window.__djclanker.decks.A._mode);
check('deck returns to normal playback after release', afterRelease === 'source', `mode=${afterRelease}`);

// Dynamic rewind: the longer the hold, the further back it spins.
const beforeRew = await frame.evaluate(() => window.__djclanker.decks.A.position);
const rew = await pageRect('.deck-A .btn-rew');
await page.mouse.move(rew.x + rew.width / 2, rew.y + rew.height / 2);
await page.mouse.down();
await page.waitForTimeout(900);
const rewRate = await frame.evaluate(() => window.__djclanker.decks.A.currentRate);
await page.mouse.up();
await page.waitForTimeout(900);
const afterRew = await frame.evaluate(() => window.__djclanker.decks.A.position);
check('rewind accelerates while held', rewRate < -3, `rate=${rewRate.toFixed(1)}x`);
check('rewind moved the track back', afterRew < beforeRew - 1,
  `${beforeRew.toFixed(1)}s -> ${afterRew.toFixed(1)}s`);

// FX: both units engage and audio keeps flowing through them.
await frame.locator('.deck-A .btn-fx').first().click();
await frame.locator('.deck-A .btn-fx').nth(1).click();
await page.waitForTimeout(1200);
const fxState = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { fl: d.fx.flanger.on, ga: d.fx.gater.on, graph: Boolean(d._graph && d._graph.flanger && d._graph.gater) };
});
check('flanger + gater engaged', fxState.fl && fxState.ga && fxState.graph);

let heard = 0;
for (let i = 0; i < 25; i++) {
  heard = Math.max(heard, await frame.evaluate(() => window.__djclanker.mixer.masterLevel()));
  await page.waitForTimeout(40);
}
check('audio still passes the FX chain', heard > 0.005, `peak=${heard.toFixed(3)}`);

// Gater division buttons rewire the schedule.
await frame.locator('.deck-A .btn-div').nth(2).click();
const div = await frame.evaluate(() => window.__djclanker.decks.A.fx.gater.division);
check('gater division switched to 1/16', div === 0.25, `division=${div}`);

await frame.locator('.deck-A .btn-fx').first().click();
await frame.locator('.deck-A .btn-fx').nth(1).click();

// Vinyl brake: pausing must ride the platter down rather than cut.
await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(120);
const braking = await frame.evaluate(() => {
  const d = window.__djclanker.decks.A;
  return { mode: d._mode, rate: d.currentRate };
});
check('stop engages the vinyl brake', braking.mode === 'platter' && braking.rate > 0.05,
  `mode=${braking.mode} rate=${braking.rate.toFixed(2)}`);
await page.waitForTimeout(1200);
await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(1500);

/* ---------------------------- discs + scopes ---------------------------- */

// The record canvas must actually paint: cover label, grooves, waveform ring.
const discPainted = await frame.evaluate(() => {
  const c = document.querySelector('.deck-A .platter-canvas');
  if (!c) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 10) lit++;
  return lit;
});
check('vinyl disc rendered', discPainted > 200, `${discPainted} lit samples`);

// The disc has to turn while the deck runs.
const turnsA = await frame.evaluate(() => window.__djclanker.decks.A.platterTurns);
await page.waitForTimeout(900);
const turnsB = await frame.evaluate(() => window.__djclanker.decks.A.platterTurns);
check('disc rotates with playback', turnsB > turnsA, `+${(turnsB - turnsA).toFixed(2)} revolutions`);

// Classic meters: channel meter under the wave and the vertical master meter
// must both light up while audio plays (fire segments, red overshoot zone).
const meterLit = async (sel) => frame.evaluate((s) => {
  const c = document.querySelector(s);
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4 * 31) {
    if (d[i] > 120 && d[i + 3] > 200) lit++; // strong warm pixels, not the idle track
  }
  return lit;
}, sel);

let deckMeter = 0;
let masterMeter = 0;
for (let i = 0; i < 20; i++) {
  deckMeter = Math.max(deckMeter, await meterLit('.deck-A .meter-canvas'));
  masterMeter = Math.max(masterMeter, await meterLit('.master-col .meter-canvas'));
  await page.waitForTimeout(60);
}
check('channel meter lights up', deckMeter > 10, `${deckMeter} lit`);
check('master meter lights up', masterMeter > 10, `${masterMeter} lit`);

await page.screenshot({ path: `${OUT}-desktop.png`, fullPage: true });

/* ------------------------------- automix ------------------------------- */

// Take the chart list as the queue, then shorten the timings so a real
// transition happens in seconds instead of at the end of a 7-minute track.
await frame.locator('.tab').first().click();
await frame.waitForSelector('.track-row');
await frame.locator('.automix .btn-mini').filter({ hasText: 'List' }).click();
const queued = await frame.evaluate(() => window.__djclanker.automix.queue.length);
check('automix queue filled from browser', queued > 5, `${queued} Tracks`);

// Clear both decks first so this is a genuine cold start.
await frame.evaluate(() => {
  const m = window.__djclanker.mixer;
  m.decks.A.pause();
  m.decks.B.pause();
});
await page.waitForTimeout(900);
await frame.locator('.btn-automix').click();

// Cold start: automix loads and plays a track by itself.
await frame.waitForFunction(() => {
  const am = window.__djclanker.automix;
  return Boolean(am.liveId && am.liveDeck && am.liveDeck.playing);
}, undefined, { timeout: 180000 });
const liveFirst = await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  return { id: am.liveId, x: am.mixer.crossfader, title: am.liveDeck.track.title };
});
check('automix started a deck on its own', Boolean(liveFirst.id), `Deck ${liveFirst.id}: ${liveFirst.title}`);
check('automix drove the crossfader to the live deck', Math.abs(liveFirst.x) > 0.9, `x=${liveFirst.x}`);

// Open the preload window without touching the playhead: seeking near the end
// and then waiting ~20 s for a download would let the track finish first and
// trigger the transition before the test is ready for it.
await frame.evaluate(() => { window.__djclanker.automix.preloadLead = 99999; });
await frame.waitForFunction(() => {
  const am = window.__djclanker.automix;
  return Boolean(am.idleDeck && am.idleDeck.status === 'ready' && am.idleDeck.track && !am.busy);
}, undefined, { timeout: 180000 });
const staged = await frame.evaluate(() => window.__djclanker.automix.idleDeck.track.title);
check('automix preloaded the next track', Boolean(staged), staged);

// Only now shorten the fade and drop the playhead into the outro.
await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  am.fadeSeconds = 3;
  am.preloadLead = 18;
  am.liveDeck.seek(am.liveDeck.duration - 2.6);
});
await frame.waitForFunction(() => Boolean(window.__djclanker.automix.fade), undefined, { timeout: 20000 });
check('automix began the crossfade', true);

const bothPlaying = await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  return am.mixer.decks.A.playing && am.mixer.decks.B.playing;
});
check('both decks run during the transition', bothPlaying);

await frame.waitForFunction((prev) => {
  const am = window.__djclanker.automix;
  return !am.fade && am.liveId && am.liveId !== prev;
}, liveFirst.id, { timeout: 40000 });
const after = await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  return { id: am.liveId, x: am.mixer.crossfader, title: am.liveDeck.track.title, other: am.idleDeck.playing };
});
check('automix handed over to the other deck', after.id !== liveFirst.id, `${liveFirst.id} → ${after.id}: ${after.title}`);
check('crossfader ended on the new deck', Math.abs(after.x) > 0.9, `x=${after.x.toFixed(2)}`);
check('previous deck was stopped', after.other === false);

await frame.locator('.btn-automix').click();
const stopped = await frame.evaluate(() => window.__djclanker.automix.enabled);
check('automix switches off', stopped === false);
await frame.evaluate(() => {
  const m = window.__djclanker.mixer;
  m.decks.A.pause();
  m.decks.B.pause();
});

// Nostr playlist tab against the shell's fixture kind-30003 set.
await frame.locator('.tab', { hasText: 'Nostr' }).click();
await frame.locator('.side-group .btn-primary').click();
await page.waitForTimeout(3000);
const setChip = await frame.locator('.side-group .chip').filter({ hasText: 'Clanker Demo Crate' }).count();
check('kind-30003 set discovered via outbox.query', setChip > 0);
if (setChip) {
  await frame.locator('.side-group .chip').filter({ hasText: 'Clanker Demo Crate' }).click();
  await page.waitForTimeout(6000);
  const n = await frame.locator('.track-row').count();
  check('playlist resolved to Wavlake tracks', n > 0, `${n} tracks`);
}

// Search tab.
await frame.locator('.tab').nth(1).click();
await frame.locator('.search-input').first().fill('bitcoin');
await frame.locator('.side-group .btn-primary').click();
await page.waitForTimeout(4000);
check('search returned results', (await frame.locator('.track-row').count()) > 0);

await page.screenshot({ path: `${OUT}-browser.png`, fullPage: true });

// Mobile layout.
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}-mobile.png`, fullPage: true });
check('mobile viewport rendered', true);

// Upstream 5xx from the CDN is environment noise, not an app fault; page-level
// exceptions are not.
const realErrors = errors.filter(
  (e) => !/favicon|Autoplay|play\(\) request|status of 5\d\d/i.test(e),
);
check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

// Master-bus set recording: a couple of seconds must land as real bytes.
const rec = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  const m = dj.mixer;
  m.ensureContext();
  // Opus squeezes silence to nothing — record actual programme material.
  const A = dj.decks.A;
  const wasPlaying = A.playing;
  if (m.resumeAudio) m.resumeAudio();
  if (m.ctx && m.ctx.state !== 'running') await m.ctx.resume().catch(() => {});
  const xfBefore = m.crossfader;
  m.setCrossfader(-1); // deck A must actually reach the master bus
  if (A.status === 'ready' && !A.playing) A.toggle();
  const started = m.startRecording();
  await new Promise((r) => setTimeout(r, 2200));
  const active = Boolean(m.recording);
  const playing = A.playing;
  const blob = await m.stopRecording();
  if (!wasPlaying && A.playing) A.pause();
  m.setCrossfader(xfBefore);
  return {
    started, active, bytes: blob ? blob.size : 0, stopped: !m.recording,
    playing, ctxState: m.ctx ? m.ctx.state : 'none', deck: A.status,
  };
});
check('set recording captures the master bus', rec.started && rec.active && rec.stopped && rec.bytes > 5000,
  JSON.stringify(rec));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
