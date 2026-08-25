/**
 * DJ David Clanker · Totem — the house DJ on a 480x320 resistive panel.
 *
 * Two screens, one engine: AUTO MIX (the show) and PLAYLIST (what plays
 * next), switched by two 44px tabs. Nothing scrolls — the queue pages three
 * rows at a time — and no control is smaller than the shell's 44px corner
 * switcher. The full two-deck mixer stays in the desktop build; this face
 * drives the same Mixer + Automix the big one does, so the mix is real.
 *
 * Gimmicks, all honest: the cover spins only while the deck actually plays,
 * the 600B matrix rain fills the disc when nothing does, and the status
 * ticker "decrypts" every state change exactly like the desktop bar.
 */
import './totem.css';

import { Mixer } from '../audio/engine.js';
import { Automix } from '../audio/automix.js';
import { h, clear, scrambleTo } from '../ui/dom.js';
import { MatrixRain } from '../ui/rain.js';
import { fetchObjectUrl } from '../lib/nap.js';
import { topTracks } from '../lib/wavlake.js';
import { initCache } from '../lib/analysiscache.js';

initCache().catch(() => {});

const mixer = new Mixer();
const automix = new Automix(mixer, {
  onCrossfade: () => {},
  // The queue never runs dry on the panel: the charts refill it.
  refill: () => lastCharts.slice(),
});
automix.order = 'list';

let lastCharts = [];

/* ------------------------------- tabs ---------------------------------- */

const screens = { mix: null, playlist: null };
let active = 'mix';

function show(name) {
  active = name;
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
  tabMix.classList.toggle('on', name === 'mix');
  tabList.classList.toggle('on', name === 'playlist');
  if (name === 'playlist') renderQueue();
}

const tabMix = h('button', { class: 'tab on', onclick: () => show('mix') }, 'AUTO MIX');
const tabList = h('button', { class: 'tab', onclick: () => show('playlist') }, 'PLAYLIST');
const onAir = h('span', { class: 'onair' }, h('i'), 'OFF AIR');
const tabs = h('nav', { class: 'tabs' }, tabMix, tabList, onAir);

/* ----------------------------- auto mix -------------------------------- */

const disc = h('canvas', { class: 'disc', width: 300, height: 300 });
const discWrap = h('div', { class: 'disc-wrap' }, disc);
const title = h('strong', { class: 'now-title' }, 'DJ David Clanker');
const artist = h('span', { class: 'now-artist' }, 'the house DJ');
const statusLine = h('span', { class: 'status-label' }, 'ready');
const statusDetail = h('span', { class: 'status-detail' }, 'tap START — the charts do the rest');
const meterFill = h('div', { class: 'meter-fill' });
const meter = h('div', { class: 'meter' }, meterFill);

const btnStart = h('button', { class: 'big primary', onclick: () => startStop() }, '▶ START');
const btnSkip = h('button', { class: 'big', disabled: true, onclick: () => automix.skip() }, 'MIX NOW ▶▶');

const mixScreen = h('section', { class: 'screen mix' },
  discWrap,
  h('div', { class: 'rail' },
    h('div', { class: 'now' }, title, artist),
    h('div', { class: 'status' }, statusLine, statusDetail),
    meter,
    h('div', { class: 'mix-actions' }, btnStart, btnSkip),
  ),
);

async function startStop() {
  mixer.resumeAudio();
  if (automix.enabled) {
    automix.toggle();
    paint();
    return;
  }
  btnStart.disabled = true;
  try {
    if (automix.queue.length === 0) await loadCharts();
    if (automix.queue.length === 0) {
      scrambleTo(statusLine, 'no signal');
      statusDetail.textContent = 'the charts did not answer — try again';
      return;
    }
    automix.toggle();
  } finally {
    btnStart.disabled = false;
    paint();
  }
}

async function loadCharts() {
  scrambleTo(statusLine, 'tuning in');
  statusDetail.textContent = 'reading the Wavlake charts…';
  try {
    lastCharts = await topTracks(40);
  } catch {
    lastCharts = [];
  }
  automix.setQueue(lastCharts.slice());
  renderQueue();
}

/* ------------------------------ playlist ------------------------------- */

const PAGE = 3;
let page = 0;
const queueList = h('div', { class: 'queue' });
const pagerBack = h('button', { class: 'pager-step', onclick: () => { page = Math.max(0, page - 1); renderQueue(); } }, '‹');
const pagerDots = h('span', { class: 'pager-dots' });
const pagerForward = h('button', { class: 'pager-step', onclick: () => { page += 1; renderQueue(); } }, '›');
const pager = h('nav', { class: 'pager' }, pagerBack, pagerDots, pagerForward);

const playlistScreen = h('section', { class: 'screen playlist', hidden: true }, queueList, pager);

function upNext() {
  return automix.queue.slice(automix.cursor);
}

