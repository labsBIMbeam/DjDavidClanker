import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizePath } from 'vite';

const AMBIENT = normalizePath(fileURLToPath(new URL('../src/lib/ambient.js', import.meta.url)));
const SANDBOX = fileURLToPath(new URL('../src/lib/ambient.sandbox.js', import.meta.url));

/**
 * NIP-5D napplets must not touch fetch/localStorage/window.nostr: the host
 * sandbox withholds them, and @napplet/conformance-cli rejects those tokens
 * anywhere in the bundle, even as dead fallback code. The app reaches ambient
 * authority only through src/lib/ambient.js; for the napplet artifact this
 * plugin loads src/lib/ambient.sandbox.js in its place (same exports, no
 * authority). The same idea as Cartridge's sandboxPurge, applied to the one
 * module that holds the standalone fallbacks.
 */
export function sandboxPurge() {
  return {
    name: 'clanker-sandbox-purge',
    enforce: 'pre',
    apply: 'build',
    load(id) {
      if (normalizePath(id.split('?')[0]) !== AMBIENT) return null;
      return readFileSync(SANDBOX, 'utf8');
    },
  };
}
