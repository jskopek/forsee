"""Calibration: target layouts, collecting samples, fitting every model, choosing, metrics,
and the saved profile. Owner: Models.

The UI shows the dots; the engine decides where they go (so tests are deterministic) and
collects samples while the UI says a dot is being looked at (docs/INTERFACES.md,
"Calibration flow").

Imported by: ``pipeline.py`` / ``server.py`` (runs, profile), ``replay.py`` (``fit_all``,
``validation_metrics``), the end-to-end test.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import CalibrationConfig
from .types import CalibSample, FitReport, GazeModel, GazePoint, Observation, ScreenInfo


@dataclass
class Target:
    """One dot: ``dot_id`` unique in the run, ``x``/``y`` in screen points."""

    dot_id: int
    x: float
    y: float

    def to_dict(self) -> dict[str, Any]:
        return {"dot_id": self.dot_id, "x": self.x, "y": self.y}


def grid_targets(screen: ScreenInfo, grid: str = "3x3", margin: float = 0.08) -> list[Target]:
    """Dots on a ``"CxR"`` grid inset by ``margin`` (fraction of each dimension), in a
    serpentine order."""
    raise NotImplementedError


def random_targets(screen: ScreenInfo, n: int, margin: float = 0.08, seed: int = 0) -> list[Target]:
    """``n`` well-spread dots for validation, avoiding the calibration grid positions."""
    raise NotImplementedError


def angular_error_deg(predicted: tuple[float, float], target: tuple[float, float], obs: Observation, screen: ScreenInfo) -> float | None:
    """Visual angle between two screen points as seen from the eyes in ``obs`` (uses the
    observation's distance and the screen's millimetre size). ``None`` if either is unknown."""
    raise NotImplementedError


@dataclass
class CalibrationRun:
    """One full, refine or validate run.

    The server creates it with the targets, then calls ``begin_dot`` / ``end_dot`` as the UI
    reports, and ``add`` for every observation in between.
    """

    run_id: str
    kind: str  # "grid" | "pursuit" | "refine" | "validate"
    targets: list[Target]
    screen: ScreenInfo
    samples: list[CalibSample] = field(default_factory=list)

    def begin_dot(self, dot_id: int, x: float, y: float, t_local: float) -> None:
        raise NotImplementedError

    def end_dot(self, dot_id: int, t_local: float) -> None:
        raise NotImplementedError

    def add(self, obs: Observation) -> None:
        """Store ``obs`` as a sample of the current dot (ignored between dots)."""
        raise NotImplementedError


@dataclass
class CalibrationResult:
    reports: list[FitReport]
    chosen: str | None
    models: dict[str, GazeModel]


def fit_all(samples: list[CalibSample], screen: ScreenInfo, models: list[GazeModel]) -> CalibrationResult:
    """Fit every candidate, score each by leave-one-dot-out, choose the best (lowest
    ``loo_error_deg``, falling back to ``loo_error_pt``)."""
    raise NotImplementedError


def refine(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
    """Quick refine: 1 dot corrects an offset; 3-5 re-solve the screen pose (geometric) or an
    affine correction (others), keeping person parameters."""
    raise NotImplementedError


def validation_metrics(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo) -> dict[str, Any]:
    """Accuracy (mean angular error) and precision (RMS sample-to-sample) in degrees on
    validation samples: ``{"accuracy_deg", "precision_deg", "accuracy_pt", "n", "per_dot"}``."""
    raise NotImplementedError


def predict_all(models: dict[str, GazeModel], obs: Observation) -> dict[str, GazePoint | None]:
    raise NotImplementedError


class Profile:
    """What is learned, saved in three layers under ``~/.phonegaze/profiles/<name>/``:
    ``person.json`` (per-eye angular offsets, eye geometry), ``setup.json`` (camera-to-screen
    pose, chosen camera and zoom, screen), ``session.json`` (latest fitted models and reports)."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def save(self, result: CalibrationResult, screen: ScreenInfo) -> None:
        raise NotImplementedError

    def load(self) -> CalibrationResult | None:
        raise NotImplementedError


def config_targets(config: CalibrationConfig, screen: ScreenInfo, kind: str) -> list[Target]:
    """Targets for a run of ``kind`` using the configured grid / refine / validate counts."""
    raise NotImplementedError
