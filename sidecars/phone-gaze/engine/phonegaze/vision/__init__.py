"""Estimators: ``DecodedFrame`` -> ``Observation``. Owner: Vision.

Modules (each defines a class satisfying ``phonegaze.types.Estimator``; ``name`` in brackets is
the name used in ``config.estimators.order``):

- ``arkit.py``: ``ArkitEstimator`` [``arkit``]. Converts ARKit transforms to engine camera
  coordinates (eyeball centres, gaze directions, head pose, distance). Does nothing when
  ``frame.frame.arkit`` is ``None``.
- ``landmarks.py``: ``LandmarkEstimator`` [``landmarks``]. MediaPipe face landmarks on the
  ``wide`` image: face rect, eye corners, rough iris, openness, head pose, distance from
  iris size.
- ``iris_edge.py``: ``IrisEdgeEstimator`` [``iris_edge``]. Sub-pixel limbus ellipse on the
  native-resolution eye ROIs.
- ``reflection.py``: ``ReflectionEstimator`` [``reflection``]. The screen's corneal reflection.
- ``appearance.py``: ``AppearanceEstimator`` [``appearance``]. Optional pretrained network.
- ``quality.py``: ``QualityEstimator`` [``quality``] plus :func:`measure_quality` used by
  Core's lens and zoom search.

Helpers: ``geometry.py`` (distance from iris size and eye-corner span, the simple eyeball model,
rotation helpers), ``eyes.py`` (port of ``tools/eye-capture/analysis/eyes.py``), ``synth.py``
(synthetic eye images and frames for tests).

Imported by: ``pipeline.py`` (``build_estimators``), ``replay.py``, Core's aiming
(``quality.measure_quality``).
"""

from __future__ import annotations

import logging

from ..config import EstimatorsConfig
from ..types import Estimator
from .appearance import AppearanceEstimator
from .arkit import ArkitEstimator
from .iris_edge import IrisEdgeEstimator
from .landmarks import LandmarkEstimator
from .quality import QualityEstimator
from .reflection import ReflectionEstimator
from .settings import opt  # noqa: F401 - re-exported

log = logging.getLogger(__name__)

REGISTRY: dict[str, type] = {
    "arkit": ArkitEstimator,
    "landmarks": LandmarkEstimator,
    "iris_edge": IrisEdgeEstimator,
    "reflection": ReflectionEstimator,
    "appearance": AppearanceEstimator,
    "quality": QualityEstimator,
}
"""name -> estimator class. Filled by the Vision area. Each class is constructed as
``cls(config: EstimatorsConfig)``."""


def enabled(config: EstimatorsConfig | None, name: str) -> bool:
    """The per-estimator switch ``config.use_<name>`` (missing: on)."""
    return bool(getattr(config, f"use_{name}", True)) if config is not None else True


def build_estimators(config: EstimatorsConfig) -> list[Estimator]:
    """Instances for ``config.order``, in order (unknown names are logged and skipped; names
    switched off with ``use_<name>`` are left out). Construction is cheap: models (MediaPipe)
    load on the first frame. Estimators keep a reference to ``config`` and read their tuning
    settings from it on every frame, so changing one needs no rebuild (see
    :data:`REBUILD_SETTINGS`)."""
    out: list[Estimator] = []
    for name in list(getattr(config, "order", []) or []):
        cls = REGISTRY.get(name)
        if cls is None:
            log.warning("unknown estimator %r skipped", name)
            continue
        if not enabled(config, name):
            continue
        out.append(cls(config))
    return out


REBUILD_SETTINGS = frozenset(
    {"order", "landmarks_model", "face_confidence", "use_arkit", "use_landmarks", "use_iris_edge", "use_reflection", "use_quality", "use_appearance"}
)
"""``estimators.*`` settings that need the estimators rebuilt (the list changes, or MediaPipe must
be reloaded). Every other estimator setting is read live and keeps the estimators' state (the
reflection priors learned from a coded flash, tracking)."""
