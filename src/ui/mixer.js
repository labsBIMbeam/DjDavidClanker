import { h, fader } from './dom.js';
import { LevelMeter } from './meter.js';

/**
 * The mixer, split for the battle layout: a vertical master column (fader +
 * classic meter with red overshoot) for the middle of the stage, and a
 * bottom bar — cue, crossfader with live A/B markers, app actions — that
 * sits directly above the track browser.
 */
export function MixerStrip(mixer, { onPublishSet, onSettings, onOutputs }) {
  const xf = fader({
    min: -1, max: 1, step: 0.005, value: 0, orient: 'h', label: 'Crossfader',
    className: 'crossfader',
    onInput: (v) => mixer.setCrossfader(v),
  });

  const btnCenter = h('button', {
    class: 'btn btn-mini', title: 'Center the crossfader',
    onclick: () => { mixer.setCrossfader(0); xf.value = '0'; },
  }, '◆');
  const btnA = h('button', {
    class: 'btn btn-mini', title: 'Full deck A',
    onclick: () => { mixer.setCrossfader(-1); xf.value = '-1'; },
  }, 'A');
  const btnB = h('button', {
    class: 'btn btn-mini', title: 'Full deck B',
    onclick: () => { mixer.setCrossfader(1); xf.value = '1'; },
  }, 'B');

  const endA = h('span', { class: 'xf-end xf-end-a', title: 'Deck A — lit while it is on air' }, 'A');
  const endB = h('span', { class: 'xf-end xf-end-b', title: 'Deck B — lit while it is on air' }, 'B');

  const cueVol = fader({
    min: 0, max: 1, step: 0.01, value: mixer.cueVolume, orient: 'h', label: 'Headphone volume',
    className: 'cuevol',
    onInput: (v) => mixer.setCueVolume(v),
  });

  const xfRow = h('div', { class: 'xf-row' },
    h('span', { class: 'lbl' }, '🎧 CUE'),
    cueVol,
    endA,
    xf,
    endB,
    h('div', { class: 'xf-btns' }, btnA, btnCenter, btnB),
    h('div', { class: 'mixer-actions' },
      h('button', { class: 'btn btn-ghost', title: 'Publish the setlist as a Nostr event', onclick: onPublishSet }, '📡 Setlist'),
      h('button', { class: 'btn btn-ghost btn-outputs', title: 'Audio outputs (master / headphones)', onclick: onOutputs }, '🔈'),
      h('button', { class: 'btn btn-ghost', title: 'Settings', onclick: onSettings }, '⚙'),
    ),
  );

  const master = fader({
    min: 0, max: 1, step: 0.01, value: mixer.master, orient: 'v', label: 'Master volume',
    className: 'master',
    onInput: (v) => mixer.setMaster(v),
  });
  const meter = LevelMeter(() => mixer.masterLevel(), { orient: 'v', length: 260, thickness: 18 });

  const middle = h('div', { class: 'master-col' },
    h('span', { class: 'lbl' }, 'MASTER'),
    h('div', { class: 'master-vert' }, master, meter.canvas),
  );

  function tick() {
    meter.draw();
    // On-air markers: playing and actually audible on the crossfader.
    endA.classList.toggle('live', mixer.decks.A.playing && mixer.crossValue('A') > 0.25);
    endB.classList.toggle('live', mixer.decks.B.playing && mixer.crossValue('B') > 0.25);
  }

  return { xfRow, middle, tick, xf };
}
