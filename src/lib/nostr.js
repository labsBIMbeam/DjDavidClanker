/**
 * Nostr side: reading kind-30003 sets as crates, and publishing a setlist
 * back after a mix.
 *
 * Wavlake tracks are not Nostr events, so the carrier is `r` tags holding
 * wavlake.com URLs — the same convention other Nostr music clients use. Any
 * `r` tag containing a UUID is treated as a Wavlake content id.
 */

import { queryEvents, publishEvent, getPublicKey } from './nap.js';
import { npubToHex } from './bech32.js';
import { trackById, albumTracks, UUID_RE } from './wavlake.js';

export const KIND_BOOKMARK_SET = 30003;
export const KIND_GENERIC_SET = 30078; // app-specific data, used for our own crates

const tagValue = (ev, name) => {
  const t = (ev.tags || []).find((x) => x[0] === name);
  return t ? t[1] : '';
};

/** Every wavlake content id referenced by an event, in tag order. */
function extractWavlakeIds(ev) {
  const ids = [];
  for (const t of ev.tags || []) {
    if (t[0] !== 'r' && t[0] !== 'i' && t[0] !== 'u') continue;
    const v = t[1] || '';
    if (!/wavlake/i.test(v)) continue;
    const m = v.match(UUID_RE);
    if (m && !ids.includes(m[0])) ids.push(m[0]);
  }
  return ids;
}

/**
 * Load kind-30003 sets for a pubkey (defaults to the signed-in user) that
 * reference at least one Wavlake item.
 */
export async function loadPlaylists(pubkeyOrNpub) {
  const hex = pubkeyOrNpub ? npubToHex(pubkeyOrNpub) : await getPublicKey();
  if (!hex) return [];
  const events = await queryEvents([{ kinds: [KIND_BOOKMARK_SET, KIND_GENERIC_SET], authors: [hex], limit: 100 }]);

  // Addressable events: keep only the newest per `d` tag.
  const byD = new Map();
  for (const ev of events) {
    const d = tagValue(ev, 'd');
    const prev = byD.get(d);
    if (!prev || ev.created_at > prev.created_at) byD.set(d, ev);
  }

  return [...byD.values()]
    .map((ev) => ({
      id: ev.id,
      d: tagValue(ev, 'd'),
      title: tagValue(ev, 'title') || tagValue(ev, 'name') || tagValue(ev, 'd') || 'Untitled set',
      description: tagValue(ev, 'description'),
      image: tagValue(ev, 'image'),
      createdAt: ev.created_at,
      trackIds: extractWavlakeIds(ev),
      kind: ev.kind,
    }))
    .filter((p) => p.trackIds.length)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Resolve a playlist's track ids into full track objects (bounded concurrency). */
export async function resolvePlaylist(playlist, { concurrency = 5 } = {}) {
  const ids = playlist.trackIds.slice(0, 200);
  const out = new Array(ids.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      try {
        out[i] = await trackById(ids[i]);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

  // An id that is not a track may well be an album — expand it in place.
  const resolved = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]) {
      resolved.push(out[i]);
      continue;
    }
    try {
      const tracks = await albumTracks(ids[i]);
      resolved.push(...tracks);
    } catch {
      /* skip unresolvable id */
    }
  }
  return resolved;
}

/**
 * Publish the session's play history as a kind-30003 set.
 * The shell signs; the napplet never sees a key.
 */
export async function publishSetlist(tracks, { title, description } = {}) {
  if (!tracks.length) throw new Error('Setlist is empty');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const tags = [
    ['d', `dj-david-clanker-${stamp}`],
    ['title', title || `DJ David Clanker Set ${stamp}`],
    ['client', 'dj-david-clanker'],
    ['t', 'wavlake'],
    ['t', 'djset'],
  ];
  if (description) tags.push(['description', description]);
  for (const t of tracks) tags.push(['r', t.pageUrl, t.title ? `${t.artist} – ${t.title}` : '']);

  const content = tracks.map((t, i) => `${i + 1}. ${t.artist} – ${t.title}`).join('\n');
  return publishEvent({
    kind: KIND_BOOKMARK_SET,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });
}
