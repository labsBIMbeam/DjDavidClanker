import './styles.css';

import { Mixer } from './audio/engine.js';
import { Automix } from './audio/automix.js';
import { DeckPanel } from './ui/deck.js';
import { AutomixBar } from './ui/automixbar.js';
import { MixerStrip } from './ui/mixer.js';
import { Browser } from './ui/browser.js';
import { openModal, toast } from './ui/modal.js';
import { openZapDialog } from './ui/zapmodal.js';
import { h, clear } from './ui/dom.js';
import { capabilities, store, getPublicKey, onIdentityChanged, inShell, mediaSession } from './lib/nap.js';
import { publishSetlist } from './lib/nostr.js';
import { hexToNpub } from './lib/bech32.js';
import { trackFromFile } from './lib/localtracks.js';
import { initCache } from './lib/analysiscache.js';
import { planTransition } from './audio/transition.js';

// Warm the analysis cache early — loads race it, and a miss only costs a
// re-analysis, so fire-and-forget is fine.
initCache().catch(() => {});

const SETTINGS_KEY = 'settings.v1';
const DEFAULTS = { zapDefault: 210, zapMode: 'lnurl', proxy: '', pitchRange: 8, outputMaster: '', outputCue: '' };

const caps = capabilities();
const mixer = new Mixer();
const settings = { ...DEFAULTS };
const setlist = [];

/* ------------------------------ shell ------------------------------ */

const identityEl = h('span', { class: 'ident' }, 'not signed in');
const modeEl = h('span', { class: 'badge' }, inShell() ? 'NAPPLET' : 'STANDALONE');

const header = h('header', { class: 'app-head' },
  h('div', { class: 'brand' },
    h('span', { class: 'brand-bot' }, '🤖'),
    h('span', { class: 'brand-name' }, 'DJ DAVID CLANKER'),
    h('span', { class: 'brand-sub' }, 'wavlake · v4v · two decks'),
  ),
  h('div', { class: 'head-right' }, modeEl, identityEl,
    h('button', { class: 'btn btn-mini', title: 'Shortcuts & info', onclick: showHelp }, '?'),
  ),
);

const deckWrap = h('div', { class: 'stage' });
const app = h('div', { class: 'app' }, header, deckWrap);
document.body.appendChild(app);

const panelA = DeckPanel(mixer.decks.A, { onZap: (d) => zapDeck(d), onEject: eject, accent: 'a' });
const panelB = DeckPanel(mixer.decks.B, { onZap: (d) => zapDeck(d), onEject: eject, accent: 'b' });
const strip = MixerStrip(mixer, { onPublishSet: publishCurrentSet, onSettings: showSettings, onOutputs: showOutputMenu });

// Battle layout: deck tops and bottoms flank the full-height vertical master
// column; both channel strips (EQ, filter, volume, cue) sit split in the
// middle like a real 2-channel mixer. The cue/crossfader/actions bar goes
// below the stage, right above the track browser.
// Two independent grid rows rather than one shared grid: the middle column
// carries a narrow MASTER on top and the two wide channel strips below, and
// a shared grid would size both to the wider one — leaving dead space either
// side of the master.
deckWrap.appendChild(h('div', { class: 'stage-top' },
  panelA.top, strip.middle, panelB.top));
deckWrap.appendChild(h('div', { class: 'stage-bottom' },
  panelA.bottom,
  h('div', { class: 'channel-wrap' }, panelA.channelStrip, panelB.channelStrip),
  panelB.bottom));
app.appendChild(strip.xfRow);

const browser = Browser({
  onLoadDeck: loadIntoDeck,
  onZap: (track) => openZapDialog(track, settings),
  capabilities: caps,
});

const automix = new Automix(mixer, {
  onCrossfade: (v) => { strip.xf.value = String(v); },
  onTrack: (track) => recordPlay(track),
  // When the queue runs dry, take whatever the browser is currently showing.
  refill: () => browser.currentItems(),
  onStatus: (s) => {
    if (s === 'skip-error' && automix.lastError) toast(`Automix skipped: ${automix.lastError}`, 'warn');
    if (s === 'empty') toast('Automix has no tracks — load a list first.', 'warn');
  },
});

