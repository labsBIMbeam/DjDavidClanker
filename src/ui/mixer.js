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

  // LINE IN: a live input as a third channel — gain, bass kill, no deck.
  const lineVol = fader({
    min: 0, max: 2, step: 0.01, value: mixer.lineIn.volume, orient: 'h', label: 'Line-in gain',
    className: 'linevol',
    onInput: (v) => mixer.setLineVolume(v),
  });
  const btnLineLow = h('button', {
    class: 'btn btn-mini btn-line-low', title: 'Line-in bass kill',
    onclick: () => mixer.setLineLow(mixer.lineIn.low < 0 ? 0 : -26),
  }, 'L');
  const btnLine = h('button', {
    class: 'btn btn-mini btn-line',
    title: 'LINE IN: default audio input into the master (virtual cable, phone, turntable). Needs media permission — devices-mode shell or standalone.',
    onclick: async () => {
      try {
        if (mixer.lineIn.on) mixer.disableLineIn();
        else await mixer.enableLineIn();
        btnLine.classList.remove('bad');
      } catch (e) {
        btnLine.classList.add('bad');
        btnLine.title = `Line-in failed: ${e.message || e} — media input needs the devices-mode shell or standalone.`;
      }
    },
  }, 'LINE');

  const xfRow = h('div', { class: 'xf-row' },
    h('span', { class: 'lbl' }, '🎧 CUE'),
    cueVol,
    h('div', { class: 'line-box' }, btnLine, lineVol, btnLineLow),
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
    btnLine.classList.toggle('on', mixer.lineIn.on);
    btnLineLow.classList.toggle('on', mixer.lineIn.low < 0);
  }

  return { xfRow, middle, tick, xf };
}
