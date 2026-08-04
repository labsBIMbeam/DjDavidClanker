/**
 * Wavlake catalog client.
 *
 * Base URL is `catalog.wavlake.com` (`api.wavlake.com` does not resolve).
 * All read endpoints used here are public — no key, no auth. The JSON API
 * sends CORS headers; the audio CDN does not, which is why audio always goes
 * through the nap `fetchObjectUrl()` path.
 */

import { fetchJson } from './nap.js';

export const CATALOG = 'https://catalog.wavlake.com/v1';
const OP3_PREFIX = /^https:\/\/op3\.dev\/e[^/]*\//;

const cache = new Map();

async function get(path, { ttlMs = 60_000 } = {}) {
  const url = `${CATALOG}${path}`;
  const hit = cache.get(url);
  const now = performance.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const body = await fetchJson(url);
  // Most endpoints wrap in { success, data }; /v1/meta/music/genres does not.
  const value = body && typeof body === 'object' && 'data' in body ? body.data : body;
  cache.set(url, { t: now, v: value });
  return value;
}

/** Strip the OP3 analytics prefix to get the bare CloudFront URL. */
export function cdnUrl(liveUrl) {
  return typeof liveUrl === 'string' ? liveUrl.replace(OP3_PREFIX, '') : '';
}

/** Normalise the several slightly different track shapes into one. */
export function normTrack(raw) {
  if (!raw || !raw.id) return null;
  const live = raw.liveUrl || '';
  return {
    id: raw.id,
    title: raw.title || raw.name || 'Untitled',
    artist: raw.artist || '',
    artistId: raw.artistId || '',
    artistUrl: raw.artistUrl || '',
    artistNpub: raw.artistNpub || '',
    albumId: raw.albumId || '',
    albumTitle: raw.albumTitle || '',
    artworkUrl: raw.artworkUrl || raw.avatarUrl || '',
    avatarUrl: raw.avatarUrl || '',
    duration: Number(raw.duration) || 0,
    // Two candidates: OP3-wrapped (counts the play for the artist) and bare CDN.
    streamUrls: [live, cdnUrl(live)].filter((u, i, a) => u && a.indexOf(u) === i),
    pageUrl: `https://wavlake.com/track/${raw.id}`,
    sats7d: Math.round(Number(raw.msatTotal7Days || 0) / 1000),
    satsTotal: Math.round(Number(raw.msatTotal || 0) / 1000),
    colorInfo: raw.colorInfo || null,
  };
}

const normList = (rows) => (Array.isArray(rows) ? rows.map(normTrack).filter(Boolean) : []);

/* --------------------------- sources --------------------------- */

/** Top chart. Ranked by msatTotal7Days desc. `days`/`genre` are ignored server-side. */
export async function topTracks(limit = 40) {
  return normList(await get(`/charts/music/top?limit=${limit}`));
}

export async function newTracks() {
  return normList(await get('/tracks/new'));
}

export async function featured() {
  const d = await get('/tracks/featured');
  return {
    featured: normList(d && d.featured),
    forYou: normList(d && d.forYou),
    trending: normList(d && d.trending),
  };
}

export async function randomTracks(genreId) {
  const path = genreId ? `/tracks/random/${genreId}/genre` : '/tracks/random';
  return normList(await get(path, { ttlMs: 0 }));
}

export async function genres() {
  const rows = await get('/meta/music/genres', { ttlMs: 3_600_000 });
  return Array.isArray(rows) ? rows : [];
}

/** Mixed search: artists, albums and tracks in one flat array. */
export async function search(term) {
  const rows = await get(`/search?term=${encodeURIComponent(term)}`, { ttlMs: 30_000 });
  const out = { artists: [], albums: [], tracks: [] };
  for (const r of rows || []) {
    if (r.type === 'artist') out.artists.push({ id: r.id, name: r.name, url: r.url, avatarUrl: r.avatarUrl });
    else if (r.type === 'album') out.albums.push({ id: r.id, name: r.name, artworkUrl: r.artworkUrl, avatarUrl: r.avatarUrl });
    else if (r.type === 'track') out.tracks.push(normTrack({ ...r, title: r.name }));
  }
  return out;
}

export async function trackById(id) {
  return normTrack(await get(`/tracks/${id}`, { ttlMs: 300_000 }));
}

export async function albumTracks(albumId) {
  return normList(await get(`/tracks/${albumId}/album`, { ttlMs: 300_000 }));
}

export async function artistTracks(artistId) {
  return normList(await get(`/tracks/${artistId}/artist`, { ttlMs: 300_000 }));
}

export async function artist(artistId) {
  return get(`/artists/${artistId}`, { ttlMs: 300_000 });
}

/**
 * Resolve the artist's Nostr npub for a track. Chart/search payloads omit it;
 * the single-track endpoint carries `artistNpub`, the artist endpoint `npub`.
 */
export async function resolveNpub(track) {
  if (track.artistNpub) return track.artistNpub;
  try {
    const full = await trackById(track.id);
    if (full && full.artistNpub) return full.artistNpub;
  } catch {
    /* ignore */
  }
  if (!track.artistId) return '';
  try {
    const a = await artist(track.artistId);
    return (a && a.npub) || '';
  } catch {
    return '';
  }
}

/** Wavlake ids are UUIDs; used to pull track ids out of arbitrary URLs. */
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
