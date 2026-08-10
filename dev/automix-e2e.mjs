/**
 * E2E for the automix across MULTIPLE transitions.
 *
 * The smoke suite drives exactly one handover, which is why a whole class of
 * bugs hid behind it: everything that only goes wrong once a deck has been
 * live and handed over. This suite plays three tracks in a row and insists
 * that each one is new.
 *
 *   node dev/serve-shell.mjs   (running)   →   node dev/automix-e2e.mjs
 *
 * Browser-driven counterpart to dev/automix-check.mjs, which covers the same
 * handover logic headlessly against the Automix internals.
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const OUT = process.env.OUT || '/tmp/automix';

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
await frame.waitForSelector('.track-row', { timeout: 30000 });

// Chart list as the queue, decks cleared: a genuine cold start.
await frame.locator('.tab').first().click();
await frame.locator('.automix .btn-mini').filter({ hasText: 'List' }).click();
const queued = await frame.evaluate(() => window.__djclanker.automix.queue.length);
check('queue filled from the browser', queued > 5, `${queued} tracks`);

await frame.evaluate(() => {
  const m = window.__djclanker.mixer;
  m.decks.A.pause();
  m.decks.B.pause();
});
await frame.locator('.btn-automix').click();

await frame.waitForFunction(() => {
  const am = window.__djclanker.automix;
  return Boolean(am.liveId && am.liveDeck && am.liveDeck.playing);
}, undefined, { timeout: 180000 });

const first = await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  return { id: am.liveId, trackId: am.liveDeck.track.id, title: am.liveDeck.track.title };
});
check('cold start went live', Boolean(first.trackId), `deck ${first.id}: ${first.title}`);

const played = [first.trackId];
const titles = [first.title];

/** Run one transition and return what went live, or null on timeout. */
async function transition(n) {
  // Open the preload window so staging starts now instead of 35 s from the end.
  await frame.evaluate(() => { window.__djclanker.automix.preloadLead = 99999; });

  // The real assertion: the idle deck must end up holding a track we have not
  // played yet. With the ping-pong bug it keeps the previous one forever.
  const staged = await frame
    .waitForFunction((seen) => {
      const am = window.__djclanker.automix;
      const idle = am.idleDeck;
      return Boolean(idle && idle.status === 'ready' && idle.track && !am.busy
        && !seen.includes(idle.track.id));
    }, played, { timeout: 120000 })
    .then(() => frame.evaluate(() => {
      const t = window.__djclanker.automix.idleDeck.track;
      return { trackId: t.id, title: t.title };
    }))
    .catch(() => null);

  if (!staged) return null;

  // Drop the playhead into the outro so the transition fires now.
  const prevId = await frame.evaluate(() => {
    const am = window.__djclanker.automix;
    am.fadeSeconds = 3;
    am.preloadLead = 18;
    am.liveDeck.seek(am.liveDeck.duration - 2.6);
    return am.liveId;
  });

  await frame.waitForFunction((prev) => {
    const am = window.__djclanker.automix;
    return !am.fade && am.liveId && am.liveId !== prev;
  }, prevId, { timeout: 60000 }).catch(() => {});

  return frame.evaluate(() => {
    const am = window.__djclanker.automix;
    return { id: am.liveId, trackId: am.liveDeck.track.id, title: am.liveDeck.track.title };
  });
}

for (let n = 1; n <= 2; n++) {
  const got = await transition(n);
  const fresh = got && !played.includes(got.trackId);
  check(`transition ${n} staged and played a new track`, Boolean(fresh),
    got ? `deck ${got.id}: ${got.title}` : 'no unplayed track ever reached the idle deck');
  if (!got) break;
  played.push(got.trackId);
  titles.push(got.title);
}

check('three distinct tracks played in a row', new Set(played).size === 3,
  titles.join(' → '));

await frame.evaluate(() => {
  const am = window.__djclanker.automix;
  if (am.enabled) am.toggle();
  am.mixer.decks.A.pause();
  am.mixer.decks.B.pause();
});

await page.screenshot({ path: `${OUT}-automix.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
