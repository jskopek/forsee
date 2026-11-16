"""Estimators: ``DecodedFrame`` -> ``Observation``. Owner: Vision.

Modules (each defines a class satisfying ``phonegaze.types.Estimator``; ``name`` in brackets is
the name used in ``config.estimators.order``):

- ``arkit.py``: ``ArkitEstimator`` [``arkit``]. Converts ARKit transforms to engine camera
  coordinates (eyeball centres, gaze directions, head pose, distance). Does nothing when
  ``frame.frame.arkit`` is ``None``.
- ``landmarks.py``: ``LandmarkEstimator`` [``landmarks``]. MediaPipe face landmarks on the
  ``wide`` image: face rect, eye corners, rough iris, openness, head pose, distance from
  iris size. Reuse ``tools/eye-capture/analysis/eyes.py``.
- ``iris_edge.py``: ``IrisEdgeEstimator`` [``iris_edge``]. Sub-pixel limbus ellipse on the
  native-resolution eye ROIs.
- ``reflection.py``: ``ReflectionEstimator`` [``reflection``]. The screen's corneal reflection.
- ``appearance.py``: ``AppearanceEstimator`` [``appearance``]. Optional pretrained network.
- ``quality.py``: ``QualityEstimator`` [``quality``] plus :func:`measure_quality` used by
  Core's lens and zoom search.

Imported by: ``pipeline.py`` (``build_estimators``), ``replay.py``, Core's aiming
(``quality.measure_quality``).
"""

from __future__ import annotations

from ..config import EstimatorsConfig
from ..types import Estimator

REGISTRY: dict[str, type] = {}
"""name -> estimator class. Filled by the Vision area. Each class is constructed as
``cls(config: EstimatorsConfig)``."""


def build_estimators(config: EstimatorsConfig) -> list[Estimator]:
    """Instances for ``config.order``, in order (unknown names are logged and skipped)."""
    raise NotImplementedError
