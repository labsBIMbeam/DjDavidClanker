/**
 * One-off: search the running dev shell for Zazawowow, load two tracks onto
 * the decks, play, and screenshot. Assumes serve-shell.mjs is already up.
 *
 *   node dev/zaza-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/zaza';
const TERM = process.env.TERM_Q || 'zazawowow';

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.deck-A', { timeout: 15000 });

// Search tab → term → search. The track list only gets DIRECT track-name
// matches; artists arrive as side-panel chips (openArtist loads their tracks).
await frame.locator('.tab').nth(1).click();
await frame.locator('.search-input').first().fill(TERM);
await frame.locator('.side-group .btn-primary').click();

const artistChip = frame.locator('.side-group .chip', { hasText: /zazawowow/i }).first();
await artistChip.waitFor({ timeout: 25000 });
console.log('artist chip found, opening artist…');
await artistChip.click();

// Rows are stale (charts) until artistTracks lands — wait for a known title.
await frame
  .locator('.track-row .row-title', { hasText: /Death is a Gift|WEBFIVE|Decentrealise/i })
  .first()
  .waitFor({ timeout: 30000 });
const rows = await frame.locator('.track-row').count();
const titles = await frame.locator('.track-row .row-title').allTextContents();
console.log(`artist "${TERM}": ${rows} rows`);
titles.slice(0, 10).forEach((t) => console.log('  -', t));

// Load the first two results onto the decks.
await frame.locator('.track-row').nth(0).locator('.load-a').click();
await frame.locator('.track-row').nth(1).locator('.load-b').click();

await frame.waitForFunction(
  () => document.querySelectorAll('.deck .badge-mode.ok').length >= 2,
  undefined,
  { timeout: 120000 },
);
const badges = await frame.locator('.deck .badge-mode').allTextContents();
const titleA = (await frame.locator('.deck-A .deck-title').textContent()).trim();
const titleB = (await frame.locator('.deck-B .deck-title').textContent()).trim();

await frame.locator('.deck-A .btn-play').click();
await page.waitForTimeout(4000);
const bpmA = await frame.locator('.deck-A .bpm-input').inputValue();
const pos = await frame.locator('.deck-A .time-cur').textContent();
const level = await frame.evaluate(() => window.__djclanker.mixer.masterLevel());

console.log(`deck A: ${titleA}  [${badges[0]}]  BPM=${bpmA}  t=${pos}  master=${level.toFixed(3)}`);
console.log(`deck B: ${titleB}  [${badges[1]}]`);

await page.screenshot({ path: `${OUT}-decks.png`, fullPage: true });
await browser.close();

const ok = badges.every((b) => b === 'FULL') && level > 0.005;
console.log(ok ? 'ZAZA CHECK PASSED' : 'ZAZA CHECK FAILED');
process.exit(ok ? 0 : 1);
