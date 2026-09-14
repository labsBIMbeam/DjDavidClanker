/**
 * Napstr: the music swarm on Nostr as a source.
 *
 * The catalogue is public and readable through the host's relay/outbox domain:
 * kind 30422 heartbeats (`t: napstr-availability`, content = the file ids a
 * seeder offers, with an `expiration`) say who is online with what; kind 30421
 * entries (`t: napstr`, `d` = the file's SHA-256, content `napstr/1`) carry the
 * metadata. The bytes themselves live in the swarm: seeders hand them over the
 * Napstr transfer protocol, not over HTTP, and a napplet cannot speak it.
 *
 * So a Napstr track here plays only where a gateway serves the file by its
 * hash: a Blossom mirror that happens to hold it, or a gateway the DJ's settings
 * name (a napstrd with an HTTP front, see nappelin.com services/napstrd).
 * Every candidate is a plain `https://<gateway>/<sha256>` URL, tried in order by
 * the deck; when none answers, the row still tells you the track exists and
 * where to get Napstr.
 */

import { queryEvents } from './nap.js';

export const KIND_CATALOGUE = 30421;
export const KIND_AVAILABILITY = 30422;
export const TAG_CATALOGUE = 'napstr';
export const TAG_AVAILABILITY = 'napstr-availability';
export const NAPSTR_HOME = 'https://github.com/lnbits/napstr';
/** Public Blossom mirrors, asked by hash. None seeds the swarm today; a track that is there is a bonus. */
export const DEFAULT_GATEWAYS = ['https://blossom.bimcvp.com', 'https://nostr.download', 'https://blossom.primal.net'];
/** How many live files the browse view hydrates (most seeders first). */
export const BROWSE_WINDOW = 120;
const CHUNK = 50;
const FILE_ID = /^[0-9a-f]{64}$/;
const FORMATS = { MP3: 'audio/mpeg', FLAC: 'audio/flac', WAV: 'audio/wav', OGG: 'audio/ogg', OPUS: 'audio/ogg' };
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'on', 'in', 'to', 'for', 'with']);

const tagValue = (ev, name) => {
  const t = (ev.tags || []).find((x) => x[0] === name);
  return t ? t[1] : undefined;
};
const tagValues = (ev, name) => (ev.tags || []).filter((x) => x[0] === name).map((x) => x[1]);
const now = () => Math.floor(Date.now() / 1000);

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One line, control characters out, cut to `limit`. */
export function clean(value, limit) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out.trim().slice(0, limit);
}

/** Who offers which file right now, from unexpired heartbeats. */
export function liveSeeders(events, at = now()) {
  const byFile = new Map();
  for (const ev of events) {
    if (ev.kind !== KIND_AVAILABILITY || !FILE_ID.test(ev.pubkey)) continue;
    if (!tagValues(ev, 't').includes(TAG_AVAILABILITY)) continue;
    const expires = Number(tagValue(ev, 'expiration'));
    if (!Number.isFinite(expires) || expires <= at) continue;
    const ids = json(ev.content);
    if (!Array.isArray(ids)) continue;
    for (const id of new Set(ids.filter((v) => typeof v === 'string' && FILE_ID.test(v)))) {
      const set = byFile.get(id) || new Set();
      set.add(ev.pubkey);
      byFile.set(id, set);
    }
  }
  return byFile;
}

/** A catalogue event checked field by field, or null. */
export function parseCatalogue(ev) {
  if (!ev || ev.kind !== KIND_CATALOGUE || !FILE_ID.test(ev.pubkey || '')) return null;
  const fileId = tagValue(ev, 'd');
  if (!fileId || !FILE_ID.test(fileId) || !tagValues(ev, 't').includes(TAG_CATALOGUE)) return null;
  const content = json(ev.content);
  if (!content || typeof content !== 'object' || content.protocol !== 'napstr/1') return null;
  if (content.deleted === true) return null;
  const x = tagValue(ev, 'x');
  if (content.fileId !== fileId || (x !== undefined && x !== fileId)) return null;
  const filename = clean(content.filename ?? tagValue(ev, 'name'), 160).split(/[\\/]/).pop();
  if (!filename) return null;
  const format = typeof content.format === 'string' ? content.format.toUpperCase() : '';
  const mime = FORMATS[format];
  if (!mime) return null;
  const size = typeof content.size === 'number' ? content.size : Number(tagValue(ev, 'size'));
  if (!Number.isSafeInteger(size) || size < 1) return null;
  return {
    fileId,
    author: ev.pubkey,
    createdAt: ev.created_at,
    filename,
    title: clean(content.title, 200) || filename,
    artist: clean(content.artist, 200),
    album: clean(content.album, 200),
    format,
    mime,
    size,
  };
}

