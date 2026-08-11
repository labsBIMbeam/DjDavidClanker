import { fetchBlob } from '../lib/nap.js';
import { detectBpm, detectKey, analyzeStructure } from './analyze.js';
import { trackCacheId, getAnalysis, putAnalysis } from '../lib/analysiscache.js';

/**
 * Background pre-analysis of upcoming queue tracks, so the smart selection
 * has data to choose on BEFORE a track ever hits a deck.
 *
 * Strictly sequential — one decode in memory at a time (a 6-minute stereo
 * decode is ~60 MB transient on top of two loaded decks), and it stands down
 * whenever a deck is actively loading. Failures are remembered so a broken
 * stream cannot spin the loop.
 */
export function createPreanalyzer(mixer, automix) {
  let running = false;
  const failed = new Set();

  const findNext = () => {
    for (let i = 0; i < 4; i++) {
      const t = automix.queue[automix.cursor + i];
      if (!t) break;
      const id = trackCacheId(t);
      if (!id || failed.has(id) || getAnalysis(id)) continue;
      if (!t.localFile && !(t.streamUrls && t.streamUrls.length)) continue;
      return t;
    }
    return null;
  };

  async function pump(force = false) {
    if (running) return;
    if (automix.order !== 'smart' || (!automix.enabled && !force)) return;
    running = true;
    try {
      for (;;) {
        if (automix.order !== 'smart' || (!automix.enabled && !force)) break;
        const decks = mixer.decks;
        if (decks.A.status === 'loading' || decks.B.status === 'loading') break;
        const track = findNext();
        if (!track) break;
        const id = trackCacheId(track);
        try {
          const ab = track.localFile
            ? await track.localFile.arrayBuffer()
            : await (await fetchBlob(track.streamUrls[0], { proxy: mixer.proxy })).arrayBuffer();
          mixer.ensureContext();
          let buffer = await mixer.ctx.decodeAudioData(ab);
          const res = await detectBpm(buffer);
          const key = await detectKey(buffer);
          const st = await analyzeStructure(buffer, {
            bpm: res.bpm, beatOffset: res.beatOffset, barOffset: res.barOffset,
          });
          buffer = null; // one decode at a time — release before the next loop
          if (!(res.bpm > 0)) {
            failed.add(id);
            continue;
          }
          putAnalysis(id, {
            v: 1,
            bpm: res.bpm,
            cf: res.confidence,
            bo: res.beatOffset,
            ro: res.barOffset,
            ld: 0,
            k: key.pitchClass >= 0
              ? [key.pitchClass, key.mode === 'major' ? 0 : 1, key.confidence] : null,
            s: st && st.ok
              ? { pb: st.phraseBars, po: st.phraseOffset, mi: st.mixInSec, mo: st.mixOutSec,
                ei: st.energyIn, eo: st.energyOut, sc: st.confidence }
              : null,
          });
        } catch {
          failed.add(id);
        }
      }
    } finally {
      running = false;
    }
  }

  return { poke: pump };
}
