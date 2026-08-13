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
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    // Fake media input: Chromium synthesizes a tone, so LINE IN is audible
    // and assertable without hardware; fake UI auto-grants the permission.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  // devices mode: getUserMedia needs a real origin (see HANDOFF on the
  // sandbox); every other code path under test is identical either way.
  await page.goto(`${BASE}/?devices=1`, { waitUntil: 'domcontentloaded' });
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

  /* ------------------------ discover (gates 4+5) ------------------------ */
  // Audius and Archive.org run against the REAL APIs, same policy as the
  // Wavlake suites; Jamendo needs a client_id, so only its hint is asserted.

  await frame.locator('.tab', { hasText: 'Discover' }).click();
  const groups = await frame.evaluate(() => ({
    headers: [...document.querySelectorAll('.side-group .side-h')].map((e) => e.textContent),
    jamendoHint: Boolean(document.querySelector('.jamendo-hint')),
  }));
  check('discover tab shows Audius, Jamendo and Archive groups',
    ['Audius', 'Jamendo (CC)', 'Archive.org'].every((x) => groups.headers.includes(x))
    && groups.jamendoHint, groups.headers.join(' | '));

  await frame.locator('.side-group .chip', { hasText: 'Trending' }).click();
  await frame.waitForFunction(
    () => document.querySelectorAll('.track-row').length >= 5,
    undefined, { timeout: 60000 },
  );
  const au = await frame.evaluate(() => {
    const t = window.__djclanker.browser.currentItems()[0];
    return {
      id: t.id, source: t.source,
      streamOk: t.streamUrls[0].includes('/stream'),
      hasPromote: Boolean(document.querySelector('.track-row .btn-ingest')),
    };
  });
  check('audius trending lists real tracks with promote buttons',
    au.id.startsWith('au:') && au.source === 'audius' && au.streamOk && au.hasPromote,
    au.id);

  await frame.locator('.track-row .btn-ingest').first().click();
  await frame.waitForFunction(() => {
    const b = document.querySelector('.track-row .btn-ingest');
    return b && (b.textContent === '✓' || b.textContent === '✗');
  }, undefined, { timeout: 15000 });
  const promoted = await fetch(`${MOCK}/ingested`).then((r) => r.json());
  const urlEntries = promoted.filter((e) => e.url);
  check('promote posts url + metadata to the ingest service',
    urlEntries.length === 1 && urlEntries[0].url.includes('/stream')
    && Boolean(urlEntries[0].title), urlEntries[0] && urlEntries[0].title);

  await frame.locator('.archive-search').fill('netlabel');
  await frame.locator('.side-group .btn-primary').nth(2).click();
  await frame.waitForFunction(
    () => [...document.querySelectorAll('.side-group .chip')].some((c) => c.textContent.startsWith('💿')),
    undefined, { timeout: 60000 },
  );
  await frame.locator('.side-group .chip', { hasText: '💿' }).first().click();
  await frame.waitForFunction(
    () => document.querySelectorAll('.track-row').length >= 1
      && window.__djclanker.browser.currentItems()[0]
      && window.__djclanker.browser.currentItems()[0].source === 'archive',
    undefined, { timeout: 60000 },
  );
  const ia = await frame.evaluate(() => {
    const t = window.__djclanker.browser.currentItems()[0];
    return { id: t.id, stream: t.streamUrls[0] };
  });
  check('archive item resolves to playable file tracks',
    ia.id.startsWith('ia:') && ia.stream.startsWith('https://archive.org/download/'),
    ia.id.slice(0, 40));

  // Auto-promote: loading an archive find onto a deck sends it to the crate.
  await frame.locator('.track-row').first().locator('.load-b').click();
  await frame.waitForFunction(async () => true, undefined, { timeout: 1000 }).catch(() => {});
  const afterAuto = await fetch(`${MOCK}/ingested`).then((r) => r.json());
  const autoEntries = afterAuto.filter((e) => e.url && e.url.startsWith('https://archive.org/'));
  check('auto-promote fires when an archive find hits a deck',
    autoEntries.length === 1, `${autoEntries.length} archive promote(s)`);
  await frame.evaluate(() => {
    window.__djclanker.decks.B.stop();
  });

  /* ------------------------------ line in ------------------------------ */

  await frame.evaluate(() => {
    window.__djclanker.decks.A.pause();
    window.__djclanker.decks.B.stop();
  });
  await frame.locator('.btn-line').click();
  await frame.waitForFunction(() => window.__djclanker.mixer.lineIn.on,
    undefined, { timeout: 15000 });
  const lineLevel = await frame.evaluate(async () => {
    const mx = window.__djclanker.mixer;
    let peak = 0;
    for (let i = 0; i < 25; i++) {
      peak = Math.max(peak, mx.masterLevel());
      await new Promise((r) => setTimeout(r, 25));
    }
    return peak;
  });
  check('LINE IN: fake input is audible on the master with both decks silent',
    lineLevel > 0.01, `peak=${lineLevel.toFixed(3)}`);

  await frame.locator('.btn-line-low').click();
  const low = await frame.evaluate(() => ({
    setting: window.__djclanker.mixer.lineIn.low,
    param: window.__djclanker.mixer._line.low.gain.value,
  }));
  check('LINE IN: bass kill drops the shelf to −26 dB', low.setting === -26 && low.param === -26);

  await frame.locator('.btn-line').click();
  const lineOff = await frame.evaluate(async () => {
    const mx = window.__djclanker.mixer;
    await new Promise((r) => setTimeout(r, 300));
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      peak = Math.max(peak, mx.masterLevel());
      await new Promise((r) => setTimeout(r, 25));
    }
    return { on: mx.lineIn.on, peak };
  });
  check('LINE IN: disable stops the stream and the master goes quiet',
    lineOff.on === false && lineOff.peak < 0.005, `peak=${lineOff.peak.toFixed(4)}`);

  /* ------------------------------- midi ------------------------------- */
  // No hardware in CI: the exposed handle() drives the MPD218 factory map
  // with raw messages, which is exactly what an input port would deliver.

  const midi = await frame.evaluate(async () => {
    const dj = window.__djclanker;
    const before = {
      playing: dj.decks.A.playing,
      fxOn: dj.decks.A.fx[dj.decks.A.fxSlots[0]] ? dj.decks.A.fx[dj.decks.A.fxSlots[0]].on : false,
      automix: dj.automix.enabled,
    };
    dj.midi.handle([0x90, 36, 100]); // pad 1: deck A play toggle
    const played = dj.decks.A.playing !== before.playing;
    dj.midi.handle([0x90, 36, 100]); // toggle back
    dj.midi.handle([0xb0, 3, 127]); // K1 full right → crossfader +1
    const xfRight = dj.mixer.crossfader;
    dj.midi.handle([0xb0, 3, 64]); // detent-ish middle
    dj.midi.handle([0xb0, 9, 127]); // K2 → master 1
    const master = dj.mixer.master;
    dj.midi.handle([0x90, 45, 100]); // pad 10 down: A FX slot 1 punch in
    const fxDown = dj.decks.A.fx[dj.decks.A.fxSlots[0]].on;
    dj.midi.handle([0x80, 45, 0]); // pad 10 up: punch out
    const fxUp = dj.decks.A.fx[dj.decks.A.fxSlots[0]].on;
    dj.midi.handle([0xb0, 9, 108]); // master back to a sane level
    return { played, xfRight, master, fxDown, fxUp };
  });
  check('MIDI: pad 1 toggles deck A transport', midi.played === true);
  check('MIDI: K1/K2 drive crossfader and master', midi.xfRight === 1 && midi.master === 1,
    `xf=${midi.xfRight} master=${midi.master}`);
  check('MIDI: FX pad is momentary (hold to ride)', midi.fxDown === true && midi.fxUp === false);

  await page.screenshot({ path: `${OUT}-server.png`, fullPage: true });
} finally {
  await browser.close();
  for (const p of procs) p.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
