"""Hybrid model: reflection where the reflection is seen, geometric where it is not. Owner: Models.

``HybridModel`` (registry ``hybrid``) blends two members, ``reflection`` and ``geometric``, with
weights that change frame by frame:

- each member's base weight is ``1 / error^2`` from its leave-one-dot-out error, as in the blend;
- the reflection's weight is then multiplied by how well the reflection is detected in this
  frame: 0 at or below ``ref_lo`` (the best eye's ``reflection_score``), 1 at or above
  ``ref_hi``, smooth in between;
- live, that factor follows detection with a time constant ``tau_s``, so the pointer slides
  from one model to the other instead of jumping when the reflection comes and goes.

Without a fitted reflection member it is exactly the geometric model. Its held-out score uses
the same per-sample weights (without the time smoothing), so ``fit_all`` judges what it does.

Config: ``models.candidates`` must include ``hybrid`` (it is not in the default list);
``models.hybrid_ref_lo``, ``hybrid_ref_hi``, ``hybrid_tau_s``.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..types import CalibSample, GazePoint, Observation
from .base import fit_samples
from .blend import BlendModel

REFLECTION = "reflection"
GEOMETRIC = "geometric"


def reflection_strength(obs: Observation) -> float:
    """The better eye's reflection score (0 when neither eye has a reflection)."""
    best = 0.0
    for side in ("left", "right"):
        eye = obs.eye(side)
        if eye.blink or eye.reflection_center is None:
            continue
        sc = eye.reflection_score
        best = max(best, 1.0 if sc is None else float(sc))
    return best


def _ramp(x: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 1.0 if x >= hi else 0.0
    f = min(1.0, max(0.0, (x - lo) / (hi - lo)))
    return f * f * (3 - 2 * f)


class HybridModel(BlendModel):
    """Confidence-weighted reflection + geometric. Registry name ``hybrid``."""

    name = "hybrid"

    def __init__(self, members: list[str] | None = None, ref_lo: float = 0.3, ref_hi: float = 0.7, tau_s: float = 0.25, **options: Any) -> None:
        super().__init__(members=[REFLECTION, GEOMETRIC], ref_lo=ref_lo, ref_hi=ref_hi, tau_s=tau_s, **options)
        self._factor: tuple[float, float] | None = None  # (t, smoothed reflection factor)

    def _ref_factor(self, obs: Observation, live: bool) -> float:
        f = _ramp(reflection_strength(obs), float(self.options["ref_lo"]), float(self.options["ref_hi"]))
        tau = float(self.options.get("tau_s") or 0.0)
        if not live or tau <= 0:
            return f
        prev = self._factor
        if prev is None or obs.t < prev[0] or obs.t - prev[0] > 1.0:
            new = f
        elif obs.t == prev[0]:
            return prev[1]
        else:
            a = 1.0 - math.exp(-(obs.t - prev[0]) / tau)
            new = prev[1] + a * (f - prev[1])
        self._factor = (obs.t, new)
        return new

    def _mix(self, pts: dict[str, tuple[float, float, float]], factor: float) -> tuple[float, float, float] | None:
        w = {}
        for name, _ in pts.items():
            base = self.weights.get(name, 0.0)
            w[name] = base * factor if name == REFLECTION else base
        total = sum(w.values())
        if total <= 0:
            # the reflection alone, with no detection: use it rather than nothing
            if pts:
                name = next(iter(pts))
                return pts[name]
            return None
        x = sum(w[n] * p[0] for n, p in pts.items()) / total
        y = sum(w[n] * p[1] for n, p in pts.items()) / total
        c = sum(w[n] * p[2] for n, p in pts.items()) / total
        return x, y, c

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        pts: dict[str, tuple[float, float, float]] = {}
        first: GazePoint | None = None
        for name, m in self.members.items():
            if self._live:
                p = m.predict(obs)
            else:
                p = m.predict_raw(obs)
                if p is not None and not m.correction.is_identity:
                    p.x, p.y = m.correction.apply(p.x, p.y)
            if p is not None and p.valid:
                pts[name] = (p.x, p.y, p.confidence)
                if name == GEOMETRIC or first is None:
                    first = p
        if not pts:
            return None
        factor = self._ref_factor(obs, self._live)
        mixed = self._mix(pts, factor)
        if mixed is None:
            return None
        assert first is not None
        return GazePoint(x=float(mixed[0]), y=float(mixed[1]), t=obs.t, confidence=float(mixed[2]), model=self.name, t_local=obs.t_local, extra={"members": sorted(pts), "reflection_factor": round(factor, 3)}, left=first.left, right=first.right)

    def loo_from_members(self, loo: dict[str, np.ndarray], samples: list[CalibSample]) -> np.ndarray:
        samples = fit_samples(samples)
        wanted = {m: loo[m] for m in (REFLECTION, GEOMETRIC) if m in loo}
        out = np.full((len(samples), 2), np.nan)
        dots = np.array([s.dot_id for s in samples])
        saved = self.weights
        try:
            for d in np.unique(dots):
                w = self._weights(wanted, samples, exclude=int(d))
                if not w:
                    continue
                self.weights = w
                for i in np.flatnonzero(dots == d):
                    pts = {k: (float(v[i, 0]), float(v[i, 1]), 1.0) for k, v in wanted.items() if k in w and np.all(np.isfinite(v[i]))}
                    mixed = self._mix(pts, self._ref_factor(samples[i].obs, live=False)) if pts else None
                    if mixed is not None:
                        out[i] = mixed[:2]
        finally:
            self.weights = saved
        return out
