import './styles.css';

import { Mixer } from './audio/engine.js';
import { Automix } from './audio/automix.js';
import { Performer } from './audio/performer.js';
import { DeckPanel, laneView, setLaneBeats } from './ui/deck.js';
import { AutomixBar } from './ui/automixbar.js';
import { MixerStrip } from './ui/mixer.js';
import { Browser } from './ui/browser.js';
import { openModal, toast } from './ui/modal.js';
import { openZapDialog } from './ui/zapmodal.js';
import { h, clear, scrambleTo } from './ui/dom.js';
import { Visualizer } from './ui/visualizer.js';
import { capabilities, store, getPublicKey, onIdentityChanged, inShell, mediaSession } from './lib/nap.js';
import { publishSetlist } from './lib/nostr.js';
import { hexToNpub } from './lib/bech32.js';
import { trackFromFile } from './lib/localtracks.js';
import { initCache } from './lib/analysiscache.js';
import { planTransition } from './audio/transition.js';
import { createPreanalyzer } from './audio/preanalyze.js';
import { createMidi } from './lib/midi.js';
import logoUrl from './assets/600.png';
import { camelotScore, bpmFoldScore, energyScore, scoreCandidate, summaryFor } from './audio/selection.js';
import { trackCacheId, getAnalysis } from './lib/analysiscache.js';
// `setlist` (below) is the session list published to Nostr; the persistent
// crate-with-cues from lib/setlist.js rides under `savedSet`.
import { initSetlist, setlist as savedSet } from './lib/setlist.js';
import { initLocalSongs, localSongs } from './lib/localsongs.js';

// Warm the analysis cache early — loads race it, and a miss only costs a
// re-analysis, so fire-and-forget is fine.
initCache().catch(() => {});
initSetlist().catch(() => {});
initLocalSongs().catch(() => {});

const SETTINGS_KEY = 'settings.v1';
const DEFAULTS = {
  zapDefault: 210, zapMode: 'lnurl', proxy: '', pitchRange: 8,
  outputMaster: '', outputCue: '',
  subsonicUrl: '', subsonicUser: '', subsonicPass: '', ingestUrl: '',
  jamendoClientId: '',
};

const caps = capabilities();
const mixer = new Mixer();
const settings = { ...DEFAULTS };
const setlist = [];

/* ------------------------------ shell ------------------------------ */

const identityEl = h('span', { class: 'ident' }, 'not signed in');
const modeEl = h('span', { class: 'badge' }, inShell() ? 'NAPPLET' : 'STANDALONE');

// ON AIR chip: names the audible deck(s), pulses only while something plays.
const onAirText = h('span', { class: 'onair-text' }, 'OFF AIR');
const onAirChip = h('span', { class: 'onair' }, h('i', { class: 'onair-dot' }), onAirText);

