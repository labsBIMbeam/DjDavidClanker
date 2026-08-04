/**
 * Artwork loader.
 *
 * The NIP-5D baseline CSP for a napplet is `img-src data: blob:` — a remote
 * `<img src="https://…">` simply will not load inside the sandbox. So every
 * image goes through the host's resource domain and is handed to the DOM as a
 * same-origin blob URL. Standalone (no resource domain) we fall back to the
 * plain URL, which browsers load fine without CORS.
 */

import { fetchBlob, has } from './nap.js';

const cache = new Map(); // url -> Promise<string>
const MAX = 240;

function remember(url, promise) {
  cache.set(url, promise);
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    const p = cache.get(oldest);
    cache.delete(oldest);
    Promise.resolve(p).then((u) => {
      if (typeof u === 'string' && u.startsWith('blob:')) URL.revokeObjectURL(u);
    }).catch(() => {});
  }
  return promise;
}

/** Resolve a remote image URL into something the sandbox will actually render. */
export function imageUrl(url) {
  if (!url) return Promise.resolve('');
  if (!has('resource')) return Promise.resolve(url);
  if (cache.has(url)) return cache.get(url);
  const p = fetchBlob(url)
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => '');
  return remember(url, p);
}

/** Point an <img> at a URL, routing through the host when necessary. */
export function setImage(img, url) {
  if (!url) return;
  imageUrl(url).then((resolved) => {
    if (resolved) img.src = resolved;
  });
  return img;
}
