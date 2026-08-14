/**
 * MIDI controller support — mapped for the Akai MPD218 factory defaults
 * (pads bank A = notes 36–51 on any channel, knobs bank A = CC 3/9/12/13/14/15).
 *
 * The demo layout, pads bottom-left = PAD 1 — both decks strictly mirrored
 * (outer = deck edge, inner = the shared middle), no automix pads:
 *
 *   13 A·SCRATCH  14 A·BACKSPIN  15 B·BACKSPIN  16 B·SCRATCH
 *      (SCRATCH throws the move armed in the deck's dropdown — same as the
 *       on-screen SCRATCH button; tap again to stop, repick to swap live)
 *    9 A·LOOP 4   10 A·FX2 tap   11 B·FX2 tap   12 B·LOOP 4
 *    5 A·SYNC      6 A·DROP       7 B·DROP       8 B·SYNC
 *    1 A·PLAY      2 A·CUE        3 B·CUE        4 B·PLAY
 *
 *   Knobs — K1+K3 belong to deck A, K2+K4 to deck B, K5 is the crossfader
 *   and K6 the headphone level. The master stays in the browser on purpose:
 *   K1 A filter · K3 A slot-1 FX · K5 crossfader
 *   K2 B filter · K4 B slot-1 FX · K6 cue volume
 *
 * The FX split is one hand per slot: K3/K4 DRIVE slot 1 (the unit's primary
 * amount — mix, drive, vowel morph, macro knob …; near zero switches it off),
 * the FX2 pads TOGGLE slot 2. Both effects stay reachable at once.
 * WebMIDI needs a real origin: devices-mode shell or standalone, like every
 * other media capability here.
 */

import { FX_PRIMARY } from '../audio/engine.js';

export const MPD218_MAP = {
  pads: {
    36: 'a.play', 37: 'a.cue', 38: 'b.cue', 39: 'b.play',
    40: 'a.sync', 41: 'a.drop', 42: 'b.drop', 43: 'b.sync',
    44: 'a.loop4', 45: 'a.fx', 46: 'b.fx', 47: 'b.loop4',
    48: 'a.scratch', 49: 'a.backspin', 50: 'b.backspin', 51: 'b.scratch',
  },
  knobs: { 3: 'a.filter', 9: 'b.filter', 12: 'a.macro', 13: 'b.macro', 14: 'xf', 15: 'cue' },
};

export function createMidi({ mixer, automix, onCrossfade, onStatus }) {
  const decks = mixer.decks;
  const say = onStatus || (() => {});

  // Momentary actions receive the pad state; everything else fires on hit.
  const momentary = new Set();

  /**
   * K3/K4: drive whatever sits in FX slot 1. A macro entry gets the bipolar
   * knob; an insert unit gets its primary amount, and near-zero releases it.
   */
  const driveSlot1 = (deck, v) => {
    const t = deck.fxSlots[0];
    if (typeof t === 'string' && t.startsWith('macro:')) {
      deck.setMacroValue(v * 2 - 1);
      return;
    }
    if (v <= 0.04) {
      deck.toggleFx(t, false);
      return;
    }
    deck.toggleFx(t, true);
    const param = FX_PRIMARY[t];
    if (!param) return;
    // Map the 0..1 pot onto the parameter's own range.
    const spans = { drive: [0, 1], depth: [0, 1], width: [0, 1], mix: [0, 1], vowel: [0, 1] };
    const [lo, hi] = spans[param] || [0, 1];
    deck.setFx(t, { [param]: lo + v * (hi - lo) });
  };

  const actions = {
    'a.play': () => decks.A.toggle(),
    'b.play': () => decks.B.toggle(),
    'a.cue': () => decks.A.cue(),
    'b.cue': () => decks.B.cue(),
    'a.sync': () => decks.A.emit('sync-request'),
    'b.sync': () => decks.B.emit('sync-request'),
    'a.drop': () => decks.A.emit('drop-request'),
    'b.drop': () => decks.B.emit('drop-request'),
    'a.loop4': () => decks.A.setLoopBeats(4),
    'b.loop4': () => decks.B.setLoopBeats(4),
    'a.fx': () => decks.A.toggleFx(decks.A.fxSlots[1]),
    'b.fx': () => decks.B.toggleFx(decks.B.fxSlots[1]),
    'a.scratch': () => decks.A.toggleAutoScratch(decks.A.scratchChoice),
    'a.backspin': () => decks.A.toggleAutoScratch('backspin'),
    'b.scratch': () => decks.B.toggleAutoScratch(decks.B.scratchChoice),
    'b.backspin': () => decks.B.toggleAutoScratch('backspin'),
  };

  const bipolar = (v) => v * 2 - 1;
  const knobs = {
    xf: (v) => {
      mixer.setCrossfader(bipolar(v));
      if (onCrossfade) onCrossfade(mixer.crossfader);
    },
    cue: (v) => mixer.setCueVolume(v),
    'a.macro': (v) => driveSlot1(decks.A, v),
    'b.macro': (v) => driveSlot1(decks.B, v),
    'a.filter': (v) => decks.A.setFilter(bipolar(v)),
    'b.filter': (v) => decks.B.setFilter(bipolar(v)),
  };

  /** One raw message. Exposed so tests can drive the map without hardware. */
  function handle(data) {
    const type = data[0] & 0xf0;
    if (type === 0x90 && data[2] > 0) return pad(data[1], true);
    if (type === 0x80 || (type === 0x90 && data[2] === 0)) return pad(data[1], false);
    if (type === 0xb0) {
      const fn = knobs[MPD218_MAP.knobs[data[1]]];
      if (fn) fn(data[2] / 127);
    }
    return undefined;
  }

  function pad(note, down) {
    const id = MPD218_MAP.pads[note];
    const fn = id && actions[id];
    if (!fn) return;
    if (momentary.has(id)) fn(down);
    else if (down) fn();
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) throw new Error('WebMIDI unavailable');
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const attach = (input) => {
      input.onmidimessage = (e) => handle(e.data);
    };
    for (const input of access.inputs.values()) attach(input);
    access.onstatechange = (e) => {
      if (e.port.type === 'input' && e.port.state === 'connected') {
        attach(e.port);
        say(`MIDI in: ${e.port.name}`);
      }
    };
    return [...access.inputs.values()].map((i) => i.name);
  }

  return { connect, handle, map: MPD218_MAP };
}
