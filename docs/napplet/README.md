# Music interoperability proposal and conformance audit

Status: **local proposal**, September 6, 2026. Neither `music` nor `dj` is an
approved upstream archetype. This branch replaces the unsupported `dj/open`
advertisement with a documented `music/open` implementation and proposal.
Publishing a manifest does not reserve or standardize a role.

## Authority

- [NAAT registry](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/ARCHETYPES.md)
- [NAP-INTENT](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INTENT.md)
- [NAP-INC](https://github.com/napplet/naps/blob/a040914b4bbd3a5cd8a14b0f316a723c968ebfb2/naps/NAP-INC.md)
- [NIP-5D draft](https://github.com/dskvr/nips/blob/24711d9c47bbdd07908bf1d52bf677d9cbc530f0/5D.md)

The NAP repository introduction still describes kind 35128; the current NIP-5D
draft assigns napplets kind **35129**. Follow the governing NIP for the artifact
kind, the individual NAP for its interface, and the registry for approved roles.
Open PRs (including VALUE, UPLOAD, MEDIA and COMMON) are proposals, not mandatory
capabilities. SDK availability alone does not settle specification status.

## The three boundaries

| Concern | Contract | Owner |
|---|---|---|
| What app handles a music selection? | Proposed `music` archetype | Registry / user default |
| What data does opening music accept? | [`napplet:music/open`](conventions/music-open.md) | Producer and consumer |
| Who selects, opens and delivers to that app? | NAP-INTENT, delivered via NAP-INC | Shell |

The role entry is deliberately small: [NAAT-MUSIC](naat/music.md). The upstream
registry addition and review text are in [proposal.md](proposal.md).

David desktop and Totem are alternative handlers for **the same task**. Neither
is a shell, a wallet, or a generic Nostr client. Decks, EQ, queue and transitions
are implementation components of playback, not automatically separate roles.

## Confirmed drift and changes

| Finding | Resolution |
|---|---|
| `dj/open` claimed without a receiver or registry entry | Proposed music boundary + validated INC receiver in both builds |
| M7 equated opaque iframes with no composition | Shell composes by intent; libraries stay internal implementation |
| Metadata pass wrote `dist` even for another output and raced async manifest writer | Shared ordered output-aware pass; hashes and metadata checked for both builds |
| Totem required unused COMMON; desktop required optional social features | Core music requires resource + inc; other injected domains are optional |
| Missing hosted domains fell through to browser APIs; denied resources fell through to direct audio | Hosted bridge and deck fail closed; standalone fallbacks remain separate |
| Totem STOP left audio playing; restart and artwork contracts were broken | Dedicated transport and blob lifecycle regressions |

The existing `common.getProfile` fast path remains optional for hosts which offer
that draft; relay/outbox lookup is the fallback. A host need not offer COMMON to
load the player. Optional storage absence means session memory, not persistence.

## Separation work after this baseline

1. Extract I/O boundaries before moving M7 files: byte loading into the deck and
   preanalyzer, storage into analysis cache and setlist. The four package.json
   placeholders are not working library entrypoints yet.
2. Keep a playback queue in music. Move library maintenance, server ingest and
   discovery into producers once their selection handoff is proved. Nostr
   profiles should open the user's profile handler, not become a new David tab.
3. Keep instrument creation independent. A synth exports a rendered track via
   host upload and invokes music/open; standalone WAV import is also supported.
4. Resolve staged-queue truth before expanding live performance: promoting a
   queued track after preloading can leave the already-staged track playing next.
   A fix must cover preload cancellation, transitions already started, and LIST,
   SHUF and SMART orders. This audit records the issue; it is not fixed here.
5. Unify transport lifecycle before adding live synth clock following. Totem
   currently depends on animation frames, unlike the desktop hidden-tab timer.

## Synth direction

The user-supplied [RACK-02 reference](https://ssx360.github.io/rack-02/rack.html?src=hn)
was inspected in a browser. Useful patterns are seeded variation, scenes,
bar-aligned loop/stem export, and explicit transport. Its source/license was not
verified; no implementation is copied. The original synth proof in this branch
demonstrates the portable rendered-loop handoff, not a clone of that rack.

Live interoperability has separate acceptance criteria: user-selected clock
leader, explicit session membership, sequence numbers, late-event handling,
scheduled future beats, stop/panic, and latency measurements. INC is a control
transport, **not a sample clock or an audio cable**. Independent AudioContexts
cannot be connected by passing AudioNodes over JSON. Live audio routing needs a
specified, available host audio service or another explicit routing contract.
No such capability is claimed by music/open. Until that seam is implemented and
measured, use rendered audio through David's existing deck/mixer graph.

## Verification and release boundary

`npm test` runs deterministic bridge, convention, transport, synth and artifact
checks. Browser conformance checks exercise real shim messages in opaque
iframes with fixture resources; they do not upload files, publish Nostr events,
or spend sats. See the task report for exact commands and any unavailable checks.

The local dev shell is a fixture host, not a production conformance claim.
Signing, Blossom upload, upstream review, deployment, and approval of the new
role remain separate release steps. Verify blob presence at every advertised
server before publishing each newly built manifest.
