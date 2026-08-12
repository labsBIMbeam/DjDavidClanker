import { fetchJson } from './nap.js';
import { md5 } from './md5.js';

/**
 * Minimal Subsonic API client — the door to a self-hosted Navidrome, the
 * single source of truth for play-ready material ("the crate").
 *
 * Everything is GET with auth in the query (the protocol's salt+token
 * scheme, so the password itself never travels), which means every call —
 * including the audio stream — rides the app's existing fetch path:
 * `resource.bytes` inside a shell, direct fetch (or CORS proxy) standalone.
 */

const API_VERSION = '1.16.1';
const CLIENT = 'davidclanker';

const randSalt = () => Math.random().toString(36).slice(2, 10);

/** Config comes from settings: { url, user, pass }. */
export function subsonicConfigured(s) {
  return Boolean(s && s.subsonicUrl && s.subsonicUser && s.subsonicPass);
}

function baseUrl(s, endpoint, params = {}) {
  const salt = randSalt();
  const u = new URL(`rest/${endpoint}`, s.subsonicUrl.replace(/\/?$/, '/'));
  u.searchParams.set('u', s.subsonicUser);
  u.searchParams.set('t', md5(s.subsonicPass + salt));
  u.searchParams.set('s', salt);
  u.searchParams.set('v', API_VERSION);
  u.searchParams.set('c', CLIENT);
  u.searchParams.set('f', 'json');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function call(s, endpoint, params, opts) {
  const json = await fetchJson(baseUrl(s, endpoint, params), opts);
  const r = json['subsonic-response'];
  if (!r || r.status !== 'ok') {
    throw new Error((r && r.error && r.error.message) || 'subsonic error');
  }
  return r;
}

/** Song → the app's track shape. Streams flow through the normal deck path. */
function toTrack(s, song) {
  return {
    id: `nd:${song.id}`,
    title: song.title || 'Untitled',
    artist: song.artist || song.albumArtist || '—',
    artistId: '',
    artistUrl: '',
    artistNpub: '',
    albumId: song.albumId || '',
    albumTitle: song.album || '',
    artworkUrl: song.coverArt ? baseUrl(s, 'getCoverArt', { id: song.coverArt, size: 300 }) : '',
    avatarUrl: '',
    duration: Number(song.duration) || 0,
    streamUrls: [baseUrl(s, 'stream', { id: song.id })],
    pageUrl: '',
    sats7d: 0,
    satsTotal: 0,
    source: 'subsonic',
  };
}

export async function subsonicPing(s, opts) {
  await call(s, 'ping', {}, opts);
  return true;
}

export async function subsonicSearch(s, query, opts) {
  const r = await call(s, 'search3', { query, songCount: 50, albumCount: 0, artistCount: 0 }, opts);
  const songs = (r.searchResult3 && r.searchResult3.song) || [];
  return songs.map((song) => toTrack(s, song));
}

export async function subsonicRandom(s, count = 30, opts) {
  const r = await call(s, 'getRandomSongs', { size: count }, opts);
  const songs = (r.randomSongs && r.randomSongs.song) || [];
  return songs.map((song) => toTrack(s, song));
}