/** The DJ's track shape for a catalogue entry; `streamUrls` are the gateways asked by hash. */
export function napstrTrack(entry, seeders, gateways = DEFAULT_GATEWAYS) {
  const bases = gateways.map((g) => String(g).replace(/\/+$/, '')).filter(Boolean);
  return {
    id: `napstr:${entry.fileId}`,
    title: entry.title,
    artist: entry.artist,
    artistId: '',
    artistUrl: '',
    artistNpub: '',
    albumId: '',
    albumTitle: entry.album || `${entry.format} · ${formatBytes(entry.size)} · ${seeders} seeding`,
    artworkUrl: '',
    avatarUrl: '',
    duration: 0,
    streamUrls: bases.map((b) => `${b}/${entry.fileId}`),
    pageUrl: '',
    sats7d: 0,
    satsTotal: 0,
    colorInfo: null,
    napstr: { fileId: entry.fileId, seeders, size: entry.size, format: entry.format, author: entry.author },
  };
}

export function formatBytes(n) {
  if (!(n > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Newest catalogue entry per file id, from the events given. */
function latestEntries(events) {
  const byId = new Map();
  for (const ev of events) {
    const entry = parseCatalogue(ev);
    if (!entry) continue;
    const old = byId.get(entry.fileId);
    if (!old || entry.createdAt > old.createdAt) byId.set(entry.fileId, entry);
  }
  return byId;
}

/** Hydrate catalogue entries for file ids, in bounded pages. */
async function hydrate(fileIds) {
  const pages = await Promise.all(chunks(fileIds, CHUNK).map((chunk) =>
    queryEvents([{ kinds: [KIND_CATALOGUE], '#t': [TAG_CATALOGUE], '#d': chunk, limit: 500 }])));
  return latestEntries(pages.flat());
}

/**
 * The live swarm: the files most seeders offer right now, with their metadata.
 * Returns `{ tracks, offered, seeding }`: tracks in seeder order, how many files
 * are offered in total, and how many seeders are online.
 */
export async function browseLive({ limit = BROWSE_WINDOW, gateways } = {}) {
  const heartbeats = await queryEvents([{ kinds: [KIND_AVAILABILITY], '#t': [TAG_AVAILABILITY], limit: 500 }]);
  const live = liveSeeders(heartbeats);
  const ranked = [...live.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
  const window = ranked.slice(0, limit).map(([id]) => id);
  const entries = await hydrate(window);
  const tracks = window.map((id) => entries.get(id)).filter(Boolean)
    .map((entry) => napstrTrack(entry, live.get(entry.fileId).size, gateways));
  const seeding = new Set([...live.values()].flatMap((set) => [...set])).size;
  return { tracks, offered: live.size, seeding };
}

/** Search the catalogue by `t` words (as Napstr indexes them), live entries first. */
export async function searchLive(query, { gateways } = {}) {
  const words = [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w)))].slice(0, 8);
  if (!words.length) return { tracks: [], offered: 0, seeding: 0 };
  const [found, heartbeats] = await Promise.all([
    queryEvents([{ kinds: [KIND_CATALOGUE], '#t': words, limit: 200 }]),
    queryEvents([{ kinds: [KIND_AVAILABILITY], '#t': [TAG_AVAILABILITY], limit: 500 }]),
  ]);
  const live = liveSeeders(heartbeats);
  const entries = [...latestEntries(found).values()];
  const q = words;
  const scored = entries.map((entry) => {
    const hay = `${entry.title} ${entry.artist} ${entry.album} ${entry.filename}`.toLowerCase();
    const hits = q.filter((w) => hay.includes(w)).length;
    return { entry, hits, seeders: (live.get(entry.fileId) || new Set()).size };
  }).filter((s) => s.hits > 0)
    .sort((a, b) => b.seeders - a.seeders || b.hits - a.hits || a.entry.title.localeCompare(b.entry.title));
  return {
    tracks: scored.map((s) => napstrTrack(s.entry, s.seeders, gateways)),
    offered: live.size,
    seeding: new Set([...live.values()].flatMap((set) => [...set])).size,
  };
}
