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

// SET & CRATE: the crate side carries the playlist menu; "Show playlist"
// opens it as the list.
await frame.locator('.mode-setlist').click();
await frame.locator('.side-group .btn-ghost', { hasText: 'Show playlist' }).click();
await frame.locator('.browser-h1', { hasText: 'Playlist' }).waitFor({ timeout: 10000 });
const menuChips = await frame.locator('.side-group .chip', { hasText: '♪' }).count();
const plRows = await frame.locator('.track-row').count();
check('playlist menu lists all tracks', menuChips === 10, `${menuChips} chips`);
check('playlist view shows all tracks', plRows === 10, `${plRows} rows`);

// Search another track and add it via the row "+" button. The source tabs
// are tucked away in SET & CRATE mode — surface them first.
await frame.locator('.mode-btn', { hasText: 'SOURCES' }).click();
await frame.locator('.tab', { hasText: 'Search' }).click();
await frame.locator('.search-input').first().fill('bitcoin');
await frame.locator('.side-group .btn-primary').click();
await frame.locator('.browser-h1', { hasText: 'Search: bitcoin' }).waitFor({ timeout: 25000 });
const searchRows = await frame.locator('.track-row').count();
check('search found other tracks', searchRows > 0, `${searchRows} rows`);
const addedTitle = (await frame.locator('.track-row .row-title').first().textContent()).trim();
await frame.locator('.track-row').first().locator('.btn-addpl').click();
await page.waitForTimeout(400);

// Back to the crate: 11 entries now, and the new one loads onto deck A.
await frame.locator('.mode-setlist').click();
await frame.locator('.side-group .btn-ghost', { hasText: 'Show playlist' }).click();
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

/* --------------- setlist: the crate with performance marks --------------- */

// Star the loaded deck-A track with marks set, write back another hot cue,
// reload it via a detour and the marks must come home. All engine truth.
const set = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  const A = dj.decks.A;
  const id = A.track.id;
  // Hot cue FIRST, main cue LAST — storing a hot cue also arms the main cue
  // (booth-round semantics), so the order decides which cue survives.
  A.seek(4); A.hotCue(1);
  A.seek(2); A.cue(); // cue point at 2 s (deck is paused after load)
  // Find the loaded track's row by its DECK A marker — indexes shifted
  // after the removal check above, and the marker pass runs at 2 Hz, so
  // poll briefly for it after the fresh render.
  let row = null;
  for (let i = 0; i < 20 && !row; i++) {
    row = [...document.querySelectorAll('.track-row')]
      .find((r) => (r.querySelector('.row-marker') || {}).textContent === 'DECK A');
    if (!row) await new Promise((r2) => setTimeout(r2, 250));
  }
  row.querySelector('.row-star').click();
  const stored = dj.setlist.cuesFor(id);
  A.seek(6); A.hotCue(2); // write-back AFTER starring
  await new Promise((r) => setTimeout(r, 100));
  const written = dj.setlist.cuesFor(id);
  return { added: dj.setlist.has(id), stored, written, id };
});
check('setlist: ☆ takes the deck marks along',
  set.added && set.stored && set.stored.cue === 2 && set.stored.hot[1] === 4,
  JSON.stringify(set.stored));
check('setlist: later marks write back live',
  set.written && set.written.hot[2] === 6, JSON.stringify(set.written));

// Detour over another track, then reload — marks restore onto the deck.
await frame.locator('.track-row').nth(0).locator('.load-a').click();
await frame.waitForFunction((id) => {
  const A = window.__djclanker.decks.A;
  return A.status === 'ready' && A.track.id !== id;
}, set.id, { timeout: 120000 });
await frame.locator('.track-row', { hasText: addedTitle }).first().locator('.load-a').click();
await frame.waitForFunction((id) => {
  const A = window.__djclanker.decks.A;
  return A.status === 'ready' && A.track.id === id;
}, set.id, { timeout: 120000 });
const restored = await frame.evaluate(() => {
  const A = window.__djclanker.decks.A;
  return { cue: A.cuePoint, hot: A.hotCues };
});
// The hot cue stored at 6 s after starring ALSO re-armed the main cue — the
// restored record must carry cue=6, not the older 2 s mark.
check('setlist: loading a listed track restores its marks',
  restored.cue === 6 && restored.hot[1] === 4 && restored.hot[2] === 6,
  JSON.stringify(restored));

