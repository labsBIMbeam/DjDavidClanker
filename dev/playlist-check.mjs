/**
 * E2E for the track playlist (crate): collect all artist tracks via
 * "+ alle → Playlist", verify the playlist menu, add one more track found
 * through search, and load from the playlist onto a deck.
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/playlist-check.mjs
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/playlist';

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

// Artist view: search → chip → 10 Zazawowow rows.
await frame.locator('.tab').nth(1).click();
await frame.locator('.search-input').first().fill('zazawowow');
await frame.locator('.side-group .btn-primary').click();
const artistChip = frame.locator('.side-group .chip', { hasText: /zazawowow/i }).first();
await artistChip.waitFor({ timeout: 25000 });
await artistChip.click();
await frame.locator('.track-row .row-title', { hasText: /Death is a Gift/i }).first().waitFor({ timeout: 30000 });
const artistRows = await frame.locator('.track-row').count();
check('artist view listed', artistRows === 10, `${artistRows} rows`);

// "+ alle → Playlist" puts the whole list into the crate.
await frame.locator('.btn-addall').click();
await frame.locator('.browser-h2', { hasText: /added to playlist/ }).waitFor({ timeout: 10000 });
check('added all listed tracks to playlist', true);

// Crate tab: playlist menu shows every track, list auto-opens the playlist.
await frame.locator('.tab').nth(2).click();
await frame.locator('.browser-h1', { hasText: 'Playlist' }).waitFor({ timeout: 10000 });
const menuChips = await frame.locator('.side-group .chip', { hasText: '♪' }).count();
const plRows = await frame.locator('.track-row').count();
check('playlist menu lists all tracks', menuChips === 10, `${menuChips} chips`);
check('playlist view shows all tracks', plRows === 10, `${plRows} rows`);

// Search another track and add it via the row "+" button.
await frame.locator('.tab').nth(1).click();
await frame.locator('.search-input').first().fill('bitcoin');
await frame.locator('.side-group .btn-primary').click();
await frame.locator('.browser-h1', { hasText: 'Search: bitcoin' }).waitFor({ timeout: 25000 });
const searchRows = await frame.locator('.track-row').count();
check('search found other tracks', searchRows > 0, `${searchRows} rows`);
const addedTitle = (await frame.locator('.track-row .row-title').first().textContent()).trim();
await frame.locator('.track-row').first().locator('.btn-addpl').click();
await page.waitForTimeout(400);

// Back to the crate: 11 entries now, and the new one loads onto deck A.
await frame.locator('.tab').nth(2).click();
await frame.locator('.browser-h1', { hasText: 'Playlist' }).waitFor({ timeout: 10000 });
const menuChips2 = await frame.locator('.side-group .chip', { hasText: '♪' }).count();
check('searched track joined the playlist', menuChips2 === 11, `${menuChips2} chips (+ ${addedTitle})`);

await frame.locator('.track-row').nth(10).locator('.load-a').click();
await frame.waitForFunction(
  () => document.querySelectorAll('.deck-A .badge-mode.ok').length >= 1,
  undefined,
  { timeout: 120000 },
);
const deckTitle = (await frame.locator('.deck-A .deck-title').textContent()).trim();
check('playlist track loads onto deck A (FULL)', deckTitle === addedTitle, deckTitle);

// Duplicates are ignored, removal updates menu and view.
await frame.locator('.track-row').nth(0).locator('.btn-addpl').click();
await page.waitForTimeout(400);
const menuChips3 = await frame.locator('.side-group .chip', { hasText: '♪' }).count();
check('duplicates are not added twice', menuChips3 === 11, `${menuChips3} chips`);
await frame.locator('.side-group .crate-row').first().locator('.btn-mini', { hasText: '×' }).click();
await page.waitForTimeout(400);
const menuChips4 = await frame.locator('.side-group .chip', { hasText: '♪' }).count();
const plRows4 = await frame.locator('.track-row').count();
check('remove updates menu and view', menuChips4 === 10 && plRows4 === 10, `${menuChips4} chips / ${plRows4} rows`);

await page.screenshot({ path: `${OUT}-crate.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
