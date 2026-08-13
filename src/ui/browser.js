import { h, clear, fmtTime, fmtSats } from './dom.js';
import * as wl from '../lib/wavlake.js';
import { loadPlaylists, resolvePlaylist } from '../lib/nostr.js';
import { store } from '../lib/nap.js';
import { setImage } from '../lib/artwork.js';
import { trackFromFile } from '../lib/localtracks.js';
import { getAnalysis, trackCacheId } from '../lib/analysiscache.js';
import { subsonicConfigured, subsonicPing, subsonicSearch, subsonicRandom } from '../lib/subsonic.js';
import {
  audiusTrending, audiusSearch, jamendoConfigured, jamendoSearch,
  archiveSearch, archiveItem,
} from '../lib/discover.js';
import { camelotFor } from '../audio/analyze.js';

/** "124 · 8B" chip when the track's analysis is cached; null otherwise. */
function keyBpmChip(t) {
  const e = getAnalysis(trackCacheId(t));
  if (!e || !(e.bpm > 0)) return null;
  const cam = e.k && e.k[0] >= 0 ? camelotFor(e.k[0], e.k[1] === 0 ? 'major' : 'minor') : '';
  return h('span', { class: 'row-keybpm', title: 'Analyzed: BPM · Camelot key' },
    `${Math.round(e.bpm)}${cam ? ` · ${cam}` : ''}`);
}

const CRATE_KEY = 'crate.v1';

/**
 * Track browser with four sources: Wavlake charts, catalog search, a saved
 * crate (single tracks as playlist + artists/albums as sources), and
 * kind-30003 sets from Nostr.
 */
