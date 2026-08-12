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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT || 5178);

const ALLOW_HOSTS = [/(^|\.)wavlake\.com$/i, /(^|\.)cloudfront\.net$/i, /(^|\.)op3\.dev$/i];
// User-configured media servers (Navidrome etc.) and test mocks join the
// allowlist via env: EXTRA_PROXY_HOSTS="music.example.org,127.0.0.1".
const EXTRA_HOSTS = (process.env.EXTRA_PROXY_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const hostAllowed = (h) => ALLOW_HOSTS.some((re) => re.test(h)) || EXTRA_HOSTS.includes(h);
// http: is acceptable for loopback and RFC1918-style LAN servers — that is
// exactly where a self-hosted Navidrome lives.
const protoAllowed = (u) => u.protocol === 'https:'
  || (u.protocol === 'http:' && EXTRA_HOSTS.includes(u.hostname));

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
      // the dev experience from looking like an app bug.
      let upstream = await fetch(target, { redirect: 'follow' });
      if (upstream.status >= 500) {
        await new Promise((r) => setTimeout(r, 400));
        upstream = await fetch(target, { redirect: 'follow' });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      return send(res, upstream.status, upstream.headers.get('content-type') || 'application/octet-stream', buf);
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String((e && e.stack) || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`napplet dev shell:  http://127.0.0.1:${PORT}`);
});
