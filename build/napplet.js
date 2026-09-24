import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SOURCE = 'https://github.com/labsBIMbeam/DjDavidClanker';
export const SERVERS = ['https://blssm.us', 'https://cdn.hzrd149.com'];
// Local proposal with a tested receiver, not an upstream-approved registry entry.
export const MUSIC_ARCHETYPES = [{ slug: 'music', convention: 'napplet:music/open' }];

/** Complete the unsigned plugin manifest after its async writer has finished. */
export function manifestMetadata({ title, description, servers = SERVERS }) {
  let file;
  return {
    name: 'clanker-manifest-metadata',
    apply: 'build',
    configResolved(config) {
      file = resolve(config.root, config.build.outDir, '.nip5a-manifest.json');
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (manifest.sig) throw new Error('Manifest metadata must be added before signing');
        manifest.tags = manifest.tags.filter(
          (tag) => !['title', 'description', 'source', 'server'].includes(tag[0]),
        );
        manifest.tags.push(['title', title], ['description', description], ['source', SOURCE],
          ...servers.map((server) => ['server', server]));
        writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
  };
}
