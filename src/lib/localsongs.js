/**
 * The local-song catalog — every file the DJ ever imported, as METADATA.
 *
 * The honest limit: a sandboxed napplet cannot persist File handles, so the
 * bytes themselves are gone after a reload. What survives (blob
 * `localsongs.v1`) is the catalog — name, size, title, artist, duration —
 * and a fresh 📁 import re-arms an entry the moment name+size match again.
 * The permanent path for audio stays the ingest service (⤴ into the crate).
 */

import { store } from './nap.js';

const KEY = 'localsongs.v1';

let data = { songs: [] };
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.setJson(KEY, data).catch(() => {}), 800);
}

export async function initLocalSongs() {
  const stored = await store.getJson(KEY, null);
  if (stored && Array.isArray(stored.songs)) data = stored;
}

export const localSongs = {
  get all() { return data.songs; },

  /** Remember an imported file (dedupe by name+size). */
  remember(track) {
    const f = track && track.localFile;
    if (!f) return;
    const hit = data.songs.find((s) => s.name === f.name && s.size === f.size);
    if (hit) {
      if (track.duration && !hit.duration) hit.duration = track.duration;
    } else {
      data.songs.push({
        name: f.name,
        size: f.size,
        title: track.title,
        artist: track.artist,
        duration: track.duration || 0,
      });
    }
    persist();
  },

  forget(name, size) {
    const i = data.songs.findIndex((s) => s.name === name && s.size === size);
    if (i < 0) return false;
    data.songs.splice(i, 1);
    persist();
    return true;
  },
};
