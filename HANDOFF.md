# Handoff — DJ David Clanker

Stand: 3. August 2026 · Status: **funktionsfähig, 42/42 E2E-Checks grün**

Dieses Dokument ist für die Person gedacht, die das Projekt als Nächstes anfasst
— egal ob das du in drei Monaten bist oder jemand anderes. Es beschreibt, was
gebaut ist, **warum es so gebaut ist**, was verifiziert wurde und wo die Kanten
sind.

---

## 1. Was das Ding ist

Ein Zwei-Deck-DJ-Mixer für [Wavlake](https://wavlake.com)-Musik, ausgeliefert als
**Napplet** nach [NIP-5D](https://github.com/nostr-protocol/nips/pull/2303):
eine sandboxed Single-Purpose-App, die in einem `iframe srcdoc` mit
`sandbox="allow-scripts"` läuft und Signing, Storage, Relays *und Netzwerk* an
eine Host-Shell delegiert.

Build-Artefakt ist **eine einzige `dist/index.html`** (~230 KB, alles inline)
plus `dist/.nip5a-manifest.json` (kind-35129-Event mit Pfad-Hashes und
`requires`-Tags).

---

## 2. Die drei Zwänge, die das Design bestimmen

Wer den Code liest und sich fragt „warum so umständlich" — hier ist die Antwort.
Das sind keine Stilentscheidungen, sondern Vorgaben der Spec.

### 2.1 Kein Netzwerk im Napplet

Die Sandbox läuft mit `connect-src 'none'`. Es gibt **kein `fetch`, kein
WebSocket, kein `localStorage`**. Jeder Byte kommt über `resource.bytes` —
der Host holt ihn.

Das ist hier ein Glücksfall statt einer Bremse: Wavlakes Audio-CDN
(`d12wklypp119aj.cloudfront.net`) sendet **keine CORS-Header**. Ein direkter
Browser-Fetch der MP3 wäre unmöglich; der Host kennt diese Schranke nicht.

→ `src/lib/nap.js`. Alle Aufrufe haben einen Standalone-Fallback, damit
`npm run dev` ohne Shell funktioniert.

### 2.2 `img-src data: blob:`

Ein `<img src="https://…">` lädt in der Sandbox schlicht nicht. Artwork geht
deshalb ebenfalls über `resource.bytes` und wird als **Blob-URL** in den DOM
gegeben, mit LRU-Cache (240 Einträge, ältere werden revoked).

→ `src/lib/artwork.js`. Das war ein echter Fund im ersten E2E-Lauf: die Bilder
blieben leer, bis alles über den Host lief.

### 2.3 Keine Signier-API, keine Payment-Domain

Ein Napplet kann Events nur **publizieren** (der Host signiert dabei), nicht
bloß signieren. Wallet-Zugang gibt es gar keinen. Ein echter NIP-57-Zap braucht
aber exakt das Gegenteil: einen signierten, *nicht* publizierten kind-9734.

Deshalb zwei Modi, umschaltbar in den Einstellungen:

| Modus | Was passiert | Nostr-Quittung |
|---|---|---|
| `lnurl` (Default) | LNURL-pay an die `lud16` aus dem Artist-Profil, Boost-Text als LNURL-Kommentar | nein |
| `nip57` | 9734 wird via `outbox.publish` signiert — landet dabei **auch auf den Relays** | ja (kind 9735) |

Die Invoice geht an WebLN, sonst per `link.open` als `lightning:`-URI.
Fehlt die `lud16`, bietet der Dialog den Boost auf wavlake.com an.

→ `src/lib/zap.js`

---

## 3. Architektur

```
src/
  main.js               Verdrahtung, Tasten, Settings, Setlist, Frame-Loop
  lib/
    nap.js              NIP-5D-Bridge + Standalone-Fallbacks
    artwork.js          Bilder über resource.bytes → blob:
    wavlake.js          catalog.wavlake.com Client (öffentlich, kein Key)
    nostr.js            kind-30003 lesen / Setlist publizieren
    zap.js              LNURL-pay bzw. NIP-57
    bech32.js           npub ↔ hex
  audio/
    engine.js           Mixer + Deck, zwei Backends, Platter-Physik
    scratch.js          Granularer Turntable (Overlap-Add) + umgedrehter Buffer
    fx.js               5 Insert-FX: Flanger, Phaser, Gater, Echo, Reverb
    automix.js          Auto-DJ-Zustandsmaschine
    analyze.js          Waveform-Peaks, RMS, BPM v2 (Comb-Autokorrelation + Beat-Phase)
  ui/
    deck.js  platter.js  scope.js  mixer.js  automixbar.js
    browser.js  modal.js  zapmodal.js  dom.js
dev/
  shell.html            Minimale NIP-5D-Host-Shell
  serve-shell.mjs       Statischer Server + Fetch-Proxy
  smoke.mjs             Playwright-E2E (42 Checks)
```

Ein einziger `requestAnimationFrame`-Loop in `main.js` treibt alles:
`mixer.tickAudio()` (Platter-Physik + Gater-Scheduling), `automix.tick(dt)`,
dann die UI-Ticks. Kein Modul hat eigene Timer — **Ausnahme**: der Turntable
nutzt `setInterval(10ms)`, weil Grain-Scheduling einen gedrosselten
Animation-Frame überleben muss.

### 3.1 Zwei Audio-Backends

| Backend | Voraussetzung | Kann |
|---|---|---|
| `buffer` (**FULL**) | Rohbytes → `decodeAudioData` | EQ, Filter, FX, Scratch, Waveform, BPM, samplegenaues Cue |
| `element` (**BASIC**) | nur `<audio>`-Streaming | Crossfade über Lautstärke, Tempo über `playbackRate` |

Im Napplet ist FULL der Normalfall. Standalone ohne CORS-Proxy bleibt BASIC.
Das Badge am Deck zeigt den aktiven Pfad.

### 3.2 Drei Transport-Modi im Buffer-Backend

Ein `AudioBufferSourceNode` läuft nur vorwärts — `playbackRate` darf nicht
negativ werden. Daher:

| `deck._mode` | Wer spielt | Wofür |
|---|---|---|
| `idle` | niemand | gestoppt |
| `source` | ein langer `AudioBufferSourceNode` | Normalbetrieb, artefaktfrei |
| `platter` | granularer Turntable | Scratch, Brake, Spin-up, Backspin |

Übergänge laufen über `_enterSource` / `_enterPlatter` / `_enterIdle`. Der
Motor (`_motorTo(target, seconds, done)`) zieht die Rate und ruft danach den
Callback — so übergibt z. B. der Spin-up sauber an `source`.

`position` und `currentRate` lesen in allen drei Modi korrekt. **Wer hier
etwas ändert, muss beide Getter mitdenken.**

### 3.3 Wer besitzt die Position?

Der subtilste Punkt im ganzen Projekt, und die Ursache eines Bugs, der zwei
Testläufe gekostet hat:

`Turntable.autoAdvance` entscheidet, wer die Abspielposition vorschiebt.
Bei Motorbetrieb (Bremse, Backspin, Hochlauf) macht es der Grain-Scheduler.
**Liegt eine Hand auf der Platte, gehört die Position der Hand** — sonst
schieben Zeiger *und* Scheduler, und jede Geste zählt doppelt (gemessen:
1,78 s statt 0,9 s für eine halbe Umdrehung).

Der E2E-Test prüft das explizit: `half a platter turn ≈ 0.9 s of audio`.

### 3.4 Automix

Zustandsmaschine in `src/audio/automix.js`, getrieben von `tick(dt)`.
**Sie greift nie in den Audiograph** — sie ruft nur dieselben öffentlichen
Deck- und Mixer-Methoden auf wie die Buttons. Deshalb kann ein Mensch jederzeit
dazwischenfahren, ohne dass der Zustand inkonsistent wird.

Ablauf: live-Deck bestimmen → nächsten Track rechtzeitig aufs freie Deck laden
(`preloadLead`, Default 35 s — Fetch + Decode dauern echte Sekunden) → bei
`fadeSeconds` Restzeit auf die BPM ziehen, starten, Crossfader rüberfahren →
Rollen tauschen.

Zwei Verhaltensweisen, die aus Bugs entstanden sind:

- **`start()` adoptiert, was schon läuft.** Automix mitten im Set einschalten
  macht nicht bei Null weiter, sondern übernimmt das laufende Deck und stoppt
  ein eventuelles zweites.
- **Ein fremd laufendes Idle-Deck wird gestoppt statt übersprungen.** Vorher
  blockierte das jede Transition — Automix stand still, ohne Fehler zu melden.
  Stilles Blockieren ist der schlimmere Bug.

Ein bereits manuell gecuetes Idle-Deck wird **behalten und als nächstes
gespielt** — das ist Absicht.

---

## 4. Was verifiziert ist

`node dev/smoke.mjs` fährt die echte App im echten Sandbox-Iframe gegen die
echte Wavlake-API. Keine Mocks außer der Nostr-Fixture. Letzter Lauf: **42/42**.

Abgedeckt: Boot und `window.napplet`-Injektion, Charts über `resource.bytes`,
FULL-Modus-Dekodierung, Waveform, BPM (92,5 gemessen), Scratch-Richtung *und*
1:1-Mapping, Rückkehr in den `source`-Modus, Rewind-Beschleunigung (−13,4×),
Vinyl-Brake, FX-Durchsatz, Gater-Division, Scheiben-Rendering und -Rotation,
Deck- und Master-Soundwellen inkl. Modus-Wechsel, kompletter Automix-Zyklus
(Kaltstart → Preload → Crossfade → Übergabe), kind-30003-Auflösung, Suche,
Mobile-Viewport, keine Konsolenfehler.

**Fallstrick bei Playwright:** `waitForFunction(fn, {timeout})` übergibt das
Objekt als *Argument* an die Page-Funktion, nicht als Option — der Default von
30 s bleibt aktiv. Richtig ist `waitForFunction(fn, undefined, {timeout})`.
Das hat einmal einen echten Fehlschlag als Timeout getarnt.

---

## 5. Nicht verifiziert / offene Punkte

- **Kein echter Host getestet.** `dev/shell.html` ist eine selbstgebaute
  Minimal-Shell, keine konforme Implementierung. Die Wire-Shapes stammen aus
  den ausgelieferten `@napplet/*`-Typdefinitionen. Vor dem Deploy gegen eine
  echte Shell (Kehto o. ä.) gegenprüfen.
- **NIP-5D ist ein offener PR**, die Pakete stehen bei 0.x. **Versionen pinnen.**
- **Zap-Pfad ist nie mit echten Sats gelaufen.** Die LNURL-Logik ist
  ungetestet gegen einen realen Endpunkt.
- **Wavlakes eigene Lightning-Adressen** sind über die Katalog-API nicht
  auffindbar. Der Zap geht an die `lud16` aus dem Nostr-Profil des Artists.
- `/v1/charts/music/top` ignoriert `days`, `genre` und `sort` serverseitig —
  nur `limit` wirkt. Ranking ist immer `msatTotal7Days`.
- **Kein Keylock.** Tempoänderung verschiebt die Tonhöhe (wie bei Vinyl).
- **Scratch-Latenz ~45 ms** — so weit im Voraus muss die Grain-Queue gefüllt
  sein. Baby-Scratch ja, Wettkampf-Turntablism nein. Seit dem Overlap-Add-Umbau
  (50 % Überlappung, Equal-Power-Sinusfenster, Rate-Glide pro Grain) ist das
  22-ms-Amplituden-Chattern der Stoßkanten weg.
- **BPM-Metrikebene ist eine Wahl, keine Wahrheit.** Der v2-Detektor findet die
  Periode auf ~0,02 BPM genau und liefert die Beat-Phase (`beatOffset`), aber
  bei Shuffle-Material konkurrieren 2:3-Ebenen — „Worn-Out War" las der alte
  Detektor als 92,5, der neue als 138,7 (= ×1,5). Kandidaten ½/2/⅔/1,5 werden
  gegeneinander gewogen (Grid-Energie, 12 %-Marge); das BASE-Feld bleibt
  editierbar für den Fall, dass die Wahl daneben liegt.
- **Cue-Ausgang nie mit echter zweiter Hardware verifiziert.** Der Bus, die
  MediaStream-Brücke und `setSinkId` sind E2E-geprüft, aber nicht mit einem
  realen zweiten Interface. In der Napplet-Sandbox braucht Gerätewahl die
  `speaker-selection`-Permission vom Host; ohne sie landet Cue auf dem
  Standardausgang.
- **Der umgedrehte Buffer verdoppelt den Speicher**: grob 60 MB pro Deck bei
  einem 6-Minuten-Stereotrack.
- **Ganze Datei vor dem Abspielen**, weil `resource.bytes` laut Spec einen
  einzelnen Blob liefert, kein Streaming.
- `window.__djclanker` ist ein Debug-Handle für die Tests. Vor einem
  öffentlichen Release entweder entfernen oder bewusst dokumentieren.

### Naheliegende nächste Schritte

1. Gegen eine echte Shell testen, `requires`-Liste verifizieren.
2. Hot Cues und Loops (die Infrastruktur — samplegenaues Seek — steht schon).
3. ~~Beat-Grid statt nur BPM~~ — erledigt: `beatOffset` + `barOffset`
   (Downbeat) aus dem Detektor, `alignPhase()` rechnet auf echten Grids,
   `armDrop()` startet samplegenau auf der Takt-1. Der Downbeat ist eine
   **Kick-Energie-Heuristik** über die vier Beat-Phasenklassen — bei 4/4-Elektronik
   meist richtig, bei Offbeat-Bässen auch mal die 3 statt der 1; der Drop landet
   dann trotzdem auf einer Grid-Linie, nur um zwei Beats versetzt.
4. Automix: Übergang auf den Takt legen — `armDrop()` liefert den Mechanismus,
   die Automix-Zustandsmaschine nutzt ihn noch nicht.
5. Waveform-Overview mit Beat-Markern.

---

## 6. Betrieb

```bash
npm install
npm run dev        # Vite :5173 — Standalone, BASIC-Modus
npm run build      # dist/index.html + dist/.nip5a-manifest.json
npm run shell      # Build + Dev-Host-Shell auf :5178  ← so testen
node dev/smoke.mjs # E2E, Screenshots nach /tmp/clanker-*.png
```

`npm run shell` braucht den eingebauten Server-Proxy: `resource.bytes` muss
Hosts erreichen, die keine CORS-Header senden — das kann eine reine
Browser-Shell nicht. Erlaubte Hosts stehen in `dev/serve-shell.mjs`
(`ALLOW_HOSTS`).

Deployment:

```bash
napplet init --name dj-david-clanker --relay wss://… --server https://…
napplet deploy --dry-run
napplet deploy
```

Playwright liegt in dieser Umgebung global. Falls `node dev/smoke.mjs` das
Paket nicht findet:

```bash
ln -sfn "$(npm root -g)/playwright" node_modules/playwright
ln -sfn "$(npm root -g)/playwright-core" node_modules/playwright-core
```

---

## 7. Design-Referenz

Seit August 2026 folgt die App dem **600B Design System v0.2.0**
(`600B Design System — Print.pdf` im 600000000000-Repo). Tokens stehen als
CSS-Custom-Properties oben in `src/styles.css` — die `--c-*`-Ebene ist das
System, die semantische Ebene darunter die App-Zuordnung:

| Token | Wert | Rolle |
|---|---|---|
| `--bg` | `#111111` (Soot) | Seitenhintergrund |
| `--panel` / `--panel-2` | `#1a1917` / `#222222` (Charcoal) | Flächen, immer als Verlauf |
| `--line` | `#2a1810` (Volcanic) | Rahmen, Trenner |
| `--text` / `--muted` | `#fff7ec` (Ember White) / `#a89f90` | Schrift |
| `--a` / `--b` | `#f7931a` (Orange) / `#f3c244` (Gold) | Deck A / Deck B, durchgängig |
| `--zap` | `#ff6a00` (Ember) | Value4Value, aktive FX, Cue-Marker, Loop |
| `--ok` / `--bad` | `#ffa733` (Bright) / `#d93000` (abgeleitet) | Zustände, Rückwärtslauf |

`--bad` ist kein Print-Token — Ember vertieft, weil das System keine
Alarmfarbe definiert. Typo: Buttons/Labels **Impact** (sharp, caps, Hover
heller, Press `scale(.97)`), Fließtext **Trebuchet MS**, Modal-Prosa
**Georgia**, Maschinelles **JetBrains Mono** mit Fallback-Stack — alles
Systemfonts, nichts wird geladen (CSP). Badges und Buttons sind `r-0` (sharp),
Flächen `r-2` (8 px). Der drehende Teller trägt den `r-stone`-Ember-Glow.
Bewusste Abweichung: die funktionalen Glyphen (⚡ 🎧 📁 …) bleiben, obwohl die
Brand-Voice „no emoji" sagt — Bedienbarkeit schlägt Reinheit.

Regeln, die sich durchziehen:

- **Deckfarbe ist identitätsstiftend.** A ist überall Orange, B überall Gold
  — Waveform, Label-Ring, Scheibe, Load-Buttons, Scope-Verlauf.
- **Monospace für alles Maschinelle** (BPM, Prozente, Badges),
  Body-Sans für Inhalte (Track-Titel, Artists), Impact für Bedienelemente.
- **Bipolare Regler haben eine Mittelrast** als zweiter Hintergrundverlauf —
  Pitch, EQ, Filter, Crossfader. „Neutral" muss man mit dem Auge finden können.
- **Vertikale Fader zeichnen ihre Nut selbst**, nicht über
  `::-webkit-slider-runnable-track`: das überlebt `writing-mode: vertical-lr`
  nicht zuverlässig.
- **Canvas statt DOM**, wo pro Frame gezeichnet wird — Scheibe, Waveform,
  Scopes. Statische Anteile liegen in Offscreen-Canvases und werden geblittet.
- **Breakpoints**: 1000 px (Decks untereinander, Browser-Sidebar oben),
  640 px (Deck-Innenraster auf `grid-template-areas`).
- `prefers-reduced-motion` schaltet die Toast-Animation ab. Die
  Plattenrotation bleibt — sie ist Statusanzeige, keine Dekoration.

Interaktionen mit nicht offensichtlichem Verhalten:

| Element | Verhalten |
|---|---|
| Plattenteller | Winkelbasiert, nicht x-basiert: eine Umdrehung = 1,8 s Audio, egal wo man greift |
| CUE | Stehend: Punkt setzen. Laufend: zurückspringen und pausieren |
| REW | Halten. Zieltempo wächst mit der Haltedauer bis −14× |
| SYNC | **Latch**: einschalten matcht BPM (auch Halb-/Doppel- und 2:3-Ebenen) und hält die Phase dann dauerhaft — Micro-Nudge bei kleinen, Hard-Realign bei großen Fehlern. Zweiter Klick löst |
| LOOP-Leiste | IN/OUT für manuelle Loops, 1/2/4/8 rasten auf dem Beat-Grid ein, EXIT verlässt. Aktiver Loop hält den Automix-Übergang auf |
| 📁 LOKAL / Drag&Drop | Lokale Audiodateien in die Liste bzw. direkt aufs Deck — immer FULL-Modus, kein Zap-Ziel, nicht in der persistenten Playlist |
| BPM-Anzeige | Groß = effektiv (Basis × Tempofader), klein editierbar = BASE |
| FX-Slot-Dropdown | Wählt, welchen der 5 Effekte der Button (bzw. F/G/H/J) schaltet; Doppelwahl tauscht die Slots |
| 🎧 (am Kanal) | Pre-Fader-Vorhören auf den Cue-Bus (Tasten E/I) |
| 🔈 (im Mixer) | Sound-Ausgänge-Menü: Master- und Kopfhörer-Gerät, greift sofort; „Gerätenamen freischalten" holt die Labels über eine Medienberechtigung |
| Kill-Buttons (HI/MID/LOW) | Toggle auf −26 dB und zurück auf 0 |
| Scope-Label | Klick wechselt MIRROR → WAVE → BARS |
| Waveform | Klick springt (im sichtbaren Fenster), Mausrad oder −/+ zoomt ×1–×64, ×1-Label setzt zurück. Gezoomt folgt das Fenster dem Playhead und rendert live aus 8k-Peaks; Takt-1-Linien sind kräftiger und auf den erkannten Downbeat geankert. Doppelklick auf eine Trackzeile lädt in Deck A |
| DROP (Tasten 3/4) | Startet das Deck samplegenau auf der nächsten Takt-1 des anderen Decks — Tempo vorher gesynct, eigener Einstieg = Cue auf die eigene 1 gesnappt, CDJ-Start ohne Vinyl-Anlauf. Nochmal drücken bricht ab |
| „+" an der Trackzeile / „+ alle" über der Liste | Track(s) in die Playlist (Crate-Tab). Dort: Menü aller Einträge, ×-entfernen, Anzeige als ladbare Liste |

---

## 8. Quellen

- [NIP-5D (PR #2303)](https://github.com/nostr-protocol/nips/pull/2303) · [napplet.run](https://napplet.run/docs/)
- Wavlake-Katalog: `https://catalog.wavlake.com/v1` (öffentlich, ohne Key).
  `api.wavlake.com` existiert **nicht** — löst nicht auf.
- [wavlake/mobile](https://github.com/wavlake/mobile) (Endpunkte, NIP-98-Auth),
  [wavlake/wavman](https://github.com/wavlake/wavman) (Zap-Logik)
- [NIP-51 Sets](https://github.com/nostr-protocol/nips/blob/master/51.md) ·
  [NIP-57 Zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
