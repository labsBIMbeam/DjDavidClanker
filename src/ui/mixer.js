import { h, fader } from './dom.js';
import { Scope } from './scope.js';

export function MixerStrip(mixer, { onPublishSet, onSettings, onOutputs }) {
  // Master sound wave — the summed signal after the crossfader, so it shows
  // what actually leaves the mixer rather than either deck alone.
  const scope = Scope(() => mixer.masterAnalyser || null, {
    height: 64,
    mode: 'mirror',
    colors: ['#f7931a', '#f3c244'],
  });

  const xf = fader({
    min: -1, max: 1, step: 0.005, value: 0, orient: 'h', label: 'Crossfader',
    className: 'crossfader',
    onInput: (v) => mixer.setCrossfader(v),
  });

  const master = fader({
    min: 0, max: 1, step: 0.01, value: mixer.master, orient: 'h', label: 'Master',
    className: 'master',
    onInput: (v) => mixer.setMaster(v),
  });

  const vu = h('div', { class: 'vu vu-master' }, h('div', { class: 'vu-fill' }));

  const cueVol = fader({
    min: 0, max: 1, step: 0.01, value: mixer.cueVolume, orient: 'h', label: 'Headphone volume',
    className: 'cuevol',
    onInput: (v) => mixer.setCueVolume(v),
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

  const root = h('div', { class: 'mixer-wrap' },
    h('div', { class: 'master-scope' }, h('span', { class: 'scope-label' }, 'MASTER'), scope.root),
    h('div', { class: 'mixer' },
    h('div', { class: 'mixer-x' },
      h('div', { class: 'mixer-x-head' },
        h('span', { class: 'lbl' }, 'CROSSFADER'),
        h('div', { class: 'xf-btns' }, btnA, btnCenter, btnB),
      ),
      xf,
    ),
    h('div', { class: 'mixer-master' },
      h('span', { class: 'lbl' }, 'MASTER'),
      h('div', { class: 'master-row' }, master, vu),
    ),
    h('div', { class: 'mixer-cue' },
      h('span', { class: 'lbl' }, '🎧 CUE'),
      cueVol,
    ),
    h('div', { class: 'mixer-actions' },
      h('button', { class: 'btn btn-ghost', title: 'Publish the setlist as a Nostr event', onclick: onPublishSet }, '📡 Setlist'),
      h('button', { class: 'btn btn-ghost btn-outputs', title: 'Audio outputs (master / headphones)', onclick: onOutputs }, '🔈'),
      h('button', { class: 'btn btn-ghost', title: 'Settings', onclick: onSettings }, '⚙'),
    ),
    ),
  );

  function tick() {
    const lv = mixer.masterLevel();
    vu.firstChild.style.width = `${Math.round(Math.min(1, lv * 1.25) * 100)}%`;
    vu.classList.toggle('clip', lv > 0.98);
    scope.draw();
  }

  return { root, tick, xf };
}