const automixBar = AutomixBar(automix, {
  onQueueFromBrowser: () => {
    const items = browser.currentItems();
    automix.setQueue(items);
    toast(items.length ? `${items.length} tracks taken into the automix queue.` : 'The list is empty.', items.length ? 'ok' : 'warn');
  },
});

app.appendChild(automixBar.root);
app.appendChild(browser.root);

const capBanner = h('div', { class: 'cap-banner' });
app.insertBefore(capBanner, deckWrap);

// Drop an audio file straight onto a deck — any of its fragments accepts it.
for (const [id, panel] of [['A', panelA], ['B', panelB]]) {
  for (const root of panel.roots) {
    root.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        root.classList.add('droptarget');
      }
    });
    root.addEventListener('dragleave', () => root.classList.remove('droptarget'));
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('droptarget');
      const file = [...((e.dataTransfer && e.dataTransfer.files) || [])]
        .find((f) => /^audio\//.test(f.type) || /\.(mp3|wav|flac|ogg|m4a)$/i.test(f.name));
      if (file) {
        const track = trackFromFile(file);
        browser.addLocalTracks([track]); // dropped files join the session list
        loadIntoDeck(id, track);
      }
    });
  }
}

/* ------------------------------ wiring ------------------------------ */

for (const id of ['A', 'B']) {
  const deck = mixer.decks[id];
  deck.on((what) => {
    if (what === 'sync-request') {
      // SYNC is a latch: on = match tempo once, then hold the phase from the
      // frame loop until it is clicked off again.
      if (deck.syncedTo) {
        deck.setSynced(null);
        toast(`SYNC deck ${id} released.`, 'ok');
        return;
      }
      const other = mixer.decks[id === 'A' ? 'B' : 'A'];
      if (!other.effectiveBpm) return toast('The other deck has no BPM.', 'warn');
      const target = other.effectiveBpm;
      const ok = deck.syncTo(other);
      const panel = id === 'A' ? panelA : panelB;
      panel.tempoFader.value = String(deck.tempo);
      if (ok) deck.setSynced(other);
      toast(ok
        ? `Deck ${id} synced to ${target.toFixed(1)} BPM — phase is being held.`
        : `Out of reach within the ±${deck.tempoRange}% range.`, ok ? 'ok' : 'warn');
    }
    if (what === 'drop-request') {
      const other = mixer.decks[id === 'A' ? 'B' : 'A'];
      const r = deck.armDrop(other);
      const panel = id === 'A' ? panelA : panelB;
      panel.tempoFader.value = String(deck.tempo);
      if (r === 'cancelled') toast(`Drop on deck ${id} cancelled.`, 'ok');
      else if (r) toast(`Deck ${id} drops on deck ${id === 'A' ? 'B' : 'A'}'s next bar-1.`, 'ok');
      else toast('Drop needs the other deck playing with a BPM and this one loaded.', 'warn');
    }
    if (what === 'ended') {
      toast(`Deck ${id} ran out.`, 'warn');
    }
  });
}

async function loadIntoDeck(id, track) {
  const deck = mixer.decks[id];
  mixer.ensureContext();
  toast(`Loading "${track.title}" into deck ${id}…`);
  await deck.load(track);
  if (deck.status === 'ready') {
    recordPlay(track);
    updateCapBanner();
  } else if (deck.status === 'error') {
    toast(`Deck ${id}: ${deck.error}`, 'bad', 7000);
  }
}

function eject(deck) {
  deck.dispose();
  deck.track = null;
  deck.status = 'empty';
  deck.backend = null;
  deck.peaks = null;
  deck.bpm = 0;
  deck.duration = 0;
  deck.playing = false;
  deck.emit('load');
}

