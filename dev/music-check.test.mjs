import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Automix } from '../src/audio/automix.js';

globalThis.window = undefined;

test('music/open appends a portable selection without replacing or starting the set', async () => {
  const { receiveMusicOpen } = await import('../src/lib/music.js');
  const queued = [{ id: 'existing' }];
  const queue = { append(track) { queued.push(track); return true; } };
  const payload = { version: 1, tracks: [
    { url: 'https://music.example/loop.wav', title: 'Loop', artist: 'Synth' },
  ] };
  const frozen = JSON.stringify(payload);
  assert.equal(receiveMusicOpen(payload, queue), 1);
  assert.equal(queued[0].id, 'existing');
  assert.deepEqual(queued[1].streamUrls, ['https://music.example/loop.wav']);
  assert.equal(queued[1].title, 'Loop');
  assert.equal(JSON.stringify(payload), frozen);
  assert.equal(receiveMusicOpen(undefined, queue), 0);
});

test('INC delivery uses the exact music topic, validates input, dedupes and closes', async (t) => {
  const { installMusicReceiver, MUSIC_OPEN } = await import('../src/lib/music.js');
  const queue = new Automix({ decks: {} });
  const errors = [];
  const accepted = [];
  let receive;
  let closed = false;
  t.mock.property(globalThis, 'window', { napplet: { inc: {
    on(topic, fn) { assert.equal(topic, MUSIC_OPEN); receive = fn;
      return { close() { closed = true; } }; },
  } } });
  const sub = installMusicReceiver(queue, {
    onAccepted: (count) => accepted.push(count), onError: (err) => errors.push(err.message),
  });
  const payload = { version: 1, tracks: [{ url: 'https://music.example/a', title: 'A' }] };
  receive({ topic: MUSIC_OPEN + '?x=1', sender: 'producer', payload });
  assert.equal(queue.queue.length, 0);
  receive({ topic: MUSIC_OPEN, sender: 'producer', payload });
  receive({ topic: MUSIC_OPEN, sender: 'producer', payload });
  receive({ topic: MUSIC_OPEN, sender: 'producer', payload: { version: 9 } });
  assert.equal(queue.queue.length, 1);
  assert.equal(queue.enabled, false);
  assert.deepEqual(accepted, [1, 0]);
  assert.equal(errors.length, 1);
  sub.close();
  assert.equal(closed, true);
  window.napplet = {};
  assert.equal(installMusicReceiver(queue), null);
});

test('invalid music input rejects the entire batch before queue mutation', async () => {
  const { receiveMusicOpen } = await import('../src/lib/music.js');
  const track = { url: 'https://music.example/loop.wav', title: 'Loop' };
  const invalid = [null, [], new Date(), new Map(), { version: 2, tracks: [track] },
    { version: 1, tracks: [track], autoplay: true },
    { version: 1, tracks: [track, { ...track, url: 'javascript:alert(1)' }] },
    { version: 1, tracks: [{ ...track, url: 'https://user:secret@music.example/a' }] },
    { version: 1, tracks: [{ ...track, url: 'http://music.example/a' }] },
    { version: 1, tracks: [{ ...track, url: 'https://music.example/a#' }] },
    { version: 1, tracks: [track, , track] },
    { version: 1, tracks: [{ ...track, title: '<b>'.repeat(100) }] },
    { version: 1, tracks: [{ ...track, artwork: 'file:///private' }] },
    { version: 1, tracks: [{ ...track, localFile: {} }] },
    { version: 1, tracks: Array(101).fill(track) },
  ];
  for (const payload of invalid) {
    const queue = [];
    assert.throws(() => receiveMusicOpen(payload, { append: (t) => queue.push(t) }));
    assert.equal(queue.length, 0);
  }
  assert.equal(receiveMusicOpen({}, {}), 0);
});
