# napplet:music/open

Status: **proposed v1**. Producer: music catalog, playlist, or rendered synth
export. Consumer: music player/DJ. This is a payload convention, not a new NAP.

## Discovery and invocation

A compatible candidate advertises action `open` and the exact convention
`napplet:music/open`. Both David builds advertise:

```json
["archetype", "music", "napplet:music/open"]
```

Check `window.napplet.intent` before calling `intent.available('music')`.
Availability comes from installed manifests, not running windows. Show the send
action only for a compatible candidate. Invoke by role without a hardcoded
handler; the shell owns the user's default, chooser and window lifecycle.

```js
await napplet.intent.invoke({
  archetype: 'music',
  action: 'open',
  convention: 'napplet:music/open',
  payload: {
    version: 1,
    tracks: [{
      url: 'https://audio.example/loop.wav',
      title: 'Night loop',
      artist: 'Synth performer'
    }]
  }
});
```

## Payload

No payload or `{}` only opens/focuses the player. A selection is an object with
exactly `version: 1` and `tracks`, an array of 0–100 track descriptors:

| Field | Required | Constraint |
|---|---|---|
| `url` | yes | Absolute HTTPS URL, at most 4096 characters; no credentials or fragment |
| `title` | yes | Nonblank text, at most 200 characters |
| `artist` | no | Nonblank text, at most 200 characters |
| `artwork` | no | Same URL rules as `url` |

v1 rejects unknown fields, unsupported versions and malformed descriptors.
The complete batch must validate before mutation. Data is treated as untrusted
text, not HTML. Metadata is not a verified artist identity or payment target.
The receiver canonicalizes URLs; waiting entries with the same canonical URL
are deduplicated. It does not mutate the producer's object.

Structured selections use an explicit payload and a queryless convention.
v1 defines no URI query shorthand, executable patches, encoded audio bytes,
local filesystem paths, Blob handles, credentials, or autoplay flag.

## Delivery and playback

The shell resolves the handler, waits until its exact INC subscription is ready,
then delivers only to that endpoint. Callers must use intent dispatch, not an
INC broadcast which could queue the selection in every open music player.
Both warm and cold delivery use the same `napplet:music/open` topic. A handler
subscribes before reporting readiness under the shell's chosen lifecycle and
closes the subscription on teardown. The app uses the injected INC API and
does not add raw cross-window message listeners.

Valid selections append to the waiting queue. They never replace the queue,
seek, start playback, stop playback, spend money or alter a running transition.
An already-running player may eventually play appended tracks through its normal
queue. A stopped player still requires its own START action. An error is shown
without partially accepting the batch.

`intent.invoke` reports dispatch, not successful decoding or playback. Host
resource policy, availability and audio decoding can still reject a URL when
the player loads it. Fetches remain host-mediated. A compatible URI must be
reachable under that host's resource policy; advertising this convention does
not grant network access.

## Synth interoperability

A synth can render a WAV, ask the host's optional UPLOAD domain to store it,
then pass the returned HTTPS reference through this convention. It checks
upload completion and intent dispatch independently. No event publishing or
payment follows implicitly. A downloaded WAV also works through David's local
file import. Notes, tempo transport, live audio routing and clock sync belong in
separate contracts and cannot be inferred from this one.
