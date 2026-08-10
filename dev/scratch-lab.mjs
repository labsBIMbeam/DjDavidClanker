/**
 * Dev-only track source: a folder on disk you can drop test audio into.
 *
 * Scratching needs decoded samples (FULL mode), which normally means the shell
 * and its resource domain. Files served same-origin by the dev server decode
 * with a plain fetch, so `npm run dev` becomes enough to work on the platter —
 * no shell, no proxy, no Wavlake round trip, and the same two bars every time,
 * which is what you actually want when tuning a scratch.
 *
 * `apply: 'serve'` keeps every byte of this out of the napplet build.
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

const LIST_ROUTE = '/__scratch-lab';
const FILE_ROUTE = '/__scratch-lab/file/';

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]    folder to serve
 * @param {string[]} [opts.first] case-insensitive substrings; files matching
 *   these float to the top of the listing in this order, so the two decks can
 *   be preloaded with specific tracks rather than whatever sorts first.
 */
export function scratchLab({ dir = 'scratch-lab', first = [] } = {}) {
  const root = resolve(process.cwd(), dir);

  const rank = (name) => {
    const lower = name.toLowerCase();
    const i = first.findIndex((f) => lower.includes(f.toLowerCase()));
    return i === -1 ? first.length : i;
  };

  const listing = () => {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => MIME[extname(name).toLowerCase()])
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((name) => {
        let size = 0;
        try {
          size = statSync(join(root, name)).size;
        } catch {
          /* vanished between readdir and stat */
        }
        return { name, size, url: FILE_ROUTE + encodeURIComponent(name) };
      });
  };

  return {
    name: 'scratch-lab',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];

        if (url === LIST_ROUTE || url === `${LIST_ROUTE}/`) {
          const files = listing();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ dir: root, files }));
          return;
        }

        if (!url.startsWith(FILE_ROUTE)) return next();

        const name = decodeURIComponent(url.slice(FILE_ROUTE.length));
        const target = resolve(root, name);
        // Containment check before anything touches the disk: a name like
        // "../../.ssh/id_ed25519" must not resolve out of the lab folder.
        if (target !== root && !target.startsWith(root + sep)) {
          res.statusCode = 403;
          res.end('outside the lab folder');
          return;
        }
        const mime = MIME[extname(target).toLowerCase()];
        if (!mime || !existsSync(target) || !statSync(target).isFile()) {
          res.statusCode = 404;
          res.end('no such test track');
          return;
        }
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(statSync(target).size));
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(target).pipe(res);
      });

      const n = listing().length;
      server.config.logger.info(
        n
          ? `  \x1b[32m➜\x1b[0m  \x1b[1mScratch lab\x1b[0m: ${n} track${n === 1 ? '' : 's'} in ${dir}/`
          : `  \x1b[33m➜\x1b[0m  \x1b[1mScratch lab\x1b[0m: drop audio into ${dir}/ and reload`,
      );
    },
  };
}
