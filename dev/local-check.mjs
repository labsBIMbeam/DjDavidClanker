/**
 * E2E for local file playback: a generated WAV goes in through the 📁 input,
 * shows up as a row (artist/title parsed from the name), is barred from
 * playlist and zap, loads onto deck A in FULL mode and audibly plays.
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/local-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/local';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** Minimal 16-bit mono WAV: 120-BPM clicks over a 220 Hz tone. */
function makeWav(seconds = 4, sr = 44100) {
  const n = seconds * sr;
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
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = t % 0.5;
    const click = ph < 0.05 ? Math.sin(2 * Math.PI * 70 * ph) * Math.exp(-ph * 70) : 0;
    const tone = 0.18 * Math.sin(2 * Math.PI * 220 * t);
    buf.writeInt16LE(Math.max(-1, Math.min(1, tone + click)) * 32767, 44 + i * 2);
  }
  return buf;
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.deck-A', { timeout: 15000 });
await frame.locator('.tab').first().click();

await frame.locator('input.local-input').setInputFiles({
  name: 'Test Artist - Local Beat.wav',
  mimeType: 'audio/wav',
  buffer: makeWav(),
});
await frame.locator('.browser-h1', { hasText: 'Local songs' }).waitFor({ timeout: 10000 });
const rows = await frame.locator('.track-row').count();
check('local file appears as a row', rows === 1, `${rows} row(s)`);
const title = (await frame.locator('.track-row .row-title').first().textContent()).trim();
const artist = (await frame.locator('.track-row .row-artist').first().textContent()).trim();
check('name splits into artist/title', title === 'Local Beat' && artist === 'Test Artist', `${artist} – ${title}`);

const plDisabled = await frame.locator('.track-row .btn-addpl').first().isDisabled();
const zapDisabled = await frame.locator('.track-row .btn-zap-mini').first().isDisabled();
check('playlist + zap are barred for local files', plDisabled && zapDisabled);

await frame.locator('.track-row').first().locator('.load-a').click();
await frame.waitForFunction(
  () => document.querySelectorAll('.deck-A .badge-mode.ok').length >= 1,
  undefined,
  { timeout: 30000 },
);
const deck = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { backend: A.backend, duration: A.duration, title: A.track.title };
});
check('local file decodes to FULL mode', deck.backend === 'buffer' && deck.duration > 3.5,
  `${deck.duration.toFixed(1)}s`);

await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(1800);
const playing = await frame.evaluate(() => ({
  pos: window.__djclanker.decks.A.position,
  level: window.__djclanker.mixer.masterLevel(),
}));
check('local file plays with signal', playing.pos > 0.5 && playing.level > 0.005,
  `t=${playing.pos.toFixed(1)}s master=${playing.level.toFixed(3)}`);

// The session-local list accumulates: a second pick joins the first.
await frame.locator('input.local-input').setInputFiles({
  name: 'Second Artist - Another Beat.wav',
  mimeType: 'audio/wav',
  buffer: makeWav(2),
});
await frame.locator('.browser-h2', { hasText: '2 loaded this session' }).waitFor({ timeout: 10000 });
const localRows = await frame.locator('.track-row').count();
check('local file list accumulates across picks', localRows === 2, `${localRows} rows`);

// The catalog remembers imports (metadata survives reloads), and an entry
// with no live File renders as a disabled ghost row.
const cat = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  const remembered = dj.localSongs.all.length;
  dj.localSongs.remember({
    title: 'Ghost Tune', artist: 'Past Session',
    localFile: { name: 'ghost.wav', size: 12345 }, duration: 90,
  });
  document.querySelectorAll('.tab')[4].click(); // Local re-render
  await new Promise((r) => setTimeout(r, 200));
  const rows = [...document.querySelectorAll('.track-row')];
  const ghost = rows.find((r) => r.textContent.includes('Ghost Tune'));
  return {
    remembered,
    rows: rows.length,
    ghostDisabled: ghost ? ghost.querySelector('.load-a').disabled : null,
  };
});
check('local catalog remembers every import', cat.remembered === 2, `${cat.remembered} remembered`);
check('remembered-only entries render as disabled ghosts',
  cat.rows === 3 && cat.ghostDisabled === true, JSON.stringify(cat));

await frame.locator('.mode-setlist').click();
const localChips = await frame.locator('.side-group .chip', { hasText: '📁' }).count();
check('SET & CRATE side lists the session local files', localChips === 2, `${localChips} chips`);

await page.screenshot({ path: `${OUT}-deck.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
