import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import { scratchLab } from './dev/scratch-lab.mjs';

// NIP-5D napplets ship as a single self-contained index.html that the shell
// injects via iframe.srcdoc. `modulePreload: false` stops Vite from emitting a
// fetch()-based preload helper, which would be blocked by `connect-src 'none'`.
export default defineConfig({
  build: {
    modulePreload: false,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  plugins: [
    // Dev server only — serves ./scratch-lab as a same-origin track source so
    // the platter can be worked on without the shell. Never enters the build.
    scratchLab({
      dir: 'scratch-lab',
      // These two land on decks A and B at boot; everything else follows.
      first: ['WEBFIVE', 'Winning is Invisible'],
    }),
    nip5aManifest({
      nappletType: 'dj-david-clanker',
      title: 'DJ David Clanker',
      description:
        'Two-deck DJ mixer for Wavlake music. Charts, search, artist sets and Nostr playlists, with per-track value4value zaps.',
      artifactMode: 'single-file',
      requires: {
        infer: false,
        explicit: ['resource', 'identity', 'storage', 'outbox', 'relay', 'common', 'link'],
        mode: 'warn',
      },
    }),
  ],
});
