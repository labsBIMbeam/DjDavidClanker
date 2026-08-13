/**
 * MIDI controller support — mapped for the Akai MPD218 factory defaults
 * (pads bank A = notes 36–51 on any channel, knobs bank A = CC 3/9/12/13/14/15).
 *
 * The demo layout, pads bottom-left = PAD 1 — both decks strictly mirrored
 * (outer = deck edge, inner = the shared middle), no automix pads:
 *
 *   13 A·SCRATCH  14 A·BACKSPIN  15 B·BACKSPIN  16 B·SCRATCH
 *    9 A·LOOP 4   10 A·FX hold   11 B·FX hold   12 B·LOOP 4
 *    5 A·SYNC      6 A·DROP       7 B·DROP       8 B·SYNC
 *    1 A·PLAY      2 A·CUE        3 B·CUE        4 B·PLAY
 *
 *   Knobs — K1+K3 belong to deck A, K2+K4 to deck B, K5 is the crossfader
 *   and K6 the headphone level. The master stays in the browser on purpose:
 *   K1 A filter · K3 A macro · K5 crossfader
 *   K2 B filter · K4 B macro · K6 cue volume
 *
 * FX pads are MOMENTARY (hold to ride, release to drop out) — they punch the
 * deck's first FX slot, macros included. Everything else toggles on hit.
 * WebMIDI needs a real origin: devices-mode shell or standalone, like every
 * other media capability here.
 */

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
  const momentary = new Set(['a.fx', 'b.fx']);
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
    'a.fx': (down) => decks.A.toggleFx(decks.A.fxSlots[0], down),
    'b.fx': (down) => decks.B.toggleFx(decks.B.fxSlots[0], down),
    'a.scratch': () => decks.A.toggleAutoScratch('baby'),
    'a.backspin': () => decks.A.toggleAutoScratch('backspin'),
    'b.scratch': () => decks.B.toggleAutoScratch('baby'),
    'b.backspin': () => decks.B.toggleAutoScratch('backspin'),
  };

  const bipolar = (v) => v * 2 - 1;
  const knobs = {
    xf: (v) => {
      mixer.setCrossfader(bipolar(v));
      if (onCrossfade) onCrossfade(mixer.crossfader);
    },
    cue: (v) => mixer.setCueVolume(v),
    'a.macro': (v) => decks.A.setMacroValue(bipolar(v)),
    'b.macro': (v) => decks.B.setMacroValue(bipolar(v)),
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
