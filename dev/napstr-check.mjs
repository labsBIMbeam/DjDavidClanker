/**
 * E2E for the Napstr source against the real relays: the tab lists live files,
 * most seeded first, and a search finds catalogue entries. Needs the dev shell
 * (`npm run shell`, or PORT=5178 node dev/serve-shell.mjs) and network access;
 * `?relays=1` makes the shell answer queries from the real relays.
 *
 *   node dev/napstr-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const QUERY = process.env.NAPSTR_QUERY || 'love';
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/?relays=1`, { waitUntil: 'domcontentloaded' });
  const frame = await (await page.waitForSelector('#frame')).contentFrame();
  await frame.waitForSelector('.deck-A', { timeout: 20000 });

  await frame.locator('.tab', { hasText: 'Napstr' }).click();
  await frame.waitForFunction(
    () => /Napstr/.test(document.querySelector('.browser-h1')?.textContent || '')
      && document.querySelectorAll('.track-row').length > 0,
    null, { timeout: 45000 },
  );
  const live = await frame.evaluate(() => ({
    n: document.querySelectorAll('.track-row').length,
    heading: document.querySelector('.browser-h1').textContent,
    sub: document.querySelector('.browser-h2')?.textContent || '',
    first: document.querySelector('.track-row .row-title')?.textContent || '',
    side: document.querySelector('.browser-side')?.textContent || '',
  }));
  check('live tab lists seeded files', live.n >= 10, `${live.n} rows · ${live.sub}`);
  check('the side panel reports the swarm', /files offered by \d+ seeders/.test(live.side), live.side.slice(0, 80));
  check('rows carry seeder counts', /seeding/.test(await frame.evaluate(() => document.querySelector('.track-row')?.textContent || '')));

  await frame.locator('input[aria-label="Search Napstr"]').fill(QUERY);
  await frame.locator('input[aria-label="Search Napstr"]').press('Enter');
  await frame.waitForFunction(
    (q) => (document.querySelector('.browser-h1')?.textContent || '').includes(q),
    QUERY, { timeout: 30000 },
  );
  await page.waitForTimeout(1500);
  const search = await frame.evaluate(() => ({
    n: document.querySelectorAll('.track-row').length,
    heading: document.querySelector('.browser-h1').textContent,
    sub: document.querySelector('.browser-h2')?.textContent || '',
  }));
  check(`search "${QUERY}" finds catalogue entries`, search.n > 0, `${search.n} rows · ${search.sub}`);

  const getNapstr = frame.locator('button', { hasText: 'Get Napstr' });
  check('the side panel offers Get Napstr', await getNapstr.count() === 1);
} catch (error) {
  check('run completed', false, String(error && error.message || error));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
