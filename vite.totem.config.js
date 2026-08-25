import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

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
      title: 'DJ David Clanker · Totem',
      description:
        'The house DJ on a 480x320 panel: auto-mix and playlist, one screen each. '
        + 'Wavlake charts feed the queue; the full two-deck mixer lives in the desktop build.',
      artifactMode: 'single-file',
      requires: {
        infer: false,
        explicit: ['resource', 'common'],
        mode: 'warn',
      },
    }),
  ],
});
