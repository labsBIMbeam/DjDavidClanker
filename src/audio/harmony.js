/**
 * Harmonic mixing — remembering keys, and choosing what goes next.
 *
 * These decks pitch-shift by resampling. There is no key lock, so the key a
 * track sounds in is decided by the speed the beat-match asks for, and moving
 * a key by a semitone costs about 6 % tempo. That makes "retune the track into
 * key" mostly a lie: the honest way to avoid an out-of-tune mix is to *play a
 * track that fits*, decided before it is loaded rather than fixed afterwards.
 *
 * Which needs the key of tracks that are not loaded yet — hence this cache.
 * Every analysis a deck finishes is remembered against the track id, so the
 * second time a library is played the whole queue is scored before anything is
 * touched. The first pass through an unheard list still has to guess, and says
 * so: an unknown key scores `null`, never a bad score, because refusing to
 * play tracks purely for being unheard would empty the crate.
 */

import { rateCandidate } from './key.js';
import { store } from '../lib/nap.js';

const STORE_KEY = 'keycache.v1';

/** Oldest entries are dropped past this. Roughly a large personal library. */
const LIMIT = 2000;

/**
 * What an unknown key is worth when ranking candidates.
 *
 * Above a two-steps-apart clash (0.45) and below an adjacent-on-the-wheel
 * match (0.8): a track we have never analysed is preferred over one we know
 * clashes, and passed over for one we know fits.
 */
export const UNKNOWN_SCORE = 0.55;

/** Remembered analysis, keyed by track id and persisted across sessions. */
export class TrackKeys {
  constructor() {
    /** @type {Map<string, {bpm:number, key:object|null, at:number}>} */
    this.map = new Map();
    this._dirty = false;
    this._saveTimer = null;
  }

  async load() {
    try {
      const raw = await store.getJson(STORE_KEY, null);
      if (!raw || !Array.isArray(raw.entries)) return this;
      for (const e of raw.entries) {
        // Stored flat — [id, bpm, pitchClass, minor, confidence, when] — because
        // a couple of thousand of these as objects is a lot of JSON for what is
        // six numbers a piece.
        const [id, bpm, pc, minor, confidence, at] = e;
        if (typeof id !== 'string') continue;
        this.map.set(id, {
          bpm: bpm || 0,
          key: pc == null ? null : keyFromParts(pc, Boolean(minor), confidence || 0),
          at: at || 0,
        });
      }
    } catch {
      /* a corrupt cache is not worth failing a set over */
    }
    return this;
  }

  get(id) {
    return (id && this.map.get(id)) || null;
  }

  get size() {
    return this.map.size;
  }

  /**
   * Record what a deck found. Called for BPM and again for key, so a partial
   * entry must never wipe a fuller one — only fill in what it actually has.
   */
  remember(track, { bpm = 0, key = null } = {}) {
    if (!track || !track.id) return;
    const prev = this.map.get(track.id);
    const next = {
      bpm: bpm || (prev && prev.bpm) || 0,
      key: key || (prev && prev.key) || null,
      at: Date.now(),
    };
    if (prev && prev.bpm === next.bpm && sameKey(prev.key, next.key)) return;
    this.map.set(track.id, next);
    this._queueSave();
  }

  forget(id) {
    if (this.map.delete(id)) this._queueSave();
  }

  _queueSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    // Analysis lands in bursts as tracks load; one write per burst is plenty.
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, 4000);
  }

  async save() {
    if (!this._dirty) return;
    this._dirty = false;
    let entries = [...this.map.entries()];
    if (entries.length > LIMIT) {
      entries.sort((a, b) => b[1].at - a[1].at);
      entries = entries.slice(0, LIMIT);
      this.map = new Map(entries);
    }
    const flat = entries.map(([id, v]) => [
      id,
      Math.round((v.bpm || 0) * 100) / 100,
      v.key ? v.key.pc : null,
      v.key && v.key.minor ? 1 : 0,
      v.key ? Math.round(v.key.confidence * 100) / 100 : 0,
      v.at,
    ]);
    try {
      await store.setJson(STORE_KEY, { entries: flat });
    } catch {
      /* storage full or unavailable — the cache is an optimisation, not state */
    }
  }
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/** Rebuild the full key object detectKey returns from the stored numbers. */
function keyFromParts(pc, minor, confidence) {
  return {
    pc,
    minor,
    name: `${NAMES[pc]} ${minor ? 'min' : 'maj'}`,
    camelot: (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pc],
    confidence,
  };
}

function sameKey(a, b) {
  if (!a || !b) return a === b;
  return a.pc === b.pc && a.minor === b.minor;
}

/**
 * Pick which of the upcoming queue entries should go next.
 *
 * Deliberately conservative. A queue is a running order, not a suggestion, so
 * a track is only jumped over for a clear harmonic gain, only within a short
 * look-ahead, and never more than `maxDefer` times running — otherwise a track
 * in an unlucky key would sit at the head of the list all night and never play.
 *
 * @param {Array} queue          the full queue
 * @param {number} from          index of the next track in running order
 * @param {object} o
 * @param {object|null} o.liveKey  sounding key of the deck about to be mixed out
 * @param {number} o.liveBpm       its effective BPM
 * @param {TrackKeys} o.keys
 * @param {string} [o.excludeId] track that must not be chosen — normally the
 *   one already live. Reordering a short queue can otherwise wrap round and
 *   pick the record that is playing, which plain list order never could.
 * @param {Map<string,number>} [o.deferrals] mutated: how often each id was passed
 * @returns {{index:number, score:number|null, relation:string}}
 */
export function pickNextIndex(queue, from, {
  liveKey,
  liveBpm = 0,
  keys,
  excludeId = '',
  tempoRange = 50,
  window = 6,
  minGain = 0.2,
  maxDefer = 2,
  deferrals = null,
} = {}) {
  const head = { index: from, score: null, relation: 'not considered' };
  if (!keys || !liveKey || from >= queue.length) return head;

  const end = Math.min(queue.length, from + Math.max(1, window));
  const headIsLive = Boolean(excludeId) && queue[from] && queue[from].id === excludeId;
  let best = null;
  // A head that is the live track loses to anything at all, and is not owed a
  // deferral count either — it is not being passed over, it is being avoided.
  let headScore = headIsLive ? -Infinity : UNKNOWN_SCORE;

  for (let i = from; i < end; i++) {
    const track = queue[i];
    if (!track) continue;
    if (excludeId && track.id === excludeId) continue;
    const r = rateCandidate(liveKey, liveBpm, keys.get(track.id), { tempoRange });
    const score = r.score == null ? UNKNOWN_SCORE : r.score;
    if (i === from) {
      headScore = score;
      head.score = r.score;
      head.relation = r.relation;
    }
    if (!best || score > best.score) best = { index: i, score, relation: r.relation };
  }

  if (!best || best.index === from) return head;
  if (!headIsLive && best.score - headScore < minGain) return head;
  if (headIsLive) return best;

  // A track that keeps getting passed over is played anyway. Better a single
  // clashing handover — which the transition choice will keep short — than a
  // track that silently never comes up.
  const headId = queue[from] && queue[from].id;
  if (deferrals && headId) {
    const n = (deferrals.get(headId) || 0) + 1;
    if (n > maxDefer) return head;
    deferrals.set(headId, n);
  }
  return best;
}
