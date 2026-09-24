/** Proposed music/open convention. See docs/napplet/conventions/music-open.md. */
import { inc } from '@napplet/sdk';
import { has } from './nap.js';

export const MUSIC_OPEN = 'napplet:music/open';

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('Invalid music/open object');
  }
}

function text(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error('Invalid music/open text');
  }
  return value;
}

function httpsUrl(value) {
  const url = new URL(text(value, 4096));
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('#')
    || url.href.length > 4096) {
    throw new Error('Music references must be HTTPS URLs without credentials or fragments');
  }
  return url.href;
}

/** Validate the complete request before any queue mutation or resource fetch. */
export function musicTracks(payload) {
  if (payload === undefined) return [];
  record(payload, ['version', 'tracks']);
  if (Object.keys(payload).length === 0) return [];
  if (payload.version !== 1 || !Array.isArray(payload.tracks) || payload.tracks.length > 100) {
    throw new Error('music/open requires version 1 and at most 100 tracks');
  }
  return Array.from(payload.tracks, (track) => {
    record(track, ['url', 'title', 'artist', 'artwork']);
    return {
      url: httpsUrl(track.url),
      title: text(track.title, 200),
      ...(track.artist === undefined ? {} : { artist: text(track.artist, 200) }),
      ...(track.artwork === undefined ? {} : { artwork: httpsUrl(track.artwork) }),
    };
  });
}

/** Append a music selection without changing transport or the existing queue. */
export function receiveMusicOpen(payload, queue) {
  const tracks = musicTracks(payload).map((track) => ({
    id: `music:${track.url}`,
    title: track.title,
    artist: track.artist || '',
    artworkUrl: track.artwork || '',
    streamUrls: [track.url],
    pageUrl: track.url,
    source: 'music',
  }));
  return tracks.reduce((added, track) => added + Number(queue.append(track)), 0);
}

/** Receive the convention through the injected host API, never sibling frames. */
export function installMusicReceiver(queue, { onAccepted, onError } = {}) {
  if (!has('inc')) return null;
  return inc.on(MUSIC_OPEN, (event) => {
    if (event?.topic !== MUSIC_OPEN || typeof event.sender !== 'string' || !event.sender) return;
    try {
      const count = receiveMusicOpen(event.payload, queue);
      onAccepted?.(count);
    } catch (error) {
      onError?.(error);
    }
  });
}