// Set recording: master bus → webm/opus, downloaded on stop.
const recTime = h('span', { class: 'rec-time' }, '');
const btnRec = h('button', {
  class: 'btn btn-mini btn-rec',
  title: 'Record the master output; stopping downloads the set as a webm file',
  onclick: async () => {
    if (mixer.recording) {
      const blob = await mixer.stopRecording();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `clanker-set-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('Set recording saved.', 'ok');
      }
    } else {
      mixer.ensureContext();
      if (mixer.startRecording()) toast('Recording the master — hit ● again to save.', 'ok');
      else toast('Recording not available here.', 'warn');
    }
  },
}, '● REC');

// Stage view for the beamer: waves + platter clusters only, everything
// booth-only (browser, settings noise) tucked away. `?stage=1` boots into it.
// The ZapViz-style visualizer runs behind it — automode only, like Winamp.
const vis = Visualizer(mixer);
document.body.appendChild(vis.canvas);
const applyStage = (on) => {
  document.body.classList.toggle('stage-view', on);
  btnStage.classList.toggle('on', on);
  // Draw for the stage OR a live pop-out; show on-page only in stage view.
  vis.setActive(on || Boolean(popWin && !popWin.closed), { show: on });
};
const btnStage = h('button', {
  class: 'btn btn-mini btn-stage',
  title: 'Stage view for the second screen: waves, decks and the visualizer — the crowd does not need the browser',
  onclick: () => applyStage(!document.body.classList.contains('stage-view')),
}, '⛶ STAGE');

// Pop-out visuals: the ZapViz canvas mirrored into its OWN window via
// captureStream, so the beamer gets full-screen visuals while this window
// stays the desk. Popups need a real window context — devices-mode shell or
// standalone; the plain napplet sandbox refuses window.open, same policy as
// every other media capability here.
let popWin = null;
let popTimer = 0;
function closePop() {
  clearInterval(popTimer);
  popTimer = 0;
  if (popWin && !popWin.closed) { try { popWin.close(); } catch { /* gone */ } }
  popWin = null;
  btnPop.classList.remove('on');
  const stage = document.body.classList.contains('stage-view');
  vis.setActive(stage, { show: stage });
}
function togglePop() {
  if (popWin && !popWin.closed) { closePop(); return; }
  let win = null;
  try { win = window.open('', 'clanker-visuals', 'width=960,height=540'); } catch { win = null; }
  if (!win) {
    toast('Pop-out blocked — visuals need the devices-mode shell (?devices=1) or standalone.', 'warn');
    return;
  }
  try {
    const doc = win.document;
    doc.title = 'DJ DAVID CLANKER — VISUALS';
    doc.body.style.cssText = 'margin:0;background:#0d0b09;overflow:hidden;cursor:none';
    const v = doc.createElement('video');
    v.muted = true;
    v.autoplay = true;
    v.playsInline = true;
    v.style.cssText = 'width:100vw;height:100vh;object-fit:cover;display:block';
    doc.body.appendChild(v);
    v.srcObject = vis.canvas.captureStream(30);
    v.play().catch(() => {});
  } catch {
    try { win.close(); } catch { /* opaque sandbox window */ }
    toast('Pop-out blocked — visuals need the devices-mode shell (?devices=1) or standalone.', 'warn');
    return;
  }
  popWin = win;
  btnPop.classList.add('on');
  vis.setActive(true, { show: document.body.classList.contains('stage-view') });
  // No close event crosses windows reliably — poll the flag instead.
  popTimer = setInterval(() => { if (!popWin || popWin.closed) closePop(); }, 800);
}
const btnPop = h('button', {
  class: 'btn btn-mini btn-pop',
  title: 'Visuals in their own window — drag it onto the beamer, the desk stays here',
  onclick: togglePop,
}, '⧉ 2ND');
if (new URLSearchParams(location.search).has('stage')) applyStage(true);

const header = h('header', { class: 'app-head' },
  h('div', { class: 'brand' },
    h('img', { class: 'brand-logo', src: logoUrl, alt: '600' }),
    h('span', { class: 'brand-name' }, 'DJ DAVID CLANKER'),
    h('span', { class: 'brand-sub' }, 'wavlake · v4v · two decks'),
  ),
  onAirChip,
  h('div', { class: 'head-right' }, btnStage, btnPop, btnRec, recTime, modeEl, identityEl,
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
// Wavedeck stage: the full-width parallel wave stack (lane A / divider /
// lane B) is the centerpiece; the master moved into the header; deck panels
// and the split channel strips sit below the waves.
header.insertBefore(strip.middle, header.querySelector('.head-right'));

const beatDots = [0, 1, 2, 3].map(() => h('i', { class: 'beat-dot' }));
const phaseText = h('span', { class: 'phase-text' }, 'PHASE —');
const syncChip = h('span', { class: 'sync-chip' }, 'SYNC');
const divider = h('div', { class: 'wave-divider' },
  h('span', { class: 'lbl-sub' }, 'BEAT'),
  h('span', { class: 'beat-dots' }, ...beatDots),
  phaseText,
  h('span', { class: 'divider-spacer' }),
  h('button', { class: 'btn btn-mini', title: 'Zoom both lanes out (more bars)', onclick: () => setLaneBeats(laneView.beats * 2) }, '−'),
  h('button', { class: 'btn btn-mini', title: 'Reset both lanes (8 bars)', onclick: () => setLaneBeats(32) }, '8b'),
  h('button', { class: 'btn btn-mini', title: 'Zoom both lanes in (fewer bars)', onclick: () => setLaneBeats(laneView.beats / 2) }, '+'),
  syncChip,
);

// Order per the design + the user's revision: waves only in the stack, the
// crossfader right beneath them, then the automix ticker, then one deck
// cluster per side around the mixer core.
deckWrap.appendChild(h('div', { class: 'wave-stack' }, panelA.lane, panelB.lane));
deckWrap.appendChild(divider);
deckWrap.appendChild(strip.xfRow);
deckWrap.appendChild(h('div', { class: 'stage-main' },
  panelA.top,
  h('div', { class: 'channel-wrap' },
    panelA.channelStrip,
    h('span', { class: 'core-label' }, 'MIXER CORE'),
    panelB.channelStrip),
  panelB.top));

/** Which decks are actually audible right now (playing + open crossfader). */
function audibleDecks() {
  const out = [];
  for (const id of ['A', 'B']) {
    const d = mixer.decks[id];
    if (d.playing && mixer.crossValue(id) > 0.12 && d.volume > 0.05) out.push(id);
  }
  return out;
}

let lastBeatIdx = -1;
let wasMixing = false;

function tickWavedeck() {
  const audible = audibleDecks();
  const label = audible.length ? `ON AIR · DECK ${audible.join(' + ')}` : 'OFF AIR';
  scrambleTo(onAirText, label); // decrypt-style swap, no-ops while unchanged
  onAirChip.classList.toggle('live', audible.length > 0);

  // Recording chip: red pulse + elapsed time while the master is captured.
  const rec = mixer.recording;
  btnRec.classList.toggle('on', Boolean(rec));
  const recLabel = rec
    ? `${String(Math.floor((Date.now() - rec.since) / 60000)).padStart(2, '0')}:${String(Math.floor(((Date.now() - rec.since) / 1000) % 60)).padStart(2, '0')}`
    : '';
  if (recTime.textContent !== recLabel) recTime.textContent = recLabel;

  const live = audible.length ? mixer.decks[audible[0]] : null;
  let beatIdx = -1;
  if (live && live.bpm && Number.isFinite(live.beatOffset)) {
    const beat = 60 / live.bpm;
    const anchor = Number.isFinite(live.barOffset) ? live.barOffset : live.beatOffset;
    const mod = (x, m) => ((x % m) + m) % m;
    beatIdx = Math.floor(mod(live.position - anchor, 4 * beat) / beat);
  }
  beatDots.forEach((d, i) => d.classList.toggle('on', i === beatIdx));

  // Bar-one pulse: a short glow ripple through the live platter and the
  // beat row every time the bar turns over. Pure class-flip — CSS animates.
  if (beatIdx === 0 && lastBeatIdx !== 0 && live) {
    deckWrap.classList.remove('bar-one', 'bar-one-a', 'bar-one-b');
    void deckWrap.offsetWidth; // restart the CSS animation
    deckWrap.classList.add('bar-one', `bar-one-${live.id.toLowerCase()}`);
  }
  lastBeatIdx = beatIdx;

  // Data-storm shimmer while a handover runs — and a fresh visualizer
  // preset with every scene change, Winamp-style.
  const mixingNow = Boolean(automix.transition || automix.fade);
  if (mixingNow && !wasMixing) vis.onTransition();
  wasMixing = mixingNow;
  deckWrap.classList.toggle('mixing', mixingNow);

  const latched = mixer.decks.A.syncedTo || mixer.decks.B.syncedTo;
  syncChip.classList.toggle('latched', Boolean(latched));
  syncChip.textContent = latched ? 'SYNC LATCHED' : 'SYNC';
  let phase = 'PHASE —';
  if (latched) {
    const s = mixer.decks.A.syncedTo ? mixer.decks.A : mixer.decks.B;
    const o = s.syncedTo;
    if (s.bpm && o.effectiveBpm) {
      const mod = (x, m) => ((x % m) + m) % m;
      const beat = 60 / s.effectiveBpm;
      const obeat = 60 / o.effectiveBpm;
      let err = mod(s.position - (s.beatOffset || 0), beat) / beat
        - mod(o.position - (o.beatOffset || 0), obeat) / obeat;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      phase = `PHASE ${err >= 0 ? '+' : ''}${(err * beat).toFixed(3)}s`;
    }
  }
  if (phaseText.textContent !== phase) phaseText.textContent = phase;
}

const browser = Browser({
  onLoadDeck: loadIntoDeck,
  onZap: (track) => openZapDialog(track, settings),
  capabilities: caps,
  settings,
  // ☆ grabs the live marks when the starred track is sitting on a deck.
  getDeckCues: (trackId) => {
    const d = [mixer.decks.A, mixer.decks.B]
      .find((x) => x.track && x.track.id === trackId);
    return d ? { cue: d.cuePoint || 0, hot: [...d.hotCues] } : null;
  },
  // Marker/rail source of truth — derived from live deck+automix state, no
  // second store anywhere.
  deckState: () => ({
    A: {
      trackId: mixer.decks.A.track && mixer.decks.A.track.id,
      audible: mixer.decks.A.playing && mixer.crossValue('A') > 0.12,
      playing: mixer.decks.A.playing,
    },
    B: {
      trackId: mixer.decks.B.track && mixer.decks.B.track.id,
      audible: mixer.decks.B.playing && mixer.crossValue('B') > 0.12,
      playing: mixer.decks.B.playing,
    },
    queue: automix.queue.slice(automix.cursor, automix.cursor + 200),
    queueTotal: Math.max(0, automix.queue.length - automix.cursor),
    order: automix.order,
    playedIds: automix.history.slice(-40).map((t) => t.id),
    liveSummary: (() => {
      const d = automix.liveId ? mixer.decks[automix.liveId]
        : (mixer.decks.A.playing ? mixer.decks.A : (mixer.decks.B.playing ? mixer.decks.B : null));
      if (!d || !d.bpm) return null;
      return {
        bpm: d.bpm,
        camelot: d.musicalKey ? d.musicalKey.camelot : '',
        energyOut: d.structure && d.structure.ok ? d.structure.energyOut : NaN,
      };
    })(),
  }),
  onQueueFromBrowser: () => automix.setQueue(browser.currentItems()),
  queueOps: {
    promote: (track) => automix.promote(track),
    remove: (id) => automix.removeFromQueue(id),
  },
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

// The performer rides on top of the automix: bar-synced scratches, loop
// rolls, FX bursts and blends, every one with an undo — and it lets go of
// anything a human touches.
const performer = new Performer(mixer, {
  automix,
  onCrossfade: (v) => { strip.xf.value = String(v); },
  onStatus: (s) => {
    if (s === 'on') toast('Performer on — bar-synced moves over the mix.', 'ok');
    if (s === 'off') toast('Performer off.', 'ok');
  },
});

const automixBar = AutomixBar(automix, {
  performer,
  onQueueFromBrowser: () => {
    const items = browser.currentItems();
    automix.setQueue(items);
    toast(items.length ? `${items.length} tracks taken into the automix queue.` : 'The list is empty.', items.length ? 'ok' : 'warn');
  },
});

// The ticker sits inside the stage, between the crossfader and the deck
// clusters; the browser stays the bottom block.
deckWrap.insertBefore(automixBar.root, deckWrap.querySelector('.stage-main'));
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
      // SYNC is a latch: on = match tempo once, then bend the phase in from
      // the frame loop until it is clicked off again. With a tempo master
      // set, SYNC always pulls THIS deck onto the master — and refuses on
      // the master itself, so the live tempo can never be yanked by habit.
      if (deck.syncedTo) {
        deck.setSynced(null);
        toast(`SYNC deck ${id} released.`, 'ok');
        return;
      }
      if (mixer.syncMaster === id) {
        return toast(`Deck ${id} IS the tempo master — hit SYNC on the other deck.`, 'warn');
      }
      const master = mixer.masterFor(deck);
      if (!master.effectiveBpm) return toast('The master deck has no BPM.', 'warn');
      const target = master.effectiveBpm;
      const ok = deck.syncTo(master);
      const panel = id === 'A' ? panelA : panelB;
      panel.tempoFader.value = String(deck.tempo);
      if (ok) deck.setSynced(master);
      toast(ok
        ? `Deck ${id} → master ${master.id} @ ${target.toFixed(1)} BPM — phase riding in.`
        : `Out of reach within the ±${deck.tempoRange}% range.`, ok ? 'ok' : 'warn');
    }
    if (what === 'cue') {
      // Performance marks ride with the setlist: a cue or hot cue set on a
      // listed track writes straight back (debounced persist inside).
      const t = deck.track;
      if (t && savedSet.has(t.id)) {
        savedSet.updateCues(t.id, { cue: deck.cuePoint || 0, hot: [...deck.hotCues] });
      }
    }
    if (what === 'load') {
      // A setlist track brings its marks back onto the deck. Real marks pin
      // the cue as manual; an empty record leaves the downbeat default alone.
      const t = deck.track;
      const c = t && savedSet.cuesFor(t.id);
      if (c) {
        deck.cuePoint = c.cue || 0;
        deck.hotCues = [...(c.hot || [null, null, null, null])];
        if (c.cue > 0 || deck.hotCues.some((x) => x != null)) deck._cueManual = true;
      }
    }
    if (what === 'master-request') {
      // Toggle this deck as the manual tempo master.
      const was = mixer.syncMaster;
      mixer.syncMaster = was === id ? null : id;
      if (mixer.syncMaster) {
        // The master itself must not stay latched onto anything.
        deck.setSynced(null);
        toast(`Deck ${id} is the tempo master — SYNC pulls the other deck onto it.`, 'ok');
      } else {
        toast('Tempo master released — SYNC targets the opposite deck again.', 'ok');
      }
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
  const ssUrl = h('input', {
    class: 'search-input', value: settings.subsonicUrl,
    placeholder: 'http://alflx:4533',
  });
  const ssUser = h('input', { class: 'search-input', value: settings.subsonicUser, placeholder: 'user' });
  const ssPass = h('input', {
    class: 'search-input', type: 'password', value: settings.subsonicPass, placeholder: 'password',
  });
  const ingest = h('input', {
    class: 'search-input', value: settings.ingestUrl,
    placeholder: 'http://alflx:8321',
  });
  const jamendo = h('input', {
    class: 'search-input', value: settings.jamendoClientId,
    placeholder: 'Jamendo client_id (free at devportal.jamendo.com)',
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
      h('label', { class: 'lbl' }, 'Media server (Navidrome / Subsonic)'), ssUrl, ssUser, ssPass,
      h('div', { class: 'muted' }, 'Your self-hosted library — the Server tab. Auth uses the Subsonic salt+token scheme, the password itself never travels. In the dev shell, allow the host via EXTRA_PROXY_HOSTS.'),
      h('label', { class: 'lbl' }, 'Ingest service'), ingest,
      h('div', { class: 'muted' }, 'The crate pipeline (upload → loudness → tags → library). Enables the ⤴ button on local session tracks and discovery finds.'),
      h('label', { class: 'lbl' }, 'Jamendo client_id'), jamendo,
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
          settings.subsonicUrl = ssUrl.value.trim().replace(/\/+$/, '');
          settings.subsonicUser = ssUser.value.trim();
          settings.subsonicPass = ssPass.value;
          settings.ingestUrl = ingest.value.trim().replace(/\/+$/, '');
          settings.jamendoClientId = jamendo.value.trim();
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

const preanalyzer = createPreanalyzer(mixer, automix);

// MIDI (MPD218 factory map): silent no-op where the sandbox withholds it.
const midi = createMidi({
  mixer,
  automix,
  onCrossfade: (v) => { strip.xf.value = String(v); },
  onStatus: (line) => toast(`🎹 ${line}`, 'ok'),
});
midi.connect()
  .then((names) => { if (names.length) toast(`🎹 MIDI: ${names.join(', ')}`, 'ok', 6000); })
  .catch(() => { /* strict sandbox or no WebMIDI — the UI covers everything */ });

// Debug handle: the napplet is alone in its sandbox, and having the live mixer
// reachable makes the platter/FX behaviour testable from the outside — and
// drivable: dev/live-dj.mjs runs a whole set through this handle.
window.__djclanker = {
  mixer, decks: mixer.decks, settings, automix, browser, toast, planTransition,
  preanalyzer, midi, performer, setlist: savedSet, localSongs, vis,
  selection: { camelotScore, bpmFoldScore, energyScore, scoreCandidate, summaryFor },
  analysisCache: { trackCacheId, getAnalysis },
};

/* ------------------------------ loop ------------------------------ */

let lastFrame = 0;
let lastPoke = 0;
let lastBrowserTick = 0;
// One deck's paint crashing must never freeze the sibling's controls in
// whatever disabled state the last good tick left them — isolate each panel.
const panelTickErr = { A: false, B: false };
function tickPanel(panel, id) {
  try {
    panel.tick();
  } catch (e) {
    if (!panelTickErr[id]) {
      panelTickErr[id] = true;
      console.error(`deck ${id} panel tick failed`, e);
    }
  }
}
function frame(now) {
  const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  mixer.tickAudio(); // platter physics + gater scheduling
  automix.tick(dt);
  performer.tick(dt);
  tickPanel(panelA, 'A');
  tickPanel(panelB, 'B');
  strip.tick();
  automixBar.tick();
  tickWavedeck();
  vis.tick(now);
  if (now - lastBrowserTick > 500) {
    lastBrowserTick = now;
    browser.tick(); // track markers + the UP NEXT rail, 2 Hz is plenty
  }
  if (now - lastPoke > 8000) {
    lastPoke = now;
    preanalyzer.poke(); // background queue analysis for the smart order
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Hidden-tab fallback: browsers stall requestAnimationFrame in background
// tabs, and with it every scheduled transition, gate and platter motor. A
// coarse interval keeps the AUDIO state machines running while hidden — the
// UI ticks stay skipped, nobody is looking. 100 ms is fine: the schedulers
// plan ~0.4 s ahead and crossfader steps at 10 Hz stay unobtrusive.
let bgTimer = 0;
let bgLast = 0;
mixer.bgTicks = 0;
function applyVisibility() {
  if (document.hidden && !bgTimer) {
    bgLast = performance.now();
    bgTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.3, (now - bgLast) / 1000);
      bgLast = now;
      mixer.bgTicks++;
      mixer.tickAudio();
      automix.tick(dt);
      performer.tick(dt);
    }, 100);
  } else if (!document.hidden && bgTimer) {
    clearInterval(bgTimer);
    bgTimer = 0;
    lastFrame = 0; // the rAF dt restarts clean instead of spanning the gap
  }
}
document.addEventListener('visibilitychange', applyVisibility);
// A page can BOOT hidden (background tab, minimized pane) — visibilitychange
// never fires then, rAF never runs, and without this call nothing would tick
// the audio state machines at all.
applyVisibility();

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