function zapDeck(deck) {
  if (!deck.track) return;
  if (deck.track.localFile) return toast('Local file — no zap target.', 'warn');
  openZapDialog(deck.track, settings);
}

function recordPlay(track) {
  const last = setlist[setlist.length - 1];
  if (last && last.id === track.id) return;
  setlist.push(track);
}

/* ------------------------------ setlist ------------------------------ */

async function publishCurrentSet() {
  if (!setlist.length) return toast('Nothing played yet.', 'warn');
  if (!caps.outbox && !caps.relay && !window.nostr) {
    return toast('No publish channel available (neither outbox/relay nor NIP-07).', 'bad', 6000);
  }
  const titleInput = h('input', { class: 'search-input', value: `DJ David Clanker Set`, 'aria-label': 'Title' });
  const descInput = h('input', { class: 'search-input', placeholder: 'Description (optional)', 'aria-label': 'Description' });
  openModal({
    title: '📡 Publish setlist',
    body: h('div', { class: 'settings' },
      h('div', { class: 'muted' }, `${setlist.length} tracks get published as a kind-30003 set with r tags.`),
      h('label', { class: 'lbl' }, 'Title'), titleInput,
      h('label', { class: 'lbl' }, 'Description'), descInput,
      h('ol', { class: 'setlist-preview' }, ...setlist.map((t) => h('li', {}, `${t.artist} – ${t.title}`))),
    ),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Publish', primary: true, onClick: async (close) => {
          try {
            const res = await publishSetlist(setlist, { title: titleInput.value, description: descInput.value });
            close();
            toast(`Set published${res.eventId ? ` (${res.eventId.slice(0, 12)}…)` : ''}.`, 'ok');
          } catch (e) {
            toast(`Failed: ${e.message}`, 'bad', 7000);
          }
        },
      },
    ],
  });
}

/* ------------------------------ audio outputs ------------------------------ */

/**
 * Dedicated output menu (🔈 in the mixer): master and headphone device,
 * applied immediately — a DJ booth does not want an extra save step.
 */
function showOutputMenu() {
  mixer.ensureContext();
  const outMaster = h('select', { class: 'search-input', 'aria-label': 'Master output' });
  const outCue = h('select', { class: 'search-input', 'aria-label': 'Cue output' });
  const status = h('div', { class: 'muted' }, '');

  const fill = async () => {
    const outs = await mixer.listOutputs();
    for (const sel of [outMaster, outCue]) {
      clear(sel).appendChild(h('option', { value: '' }, 'System default'));
      for (const o of outs) sel.appendChild(h('option', { value: o.deviceId }, o.label));
    }
    outMaster.value = mixer.outputs.master || settings.outputMaster || '';
    outCue.value = mixer.outputs.cue || settings.outputCue || '';
    const unlabeled = outs.length && outs.every((o) => /^Output \d+$/.test(o.label));
    status.textContent = !outs.length
      ? 'No devices visible — this browser/host does not expose the list.'
      : unlabeled ? 'The browser hides device names until you grant access (button below).' : '';
  };

  const apply = (which, sel) => async () => {
    const ok = await mixer.setOutputDevice(which, sel.value);
    settings[which === 'cue' ? 'outputCue' : 'outputMaster'] = sel.value;
    await store.setJson(SETTINGS_KEY, settings);
    toast(ok
      ? `${which === 'cue' ? 'Headphones' : 'Master'} switched.`
      : 'Device selection not possible (setSinkId missing or denied).', ok ? 'ok' : 'warn');
  };
  outMaster.addEventListener('change', apply('master', outMaster));
  outCue.addEventListener('change', apply('cue', outCue));

  const btnUnlock = h('button', {
    class: 'btn btn-ghost',
    onclick: async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        await fill();
        toast('Device names revealed.', 'ok');
      } catch {
        toast('No permission — names stay hidden.', 'warn');
      }
    },
  }, 'Reveal device names');

  fill();
  openModal({
    title: '🔈 Audio outputs',
    body: h('div', { class: 'settings' },
      h('label', { class: 'lbl' }, 'Master (PA)'), outMaster,
      h('label', { class: 'lbl' }, 'Cue 🎧 (headphones)'), outCue,
      status,
      btnUnlock,
      h('div', { class: 'muted' }, 'Separate outputs need AudioContext.setSinkId (Chrome ≥ 110). Inside a napplet shell the host has to pass the speaker-selection policy through; without a selection the cue bus lands on the default output.'),
    ),
    actions: [{ label: 'Done', primary: true, onClick: (close) => close() }],
  });
}

