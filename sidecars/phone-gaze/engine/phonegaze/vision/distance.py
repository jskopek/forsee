"""Viewing-distance policy (``estimators.distance_source``) and the depth-map cue. Owner: Vision.

The estimators each measure distance their own way (ARKit's face transform, the eye-corner span
and the low-resolution iris in ``landmarks``, the sub-pixel iris in ``iris_edge``). This module
holds the switch that decides which of those may set ``Observation.distance``:

- ``auto``: ARKit when tracking, else the iris fit refines landmarks' blend of span and iris;
- ``depth``: the phone's depth map at the eyes (``stream.depth``), falling back to ``auto``;
- ``iris``: iris size only (landmarks ignore the eye-corner span);
- ``head``: eye-corner span only (the iris fit leaves the distance alone);
- ``fixed``: ``estimators.fixed_distance_m``.

:class:`DistanceSmoother` (``estimators.distance_smoothing_s``) then smooths the chosen distance
over time and moves the eyeball centres and head position with it (the quality estimator runs
it, last in every chain).

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


class DistanceSmoother:
    """Exponential smoothing of ``Observation.distance`` over time. A point placed at the noisy
    distance is scaled about the camera to the smoothed one (its pixel stays), so the eyeball
    centres and head position follow; the gaze directions are then recomputed. A gap of over a
    second starts afresh. ARKit's distance and a fixed distance are left alone."""

    def __init__(self) -> None:
        self._state: tuple[float, float] | None = None

    def reset(self) -> None:
        self._state = None

    def apply(self, obs: Observation, t: float, config: Any, estimator: str = "quality") -> None:
        from .geometry import fill_eye_model

        tau = float(opt(config, "distance_smoothing_s", 0.0) or 0.0)
        d = obs.distance
        if tau <= 0 or not d or obs.provenance.get("distance") == "arkit" or source(config) == "fixed":
            self._state = None if tau <= 0 else self._state
            return
        prev = self._state
        if prev is None or t < prev[0] or t - prev[0] > 1.0:
            ds = float(d)
        else:
            a = 1.0 - math.exp(-(t - prev[0]) / tau)
            ds = (1 - a) * prev[1] + a * float(d)
        self._state = (t, ds)
        k = ds / float(d)
        if abs(k - 1.0) < 1e-9:
            return
        obs.set("distance", ds, estimator)
        for side in ("left", "right"):
            c = obs.eye(side).eyeball_center
            if c is not None:
                obs.set(f"{side}.eyeball_center", tuple(float(v) * k for v in c), estimator)
        if obs.head_position is not None:
            obs.set("head_position", tuple(float(v) * k for v in obs.head_position), estimator)
        fill_eye_model(obs, estimator)
