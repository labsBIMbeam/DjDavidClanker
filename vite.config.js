import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import { sandboxPurge } from './build/sandbox-purge.js';

// NIP-5D napplets ship as a single self-contained index.html that the shell
// injects via iframe.srcdoc. `modulePreload: false` stops Vite from emitting a
// fetch()-based preload helper, which would be blocked by `connect-src 'none'`.
//
// Two artifacts from one source:
//   npm run build             -> dist/             the napplet (sandbox-purged, conformant)
//   npm run build:standalone  -> dist-standalone/  the standalone app (browser fetch,
//                                                  localStorage, NIP-07 as fallbacks)
// Only dist/ is a napplet; publish that one.

/** The standalone artifact is not a napplet: drop the manifest sidecar the plugin writes. */
const dropManifest = (outDir) => ({
  name: 'clanker-standalone-no-manifest',
  apply: 'build',
  closeBundle: {
    order: 'post',
    sequential: true,
    handler: () => rm(resolve(import.meta.dirname, outDir, '.nip5a-manifest.json'), { force: true }),
  },
});

export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  const outDir = standalone ? 'dist-standalone' : 'dist';
  return {
    build: {
      outDir,
      modulePreload: false,
      target: 'es2022',
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
    },
    plugins: [
      ...(standalone ? [] : [sandboxPurge()]),
      nip5aManifest({
        nappletType: 'dj-david-clanker',
        title: 'DJ David Clanker',
        description:
          'Two-deck auto-DJ: phrase-aligned transitions, key detection and smart track selection. '
          + 'Wavlake value4value with per-track zaps, Nostr playlists, your own Subsonic/Navidrome '
          + 'library, Audius and Archive.org discovery, local files, real scratching and macro FX.',
        artifactMode: 'single-file',
        requires: {
          infer: false,
          explicit: ['resource', 'identity', 'storage', 'outbox', 'relay', 'common', 'link'],
          mode: 'warn',
        },
      }),
      ...(standalone ? [dropManifest(outDir)] : []),
    ],
  };
});