/* ------------------------------ settings ------------------------------ */

function showSettings() {
  const zapAmount = h('input', { class: 'search-input', type: 'number', min: '1', value: String(settings.zapDefault) });
  const zapMode = h('select', { class: 'search-input' },
    h('option', { value: 'lnurl', selected: settings.zapMode === 'lnurl' }, 'LNURL-pay (nothing gets signed)'),
    h('option', { value: 'nip57', selected: settings.zapMode === 'nip57' }, 'NIP-57 (host signs & publishes kind 9734)'),
  );
  const proxy = h('input', {
    class: 'search-input', value: settings.proxy,
    placeholder: 'https://proxy.example/?url={url}',
  });

  openModal({
    title: '⚙ Settings',
    body: h('div', { class: 'settings' },
      h('label', { class: 'lbl' }, 'Default zap (sats)'), zapAmount,
      h('label', { class: 'lbl' }, 'Zap mode'), zapMode,
      h('div', { class: 'muted' }, 'NIP-5D has no payment domain and no pure signing API. A real NIP-57 zap only works by letting the host sign the 9734 request while publishing it — so it also lands on your relays.'),
      h('label', { class: 'lbl' }, 'Audio outputs'),
      h('button', { class: 'btn btn-ghost', onclick: () => showOutputMenu() }, '🔈 Open audio outputs'),
      h('label', { class: 'lbl' }, 'CORS proxy (standalone only)'), proxy,
      h('div', { class: 'muted' }, 'Wavlake\'s audio CDN sends no CORS headers. Inside the napplet the host fetches the bytes via resource.bytes; standalone needs a proxy for that — otherwise only basic mode runs.'),
      h('div', { class: 'caps' }, h('div', { class: 'side-h' }, 'Host domains'),
        ...Object.entries(caps).filter(([k]) => k !== 'shell').map(([k, v]) =>
          h('span', { class: `cap ${v ? 'on' : 'off'}` }, `${v ? '✓' : '×'} ${k}`)),
      ),
    ),
    actions: [
      { label: 'Close', onClick: (close) => close() },
      {
        label: 'Save', primary: true, onClick: async (close) => {
          settings.zapDefault = Math.max(1, parseInt(zapAmount.value, 10) || 210);
          settings.zapMode = zapMode.value;
          settings.proxy = proxy.value.trim();
          mixer.proxy = settings.proxy;
          await store.setJson(SETTINGS_KEY, settings);
          close();
          toast('Saved.', 'ok');
        },
      },
    ],
  });
}

