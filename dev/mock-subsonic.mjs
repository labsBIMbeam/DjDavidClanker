/**
 * Mock Subsonic server + ingest capture for the sources E2E.
 *
 * Speaks just enough of the Subsonic REST dialect (ping, search3,
 * getRandomSongs, stream) to exercise the app's Server tab against known
 * data, and records POST /ingest uploads so the ⤴ button is assertable.
 * Everything answers permissive CORS, like a properly configured Navidrome
 * behind a reverse proxy would.
 *
 *   node dev/mock-subsonic.mjs   →   http://127.0.0.1:5199
 */

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 5199);

const SONGS = [
  { id: 's1', title: 'Crate One', artist: 'Server Artist', album: 'Lib', duration: 4 },
  { id: 's2', title: 'Crate Two', artist: 'Server Artist', album: 'Lib', duration: 4 },
  { id: 's3', title: 'Other Thing', artist: 'Second Artist', album: 'Lib', duration: 4 },
];

/** 4-second 44.1 kHz mono WAV with a 220 Hz tone — decodes in FULL mode. */
function wavBytes(seconds = 4, sr = 44100) {
  const n = seconds * sr;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.sin((2 * Math.PI * 220 * i) / sr) * 0.4 * 32767, 44 + i * 2);
  }
  return buf;
}
const WAV = wavBytes();

const ingested = []; // { name, bytes }

const ok = (payload) => JSON.stringify({
  'subsonic-response': { status: 'ok', version: '1.16.1', ...payload },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, ...cors });
    res.end(body);
  };

  if (url.pathname === '/rest/ping' || url.pathname === '/rest/ping.view') {
    return send(200, 'application/json', ok({}));
  }
  if (url.pathname.startsWith('/rest/search3')) {
    const q = (url.searchParams.get('query') || '').toLowerCase();
    const song = SONGS.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q));
    return send(200, 'application/json', ok({ searchResult3: { song } }));
  }
  if (url.pathname.startsWith('/rest/getRandomSongs')) {
    return send(200, 'application/json', ok({ randomSongs: { song: SONGS } }));
  }
  if (url.pathname.startsWith('/rest/stream')) {
    return send(200, 'audio/wav', WAV);
  }
  if (url.pathname === '/ingest' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const m = /filename="([^"]+)"/.exec(body.toString('latin1'));
      ingested.push({ name: m ? m[1] : 'unknown', bytes: body.length });
      send(200, 'application/json', JSON.stringify({ ok: true, queued: ingested.length }));
    });
    return undefined;
  }
  if (url.pathname === '/ingested') {
    return send(200, 'application/json', JSON.stringify(ingested));
  }
  return send(404, 'text/plain', 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock subsonic+ingest on http://127.0.0.1:${PORT}`);
});
