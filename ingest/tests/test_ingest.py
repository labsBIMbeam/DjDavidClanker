"""Pipeline and API tests. The pipeline tests need ffmpeg on PATH."""

from __future__ import annotations

import io
import math
import shutil
import struct
import wave
from pathlib import Path

import pytest

import app as ingest


def make_wav(path: Path, seconds: float = 2.0, sr: int = 44100) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(int(seconds * sr)):
            v = int(0.3 * 32767 * math.sin(2 * math.pi * 220 * i / sr))
            frames += struct.pack("<h", v)
        w.writeframes(bytes(frames))


ffmpeg = shutil.which("ffmpeg") is not None


@pytest.fixture(autouse=True)
def clean_dirs():
    for d in (ingest.INBOX, ingest.WATCH, ingest.LIBRARY, ingest.FAILED, ingest.WORK):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True, exist_ok=True)
    yield


def test_parse_name_from_filename(tmp_path: Path) -> None:
    f = tmp_path / "Some Artist - A Great Track.wav"
    make_wav(f, 0.2)
    artist, title = ingest.parse_name(f)
    assert artist == "Some Artist"
    assert title == "A Great Track"


def test_parse_name_fallback(tmp_path: Path) -> None:
    f = tmp_path / "untitled_take3.wav"
    make_wav(f, 0.2)
    artist, title = ingest.parse_name(f)
    assert artist == "Unknown Artist"
    assert title == "untitled_take3"


@pytest.mark.skipif(not ffmpeg, reason="ffmpeg not on PATH")
def test_pipeline_wav_to_library() -> None:
    src = ingest.WATCH / "Pipe Artist - Pipe Track.wav"
    make_wav(src)
    seen: dict[Path, int] = {}
    assert ingest.process_pending(seen) == 0  # first sight: size not yet stable
    assert ingest.process_pending(seen) == 1  # second sight: processed
    out = list(ingest.LIBRARY.rglob("*.mp3"))
    assert len(out) == 1
    assert out[0].parent.name == "Pipe Artist"
    assert out[0].stem == "Pipe Track"
    assert not src.exists()

    from mutagen.easyid3 import EasyID3

    tags = EasyID3(out[0])
    assert tags["artist"] == ["Pipe Artist"]
    assert tags["title"] == ["Pipe Track"]


@pytest.mark.skipif(not ffmpeg, reason="ffmpeg not on PATH")
def test_broken_file_goes_to_failed() -> None:
    bad = ingest.INBOX / "Broken - File.mp3"
    bad.write_bytes(b"this is not audio")
    seen: dict[Path, int] = {}
    ingest.process_pending(seen)
    assert ingest.process_pending(seen) == 0
    assert not bad.exists()
    assert (ingest.FAILED / bad.name).exists()


def test_upload_endpoint_lands_in_inbox() -> None:
    from fastapi.testclient import TestClient

    client = TestClient(ingest.app)
    buf = io.BytesIO(b"RIFF....fake")
    r = client.post("/ingest", files={"file": ("Up Artist - Up Track.wav", buf, "audio/wav")})
    assert r.status_code == 200
    assert r.json()["ok"] is True
    inbox = list(ingest.INBOX.iterdir())
    assert len(inbox) == 1
    assert inbox[0].name.endswith("Up Artist - Up Track.wav")


def test_magnet_handler_claims_urls() -> None:
    import handlers

    assert handlers.find("magnet:?xt=urn:btih:abc") is not None
    assert handlers.find("https://example.org/album.torrent") is not None
    assert handlers.find("https://example.org/page") is None


def test_direct_url_handler_claims_audio_urls() -> None:
    import handlers

    direct = handlers.find("https://archive.org/download/x/track.mp3")
    assert direct is not None and direct.__name__.endswith("direct_url")
    assert handlers.find("https://node.audius.co/v1/tracks/abc/stream?app_name=x") is not None
    assert handlers.find("http://insecure.example/track.mp3") is None
    assert handlers.find("https://example.org/page.html") is None


class FakeHandler:
    __name__ = "fake"

    @staticmethod
    def can_handle(url: str) -> bool:
        return True

    @staticmethod
    def fetch(url: str, workdir: Path) -> list[Path]:
        f = workdir / "stream.mp3"
        f.write_bytes(b"fake-bytes")
        return [f]


def test_deliver_url_renames_single_find_with_metadata() -> None:
    """The app sends artist/title along; a tagless single download gets the
    canonical 'Artist - Title' name so the pipeline's fallback tags it."""
    n = ingest.deliver_url("https://x/stream", "Disco Very", "Found It", FakeHandler)
    assert n == 1
    assert [f.name for f in ingest.INBOX.iterdir()] == ["Disco Very - Found It.mp3"]


def test_ingest_url_endpoint_accepts_and_schedules(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    import handlers as handlers_mod

    monkeypatch.setattr(handlers_mod, "find", lambda url: FakeHandler)
    client = TestClient(ingest.app)
    r = client.post("/ingest/url", json={"url": "https://x/stream"})
    assert r.status_code == 200
    assert r.json()["ok"] is True and r.json()["handler"] == "FakeHandler"
    monkeypatch.undo()
    no = client.post("/ingest/url", json={"url": "https://nothing.example/page"})
    assert no.json()["ok"] is False
