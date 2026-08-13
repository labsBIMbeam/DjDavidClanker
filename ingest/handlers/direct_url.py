"""Direct-download gate: a plain https audio URL goes straight to the pipeline.

This is what the DJ app's discovery promote (⤴ / auto→crate) posts: Archive.org
download links, Audius stream endpoints, Jamendo CDN files. The filename is
taken from the URL when it carries an audio extension; otherwise the extension
is sniffed from the Content-Type, and the ingest endpoint renames the file to
"Artist - Title.ext" when the app sent metadata along.
"""

from __future__ import annotations

import urllib.parse
import urllib.request
from pathlib import Path

AUDIO_EXT = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".opus", ".aiff"}
TYPE_EXT = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".m4a",
    "audio/opus": ".opus",
}


def can_handle(url: str) -> bool:
    if not url.startswith("https://"):
        return False
    path = urllib.parse.urlparse(url).path.lower()
    return Path(path).suffix in AUDIO_EXT or "/stream" in path


def fetch(url: str, workdir: Path) -> list[Path]:
    req = urllib.request.Request(url, headers={"User-Agent": "dj-crate-ingest"})
    with urllib.request.urlopen(req, timeout=600) as res:
        name = Path(urllib.parse.unquote(urllib.parse.urlparse(res.url).path)).name
        ext = Path(name).suffix.lower()
        if ext not in AUDIO_EXT:
            ctype = (res.headers.get("content-type") or "").split(";")[0].strip().lower()
            ext = TYPE_EXT.get(ctype, "")
            if not ext:
                raise RuntimeError(f"not audio: {ctype or 'unknown content-type'}")
            name = (Path(name).stem or "download") + ext
        dest = workdir / name
        with dest.open("wb") as out:
            while chunk := res.read(1 << 16):
                out.write(chunk)
    return [dest]
