/**
 * The setlist — the DJ's own ordered crate, one level ABOVE the sources.
 *
 * A setlist entry is a normalized track plus its performance marks: the cue
 * point and the four hot cues, in track seconds. Marks ride along with the
 * list: setting a hot cue on a loaded setlist track writes it back here
 * (debounced persist), loading a setlist track restores its marks onto the
 * deck. One storage blob (`setlist.v1`) — the sdk storage cannot enumerate
 * keys, same design as the analysis cache.
 */

import { store } from './nap.js';

const KEY = 'setlist.v1';
const EMPTY_CUES = () => ({ cue: 0, hot: [null, null, null, null] });

let data = { name: 'My Set', tracks: [] };
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.setJson(KEY, data).catch(() => {}), 800);
}

export async function initSetlist() {
  const stored = await store.getJson(KEY, null);
  if (stored && Array.isArray(stored.tracks)) data = stored;
}

export const setlist = {
  get name() { return data.name; },
  set name(v) { data.name = String(v || 'My Set'); persist(); },
  get tracks() { return data.tracks; },

  has(id) {
    return Boolean(id) && data.tracks.some((t) => t.id === id);
  },

  /** Add a track (with the deck's current marks when it is loaded). */
  add(track, cues) {
    if (!track || !track.id || this.has(track.id)) return false;
    data.tracks.push({ ...track, cues: cues || EMPTY_CUES() });
    persist();
    return true;
  },

  remove(id) {
    const i = data.tracks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    data.tracks.splice(i, 1);
    persist();
    return true;
  },

  /** Move an entry up (-1) or down (+1) in the running order. */
  move(id, dir) {
    const i = data.tracks.findIndex((t) => t.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= data.tracks.length) return false;
    const [t] = data.tracks.splice(i, 1);
    data.tracks.splice(j, 0, t);
    persist();
    return true;
  },

  cuesFor(id) {
    const t = data.tracks.find((x) => x.id === id);
    return t ? t.cues || EMPTY_CUES() : null;
  },

  /** Live write-back: the deck's marks changed while its track is listed. */
  updateCues(id, cues) {
    const t = data.tracks.find((x) => x.id === id);
    if (!t) return false;
    t.cues = { cue: cues.cue || 0, hot: [...(cues.hot || EMPTY_CUES().hot)] };
    persist();
    return true;
  },
};
