import './styles.css';

import { Mixer } from './audio/engine.js';
import { Automix } from './audio/automix.js';
import { Performer } from './audio/performer.js';
import { planKeyMatch } from './audio/key.js';
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
import { trackFromFile, fetchLabTracks } from './lib/localtracks.js';

const SETTINGS_KEY = 'settings.v1';
const DEFAULTS = { zapDefault: 210, zapMode: 'lnurl', proxy: '', pitchRange: 8, outputMaster: '', outputCue: '' };

const caps = capabilities();
const mixer = new Mixer();
const settings = { ...DEFAULTS };
const setlist = [];

/* ------------------------------ shell ------------------------------ */

const identityEl = h('span', { class: 'ident' }, 'not signed in');
const modeEl = h('span', { class: 'badge' }, inShell() ? 'NAPPLET' : 'STANDALONE');

const btnPlayBoth = h('button', {
  class: 'btn btn-playboth',
  title: 'Start both decks beat-matched, hand over to automix, and begin scratching',
  onclick: () => (performer.enabled ? stopPerforming() : playBoth()),
}, '▶▶ PLAY BOTH');

const btnTempoMatch = h('button', {
  class: 'btn btn-mini btn-match',
  title: 'Pull the other deck onto the live deck\'s tempo and beat grid',
  onclick: () => tempoMatch(),
}, '⏱ TEMPO');

const btnAutoTune = h('button', {
  class: 'btn btn-mini btn-match',
  title: 'Beat-match, then bring the two decks into a compatible musical key',
  onclick: () => autoTune(),
}, '♪ AUTO TUNE');

const matchInfo = h('span', { class: 'match-info' }, '');

