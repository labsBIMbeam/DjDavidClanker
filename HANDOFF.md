# Handoff — DJ David Clanker

As of: August 3, 2026 · Status: **working, 42/42 E2E checks green**

This document is for the person who touches the project next — whether that's
you in three months or someone else. It describes what is built, **why it is
built that way**, what has been verified and where the edges are.

---

## 1. What this thing is

A two-deck DJ mixer for [Wavlake](https://wavlake.com) music, shipped as a
**napplet** per [NIP-5D](https://github.com/nostr-protocol/nips/pull/2303):
a sandboxed single-purpose app that runs in an `iframe srcdoc` with
`sandbox="allow-scripts"` and delegates signing, storage, relays *and network
access* to a host shell.

The build artifact is **a single `dist/index.html`** (~125 KB, everything
inline) plus `dist/.nip5a-manifest.json` (a kind-35129 event with path hashes
and `requires` tags).

---

## 2. The three constraints that drive the design

If you read the code and wonder "why so roundabout" — here is the answer.
These are not style choices, they are requirements of the spec.

### 2.1 No network inside the napplet

The sandbox runs with `connect-src 'none'`. There is **no `fetch`, no
WebSocket, no `localStorage`**. Every byte arrives via `resource.bytes` — the
host fetches it.

Here that's a stroke of luck rather than a brake: Wavlake's audio CDN
(`d12wklypp119aj.cloudfront.net`) sends **no CORS headers**. A direct browser
fetch of the MP3 would be impossible; the host has no such restriction.

→ `src/lib/nap.js`. Every call has a standalone fallback so `npm run dev`
works without a shell.

### 2.2 `img-src data: blob:`

An `<img src="https://…">` simply won't load in the sandbox. Artwork
therefore also goes through `resource.bytes` and is handed to the DOM as a
**blob URL**, with an LRU cache (240 entries, older ones get revoked).

→ `src/lib/artwork.js`. This was a genuine find in the first E2E run: the
images stayed blank until everything went through the host.

### 2.3 No signing API, no payment domain

A napplet can only **publish** events (the host signs in the process), not
merely sign them. Wallet access doesn't exist at all. A real NIP-57 zap needs
exactly the opposite, though: a signed, *not* published kind-9734.

Hence two modes, switchable in ⚙ Settings:

| Mode | What happens | Nostr receipt |
|---|---|---|
| `lnurl` (default) | LNURL-pay to the `lud16` from the artist profile, boost text as the LNURL comment | no |
| `nip57` | the 9734 is signed via `outbox.publish` — and thereby **also lands on the relays** | yes (kind 9735) |

The invoice goes to WebLN, otherwise via `link.open` as a `lightning:` URI.
If the `lud16` is missing, the dialog offers the boost on wavlake.com.

→ `src/lib/zap.js`

---

## 3. Architecture

```
src/
  main.js               wiring, keys, settings, setlist, frame loop
  lib/
    nap.js              NIP-5D bridge + standalone fallbacks
    artwork.js          images via resource.bytes → blob:
    wavlake.js          catalog.wavlake.com client (public, no key)
    nostr.js            read kind-30003 / publish setlist
    zap.js              LNURL-pay or NIP-57
    bech32.js           npub ↔ hex
  audio/
    engine.js           mixer + deck, two backends, platter physics
    scratch.js          granular turntable (overlap-add) + reversed buffer
    fx.js               5 insert FX + ChannelFilter (clean/djm/xone models)
    macrofx.js          one-knob Macro FX (echo/space/noise/gate/barber)
    automix.js          auto-DJ state machine
    analyze.js          waveform peaks, RMS, BPM v2 (comb autocorrelation + beat phase)
  ui/
    deck.js  platter.js  meter.js  mixer.js  automixbar.js
    browser.js  modal.js  zapmodal.js  dom.js
dev/
  shell.html            minimal NIP-5D host shell
  serve-shell.mjs       static server + fetch proxy
  smoke.mjs             Playwright E2E (40 checks; six sibling suites exist)
  automix-check.mjs     three tracks in a row — guards the second handover
  macro-check.mjs       Macro FX + filter models against the live graph
  autodj-check.mjs      analysis v2 + transition engine on known fixtures
```

A single `requestAnimationFrame` loop in `main.js` drives everything:
`mixer.tickAudio()` (platter physics + gater scheduling), `automix.tick(dt)`,
then the UI ticks. No module has timers of its own — **exception**: the
turntable uses `setInterval(10ms)`, because grain scheduling has to survive a
throttled animation frame.

### 3.1 Two audio backends

| Backend | Prerequisite | Can do |
|---|---|---|
| `buffer` (**FULL**) | raw bytes → `decodeAudioData` | EQ, filter, FX, scratch, waveform, BPM, sample-accurate cue |
| `element` (**BASIC**) | `<audio>` streaming only | crossfade via volume, tempo via `playbackRate` |

Inside the napplet, FULL is the normal case. Standalone without a CORS proxy
stays BASIC. The badge on the deck shows the active path.

### 3.2 Three transport modes in the buffer backend

An `AudioBufferSourceNode` only runs forwards — `playbackRate` must not go
negative. Hence:

| `deck._mode` | Who plays | For what |
|---|---|---|
| `idle` | nobody | stopped |
| `source` | one long `AudioBufferSourceNode` | normal operation, artifact-free |
| `platter` | granular turntable | scratch, brake, spin-up, backspin |

Transitions go through `_enterSource` / `_enterPlatter` / `_enterIdle`. The
motor (`_motorTo(target, seconds, done)`) pulls the rate and then calls the
callback — that's how, e.g., the spin-up hands over cleanly to `source`.

`position` and `currentRate` read correctly in all three modes. **Anyone
changing something here has to keep both getters in mind.**

### 3.3 Who owns the position?

The subtlest point in the whole project, and the cause of a bug that cost two
test runs:

`Turntable.autoAdvance` decides who advances the playback position. Under
motor drive (brake, backspin, spin-up) the grain scheduler does it. **While a
hand is on the record, the position belongs to the hand** — otherwise pointer
*and* scheduler both push, and every gesture counts double (measured: 1.78 s
instead of 0.9 s for half a turn).

The E2E test checks this explicitly: `half a platter turn ≈ 0.9 s of audio`.

### 3.4 Automix

State machine in `src/audio/automix.js`, driven by `tick(dt)`. **It never
touches the audio graph** — it only calls the same public deck and mixer
methods as the buttons. That's why a human can cut in at any time without the
state going inconsistent.

Flow: determine the live deck → load the next track onto the free deck in
time (`preloadLead`, default 35 s — fetch + decode take real seconds) → at
`fadeSeconds` remaining, pull to the BPM, start, drive the crossfader over →
swap roles.

Three behaviors that grew out of bugs:

- **`start()` adopts what's already playing.** Switching Automix on mid-set
  doesn't start from zero; it adopts the running deck and stops a possible
  second one.
- **An idle deck that's playing on its own gets stopped, not skipped.**
  Previously that blocked every transition — Automix stood still without
  reporting an error. Silently blocking is the worse bug.

- **The deck that just handed over is marked stale (`staleId`).** After a
  transition it still holds its played-out track at status `'ready'` — which
  is byte-for-byte indistinguishable from a deck a human cued on purpose, and
  those are deliberately kept (below). Without the marker the preload skipped
  loading from the *second* transition on and the mix ping-ponged between the
  same two tracks forever. The one-handover smoke test never saw it; that is
  what `dev/automix-check.mjs` exists for.

An idle deck that was already cued manually is **kept and played next** —
that's intentional, and it is exactly why `staleId` has to exist to tell the
two cases apart.

---

## 4. What is verified

`node dev/smoke.mjs` drives the real app in the real sandboxed iframe against
the real Wavlake API. No mocks except the Nostr fixture. Last run: **40/40**,
plus the sibling suites `fx-sync-check` (48), `automix-check` (5),
`macro-check` (24), `autodj-check` (27), `playlist-check` (9) and
`local-check` (7) — 160 checks in total.

**Auto-DJ v2** (milestones 1+2 of the plan). The deck knows the track:
`analyzeStructure` (per-bar energy on the beat grid, sections, phrase length
16/32 + offset, bar-snapped mixIn/mixOut points, a confidence that gates all
downstream use) and `detectKey` (Goertzel chromagram vs Krumhansl profiles →
Camelot code; chunked on the main thread; skipped over 12 min). Results
persist in `lib/analysiscache.js` — ONE LRU blob under `analysis.v1`
(`sdk.storage` cannot enumerate keys), ~150 entries ≈ 70 KB; cache hits skip
the expensive passes.

The automix mixes through `src/audio/transition.js`: the planner picks
blend / cut / echo / fade (first rule wins, everything uncertain degrades to
the legacy fade — the floor is never removed). A blend arms the incoming
deck SAMPLE-ACCURATELY on the outgoing phrase boundary via `armStartAt` (the
DROP mechanic, generalized — no vinyl spin-up ramp), enters at the incoming
mix-in point, pre-kills its LOW, latches SYNC during the overlap, rides the
crossfader on a smoothstep, swaps the bass on the phrase nearest the
midpoint, then glides the survivor's tempo back to 0% over four bars — no
cumulative pitch drift across a set. Echo ramps the DUB ECHO macro over the
last bar and lets the tail ring past the cut. Every surface the machine
drives (crossfader, both LOW EQs, tempo) yields permanently the moment a
human's hand differs from the machine's last write (expected-vs-actual).

Guards worth knowing: the SYNC latch pauses while a scheduled start is armed
(alignPhase seeks, a seek would destroy the pending source); a user-armed
DROP on the idle deck makes the automix stay on the legacy fader ride; the
preload lead is measured to the MIX-OUT point, not the track end — measured
to the end it systematically starved every track with a real outro into the
fade fallback (45 s keeps a full phrase of headroom). Hidden tab: scheduled
starts still fire (the audio clock runs), fader rides freeze — documented,
not solved.

**Macro FX** (`src/audio/macrofx.js`) is the Traktor "Mixer FX" idea: one
bipolar knob per channel drives a tuned effect+filter combination — left
blends the effect in over a lowpass sweep, right over a highpass sweep,
centre (±0.06) is a hard bypass detent. Macros are selected in the standard
FX-slot dropdowns (entries `macro:*`); the slot button punches the amount
out and back, and there is only ONE macro engine per deck, so a macro in the
second slot swaps like a duplicate insert would. Types: DUB ECHO (ping-pong,
dotted-eighth synced, darkened feedback loop), SPACE (plate-style convolution
with progressive damping), NOISE (self-generating riser — audible with the
channel open even while the track is paused, like Pioneer's), GATE (1/16
tempo gate on the dry path), BARBER (two crossfaded flanger voices whose
triangle windows sum to exactly 1; the comb notches climb forever — the
knob's sign sets the direction). It sits after the insert chain, before the
channel gain, so the cue bus hears it. BARBER and GATE schedule from the
frame loop and freeze in a hidden tab, like the gater always has.

**Channel-filter models** (`ChannelFilter` in `src/audio/fx.js`): the FLT
sweep's personality is switchable — CLN (transparent 2-pole, the original),
DJM (Q rises gently toward the ends), XONE (Xone:92-flavoured: two cascaded
biquads at the same corner for 24 dB/oct, resonance that rides the sweep,
tanh saturation for the crunch). The chain is fixed and models make unused
stages transparent, so switching never rewires a live graph. Honest note:
these are flavoured approximations of the hardware, not circuit models.

**Lesson worth keeping:** the smoke suite drove exactly *one* automix
handover for months, and a bug that only appears on the second one lived
happily behind that green check. When a suite covers a cycle, make it run the
cycle at least twice.

Covered: boot and `window.napplet` injection, charts via `resource.bytes`,
FULL-mode decoding, waveform, BPM (92.5 measured), scratch direction *and*
1:1 mapping, return to `source` mode, rewind acceleration (−13.4×), vinyl
brake, FX throughput, gater division, disc rendering and rotation, deck and
master level meters (fire segments, red overshoot), a complete Automix cycle (cold start →
preload → crossfade → handover), kind-30003 resolution, search, mobile
viewport, no console errors.

**Playwright pitfall #2 (iframe coordinates):** `locator.boundingBox()` on an
element inside the sandboxed srcdoc iframe returns FRAME-relative coordinates
here, not page coordinates — and the dev shell's log grows during a run,
pushing the iframe down, so even a correct offset measured at boot goes stale.
Raw `page.mouse` gestures must compute page coordinates per call: scroll the
element to the frame-viewport center, take the iframe's own boundingBox, add
the in-frame `getBoundingClientRect`. `smoke.mjs` has the `pageRect()` helper;
`locator.click()` is unaffected (it targets internally). This masked itself
for weeks because frame scroll ≈ iframe offset by coincidence.

**Playwright pitfall:** `waitForFunction(fn, {timeout})` passes the object as
an *argument* to the page function, not as an option — the 30 s default stays
active. Correct is `waitForFunction(fn, undefined, {timeout})`. That once
disguised a real failure as a timeout.

---

## 5. Not verified / open items

- **No real host tested.** `dev/shell.html` is a self-built minimal shell,
  not a conformant implementation. The wire shapes come from the shipped
  `@napplet/*` type definitions. Cross-check against a real shell (Kehto or
  similar) before deploying.
- **NIP-5D is an open PR**, the packages sit at 0.x. **Pin versions.**
- **The zap path has never run with real sats.** The LNURL logic is untested
  against a real endpoint.
- **Wavlake's own Lightning addresses** aren't discoverable via the catalog
  API. The zap goes to the `lud16` from the artist's Nostr profile.
- `/v1/charts/music/top` ignores `days`, `genre` and `sort` server-side —
  only `limit` has any effect. Ranking is always `msatTotal7Days`.
- **No keylock.** Changing the tempo shifts the pitch (like vinyl).
- **Scratch latency ~45 ms** — the grain queue has to be filled that far
  ahead. Baby scratch yes, competition turntablism no. Since the overlap-add
  rework (50 % overlap, equal-power sine window, per-grain rate glide) the
  22 ms amplitude chatter at the grain seams is gone.
- **The BPM metrical level is a choice, not a truth.** The v2 detector finds
  the period to ~0.02 BPM and delivers the beat phase (`beatOffset`), but on
  shuffle material 2:3 levels compete — "Worn-Out War" read as 92.5 on the
  old detector, 138.7 (= ×1.5) on the new one. Candidates ½/2/⅔/1.5 are
  weighed against each other (grid energy, 12 % margin); the BASE field
  stays editable for when the choice is wrong.
- **The cue output was never verified with real second hardware.** The bus,
  the MediaStream bridge and `setSinkId` are E2E-checked, but not with a
  real second interface. **Shell requirement:** the host iframe must carry
  `allow="speaker-selection *; microphone *"` (the `*` form — a sandboxed
  srcdoc frame has an opaque origin). The dev shell does this since Aug 2026;
  without the `microphone` delegation, "Reveal device names" cannot get
  labels and the output menu shows anonymous entries. Note Chromium does not
  recognize `speaker-selection` as a policy name (`allowsFeature` says no) —
  `setSinkId` works there regardless; the mic policy is the load-bearing one.
- **The reversed buffer doubles the memory**: roughly 60 MB per deck for a
  6-minute stereo track.
- **Whole file before playback**, because `resource.bytes` returns a single
  blob per spec, no streaming.
- `window.__djclanker` is a debug handle for the tests. Before a public
  release, either remove it or document it deliberately.

### Obvious next steps

1. Test against a real shell, verify the `requires` list.
2. Hot cues and loops (the infrastructure — sample-accurate seek — is
   already there).
3. ~~Beat grid instead of just BPM~~ — done: `beatOffset` + `barOffset`
   (downbeat) from the detector, `alignPhase()` computes on real grids,
   `armDrop()` starts sample-accurately on bar-1. The downbeat is a
   **kick-energy heuristic** over the four beat phase classes — usually right
   for 4/4 electronic material, sometimes the 3 instead of the 1 on offbeat
   basslines; the drop still lands on a grid line then, just two beats off.
4. Automix: put the transition on the bar — `armDrop()` provides the
   mechanism, the Automix state machine doesn't use it yet.
5. Waveform overview with beat markers.

---

## 6. Operations

```bash
npm install
npm run dev        # Vite :5173 — standalone, BASIC mode
npm run build      # dist/index.html + dist/.nip5a-manifest.json
npm run shell      # build + dev host shell on :5178  ← test it this way
node dev/smoke.mjs # E2E, screenshots to /tmp/clanker-*.png
```

`npm run shell` needs the built-in server proxy: `resource.bytes` has to
reach hosts that send no CORS headers — a pure browser shell can't do that.
Allowed hosts live in `dev/serve-shell.mjs` (`ALLOW_HOSTS`).

Deployment:

```bash
napplet init --name dj-david-clanker --relay wss://… --server https://…
napplet deploy --dry-run
napplet deploy
```

**Live DJ** — `node dev/live-dj.mjs` puts an LLM behind the decks: the napplet
has no network, so the brain runs outside and drives the same
`window.__djclanker` handle the E2E suites use. Claude (Opus 5, JSON-schema
decisions, server-side fallbacks) curates the browser list, drops MC lines as
toasts and occasionally rides an effect; automix/SYNC/DROP keep the mechanics
deterministic. Headed by default so audio plays locally; `HEADLESS=1`,
`CYCLE_MS`, `MAX_CYCLES` for CI. Credentials resolve like any Anthropic SDK
app (`ANTHROPIC_API_KEY` or an `ant auth login` profile); without them it
falls back to a heuristic mode — same mixing, canned MC lines. The LLM request
path follows the current SDK docs but has not yet run against the live API
from this repo (no credentials in the dev environment).

Playwright is installed globally in this environment. If `node dev/smoke.mjs`
can't find the package:

```bash
ln -sfn "$(npm root -g)/playwright" node_modules/playwright
ln -sfn "$(npm root -g)/playwright-core" node_modules/playwright-core
```

---

## 7. Design reference

Since August 2026 the app follows the **600B Design System v0.2.0**
(`600B Design System — Print.pdf` in the 600000000000 repo). Tokens sit as
CSS custom properties at the top of `src/styles.css` — the `--c-*` layer is
the system, the semantic layer below it is the app mapping:

| Token | Value | Role |
|---|---|---|
| `--bg` | `#111111` (Soot) | page background |
| `--panel` / `--panel-2` | `#1a1917` / `#222222` (Charcoal) | surfaces, always as a gradient |
| `--line` | `#2a1810` (Volcanic) | borders, dividers |
| `--text` / `--muted` | `#fff7ec` (Ember White) / `#a89f90` | type |
| `--a` / `--b` | `#f7931a` (Orange) / `#f3c244` (Gold) | Deck A / Deck B, throughout |
| `--zap` | `#ff6a00` (Ember) | Value4Value, active FX, cue markers, loop |
| `--ok` / `--bad` | `#ffa733` (Bright) / `#d93000` (derived) | states, reverse playback |

`--bad` is not a print token — Ember deepened, because the system defines no
alarm color. Type: buttons/labels **Impact** (sharp, caps, hover brighter,
press `scale(.97)`), body text **Trebuchet MS**, modal prose **Georgia**,
machine values **JetBrains Mono** with a fallback stack — all system fonts,
nothing gets loaded (CSP). Badges and buttons are `r-0` (sharp), surfaces
`r-2` (8 px). The spinning platter carries the `r-stone` Ember glow.
Deliberate deviation: the functional glyphs (⚡ 🎧 📁 …) stay, even though
the brand voice says "no emoji" — usability beats purity.

Rules that hold throughout:

- **Deck color is identity.** A is Orange everywhere, B is Gold everywhere —
  waveform, label ring, disc, Load buttons, scope gradient.
- **Monospace for everything machine-made** (BPM, percentages, badges),
  body sans for content (track titles, artists), Impact for controls.
- **Bipolar controls have a center detent** as a second background gradient —
  pitch, EQ, filter, crossfader. "Neutral" has to be findable by eye.
- **Vertical faders draw their own groove**, not via
  `::-webkit-slider-runnable-track`: that doesn't reliably survive
  `writing-mode: vertical-lr`.
- **Canvas instead of DOM** wherever drawing happens per frame — disc,
  waveform, scopes. Static parts live in offscreen canvases and get blitted.
- **Breakpoints**: 1000 px (decks stacked, browser sidebar on top),
  640 px (deck inner grid onto `grid-template-areas`).
- `prefers-reduced-motion` disables the toast animation. The record rotation
  stays — it's a status display, not decoration.

Interactions with non-obvious behavior:

| Element | Behavior |
|---|---|
| Platter | angle-based, not x-based: one revolution = 1.8 s of audio, no matter where you grab |
| CUE | stopped: set the point. Playing: jump back and pause |
| REW | hold. Target speed grows with hold time up to −14× |
| SYNC | **latch**: engaging matches BPM (incl. half/double and 2:3 levels) and then holds the phase permanently — micro-nudge for small errors, hard realign for large ones. A second click releases |
| LOOP bar | IN/OUT for manual loops, 1/2/4/8 snap onto the beat grid, EXIT leaves. An active loop holds off the Automix transition |
| 📁 LOCAL / drag & drop | local audio files into the list or straight onto a deck — always FULL mode, no zap target, not in the persistent playlist |
| BPM display | large = effective (base × tempo fader), small editable = BASE |
| FX slot dropdown | picks which of the 5 effects the button (or F/G/H/J) toggles; picking the other slot's effect swaps the slots |
| 🎧 (on the channel) | pre-fader listen on the cue bus (keys E/I) |
| 🔈 (in the mixer) | "🔈 Audio outputs" menu: master and headphone device, applies immediately; "Reveal device names" fetches the labels via a media permission |
| Kill buttons (HI/MID/LOW) | toggle to −26 dB and back to 0 |
| Level meters | classic segmented meters (channel horizontal under the wave, master vertical mid-stage): fire palette, red overshoot ≥ 0.9 with clip latch and peak hold. They replaced the oscilloscope scopes |
| Beat-loop buttons | second press on the same length exits the loop |
| Macro FX (FX slots) | the slot dropdowns list the five combos below the insert FX; the slot body becomes one bipolar fader (left = combo over lowpass, right = over highpass, centre = off) and the slot button punches out/in to the last amount |
| Filter model button | cycles CLN → DJM → XONE next to the FLT fader — the sweep's resonance/crunch personality |
| Local files (crate tab) | every picked or dropped file joins a session list — reachable until reload; File handles cannot persist through the storage domain |
| Cue bridge gate | the second AudioContext stays muted until the cue device differs from the master device — same-device output would double-play with a few ms offset and comb-filter the bass away |
| Waveform | click jumps (within the visible window), mouse wheel or −/+ zooms ×1–×64, the ×1 label resets. Zoomed, the window follows the playhead and renders live from 8k peaks; bar-1 lines are stronger and anchored to the detected downbeat. Double-click on a track row loads into Deck A |
| DROP (keys 3/4) | starts the deck sample-accurately on the other deck's next bar-1 — tempo synced beforehand, own entry point = cue snapped to its own 1, CDJ start without vinyl spin-up. Pressing again aborts |
| TAP (keys T/U) | tap tempo: hit it on every beat. Uses playback-position deltas (median), so it yields the BASE bpm regardless of the tempo fader; from the 4th tap BPM + beat grid are set and marked manual. Taps give the beat, not the 1 — `barOffset` re-anchors to the tapped grid |
| Auto-scratch (BABY/SCRB/CHRP/TRNS/BSPN) | scripted turntablism over the granular platter, beat-synced, driven from `tickAudio`: baby, scribble, chirp, transformer, backspin. Runs ~2 bars (backspin 1) then hands back to normal playback; chirp/transformer gate the deck channel, not the crossfader |
| "+" on a track row / "+ all → playlist" above the list | adds the track(s) to the playlist (Crate tab). There: a menu of all entries, × removes, "Show playlist" renders it as a loadable list |

---

## 8. Sources

- [NIP-5D (PR #2303)](https://github.com/nostr-protocol/nips/pull/2303) · [napplet.run](https://napplet.run/docs/)
- Wavlake catalog: `https://catalog.wavlake.com/v1` (public, no key).
  `api.wavlake.com` does **not** exist — it doesn't resolve.
- [wavlake/mobile](https://github.com/wavlake/mobile) (endpoints, NIP-98 auth),
  [wavlake/wavman](https://github.com/wavlake/wavman) (zap logic)
- [NIP-51 Sets](https://github.com/nostr-protocol/nips/blob/master/51.md) ·
  [NIP-57 Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
