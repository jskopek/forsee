"""Viewing-distance policy (``estimators.distance_source``) and the depth-map cue. Owner: Vision.

The estimators each measure distance their own way (ARKit's face transform, the eye-corner span
and the low-resolution iris in ``landmarks``, the sub-pixel iris in ``iris_edge``). This module
holds the switch that decides which of those may set ``Observation.distance``:

- ``auto``: ARKit when tracking, else the iris fit refines landmarks' blend of span and iris;
- ``depth``: the phone's depth map at the eyes (``stream.depth``), falling back to ``auto``;
- ``iris``: iris size only (landmarks ignore the eye-corner span);
- ``head``: eye-corner span only (the iris fit leaves the distance alone);
- ``fixed``: ``estimators.fixed_distance_m``.

Every estimator that sets the distance records which cue it used in
``obs.extra["distance"] = {"source": ..., "cues": {...}}`` so the Tuning page can show it.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..types import DecodedFrame, Observation, apply_affine
from .settings import opt


def source(config: Any) -> str:
    return str(opt(config, "distance_source", "auto"))


def depth_at(frame: DecodedFrame, uv: tuple[float, float], radius_px: float = 6.0) -> float | None:
    """Median depth in metres near the full-frame pixel ``uv`` from any depth part, or ``None``."""
    for im in frame.images.values():
        if im.kind != "depth" or im.pixels.ndim != 2:
            continue
        x, y = apply_affine(im.from_full, uv)
        r = max(1.0, radius_px * im.scale)
        h, w = im.pixels.shape
        x0, x1 = int(max(0, math.floor(x - r))), int(min(w, math.ceil(x + r)))
        y0, y1 = int(max(0, math.floor(y - r))), int(min(h, math.ceil(y + r)))
        if x1 <= x0 or y1 <= y0:
            continue
        vals = im.pixels[y0:y1, x0:x1].astype(np.float64).ravel()
        vals = vals[np.isfinite(vals) & (vals > 0.05) & (vals < 5.0)]
        if len(vals) >= 3:
            return float(np.median(vals))
    return None


def note(obs: Observation, src: str, cues: dict[str, Any] | None = None) -> None:
    """Record which cue set the distance (for the Tuning page)."""
    info = obs.extra.setdefault("distance", {})
    info["source"] = src
    if cues:
        info.setdefault("cues", {}).update({k: (None if v is None else float(v)) for k, v in cues.items()})
