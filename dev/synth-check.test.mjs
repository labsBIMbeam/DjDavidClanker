import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a synth render contains exactly four bars at the selected tempo', async () => {
  const { renderLoop } = await import('../src/synth/render.js');
  const samples = renderLoop({ bpm: 120, root: 36, seed: 21, sampleRate: 8000 });
  assert.equal(samples.length, 64_000);
  assert.ok(samples instanceof Float32Array);
});

test('the seed reproduces the audible loop and changes its pattern', async () => {
  const { renderLoop } = await import('../src/synth/render.js');
  const options = { bpm: 126, root: 36, seed: 21, sampleRate: 8000 };
  const first = renderLoop(options);
  assert.ok(first.some((value) => Math.abs(value) > 0.05), 'the instrument must produce sound');
  assert.deepEqual(first, renderLoop(options));
  assert.notDeepEqual(first, renderLoop({ ...options, seed: 22 }));
  assert.notDeepEqual(first, renderLoop({ ...options, root: 38 }));
});

test('renders remain finite and bounded and reject settings outside the allocation budget', async () => {
  const { renderLoop } = await import('../src/synth/render.js');
  const samples = renderLoop({ bpm: 80, root: 60, seed: 4294967295, sampleRate: 48000 });
  assert.equal(samples.length, 576000);
  assert.ok(samples.every((value) => Number.isFinite(value) && Math.abs(value) <= 1));
  assert.equal(samples[0], 0);
  assert.equal(Math.abs(samples.at(-1)), 0);
  for (const settings of [{ bpm: NaN }, { bpm: 79 }, { bpm: 161 }, { root: 61 },
    { root: 36.5 }, { seed: -1 }, { seed: 1.5 }, { sampleRate: 7999 }, { sampleRate: 96000 }]) {
    assert.throws(() => renderLoop(settings), /invalid/i, JSON.stringify(settings));
  }
});

test('WAV export writes a mono PCM16 header and clamps its sample data', async () => {
  const { encodeWav } = await import('../src/synth/render.js');
  const bytes = encodeWav(new Float32Array([-2, -1, 0, 1, 2]), 8000);
  const view = new DataView(bytes);
  const ascii = (at, n) => new TextDecoder().decode(bytes.slice(at, at + n));
  assert.equal(bytes.byteLength, 54);
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint32(28, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [-32768, -32768, 0, 32767, 32767]);
  assert.throws(() => encodeWav(new Float32Array([NaN]), 8000), /invalid/i);
});

function audioFixture(resume = async () => {}) {
  const calls = [];
  const context = {
    destination: {}, resume,
    createBuffer: () => ({ copyToChannel: () => calls.push('copy') }),
    createBufferSource: () => ({
      connect: () => calls.push('connect'), start: () => calls.push('start'),
      stop: () => calls.push('stop'), disconnect: () => calls.push('disconnect'),
    }),
    close: async () => { calls.push('close'); },
  };
  return { calls, createContext: () => { calls.push('context'); return context; } };
}

test('playback creates audio only on play and STOP releases its audio resources', async () => {
  const { createLoopPlayer } = await import('../src/synth/player.js');
  const fixture = audioFixture();
  const player = createLoopPlayer(fixture.createContext);
  assert.deepEqual(fixture.calls, []);
  await player.play(new Float32Array([0, 0.2]), 8000);
  assert.equal(player.playing, true);
  player.stop();
  player.stop();
  assert.equal(player.playing, false);
  assert.deepEqual(fixture.calls, ['context', 'copy', 'connect', 'start', 'stop', 'disconnect', 'close']);
});

test('STOP during audio unlock prevents a late playback start', async () => {
  const { createLoopPlayer } = await import('../src/synth/player.js');
  let unlock;
  const pending = new Promise((resolve) => { unlock = resolve; });
  const fixture = audioFixture(() => pending);
  const player = createLoopPlayer(fixture.createContext);
  const play = player.play(new Float32Array([0, 0.2]), 8000);
  player.stop();
  unlock();
  await play;
  assert.equal(player.playing, false);
  assert.ok(!fixture.calls.includes('start'));
  assert.equal(fixture.calls.filter((call) => call === 'close').length, 1);
});

test('a cancelled audio unlock cannot stop a newer playback session', async () => {
  const { createLoopPlayer } = await import('../src/synth/player.js');
  let rejectOld;
  const pending = new Promise((_, reject) => { rejectOld = reject; });
  const old = audioFixture(() => pending);
  const newer = audioFixture();
  let created = 0;
  const player = createLoopPlayer(() => (created++ ? newer : old).createContext());
  const first = player.play(new Float32Array([0, 0.2]), 8000);
  player.stop();
  await player.play(new Float32Array([0, 0.3]), 8000);
  rejectOld(new Error('audio unlock cancelled'));
  await first.catch(() => {});
  assert.equal(player.playing, true);
  assert.ok(!newer.calls.includes('close'));
  player.stop();
});

function hostFixture({ compatible = true, uploadResult } = {}) {
  const calls = [];
  const intentApi = {
    available: async (archetype) => {
      calls.push(['available', archetype]);
      return { available: true, candidates: [{ actions: ['open'],
        conventions: compatible ? ['napplet:music/open'] : ['other:music/open'] }] };
    },
    invoke: async (request) => { calls.push(['invoke', request]); return { ok: true, handled: true }; },
  };
  const uploadApi = {
    upload: async (request) => {
      calls.push(['upload', request]);
      return uploadResult || { ok: true, uploadId: 'u1', status: 'complete',
        url: 'https://storage.example.test/loop.wav' };
    },
  };
  return { calls, intentApi, uploadApi, getHost: () => ({ intent: {}, upload: {} }) };
}

