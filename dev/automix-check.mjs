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
    this.plays = []; // every position playback was started from
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.nominalRate : 0;
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
    this._bpmIn = 3;
    this._realBpm = track.bpm;
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

  syncTo(other) {
    const target = typeof other === 'number' ? other : other.effectiveBpm;
    if (!target || !this.bpm) return false;
    let best = null;
    for (const t of [target, target * 2, target / 2, target * 1.5, target / 1.5]) {
      const pct = (t / this.bpm - 1) * 100;
      if (Math.abs(pct) <= this.tempoRange && (!best || Math.abs(pct) < Math.abs(best))) best = pct;
    }
    if (best === null) return false;
    this.tempo = best;
    this.nominalRate = 1 + best / 100;
    this.syncedTo = typeof other === 'number' ? 'num' : other.id;
    return true;
  }

  setTempoRange(r) {
    this.tempoRange = r;
  }

  matchTempoTo(other, ranges = [8, 16, 50]) {
    if (!other || !this.bpm || !other.effectiveBpm) return false;
    const start = this.tempoRange;
    for (const r of ranges.filter((v) => v >= start)) {
      this.tempoRange = r;
      if (this.syncTo(other)) return true;
    }
    this.tempoRange = start;
    return false;
  }

  advance(dt) {
    if (this._bpmIn > 0 && --this._bpmIn === 0) this.bpm = this._realBpm;
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

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
