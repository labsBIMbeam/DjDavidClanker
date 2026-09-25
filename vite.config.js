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

/** The napplet's d-tag. */
const NAPPLET_TYPE = 'dj-david-clanker';

/**
 * Every host domain the code asks the shell for through src/lib/nap.js,
 * optional ones included: a shell grants only the domains a napplet declares.
 * `media` (OS transport controls) is optional at runtime; the app degrades
 * without it.
 */
const REQUIRES = ['common', 'identity', 'link', 'media', 'outbox', 'relay', 'resource', 'storage'];

/**
 * The manifest plugin keeps protocol metadata out of index.html, but hosts
 * that read the artifact alone (the Nappelin Hangar check) look for these two
 * tags, so the napplet build stamps them from the same values as the manifest.
 *
 * `injectTo: 'head'` keeps <meta charset> first (the tags land after <title>).
 * The hook must run `pre`: Vite injects the entry script into <head> before
 * the normal hooks, and the single-file build later inlines ~310 KB of bundle
 * into that tag, which would push the metas far past the first 1024 bytes a
 * host scans.
 */
const meta = (name, content) => ({ tag: 'meta', attrs: { name, content }, injectTo: 'head' });
const nappletMeta = () => ({
  name: 'clanker-napplet-meta',
  apply: 'build',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [
      meta('napplet-type', NAPPLET_TYPE),
      meta('napplet-requires', REQUIRES.join(',')),
    ],
  },
});

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
      ...(standalone ? [] : [sandboxPurge(), nappletMeta()]),
      nip5aManifest({
        nappletType: NAPPLET_TYPE,
        title: 'DJ David Clanker',
        description:
          'Two-deck auto-DJ: phrase-aligned transitions, key detection and smart track selection. '
          + 'Wavlake value4value with per-track zaps, Nostr playlists, your own Subsonic/Navidrome '
          + 'library, Audius and Archive.org discovery, local files, real scratching and macro FX.',
        artifactMode: 'single-file',
        requires: {
          infer: false,
          explicit: REQUIRES,
          mode: 'warn',
        },
      }),
      ...(standalone ? [dropManifest(outDir)] : []),
    ],
  };
});
