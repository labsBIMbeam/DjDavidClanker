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

const SETTINGS_KEY = 'settings.v1';
const DEFAULTS = { zapDefault: 210, zapMode: 'lnurl', proxy: '', pitchRange: 8, outputMaster: '', outputCue: '' };

const caps = capabilities();
const mixer = new Mixer();
const settings = { ...DEFAULTS };
const setlist = [];

/* ------------------------------ shell ------------------------------ */

const identityEl = h('span', { class: 'ident' }, 'nicht angemeldet');
const modeEl = h('span', { class: 'badge' }, inShell() ? 'NAPPLET' : 'STANDALONE');

const header = h('header', { class: 'app-head' },
  h('div', { class: 'brand' },
    h('span', { class: 'brand-bot' }, '🤖'),
    h('span', { class: 'brand-name' }, 'DJ DAVID CLANKER'),
    h('span', { class: 'brand-sub' }, 'wavlake · v4v · two decks'),
  ),
  h('div', { class: 'head-right' }, modeEl, identityEl,
    h('button', { class: 'btn btn-mini', title: 'Tastenkürzel & Info', onclick: showHelp }, '?'),
  ),
);

const deckWrap = h('div', { class: 'decks' });
const app = h('div', { class: 'app' }, header, deckWrap);
document.body.appendChild(app);

const panelA = DeckPanel(mixer.decks.A, { onZap: (d) => zapDeck(d), onEject: eject, accent: 'a' });
const panelB = DeckPanel(mixer.decks.B, { onZap: (d) => zapDeck(d), onEject: eject, accent: 'b' });
deckWrap.appendChild(panelA.root);
deckWrap.appendChild(panelB.root);

const strip = MixerStrip(mixer, { onPublishSet: publishCurrentSet, onSettings: showSettings, onOutputs: showOutputMenu });
app.appendChild(strip.root);

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
    if (s === 'skip-error' && automix.lastError) toast(`Automix übersprungen: ${automix.lastError}`, 'warn');
    if (s === 'empty') toast('Automix hat keine Tracks — erst eine Liste laden.', 'warn');
  },
});

const automixBar = AutomixBar(automix, {
  onQueueFromBrowser: () => {
    const items = browser.currentItems();
    automix.setQueue(items);
    toast(items.length ? `${items.length} Tracks in die Automix-Queue übernommen.` : 'Die Liste ist leer.', items.length ? 'ok' : 'warn');
  },
});

app.appendChild(automixBar.root);
app.appendChild(browser.root);

const capBanner = h('div', { class: 'cap-banner' });
app.insertBefore(capBanner, deckWrap);

// Drop an audio file straight onto a deck — the fastest way to play local music.
for (const [id, panel] of [['A', panelA], ['B', panelB]]) {
  const root = panel.root;
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
    if (file) loadIntoDeck(id, trackFromFile(file));
  });
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
        toast(`SYNC Deck ${id} gelöst.`, 'ok');
        return;
      }
      const other = mixer.decks[id === 'A' ? 'B' : 'A'];
      if (!other.effectiveBpm) return toast('Das andere Deck hat keine BPM.', 'warn');
      const target = other.effectiveBpm;
      const ok = deck.syncTo(other);
      const panel = id === 'A' ? panelA : panelB;
      panel.tempoFader.value = String(deck.tempo);
      if (ok) deck.setSynced(other);
      toast(ok
        ? `Deck ${id} SYNC auf ${target.toFixed(1)} BPM — Phase wird gehalten.`
        : `Nicht erreichbar im ±${deck.tempoRange}%-Bereich.`, ok ? 'ok' : 'warn');
    }
    if (what === 'drop-request') {
      const other = mixer.decks[id === 'A' ? 'B' : 'A'];
      const r = deck.armDrop(other);
      const panel = id === 'A' ? panelA : panelB;
      panel.tempoFader.value = String(deck.tempo);
      if (r === 'cancelled') toast(`Drop Deck ${id} abgebrochen.`, 'ok');
      else if (r) toast(`Deck ${id} droppt auf der nächsten 1 von Deck ${id === 'A' ? 'B' : 'A'}.`, 'ok');
      else toast('Drop braucht ein laufendes anderes Deck mit BPM und ein geladenes eigenes.', 'warn');
    }
    if (what === 'ended') {
      toast(`Deck ${id} ist durch.`, 'warn');
    }
  });
}

