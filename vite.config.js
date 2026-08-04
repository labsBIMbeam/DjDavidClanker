import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

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
