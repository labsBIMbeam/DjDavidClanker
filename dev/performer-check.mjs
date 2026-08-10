/**
 * Performer safety net.
 *
 * The performer is meant to be left running unattended, so the two properties
 * that matter are not "does it sound good" but:
 *
 *   1. every gesture it makes is undone — after stop() the mix is exactly as
 *      it was found, with no effect left on and no loop left armed;
 *   2. it never touches a deck a human has hold of.
 *
 * Both are checked here by driving it against fakes for a few thousand bars.
 *
 *   node dev/performer-check.mjs
 */

import { Performer } from '../src/audio/performer.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

class FakeDeck {
  constructor(id) {
    this.id = id;
    this.status = 'ready';
    this.backend = 'buffer';
    this.canVinyl = true;
    this.playing = true;
    this.scratching = false;
    this.rewinding = false;
    this.autoScratching = false;
    this.duration = 200;
    this.position = 0;
    this.bpm = 124;
    this.nominalRate = 1;
    this.filter = 0;
    this.eq = { low: 0, mid: 0, high: 0 };
    this.loop = { active: false, start: 0, end: 0, beats: 0 };
    this.fx = {};
    for (const t of ['flanger', 'phaser', 'gater', 'echo', 'reverb']) this.fx[t] = { on: false };
    this.touchedWhileHeld = 0;
    this._held = false;
  }

  get effectiveBpm() {
    return this.bpm * this.nominalRate;
  }

  /** Put a hand on the record: nothing the performer does may reach it. */
  setHeld(v) {
    this._held = v;
    this.scratching = v;
    this.autoScratching = false;
  }

  _guard() {
    if (this._held) this.touchedWhileHeld++;
  }

  toggleAutoScratch(name) {
    this._guard();
    this.autoScratching = !this.autoScratching;
    this.pattern = name;
  }

  stopAutoScratch() {
    this.autoScratching = false;
  }

  setLoopBeats(b) {
    this._guard();
    this.loop = { active: true, start: this.position, end: this.position + b, beats: b };
  }

  exitLoop() {
    this.loop = { ...this.loop, active: false };
  }

  toggleFx(unit, on) {
    this._guard();
    this.fx[unit].on = on === undefined ? !this.fx[unit].on : Boolean(on);
  }

  setFilter(v) {
    this._guard();
    this.filter = Math.max(-1, Math.min(1, v));
  }

  setEq(band, db) {
    this._guard();
    this.eq[band] = Math.max(-26, Math.min(6, db));
  }

  play() {
    this._guard();
    this.playing = true;
  }

  pause() {
    this._guard();
    this.playing = false;
  }

  seek(t) {
    this._guard();
    this.position = t;
  }

  /**
   * Beatmatching deliberately persists — it is the one thing the performer
   * does that should outlive the gesture — so nominalRate is not part of the
   * restore snapshot.
   */
  syncTo(other) {
    this._guard();
    const target = typeof other === 'number' ? other : other.effectiveBpm;
    if (!target || !this.bpm) return false;
    this.nominalRate = target / this.bpm;
    return true;
  }

  matchTempoTo(other) {
    return this.syncTo(other);
  }

  setSynced(other) {
    this.syncedTo = other || null;
  }
}

class FakeMixer {
  constructor() {
    this.decks = { A: new FakeDeck('A'), B: new FakeDeck('B') };
    this.crossfader = 0;
  }

  crossValue(id) {
    const x = (this.crossfader + 1) / 2;
    return id === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2);
  }

  setCrossfader(v) {
    this.crossfader = Math.max(-1, Math.min(1, v));
  }
}

const snapshot = (m) => JSON.stringify({
  x: m.crossfader,
  decks: Object.values(m.decks).map((d) => ({
    filter: d.filter,
    eq: d.eq,
    loop: d.loop.active,
    fx: Object.fromEntries(Object.entries(d.fx).map(([k, v]) => [k, v.on])),
    scratch: d.autoScratching,
  })),
});

