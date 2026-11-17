"""Gaze models: ``Observation`` -> screen point. Owner: Models.

Modules (each defines one or more classes satisfying ``phonegaze.types.GazeModel``):

- ``geometric.py``: ``GeometricModel`` (eye rays + calibrated camera-to-screen pose).
- ``regression.py``: ``RidgeModel``, ``KernelModel`` (ray-space features + head pose).
- ``reflection.py``: ``ReflectionModel`` (polynomial on the iris-to-reflection vector).
- ``blend.py``: ``BlendModel``, ``ResidualModel``.
- ``hybrid.py``: ``HybridModel`` (reflection where it is detected, geometric otherwise, with a
  smooth per-frame weight).
- ``errormap.py``: ``ErrorMap``, a smooth correction over the screen learned from known
  look-points (``calibration.error_map``); applied by ``BaseModel`` after the correction.
- ``base.py``: shared machinery (output correction for quick refine and drift, ridge,
  leave-one-dot-out); ``features.py``: zoom-invariant features from an ``Observation``.
- ``drift.py``: ``DriftCorrector``, drift correction from selections (known look-points) with
  side-by-side scoring; not a model, used on top of the active one by ``pipeline.py``.

``REGISTRY`` maps the names used in ``config.models.candidates`` to classes; each class has a
``from_dict(data)`` classmethod that rebuilds a fitted model.

Imported by: ``pipeline.py``, ``calibration.py``, ``replay.py``.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import ModelsConfig
from ..types import GazeModel
from .blend import BlendModel, ResidualModel
from .geometric import GeometricModel
from .hybrid import HybridModel
from .reflection import ReflectionModel
from .regression import KernelModel, RidgeModel

log = logging.getLogger(__name__)

REGISTRY: dict[str, type] = {
    "geometric": GeometricModel,
    "ridge": RidgeModel,
    "kernel": KernelModel,
    "reflection": ReflectionModel,
    "blend": BlendModel,
    "residual": ResidualModel,
    "hybrid": HybridModel,
}
"""name -> model class."""


def _options(name: str, config: ModelsConfig) -> dict[str, Any]:
    opts: dict[str, Any] = {}
    if name == "geometric":
        opts["kappa_sd_deg"] = float(getattr(config, "kappa_prior_sd_deg", 2.5))
        opts["smooth_centre_s"] = float(getattr(config, "smooth_centre_s", 0.3))
        opts["centre"] = str(getattr(config, "eyeball_centre", "estimator"))
        opts["centre_sd_mm"] = float(getattr(config, "eyeball_centre_sd_mm", 2.0))
        opts["eye"] = str(getattr(config, "eye", "both"))
        opts["eye_auto_margin"] = float(getattr(config, "eye_auto_margin", 0.15))
    if name == "hybrid":
        opts["ref_lo"] = float(getattr(config, "hybrid_ref_lo", 0.3))
        opts["ref_hi"] = float(getattr(config, "hybrid_ref_hi", 0.7))
        opts["tau_s"] = float(getattr(config, "hybrid_tau_s", 0.25))
    if name in ("ridge", "kernel", "reflection") and getattr(config, "eyelid_feature", False):
        opts["lid"] = True
    if name == "ridge" and not getattr(config, "auto_alpha", True):
        opts["alpha"] = float(config.ridge_alpha)
    if name == "blend":
        opts["members"] = [c for c in config.candidates if c not in ("blend", "residual", "hybrid")] or None
    return opts


def build_models(config: ModelsConfig) -> list[GazeModel]:
    """Fresh, unfitted instances of every model in ``config.candidates`` (unknown names are
    logged and skipped). The blend, if listed, comes last."""
    blends = [n for n in ("hybrid", "blend") if n in config.candidates]
    names = [n for n in config.candidates if n not in blends] + blends
    out: list[GazeModel] = []
    for name in names:
        cls = REGISTRY.get(name)
        if cls is None:
            log.warning("unknown gaze model %r skipped", name)
            continue
        out.append(cls(**_options(name, config)))
    return out


def load_model(data: dict[str, Any]) -> GazeModel:
    """Rebuild a fitted model from ``GazeModel.to_dict()`` output (uses ``data["type"]``)."""
    cls = REGISTRY.get(str(data.get("type")))
    if cls is None:
        raise ValueError(f"unknown model type {data.get('type')!r}")
    return cls.from_dict(data)


__all__ = ["REGISTRY", "BlendModel", "GeometricModel", "HybridModel", "KernelModel", "ReflectionModel", "ResidualModel", "RidgeModel", "build_models", "load_model"]
