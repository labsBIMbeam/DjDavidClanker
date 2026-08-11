/**
 * Automix state machine, headless.
 *
 * Automix touches no audio nodes — it only calls public Deck/Mixer methods —
 * so it can be driven against fakes and stepped in simulated time. This is the
 * regression net for the transition bug: a deck coming off a fade still holds
 * its finished track at `status === 'ready'` with the playhead at the end, and
 * the stager used to read that as "next track already cued", fade back into it
 * and produce silence from the second transition onward.
 *
 *   node dev/automix-check.mjs
 */

import { Automix } from '../src/audio/automix.js';
import { bestOption, keyAtRate, tempoOptions } from '../src/audio/key.js';
import { overlapOf } from '../src/audio/transitions.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

class FakeDeck {
  constructor(id) {
    this.id = id;
    this.status = 'empty';
    this.track = null;
    this.playing = false;
    this.duration = 0;
    this.position = 0;
    this.bpm = 0;
    this.tempo = 0;
    this.tempoRange = 8;
    this.nominalRate = 1;
    this.cuePoint = 0;
    this.syncedTo = null;
    this.error = '';
    this.key = null;
    this.plays = []; // every position playback was started from
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.nominalRate : 0;
  }

  /** As on the real deck: resampling means the tempo fader moves the key. */
  get soundingKey() {
    return this.key ? keyAtRate(this.key, this.nominalRate) : null;
  }

  async load(track) {
    this.track = track;
    this.duration = track.duration;
    this.position = 0;
    this.playing = false;
    this.status = 'ready';
    this.syncedTo = null;
    // BPM detection is asynchronous in the real deck and lands after the
    // decode; the delay is the whole reason sync has to be retried.
    this.bpm = 0;
    this.key = null;
    this._bpmIn = 3;
    this._realBpm = track.bpm;
    this._realKey = track.key || null;
  }

  play() {
    this.playing = true;
    this.plays.push(this.position);
  }

  pause() {
    this.playing = false;
  }

  seek(t) {
    this.position = t;
  }

  // Same shape as the real deck, including the key preference between
  // metrical relations — automix relies on that, so the fake has to have it.
  syncTo(other, { preferKey = null } = {}) {
    const target = typeof other === 'number' ? other : other.effectiveBpm;
    if (!target || !this.bpm) return false;
    const options = tempoOptions(this.bpm, target, this.tempoRange);
    if (!options.length) return false;
    const pick = preferKey && this.key ? bestOption(preferKey, this.key, options) : options[0];
    this.tempo = pick.percent;
    this.nominalRate = 1 + pick.percent / 100;
    this.syncedTo = typeof other === 'number' ? 'num' : other.id;
    return true;
  }

  setTempoRange(r) {
    this.tempoRange = r;
  }

  matchTempoTo(other, ranges = [8, 16, 50], opts = {}) {
    if (!other || !this.bpm || !other.effectiveBpm) return false;
    const start = this.tempoRange;
    for (const r of ranges.filter((v) => v >= start)) {
      this.tempoRange = r;
      if (this.syncTo(other, opts)) return true;
    }
    this.tempoRange = start;
    return false;
  }

  advance(dt) {
    if (this._bpmIn > 0 && --this._bpmIn === 0) {
      this.bpm = this._realBpm;
      this.key = this._realKey;
    }
    if (this.playing) this.position = Math.min(this.duration, this.position + dt * this.nominalRate);
  }
}

class FakeMixer {
  constructor() {
    this.decks = { A: new FakeDeck('A'), B: new FakeDeck('B') };
    this.crossfader = 0;
  }

  setCrossfader(v) {
    this.crossfader = Math.max(-1, Math.min(1, v));
  }
}

/* ------------------------------------------------------------------ */

const QUEUE = [
  { id: 't1', title: 'One', artist: 'A', duration: 60, bpm: 120 },
  { id: 't2', title: 'Two', artist: 'B', duration: 60, bpm: 128 },
  { id: 't3', title: 'Three', artist: 'C', duration: 60, bpm: 100 },
  { id: 't4', title: 'Four', artist: 'D', duration: 60, bpm: 140 },
];

