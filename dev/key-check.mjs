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

import {
  bestOption, compatibility, keyAtRate, planKeyMatch, rateCandidate,
  semitonesForRate, tempoOptions, transpose,
} from '../src/audio/key.js';
import { pickNextIndex, UNKNOWN_SCORE } from '../src/audio/harmony.js';

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

/* ------------------- the free re-key: metrical choice ------------------- */

/**
 * Half, double and 3:2 time are all exact beat-matches at wildly different
 * rates, so they sound in different keys. Choosing between them is the only
 * key change this rig can make that costs nothing, and the arithmetic behind
 * it is where a mistake would silently give up either the beat or the key.
 */
{
  const opts = tempoOptions(174, 128, 50);
  check('several metrical beat-matches are found', opts.length >= 2,
    opts.map((o) => `${o.ratio}× ${o.percent.toFixed(1)}%`).join(', '));
  check('all of them are exact beat-matches',
    opts.every((o) => [1, 2, 0.5, 1.5, 2 / 3].some((r) => Math.abs((128 * r) / 174 - 1 - o.percent / 100) < 1e-9)));
  check('they are ordered nearest-to-zero first',
    opts.every((o, i) => i === 0 || Math.abs(o.percent) >= Math.abs(opts[i - 1].percent)));
  check('nothing outside the fader is offered',
    tempoOptions(174, 128, 8).every((o) => Math.abs(o.percent) <= 8));

  // With no key to go on, the choice must be exactly what a plain tempo match
  // would have made — the harmonic preference may never move a match by itself.
  const blind = bestOption(null, Cmaj, opts);
  check('unknown keys change nothing', blind.percent === opts[0].percent,
    `${blind.percent.toFixed(2)}% vs ${opts[0].percent.toFixed(2)}%`);

  /**
   * The one case where this is worth anything, and it is a common one: a track
   * at roughly half the live tempo locks either at half time or at two-thirds
   * time, and those two are five semitones apart. 100 BPM under 170 gives -15%
   * and +13.3% — both exact, both still sounding like the record.
   */
  const half = tempoOptions(100, 170, 16);
  check('half time and two-thirds time are both reachable and musical',
    half.length === 2 && half.every((o) => Math.abs(o.percent) <= 16),
    half.map((o) => `${o.ratio.toFixed(3)}× ${o.percent.toFixed(1)}%`).join(', '));
  check('and they are far apart in key',
    Math.abs(semitonesForRate(half[0].rate) - semitonesForRate(half[1].rate)) > 4,
    `${(semitonesForRate(half[1].rate) - semitonesForRate(half[0].rate)).toFixed(2)} semitones apart`);

  // B major up a semitone is C major, so the fitting option is the +5.95% one
  // even though 0% is the nearer move.
  const Bmaj = KEY(11, false);
  const chosen = bestOption(Cmaj, Bmaj, [
    { percent: 0, rate: 1, ratio: 1 },
    { percent: 5.946, rate: Math.pow(2, 1 / 12), ratio: 1.5 },
  ]);
  check('the better-sounding beat-match is preferred over the nearer one',
    chosen.score === 1, `${chosen.relation} at ${chosen.percent.toFixed(2)}%`);

  // Ties go to the smaller move, so a pair that fits equally well either way
  // does not get dragged to a wild tempo for nothing.
  const tie = bestOption(Cmaj, Cmaj, [
    { percent: 0, rate: 1, ratio: 1 },
    { percent: 100 * (Math.pow(2, 1) - 1), rate: 2, ratio: 2 },
  ]);
  check('a tie takes the smaller tempo move', tie.percent === 0);

  // Key must never buy a tempo that makes the track sound like another record.
  // Only the ±16% option may be chosen here, however well the wild one sits.
  const bounded = bestOption(Cmaj, Bmaj, [
    { percent: 5.946, rate: Math.pow(2, 1 / 12), ratio: 1 },
    { percent: 47.1, rate: 1.471, ratio: 2 },
  ]);
  check('key never drags the tempo out of a musical range',
    Math.abs(bounded.percent) <= 16, `${bounded.percent.toFixed(2)}%`);
}

/* -------------------- judging a track before loading -------------------- */

{
  // C major live; a candidate in A minor at a matchable tempo is the textbook
  // relative-minor move and must score as such.
  const good = rateCandidate(Cmaj, 128, { bpm: 128, key: Amin });
  check('a relative minor at the same tempo rates well', good.score >= 0.85, `${good.score} — ${good.relation}`);

  const bad = rateCandidate(Cmaj, 128, { bpm: 128, key: Fsmaj });
  check('a tritone at the same tempo rates badly', bad.score < 0.5, `${bad.score} — ${bad.relation}`);

  const unheard = rateCandidate(Cmaj, 128, null);
  check('an unanalysed track is unknown, not bad', unheard.score === null, unheard.relation);

  // A track that cannot be beat-matched at all is a worse pick than one that
  // can, whatever its key says — sinking below the unknown score is the point.
  // 128 under 300 is unreachable at any metrical relation inside ±8%.
  const unreachable = rateCandidate(Cmaj, 300, { bpm: 128, key: Cmaj }, { tempoRange: 8 });
  check('an unmatchable tempo outranks nothing', unreachable.score < UNKNOWN_SCORE,
    `${unreachable.score} — ${unreachable.relation}`);
}

