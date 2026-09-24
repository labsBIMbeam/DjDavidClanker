import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import { manifestMetadata } from './build/napplet.js';

const TITLE = 'Clanker Synth';
const DESCRIPTION = 'An original seeded four-bar bass and drum instrument. '
  + 'Render WAV loops and send them to a music player through the shell.';

export default defineConfig({
  root: resolve(import.meta.dirname, 'synth'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist-synth'),
    emptyOutDir: true,
    modulePreload: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  plugins: [
    nip5aManifest({
      nappletType: 'clanker-synth',
      title: TITLE,
      description: DESCRIPTION,
      artifactMode: 'single-file',
      // A producer of music selections, not a handler for music playback.
      // Local synthesis works without domains; upload and intent are optional.
      requires: { infer: false, explicit: [], mode: 'warn' },
    }),
    manifestMetadata({ title: TITLE, description: DESCRIPTION }),
  ],
});
