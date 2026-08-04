import { h, clear, fmtTime, fmtSats } from './dom.js';
import * as wl from '../lib/wavlake.js';
import { loadPlaylists, resolvePlaylist } from '../lib/nostr.js';
import { store } from '../lib/nap.js';
import { setImage } from '../lib/artwork.js';
import { trackFromFile } from '../lib/localtracks.js';

const CRATE_KEY = 'crate.v1';

/**
 * Track browser with four sources: Wavlake charts, catalog search, a saved
 * crate (single tracks as playlist + artists/albums as sources), and
 * kind-30003 sets from Nostr.
 */
export function Browser({ onLoadDeck, onZap, capabilities }) {
  let tab = 'charts';
  let items = [];
  let heading = '';
  let sub = '';
  let busy = false;
  let error = '';
  let crate = [];
  let genreList = [];

  const list = h('div', { class: 'track-list' });
  const headEl = h('div', { class: 'browser-heading' });
  const sideEl = h('div', { class: 'browser-side' });
  const statusEl = h('div', { class: 'browser-status' });

  const searchInput = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: 'Artist, Album, Track…',
    'aria-label': 'Wavlake durchsuchen',
    onkeydown: (e) => { if (e.key === 'Enter') runSearch(); },
  });

  const npubInput = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'npub… (leer = eigenes Profil)',
    'aria-label': 'Nostr Pubkey',
  });

  const tabs = [
    ['charts', 'Charts'],
    ['search', 'Suche'],
    ['crate', 'Crate'],
    ['nostr', 'Nostr'],
  ].map(([key, label]) =>
    h('button', {
      class: 'tab',
      onclick: () => { tab = key; renderSide(); if (key === 'charts') loadCharts(40); else if (key === 'crate') showCrateHome(); else renderList(); },
    }, label),
  );

  const localInput = h('input', {
    class: 'local-input',
    type: 'file',
    accept: 'audio/*,.mp3,.wav,.flac,.ogg,.m4a',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      const files = [...localInput.files];
      if (!files.length) return;
      setItems(files.map(trackFromFile), 'Lokale Dateien', `${files.length} Dateien — bleiben auf deinem Rechner, kein Upload`);
      renderList();
      localInput.value = '';
    },
  });
  const btnLocal = h('button', {
    class: 'btn btn-mini btn-local',
    title: 'Lokale Audiodateien öffnen (oder direkt aufs Deck ziehen)',
    onclick: () => localInput.click(),
  }, '📁 LOKAL');

  const root = h('div', { class: 'browser' },
    h('div', { class: 'browser-tabs' }, ...tabs, h('span', { class: 'tabs-spacer' }), btnLocal, localInput),
    h('div', { class: 'browser-main' }, sideEl, h('div', { class: 'browser-results' }, headEl, statusEl, list)),
  );

  /* ------------------------------ helpers ------------------------------ */

  async function guard(fn, label) {
    busy = true;
    error = '';
    renderStatus();
    try {
      await fn();
    } catch (e) {
      error = `${label}: ${e.message || e}`;
    } finally {
      busy = false;
      renderStatus();
      renderList();
    }
  }

  function setItems(next, title, subtitle = '') {
    items = next || [];
    heading = title;
    sub = subtitle;
  }

  /* ------------------------------ sources ------------------------------ */

  async function loadCharts(limit = 40) {
    await guard(async () => setItems(await wl.topTracks(limit), `Wavlake Top ${limit}`, 'Sortiert nach Sats der letzten 7 Tage'), 'Charts');
  }

  async function loadNew() {
    await guard(async () => setItems(await wl.newTracks(), 'Neu auf Wavlake', ''), 'Neu');
  }

  async function loadRandom(genre) {
    await guard(async () => {
      const tracks = await wl.randomTracks(genre && genre.id);
      setItems(tracks, genre ? `Zufall · ${genre.name}` : 'Zufall', `${tracks.length} Tracks`);
    }, 'Zufall');
  }

  async function runSearch() {
    const term = searchInput.value.trim();
    if (!term) return;
    await guard(async () => {
      const res = await wl.search(term);
      setItems(res.tracks, `Suche: ${term}`, `${res.tracks.length} Tracks, ${res.artists.length} Artists, ${res.albums.length} Alben`);
      renderSearchSide(res);
    }, 'Suche');
  }

  async function openArtist(a) {
    await guard(async () => {
      const tracks = await wl.artistTracks(a.id);
      setItems(tracks, a.name, `${tracks.length} Tracks`);
    }, 'Artist');
  }

  async function openAlbum(al) {
    await guard(async () => {
      const tracks = await wl.albumTracks(al.id);
      setItems(tracks, al.name, `${tracks.length} Tracks`);
    }, 'Album');
  }

  async function loadNostrPlaylists() {
    await guard(async () => {
      const key = npubInput.value.trim();
      const pls = await loadPlaylists(key || undefined);
      renderNostrSide(pls);
      if (!pls.length) {
        setItems([], 'Nostr Playlists', capabilities.outbox || capabilities.relay
          ? 'Keine Sets mit Wavlake-Tracks gefunden (kind 30003).'
          : 'Kein Relay-Zugriff — dieser Host stellt weder outbox noch relay bereit.');
      } else {
        setItems([], 'Nostr Playlists', `${pls.length} Sets gefunden — links auswählen`);
      }
    }, 'Nostr');
  }

  async function openPlaylist(pl) {
    await guard(async () => {
      const tracks = await resolvePlaylist(pl);
      setItems(tracks, pl.title, `${tracks.length} von ${pl.trackIds.length} Einträgen aufgelöst`);
    }, 'Playlist');
  }

  /* ------------------------------ crate ------------------------------ */

  async function loadCrate() {
    crate = await store.getJson(CRATE_KEY, []);
  }

  async function saveCrate() {
    await store.setJson(CRATE_KEY, crate);
    renderSide();
  }

  async function addToCrate(entry) {
    if (crate.some((c) => c.id === entry.id && c.type === entry.type)) return;
    crate.push(entry);
    await saveCrate();
  }

  async function removeFromCrate(entry) {
    crate = crate.filter((c) => !(c.id === entry.id && c.type === entry.type));
    await saveCrate();
  }

  /** Tracks are stored whole (minus colorInfo) so the playlist stands on its own. */
  const crateTrackEntry = (t) => ({ type: 'track', id: t.id, name: t.title, track: { ...t, colorInfo: null } });

  async function addTracksToCrate(tracks) {
    // Local files stay out: a persisted File reference is dead next session.
    const fresh = tracks.filter((t) => t && t.id && !t.localFile
      && !crate.some((c) => c.type === 'track' && c.id === t.id));
    if (!fresh.length) return 0;
    crate.push(...fresh.map(crateTrackEntry));
    await saveCrate();
    return fresh.length;
  }

  const playlistTracks = () => crate.filter((c) => c.type === 'track' && c.track).map((c) => c.track);

  function showPlaylist() {
    const pl = playlistTracks();
    setItems(pl, 'Playlist', `${pl.length} Tracks im Crate`);
    renderList();
  }

  function showCrateHome() {
    if (playlistTracks().length) showPlaylist();
    else renderList();
  }

  /* ------------------------------ rendering ------------------------------ */

  function renderStatus() {
    clear(statusEl);
    if (busy) statusEl.appendChild(h('div', { class: 'status busy' }, 'Lade…'));
    else if (error) statusEl.appendChild(h('div', { class: 'status bad' }, error));
  }

  function trackRow(t, index) {
    const toDeck = (id) => h('button', {
      class: `btn btn-load load-${id.toLowerCase()}`,
      title: `In Deck ${id} laden`,
      onclick: (e) => { e.stopPropagation(); onLoadDeck(id, t); },
    }, id);

    return h('div', { class: 'track-row', ondblclick: () => onLoadDeck('A', t) },
      h('span', { class: 'row-n' }, String(index + 1)),
      t.artworkUrl
        ? setImage(h('img', { class: 'row-art', alt: '' }), t.artworkUrl)
        : h('div', { class: 'row-art row-art-ph' }, '♪'),
      h('div', { class: 'row-meta' },
        h('div', { class: 'row-title' }, t.title),
        h('div', { class: 'row-artist' }, t.artist),
      ),
      h('div', { class: 'row-stats' },
        h('span', { class: 'row-dur' }, fmtTime(t.duration)),
        t.sats7d ? h('span', { class: 'row-sats', title: 'Sats letzte 7 Tage' }, `⚡${fmtSats(t.sats7d)}`) : null,
      ),
      h('div', { class: 'row-actions' },
        h('button', {
          class: 'btn btn-mini btn-addpl',
          title: t.localFile ? 'Lokale Dateien bleiben außerhalb der Playlist' : 'Zur Playlist',
          disabled: Boolean(t.localFile),
          onclick: (e) => { e.stopPropagation(); addTracksToCrate([t]); },
        }, '+'),
        h('button', {
          class: 'btn btn-zap-mini',
          title: t.localFile ? 'Lokale Datei — kein Zap-Ziel' : 'Zap an den Artist',
          disabled: Boolean(t.localFile),
          onclick: (e) => { e.stopPropagation(); onZap(t); },
        }, '⚡'),
        toDeck('A'),
        toDeck('B'),
      ),
    );
  }

  function renderList() {
    clear(headEl);
    if (heading) {
      headEl.appendChild(h('div', { class: 'browser-h1' }, heading));
      if (sub) headEl.appendChild(h('div', { class: 'browser-h2' }, sub));
      if (items.length && heading !== 'Playlist') {
        headEl.appendChild(h('button', {
          class: 'btn btn-mini btn-addall', title: 'Alle gelisteten Tracks zur Playlist',
          onclick: async () => {
            const n = await addTracksToCrate(items);
            sub = n ? `${n} zur Playlist hinzugefügt` : 'Alle schon in der Playlist';
            renderList();
          },
        }, '+ alle → Playlist'));
      }
    }
    clear(list);
    if (!items.length && !busy) {
      list.appendChild(h('div', { class: 'empty' }, 'Nichts zu zeigen.'));
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((t, i) => frag.appendChild(trackRow(t, i)));
    list.appendChild(frag);
  }

  function chip(label, onclick, extra) {
    return h('button', { class: `chip ${extra || ''}`, onclick }, label);
  }

  function renderSide() {
    for (let i = 0; i < tabs.length; i++) {
      const key = ['charts', 'search', 'crate', 'nostr'][i];
      tabs[i].classList.toggle('on', key === tab);
    }
    clear(sideEl);
    if (tab === 'charts') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Listen'),
        chip('Top 40', () => loadCharts(40)),
        chip('Top 100', () => loadCharts(100)),
        chip('Neu', () => loadNew()),
        chip('Zufall', () => loadRandom(null)),
      ));
      const g = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, 'Genres'));
      if (!genreList.length) {
        wl.genres().then((rows) => { genreList = rows; renderSide(); }).catch(() => {});
        g.appendChild(h('div', { class: 'muted' }, 'lade…'));
      } else {
        for (const gen of genreList.slice(0, 24)) g.appendChild(chip(`${gen.name}`, () => loadRandom(gen)));
      }
      sideEl.appendChild(g);
    } else if (tab === 'search') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Wavlake durchsuchen'),
        searchInput,
        h('button', { class: 'btn btn-primary', onclick: runSearch }, 'Suchen'),
      ));
      if (sideEl._searchExtra) sideEl.appendChild(sideEl._searchExtra);
    } else if (tab === 'crate') {
      const trackEntries = crate.filter((c) => c.type === 'track');
      const g = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, `Playlist (${trackEntries.length})`));
      if (!trackEntries.length) {
        g.appendChild(h('div', { class: 'muted' }, 'Leer. In jeder Liste legt „+" einen Track hierher, „+ alle" die ganze Liste.'));
      } else {
        for (const c of trackEntries) {
          g.appendChild(h('div', { class: 'crate-row' },
            chip(`♪ ${c.name}`, showPlaylist),
            h('button', {
              class: 'btn btn-mini', title: 'Entfernen',
              onclick: async () => { await removeFromCrate(c); if (heading === 'Playlist') showPlaylist(); },
            }, '×'),
          ));
        }
        g.appendChild(h('button', { class: 'btn btn-ghost', onclick: showPlaylist }, 'Playlist anzeigen'));
      }
      sideEl.appendChild(g);

      const sources = crate.filter((c) => c.type !== 'track');
      const g2 = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, 'Quellen'));
      if (!sources.length) {
        g2.appendChild(h('div', { class: 'muted' }, 'Artists/Alben aus der Suche mit „+ Crate" merken.'));
      } else {
        for (const c of sources) {
          g2.appendChild(h('div', { class: 'crate-row' },
            chip(`${c.type === 'artist' ? '👤' : '💿'} ${c.name}`, () => (c.type === 'artist' ? openArtist(c) : openAlbum(c))),
            h('button', { class: 'btn btn-mini', title: 'Entfernen', onclick: () => removeFromCrate(c) }, '×'),
          ));
        }
        g2.appendChild(h('button', {
          class: 'btn btn-ghost',
          onclick: () => guard(async () => {
            const all = [];
            for (const c of sources) {
              const t = c.type === 'artist' ? await wl.artistTracks(c.id) : await wl.albumTracks(c.id);
              all.push(...t);
            }
            setItems(all, 'Quellen gesamt', `${all.length} Tracks aus ${sources.length} Einträgen`);
          }, 'Crate'),
        }, 'Alles laden'));
      }
      sideEl.appendChild(g2);
    } else if (tab === 'nostr') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Playlists (kind 30003)'),
        npubInput,
        h('button', { class: 'btn btn-primary', onclick: loadNostrPlaylists }, 'Laden'),
        sideEl._nostrExtra || h('div', { class: 'muted' }, 'Sets mit Wavlake-Links werden aufgelöst.'),
      ));
    }
  }

  function renderSearchSide(res) {
    const extra = h('div', { class: 'side-group' });
    if (res.artists.length) {
      extra.appendChild(h('div', { class: 'side-h' }, 'Artists'));
      for (const a of res.artists.slice(0, 12)) {
        extra.appendChild(h('div', { class: 'crate-row' },
          chip(a.name, () => openArtist(a)),
          h('button', { class: 'btn btn-mini', title: 'Zum Crate', onclick: () => addToCrate({ type: 'artist', id: a.id, name: a.name }) }, '+'),
        ));
      }
    }
    if (res.albums.length) {
      extra.appendChild(h('div', { class: 'side-h' }, 'Alben'));
      for (const al of res.albums.slice(0, 12)) {
        extra.appendChild(h('div', { class: 'crate-row' },
          chip(al.name, () => openAlbum(al)),
          h('button', { class: 'btn btn-mini', title: 'Zum Crate', onclick: () => addToCrate({ type: 'album', id: al.id, name: al.name }) }, '+'),
        ));
      }
    }
    sideEl._searchExtra = extra;
    renderSide();
  }

  function renderNostrSide(pls) {
    const extra = h('div', { class: 'side-group' });
    extra.appendChild(h('div', { class: 'side-h' }, `${pls.length} Sets`));
    for (const p of pls) {
      extra.appendChild(chip(`${p.title} (${p.trackIds.length})`, () => openPlaylist(p)));
    }
    sideEl._nostrExtra = extra;
    renderSide();
  }

  /** Everything currently listed, for "load all into a queue"-style actions. */
  const currentItems = () => items.slice();

  loadCrate().then(renderSide);
  renderSide();
  loadCharts(40);

  return { root, currentItems, addToCrate, loadCharts };
}