/* ---------------- 1. everything it does, it undoes ---------------- */

const mixer = new FakeMixer();
const before = snapshot(mixer);
const performer = new Performer(mixer, { automix: null });
performer.intensity = 1; // maximum pressure
performer.start();

const DT = 1 / 60;
let maxConcurrent = 0;
for (let i = 0; i < 60 * 60 * 20; i++) {
  performer.tick(DT);
  for (const d of Object.values(mixer.decks)) d.position = (d.position + DT) % d.duration;
  maxConcurrent = Math.max(maxConcurrent, performer._holds.length);
}
const during = snapshot(mixer);
performer.stop();
const after = snapshot(mixer);

check('performer actually did something', during !== before || maxConcurrent > 0,
  `peak concurrent gestures ${maxConcurrent}`);
check('mix fully restored after stop', after === before,
  after === before ? '' : `\n    before ${before}\n    after  ${after}`);
check('gestures never stacked unboundedly', maxConcurrent <= 4, `peak ${maxConcurrent}`);

/* ---------------- 2. a hand on a deck is never overridden ---------------- */

const m2 = new FakeMixer();
const p2 = new Performer(m2, { automix: null });
p2.intensity = 1;
p2.start();
m2.decks.A.setHeld(true); // human is scratching deck A for the whole run
m2.crossfader = -1; // ...and it is the live one, so it is the tempting target

// Gestures already in flight get one restoring write each as they release —
// that is the performer getting out of the way, not intruding. Let those
// settle, then require absolute silence on that deck from here on.
for (let i = 0; i < 120; i++) p2.tick(DT);
m2.decks.A.touchedWhileHeld = 0;

for (let i = 0; i < 60 * 60 * 20; i++) {
  p2.tick(DT);
  for (const d of Object.values(m2.decks)) d.position = (d.position + DT) % d.duration;
}
p2.stop();

check('never touched the deck under a hand', m2.decks.A.touchedWhileHeld === 0,
  `${m2.decks.A.touchedWhileHeld} intrusions`);

/* ---------------- 3. it stays off the fader during a transition -------- */

const m3 = new FakeMixer();
const fakeAutomix = { fade: { t: 0, dur: 8 }, liveDeck: m3.decks.A };
const p3 = new Performer(m3, { automix: fakeAutomix });
p3.intensity = 1;
p3.start();
const xBefore = m3.crossfader;
let faderMoved = false;
for (let i = 0; i < 60 * 60 * 10; i++) {
  p3.tick(DT);
  if (m3.crossfader !== xBefore) faderMoved = true;
}
p3.stop();

check('left the crossfader alone mid-transition', !faderMoved,
  faderMoved ? `crossfader drifted to ${m3.crossfader}` : '');

/* ---------------- 4. the mix is fader work, not scratch work ------------ */

const m4 = new FakeMixer();
const p4 = new Performer(m4, { automix: null });
p4.intensity = 1;
const census = {};
const realHold = p4._hold.bind(p4);
p4._hold = (spec) => {
  const kind = spec.label.split(' ')[0];
  census[kind] = (census[kind] || 0) + 1;
  return realHold(spec);
};
p4.start();
for (let i = 0; i < 60 * 60 * 30; i++) {
  p4.tick(DT);
  for (const d of Object.values(m4.decks)) d.position = (d.position + DT) % d.duration;
}
p4.stop();

const fader = (census.blend || 0) + (census.fade || 0) + (census.fader || 0);
const scratch = census.scratch || 0;
check('crossfader work outweighs scratching', fader > scratch * 3,
  `${Object.entries(census).map(([k, v]) => `${k}:${v}`).join(' ') || 'nothing'}`);
check('blending happens regularly', (census.blend || 0) > 0,
  `${census.blend || 0} blends in 30 simulated minutes`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
