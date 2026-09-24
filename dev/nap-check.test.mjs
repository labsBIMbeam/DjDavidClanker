import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchBlob, openLink, publishEvent, store } from '../src/lib/nap.js';
import { Deck } from '../src/audio/engine.js';
import { imageUrl } from '../src/lib/artwork.js';
import { payInvoice } from '../src/lib/zap.js';

globalThis.window = undefined;
globalThis.localStorage = undefined;

test('a hosted app never substitutes native APIs for absent host domains', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => {
    calls.push('fetch');
    return new Response('native bytes');
  });
  t.mock.property(globalThis, 'window', {
    napplet: {},
    open: () => calls.push('open'),
    nostr: { signEvent: async () => { calls.push('sign'); return { id: 'signed' }; } },
  });
  t.mock.property(globalThis, 'localStorage', {
    getItem: () => { calls.push('storage.get'); return 'native'; },
    setItem: () => calls.push('storage.set'),
  });
  const fetchResult = await fetchBlob('https://example.test/music').catch((e) => e);
  await openLink('https://example.test/artist');
  await publishEvent({ kind: 1, content: '', tags: [] }).catch(() => {});
  await store.set('host-only', 'session value');
  assert.equal(await store.get('host-only'), 'session value');
  assert.deepEqual(calls, [], 'missing grants must not become native authority');
  assert.match(fetchResult.message, /resource.*unavailable/i);
});

test('hosted artwork and wallet helpers do not bypass absent domains', async (t) => {
  let paid = false;
  t.mock.property(globalThis, 'window', { napplet: {}, webln: {
    enable: async () => {}, sendPayment: async () => { paid = true; },
  } });
  assert.equal(await imageUrl('https://music.example/cover.png'), '');
  assert.deepEqual(await payInvoice('fixture-invoice'), { method: 'link', ok: false });
  assert.equal(paid, false);
});

test('granted host calls preserve arguments and denial results', async (t) => {
  const blob = new Blob(['music']);
  const signal = new AbortController().signal;
  t.mock.property(globalThis, 'window', { napplet: {
    resource: { bytes: async (url, opts) => {
      assert.equal(url, 'https://music.example/track');
      assert.equal(opts.signal, signal);
      return blob;
    } },
    link: { open: async () => ({ status: 'denied' }) },
  } });
  assert.equal(await fetchBlob('https://music.example/track', { signal }), blob);
  assert.equal(await openLink('https://music.example'), false);
  window.napplet.link.open = async () => undefined;
  assert.equal(await openLink('https://music.example'), false);
});

test('standalone byte and artwork fallbacks still work', async (t) => {
  t.mock.property(globalThis, 'window', {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/proxy?url=https%3A%2F%2Fmusic.example%2Fa');
    return new Response('track');
  });
  assert.equal(await (await fetchBlob('https://music.example/a', {
    proxy: '/proxy?url={url}',
  })).text(), 'track');
  assert.equal(await imageUrl('https://music.example/art'), 'https://music.example/art');
});

test('a host refusing resource bytes cannot trigger a direct audio URL fallback', async (t) => {
  t.mock.property(globalThis, 'window', { napplet: {
    resource: { bytes: async () => { throw new Error('host denied'); } },
  } });
  const deck = new Deck({ ensureContext() {}, proxy: '' }, 'A');
  t.mock.method(deck, 'stop', () => {});
  const direct = t.mock.method(deck, '_loadElement', async () => {});
  await deck.load({ id: 'denied', streamUrls: ['https://example.test/audio.mp3'] });
  assert.equal(direct.mock.callCount(), 0);
  assert.equal(deck.status, 'error');
  assert.equal(deck.error, 'host denied');
});
