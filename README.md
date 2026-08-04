# DJ David Clanker

Ein Zwei-Deck-DJ-Mixer für [Wavlake](https://wavlake.com)-Musik, gebaut als
**Napplet** nach [NIP-5D](https://github.com/nostr-protocol/nips/pull/2303) —
eine sandboxed Single-Purpose-App, die Signing, Storage, Relays und Netzwerk an
eine Host-Shell delegiert.

```
┌────────── Host-Shell (NIP-5D) ──────────────────────────────┐
│  iframe srcdoc, sandbox="allow-scripts", connect-src 'none' │
│                                                             │
│   ┌── DJ David Clanker ────────────────────────────────┐    │
│   │  Deck A ──┐                                        │    │
│   │           ├─ Crossfader ─ Master ─ Ausgabe         │    │
│   │  Deck B ──┘                                        │    │
│   │  Browser: Charts · Suche · Crate · Nostr-Playlists │    │
│   └────────────────────────────────────────────────────┘    │
│        │ resource.bytes        │ outbox/relay   │ link.open │
└────────┼───────────────────────┼────────────────┼───────────┘
     Wavlake-API + CDN       Nostr-Relays     Lightning-Wallet
```

## Funktionsumfang

**Zwei Vinyl-Decks**
- **Echtes Scratchen**: der Teller ist ein Plattenteller. Ziehen bewegt die
  Audioposition 1:1 mit der Drehung (33⅓ rpm → eine halbe Umdrehung = 0,9 s),
  vorwärts wie rückwärts.
- **Vinyl-Brake und Spin-up**: Stop bremst hörbar aus, Start läuft hoch.
  Umschaltbar auf CDJ-Modus (sofortiger Start, Teller = Pitchbend).
- **Dynamischer Rewind**: gedrückt halten, der Backspin beschleunigt bis −14×.
  Antippen gibt einen Stotterer, halten einen kompletten Rewind.
- **Echte Scheibe**: Canvas-gezeichnete Platte mit dem Cover als Label,
  Rillen und wanderndem Lichtreflex. Sie dreht sich mit der *tatsächlichen*
  Rate — Bremsen, Backspin und Handscratch sieht man direkt.
- **Wellen-Ring** um die Platte: der ganze Track auf 360° gelegt, stehend
  (eine mitdrehende Waveform ist unlesbar), abgespielter Teil leuchtet,
  Nadel-Marker zeigt die Position.
- Waveform mit Playhead und Cue-Marker, Klick zum Springen
- CUE nach CDJ-Logik (stehend setzen, laufend zurückspringen)
- **Tempo-Fader** ±8 / ±16 / ±50 %, BPM-Erkennung, **SYNC** zieht BPM *und*
  Beat-Phase aufs andere Deck (inkl. Halb-/Doppeltempo)
- 3-Band-EQ mit Kill, bipolarer Filtersweep (LP ↔ HP), Trim mit Auto-Gain
- Kanalfader plus VU-Meter je Deck

**FX pro Deck** (Insert hinter dem Filter)
- **Flanger**: modulierte Kurzverzögerung mit Feedback — Rate, Depth, Feedback, Mix
- **Gater**: tempo-synchron auf der Deck-BPM — Division 1/4…1/32, Duty,
  Depth, weiche Flanken. Die Gain-Automation wird 0,4 s im Voraus geplant,
  damit die Flanken sample-genau sitzen und Main-Thread-Jitter egal ist.

**Soundwellen**
- Live-Scope pro Deck direkt am eigenen Analyser
- Großes Master-Scope hinter dem Crossfader — zeigt die Summe, nicht ein Deck
- Drei Darstellungen umschaltbar: `MIRROR` (gespiegelte Hüllkurve),
  `WAVE` (Zeitsignal), `BARS` (Spektrum, logarithmisch gebinnt — lineare
  FFT-Bins verschenken sonst fast die ganze Breite an die Höhen)

**Automix**
- Ein Knopf, und die Kiste läuft weiter: nächster Track wird rechtzeitig aufs
  freie Deck geladen, auf die BPM gezogen und im Outro übergeblendet
- Queue kommt aus der aktuellen Browser-Liste (`⤓ Liste`), Überblendzeit
  2–45 s, SYNC und SHUFFLE einzeln schaltbar, `⏭` blendet sofort
- Greift **nie** in den Audiograph — nutzt dieselben Deck- und Mixer-Methoden
  wie die Buttons, also kann man jederzeit dazwischenfahren
- Einschalten mitten im Set übernimmt das laufende Deck, statt neu anzufangen

**Mixer**
- Crossfader mit Konstant-Power-Kurve, Master mit Pegelanzeige

**Musikquellen**
- Wavlake Top 40 / Top 100 / Neu / Zufall / Genre-Zufall
- Katalogsuche (Tracks, Artists, Alben)
- Crate: gespeicherte Artists und Alben, persistiert über `storage`
- Nostr: kind-30003-Sets werden geladen und die enthaltenen
  Wavlake-Links zu spielbaren Tracks aufgelöst

**Value4Value**
- Zap-Button pro Track und pro Deck
- Setlist der Session als kind-30003-Event veröffentlichen

## Was NIP-5D hier erzwingt

Diese drei Einschränkungen prägen die gesamte Architektur — sie sind keine
Designentscheidungen, sondern Vorgaben der Spec:

1. **Kein Netzwerk im Napplet.** Der Sandbox-Iframe läuft mit
   `connect-src 'none'`; `fetch`, WebSocket und `localStorage` existieren nicht.
   Alles läuft über `resource.bytes` — der Host holt die Bytes. Das ist hier ein
   Glücksfall: Wavlakes Audio-CDN sendet *keine* CORS-Header, ein direkter
   Browser-Fetch der MP3 wäre unmöglich. Der Host kennt diese Schranke nicht.
   → `src/lib/nap.js`

2. **`img-src data: blob:`.** Ein `<img src="https://…">` lädt in der Sandbox
   nicht. Artwork geht deshalb ebenfalls über `resource.bytes` und wird als
   Blob-URL in den DOM gegeben (mit LRU-Cache).
   → `src/lib/artwork.js`

3. **Keine Signier-API, keine Payment-Domain.** Ein Napplet kann Events nur
   *publizieren* (der Host signiert dabei), nicht bloß signieren. Und es gibt
   keinerlei Wallet-Zugang. Ein echter NIP-57-Zap braucht aber genau das: einen
   signierten, *nicht* publizierten kind-9734-Request. Deshalb zwei Modi:

   | Modus | Was passiert | Nostr-Quittung |
   |---|---|---|
   | `lnurl` (Default) | LNURL-pay an die Lightning-Adresse aus dem Artist-Profil, Boost-Text als LNURL-Kommentar | nein |
   | `nip57` | 9734 wird via `outbox.publish` signiert — landet dabei auch auf deinen Relays | ja (kind 9735) |

   Die Invoice geht danach an WebLN oder per `link.open` als `lightning:`-URI an
   die externe Wallet.
   → `src/lib/zap.js`

## Audio-Backends

Zwei Pfade hinter einer Deck-API (`src/audio/engine.js`):

| Backend | Voraussetzung | Kann |
|---|---|---|
| `buffer` (**FULL**) | Rohbytes verfügbar → `decodeAudioData` | EQ, Filter, FX, Scratch, Waveform, BPM, samplegenaues Cue, VU |
| `element` (**BASIC**) | nur `<audio>`-Streaming | Crossfade über Lautstärke, Tempo über `playbackRate` |

Im Napplet ist FULL der Normalfall (`resource.bytes`). Standalone ohne Proxy
bleibt nur BASIC — das Badge am Deck zeigt an, welcher Pfad aktiv ist.

Kein Timestretch: Pitch und Tempo hängen zusammen, wie bei Vinyl. Der
`playbackRate` der Web Audio API kann nichts anderes.

### Wie das Scratchen funktioniert

Ein `AudioBufferSourceNode` läuft nur vorwärts — `playbackRate` darf nicht
negativ werden. Deshalb hat jedes Deck zwei Transport-Modi:

| Modus | Wer spielt | Wofür |
|---|---|---|
| `source` | ein langer `AudioBufferSourceNode` | normaler Betrieb, artefaktfrei |
| `platter` | granularer *Turntable* (`src/audio/scratch.js`) | Scratch, Brake, Spin-up, Backspin |

Der Turntable schedult 22-ms-Körner mit kurzen Rampen an den Nahtstellen (ohne
die klickt es hörbar) und liest bei negativer Rate aus einer **vorab
umgedrehten Kopie** des Buffers. Die wird erst *nach* dem Dekodieren gebaut, um
den Ladeweg nicht zu blockieren.

Wichtig für die Haptik: solange die Hand auf der Platte liegt, gehört die
Position der Hand (`autoAdvance = false`) — sonst würden Zeiger *und*
Grain-Scheduler beide vorschieben und jede Geste doppelt zählen. Beim Loslassen
übernimmt der Motor, zieht die Rate auf Nennwert und übergibt zurück an
`source`.

## Setup

```bash
npm install
npm run dev        # Vite auf :5173 — Standalone, BASIC-Modus
npm run build      # dist/index.html (single-file) + dist/.nip5a-manifest.json
npm run shell      # Build + Dev-Host-Shell auf :5178  ← so testen
```

`npm run shell` startet eine minimale NIP-5D-Shell (`dev/`), die das Napplet
über `srcdoc` mit `sandbox="allow-scripts"` lädt, den offiziellen
`@napplet/shim`-Prelude injiziert und die Domains `resource`, `identity`,
`storage`, `outbox`, `relay`, `common`, `link` bedient. Der eingebaute
Server-Proxy erlaubt echte `resource.bytes`-Fetches gegen Wavlake — dadurch
lässt sich der FULL-Pfad lokal wirklich testen.

```bash
node dev/smoke.mjs   # End-to-End-Test im echten Sandbox-Iframe (Playwright)
```

Der Test lädt Charts, wirft je einen Track auf beide Decks, prüft Dekodierung,
Waveform, BPM, Transport, Crossfader, EQ, SYNC, Nostr-Playlist-Auflösung und
Suche, und schreibt Screenshots nach `/tmp/clanker-*.png`.

## Deployment

`npm run build` erzeugt `dist/.nip5a-manifest.json` — ein kind-35129-Event mit
`d`-Tag, `path`-Hash, Aggregat-Hash und den `requires`-Tags. Für die
Veröffentlichung (Blossom-Upload + Relay-Publish):

```bash
napplet init --name dj-david-clanker --relay wss://… --server https://…
napplet deploy --dry-run
napplet deploy
```

## Projektstruktur

```
index.html              Napplet-Entry
vite.config.js          nip5aManifest(), single-file Artifact
src/
  main.js               Verdrahtung, Tastenkürzel, Settings, Setlist
  styles.css
  lib/
    nap.js              NIP-5D-Bridge + Standalone-Fallbacks
    artwork.js          Bilder über resource.bytes → blob:
    wavlake.js          catalog.wavlake.com Client
    nostr.js            kind-30003 lesen / Setlist publizieren
    zap.js              LNURL-pay bzw. NIP-57
    bech32.js           npub ↔ hex
  audio/
    engine.js           Mixer + Deck, zwei Backends, Platter-Physik
    scratch.js          Granularer Turntable + umgedrehter Buffer
    fx.js               Flanger, tempo-synchroner Gater
    automix.js          Auto-DJ-Zustandsmaschine
    analyze.js          Waveform-Peaks, RMS, BPM-Schätzung
  ui/
    platter.js          Canvas-Scheibe: Cover-Label, Rillen, Wellen-Ring
    scope.js            Live-Soundwellen (mirror / wave / bars)
    deck, mixer, browser, modal, zapmodal, dom
dev/
  shell.html            Minimale NIP-5D-Host-Shell
  serve-shell.mjs       Statischer Server + Fetch-Proxy
  smoke.mjs             Playwright-E2E
```

## Tastenkürzel

| Taste | Funktion |
|---|---|
| `Q` / `P` | Deck A / B Play-Pause |
| `W` / `O` | Deck A / B Cue |
| `X` | Automix an / aus |
| `N` | Automix: jetzt überblenden |
| `S` / `L` | Deck A / B Rewind — halten, wird schneller |
| `V` / `B` | Deck A / B zwischen VINYL und CDJ |
| `F` / `G` | Deck A Flanger / Gater |
| `H` / `J` | Deck B Flanger / Gater |
| `,` / `.` | Crossfader links / rechts |
| `M` | Crossfader mittig |
| `1` / `2` | Deck A / B synchronisieren (BPM + Beat-Phase) |
| `←` / `→` | Deck A ±5 s (mit `Alt`: Deck B) |

Für Architektur, Designentscheidungen, Testabdeckung und offene Punkte siehe
**[HANDOFF.md](HANDOFF.md)**.

## Bekannte Grenzen

- **Kein Keylock.** Tempoänderung verschiebt die Tonhöhe.
- **Scratch-Latenz** liegt bei rund 45 ms — so weit im Voraus muss die
  Grain-Queue gefüllt sein, damit nichts aussetzt. Für Baby-Scratches und
  Transformer reicht das; für Turntablism auf Wettkampfniveau nicht.
- **Der umgedrehte Buffer kostet Speicher**: nochmal so viel wie das Original,
  bei einem 6-Minuten-Stereotrack also grob 60 MB pro Deck.
- **Vinyl-Features brauchen den FULL-Modus.** Im BASIC-Modus sind Scratch,
  Brake, Rewind und FX deaktiviert — die Samples liegen dort nicht vor.
- **BPM-Erkennung** ist eine Peak-Intervall-Schätzung im Tiefband. Bei
  4/4-Material zuverlässig, bei freiem Rhythmus nicht. Gestrichelter Rahmen im
  BPM-Feld heißt „niedrige Konfidenz"; der Wert ist überschreibbar.
- **Ganze Datei wird geladen**, bevor ein Deck spielt (`resource.bytes` liefert
  laut Spec einen einzelnen Blob, kein Streaming). 4–6 MB pro Track.
- **Wavlakes Lightning-Adressen** sind nicht über die Katalog-API auffindbar.
  Der Zap geht an die `lud16` aus dem Nostr-Profil des Artists; fehlt sie,
  bietet der Dialog den Boost auf wavlake.com an.
- **NIP-5D ist ein offener PR**, die `@napplet/*`-Pakete stehen bei 0.x. Die
  Wire-Shapes hier stammen aus den ausgelieferten Type-Definitionen und können
  driften. Versionen pinnen.

## Quellen

- [NIP-5D (PR #2303)](https://github.com/nostr-protocol/nips/pull/2303) · [napplet.run](https://napplet.run/docs/)
- [Wavlake](https://wavlake.com) · `https://catalog.wavlake.com/v1` (öffentlich, ohne Key)
- [NIP-51 Sets](https://github.com/nostr-protocol/nips/blob/master/51.md) · [NIP-57 Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