function showHelp() {
  const keys = [
    ['Q / P', 'Deck A / B play-pause'],
    ['W / O', 'Deck A / B cue'],
    ['X', 'Automix on / off'],
    ['N', 'Automix: crossfade now'],
    ['S / L', 'Deck A / B rewind — hold to speed up'],
    ['V / B', 'Deck A / B toggle VINYL vs CDJ'],
    ['E / I', 'Deck A / B pre-listen (🎧 cue bus)'],
    ['T / U', 'Deck A / B tap tempo — tap every beat, 4+ taps set BPM and grid'],
    ['F / G', 'Deck A FX slot 1 / 2'],
    ['H / J', 'Deck B FX slot 1 / 2'],
    [', / .', 'Crossfader left / right'],
    ['M', 'Center the crossfader'],
    ['1 / 2', 'Deck A / B SYNC latch (hold BPM + phase)'],
    ['3 / 4', 'Deck A / B DROP: start on the other deck\'s next bar-1'],
    ['← / →', 'Seek deck A by 5 s (with Alt: deck B)'],
    ['Double-click', 'Load a track into deck A'],
  ];
  openModal({
    title: 'DJ David Clanker',
    body: h('div', { class: 'settings' },
      h('div', { class: 'muted' }, 'Two-deck mixer for Wavlake music, built as a NIP-5D napplet. Music comes from the Wavlake charts, catalog search, your crate, kind-30003 playlists from Nostr, and local files. Every track has a value4value zap button.'),
      h('div', { class: 'side-h' }, 'Vinyl'),
      h('div', { class: 'muted' }, 'In VINYL mode the platter is a turntable: dragging scratches the audio forwards and backwards, stop brakes audibly, start spins up. CDJ mode starts instantly and the platter only pitchbends. Rewind accelerates the longer you hold — a tap gives a stutter, holding gives a full backspin.'),
      h('div', { class: 'side-h' }, 'Automix'),
      h('div', { class: 'muted' }, 'Takes the list from the browser, loads the next track onto the free deck in time, pulls it onto the BPM and crossfades in the outro. You can grab the controls at any moment — automix drives the same controls you do.'),
      h('div', { class: 'side-h' }, 'FX'),
      h('div', { class: 'muted' }, 'Five insert effects per deck — flanger, phaser, gater, echo, reverb — behind the filter. Two slots choose via dropdown which pair the FX buttons (and F/G or H/J) drive. Gater and echo run tempo-synced on the deck\'s BPM.'),
      h('div', { class: 'side-h' }, 'Keys'),
      h('table', { class: 'keys' }, ...keys.map(([k, d]) => h('tr', {}, h('td', {}, k), h('td', {}, d)))),
      h('div', { class: 'side-h' }, 'Modes'),
      h('div', { class: 'muted' }, 'FULL = samples are decoded: EQ, filter, FX, scratch, waveform, BPM detection. BASIC = <audio> streaming only: crossfade via volume and tempo via playbackRate — no EQ, no FX, no scratch.'),
    ),
    actions: [{ label: 'Got it', primary: true, onClick: (close) => close() }],
  });
}

/* ------------------------------ capability banner ------------------------------ */

function updateCapBanner() {
  clear(capBanner);
  const msgs = [];
  if (!inShell()) {
    msgs.push('Standalone mode: no NIP-5D host. Zaps go through WebLN or an external wallet, Nostr publishing through a NIP-07 extension.');
  }
  if (!caps.resource && !inShell()) {
    msgs.push('Without the host resource domain and without a CORS proxy, audio stays in BASIC mode (no EQ/filter/waveform).');
  }
  if (inShell() && !caps.resource) {
    msgs.push('This host does not provide the resource domain — inside the sandboxed iframe no audio is reachable.');
  }
  if (!msgs.length) {
    capBanner.style.display = 'none';
    return;
  }
  capBanner.style.display = '';
  for (const m of msgs) capBanner.appendChild(h('div', { class: 'cap-msg' }, m));
}

/* ------------------------------ keyboard ------------------------------ */

const inField = (e) => /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '');
const held = new Set();

