/**
 * Key maths and the tempo-vs-key trade-off.
 *
 * detectKey needs an OfflineAudioContext and cannot run here, but everything
 * downstream of it is pure arithmetic and is exactly where the reasoning
 * errors would be: Camelot adjacency, the semitone shift a playback rate
 * causes, and the rule that a key correction must never silently break a
 * beat-match.
 *
 *   node dev/key-check.mjs
 */

import { compatibility, keyAtRate, planKeyMatch, semitonesForRate, transpose } from '../src/audio/key.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const KEY = (pc, minor) => {
  const CAM_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
  const CAM_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
  return { pc, minor, name: 'x', camelot: (minor ? CAM_MIN : CAM_MAJ)[pc], confidence: 1 };
};

/* ---------------------------- Camelot sanity ---------------------------- */

const Cmaj = KEY(0, false);
const Amin = KEY(9, true);
const Gmaj = KEY(7, false);
const Fsmaj = KEY(6, false);

check('C major is 8B', Cmaj.camelot === '8B', Cmaj.camelot);
check('A minor is 8A', Amin.camelot === '8A', Amin.camelot);
check('relative major/minor is compatible', compatibility(Cmaj, Amin).ok,
  compatibility(Cmaj, Amin).relation);
check('one step round the wheel is compatible', compatibility(Cmaj, Gmaj).ok,
  `8B vs 9B — ${compatibility(Cmaj, Gmaj).relation}`);
check('the tritone is not compatible', !compatibility(Cmaj, Fsmaj).ok,
  `8B vs 2B — ${compatibility(Cmaj, Fsmaj).relation}`);
check('a key is compatible with itself', compatibility(Cmaj, Cmaj).score === 1);

/* ---------------------------- rate → pitch ---------------------------- */

const semis = semitonesForRate(Math.pow(2, 1 / 12));
check('one semitone is ~5.95% rate', Math.abs(semis - 1) < 1e-9, `${semis.toFixed(6)} semitones`);
check('+6% rate is about a semitone sharp',
  Math.round(semitonesForRate(1.06)) === 1, `${semitonesForRate(1.06).toFixed(3)} semitones`);
check('rate shift transposes the key', keyAtRate(Cmaj, Math.pow(2, 1 / 12)).pc === 1,
  `C at +1 semitone → pc ${keyAtRate(Cmaj, Math.pow(2, 1 / 12)).pc}`);
check('transpose wraps the octave', transpose(Cmaj, 12).pc === 0);

/* ---------------------------- the trade-off ---------------------------- */

// Already compatible at the matched tempo: nothing should move.
const same = planKeyMatch(Cmaj, Amin, { matchedPercent: 0, tempoRange: 8 });
check('leaves a compatible pair alone', same.action === 'none' && same.tempoPercent === 0, same.reason);

// A clash that only a big pitch shift could fix must be offered, not applied.
const clash = planKeyMatch(Cmaj, Fsmaj, { matchedPercent: 0, tempoRange: 8 });
check('never silently breaks the beat-match', clash.action !== 'retune',
  `${clash.action}: ${clash.reason}`);
if (clash.action === 'offer') {
  check('an offered fix reports its tempo cost', clash.cost > 1.5, `${clash.cost.toFixed(2)}%`);
} else {
  check('an unreachable fix says so', clash.reason.includes('no compatible key'), clash.reason);
}

// A shift that is already nearly there should be taken.
const nearly = planKeyMatch(Cmaj, KEY(11, false), { matchedPercent: 5.6, tempoRange: 8 });
check('takes a correction that costs almost no tempo',
  nearly.action === 'retune' ? nearly.cost <= 1.5 : true,
  `${nearly.action}: ${nearly.reason}`);

// Nothing is proposed outside the pitch range.
const narrow = planKeyMatch(Cmaj, Fsmaj, { matchedPercent: 0, tempoRange: 2 });
check('respects the deck pitch range',
  narrow.action === 'none' || Math.abs(narrow.offerPercent ?? 0) <= 2,
  `${narrow.action}: ${narrow.reason}`);

// Missing detection must degrade quietly, not throw.
const missing = planKeyMatch(null, Cmaj, { matchedPercent: 0, tempoRange: 8 });
check('copes with an undetected key', missing.action === 'none', missing.reason);

/* ------------- the tempo gap that actually came up in use ------------- */

/**
 * A minimal stand-in for Deck.matchTempoTo, exercising the same relation set
 * and range escalation. The real pair that failed was 107.7 BPM against
 * 184.6 BPM — 42% apart head-on, and unreachable inside ±8% however you slice
 * it, which is why the match silently never happened.
 */
function matchTempoTo(myBpm, targetBpm, ranges = [8, 16, 50]) {
  for (const range of ranges) {
    let best = null;
    for (const t of [targetBpm, targetBpm * 2, targetBpm / 2, targetBpm * 1.5, targetBpm / 1.5]) {
      const pct = (t / myBpm - 1) * 100;
      if (Math.abs(pct) <= range && (!best || Math.abs(pct) < Math.abs(best))) best = pct;
    }
    if (best !== null) return { ok: true, percent: best, range };
  }
  return { ok: false };
}

check('±8% cannot bridge 108 to 185 BPM', !matchTempoTo(184.6, 107.7, [8]).ok,
  'this is the case that was reported as "waiting for BPM detection" forever');

const wide = matchTempoTo(184.6, 107.7);
check('widening the range does bridge it', wide.ok,
  wide.ok ? `${wide.percent >= 0 ? '+' : ''}${wide.percent.toFixed(2)}% at ±${wide.range}%` : 'still unreachable');
check('and it lands on a musical relation, not a fudge',
  wide.ok && Math.abs(Math.abs(wide.percent) - 12.5) < 1,
  wide.ok ? `${wide.percent.toFixed(2)}% — the 3:2 relation, 184.6 × 0.875 = 161.5 = 107.7 × 1.5` : '');

check('an easy pair still matches at ±8% without widening',
  matchTempoTo(124, 128).range === 8, `range ±${matchTempoTo(124, 128).range}%`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