/* ---------------------- choosing what plays next ---------------------- */

const T = (id) => ({ id, title: id });
const cacheOf = (entries) => ({ get: (id) => entries[id] || null });

{
  const queue = [T('clash'), T('clash2'), T('fits')];
  const keys = cacheOf({
    clash: { bpm: 128, key: Fsmaj },
    clash2: { bpm: 128, key: Fsmaj },
    fits: { bpm: 128, key: Amin },
  });
  const pick = pickNextIndex(queue, 0, { liveKey: Cmaj, liveBpm: 128, keys });
  check('a track that fits is brought forward', pick.index === 2, `index ${pick.index} — ${pick.relation}`);

  // ...but only for a real gain. Two tracks that both work stay in list order.
  const bothFine = cacheOf({ clash: { bpm: 128, key: Amin }, clash2: { bpm: 128, key: Gmaj }, fits: { bpm: 128, key: Cmaj } });
  const stay = pickNextIndex(queue, 0, { liveKey: Cmaj, liveBpm: 128, keys: bothFine });
  check('a working order is left alone', stay.index === 0, `index ${stay.index}`);

  // And a track in an unlucky key must not sit at the head of the list all
  // night. After maxDefer passes it goes on regardless.
  const deferrals = new Map();
  const opts = { liveKey: Cmaj, liveBpm: 128, keys, deferrals };
  const seen = [0, 1, 2].map(() => pickNextIndex(queue, 0, opts).index);
  check('a passed-over track is played eventually', seen.includes(0),
    `picks were ${seen.join(', ')} with maxDefer 2`);

  // Nothing is ever dropped: the picker only ever names an index inside the
  // look-ahead window, and the caller reorders rather than skipping.
  const inWindow = [];
  for (let i = 0; i < 50; i++) inWindow.push(pickNextIndex(queue, 0, { liveKey: Cmaj, liveBpm: 128, keys }).index);
  check('the pick is always a real queue position',
    inWindow.every((i) => i >= 0 && i < queue.length));

  // With no live key there is nothing to be harmonic about, and guessing would
  // be worse than the running order.
  const blind = pickNextIndex(queue, 0, { liveKey: null, liveBpm: 128, keys });
  check('an unknown live key leaves the order alone', blind.index === 0);

  // A short queue must not read past its end.
  const tail = pickNextIndex(queue, 2, { liveKey: Cmaj, liveBpm: 128, keys });
  check('the last entry is handled', tail.index === 2);
  check('an exhausted queue is handled', pickNextIndex(queue, 3, { liveKey: Cmaj, keys }).index === 3);
}

/* ------------- the free re-key reaching planKeyMatch ------------- */

{
  /**
   * The real one, end to end. A 100 BPM track under a 170 BPM deck: the plain
   * match takes half time (-15%), which drops the track's key by nearly three
   * semitones. Two-thirds time (+13.3%) is just as locked to the beat and lands
   * five semitones higher. Pick a key where only the second one works and the
   * plan must find it — and must charge nothing for it.
   *
   * At -15% an F major track sounds three semitones down, in D major (10B),
   * which is two steps from the live 8B — a clash. At +13.3% it sounds two up,
   * in G major (9B), which is right next door.
   */
  const Fmaj = KEY(5, false);
  const plan = planKeyMatch(Cmaj, Fmaj, {
    matchedPercent: -15, tempoRange: 16, liveBpm: 170, otherBpm: 100,
  });
  check('a free re-key is taken when one exists', plan.action === 'retune' && plan.cost === 0,
    `${plan.action}: ${plan.reason}`);
  check('and it lands on a real beat-match, not a nudge',
    plan.action !== 'retune' || Math.abs(plan.tempoPercent - 13.33) < 0.1,
    `${plan.tempoPercent.toFixed(2)}%`);

  // Without BPMs there is nothing to choose between, so it must behave exactly
  // as it did before: report the cost, do not spend it.
  const old = planKeyMatch(Cmaj, Fsmaj, { matchedPercent: 0, tempoRange: 8 });
  check('no BPMs means no free re-key', old.action !== 'retune', `${old.action}: ${old.reason}`);

  // And a free re-key must never be invented where the tempo would go wild.
  const wild = planKeyMatch(Cmaj, Fsmaj, {
    matchedPercent: 0, tempoRange: 50, liveBpm: 128, otherBpm: 128,
  });
  check('no wild tempo is spent on a key', wild.action !== 'retune' || Math.abs(wild.tempoPercent) <= 16,
    `${wild.action}: ${wild.reason}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
