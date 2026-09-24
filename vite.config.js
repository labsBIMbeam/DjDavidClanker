import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import { manifestMetadata, MUSIC_ARCHETYPES } from './build/napplet.js';

const TITLE = 'DJ David Clanker';
const DESCRIPTION =
  'Two-deck auto-DJ: phrase-aligned transitions, key detection and smart track selection. '
  + 'Wavlake value4value with per-track zaps, Nostr playlists, your own Subsonic/Navidrome '
  + 'library, Audius and Archive.org discovery, local files, real scratching and macro FX.';

// NIP-5D napplets ship as a single self-contained index.html that the shell
// injects via iframe.srcdoc. `modulePreload: false` stops Vite from emitting a
// fetch()-based preload helper, which would be blocked by `connect-src 'none'`.
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    modulePreload: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  plugins: [
    nip5aManifest({
      nappletType: 'dj-david-clanker',
      title: TITLE,
      description: DESCRIPTION,
      artifactMode: 'single-file',
      archetypes: MUSIC_ARCHETYPES,
      requires: {
        infer: false,
        explicit: ['resource', 'inc'],
        mode: 'warn',
      },
    }),
    manifestMetadata({ title: TITLE, description: DESCRIPTION }),
  ],
});
