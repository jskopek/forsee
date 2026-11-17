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
import ssl
import subprocess
import sys
import tempfile
import urllib.error
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
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False, suffix=".part") as tmp:
        tmp_path = Path(tmp.name)
    try:
        _fetch(url, tmp_path)
        if digest and _sha256(tmp_path) != digest:
            raise RuntimeError(f"{name}: checksum mismatch")
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)
    return path


def _fetch(url: str, dest: Path) -> None:
    """Download ``url`` to ``dest``. Python from python.org has no certificate store until its
    "Install Certificates.command" is run, so on a certificate error this retries with certifi's
    bundle (installed with mediapipe) and then with ``curl``, which uses the system's."""
    errors: list[str] = []
    contexts: list[ssl.SSLContext | None] = [None]
    try:
        import certifi

        contexts.append(ssl.create_default_context(cafile=certifi.where()))
    except ImportError:
        pass
    for ctx in contexts:
        try:
            with urllib.request.urlopen(url, timeout=60, context=ctx) as response, dest.open("wb") as out:
                shutil.copyfileobj(response, out)
            return
        except (urllib.error.URLError, ssl.SSLError, OSError) as exc:
            errors.append(str(exc))
            if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
                break
    curl = shutil.which("curl")
    if curl:
        result = subprocess.run([curl, "-fsSL", "--retry", "2", "-o", str(dest), url], check=False, capture_output=True, text=True)
        if result.returncode == 0:
            return
        errors.append(f"curl: {result.stderr.strip() or result.returncode}")
    raise RuntimeError(f"could not download {url}: " + "; ".join(errors))


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