// The setlist view: badge, running-order controls, sources hidden below.
await frame.locator('.mode-setlist').click();
await page.waitForTimeout(300);
const view = await frame.evaluate(() => ({
  rows: document.querySelectorAll('.track-row').length,
  badge: (document.querySelector('.cue-badge') || {}).textContent || '',
  tabsHidden: getComputedStyle(document.querySelector('.browser-tabs')).display === 'none',
}));
check('setlist view: marks badge + sources tucked away',
  view.rows === 1 && view.badge.includes('hot') && view.tabsHidden,
  JSON.stringify(view));

// ⤓ save must produce a real download (needs allow-downloads on the frame).
const dlPromise = page.waitForEvent('download', { timeout: 10000 });
await frame.locator('.btn-saveset').click();
const dl = await dlPromise;
check('setlist ⤓ save downloads setlist.json', dl.suggestedFilename() === 'setlist.json',
  dl.suggestedFilename());

/* --------------------------- queue interface --------------------------- */

// The rail must tell the truth about the WHOLE queue: real count in the
// header, a full expandable view, drop + promote as pure array surgery,
// and a materialized front under shuffle so the display IS the plan.
const q1 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const mk = (i) => ({ id: 'qi-' + i, title: 'QI ' + i, artist: 'Suite', duration: 200, streamUrls: [], source: 'server' });
  dj.automix.order = 'list';
  dj.automix.setQueue([1, 2, 3, 4, 5, 6, 7, 8].map(mk));
  dj.automix.tick(0.016);
  dj.browser.tick();
  const head = document.querySelector('.upnext-head');
  return { header: head ? head.textContent : '' };
});
check('queue rail shows the real count', q1.header.includes('8 in queue'), q1.header.trim());

const q2 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  document.querySelector('.upnext-toggle').click();
  dj.browser.tick();
  const rows = document.querySelectorAll('.qfull-row').length;
  document.querySelectorAll('.qfull-row')[1].querySelector('.btn-qdrop').click();
  dj.browser.tick();
  return {
    rows,
    afterDrop: document.querySelectorAll('.qfull-row').length,
    gone: !dj.automix.queue.some((t) => t.id === 'qi-2'),
    playingUntouched: !dj.decks.A.playing || dj.decks.A.playing, // never throws — audio state read only
  };
});
check('full queue view opens and drops entries silently', q2.rows === 8 && q2.afterDrop === 7 && q2.gone,
  `rows ${q2.rows} → ${q2.afterDrop}`);

const q3 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const rows = [...document.querySelectorAll('.qfull-row')];
  const title = rows[3].querySelector('.qfull-title').textContent;
  rows[3].querySelector('button[title="Play next"]').click();
  dj.browser.tick();
  return { title, first: dj.automix.queue[dj.automix.cursor].title };
});
check('promote pins a track right behind the playhead', q3.first === q3.title, `${q3.title} → Q1`);

const q4 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  dj.automix.order = 'shuffle';
  dj.automix.tick(0.016);
  const f1 = dj.automix.queue.slice(dj.automix.cursor, dj.automix.cursor + 3).map((t) => t.id);
  dj.automix.tick(0.016);
  dj.automix.tick(0.016);
  const f2 = dj.automix.queue.slice(dj.automix.cursor, dj.automix.cursor + 3).map((t) => t.id);
  const took = dj.automix._takeNext();
  return { stable: f1.join() === f2.join(), consumedHead: took && took.id === f1[0] };
});
check('shuffle front is materialized: display IS the plan', q4.stable && q4.consumedHead,
  `stable=${q4.stable} head-consumed=${q4.consumedHead}`);

const q5 = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  for (let i = 0; i < 30 && !document.querySelector('.suggest-card'); i++) {
    dj.browser.tick();
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    cards: document.querySelectorAll('.suggest-card').length,
    rowBtns: document.querySelectorAll('.btn-qnext').length,
  };
});
check('wavlake picks suggest chart tracks beside the queue', q5.cards === 3 && q5.rowBtns > 0,
  `cards=${q5.cards} row-promotes=${q5.rowBtns}`);

/* ----------------------------- queue desk ----------------------------- */

