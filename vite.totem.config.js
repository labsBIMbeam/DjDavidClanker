import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import { manifestMetadata, MUSIC_ARCHETYPES } from './build/napplet.js';

const TITLE = 'DJ David Clanker · Totem';
const DESCRIPTION = 'Music playback and auto-mix on a 480x320 panel. '
  + 'Accepts portable music selections through the proposed music/open convention.';

// The Totem build: the same engine, a 480x320 face. One self-contained file,
// exactly like the main build, landing in dist-totem/ so the two artifacts
// never overwrite each other.
export default defineConfig({
  // The napplet plugin's single-file mode expects the page to be index.html,
  // so the totem entry lives in its own root.
  root: resolve(import.meta.dirname, 'totem'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist-totem'),
    emptyOutDir: true,
    modulePreload: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  plugins: [
    nip5aManifest({
      nappletType: 'dj-david-clanker-totem',
      title: TITLE,
      description: DESCRIPTION,
      archetypes: MUSIC_ARCHETYPES,
      artifactMode: 'single-file',
      requires: {
        infer: false,
        explicit: ['resource', 'inc'],
        mode: 'warn',
      },
    }),
    manifestMetadata({ title: TITLE, description: DESCRIPTION }),
  ],
});
