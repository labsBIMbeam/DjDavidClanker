# dj-crate-ingest

Every road into the crate runs the same pipeline:

```
upload / watch folder / URL handler
        │
        ▼
loudness normalize (2-pass ffmpeg loudnorm, −14 LUFS, TP −1)
        ▼
tags (mutagen; "Artist - Title" filename fallback)
        ▼
LIBRARY/Artist/Title.ext  ──►  Navidrome (optional scan trigger)
```

The library folder is what Navidrome serves, and Navidrome is what the DJ
app's **Server** tab plays from — the single source of truth for play-ready
material.

## Gates in

- **`POST /ingest`** — multipart file upload (MP3/FLAC/WAV/OGG/M4A). The DJ
  app's ⤴ button on local session tracks posts here.
- **Watch folder** — drop or copy files in (e.g. an existing collection);
  a file is picked up once its size stops changing.
- **`POST /ingest/url`** `{"url": "…"}` — pluggable handlers. Shipped:
  `magnet_aria2.py` (magnet links / .torrent, e.g. Archive.org netlabel
  torrents; needs `aria2c`). Drop additional site-specific handlers into
  `handlers/` as `*.local.py` — they load like any handler but are
  gitignored, so they never enter the repository.

## Run

```bash
cd ingest
uv sync
LIBRARY_DIR=/nas/music WATCH_DIR=/nas/ingest-watch \
  uv run uvicorn app:app --host 0.0.0.0 --port 8321
```

Env: `LIBRARY_DIR`, `WATCH_DIR`, `INGEST_DATA` (inbox/work/failed),
`LOUDNESS_I` (default −14), and optionally `NAVIDROME_URL` /
`NAVIDROME_USER` / `NAVIDROME_PASS` for the scan trigger (Navidrome's own
folder watcher makes this optional).

## Tests

```bash
uv run pytest          # needs ffmpeg on PATH for the pipeline tests
uv run ruff check .
```

Failed files land in `data/failed/` instead of stalling the queue.
