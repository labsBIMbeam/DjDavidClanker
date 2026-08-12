"""Crate ingest service — every road into the library runs the same pipeline.

Gates in:  POST /ingest (file upload), a watch folder on disk, and pluggable
URL handlers (POST /ingest/url — e.g. magnet links via aria2).
Pipeline:  two-pass ffmpeg loudnorm to -14 LUFS -> tags (mutagen, with an
"Artist - Title" filename fallback) -> LIBRARY/Artist/Title.ext -> optional
Navidrome scan trigger. The library is the single source of truth the DJ app
reads through its Server tab.

Run:  uv run uvicorn app:app --host 0.0.0.0 --port 8321
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from mutagen import File as MutagenFile
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC

import handlers

log = logging.getLogger("ingest")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DATA = Path(os.environ.get("INGEST_DATA", "./data")).resolve()
INBOX = DATA / "inbox"
WORK = DATA / "work"
FAILED = DATA / "failed"
WATCH = Path(os.environ.get("WATCH_DIR", str(DATA / "watch"))).resolve()
LIBRARY = Path(os.environ.get("LIBRARY_DIR", str(DATA / "library"))).resolve()
LOUDNESS_I = os.environ.get("LOUDNESS_I", "-14")
AUDIO_EXT = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aiff", ".opus"}

for d in (INBOX, WORK, FAILED, WATCH, LIBRARY):
    d.mkdir(parents=True, exist_ok=True)

stats = {"done": 0, "failed": 0}


def parse_name(path: Path) -> tuple[str, str]:
    """Artist/title from tags, falling back to an 'Artist - Title' filename."""
    audio = MutagenFile(path, easy=True)
    artist = title = ""
    if audio and audio.tags:
        artist = (audio.tags.get("artist") or [""])[0]
        title = (audio.tags.get("title") or [""])[0]
    if not (artist and title):
        m = re.match(r"^(.+?)\s+-\s+(.+)$", path.stem)
        if m:
            artist = artist or m.group(1).strip()
            title = title or m.group(2).strip()
    return artist or "Unknown Artist", title or path.stem


def _loudnorm_measure(src: Path) -> dict:
    flt = f"loudnorm=I={LOUDNESS_I}:TP=-1:LRA=11:print_format=json"
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(src), "-af", flt, "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    tail = proc.stderr[proc.stderr.rindex("{") :]
    return json.loads(tail[: tail.index("}") + 1])


def sanitize(part: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", part).strip() or "_"


def process_file(src: Path) -> Path:
    """Loudnorm -> tag -> place in the library. Returns the final path."""
    artist, title = parse_name(src)
    keep_flac = src.suffix.lower() == ".flac"
    out_ext = ".flac" if keep_flac else ".mp3"
    out = WORK / f"{uuid.uuid4().hex}{out_ext}"

    m = _loudnorm_measure(src)
    flt = (
        f"loudnorm=I={LOUDNESS_I}:TP=-1:LRA=11"
        f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
        f":offset={m['target_offset']}:linear=true"
    )
    codec = ["-c:a", "flac"] if keep_flac else ["-c:a", "libmp3lame", "-b:a", "320k"]
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            str(src),
            "-af",
            flt,
            "-ar",
            "44100",
            *codec,
            str(out),
        ],
        capture_output=True,
        check=True,
    )

    if keep_flac:
        tags = FLAC(out)
        tags["artist"] = artist
        tags["title"] = title
        tags["comment"] = "dj-crate-ingest"
        tags.save()
    else:
        try:
            tags = EasyID3(out)
        except Exception:
            tags = MutagenFile(out, easy=True)
            tags.add_tags()
        tags["artist"] = artist
        tags["title"] = title
        tags.save()

    dest_dir = LIBRARY / sanitize(artist)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{sanitize(title)}{out_ext}"
    if dest.exists():  # same name again: keep both, disambiguate by content
        digest = hashlib.sha1(out.read_bytes()).hexdigest()[:8]
        dest = dest_dir / f"{sanitize(title)}.{digest}{out_ext}"
    shutil.move(str(out), dest)
    log.info("library <- %s / %s (%s)", artist, title, dest.name)
    return dest


def _stable(path: Path, seen: dict[Path, int]) -> bool:
    """A file counts as complete once its size stops changing between polls."""
    size = path.stat().st_size
    ok = seen.get(path) == size and size > 0
    seen[path] = size
    return ok


def process_pending(seen: dict[Path, int] | None = None) -> int:
    """One worker cycle over inbox + watch folder. Returns files processed."""
    seen = seen if seen is not None else {}
    done = 0
    for folder in (INBOX, WATCH):
        for path in sorted(folder.iterdir()):
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXT:
                continue
            if not _stable(path, seen):
                continue
            try:
                process_file(path)
                path.unlink()
                stats["done"] += 1
                done += 1
            except Exception as e:  # a broken file must not stall the queue
                log.warning("failed %s: %s", path.name, e)
                shutil.move(str(path), FAILED / path.name)
                stats["failed"] += 1
    if done:
        trigger_scan()
    return done


def trigger_scan() -> None:
    """Ask Navidrome to rescan (optional; it also watches the folder itself)."""
    base = os.environ.get("NAVIDROME_URL", "")
    user = os.environ.get("NAVIDROME_USER", "")
    pw = os.environ.get("NAVIDROME_PASS", "")
    if not (base and user and pw):
        return
    salt = secrets.token_hex(4)
    token = hashlib.md5((pw + salt).encode()).hexdigest()
    q = urllib.parse.urlencode(
        {"u": user, "t": token, "s": salt, "v": "1.16.1", "c": "ingest", "f": "json"}
    )
    try:
        urllib.request.urlopen(f"{base.rstrip('/')}/rest/startScan?{q}", timeout=5)
    except Exception as e:
        log.warning("scan trigger failed: %s", e)


app = FastAPI(title="dj-crate-ingest")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health() -> dict:
    pending = sum(1 for f in (*INBOX.iterdir(), *WATCH.iterdir()) if f.is_file())
    return {"ok": True, "pending": pending, **stats}


@app.post("/ingest")
async def ingest(file: UploadFile) -> dict:
    name = Path(file.filename or "upload.bin").name
    dest = INBOX / f"{uuid.uuid4().hex[:8]}_{name}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    log.info("inbox <- %s (%d bytes)", name, dest.stat().st_size)
    return {"ok": True, "queued": name}


@app.post("/ingest/url")
async def ingest_url(payload: dict) -> dict:
    url = str(payload.get("url", ""))
    handler = handlers.find(url)
    if not handler:
        return {"ok": False, "error": "no handler for this URL"}

    async def run() -> None:
        work = WORK / uuid.uuid4().hex
        work.mkdir(parents=True)
        try:
            files = await asyncio.to_thread(handler.fetch, url, work)
            for f in files:
                shutil.move(str(f), INBOX / f.name)
            log.info("url handler %s delivered %d file(s)", handler.__name__, len(files))
        except Exception as e:
            log.warning("url handler failed: %s", e)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    asyncio.get_running_loop().create_task(run())
    return {"ok": True, "handler": handler.__name__}


@app.on_event("startup")
async def start_worker() -> None:
    async def loop() -> None:
        seen: dict[Path, int] = {}
        while True:
            try:
                await asyncio.to_thread(process_pending, seen)
            except Exception as e:
                log.warning("worker cycle failed: %s", e)
            await asyncio.sleep(2)

    asyncio.get_running_loop().create_task(loop())