const header = h('header', { class: 'app-head' },
  h('div', { class: 'brand' },
    h('span', { class: 'brand-bot' }, '🤖'),
    h('span', { class: 'brand-name' }, 'DJ DAVID CLANKER'),
    h('span', { class: 'brand-sub' }, 'wavlake · v4v · two decks'),
  ),
  h('div', { class: 'head-mix' }, btnPlayBoth, btnTempoMatch, btnAutoTune, matchInfo),
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

const performer = new Performer(mixer, {
  automix,
  onCrossfade: (v) => { strip.xf.value = String(v); },
  onStatus: () => { btnPlayBoth.classList.toggle('on', performer.enabled); },
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

/* --------------------------- tempo & key matching --------------------------- */

/** Which deck leads a match: whatever the mix currently considers live. */
function matchPair() {
  const live = performer.liveDeck;
  const other = mixer.decks[live.id === 'A' ? 'B' : 'A'];
  return { live, other };
}

/**
 * Pull the other deck onto the live deck's tempo and beat grid.
 *
 * Retries rather than assuming: BPM detection finishes well after a track is
 * playable, so a match asked for immediately after loading has nothing to work
 * with yet. Returns whether it landed.
 */
/** Pitch-fader widths to try, in order. Standard DJ hardware positions. */
const TEMPO_RANGES = [8, 16, 50];

function tempoMatch({ quiet = false, tries = 14 } = {}) {
  const { live, other } = matchPair();
  if (live.status !== 'ready' || other.status !== 'ready') {
    if (!quiet) toast('Both decks need a track before they can be matched.', 'warn');
    return false;
  }

  // Not knowing a BPM yet and not being able to reach one are completely
  // different failures, and conflating them was the bug: a pair too far apart
  // to match reported "waiting for BPM detection" forever, while the BPM was
  // sitting on screen the whole time. Only the first case is worth retrying.
  if (!other.bpm || !live.effectiveBpm) {
    if (tries > 0) {
      setTimeout(() => tempoMatch({ quiet, tries: tries - 1 }), 400);
      if (!quiet) toast('Waiting for BPM detection…');
    } else if (!quiet) {
      toast('BPM detection did not produce a tempo for both decks — set one by hand.', 'warn', 7000);
    }
    return false;
  }

  // Widen the pitch fader until the gap is reachable. Tracks a long way apart
  // — a 108 BPM track against a 185 BPM one, say — need more than ±8%, and
  // refusing to reach for ±16 or ±50 is just refusing to do the job.
  const startRange = other.tempoRange;
  if (other.matchTempoTo(live, TEMPO_RANGES)) {
    other.setSynced(live);
    updateMatchInfo();
    if (!quiet) {
      const widened = other.tempoRange > startRange ? `, pitch range widened to ±${other.tempoRange}%` : '';
      toast(`Deck ${other.id} matched to ${live.effectiveBpm.toFixed(1)} BPM (${other.tempo >= 0 ? '+' : ''}${other.tempo.toFixed(1)}%${widened}).`, 'ok');
    }
    return true;
  }

  if (!quiet) {
    const gap = ((live.effectiveBpm / other.bpm - 1) * 100).toFixed(0);
    toast(`Cannot match ${other.bpm.toFixed(1)} to ${live.effectiveBpm.toFixed(1)} BPM — ${gap}% apart, beyond even ±50%.`, 'warn', 8000);
  }
  return false;
}

/**
 * Beat-match, then deal with the keys.
 *
 * These decks pitch-shift by resampling, so there is no key lock and moving a
 * track's key means moving its speed — about 6 % per semitone. Beat-matching
 * and key-matching genuinely conflict, so anything that needs more tempo than
 * the beat-match can absorb is offered rather than applied: a key clash is
 * much easier to live with than two tracks drifting apart.
 */
function autoTune({ quiet = false } = {}) {
  const { live, other } = matchPair();
  if (live.status !== 'ready' || other.status !== 'ready') {
    if (!quiet) toast('Both decks need a track before they can be tuned.', 'warn');
    return false;
  }
  if (!live.key || !other.key) {
    if (!quiet) toast('Key detection has not finished on both decks yet.');
    setTimeout(() => autoTune({ quiet: true }), 800);
    return false;
  }

  tempoMatch({ quiet: true, tries: 0 });
  const matchedPercent = other.tempo;

  const plan = planKeyMatch(live.soundingKey, other.key, {
    matchedPercent,
    tempoRange: other.tempoRange,
  });

  if (plan.action === 'retune') {
    other.setTempo(plan.tempoPercent);
    other.setSynced(live);
    if (!quiet) toast(`Keys tuned together — ${plan.reason}.`, 'ok');
  } else if (plan.action === 'offer') {
    if (!quiet) toast(`Left the beat-match alone: ${plan.reason}.`, 'warn', 7000);
  } else if (!quiet) {
    toast(`Keys: ${plan.reason}.`, plan.relation && plan.reason.startsWith('already') ? 'ok' : 'warn');
  }
  updateMatchInfo();
  return plan.action !== 'none';
}

/** Live readout next to the buttons: both decks' BPM and sounding key. */
function updateMatchInfo() {
  const { A, B } = mixer.decks;
  const one = (d) => {
    if (d.status !== 'ready') return `${d.id} —`;
    const bpm = d.effectiveBpm ? d.effectiveBpm.toFixed(1) : '…';
    const k = d.soundingKey;
    return `${d.id} ${bpm}${k ? ` ${k.camelot}` : ''}`;
  };
  const pair = A.soundingKey && B.soundingKey ? ` · ${A.harmonyWith(B).relation}` : '';
  matchInfo.textContent = `${one(A)}  ${one(B)}${pair}`;
  const ok = A.soundingKey && B.soundingKey && A.harmonyWith(B).ok;
  matchInfo.classList.toggle('ok', Boolean(ok));
}

/**
 * One button, whole set. Fills any empty deck from the lab, beat-matches B to
 * A, opens both sides of the crossfader, hands the queue to automix so tracks
 * keep coming, and puts a scratch routine and an effect on top.
 *
 * Everything it does goes through the same public methods the buttons use, so
 * grabbing a control mid-set does not desync anything — the only piece that
 * takes itself back off is the scratch routine, which yields the moment a hand
 * lands on that platter.
 */
async function playBoth() {
  const { A, B } = mixer.decks;
  // Runs inside the click, which is the gesture the AudioContext needs.
  mixer.ensureContext();
  mixer.resumeAudio();

  // Fill whatever is empty. Preferred tracks are already first in the list.
  const empty = [A, B].filter((d) => d.status !== 'ready');
  if (empty.length) {
    const pool = (await fetchLabTracks()).concat(browser.currentItems());
    const taken = new Set([A.track && A.track.id, B.track && B.track.id]);
    for (const deck of empty) {
      const track = pool.find((t) => t && !taken.has(t.id));
      if (!track) break;
      taken.add(track.id);
      await loadIntoDeck(deck.id, track);
    }
  }

  const ready = [A, B].filter((d) => d.status === 'ready');
  if (!ready.length) {
    toast('Nothing to play — drop audio into ./scratch-lab or load a list.', 'warn');
    return;
  }

  for (const d of ready) if (!d.playing) d.play();

  // Beat-match, then bring the keys together. Both retry internally, because
  // BPM and key detection finish well after a track becomes playable.
  tempoMatch({ quiet: true });
  setTimeout(() => autoTune({ quiet: true }), 1200);

  // Both audible. A hair toward A so the deck being scratched sits on top.
  setX(ready.length === 2 ? -0.12 : (ready[0].id === 'A' ? -1 : 1));

  // The performer goes first: its opening blend sets automix's allowBoth, so
  // automix adopts a live deck without stopping the one it is blended with.
  performer.intensity = 0.85;
  if (!performer.enabled) performer.start();

  // Keep the set fed once these two run out.
  const queue = (await fetchLabTracks()).concat(browser.currentItems());
  if (queue.length) automix.setQueue(queue);
  if (!automix.enabled) automix.start();

  btnPlayBoth.classList.add('on');
  toast('Both decks live and beat-locked — automix has the queue, performer is riding the fader.', 'ok');
}

/** PLAY BOTH again while it is running stops the performance, not the music. */
function stopPerforming() {
  performer.stop();
  btnPlayBoth.classList.remove('on');
  toast('Performer off — decks and automix keep running.', 'ok');
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
    ['C / K', 'Deck A / B autoscratch on / off'],
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
      h('div', { class: 'side-h' }, 'Play both, tempo and key'),
      h('div', { class: 'muted' }, 'PLAY BOTH starts both decks, beat-matches them, hands the queue to automix and turns the performer loose — blending, riding the fader, filter sweeps and the occasional scratch. It runs the tempo match and the key match for you; the two buttons beside it do each on their own. Each deck shows its Camelot key next to the BPM, and it is the key the deck is SOUNDING at, not the one detected: these decks pitch-shift by resampling, so a track pulled 6% faster to beat-match is also about a semitone sharp. That is also why AUTO TUNE will sometimes refuse — moving a key by a semitone costs about 6% tempo, and losing the beat-match is far more audible than a key clash, so anything that expensive is reported rather than applied.'),
      h('div', { class: 'side-h' }, 'Autoscratch'),
      h('div', { class: 'muted' }, 'AUTO ✳ performs a chosen scratch on the deck\'s own BPM, anchored at the cue point — set CUE on the sound you want to cut up first. The routines are grouped by what the fader is doing: Foundation leaves it open and lets the record do the work, Cuts hide the return stroke, Clicks interrupt a continuous motion (that is the whole difference between a transformer, a flare and a crab). HUMAN adds timing slop; at 0 it is a machine, and a crab in particular needs some. Touching the platter or hitting rewind takes the record straight back off it.'),
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
    case 'c': A.toggleAutoScratch(); break;
    case 'k': B.toggleAutoScratch(); break;
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
window.__djclanker = { mixer, decks: mixer.decks, settings, automix, browser, toast };

/* ------------------------------ loop ------------------------------ */

let lastFrame = 0;
let matchInfoTick = 0;
function frame(now) {
  const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  mixer.tickAudio(); // platter physics + gater scheduling
  automix.tick(dt);
  performer.tick(dt); // after automix, so it sees the settled live deck
  if (++matchInfoTick % 30 === 0) updateMatchInfo(); // twice a second is plenty
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

  // Preload the first two lab tracks onto the decks so PLAY BOTH is one click
  // from silence. Dev only — fetchLabTracks is a no-op in a built napplet.
  const lab = await fetchLabTracks();
  if (lab.length) {
    for (const [i, id] of ['A', 'B'].entries()) {
      if (lab[i] && mixer.decks[id].status !== 'ready') await loadIntoDeck(id, lab[i]);
    }
    automix.setQueue(lab);
  }

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
