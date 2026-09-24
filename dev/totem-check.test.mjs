import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Automix } from '../src/audio/automix.js';

const source = await readFile(new URL('../src/totem/main.js', import.meta.url), 'utf8');

// Run the UI handlers verbatim, without booting a canvas or an AudioContext.
function handler(name, nextName) {
  return source.slice(source.indexOf(`async function ${name}(`),
    source.indexOf(`\n${nextName}`));
}

function transportFixture() {
  const deck = (id) => ({
    id, status: 'ready', track: { id: `track-${id}` }, playing: false,
    position: 20, duration: 180, nominalRate: 1,
    pause() { this.playing = false; },
    play() { this.playing = true; },
  });
  const mixer = {
    decks: { A: deck('A'), B: deck('B') }, crossfader: -1,
    resumeAudio() {},
    setCrossfader(value) { this.crossfader = value; },
  };
  const automix = new Automix(mixer);
  automix.setQueue([{ id: 'next' }]);
  let chartLoads = 0;
  const toggle = new Function('mixer', 'automix', 'paint', 'btnStart', 'loadCharts',
    `${handler('startStop', 'async function loadCharts(')}; return startStop;`)(
    mixer, automix, () => {}, {}, async () => {
      chartLoads++;
      automix.setQueue([{ id: 'chart-track' }]);
    });
  return { mixer, automix, toggle, chartLoads: () => chartLoads };
}

function coverFixture({ decode = async () => {} } = {}) {
  const released = [];
  class TestImage {
    set src(value) { this.url = String(value); }
    get src() { return this.url; }
    async decode() { await decode(this); }
  }
  const fetchObjectUrl = async (url) => ({
    url: `blob:${url}`, size: 123, revoke: () => released.push(url),
  });
  const cover = new Function('fetchObjectUrl', 'Image', `
    let coverImg = null;
    let coverFor = '';
    ${handler('ensureCover', 'function drawDisc(')}
    return { load: ensureCover, image: () => coverImg };
  `)(fetchObjectUrl, TestImage);
  return { ...cover, released };
}

test('Totem STOP pauses both decks during a crossfade', async () => {
  const { mixer, automix, toggle } = transportFixture();
  mixer.decks.A.playing = true;
  automix.start();
  mixer.decks.B.playing = true;
  automix.fade = { from: -1, to: 1, t: 1, dur: 4 };
  await toggle();
  assert.equal(automix.enabled, false);
  assert.equal(automix.fade, null);
  assert.equal(mixer.decks.A.playing, false, 'the outgoing deck must stop');
  assert.equal(mixer.decks.B.playing, false, 'the incoming deck must stop');
});

test('Totem START resumes the stopped live deck at its existing position', async () => {
  const { mixer, automix, toggle } = transportFixture();
  mixer.decks.A.playing = true;
  automix.start();
  await toggle();
  await toggle();
  assert.equal(automix.enabled, true);
  assert.equal(mixer.decks.A.playing, true, 'START must resume the stopped audio');
  assert.equal(mixer.decks.A.position, 20);
  assert.equal(mixer.decks.B.playing, false);
});

test('resuming a loaded track does not depend on fetching charts', async () => {
  const { mixer, automix, toggle, chartLoads } = transportFixture();
  mixer.decks.A.playing = true;
  automix.start();
  await toggle();
  automix.setQueue([]);
  await toggle();
  assert.equal(chartLoads(), 0, 'a stopped track must resume even when offline');
  assert.equal(mixer.decks.A.playing, true);
});

test('cover decoding receives the blob URL from the bridge result', async () => {
  const cover = coverFixture();
  await cover.load({ artworkUrl: 'album-cover' });
  assert.equal(cover.image().src, 'blob:album-cover');
});

test('cover URLs are released after successful, failed, and superseded decoding', async (t) => {
  await t.test('successful decode', async () => {
    const cover = coverFixture();
    await cover.load({ artworkUrl: 'success' });
    assert.deepEqual(cover.released, ['success']);
  });
  await t.test('failed decode', async () => {
    const cover = coverFixture({ decode: async () => { throw new Error('bad artwork'); } });
    await cover.load({ artworkUrl: 'failure' });
    assert.equal(cover.image(), null);
    assert.deepEqual(cover.released, ['failure']);
  });
  await t.test('superseded decode', async () => {
    let finishOld;
    const oldDecode = new Promise((resolve) => { finishOld = resolve; });
    const cover = coverFixture({
      decode: async (img) => { if (img.src === 'blob:old') await oldDecode; },
    });
    const old = cover.load({ artworkUrl: 'old' });
    await cover.load({ artworkUrl: 'new' });
    assert.equal(cover.image().src, 'blob:new');
    finishOld();
    await old;
    assert.equal(cover.image().src, 'blob:new', 'late decoding must not replace the current cover');
    assert.deepEqual(cover.released, ['new', 'old']);
  });
});

test('a track without artwork invalidates an earlier pending cover', async () => {
  let finishDecode;
  const decoding = new Promise((resolve) => { finishDecode = resolve; });
  const cover = coverFixture({ decode: async () => decoding });
  const pending = cover.load({ artworkUrl: 'old' });
  await cover.load({ title: 'No cover' });
  finishDecode();
  await pending;
  assert.equal(cover.image(), null, 'the old cover must not be used for a different track');
  assert.deepEqual(cover.released, ['old']);
});
