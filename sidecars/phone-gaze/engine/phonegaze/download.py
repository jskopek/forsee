"""Download the model files the engine needs into ``engine/models/``. Owner: Foundation.

    python -m phonegaze.download            # fetch anything missing
    python -m phonegaze.download --list

Other areas register their files by adding an entry to ``MODELS`` (name -> (url, sha256 or
None)). Code finds a file with :func:`model_path`, which never downloads; call
:func:`ensure_model` to download on demand.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

MODELS_DIR = Path(os.environ.get("PHONEGAZE_MODELS", Path(__file__).resolve().parent.parent / "models"))
"""``sidecars/phone-gaze/engine/models`` (git-ignored), or ``$PHONEGAZE_MODELS``."""

MODELS: dict[str, tuple[str, str | None]] = {
    "face_landmarker.task": (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/"
        "float16/latest/face_landmarker.task",
        None,  # "latest" changes over time, so no fixed checksum
    ),
}


def model_path(name: str) -> Path:
    """Where ``name`` lives (it may not exist yet)."""
    return MODELS_DIR / name


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(name: str, *, quiet: bool = False) -> Path:
    """Return the model's path, downloading it first if it is missing."""
    path = model_path(name)
    if path.exists():
        return path
    if name not in MODELS:
        raise FileNotFoundError(f"{path} is missing and {name!r} has no download URL")
    url, digest = MODELS[name]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not quiet:
        print(f"Downloading {name} from {url}", file=sys.stderr)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        with urllib.request.urlopen(url, timeout=60) as response:
            shutil.copyfileobj(response, tmp)
    tmp_path = Path(tmp.name)
    if digest and _sha256(tmp_path) != digest:
        tmp_path.unlink()
        raise RuntimeError(f"{name}: checksum mismatch")
    tmp_path.replace(path)
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--list", action="store_true", help="show models and whether present")
    parser.add_argument("names", nargs="*", help="models to fetch (default: all)")
    args = parser.parse_args(argv)
    if args.list:
        for name in MODELS:
            print(f"{'present' if model_path(name).exists() else 'missing':8} {model_path(name)}")
        return 0
    for name in args.names or list(MODELS):
        print(ensure_model(name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
