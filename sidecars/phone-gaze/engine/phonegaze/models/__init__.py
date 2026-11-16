"""Gaze models: ``Observation`` -> screen point. Owner: Models.

Modules (each defines one or more classes satisfying ``phonegaze.types.GazeModel``):

- ``geometric.py``: ``GeometricModel`` (eye rays + calibrated camera-to-screen pose).
- ``regression.py``: ``RidgeModel``, ``KernelModel`` (ray-space features + head pose).
- ``reflection.py``: ``ReflectionModel`` (polynomial on the iris-to-reflection vector).
- ``blend.py``: ``BlendModel``, ``ResidualModel``.

``REGISTRY`` maps the names used in ``config.models.candidates`` to classes; each class has a
``from_dict(data)`` classmethod that rebuilds a fitted model.

Imported by: ``pipeline.py``, ``calibration.py``, ``replay.py``.
"""

from __future__ import annotations

from typing import Any

from ..config import ModelsConfig
from ..types import GazeModel

REGISTRY: dict[str, type] = {}
"""name -> model class. Filled by the Models area."""


def build_models(config: ModelsConfig) -> list[GazeModel]:
    """Fresh, unfitted instances of every model in ``config.candidates`` (unknown names are
    logged and skipped)."""
    raise NotImplementedError


def load_model(data: dict[str, Any]) -> GazeModel:
    """Rebuild a fitted model from ``GazeModel.to_dict()`` output (uses ``data["type"]``)."""
    raise NotImplementedError
