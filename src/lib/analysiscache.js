import { store } from './nap.js';

/**
 * Persistent per-track analysis cache (BPM, grid, key, structure summary).
 *
 * `sdk.storage` is plain string key/value with no key enumeration, so the
 * whole cache is ONE JSON blob under one key with the LRU order encoded in
 * entry order. ~150 entries at ~450 bytes each keeps us near 70 KB of the
 * 512 KB quota, alongside crate.v1 and settings.v1.
 *
 * Reads are synchronous against a memory mirror (the UI needs that); writes
 * are debounced so batch pre-analysis does not hammer the storage bridge.
 */

const KEY = 'analysis.v1';
const VERSION = 1;
const MAX_ENTRIES = 150;
const WRITE_DELAY = 2000;

let mem = new Map();
let writeTimer = 0;

/** Stable cache id: Wavlake track id, or name+size for a local file. */
export function trackCacheId(track) {
  if (!track) return '';
  if (track.localFile) return `local:${track.localFile.name}:${track.localFile.size}`;
  return track.id || '';
}

/** Load the blob into the memory mirror. Call once at boot; safe to forget. */
export async function initCache() {
  const blob = await store.getJson(KEY, null);
  if (blob && blob.v === VERSION && Array.isArray(blob.e)) {
    mem = new Map(blob.e);
  }
}

/** Synchronous lookup; a hit is bumped to most-recently-used. */
export function getAnalysis(id) {
  const entry = id ? mem.get(id) : null;
  if (entry) {
    mem.delete(id);
    mem.set(id, entry);
  }
  return entry || null;
}

export function putAnalysis(id, entry) {
  if (!id || !entry) return;
  mem.delete(id);
  mem.set(id, entry);
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    store.setJson(KEY, { v: VERSION, e: [...mem.entries()] });
  }, WRITE_DELAY);
}

/** How many tracks are cached — for UI hints and tests. */
export function cacheSize() {
  return mem.size;
}
