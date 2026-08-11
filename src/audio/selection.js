import { getAnalysis, trackCacheId } from '../lib/analysiscache.js';
import { camelotFor } from './analyze.js';

/**
 * Smart track selection — pure scoring, no side effects.
 *
 * A good DJ picks the next track for continuity: harmonically compatible
 * (Camelot neighbours), tempo within reach of the pitch fader (after octave
 * folding), and an energy level that carries the room. Unknown values score
 * neutral, so a cold cache degrades exactly to list order.
 */

const parseCamelot = (c) => {
  const m = /^(\d{1,2})(A|B)$/.exec(c || '');
  return m ? { num: parseInt(m[1], 10), letter: m[2] } : null;
};

/** 1.0 same key · 0.9 neighbour · 0.85 relative · 0.4 two steps · 0.2 far. */
export function camelotScore(a, b) {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 0.6; // unknown — neutral, never disqualifying
  const dist = Math.min(Math.abs(ka.num - kb.num), 12 - Math.abs(ka.num - kb.num));
  if (dist === 0) return ka.letter === kb.letter ? 1 : 0.85; // same or relative
  if (ka.letter !== kb.letter) return 0.3; // wheel jump AND mode change
  if (dist === 1) return 0.9;
  if (dist === 2) return 0.4;
  return 0.2;
}

/** Best pitch-fader fit over the sync folds; 1 at 0%, 0 at/beyond the range. */
export function bpmFoldScore(liveBpm, candBpm, range = 8) {
  if (!(liveBpm > 0) || !(candBpm > 0)) return 0.5;
  let best = Infinity;
  for (const t of [liveBpm, liveBpm * 2, liveBpm / 2, liveBpm * 1.5, liveBpm / 1.5]) {
    best = Math.min(best, Math.abs((t / candBpm - 1) * 100));
  }
  return Math.max(0, 1 - best / Math.max(1, range));
}

/** How well the candidate's mix-in energy continues the current mix-out. */
export function energyScore(liveOut, candIn) {
  if (!Number.isFinite(liveOut) || !Number.isFinite(candIn)) return 0.7;
  return 1 - Math.min(1, Math.abs(candIn - liveOut));
}

/** Cached-analysis summary for a track, or null. */
export function summaryFor(track) {
  const e = getAnalysis(trackCacheId(track));
  if (!e) return null;
  return {
    bpm: e.bpm,
    camelot: e.k && e.k[0] >= 0 ? camelotFor(e.k[0], e.k[1] === 0 ? 'major' : 'minor') : '',
    energyIn: e.s ? e.s.ei : NaN,
    energyOut: e.s ? e.s.eo : NaN,
  };
}

/**
 * Score a candidate against the live deck. `liveSummary` needs {bpm, camelot,
 * energyOut}; candidates without cached analysis get the neutral priors.
 */
export function scoreCandidate(liveSummary, candSummary, recentIds, candId) {
  const bpm = bpmFoldScore(liveSummary.bpm, candSummary ? candSummary.bpm : 0);
  const key = camelotScore(liveSummary.camelot, candSummary ? candSummary.camelot : '');
  const energy = energyScore(liveSummary.energyOut, candSummary ? candSummary.energyIn : NaN);
  const recency = recentIds.includes(candId) ? 0.25 : 0;
  return 0.4 * bpm + 0.3 * key + 0.2 * energy + 0.1 - recency;
}
