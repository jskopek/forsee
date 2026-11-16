"""Replay recorded sessions through any estimators and models, offline. Owner: Core.

Imported by: tests, the UI's experiment page (through ``server.py``), command line scripts.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .types import Estimator, Frame, GazeModel


def iter_frames(recording: Path) -> Iterator[Frame]:
    """Frames of a Phone Gaze recording (``stream.pgz1``), with ``t_received`` from ``recv``."""
    raise NotImplementedError


def iter_eye_capture(session_dir: Path) -> Iterator[Frame]:
    """Frames from a ``tools/eye-capture`` session (mp4 + per-frame CSV + segment JSON), each
    turned into a ``Frame`` whose single ``wide`` part is the full-resolution frame as JPEG and
    whose ``arkit`` block is rebuilt from the CSV columns when the segment was ARKit."""
    raise NotImplementedError


def score(
    recording: Path,
    estimators: list[Estimator],
    models: list[GazeModel],
) -> dict[str, Any]:
    """Re-run a recording that contains calibration and validation events: refit every model on
    the calibration samples and report validation accuracy per model (``FitReport`` dicts plus
    ``{"validation": {model: {"accuracy_deg", "precision_deg"}}}``)."""
    raise NotImplementedError
