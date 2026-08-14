# DJ David Clanker

A two-deck DJ mixer for [Wavlake](https://wavlake.com) music, built as a
**napplet** per [NIP-5D](https://github.com/nostr-protocol/nips/pull/2303) —
a sandboxed single-purpose app that delegates signing, storage, relays and
network access to a host shell.

```
┌────────── Host shell (NIP-5D) ──────────────────────────────┐
│  iframe srcdoc, sandbox="allow-scripts", connect-src 'none' │
│                                                             │
│   ┌── DJ David Clanker ─────────────────────────────────┐   │
│   │  Deck A ──┐                                         │   │
│   │           ├─ Crossfader ─ Master ─ Output           │   │
│   │  Deck B ──┘                                         │   │
│   │  Browser: Charts · Search · Crate · Nostr playlists │   │
│   └─────────────────────────────────────────────────────┘   │
│        │ resource.bytes        │ outbox/relay   │ link.open │
└────────┼───────────────────────┼────────────────┼───────────┘
     Wavlake API + CDN       Nostr relays     Lightning wallet
```

## Features

**Two vinyl decks**
- **Real scratching**: the platter is a record platter. Dragging moves the
  audio position 1:1 with the rotation (33⅓ rpm → half a turn = 0.9 s),
  forwards and backwards.
- **Vinyl brake and spin-up**: stop audibly brakes to a halt, start spins up.
  Switchable to CDJ mode (instant start, platter = pitch bend).
- **Dynamic rewind**: keep it held and the backspin accelerates up to −14×.
  A tap gives a stutter, holding gives a complete rewind.
- **A real disc**: canvas-drawn record with the cover as its label, grooves
  and a traveling light reflection. It spins at the *actual* rate — braking,
  backspin and hand scratching are directly visible.
- **Waveform ring** around the record: the whole track laid onto 360°,
  stationary (a co-rotating waveform is unreadable), the played part glows,
  a needle marker shows the position.
- **Wavedeck stage**: both waveforms as a mirrored, edge-to-edge pair at the
  top — always a playhead-centered zoom window (default ×8, wheel/−/+ for
  ×2–×64) over a full-track overview strip, with beat/bar markers anchored
  to the detected downbeat. Drag scrubs the wave under the fixed playhead,
  click jumps; a shared beat row (beat dots, phase, sync chip) sits under
  the seam. Empty lanes run the 600B matrix rain
- CUE with CDJ logic (set while stopped, jump back while playing), plus
  **4 hot cues** per deck: empty pad stores, set pad jumps (fires from
  stop), double-click clears — drawn as numbered ember pins on the zoom
  wave and as ticks on the overview strip
- **● REC**: record the master bus; stopping downloads the whole set as a
  webm/opus file. **⚡ SHOW**: one button arms the full autopilot — queue,
  automix with SMART order, performer riding on top
- **⛶ STAGE + visualizer**: the beamer face runs a ZapViz-style feedback
  visualizer behind the decks — auto-drifting trails, noise sparkles and
  five audio-reactive presets rotating on their own, Winamp automode style
- **Beat loops**: IN/OUT for manual loops, 1/2/4/8 snap onto the detected
  grid, EXIT leaves
- **Tempo fader** ±8 / ±16 / ±50 %, BPM detection with beat phase and 4/4
  downbeat, **SYNC** as a latch: pulls BPM *and* beat phase onto the other
  deck (incl. half/double tempo) and keeps the phase locked until released
- **Quantized DROP**: starts the deck sample-accurately on the other deck's
  next bar-1
- 3-band EQ with kill, bipolar filter sweep (LP ↔ HP), trim with auto-gain
- Channel fader plus VU meter per deck

**FX per deck** (insert after the filter) — **15 units** in a fixed rack:
flanger, phaser, chorus, gater, tremolo, autopan, drive, bitcrush, echo,
ping-pong delay (both tempo-synced), reverb, and the special filters —
telephone, auto-wah, vowel/formant morph (A–U), comb. Two switchable slots
pick which units the buttons drive; on the MPD218 it is one hand per slot:
K3/K4 turn slot 1 (the unit's primary amount — zero releases it), the FX2
pads toggle slot 2.
- **5 effects in 2 switchable slots**: flanger, phaser, gater, echo, reverb.
  A dropdown per slot picks which effect the button (or F/G/H/J) toggles;
  picking an effect already in the other slot swaps the slots.
- **Flanger**: modulated short delay with feedback — rate, depth, feedback, mix
- **Gater**: tempo-synced to the deck BPM — division 1/4…1/32, duty, depth,
  soft edges. The gain automation is scheduled 0.4 s ahead so the edges land
  sample-accurately and main-thread jitter doesn't matter.

**Waveform scopes**
- Live scope per deck, fed by its own analyser
- Large master scope behind the crossfader — shows the sum, not one deck
- Three display modes: `MIRROR` (mirrored envelope), `WAVE` (time signal),
  `BARS` (spectrum, logarithmically binned — linear FFT bins would otherwise
  waste almost the whole width on the highs)

**Auto-DJ**
- One button and the box mixes like a DJ, not like a jukebox: every track is
  analyzed for structure (intro/high/breakdown/outro), 16/32-bar phrases,
  mix-in/mix-out points and musical key (Camelot) — cached, so known tracks
  are instant
- Transitions are planned per pair: **BLEND** starts the next track
  sample-accurately on a phrase boundary at its mix-in point, kills its bass
  until the bass-swap phrase, keeps the phase latched and eases the
  crossfader; **ECHO** rides a dub tail out when the tempo gap is unreachable;
  **CUT** drops on the phrase when a track ends hot; **SPINBACK** throws the
  outgoing record hard backwards over the cut; **FADE** is the old crossfade
  and remains the fallback for anything uncertain
- AUTO carries a **seam budget**: roughly a quarter of handovers take an
  audible exit (cut/echo/spinback) instead of an invisible blend — never the
  same seam twice in a row. All blends goes flat; all cuts is exhausting
- After every handover the tempo glides back to 0 % — a set never drifts
  sharp over the night
- **SMART order** picks the next track by key compatibility, BPM closeness
  and energy continuity (LIST and SHUF still available); a background
  preanalyzer fills the cache ahead of the set
- Structure, phrase lines and mix points are drawn on the waveform; decks and
  browser rows show the key badge
- The machine **yields instantly** the moment you touch a control it is
  driving — grab the fader mid-blend and it is yours
- Switching it on mid-set adopts the running deck instead of starting over

**Turntablism**
- **20 scratch moves in three families** (ported from Zazawowow's PR #8):
  Foundation (baby, drag, scribble, 2/3-click tears, hydroplane, backspin),
  Cuts (forward, stab, chirp) and Clicks (transformer, military, 1/2/3-click
  flares, crab with finger jitter, orbit both ways, uzi, drag tear). A
  scratch is modelled as record motion **plus** an independent fader-gate
  schedule — the gates are sample-accurate AudioParam ramps on a per-deck
  battle fader, latency-compensated against the grain player
- Motion is analytic (velocity and displacement known at every instant), so
  cycles land back on the anchor and nothing drifts; humanize jitter keeps
  repeats from being bit-identical
- One dropdown per deck arms a move from the book; one **SCRATCH** button
  throws it and loops until tapped off (repick mid-scratch to swap live).
  The top MIDI pad row hits the same button (plus dedicated backspin pads)
- **✦ PERFORM**: a bar-synced performer rides the running mix — scratch
  bursts, loop rolls, FX bursts, filter sweeps, band isolation, fader chops
  and blends. Each track gets a mood (usually calm; busy/peak only when the
  music steps up), every gesture records its own undo, and anything a human
  touches is released instantly

**Set & crate**
- **★ SET & CRATE** sits one level above the sources: the setlist — your
  ordered crate for the night — as the list, and the crate (playlist,
  saved artists/albums, local shortcuts) in the side panel. ☆ on any row
  puts a track into the set, and its performance marks (cue point + four
  hot cues) ride along: set a hot cue on a listed track and it is stored;
  load it later and the marks come back onto the deck. Reorder with ▲▼
- **⤓ save** writes the setlist — cues included — as `setlist.json` on
  your machine; drop the file back on 📁 and it merges in again
- The **Local** source tab is the home of every imported file: session
  tracks are playable, remembered-only entries (the catalog survives
  reloads, file handles cannot) sit greyed until a re-import with the same
  name+size re-arms them — ⤴ into the crate stays the permanent road

**Sources**
- **Wavlake** charts/search/genres (value4value — zap the artist while it
  plays), **Nostr** playlists, **local files** (drag & drop, analyzed in
  seconds, session-scoped)
- **Your own server**: the Server tab speaks the Subsonic API to a
  self-hosted Navidrome — your collection, full quality, salt+token auth.
  A ready-made local instance ships in `ingest/docker-compose.yml`
  (`cd ingest && docker compose up -d` → http://localhost:4533, serving
  the same library folder the ingest pipeline fills)
- **Discover**: Audius (open API, DJ catalog), Jamendo (Creative Commons —
  clean for public sets, free client_id) and Archive.org netlabels/live
  sets. Any find promotes into the crate with ⤴; Archive finds auto-promote
  the moment they hit a deck — discovery is the road into the collection
- **The crate pipeline** (`ingest/`): upload, watch folder or URL handlers →
  loudness-normalized (−14 LUFS), tagged, filed into the library Navidrome
  serves. The ⤴ button on a local session track sends it there — drag & drop
  is the instant path, ⤴ makes it permanent on every device

**Controller**
- **Akai MPD218** mapped out of the box (factory defaults, bank A): pads for
  transport, SYNC, DROP, loops, momentary FX punches, scratch and automix;
  knobs for crossfader, master, and each deck's macro + filter

**Mixer**
- Crossfader with constant-power curve, master with level meter
- **Cue/headphone bus**: pre-fader listen per channel (🎧), master and
  headphones on separate output devices via the "🔈 Audio outputs" menu
  ("Reveal device names" fetches the labels)

**Music sources**
- Wavlake Top 40 / Top 100 / New / Random / genre random
- Catalog search (tracks, artists, albums)
- Crate: saved artists and albums, persisted via `storage` — plus a track
  playlist ("+" on a track row, "+ all → playlist" above the list,
  "Show playlist" renders it as a loadable list)
- Local files: file picker (📁 LOCAL) and drag & drop onto a deck — always
  FULL mode, no zap target
- Nostr: kind-30003 sets are loaded and the Wavlake links they contain are
  resolved to playable tracks

**Value4Value**
- Zap button per track and per deck
- Publish the session's setlist as a kind-30003 event — and with **⚡
  NIP-07** signed into the dev shell (Alby/nos2x on the shell's real
  origin), it goes out signed by YOUR key to real relays

**Design**
- The UI follows the **600B design system** — tokens at the top of
  `src/styles.css`, details in [HANDOFF.md](HANDOFF.md)

## What NIP-5D forces here

These three constraints shape the entire architecture — they are not design
decisions, they are requirements of the spec:

1. **No network inside the napplet.** The sandboxed iframe runs with
   `connect-src 'none'`; `fetch`, WebSocket and `localStorage` don't exist.
   Everything goes through `resource.bytes` — the host fetches the bytes.
   Here that's a stroke of luck: Wavlake's audio CDN sends *no* CORS headers,
   a direct browser fetch of the MP3 would be impossible. The host has no
   such restriction.
   → `src/lib/nap.js`

2. **`img-src data: blob:`.** An `<img src="https://…">` won't load in the
   sandbox. Artwork therefore also goes through `resource.bytes` and is
   handed to the DOM as a blob URL (with an LRU cache).
   → `src/lib/artwork.js`

3. **No signing API, no payment domain.** A napplet can only *publish*
   events (the host signs in the process), not merely sign them. And there
   is no wallet access whatsoever. A real NIP-57 zap needs exactly that: a
   signed, *not* published kind-9734 request. Hence two modes:

   | Mode | What happens | Nostr receipt |
   |---|---|---|
   | `lnurl` (default) | LNURL-pay to the Lightning address from the artist profile, boost text as the LNURL comment | no |
   | `nip57` | the 9734 is signed via `outbox.publish` — and thereby also lands on your relays | yes (kind 9735) |

   The invoice then goes to WebLN or, via `link.open`, as a `lightning:` URI
   to the external wallet.
   → `src/lib/zap.js`

## Audio backends

Two paths behind one deck API (`src/audio/engine.js`):

| Backend | Prerequisite | Can do |
|---|---|---|
| `buffer` (**FULL**) | raw bytes available → `decodeAudioData` | EQ, filter, FX, scratch, waveform, BPM, sample-accurate cue, VU |
| `element` (**BASIC**) | `<audio>` streaming only | crossfade via volume, tempo via `playbackRate` |

Inside the napplet, FULL is the normal case (`resource.bytes`). Standalone
without a proxy, only BASIC remains — the badge on the deck shows which path
is active.

No timestretch: pitch and tempo are coupled, like on vinyl. The Web Audio
API's `playbackRate` can't do anything else.

### How scratching works

An `AudioBufferSourceNode` only runs forwards — `playbackRate` must not go
negative. That's why every deck has two transport modes:

| Mode | Who plays | For what |
|---|---|---|
| `source` | one long `AudioBufferSourceNode` | normal operation, artifact-free |
| `platter` | granular *turntable* (`src/audio/scratch.js`) | scratch, brake, spin-up, backspin |

The turntable schedules 22 ms grains with short ramps at the seams (without
them it clicks audibly) and, at negative rates, reads from a **pre-reversed
copy** of the buffer. That copy is built only *after* decoding, so it doesn't
block the load path.

Important for the feel: while a hand is on the record, the position belongs
to the hand (`autoAdvance = false`) — otherwise pointer *and* grain scheduler
would both push it forward and every gesture would count double. On release
the motor takes over, pulls the rate to nominal and hands back to `source`.

## Setup

```bash
npm install
npm run dev        # Vite on :5173 — standalone, BASIC mode
npm run build      # dist/index.html (single-file) + dist/.nip5a-manifest.json
npm run shell      # build + dev host shell on :5178  ← test it this way
```

`npm run shell` starts a minimal NIP-5D shell (`dev/`) that loads the napplet
via `srcdoc` with `sandbox="allow-scripts"`, injects the official
`@napplet/shim` prelude and serves the `resource`, `identity`, `storage`,
`outbox`, `relay`, `common`, `link` domains. The built-in server proxy allows
real `resource.bytes` fetches against Wavlake — which makes the FULL path
actually testable locally.

```bash
node dev/smoke.mjs           # end-to-end in the real sandboxed iframe (Playwright)
node dev/fx-sync-check.mjs   # FX rack, SYNC latch, loops, DROP
node dev/local-check.mjs     # local file playback
node dev/playlist-check.mjs  # playlist / crate
```

Four Playwright E2E suites, 96 checks in total. The smoke test loads charts,
throws a track onto each deck, checks decoding, waveform, BPM, transport,
crossfader, EQ, SYNC, Nostr playlist resolution and search, and writes
screenshots to `/tmp/clanker-*.png`.

## Deployment

`npm run build` produces `dist/.nip5a-manifest.json` — a kind-35129 event
with `d` tag, `path` hash, aggregate hash and the `requires` tags. To publish
(Blossom upload + relay publish):

```bash
napplet init --name dj-david-clanker --relay wss://… --server https://…
napplet deploy --dry-run
napplet deploy
```

## Project structure

```
index.html              napplet entry
vite.config.js          nip5aManifest(), single-file artifact
src/
  main.js               wiring, keyboard shortcuts, settings, setlist
  styles.css
  lib/
    nap.js              NIP-5D bridge + standalone fallbacks
    artwork.js          images via resource.bytes → blob:
    wavlake.js          catalog.wavlake.com client
    nostr.js            read kind-30003 / publish setlist
    zap.js              LNURL-pay or NIP-57
    bech32.js           npub ↔ hex
  audio/
    engine.js           mixer + deck, two backends, platter physics
    scratch.js          granular turntable + reversed buffer
    fx.js               5 insert FX: flanger, phaser, gater, echo, reverb
    automix.js          auto-DJ state machine
    analyze.js          waveform peaks, RMS, BPM estimation
  ui/
    platter.js          canvas disc: cover label, grooves, waveform ring
    scope.js            live scopes (mirror / wave / bars)
    deck, mixer, automixbar, browser, modal, zapmodal, dom
dev/
  shell.html            minimal NIP-5D host shell
  serve-shell.mjs       static server + fetch proxy
  smoke.mjs             Playwright E2E
  fx-sync-check.mjs     E2E: FX, SYNC latch, loops, DROP
  local-check.mjs       E2E: local files
  playlist-check.mjs    E2E: playlist
```

## Keyboard shortcuts

| Key | Function |
|---|---|
| `Q` / `P` | Deck A / B play-pause |
| `W` / `O` | Deck A / B cue |
| `E` / `I` | Deck A / B headphone cue (pre-fader) |
| `X` | Automix on / off |
| `N` | Automix: crossfade now |
| `S` / `L` | Deck A / B rewind — hold and it speeds up |
| `V` / `B` | Deck A / B between VINYL and CDJ |
| `F` / `G` | Deck A FX slot 1 / 2 |
| `H` / `J` | Deck B FX slot 1 / 2 |
| `3` / `4` | DROP Deck A / B on the other deck's next bar-1 |
| `,` / `.` | crossfader left / right |
| `M` | crossfader centered |
| `1` / `2` | sync Deck A / B (BPM + beat phase) |
| `←` / `→` | Deck A ±5 s (with `Alt`: Deck B) |

For architecture, design decisions, test coverage and open items, see
**[HANDOFF.md](HANDOFF.md)**.

## Known limits

- **No keylock.** Changing the tempo shifts the pitch.
- **Scratch latency** sits around 45 ms — the grain queue has to be filled
  that far ahead so nothing drops out. Enough for baby scratches and
  transformer work; not for competition-level turntablism.
- **The reversed buffer costs memory**: as much again as the original — for
  a 6-minute stereo track roughly 60 MB per deck.
- **Vinyl features need FULL mode.** In BASIC mode scratch, brake, rewind
  and FX are disabled — the samples simply aren't there.
- **BPM detection** (v2, comb autocorrelation) nails the period, but the
  metrical level is a choice — on shuffle material half/double and 2:3
  levels compete. A dashed frame on the BPM field means "low confidence";
  the value stays editable.
- **The whole file is loaded** before a deck plays (`resource.bytes` returns
  a single blob per spec, no streaming). 4–6 MB per track.
- **Wavlake's Lightning addresses** aren't discoverable via the catalog API.
  The zap goes to the `lud16` from the artist's Nostr profile; if that's
  missing, the dialog offers the boost on wavlake.com.
- **NIP-5D is an open PR**, the `@napplet/*` packages sit at 0.x. The wire
  shapes here come from the shipped type definitions and can drift. Pin
  versions.

## Sources

- [NIP-5D (PR #2303)](https://github.com/nostr-protocol/nips/pull/2303) · [napplet.run](https://napplet.run/docs/)
- [Wavlake](https://wavlake.com) · `https://catalog.wavlake.com/v1` (public, no key)
- [NIP-51 Sets](https://github.com/nostr-protocol/nips/blob/master/51.md) · [NIP-57 Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