const TRACE = process.env.TRACE === '1';
const mixer = new FakeMixer();
const played = [];
let step = 0;
const automix = new Automix(mixer, {
  onCrossfade: () => {},
  onTrack: (t) => {
    played.push(t.id);
    if (TRACE) {
      const live = automix.liveId;
      console.log(
        `t=${(step * 0.25).toFixed(1)}s  LIVE ${t.id} on ${live}  cursor=${automix.cursor}` +
        `  A=${mixer.decks.A.track?.id}@${mixer.decks.A.position.toFixed(1)}` +
        `  B=${mixer.decks.B.track?.id}@${mixer.decks.B.position.toFixed(1)}` +
        `  spent=[${[...automix._spent]}]`,
      );
    }
  },
  refill: () => [],
});
automix.setQueue(QUEUE.slice());
automix.fadeSeconds = 6;
automix.preloadLead = 20;
automix.start();

const DT = 0.25;
let silentTicks = 0;
let maxSilentRun = 0;
let badFade = '';

for (step = 0; step < 4000; step++) {
  automix.tick(DT);
  for (const d of Object.values(mixer.decks)) d.advance(DT);
  await Promise.resolve(); // let _loadInto settle

  // A deck the mix has faded into must never be sitting on its last sample.
  for (const d of Object.values(mixer.decks)) {
    const gain = d.id === 'A' ? (1 - mixer.crossfader) / 2 : (mixer.crossfader + 1) / 2;
    if (gain > 0.5 && d.playing && d.position >= d.duration - 0.01 && !badFade) {
      badFade = `deck ${d.id} is live at the end of "${d.track && d.track.title}"`;
    }
  }

  // Audible = some deck that is playing, not finished, is open on the fader.
  const audible = Object.values(mixer.decks).some((d) => {
    const gain = d.id === 'A' ? (1 - mixer.crossfader) / 2 : (mixer.crossfader + 1) / 2;
    return d.playing && d.position < d.duration - 0.01 && gain > 0.02;
  });
  if (audible) silentTicks = 0;
  else if (++silentTicks > maxSilentRun) maxSilentRun = silentTicks;
}

check('every queued track went live', played.length >= 4 && QUEUE.every((t) => played.includes(t.id)),
  `played: ${played.join(' → ') || 'nothing'}`);
check('no transition faded into a finished deck', !badFade, badFade);
check('mix never went silent for long', maxSilentRun * DT < 3,
  `longest gap ${(maxSilentRun * DT).toFixed(2)} s`);
check('each playback started from the top, not the end',
  Object.values(mixer.decks).every((d) => d.plays.every((p) => p < d.duration - 1)),
  `starts A=[${mixer.decks.A.plays.map((p) => p.toFixed(1))}] B=[${mixer.decks.B.plays.map((p) => p.toFixed(1))}]`);

const synced = Object.values(mixer.decks).some((d) => d.syncedTo);
check('tempo sync landed despite late BPM detection', synced,
  `A→${mixer.decks.A.syncedTo} rate ${mixer.decks.A.nominalRate.toFixed(3)}, B→${mixer.decks.B.syncedTo} rate ${mixer.decks.B.nominalRate.toFixed(3)}`);

/* ---------------------- harmonic mixing, end to end ---------------------- */

