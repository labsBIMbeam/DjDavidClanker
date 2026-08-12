/**
 * E2E for the media-server source (Subsonic/Navidrome) and the ingest button.
 *
 * Spawns its own mock server (dev/mock-subsonic.mjs) and its own dev shell
 * with the mock allowlisted, so the suite is fully self-contained and does
 * not disturb a shell already running on :5178.
 *
 *   node dev/sources-check.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 5199;
const SHELL_PORT = 5177;
const BASE = `http://127.0.0.1:${SHELL_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const OUT = process.env.OUT || '/tmp/sources';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const procs = [];
const boot = (script, env) => {
  const p = spawn(process.execPath, [join(here, script)], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  procs.push(p);
  return p;
};
const waitPort = async (url) => {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`server never came up: ${url}`);
};

boot('mock-subsonic.mjs', { MOCK_PORT: String(MOCK_PORT) });
boot('serve-shell.mjs', { PORT: String(SHELL_PORT), EXTRA_PROXY_HOSTS: '127.0.0.1' });
await waitPort(`${MOCK}/rest/ping`);
await waitPort(BASE);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const frame = await (await page.waitForSelector('#frame')).contentFrame();
  await frame.waitForSelector('.deck-A', { timeout: 15000 });

  // Configure the media server exactly as the settings dialog would.
  await frame.evaluate((mock) => {
    const s = window.__djclanker.settings;
    s.subsonicUrl = mock;
    s.subsonicUser = 'dj';
    s.subsonicPass = 'secret';
    s.ingestUrl = mock;
  }, MOCK);

  await frame.locator('.tab', { hasText: 'Server' }).click();
  await frame.waitForFunction(
    () => document.querySelectorAll('.track-row').length >= 3,
    undefined, { timeout: 20000 },
  );
  const rows = await frame.evaluate(() => ({
    n: document.querySelectorAll('.track-row').length,
    heading: document.querySelector('.browser-h1').textContent,
    first: document.querySelector('.track-row .row-title').textContent,
  }));
  check('server tab lists the library (random 30)', rows.n === 3
    && rows.heading === 'Crate server', `${rows.n} rows`);

  // Auth shape: salt+token, never the password.
  const auth = await frame.evaluate(() => {
    const t = window.__djclanker.browser.currentItems()[0];
    const u = new URL(t.streamUrls[0]);
    return {
      hasToken: u.searchParams.has('t') && u.searchParams.has('s'),
      leaksPass: [...u.searchParams.values()].includes('secret'),
      id: t.id,
    };
  });
  check('stream URLs carry salt+token auth, never the password',
    auth.hasToken && !auth.leaksPass && auth.id.startsWith('nd:'));

  // Search narrows.
  await frame.locator('.server-search').fill('Other');
  await frame.locator('.server-search').press('Enter');
  await frame.waitForFunction(
    () => document.querySelectorAll('.track-row').length === 1,
    undefined, { timeout: 15000 },
  );
  check('server search narrows to the match', true);

  // A server track loads onto a deck in FULL mode through the normal path.
  await frame.locator('.track-row').first().locator('.load-a').click();
  await frame.waitForFunction(() => {
    const d = window.__djclanker.decks.A;
    return d.status === 'ready' && d.backend === 'buffer';
  }, undefined, { timeout: 60000 });
  const deck = await frame.evaluate(() => {
    const d = window.__djclanker.decks.A;
    return { title: d.track.title, duration: d.duration, source: d.track.source };
  });
  check('server track decodes in FULL mode', deck.title === 'Other Thing'
    && deck.duration > 3.5 && deck.source === 'subsonic', `${deck.duration.toFixed(1)}s`);

  // Ingest button: a local session file goes to the pipeline endpoint.
  const wav = await fetch(`${MOCK}/rest/stream?id=s1`).then((r) => r.arrayBuffer());
  await frame.locator('input.local-input').setInputFiles({
    name: 'Up Loader - Send Me.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from(wav),
  });
  await page.waitForTimeout(300);
  const ingestBtn = frame.locator('.track-row', { hasText: 'Send Me' }).locator('.btn-ingest');
  check('local session row offers the ⤴ crate button', await ingestBtn.count() === 1);
  await ingestBtn.click();
  await frame.waitForFunction(
    () => document.querySelector('.btn-ingest') && document.querySelector('.btn-ingest').textContent === '✓',
    undefined, { timeout: 15000 },
  );
  const captured = await fetch(`${MOCK}/ingested`).then((r) => r.json());
  check('upload reached the ingest endpoint with the file',
    captured.length === 1 && captured[0].name === 'Up Loader - Send Me.wav'
    && captured[0].bytes > 100000, `${captured[0] && captured[0].bytes} bytes`);

  await page.screenshot({ path: `${OUT}-server.png`, fullPage: true });
} finally {
  await browser.close();
  for (const p of procs) p.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
