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


def build_estimators(config: EstimatorsConfig) -> list[Estimator]:
    """Instances for ``config.order``, in order (unknown names are logged and skipped).
    Construction is cheap: models (MediaPipe) load on the first frame."""
    out: list[Estimator] = []
    for name in list(getattr(config, "order", []) or []):
        cls = REGISTRY.get(name)
        if cls is None:
            log.warning("unknown estimator %r skipped", name)
            continue
        out.append(cls(config))
    return out