/**
 * The two halves of "no out-of-tune mixes", driven through the whole state
 * machine rather than unit-tested in isolation:
 *
 *   1. a track that fits the key is brought forward out of the next few;
 *   2. when one that clashes has to be played anyway, the two are never left
 *      blending full-range — the handover gets a flow that keeps them apart.
 *
 * Everything is at one tempo so nothing here can be explained by BPM.
 */
{
  const K = (pc, minor) => {
    const CAM_MAJ = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
    const CAM_MIN = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];
    return { pc, minor, name: 'x', camelot: (minor ? CAM_MIN : CAM_MAJ)[pc], confidence: 1 };
  };
  const Cmaj = K(0, false);
  const Amin = K(9, true);   // relative minor of C — the textbook next track
  const Fsmaj = K(6, false); // tritone from C — the clash

  // Long enough tracks and a long enough runway that a 16-bar blend actually
  // fits — otherwise every flow would be a cut for want of time and the
  // overlap rule would never be the thing under test.
  const tracks = [
    { id: 'live', title: 'Live', artist: 'x', duration: 120, bpm: 128, key: Cmaj },
    { id: 'clash', title: 'Clash', artist: 'x', duration: 120, bpm: 128, key: Fsmaj },
    { id: 'fits', title: 'Fits', artist: 'x', duration: 120, bpm: 128, key: Amin },
  ];
  const byId = Object.fromEntries(tracks.map((t) => [t.id, t]));
  // Stands in for TrackKeys: everything has been played before, so the whole
  // queue can be judged without loading any of it.
  const keys = { get: (id) => (byId[id] ? { bpm: byId[id].bpm, key: byId[id].key } : null) };

  const run = async (harmonic) => {
    const m = new FakeMixer();
    const order = [];
    const flows = [];
    const am = new Automix(m, { onCrossfade: () => {}, onTrack: (t) => order.push(t.id), refill: () => [], keys });
    am.harmonic = harmonic;
    am.markedRate = 0; // smooth by default, so any marked flow is the key rule
    am.setQueue([byId.live, byId.clash, byId.fits]);
    am.fadeSeconds = 40;
    am.preloadLead = 60;
    am.start();
    // Record every handover, not every *change* of flow: two consecutive
    // transitions using the same flow are still two transitions.
    let seen = null;
    for (let i = 0; i < 2600; i++) {
      am.tick(DT);
      for (const d of Object.values(m.decks)) d.advance(DT);
      if (am.fade && am.fade !== seen) {
        seen = am.fade;
        flows.push({ flow: am.fade.key, harmony: am.harmony });
      }
      await Promise.resolve();
    }
    return { order, flows };
  };

  const on = await run(true);
  check('the track that fits the key is brought forward',
    on.order[0] === 'live' && on.order[1] === 'fits',
    `played ${on.order.join(' → ')}`);
  check('the track it jumped is not dropped', on.order.includes('clash'),
    `played ${on.order.join(' → ')}`);
  // Reordering a short queue must not wrap round onto the record that is
  // already playing — plain list order could never do that.
  check('no track is ever mixed into itself',
    on.order.every((id, i) => i === 0 || id !== on.order[i - 1]),
    `played ${on.order.join(' → ')}`);

  const clashing = on.flows.filter((f) => f.harmony && f.harmony.known && !f.harmony.ok);
  check('a clashing pair is never blended full-range',
    clashing.every((f) => overlapOf(f.flow) !== 'full'),
    clashing.length
      ? clashing.map((f) => `${f.harmony.pair} ${f.harmony.relation} → ${f.flow} (${overlapOf(f.flow)})`).join('; ')
      : 'no clashing handover occurred');
  check('a clashing handover did occur, so that rule was actually exercised',
    clashing.length > 0, `${clashing.length} of ${on.flows.length} handovers clashed`);

  const inKey = on.flows.filter((f) => f.harmony && f.harmony.known && f.harmony.ok);
  check('an in-key pair is still allowed a long blend',
    !inKey.length || inKey.some((f) => overlapOf(f.flow) === 'full'),
    inKey.map((f) => `${f.harmony.pair} → ${f.flow}`).join('; ') || 'none observed');

  // With harmony off, the running order must be exactly the list order — the
  // feature has to be a switch, not a behaviour baked into the machine.
  const off = await run(false);
  check('harmony off leaves the running order alone',
    off.order.slice(0, 3).join(',') === 'live,clash,fits', `played ${off.order.join(' → ')}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
