# NAAT-MUSIC · `music`

**Recommended open contract:** `napplet:music/open`
**Actions:** open

A napplet that plays a music selection and controls its playback queue.

- **IS:** listening or DJ playback of supplied music, including transport,
  queue order and transitions between tracks.
- **IS NOT:** sound synthesis or sequencing an instrument; maintaining a music
  catalog; editing a saved playlist; displaying a general event feed; managing
  payment credentials or independently routing other napplets' audio.
- **Distinct from:** `feed` (playing music vs. browsing events) · `note`
  (a playback session vs. inspecting an event) · `composer` (playing existing
  audio vs. authoring a Nostr event).
