# Proposed upstream change

PR title: `feat: add music playback archetype`

## What

Add `naat/music.md` using the [adjacent role entry](naat/music.md), and add this
row to upstream `ARCHETYPES.md`:

```markdown
| [NAAT-MUSIC](naat/music.md) | `music` | Plays a music selection and controls its playback queue | `napplet:music/open` | Draft |
```

Keep the [open convention](conventions/music-open.md) separate from the role
entry. No runtime domain, numbered NAP, or new NIP-5D message type is introduced.

## Why

Music catalogs, playlist tools and synthesizers need to hand a selection to the
user's player without embedding it or selecting its implementation. A simple
player and a two-deck DJ can fulfill the same playback role. Instrument creation
has a different boundary and must not be absorbed into a broad music super-app.

## Implementation and testing

This local David branch provides two consumers and an original synth export
producer. Tests cover payload rejection before mutation, URL policy, duplicate
delivery, stopped/live transport preservation, metadata and artifact hashes.
The code is a reference candidate; it has not been deployed or accepted upstream.
Add a public implementation revision and browser evidence before submission.

## Review questions

- Does `music` clearly denote playback, or should the registry prefer `music-player`?
- Is append-only opening the right non-destructive interoperability floor?
- Should content-addressed Blossom/Nostr references be an additional convention
  after an independent consumer is implemented?

No upstream issue or PR was opened by preparing this file.
