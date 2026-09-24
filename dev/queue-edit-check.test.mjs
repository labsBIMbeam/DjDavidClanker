import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Automix } from '../src/audio/automix.js';

const track = (id) => ({ id, title: id, artist: 'Queue test', duration: 100 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

/** A deterministic audio boundary; selection and handovers use the real Automix. */
function fixture(order = 'list') {
  const makeDeck = (id) => ({
    id, track: null, status: 'empty', playing: false, position: 0, duration: 100,
    nominalRate: 1, bpm: 0, tempo: 0, loadCalls: [], playCalls: [],
    async load(value) {
      this.loadCalls.push(value.id);
      this.track = value;
      this.status = 'ready';
      this.position = 0;
      this.playing = false;
    },
    play() { this.playCalls.push(this.track.id); this.playing = true; },
    pause() { this.playing = false; },
  });
  const decks = { A: makeDeck('A'), B: makeDeck('B') };
  const mixer = { decks, crossfader: -1, setCrossfader(v) { this.crossfader = v; } };
  decks.A.track = track('live');
  decks.A.status = 'ready';
  decks.A.playing = true;
  decks.A.position = 60;
  const automix = new Automix(mixer);
  automix.order = order;
  automix.phraseAlign = false;
  automix.setQueue(['staged', 'later', 'promoted'].map(track));
  automix.start();
  return { automix, decks };
}

/** Complete one real fade without timers or a browser audio device. */
function handover(automix) {
  assert.equal(automix.skip(), true, 'the requested next track is ready');
  automix.tick(6);
  return automix.liveDeck.track.id;
}

test('promotion after preload plays the promoted track next and preserves the old pick', async () => {
  const { automix, decks } = fixture();
  automix.tick(0);
  await flush();
  assert.equal(decks.B.track.id, 'staged');
  assert.equal(automix.promote(track('promoted')), true);
  automix.tick(0);
  await flush();
  assert.equal(handover(automix), 'promoted');
  assert.deepEqual(automix.queue.slice(automix.cursor).map((t) => t.id), ['staged', 'later']);
  assert.deepEqual(decks.A.loadCalls, [], 'promotion must never reload the live deck');
});

for (const [name, edit, next, remaining] of [
  ['insert at slot one', (am) => am.insertAt(track('inserted'), 1), 'inserted',
    ['staged', 'later', 'promoted']],
  ['move staged pick to slot three', (am) => am.insertAt(track('staged'), 3), 'later',
    ['promoted', 'staged']],
  ['remove staged pick', (am) => am.removeFromQueue('staged'), 'later', ['promoted']],
  ['replace queue', (am) => am.setQueue([track('replacement')]), 'replacement', []],
]) {
  test(`${name} changes the next audible handover`, async () => {
    const { automix } = fixture();
    automix.tick(0);
    await flush();
    edit(automix);
    automix.tick(0);
    await flush();
    assert.equal(handover(automix), next);
    assert.deepEqual(automix.queue.slice(automix.cursor).map((t) => t.id), remaining);
  });
}

test('removing the only staged pick prevents skip and end-of-track playback of it', async () => {
  const { automix, decks } = fixture();
  automix.setQueue([track('removed')]);
  automix.tick(0);
  await flush();
  assert.equal(automix.removeFromQueue('removed'), true);
  assert.equal(automix.skip(), false);
  decks.A.playing = false;
  decks.A.position = 100;
  automix.tick(0);
  assert.deepEqual(decks.B.playCalls, []);
});

for (const order of ['list', 'shuffle', 'smart']) {
  test(`a promoted pick stays first in ${order} mode after preloading`, async (t) => {
    t.mock.method(Math, 'random', () => 0.99);
    const { automix } = fixture(order);
    automix.tick(0);
    await flush();
    const before = automix.queue.slice(automix.cursor).map((x) => x.id);
    automix.promote(track('requested'));
    automix.tick(0);
    await flush();
    assert.equal(automix.queue[automix.cursor].id, 'requested', 'the rail shows the staged pick');
    assert.equal(handover(automix), 'requested');
    assert.deepEqual(automix.queue.slice(automix.cursor).map((x) => x.id), before);
  });
}

test('changing order after staging keeps the visible next pick and audio aligned', async (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const { automix } = fixture();
  automix.tick(0);
  await flush();
  automix.order = 'shuffle';
  automix.tick(0);
  await flush();
  const promised = automix.queue[automix.cursor].id;
  assert.equal(handover(automix), promised);
});

/** Deferred Deck.load follows the production deck's superseding-load token semantics. */
function deferLoads(deck) {
  const requests = [];
  let token = 0;
  deck.load = (value) => {
    const mine = ++token;
    deck.loadCalls.push(value.id);
    deck.track = value;
    deck.status = 'loading';
    deck.playing = false;
    return new Promise((resolve, reject) => {
      requests.push({
        ready() { if (mine === token) deck.status = 'ready'; resolve(); },
        fail() { if (mine === token) deck.status = 'error'; reject(new Error('load failed')); },
      });
    });
  };
  return requests;
}

for (const oldFirst of [true, false]) {
  test(`promotion supersedes a loading pick when the old request finishes ${oldFirst ? 'first' : 'last'}`,
    async () => {
      const { automix, decks } = fixture();
      const requests = deferLoads(decks.B);
      automix.tick(0);
      automix.promote(track('requested'));
      assert.equal(requests.length, 2);
      if (oldFirst) {
        requests[0].ready();
        await flush();
        assert.equal(automix.busy, true, 'old completion must not clear the new loading state');
        assert.equal(automix.skip(), false);
      }
      requests[1].ready();
      await flush();
      assert.equal(handover(automix), 'requested');
      if (!oldFirst) {
        requests[0].fail();
        await flush();
        assert.equal(automix.lastError, '', 'old failure must not overwrite current state');
      }
      assert.equal(automix.busy, false);
      assert.equal(automix.pending, null);
      assert.deepEqual(decks.A.loadCalls, []);
    });
}

test('a manual idle cue survives promotion and is not consumed from the future queue', async () => {
  const { automix, decks } = fixture();
  await decks.B.load(track('manual'));
  automix.promote(track('requested'));
  automix.tick(0);
  await flush();
  assert.equal(handover(automix), 'manual');
  assert.equal(automix.queue[automix.cursor].id, 'requested');
});

test('promotion during a fade waits for the committed handover', async () => {
  const { automix, decks } = fixture();
  automix.tick(0);
  await flush();
  assert.equal(automix.skip(), true);
  automix.promote(track('requested'));
  assert.deepEqual(decks.B.loadCalls, ['staged']);
  automix.tick(6);
  assert.equal(automix.liveDeck.track.id, 'staged');
  automix.preloadLead = 999;
  automix.tick(0);
  await flush();
  assert.equal(handover(automix), 'requested');
});

test('promotion during a real armed Transition waits for its handover', async () => {
  const { automix, decks } = fixture();
  automix.mixer.ctx = { currentTime: 0 };
  for (const deck of Object.values(decks)) {
    Object.assign(deck, {
      bpm: 120, effectiveBpm: 120, eq: { low: 0 },
      setEq(band, value) { this.eq[band] = value; },
      armStartAt() { return true; },
      setSynced() {},
    });
  }
  automix.tick(0);
  await flush();
  automix.plan = { style: 'cut', startSec: 64, endSec: 65, inOffset: 0 };
  automix._lastLivePos = 60;
  automix.tick(0);
  assert.equal(automix.transition.state, 'ARMED');
  automix.promote(track('requested'));
  assert.deepEqual(decks.B.loadCalls, ['staged']);
  automix.mixer.ctx.currentTime = 4;
  decks.A.position = 64;
  decks.B.play();
  automix.tick(0);
  assert.equal(automix.transition.state, 'OVERLAP');
  automix.insertAt(track('after-requested'), 2);
  automix.mixer.ctx.currentTime = 5;
  decks.A.position = 65;
  automix.tick(1);
  assert.equal(automix.transition, null);
  assert.equal(automix.liveDeck.track.id, 'staged');
  automix.preloadLead = 999;
  decks.A.bpm = 0;
  automix.tick(0);
  await flush();
  assert.equal(handover(automix), 'requested');
});

test('promote stays pinned when an order change has not reached the frame loop yet', async (t) => {
  t.mock.method(Math, 'random', () => 0.99);
  const { automix } = fixture();
  automix.tick(0);
  await flush();
  automix.order = 'shuffle';
  automix.promote(track('requested'));
  automix.tick(0);
  await flush();
  assert.equal(handover(automix), 'requested');
});

test('manual replacement just before skip preserves the unplayed reserved queue entry', async () => {
  const { automix, decks } = fixture();
  automix.tick(0);
  await flush();
  await decks.B.load(track('manual'));
  assert.equal(handover(automix), 'manual');
  assert.equal(automix.queue[automix.cursor].id, 'staged');
});

for (const edit of ['promote', 'insertAt']) {
  test(`${edit} synchronizes a mode-selected queue head before immediate skip`, async (t) => {
    t.mock.method(Math, 'random', () => 0.99);
    const { automix } = fixture();
    automix.tick(0);
    await flush();
    automix.order = 'shuffle';
    automix[edit](track('promoted'), 1);
    await flush();
    assert.equal(handover(automix), 'promoted');
  });
}
