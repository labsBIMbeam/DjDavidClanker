import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

const TITLE = 'DJ David Clanker';
const DESCRIPTION =
  'Two-deck auto-DJ: phrase-aligned transitions, key detection and smart track selection. '
  + 'Wavlake value4value with per-track zaps, Nostr playlists, your own Subsonic/Navidrome '
  + 'library, Audius and Archive.org discovery, local files, real scratching and macro FX.';

// Blossom servers holding our blobs. NIP-5D: "`server` tags SHOULD hint the
// Blossom servers holding those blobs" — and the Kehto runtime reads the
// servers from the MANIFEST (`allTagValues(event.tags, "server")`), not from
// the author's kind-10063 list. Without these the napplet resolves but the
// bytes are never fetched. First entry is the default.
const SERVERS = ['https://blssm.us', 'https://cdn.hzrd149.com'];

/**
 * The napplet plugin (0.14.1) documents `["title", …]` / `["description", …]`
 * manifest tags but only writes them into the built HTML, and it has no
 * option for `server` tags at all. This sidecar pass adds both, so a
 * published manifest carries what a runtime or directory needs to name,
 * describe and actually LOAD this napplet.
 */
function manifestMetadata({ title, description, servers }) {
  return {
    name: 'clanker-manifest-metadata',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const file = resolve(process.cwd(), 'dist/.nip5a-manifest.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const keep = manifest.tags.filter(
        (t) => !['title', 'description', 'server'].includes(t[0]),
      );
      const dIndex = keep.findIndex((t) => t[0] === 'd');
      const extras = [
        ['title', title],
        ['description', description],
        ...servers.map((s) => ['server', s]),
      ];
      keep.splice(dIndex + 1, 0, ...extras);
      manifest.tags = keep;
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

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
      title: TITLE,
      description: DESCRIPTION,
      artifactMode: 'single-file',
      // NAAT role. There is no music/player/dj archetype in the registry yet
      // (note, feed, feed-manager, composer, profile, dm, pet) — this claims
      // the slug; making it official needs a PR to napplet/naps.
      archetypes: [{ slug: 'dj', convention: 'napplet:dj/open' }],
      requires: {
        infer: false,
        explicit: ['resource', 'identity', 'storage', 'outbox', 'relay', 'common', 'link'],
        mode: 'warn',
      },
    }),
    manifestMetadata({ title: TITLE, description: DESCRIPTION, servers: SERVERS }),
  ],
});
