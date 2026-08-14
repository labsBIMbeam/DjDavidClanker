/**
 * Dev host for the napplet.
 *
 * Serves `dev/shell.html` (a minimal NIP-5D shell), the built napplet, the
 * official `@napplet/shim` prelude, and — crucially — a server-side fetch
 * proxy. That proxy is what makes this shell behave like a real desktop shell:
 * `resource.bytes` must be able to reach hosts that send no CORS headers, which
 * a browser-only shell cannot do.
 *
 *   npm run shell   ->  http://127.0.0.1:5178
 */

import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT || 5178);

// Disk cache for proxied upstreams. Wavlake goes through slow windows that
// used to take every E2E suite (and any offline demo) down with it; a proxy
// hit is served fresh when the upstream answers and from disk when it stalls.
const CACHE_DIR = join(here, '.proxy-cache');
await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
const cachePaths = (target) => {
  const k = createHash('sha1').update(target).digest('hex');
  return { bin: join(CACHE_DIR, `${k}.bin`), meta: join(CACHE_DIR, `${k}.json`) };
};
async function cacheRead(target) {
  try {
    const p = cachePaths(target);
    const meta = JSON.parse(await readFile(p.meta, 'utf8'));
    return { buf: await readFile(p.bin), type: meta.type };
  } catch {
    return null;
  }
}
function cacheWrite(target, type, buf) {
  if (!buf.length || buf.length > 30e6) return;
  const p = cachePaths(target);
  writeFile(p.bin, buf)
    .then(() => writeFile(p.meta, JSON.stringify({ type, url: target })))
    .catch(() => {});
}

const ALLOW_HOSTS = [
  /(^|\.)wavlake\.com$/i, /(^|\.)cloudfront\.net$/i, /(^|\.)op3\.dev$/i,
  // Discovery sources: Audius (host list + first-party discovery nodes),
  // Jamendo (API + storage CDN), Archive.org (search/metadata/download —
  // the download redirect to ia*.us.archive.org happens inside the proxy's
  // own fetch, so only this first hop needs to be listed).
  /(^|\.)audius\.co$/i, /(^|\.)jamendo\.com$/i, /(^|\.)archive\.org$/i,
];
// User-configured media servers (Navidrome etc.) and test mocks join the
// allowlist via env: EXTRA_PROXY_HOSTS="music.example.org,127.0.0.1".
const EXTRA_HOSTS = (process.env.EXTRA_PROXY_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Loopback is always fair game in a dev shell: the ingest service and a
// local Navidrome live there, and requiring an env var to reach your own
// machine made the ⤴ promote button silently dead on a plain `npm run shell`.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const hostAllowed = (h) => ALLOW_HOSTS.some((re) => re.test(h))
  || EXTRA_HOSTS.includes(h) || LOOPBACK.includes(h);
// http: is acceptable for loopback and RFC1918-style LAN servers — that is
// exactly where a self-hosted Navidrome lives.
const protoAllowed = (u) => u.protocol === 'https:'
  || (u.protocol === 'http:' && (EXTRA_HOSTS.includes(u.hostname) || LOOPBACK.includes(u.hostname)));

const send = (res, code, type, body, extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', ...extra });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(here, 'shell.html')));
    }
    if (url.pathname === '/napplet.html') {
      return send(res, 200, 'text/plain; charset=utf-8', await readFile(join(root, 'dist/index.html')));
    }
    if (url.pathname === '/prelude.js') {
      return send(
        res,
        200,
        'text/plain; charset=utf-8',
        await readFile(join(root, 'node_modules/@napplet/shim/dist/prelude.global.js')),
      );
    }
    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('url');
      if (!target) return send(res, 400, 'text/plain', 'missing url');
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return send(res, 400, 'text/plain', 'bad url');
      }
      if (!protoAllowed(parsed) || !hostAllowed(parsed.hostname)) {
        return send(res, 403, 'text/plain', `host not allowed: ${parsed.hostname}`);
      }
      // The egress path occasionally returns a transient 5xx; one retry keeps
      // the dev experience from looking like an app bug. The short abort
      // guards the CONNECT phase only (it must stay under the napplet shim's
      // own resource.bytes patience, or the cache fallback answers a request
      // nobody waits for) — once headers arrive, a multi-MB audio body gets
      // its own generous window. Aborting the whole fetch at 6 s silently
      // downgraded every slow Wavlake track to the BASIC backend: no peaks,
      // no waveform, no vinyl.
      const grab = async (connectMs) => {
        const ctrl = new AbortController();
        let timer = setTimeout(() => ctrl.abort(), connectMs);
        try {
          const r = await fetch(target, { redirect: 'follow', signal: ctrl.signal });
          clearTimeout(timer); // headers are in — now guard the body loosely
          timer = setTimeout(() => ctrl.abort(), 120000);
          const buf = Buffer.from(await r.arrayBuffer());
          return { r, buf };
        } finally {
          clearTimeout(timer);
        }
      };
      let got = null;
      try {
        got = await grab(6000);
        if (got.r.status >= 500) {
          await new Promise((r) => setTimeout(r, 400));
          got = await grab(4000);
        }
      } catch {
        got = null;
      }
      if (!got || got.r.status >= 500) {
        const hit = await cacheRead(target);
        if (hit) return send(res, 200, hit.type, hit.buf, { 'x-proxy-cache': 'stale' });
        if (!got) return send(res, 504, 'text/plain', 'upstream timeout');
      }
      const type = got.r.headers.get('content-type') || 'application/octet-stream';
      if (got.r.ok) cacheWrite(target, type, got.buf);
      return send(res, got.r.status, type, got.buf);
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String((e && e.stack) || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`napplet dev shell:  http://127.0.0.1:${PORT}`);
});
