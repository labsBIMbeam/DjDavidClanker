"""URL-handler registry for the ingest service.

Every module in this package that exposes `can_handle(url) -> bool` and
`fetch(url, workdir: Path) -> list[Path]` becomes an ingest gate. Files
matching `*.local.py` are loaded too but are gitignored — that is where
site-specific handlers live without ever entering the repository.
"""

from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path

_HERE = Path(__file__).parent
_modules = []


def _load() -> None:
    for f in sorted(_HERE.glob("*.py")):
        if f.name.startswith("_"):
            continue
        if f.name.endswith(".local.py"):
            spec = importlib.util.spec_from_file_location(f"handlers.{f.stem}", f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        else:
            mod = importlib.import_module(f"handlers.{f.stem}")
        if hasattr(mod, "can_handle") and hasattr(mod, "fetch"):
            _modules.append(mod)


def find(url: str):
    """First handler that claims the URL, or None."""
    if not _modules:
        _load()
    for mod in _modules:
        try:
            if mod.can_handle(url):
                return mod
        except Exception:
            continue
    return None