document.addEventListener('keydown', (e) => {
  if (inField(e)) return;
  const A = mixer.decks.A;
  const B = mixer.decks.B;
  const k = e.key.toLowerCase();

  // Rewind is a hold, so it must not retrigger on key auto-repeat.
  if (k === 's' || k === 'l') {
    e.preventDefault();
    if (held.has(k)) return;
    held.add(k);
    (k === 's' ? A : B).startRewind();
    return;
  }

  let handled = true;
  switch (k) {
    case 'q': A.toggle(); break;
    case 'p': B.toggle(); break;
    case 'w': A.cue(); break;
    case 'o': B.cue(); break;
    case ',': setX(mixer.crossfader - 0.08); break;
    case '.': setX(mixer.crossfader + 0.08); break;
    case 'm': setX(0); break;
    case '1': A.emit('sync-request'); break;
    case '2': B.emit('sync-request'); break;
    case '3': A.emit('drop-request'); break;
    case '4': B.emit('drop-request'); break;
    case 'x':
      if (!automix.enabled && !automix.queue.length) automix.setQueue(browser.currentItems());
      automix.toggle();
      break;
    case 'n': automix.skip(); break;
    case 'v': A.vinylMode = !A.vinylMode; A.emit('mode'); break;
    case 'b': B.vinylMode = !B.vinylMode; B.emit('mode'); break;
    case 'e': A.setCue(); break;
    case 'i': B.setCue(); break;
    case 't': A.tapBeat(); break;
    case 'u': B.tapBeat(); break;
    case 'f': A.toggleFx(A.fxSlots[0]); break;
    case 'g': A.toggleFx(A.fxSlots[1]); break;
    case 'h': B.toggleFx(B.fxSlots[0]); break;
    case 'j': B.toggleFx(B.fxSlots[1]); break;
    case 'arrowleft': (e.altKey ? B : A).seek((e.altKey ? B : A).position - 5); break;
    case 'arrowright': (e.altKey ? B : A).seek((e.altKey ? B : A).position + 5); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (!held.has(k)) return;
  held.delete(k);
  (k === 's' ? mixer.decks.A : mixer.decks.B).stopRewind();
});

// A key held while the window loses focus would otherwise rewind forever.
window.addEventListener('blur', () => {
  for (const k of held) (k === 's' ? mixer.decks.A : mixer.decks.B).stopRewind();
  held.clear();
});

function setX(v) {
  mixer.setCrossfader(v);
  strip.xf.value = String(mixer.crossfader);
}

/* ------------------------------ media session ------------------------------ */

// Entirely optional: a host that implements NAP-MEDIA gets OS transport
// controls. Hosts that advertise the domain but do not answer are common, so
// every call here is fire-and-forget.
const media = mediaSession();
if (media) {
  Promise.resolve()
    .then(() => media.createSession({ title: 'DJ David Clanker' }))
    .then(() => media.onCommand((cmd) => {
      const deck = mixer.decks.A.playing || !mixer.decks.B.track ? mixer.decks.A : mixer.decks.B;
      if (cmd && cmd.action === 'play') deck.play();
      else if (cmd && cmd.action === 'pause') deck.pause();
    }))
    .catch(() => { /* host does not really support media */ });
}

// Debug handle: the napplet is alone in its sandbox, and having the live mixer
// reachable makes the platter/FX behaviour testable from the outside — and
// drivable: dev/live-dj.mjs runs a whole set through this handle.
window.__djclanker = { mixer, decks: mixer.decks, settings, automix, browser, toast, planTransition };

/* ------------------------------ loop ------------------------------ */

let lastFrame = 0;
function frame(now) {
  const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  mixer.tickAudio(); // platter physics + gater scheduling
  automix.tick(dt);
  panelA.tick();
  panelB.tick();
  strip.tick();
  automixBar.tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------------------ boot ------------------------------ */

(async function boot() {
  Object.assign(settings, await store.getJson(SETTINGS_KEY, DEFAULTS));
  mixer.proxy = settings.proxy;
  mixer.decks.A.tempoRange = settings.pitchRange;
  mixer.decks.B.tempoRange = settings.pitchRange;

  const pk = await getPublicKey();
  const showKey = (hex) => {
    const npub = hex ? hexToNpub(hex) : '';
    identityEl.textContent = npub ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : 'not signed in';
    identityEl.title = npub || '';
  };
  showKey(pk);
  onIdentityChanged(showKey);

  updateCapBanner();

  // The AudioContext must start from a user gesture; take the first one we see.
  const unlock = () => {
    mixer.ensureContext();
    mixer.resumeAudio();
    if (settings.outputMaster) mixer.setOutputDevice('master', settings.outputMaster);
    if (settings.outputCue) mixer.setOutputDevice('cue', settings.outputCue);
  };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
})();
