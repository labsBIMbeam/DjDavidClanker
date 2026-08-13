import { fetchJson } from './nap.js';

/**
 * Spontaneous / discovery sources, by role:
 *
 *   Audius   — decentralized platform with an open API and a DJ-heavy
 *              catalog; streams need no auth. Discovery hosts rotate, so the
 *              entry point is the host list at api.audius.co.
 *   Jamendo  — Creative-Commons music; legally clean even for public sets.
 *              Needs a (free) client_id, configured in settings.
 *   Archive  — archive.org netlabels and live sets. Searching returns ITEMS
 *              (albums); resolving one yields its audio files as tracks.
 *
 * Everything is plain GETs through fetchJson, so it rides the same path as
 * every other source: resource.bytes in a shell, direct fetch standalone.
 */

const APP_NAME = 'davidclanker';

/* ------------------------------- audius ------------------------------- */

let audiusHost = '';

async function getAudiusHost(opts) {
  if (audiusHost) return audiusHost;
  const res = await fetchJson('https://api.audius.co', opts);
  const hosts = (res && res.data) || [];
  if (!hosts.length) throw new Error('no audius hosts');
  // Prefer first-party hosts: the dev-shell proxy allowlists *.audius.co,
  // and third-party node domains would need their own entries.
  audiusHost = hosts.find((u) => /audius\.co$/i.test(new URL(u).hostname)) || hosts[0];
  return audiusHost;
}

function audiusTrack(host, t) {
  return {
    id: `au:${t.id}`,
    title: t.title || 'Untitled',
    artist: (t.user && t.user.name) || '—',
    artistId: '',
    artistUrl: t.user && t.user.handle ? `https://audius.co/${t.user.handle}` : '',
    artistNpub: '',
    albumId: '',
    albumTitle: '',
    artworkUrl: (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
    avatarUrl: '',
    duration: Number(t.duration) || 0,
    streamUrls: [`${host}/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`],
    pageUrl: t.permalink ? `https://audius.co${t.permalink}` : '',
    sats7d: 0,
    satsTotal: 0,
    source: 'audius',
  };
}

export async function audiusTrending(opts) {
  const host = await getAudiusHost(opts);
  const res = await fetchJson(`${host}/v1/tracks/trending?app_name=${APP_NAME}`, opts);
  return ((res && res.data) || []).map((t) => audiusTrack(host, t));
}

export async function audiusSearch(query, opts) {
  const host = await getAudiusHost(opts);
  const q = encodeURIComponent(query);
  const res = await fetchJson(`${host}/v1/tracks/search?query=${q}&app_name=${APP_NAME}`, opts);
  return ((res && res.data) || []).map((t) => audiusTrack(host, t));
}

/* ------------------------------- jamendo ------------------------------- */

export function jamendoConfigured(settings) {
  return Boolean(settings && settings.jamendoClientId);
}

export async function jamendoSearch(settings, query, opts) {
  const q = new URLSearchParams({
    client_id: settings.jamendoClientId,
    format: 'json',
    limit: '50',
    search: query,
    audioformat: 'mp32',
  });
  const res = await fetchJson(`https://api.jamendo.com/v3.0/tracks/?${q}`, opts);
  return ((res && res.results) || []).map((t) => ({
    id: `jm:${t.id}`,
    title: t.name || 'Untitled',
    artist: t.artist_name || '—',
    artistId: '',
    artistUrl: '',
    artistNpub: '',
    albumId: '',
    albumTitle: t.album_name || '',
    artworkUrl: t.album_image || t.image || '',
    avatarUrl: '',
    duration: Number(t.duration) || 0,
    streamUrls: t.audio ? [t.audio] : [],
    pageUrl: t.shareurl || '',
    sats7d: 0,
    satsTotal: 0,
    source: 'jamendo',
  })).filter((t) => t.streamUrls.length);
}

/* ------------------------------- archive ------------------------------- */

const AUDIO_RE = /\.(mp3|flac|ogg|m4a|wav|opus)$/i;

/** Search archive.org audio items (albums / live sets), netlabels first. */
export async function archiveSearch(query, opts) {
  const q = encodeURIComponent(`(${query}) AND mediatype:(audio)`);
  const url = 'https://archive.org/advancedsearch.php'
    + `?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&rows=24&page=1&output=json`
    + '&sort[]=downloads+desc';
  const res = await fetchJson(url, opts);
  return (((res || {}).response || {}).docs || []).map((d) => ({
    identifier: d.identifier,
    title: d.title || d.identifier,
    creator: Array.isArray(d.creator) ? d.creator[0] : d.creator || '',
  }));
}

/** Resolve one item into its audio files as playable tracks. */
export async function archiveItem(identifier, opts) {
  const res = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, opts);
  const meta = (res && res.metadata) || {};
  const files = ((res && res.files) || []).filter((f) => AUDIO_RE.test(f.name || ''));
  // Prefer one format per stem so an item with mp3+flac+ogg lists each track once.
  const seen = new Set();
  const picked = [];
  for (const ext of ['.mp3', '.ogg', '.m4a', '.flac', '.wav', '.opus']) {
    for (const f of files) {
      const stem = f.name.replace(AUDIO_RE, '');
      if (f.name.toLowerCase().endsWith(ext) && !seen.has(stem)) {
        seen.add(stem);
        picked.push(f);
      }
    }
  }
  picked.sort((a, b) => (a.name > b.name ? 1 : -1));
  return picked.map((f) => ({
    id: `ia:${identifier}/${f.name}`,
    title: f.title || f.name.replace(AUDIO_RE, '').replace(/^[\d\s._-]+/, '') || f.name,
    artist: (Array.isArray(meta.creator) ? meta.creator[0] : meta.creator) || meta.title || '—',
    artistId: '',
    artistUrl: '',
    artistNpub: '',
    albumId: identifier,
    albumTitle: meta.title || identifier,
    artworkUrl: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
    avatarUrl: '',
    duration: Number(f.length) || 0,
    streamUrls: [`https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`],
    pageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    sats7d: 0,
    satsTotal: 0,
    source: 'archive',
  }));
}
