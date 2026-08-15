/**
 * Local stack for the STANDALONE napplet (the public nsite build or
 * `npm run preview`): one command brings up everything the app can use
 * beyond charts + local files.
 *
 *   node dev/local-stack.mjs              ingest (with /proxy) + Navidrome
 *   node dev/local-stack.mjs --no-docker  ingest only (no Navidrome)
 *
 * - ingest on 127.0.0.1:8321 — library pipeline, discovery, and the CORS
 *   relay that turns Wavlake streams into decoded FULL-backend tracks
 * - Navidrome on 127.0.0.1:4533 via `docker compose` (ingest/docker-compose.yml)
 *
 * The processes are spawned DETACHED: closing this script leaves them up.
 * Afterwards paste the printed values into ⚙ Settings of the standalone app.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const ingestDir = join(repo, 'ingest');
const noDocker = process.argv.includes('--no-docker');

const up = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
};

const detach = (cmd, args, cwd) => {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.unref();
};

if (await up('http://127.0.0.1:8321/health')) {
  console.log('ingest      already up on 127.0.0.1:8321');
} else {
  detach('uv', ['run', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8321'], ingestDir);
  console.log('ingest      starting on 127.0.0.1:8321 (uv run uvicorn)');
}

if (noDocker) {
  console.log('navidrome   skipped (--no-docker)');
} else {
  detach('docker', ['compose', 'up', '-d'], ingestDir);
  console.log('navidrome   docker compose up -d (127.0.0.1:4533; needs Docker running)');
}

// Give the ingest a moment, then report what actually answers.
await new Promise((r) => setTimeout(r, 4000));
const ingestUp = await up('http://127.0.0.1:8321/health');
const naviUp = noDocker ? false : await up('http://127.0.0.1:4533/ping');

console.log('\n--- status ---');
console.log(`ingest    ${ingestUp ? 'UP' : 'still starting — check again in a few seconds'}`);
if (!noDocker) console.log(`navidrome ${naviUp ? 'UP' : 'still starting (first pull can take minutes)'}`);

console.log(`
--- paste into the standalone app's ⚙ Settings ---
CORS proxy   http://127.0.0.1:8321/proxy?url={url}
Ingest URL   http://127.0.0.1:8321
Server URL   http://127.0.0.1:4533   (user/password from your Navidrome setup)

With the proxy set, Wavlake tracks decode into the FULL backend —
EQ, filter, FX, scratch and waveform, same as inside the host shell.`);
