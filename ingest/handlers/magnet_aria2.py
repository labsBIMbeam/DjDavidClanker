"""Magnet / torrent gate: aria2 downloads, the audio files go to the pipeline.

Meant for legitimately distributed material — Archive.org publishes torrents
for its netlabel collections, and plenty of artists ship releases this way.
Requires `aria2c` on PATH; seeding is disabled (--seed-time=0) so the job
ends when the download does.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

AUDIO_EXT = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aiff", ".opus"}


def can_handle(url: str) -> bool:
    return url.startswith("magnet:") or url.endswith(".torrent")


def fetch(url: str, workdir: Path) -> list[Path]:
    if not shutil.which("aria2c"):
        raise RuntimeError("aria2c is not installed")
    subprocess.run(
        ["aria2c", "--seed-time=0", "--summary-interval=0", "--dir", str(workdir), url],
        check=True,
        capture_output=True,
        timeout=3600,
    )
    return [p for p in workdir.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXT]
