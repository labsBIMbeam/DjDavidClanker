# M7 — The module family

Decks, mixer, playlist and queue become reusable packages under
`packages/*`, and where an element carries its own weight it also ships as
its own napplet. This document is the binding cut plan; M7-1 (this PR) adds
the workspace skeleton, M7-2 and M7-3 execute the moves. Nothing changes
behavior at any step — the 238-check board is the net.

## Why

- Booth request: build napplets out of the individual elements (decks,
  mixer, playlist, queue).
- NIP-5D napplets cannot embed each other (sandboxed iframes do not
  compose), so "elements as napplets" means BOTH: packages that we and
  third parties build napplets FROM, and standalone mini-napplets where an
  element works solo. The DJ app itself stays the composition of all four
  packages — same behavior, same single-file build.

## The four packages

| Package | Today's files | Solo napplet? |
|---|---|---|
| `@clanker/queue` | `src/audio/automix.js`, `selection.js`, `preanalyze.js`, `transition.js` | no — headless library |
| `@clanker/playlist` | `src/lib/setlist.js`, `localsongs.js`, the kind-30003 half of `nostr.js` | yes — a setlist manager (edit marks, publish, no decks) |
| `@clanker/deck` | deck half of `engine.js`, `scratch.js`, `autoscratch.js`, `keylock.js`, `analyze.js`, `analysiscache.js`, `ui/deck.js`, `ui/platter.js` | maybe later — a practice deck |
| `@clanker/mixer` | mixer half of `engine.js`, `fx.js`, `macrofx.js`, `performer.js`(?), `ui/mixer.js` | yes — an FX box: LINE-IN → 16 units → out |

Also on the list, outside the four: `@clanker/viz` (`ui/visualizer.js`) —
the ZapViz Winamp visualizer is the easiest standalone napplet of all
(master analyser in, ridiculousness out).

## The knots (what actually blocks a clean cut)

These are the reasons M7 is three rounds and not one afternoon:

1. **`engine.js` is one file holding Deck AND Mixer.** They share `clamp`,
   the graph-building code and the `FX_TYPES`/`FX_PRIMARY` tables. Cut:
   `Deck` moves to `@clanker/deck`, `Mixer` to `@clanker/mixer`, the FX
   tables live with the mixer, and the deck receives the mixer through its
   constructor exactly as it already does (`this.mixer`) — the interface
   is in place, only the file boundary is missing.
2. **`setlist.js` imports `store` from `nap.js`.** A package must not
   depend on the app's NIP-5D bridge. Cut: the playlist package exports
   `initSetlist(storage)` taking a `{get,set}` pair; the app passes the
   nap store, a solo napplet passes its own bridge, tests pass a Map.
3. **`transition.js` calls `Deck.nextBarTime`.** Static helper on the deck
   class. Cut: `nextBarTime(host, ctx, opts)` moves into a shared
   `@clanker/queue` util that takes the host deck as a plain argument —
   it already reads only public fields.
4. **`automix.js` reaches into deck internals in two places** (`_drop`,
   `staleId` bookkeeping). Both are already commented as deliberate;
   they become part of the documented deck contract (`deck.armedDrop`,
   `deck.markStale()`) before the move.
5. **The keylock worklet inlines its processor source** (Blob URL) — no
   build-order problem, moves with the deck untouched.
6. **UI factories import `dom.js` helpers.** `h`/`clear`/`fader` become a
   tiny `@clanker/dom` internal package (not published, just shared).

## Order of execution

- **M7-2 (safe moves):** `@clanker/queue` + `@clanker/playlist` — pure-JS
  moves plus knots 2–4. App imports switch to workspace specifiers; vite
  resolves workspaces without config changes. Full board must stay green.
- **M7-3 (the engine cut):** `@clanker/deck` + `@clanker/mixer` + knot 1,
  then `@clanker/viz` and the first solo napplet build (viz) as proof.
- **Not before all boards are green twice:** publishing any package
  beyond `private: true`.

## Build rule during M7

`dist/` stays the product of the CURRENT app until each round's board is
green — refactor builds go to a scratch outDir first. A live booth may be
running against `dist` at any time; it was, when this plan was written.