export function Browser({ onLoadDeck, onZap, capabilities, settings = {} }) {
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
    'aria-label': 'Search Wavlake',
    onkeydown: (e) => { if (e.key === 'Enter') runSearch(); },
  });

  const npubInput = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'npub… (empty = your own profile)',
    'aria-label': 'Nostr pubkey',
  });

  const tabs = [
    ['charts', 'Charts'],
    ['search', 'Search'],
    ['server', 'Server'],
    ['discover', 'Discover'],
    ['crate', 'Crate'],
    ['nostr', 'Nostr'],
  ].map(([key, label]) =>
    h('button', {
      class: 'tab',
      onclick: () => {
        tab = key;
        listEpoch++; // whatever is still in flight belongs to the old tab
        renderSide();
        if (key === 'charts') loadCharts(40);
        else if (key === 'crate') showCrateHome();
        else if (key === 'server') showServerHome();
        else if (key === 'discover') showDiscoverHome();
        else renderList();
      },
    }, label),
  );

  /* ----------------------------- discover ----------------------------- */
  // Spontaneous sources by role: Audius (open API, DJ catalog), Jamendo
  // (Creative Commons — clean for public sets), Archive.org (netlabels and
  // live sets; searching yields ITEMS, resolving one yields its tracks).

  let archiveItems = [];
  let autoPromoteArchive = true;

  const audiusInput = h('input', {
    class: 'search-input audius-search', type: 'text', placeholder: 'Search Audius…',
    'aria-label': 'Audius search',
    onkeydown: (e) => { if (e.key === 'Enter') runAudiusSearch(); },
  });
  const jamendoInput = h('input', {
    class: 'search-input jamendo-search', type: 'text', placeholder: 'Search Jamendo (CC)…',
    'aria-label': 'Jamendo search',
    onkeydown: (e) => { if (e.key === 'Enter') runJamendoSearch(); },
  });
  const archiveInput = h('input', {
    class: 'search-input archive-search', type: 'text', placeholder: 'Search Archive.org…',
    'aria-label': 'Archive search',
    onkeydown: (e) => { if (e.key === 'Enter') runArchiveSearch(); },
  });

  function showDiscoverHome() {
    setItems([], 'Discover',
      'Audius trending, Jamendo CC and Archive.org netlabels — pick a source on the left. ⤴ sends a find into the crate pipeline.');
    renderList();
  }

  function runAudiusTrending() {
    const stale = beginList();
    guard(async () => {
      const tracks = await audiusTrending();
      if (stale()) return;
      setItems(tracks, 'Audius · Trending', `${tracks.length} tracks`);
    }, 'Audius');
  }

  function runAudiusSearch() {
    const q = audiusInput.value.trim();
    if (!q) return;
    const stale = beginList();
    guard(async () => {
      const tracks = await audiusSearch(q);
      if (stale()) return;
      setItems(tracks, `Audius: ${q}`, `${tracks.length} tracks`);
    }, 'Audius');
  }

  function runJamendoSearch() {
    const q = jamendoInput.value.trim();
    if (!q || !jamendoConfigured(settings)) return;
    const stale = beginList();
    guard(async () => {
      const tracks = await jamendoSearch(settings, q);
      if (stale()) return;
      setItems(tracks, `Jamendo: ${q}`, `${tracks.length} CC tracks`);
    }, 'Jamendo');
  }

  function runArchiveSearch() {
    const q = archiveInput.value.trim();
    if (!q) return;
    const stale = beginList();
    guard(async () => {
      archiveItems = await archiveSearch(q);
      if (stale()) return;
      renderSide();
      setItems([], `Archive: ${q}`,
        `${archiveItems.length} items — open one on the left to list its tracks`);
    }, 'Archive');
  }

  function openArchiveItem(item) {
    const stale = beginList();
    guard(async () => {
      const tracks = await archiveItem(item.identifier);
      if (stale()) return;
      setItems(tracks, item.title, `${tracks.length} tracks · ${item.creator || 'archive.org'}`);
    }, 'Archive');
  }

  // The self-hosted media server (Navidrome / any Subsonic API) — the single
  // source of truth for play-ready material.
  const serverSearch = h('input', {
    class: 'search-input server-search', type: 'text', placeholder: 'Search the crate server…',
    'aria-label': 'Server search',
    onkeydown: (e) => { if (e.key === 'Enter') runServerSearch(); },
  });

  function runServerSearch() {
    const q = serverSearch.value.trim();
    if (!q) return;
    const stale = beginList();
    guard(async () => {
      const tracks = await subsonicSearch(settings, q);
      if (stale()) return;
      setItems(tracks, `Server: ${q}`, `${tracks.length} tracks from your library`);
    }, 'Server');
  }

  function showServerHome() {
    if (!subsonicConfigured(settings)) {
      setItems([], 'Media server', 'Set server URL, user and password in ⚙ settings first.');
      renderList();
      return;
    }
    const stale = beginList();
    guard(async () => {
      await subsonicPing(settings);
      const tracks = await subsonicRandom(settings, 30);
      if (stale()) return;
      setItems(tracks, 'Crate server', `${tracks.length} random from your library — search on the left`);
    }, 'Server');
  }

  // Local files accumulate for the session — every pick or deck drop joins
  // the list, so earlier files stay reachable without re-picking. (File
  // handles cannot be persisted through the storage domain, so the list
  // lives and dies with the page.)
  const localList = [];

  function addLocalTracks(tracks) {
    for (const t of tracks) {
      if (t && t.localFile && !localList.some((x) => x.title === t.title && x.artist === t.artist)) {
        localList.push(t);
      }
    }
    renderSide();
  }

  function showLocal() {
    setItems([...localList], 'Local files', `${localList.length} this session — they stay on your machine, no upload`);
    renderList();
  }

  const localInput = h('input', {
    class: 'local-input',
    type: 'file',
    accept: 'audio/*,.mp3,.wav,.flac,.ogg,.m4a',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      const files = [...localInput.files];
      if (!files.length) return;
      addLocalTracks(files.map(trackFromFile));
      showLocal();
      localInput.value = '';
    },
  });
  const btnLocal = h('button', {
    class: 'btn btn-mini btn-local',
    title: 'Open local audio files (or drop them straight onto a deck)',
    onclick: () => localInput.click(),
  }, '📁 LOCAL');

  const root = h('div', { class: 'browser' },
    h('div', { class: 'browser-tabs' }, ...tabs, h('span', { class: 'tabs-spacer' }), btnLocal, localInput),
    h('div', { class: 'browser-main' }, sideEl, h('div', { class: 'browser-results' }, headEl, statusEl, list)),
  );

  /* ------------------------------ helpers ------------------------------ */

  // Late async responses must not stomp the current list: every list request
  // takes an epoch, and a response only lands while its epoch is newest.
  // (Found the hard way: the boot-time charts fetch replaced the Server tab's
  // rows mid-test, and a click landed on a chart track.)
  let listEpoch = 0;
  const beginList = () => {
    const ep = ++listEpoch;
    return () => ep !== listEpoch;
  };

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
    const stale = beginList();
    await guard(async () => {
      const tracks = await wl.topTracks(limit);
      if (stale()) return;
      setItems(tracks, `Wavlake Top ${limit}`, 'Ranked by sats over the last 7 days');
    }, 'Charts');
  }

  async function loadNew() {
    const stale = beginList();
    await guard(async () => {
      const tracks = await wl.newTracks();
      if (stale()) return;
      setItems(tracks, 'New on Wavlake', '');
    }, 'New');
  }

  async function loadRandom(genre) {
    const stale = beginList();
    await guard(async () => {
      const tracks = await wl.randomTracks(genre && genre.id);
      if (stale()) return;
      setItems(tracks, genre ? `Random · ${genre.name}` : 'Random', `${tracks.length} tracks`);
    }, 'Random');
  }

  async function runSearch() {
    const term = searchInput.value.trim();
    if (!term) return;
    const stale = beginList();
    await guard(async () => {
      const res = await wl.search(term);
      if (stale()) return;
      setItems(res.tracks, `Search: ${term}`, `${res.tracks.length} tracks, ${res.artists.length} artists, ${res.albums.length} albums`);
      renderSearchSide(res);
    }, 'Search');
  }

  async function openArtist(a) {
    const stale = beginList();
    await guard(async () => {
      const tracks = await wl.artistTracks(a.id);
      if (stale()) return;
      setItems(tracks, a.name, `${tracks.length} tracks`);
    }, 'Artist');
  }

  async function openAlbum(al) {
    const stale = beginList();
    await guard(async () => {
      const tracks = await wl.albumTracks(al.id);
      if (stale()) return;
      setItems(tracks, al.name, `${tracks.length} tracks`);
    }, 'Album');
  }

  async function loadNostrPlaylists() {
    const stale = beginList();
    await guard(async () => {
      const key = npubInput.value.trim();
      const pls = await loadPlaylists(key || undefined);
      if (stale()) return;
      renderNostrSide(pls);
      if (!pls.length) {
        setItems([], 'Nostr playlists', capabilities.outbox || capabilities.relay
          ? 'No sets with Wavlake tracks found (kind 30003).'
          : 'No relay access — this host provides neither outbox nor relay.');
      } else {
        setItems([], 'Nostr playlists', `${pls.length} sets found — pick one on the left`);
      }
    }, 'Nostr');
  }

  async function openPlaylist(pl) {
    const stale = beginList();
    await guard(async () => {
      const tracks = await resolvePlaylist(pl);
      if (stale()) return;
      setItems(tracks, pl.title, `${tracks.length} of ${pl.trackIds.length} entries resolved`);
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
    setItems(pl, 'Playlist', `${pl.length} tracks in the crate`);
    renderList();
  }

  function showCrateHome() {
    if (playlistTracks().length) showPlaylist();
    else renderList();
  }

  /* ------------------------------ rendering ------------------------------ */

  function renderStatus() {
    clear(statusEl);
    if (busy) statusEl.appendChild(h('div', { class: 'status busy' }, 'Loading…'));
    else if (error) statusEl.appendChild(h('div', { class: 'status bad' }, error));
  }

  function trackRow(t, index) {
    const toDeck = (id) => h('button', {
      class: `btn btn-load load-${id.toLowerCase()}`,
      title: `Load into deck ${id}`,
      onclick: (e) => { e.stopPropagation(); onLoadDeck(id, t); maybeAutoPromote(t); },
    }, id);

    return h('div', { class: 'track-row', ondblclick: () => { onLoadDeck('A', t); maybeAutoPromote(t); } },
      h('span', { class: 'row-n' }, String(index + 1)),
      t.artworkUrl
        ? setImage(h('img', { class: 'row-art', alt: '' }), t.artworkUrl)
        : h('div', { class: 'row-art row-art-ph' }, '♪'),
      h('div', { class: 'row-meta' },
        h('div', { class: 'row-title' }, t.title),
        h('div', { class: 'row-artist' }, t.artist),
      ),
      h('div', { class: 'row-stats' },
        keyBpmChip(t),
        h('span', { class: 'row-dur' }, fmtTime(t.duration)),
        t.sats7d ? h('span', { class: 'row-sats', title: 'Sats over the last 7 days' }, `⚡${fmtSats(t.sats7d)}`) : null,
      ),
      h('div', { class: 'row-actions' },
        canPromote(t) ? ingestButton(t) : null,
        h('button', {
          class: 'btn btn-mini btn-addpl',
          title: t.localFile ? 'Local files stay out of the playlist' : 'Add to playlist',
          disabled: Boolean(t.localFile),
          onclick: (e) => { e.stopPropagation(); addTracksToCrate([t]); },
        }, '+'),
        h('button', {
          class: 'btn btn-zap-mini',
          title: t.localFile ? 'Local file — no zap target' : 'Zap the artist',
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
          class: 'btn btn-mini btn-addall', title: 'Add every listed track to the playlist',
          onclick: async () => {
            const n = await addTracksToCrate(items);
            sub = n ? `${n} added to playlist` : 'All already in the playlist';
            renderList();
          },
        }, '+ all → playlist'));
      }
    }
    clear(list);
    if (!items.length && !busy) {
      list.appendChild(h('div', { class: 'empty' }, 'Nothing to show.'));
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((t, i) => frag.appendChild(trackRow(t, i)));
    list.appendChild(frag);
  }

  function chip(label, onclick, extra) {
    return h('button', { class: `chip ${extra || ''}`, onclick }, label);
  }

  /**
   * "Send this track into the crate": local files upload as multipart, URL
   * tracks (Audius / Jamendo / Archive finds) go as POST /ingest/url with
   * artist/title riding along for the tag fallback. Either way the ingest
   * pipeline (loudness → tags → library) makes the track permanent on the
   * media server. Direct fetch — the service answers CORS; a strict napplet
   * host without an egress bridge simply hides the button.
   */
  async function promoteTrack(t) {
    if (t.localFile) {
      const form = new FormData();
      form.append('file', t.localFile, t.localFile.name);
      const res = await fetch(`${settings.ingestUrl}/ingest`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return;
    }
    const res = await fetch(`${settings.ingestUrl}/ingest/url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: t.streamUrls[0], artist: t.artist, title: t.title }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  }

  const canPromote = (t) => Boolean(settings.ingestUrl)
    && (t.localFile || (t.streamUrls && t.streamUrls.length && t.source && t.source !== 'subsonic'));

  function ingestButton(t) {
    const b = h('button', {
      class: 'btn btn-mini btn-ingest',
      title: 'Send to the crate pipeline (loudness, tags, library)',
      onclick: async (e) => {
        e.stopPropagation();
        b.disabled = true;
        b.textContent = '…';
        try {
          await promoteTrack(t);
          b.textContent = '✓';
          b.title = 'Queued for the crate — it appears on the server after processing';
        } catch (err) {
          b.textContent = '✗';
          b.disabled = false;
          b.title = `Send failed: ${err.message || err}`;
        }
      },
    }, '⤴');
    return b;
  }

  /** Discovery → crate: loading an Archive find onto a deck promotes it. */
  function maybeAutoPromote(t) {
    if (autoPromoteArchive && t.source === 'archive' && settings.ingestUrl) {
      promoteTrack(t).catch(() => { /* discovery must keep playing regardless */ });
    }
  }

  function renderSide() {
    for (let i = 0; i < tabs.length; i++) {
      const key = ['charts', 'search', 'server', 'discover', 'crate', 'nostr'][i];
      tabs[i].classList.toggle('on', key === tab);
    }
    clear(sideEl);
    if (tab === 'charts') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Lists'),
        chip('Top 40', () => loadCharts(40)),
        chip('Top 100', () => loadCharts(100)),
        chip('New', () => loadNew()),
        chip('Random', () => loadRandom(null)),
      ));
      const g = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, 'Genres'));
      if (!genreList.length) {
        wl.genres().then((rows) => { genreList = rows; renderSide(); }).catch(() => {});
        g.appendChild(h('div', { class: 'muted' }, 'loading…'));
      } else {
        for (const gen of genreList.slice(0, 24)) g.appendChild(chip(`${gen.name}`, () => loadRandom(gen)));
      }
      sideEl.appendChild(g);
    } else if (tab === 'search') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Search Wavlake'),
        searchInput,
        h('button', { class: 'btn btn-primary', onclick: runSearch }, 'Search'),
      ));
      if (sideEl._searchExtra) sideEl.appendChild(sideEl._searchExtra);
    } else if (tab === 'crate') {
      const trackEntries = crate.filter((c) => c.type === 'track');
      const g = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, `Playlist (${trackEntries.length})`));
      if (!trackEntries.length) {
        g.appendChild(h('div', { class: 'muted' }, 'Empty. In any list, "+" drops a track here, "+ all" the whole list.'));
      } else {
        for (const c of trackEntries) {
          g.appendChild(h('div', { class: 'crate-row' },
            chip(`♪ ${c.name}`, showPlaylist),
            h('button', {
              class: 'btn btn-mini', title: 'Remove',
              onclick: async () => { await removeFromCrate(c); if (heading === 'Playlist') showPlaylist(); },
            }, '×'),
          ));
        }
        g.appendChild(h('button', { class: 'btn btn-ghost', onclick: showPlaylist }, 'Show playlist'));
      }
      sideEl.appendChild(g);

      const sources = crate.filter((c) => c.type !== 'track');
      const g2 = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, 'Sources'));
      if (!sources.length) {
        g2.appendChild(h('div', { class: 'muted' }, 'Save artists/albums from search with "+ Crate".'));
      } else {
        for (const c of sources) {
          g2.appendChild(h('div', { class: 'crate-row' },
            chip(`${c.type === 'artist' ? '👤' : '💿'} ${c.name}`, () => (c.type === 'artist' ? openArtist(c) : openAlbum(c))),
            h('button', { class: 'btn btn-mini', title: 'Remove', onclick: () => removeFromCrate(c) }, '×'),
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
            setItems(all, 'All sources', `${all.length} tracks from ${sources.length} entries`);
          }, 'Crate'),
        }, 'Load all'));
      }
      sideEl.appendChild(g2);

      if (localList.length) {
        const g3 = h('div', { class: 'side-group' }, h('div', { class: 'side-h' }, `Local files (${localList.length})`));
        for (const t of localList.slice(0, 20)) {
          g3.appendChild(chip(`📁 ${t.title}`, showLocal));
        }
        g3.appendChild(h('button', { class: 'btn btn-ghost', onclick: showLocal }, 'Show local files'));
        sideEl.appendChild(g3);
      }
    } else if (tab === 'server') {
      const ok = subsonicConfigured(settings);
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Navidrome / Subsonic'),
        serverSearch,
        h('button', { class: 'btn btn-primary', onclick: runServerSearch, disabled: !ok }, 'Search'),
        chip('🎲 Random 30', showServerHome),
        ok
          ? h('div', { class: 'muted' }, new URL(settings.subsonicUrl).host)
          : h('div', { class: 'muted' }, 'Not configured — ⚙ settings.'),
      ));
    } else if (tab === 'discover') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Audius'),
        audiusInput,
        h('button', { class: 'btn btn-primary', onclick: runAudiusSearch }, 'Search'),
        chip('🔥 Trending', runAudiusTrending),
      ));
      const jm = h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Jamendo (CC)'),
        jamendoInput,
        h('button', { class: 'btn btn-primary', onclick: runJamendoSearch, disabled: !jamendoConfigured(settings) }, 'Search'),
      );
      if (!jamendoConfigured(settings)) {
        jm.appendChild(h('div', { class: 'muted jamendo-hint' }, 'Needs a free client_id — ⚙ settings.'));
      }
      sideEl.appendChild(jm);
      const ar = h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Archive.org'),
        archiveInput,
        h('button', { class: 'btn btn-primary', onclick: runArchiveSearch }, 'Search'),
        chip(autoPromoteArchive ? '⤴ AUTO→CRATE on' : '⤴ auto→crate off', () => {
          autoPromoteArchive = !autoPromoteArchive;
          renderSide();
        }, autoPromoteArchive ? 'on' : ''),
      );
      for (const item of archiveItems.slice(0, 12)) {
        ar.appendChild(chip(`💿 ${item.title.slice(0, 34)}`, () => openArchiveItem(item)));
      }
      sideEl.appendChild(ar);
    } else if (tab === 'nostr') {
      sideEl.appendChild(h('div', { class: 'side-group' },
        h('div', { class: 'side-h' }, 'Playlists (kind 30003)'),
        npubInput,
        h('button', { class: 'btn btn-primary', onclick: loadNostrPlaylists }, 'Load'),
        sideEl._nostrExtra || h('div', { class: 'muted' }, 'Sets containing Wavlake links get resolved.'),
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
          h('button', { class: 'btn btn-mini', title: 'Save to crate', onclick: () => addToCrate({ type: 'artist', id: a.id, name: a.name }) }, '+'),
        ));
      }
    }
    if (res.albums.length) {
      extra.appendChild(h('div', { class: 'side-h' }, 'Albums'));
      for (const al of res.albums.slice(0, 12)) {
        extra.appendChild(h('div', { class: 'crate-row' },
          chip(al.name, () => openAlbum(al)),
          h('button', { class: 'btn btn-mini', title: 'Save to crate', onclick: () => addToCrate({ type: 'album', id: al.id, name: al.name }) }, '+'),
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

  return { root, currentItems, addToCrate, loadCharts, addLocalTracks };
}