// One tab that is queue AND playlist: the running queue pinned on top, any
// source list below, + / 1 2 3 on every row, the order mode in the header.
const d1 = await frame.evaluate(async () => {
  const dj = window.__djclanker;
  const mk = (i) => ({ id: 'qd-' + i, title: 'QD ' + i, artist: 'Desk', duration: 200, streamUrls: [], source: 'server' });
  dj.automix.order = 'list';
  dj.automix.setQueue([1, 2, 3, 4].map(mk));
  document.querySelector('.mode-queue').click();
  // Real user flow: pick a source below the pinned queue. Re-click the
  // Charts tab while polling — if a stray epoch bump ate a response, the
  // next click fires a fresh fetch with the newest epoch.
  for (let i = 0; i < 40 && document.querySelectorAll('.track-row .qslot-group').length < 2; i++) {
    if (i % 8 === 0) document.querySelector('.tab').click();
    dj.automix.tick(0.016);
    dj.browser.tick();
    await new Promise((r) => setTimeout(r, 300));
  }
  const head = document.querySelector('.desk-head');
  return {
    head: head ? head.textContent : '',
    deskRows: document.querySelectorAll('.queue-desk .qfull-row').length,
    slotRows: document.querySelectorAll('.track-row .qslot-group').length,
    tabsVisible: getComputedStyle(document.querySelector('.browser-tabs')).display !== 'none',
    heading: (document.querySelector('.browser-h1') || {}).textContent || '',
  };
});
check('queue desk pins the whole queue above the sources',
  d1.head.includes('4 tracks') && d1.deskRows === 4 && d1.slotRows >= 2 && d1.tabsVisible,
  `rows=${d1.deskRows} slotRows=${d1.slotRows} list="${d1.heading}"`);

const d2 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const kick = () => { dj.automix.tick(0.016); dj.browser.tick(); };
  const rows = [...document.querySelectorAll('.track-row .qslot-group')];
  const before = dj.automix.queue.length;
  rows[0].querySelector('button').click(); kick();
  const afterAppend = dj.automix.queue.length;
  const appendedId = dj.automix.queue[dj.automix.queue.length - 1].id;
  rows[0].querySelector('button').click(); kick();
  const afterDupe = dj.automix.queue.length;
  const btn2 = [...rows[1].querySelectorAll('button')].find((b) => b.textContent === '2');
  btn2.click(); kick();
  return {
    appended: afterAppend === before + 1,
    deduped: afterDupe === afterAppend,
    appendedAtEnd: appendedId !== 'qd-4' ? 'chart' : 'FAIL',
    slot2: dj.automix.queue[dj.automix.cursor + 1].id !== 'qd-2',
    deskRow2: [...document.querySelectorAll('.queue-desk .qfull-title')][1].textContent,
  };
});
check('desk rows append with + (deduped) and push into slot 2',
  d2.appended && d2.deduped && d2.slot2, `slot2 now "${d2.deskRow2}"`);

const d3 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const kick = () => { dj.automix.tick(0.016); dj.browser.tick(); };
  const ob = document.querySelector('.btn-qorder');
  const start = ob.textContent;
  ob.click(); kick();
  const after = { label: document.querySelector('.btn-qorder').textContent, engine: dj.automix.order };
  const f1 = dj.automix.queue.slice(dj.automix.cursor, dj.automix.cursor + 3).map((t) => t.id);
  kick(); kick();
  const f2 = dj.automix.queue.slice(dj.automix.cursor, dj.automix.cursor + 3).map((t) => t.id);
  return { start, after, stable: f1.join() === f2.join() };
});
check('desk order button cycles LIST → SHUF with a stable materialized front',
  d3.start === 'LIST' && d3.after.label === 'SHUF' && d3.after.engine === 'shuffle' && d3.stable,
  `${d3.start} → ${d3.after.label}`);

const d4 = await frame.evaluate(() => {
  const dj = window.__djclanker;
  const before = dj.automix.queue.length;
  document.querySelector('.btn-addall-q').click();
  dj.automix.tick(0.016); dj.browser.tick();
  const items = dj.browser.currentItems();
  const queuedIds = new Set(dj.automix.queue.map((t) => t.id));
  return {
    added: dj.automix.queue.length - before,
    listLen: items.length,
    allIn: items.every((t) => queuedIds.has(t.id)),
  };
});
check('+ ALL FROM LIST appends only the missing tracks', d4.added > 0 && d4.added < d4.listLen && d4.allIn,
  `${d4.added} of ${d4.listLen} added, rest were queued already`);

await page.screenshot({ path: `${OUT}-crate.png`, fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