async function loadIntoDeck(id, track) {
  const deck = mixer.decks[id];
  mixer.ensureContext();
  toast(`Lade "${track.title}" in Deck ${id}…`);
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
  if (deck.track.localFile) return toast('Lokale Datei — kein Zap-Ziel.', 'warn');
  openZapDialog(deck.track, settings);
}

function recordPlay(track) {
  const last = setlist[setlist.length - 1];
  if (last && last.id === track.id) return;
  setlist.push(track);
}

/* ------------------------------ setlist ------------------------------ */

async function publishCurrentSet() {
  if (!setlist.length) return toast('Noch nichts gespielt.', 'warn');
  if (!caps.outbox && !caps.relay && !window.nostr) {
    return toast('Kein Publish-Kanal verfügbar (weder outbox/relay noch NIP-07).', 'bad', 6000);
  }
  const titleInput = h('input', { class: 'search-input', value: `DJ David Clanker Set`, 'aria-label': 'Titel' });
  const descInput = h('input', { class: 'search-input', placeholder: 'Beschreibung (optional)', 'aria-label': 'Beschreibung' });
  openModal({
    title: '📡 Setlist veröffentlichen',
    body: h('div', { class: 'settings' },
      h('div', { class: 'muted' }, `${setlist.length} Tracks werden als kind-30003-Set mit r-Tags publiziert.`),
      h('label', { class: 'lbl' }, 'Titel'), titleInput,
      h('label', { class: 'lbl' }, 'Beschreibung'), descInput,
      h('ol', { class: 'setlist-preview' }, ...setlist.map((t) => h('li', {}, `${t.artist} – ${t.title}`))),
    ),
    actions: [
      { label: 'Abbrechen', onClick: (close) => close() },
      {
        label: 'Veröffentlichen', primary: true, onClick: async (close) => {
          try {
            const res = await publishSetlist(setlist, { title: titleInput.value, description: descInput.value });
            close();
            toast(`Set veröffentlicht${res.eventId ? ` (${res.eventId.slice(0, 12)}…)` : ''}.`, 'ok');
          } catch (e) {
            toast(`Fehlgeschlagen: ${e.message}`, 'bad', 7000);
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
  const outMaster = h('select', { class: 'search-input', 'aria-label': 'Master-Ausgang' });
  const outCue = h('select', { class: 'search-input', 'aria-label': 'Vorhör-Ausgang' });
  const status = h('div', { class: 'muted' }, '');

  const fill = async () => {
    const outs = await mixer.listOutputs();
    for (const sel of [outMaster, outCue]) {
      clear(sel).appendChild(h('option', { value: '' }, 'Systemstandard'));
      for (const o of outs) sel.appendChild(h('option', { value: o.deviceId }, o.label));
    }
    outMaster.value = mixer.outputs.master || settings.outputMaster || '';
    outCue.value = mixer.outputs.cue || settings.outputCue || '';
    const unlabeled = outs.length && outs.every((o) => /^Ausgang \d+$/.test(o.label));
    status.textContent = !outs.length
      ? 'Keine Geräte sichtbar — dieser Browser/Host gibt die Liste nicht frei.'
      : unlabeled ? 'Gerätenamen verbirgt der Browser bis zur Freigabe (Button unten).' : '';
  };

  const apply = (which, sel) => async () => {
    const ok = await mixer.setOutputDevice(which, sel.value);
    settings[which === 'cue' ? 'outputCue' : 'outputMaster'] = sel.value;
    await store.setJson(SETTINGS_KEY, settings);
    toast(ok
      ? `${which === 'cue' ? 'Kopfhörer' : 'Master'} umgeschaltet.`
      : 'Gerätewahl nicht möglich (setSinkId fehlt oder verweigert).', ok ? 'ok' : 'warn');
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
        toast('Gerätenamen sichtbar.', 'ok');
      } catch {
        toast('Keine Freigabe — Namen bleiben verborgen.', 'warn');
      }
    },
  }, 'Gerätenamen freischalten');

  fill();
  openModal({
    title: '🔈 Sound-Ausgänge',
    body: h('div', { class: 'settings' },
      h('label', { class: 'lbl' }, 'Master (Anlage)'), outMaster,
      h('label', { class: 'lbl' }, 'Vorhören 🎧 (Kopfhörer)'), outCue,
      status,
      btnUnlock,
      h('div', { class: 'muted' }, 'Getrennte Ausgänge brauchen AudioContext.setSinkId (Chrome ≥ 110). In einer Napplet-Shell muss der Host die speaker-selection-Policy durchreichen; ohne Wahl landet der Cue-Bus auf dem Standardausgang.'),
    ),
    actions: [{ label: 'Fertig', primary: true, onClick: (close) => close() }],
  });
}

/* ------------------------------ settings ------------------------------ */

function showSettings() {
  const zapAmount = h('input', { class: 'search-input', type: 'number', min: '1', value: String(settings.zapDefault) });
  const zapMode = h('select', { class: 'search-input' },
    h('option', { value: 'lnurl', selected: settings.zapMode === 'lnurl' }, 'LNURL-pay (nichts wird signiert)'),
    h('option', { value: 'nip57', selected: settings.zapMode === 'nip57' }, 'NIP-57 (Host signiert & publiziert kind 9734)'),
  );
  const proxy = h('input', {
    class: 'search-input', value: settings.proxy,
    placeholder: 'https://proxy.example/?url={url}',
  });

  openModal({
    title: '⚙ Einstellungen',
    body: h('div', { class: 'settings' },
      h('label', { class: 'lbl' }, 'Standard-Zap (sats)'), zapAmount,
      h('label', { class: 'lbl' }, 'Zap-Modus'), zapMode,
      h('div', { class: 'muted' }, 'NIP-5D kennt keine Payment-Domain und keine reine Signier-API. Ein echter NIP-57-Zap ist nur möglich, indem der Host den 9734-Request beim Publizieren signiert — er landet dann auch auf deinen Relays.'),
      h('label', { class: 'lbl' }, 'Audio-Ausgänge'),
      h('button', { class: 'btn btn-ghost', onclick: () => showOutputMenu() }, '🔈 Sound-Ausgänge öffnen'),
      h('label', { class: 'lbl' }, 'CORS-Proxy (nur Standalone)'), proxy,
      h('div', { class: 'muted' }, 'Wavlakes Audio-CDN sendet keine CORS-Header. Im Napplet holt der Host die Bytes über resource.bytes, standalone braucht es dafür einen Proxy — sonst läuft nur der Basic-Modus.'),
      h('div', { class: 'caps' }, h('div', { class: 'side-h' }, 'Host-Domains'),
        ...Object.entries(caps).filter(([k]) => k !== 'shell').map(([k, v]) =>
          h('span', { class: `cap ${v ? 'on' : 'off'}` }, `${v ? '✓' : '×'} ${k}`)),
      ),
    ),
    actions: [
      { label: 'Schließen', onClick: (close) => close() },
      {
        label: 'Speichern', primary: true, onClick: async (close) => {
          settings.zapDefault = Math.max(1, parseInt(zapAmount.value, 10) || 210);
          settings.zapMode = zapMode.value;
          settings.proxy = proxy.value.trim();
          mixer.proxy = settings.proxy;
          await store.setJson(SETTINGS_KEY, settings);
          close();
          toast('Gespeichert.', 'ok');
        },
      },
    ],
  });
}

function showHelp() {
  const keys = [
    ['Q / P', 'Deck A / B Play-Pause'],
    ['W / O', 'Deck A / B Cue'],
    ['X', 'Automix an / aus'],
    ['N', 'Automix: jetzt überblenden'],
    ['S / L', 'Deck A / B Rewind — halten, wird schneller'],
    ['V / B', 'Deck A / B zwischen VINYL und CDJ umschalten'],
    ['E / I', 'Deck A / B Vorhören (🎧 Cue-Bus)'],
    ['F / G', 'Deck A FX-Slot 1 / 2'],
    ['H / J', 'Deck B FX-Slot 1 / 2'],
    [', / .', 'Crossfader nach links / rechts'],
    ['M', 'Crossfader mittig'],
    ['1 / 2', 'Deck A / B SYNC-Latch (BPM + Phase halten)'],
    ['3 / 4', 'Deck A / B DROP: auf der nächsten Takt-1 des anderen Decks starten'],
    ['← / →', 'Deck A um 5 s spulen (mit Alt: Deck B)'],
    ['Doppelklick', 'Track in Deck A laden'],
  ];
  openModal({
    title: 'DJ David Clanker',
    body: h('div', { class: 'settings' },
      h('div', { class: 'muted' }, 'Zwei-Deck-Mixer für Wavlake-Musik, gebaut als NIP-5D-Napplet. Musik kommt aus den Wavlake-Charts, der Katalogsuche, deinem Crate und kind-30003-Playlists von Nostr. Jeder Track hat einen Value4Value-Zap-Button.'),
      h('div', { class: 'side-h' }, 'Vinyl'),
      h('div', { class: 'muted' }, 'Im VINYL-Modus ist der Teller ein Plattenteller: ziehen scratcht das Audio vorwärts und rückwärts, Stop bremst hörbar aus, Start läuft hoch. CDJ-Modus startet sofort, der Teller macht dann nur Pitchbend. Rewind wird umso schneller, je länger du hältst — kurz antippen gibt einen Stotterer, lange halten einen kompletten Backspin.'),
      h('div', { class: 'side-h' }, 'Automix'),
      h('div', { class: 'muted' }, 'Übernimmt die Liste aus dem Browser, lädt den nächsten Track rechtzeitig aufs freie Deck, zieht ihn auf die BPM und blendet im Outro über. Du kannst jederzeit dazwischenfahren — Automix nutzt dieselben Bedienelemente wie du.'),
      h('div', { class: 'side-h' }, 'FX'),
      h('div', { class: 'muted' }, 'Fünf Insert-Effekte pro Deck — Flanger, Phaser, Gater, Echo, Reverb — hinter dem Filter. Zwei Slots wählen per Dropdown, welche beiden die FX-Buttons (und F/G bzw. H/J) schalten. Gater und Echo laufen tempo-synchron auf der BPM des Decks.'),
      h('div', { class: 'side-h' }, 'Tasten'),
      h('table', { class: 'keys' }, ...keys.map(([k, d]) => h('tr', {}, h('td', {}, k), h('td', {}, d)))),
      h('div', { class: 'side-h' }, 'Modi'),
      h('div', { class: 'muted' }, 'FULL = Samples liegen dekodiert vor: EQ, Filter, FX, Scratch, Waveform, BPM-Erkennung. BASIC = nur <audio>-Streaming: Crossfade über Lautstärke und Tempo über playbackRate — kein EQ, kein FX, kein Scratch.'),
    ),
    actions: [{ label: 'Alles klar', primary: true, onClick: (close) => close() }],
  });
}

/* ------------------------------ capability banner ------------------------------ */

function updateCapBanner() {
  clear(capBanner);
  const msgs = [];
  if (!inShell()) {
    msgs.push('Standalone-Modus: kein NIP-5D-Host. Zaps laufen über WebLN bzw. externe Wallet, Nostr-Publishing über eine NIP-07-Extension.');
  }
  if (!caps.resource && !inShell()) {
    msgs.push('Ohne Host-resource-Domain und ohne CORS-Proxy bleibt Audio im BASIC-Modus (kein EQ/Filter/Waveform).');
  }
  if (inShell() && !caps.resource) {
    msgs.push('Dieser Host stellt die resource-Domain nicht bereit — im Sandbox-Iframe ist damit kein Audio erreichbar.');
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
// reachable makes the platter/FX behaviour testable from the outside.
window.__djclanker = { mixer, decks: mixer.decks, settings, automix, browser };

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
    identityEl.textContent = npub ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : 'nicht angemeldet';
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