test('send is unavailable without grants or an exact music/open convention', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const missing = hostFixture();
  const noHost = createMusicSender({ ...missing, getHost: () => undefined });
  assert.equal((await noHost.availability()).ready, false);
  assert.deepEqual(missing.calls, []);
  const mismatch = hostFixture({ compatible: false });
  const sender = createMusicSender(mismatch);
  assert.equal((await sender.availability()).ready, false);
  await assert.rejects(sender.send(new Blob(['wav']), 'Test'), /compatible/i);
  assert.ok(mismatch.calls.every(([name]) => name === 'available'));
});

test('send uploads the WAV before dispatching a versioned HTTPS music intent', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture();
  const sender = createMusicSender(fixture);
  const blob = new Blob([new Uint8Array(48)], { type: 'audio/wav' });
  await sender.send(blob, 'Seed 21', 'seed-21.wav');
  assert.deepEqual(fixture.calls.map(([name]) => name), ['available', 'upload', 'invoke']);
  assert.equal(fixture.calls[1][1].data, blob);
  assert.equal(fixture.calls[1][1].mimeType, 'audio/wav');
  assert.deepEqual(fixture.calls[2][1], {
    archetype: 'music', action: 'open', convention: 'napplet:music/open',
    payload: { version: 1, tracks: [{ url: 'https://storage.example.test/loop.wav',
      title: 'Seed 21', artist: 'Clanker Synth' }] },
  });
});

test('failed uploads and unsafe upload URLs never dispatch music', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  for (const uploadResult of [
    { ok: false, status: 'cancelled', error: 'Cancelled' },
    { ok: true, status: 'complete', url: 'http://example.test/loop.wav' },
    { ok: true, status: 'complete', url: 'https://user:secret@example.test/loop.wav' },
    { ok: true, status: 'complete', url: 'https://example.test/loop.wav#fragment' },
    { ok: true, status: 'complete', url: 'https://example.test/loop.wav#' },
  ]) {
    const fixture = hostFixture({ uploadResult });
    await assert.rejects(createMusicSender(fixture).send(
      new Blob([new Uint8Array(48)], { type: 'audio/wav' }), 'Loop'));
    assert.ok(!fixture.calls.some(([name]) => name === 'invoke'));
  }
});

test('send waits for host upload completion and releases the status listener', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture({ uploadResult: { ok: true, status: 'uploading', uploadId: 'u1' } });
  let listener;
  let closed = 0;
  fixture.uploadApi.onStatus = (callback) => { listener = callback; return { close: () => closed++ }; };
  fixture.uploadApi.status = async () => ({ ok: true, status: 'uploading', uploadId: 'u1' });
  const sending = createMusicSender(fixture).send(new Blob(['wav']), 'Loop').catch((e) => e);
  await new Promise(setImmediate);
  assert.equal(typeof listener, 'function');
  assert.ok(!fixture.calls.some(([name]) => name === 'invoke'));
  listener({ ok: true, status: 'complete', uploadId: 'u1', url: 'https://example.test/loop.wav' });
  assert.equal((await sending).handled, true);
  assert.equal(closed, 1);
});

test('one sender rejects duplicate concurrent sends and unlocks after completion', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture();
  const sender = createMusicSender(fixture);
  const first = sender.send(new Blob(['wav']), 'Loop');
  await assert.rejects(sender.send(new Blob(['wav']), 'Loop'), /progress/i);
  await first;
  assert.equal(sender.busy, false);
  assert.equal(fixture.calls.filter(([name]) => name === 'upload').length, 1);
});

test('a timed out upload closes its listener and cannot dispatch after late completion', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture({ uploadResult: { ok: true, status: 'uploading', uploadId: 'u1' } });
  let listener;
  let closed = 0;
  fixture.uploadApi.onStatus = (callback) => { listener = callback; return { close: () => closed++ }; };
  fixture.uploadApi.status = async () => ({ ok: true, status: 'uploading', uploadId: 'u1' });
  const sender = createMusicSender({ ...fixture, timeoutMs: 10 });
  await assert.rejects(sender.send(new Blob(['wav']), 'Loop'), /timed out/i);
  listener({ ok: true, status: 'complete', uploadId: 'u1', url: 'https://example.test/loop.wav' });
  assert.equal(closed, 1);
  assert.equal(sender.busy, false);
  assert.ok(!fixture.calls.some(([name]) => name === 'invoke'));
});

test('a declined music intent is reported as a failure', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture();
  fixture.intentApi.invoke = async () => ({ ok: false, handled: false });
  await assert.rejects(createMusicSender(fixture).send(new Blob(['wav']), 'Loop'), /not accept/i);
});

test('an incompatible default music app blocks upload even when another app is compatible', async () => {
  const { createMusicSender } = await import('../src/synth/send.js');
  const fixture = hostFixture();
  fixture.intentApi.available = async () => ({ available: true, hasDefault: true, candidates: [
    { isDefault: true, actions: ['open'], conventions: ['other:music/open'] },
    { isDefault: false, actions: ['open'], conventions: ['napplet:music/open'] },
  ] });
  const sender = createMusicSender(fixture);
  const state = await sender.availability();
  assert.equal(state.ready, false);
  assert.match(state.message, /default/i);
  await assert.rejects(sender.send(new Blob(['wav']), 'Loop'), /default/i);
  assert.equal(fixture.calls.length, 0, 'neither upload nor intent may precede a compatible default');
});