function renderQueue() {
  const items = upNext();
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  page = Math.min(page, pages - 1);
  clear(queueList);
  if (items.length === 0) {
    queueList.append(h('div', { class: 'empty' },
      'The queue is empty. START on the mix screen fills it from the charts.'));
  }
  const liveTrack = automix.liveDeck && automix.liveDeck.track;
  items.slice(page * PAGE, page * PAGE + PAGE).forEach((track, offset) => {
    const index = page * PAGE + offset;
    const row = h('button', {
      class: 'row' + (liveTrack && liveTrack.id === track.id ? ' live' : ''),
      // A tap promotes the track: it plays at the next transition.
      onclick: () => {
        automix.promote(track);
        renderQueue();
        scrambleTo(statusLine, 'promoted');
        statusDetail.textContent = `${track.title} plays next`;
      },
    },
      h('span', { class: 'n' }, String(index + 1).padStart(2, '0')),
      h('span', { class: 'copy' },
        h('strong', {}, track.title),
        h('span', {}, track.artist),
      ),
      h('span', { class: 'when' }, index === 0 ? 'next' : ''),
    );
    queueList.append(row);
  });
  pager.hidden = pages <= 1;
  pagerBack.disabled = page === 0;
  pagerForward.disabled = page >= pages - 1;
  clear(pagerDots);
  if (pages <= 8) {
    for (let i = 0; i < pages; i += 1) {
      pagerDots.append(h('i', { class: i === page ? 'on' : '' }));
    }
  } else {
    pagerDots.append(h('span', { class: 'count' }, `${page + 1} / ${pages}`));
  }
}

/* ------------------------------ the disc -------------------------------- */

const rain = MatrixRain();
const discCtx = disc.getContext('2d');
let coverImg = null;
let coverFor = '';
let angle = 0;

async function ensureCover(track) {
  const url = track && (track.artworkUrl || track.avatarUrl);
  if (!url || coverFor === url) return;
  coverFor = url;
  coverImg = null;
  try {
    const objectUrl = await fetchObjectUrl(url);
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    if (coverFor === url) coverImg = img;
  } catch { /* the bare disc plays on */ }
}

function drawDisc(dt, playing) {
  const size = disc.width;
  const half = size / 2;
  discCtx.clearRect(0, 0, size, size);
  if (!playing) {
    // 600B rain while the decks are quiet — the canonical idle state.
    discCtx.save();
    discCtx.beginPath();
    discCtx.arc(half, half, half - 2, 0, Math.PI * 2);
    discCtx.clip();
    rain.draw(discCtx, size, size);
    discCtx.restore();
  } else {
    if (playing) angle += dt * 1.8; // ~17 rpm of pure theatre, spin = sound
    discCtx.save();
    discCtx.translate(half, half);
    discCtx.rotate(angle);
    discCtx.beginPath();
    discCtx.arc(0, 0, half - 2, 0, Math.PI * 2);
    discCtx.fillStyle = '#0c0c0c';
    discCtx.fill();
    if (coverImg) {
      discCtx.save();
      discCtx.beginPath();
      discCtx.arc(0, 0, half * 0.52, 0, Math.PI * 2);
      discCtx.clip();
      discCtx.drawImage(coverImg, -half * 0.52, -half * 0.52, half * 1.04, half * 1.04);
      discCtx.restore();
    }
    discCtx.strokeStyle = 'rgba(255, 255, 255, .06)';
    for (let r = half * 0.6; r < half - 6; r += 7) {
      discCtx.beginPath();
      discCtx.arc(0, 0, r, 0, Math.PI * 2);
      discCtx.stroke();
    }
    discCtx.restore();
  }
  discCtx.beginPath();
  discCtx.arc(half, half, half - 1.5, 0, Math.PI * 2);
  discCtx.strokeStyle = 'rgba(255, 122, 26, .5)';
  discCtx.lineWidth = 2;
  discCtx.stroke();
}

/* ------------------------------ heartbeat ------------------------------- */

function paint() {
  btnStart.textContent = automix.enabled ? '■ STOP' : '▶ START';
  btnStart.classList.toggle('primary', !automix.enabled);
  btnSkip.disabled = !automix.enabled;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  mixer.tickAudio();
  automix.tick(dt);

  const deck = automix.liveDeck;
  const track = deck && deck.track;
  const playing = Boolean(deck && deck.playing);
  if (track) {
    if (title.textContent !== track.title) {
      title.textContent = track.title;
      artist.textContent = track.artist || '';
      renderQueue();
    }
    void ensureCover(track);
  }
  const described = automix.describe();
  scrambleTo(statusLine, described.label);
  if (statusDetail.textContent !== described.detail) statusDetail.textContent = described.detail;

  let pct = 0;
  if (automix.fade || automix.transition) pct = 100;
  else if (automix.enabled && Number.isFinite(automix.remaining) && deck && deck.duration) {
    pct = Math.min(100, (1 - Math.max(0, automix.remaining - automix.fadeSeconds) / deck.duration) * 100);
  }
  meterFill.style.width = `${pct}%`;

  onAir.classList.toggle('live', playing);
  onAir.lastChild.textContent = playing ? 'ON AIR' : 'OFF AIR';
  drawDisc(dt, playing);
  requestAnimationFrame(frame);
}

const prevStatus = automix.onStatus;
automix.onStatus = (s) => {
  prevStatus(s);
  paint();
  if (s === 'queue' || s === 'advance') renderQueue();
};

document.body.append(tabs, mixScreen, playlistScreen);
screens.mix = mixScreen;
screens.playlist = playlistScreen;
paint();
requestAnimationFrame(frame);
