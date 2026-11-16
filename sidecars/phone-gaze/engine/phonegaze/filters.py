"""Smoothing, fixation and blink handling on the gaze stream. Owner: Models.

Imported by: ``pipeline.py`` (``build_filter``), the models (``fuse_eyes``).

Every filter here does the same four things around its smoother (research note 04):

1. **Blink hold.** While there is no valid point (blink, lost tracking) the last output is held,
   still ``valid``, for ``filters.blink_hold_ms``; after that it is reported invalid at the last
   position (consumers ignore ``x``/``y`` when ``valid`` is false).
2. **Saccade detection.** A jump of more than ``filters.saccade_deg`` from the current fixation,
   confirmed by the next sample landing near it (a single outlier is not a saccade, at the cost
   of one frame of latency), resets the smoother so the output snaps to the new place.
3. **Fixation state.** ``GazePoint.fixation`` is true once gaze has stayed within
   ``filters.fixation_deg`` for 60 ms.
4. **Confidence.** Output confidence is the model's, lowered just after a saccade and while held.

Smoothers (``filters.kind``): ``none`` (pass-through, no hold), ``one_euro`` (Casiez et al.),
``kalman`` (constant velocity), ``fixation`` (hard smoothing during fixations: the exponentially
weighted fixation centre with time constant ``filters.fixation_tau_ms``).

Degrees are turned into screen points with the screen's millimetre size and the observation's
distance when the filter knows them (``set_screen``), else ``filters.points_per_degree``.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any, Protocol

import numpy as np

from .config import FiltersConfig
from .types import GazePoint, Observation, ScreenInfo


class GazeFilter(Protocol):
    """``update`` receives each raw model output (``None`` when there is none) and the frame's
    observation; it returns the point to emit (may be held during a blink), or ``None``."""

    def update(self, point: GazePoint | None, obs: Observation | None) -> GazePoint | None: ...

    def reset(self) -> None: ...


# ---------------------------------------------------------------------------------------------
# Per-eye fusion
# ---------------------------------------------------------------------------------------------


def fuse_eyes(left: tuple[float, float] | None, right: tuple[float, float] | None, conf_left: float = 1.0, conf_right: float = 1.0) -> tuple[float, float, float]:
    """Confidence-weighted mean of per-eye screen points: ``(x, y, confidence)``.

    One eye alone is used with its confidence scaled by 0.8 (a single eye is noisier and loses
    the cancellation of opposite per-eye biases). Raises ``ValueError`` when both are missing.
    """
    if left is None and right is None:
        raise ValueError("no eye")
    if left is None or conf_left <= 0:
        if right is None:
            assert left is not None
            return float(left[0]), float(left[1]), 0.8 * max(conf_left, 0.0)
        return float(right[0]), float(right[1]), 0.8 * conf_right
    if right is None or conf_right <= 0:
        return float(left[0]), float(left[1]), 0.8 * conf_left
    wl, wr = max(conf_left, 1e-3), max(conf_right, 1e-3)
    x = (wl * left[0] + wr * right[0]) / (wl + wr)
    y = (wl * left[1] + wr * right[1]) / (wl + wr)
    return float(x), float(y), float((wl * conf_left + wr * conf_right) / (wl + wr))


# ---------------------------------------------------------------------------------------------
# Smoothers
# ---------------------------------------------------------------------------------------------


class LowPass:
    def __init__(self) -> None:
        self.y: float | None = None

    def __call__(self, x: float, alpha: float) -> float:
        self.y = x if self.y is None else alpha * x + (1 - alpha) * self.y
        return self.y


class OneEuro:
    """The One Euro filter for one value (Casiez, Roussel and Vogel, CHI 2012)."""

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.0, d_cutoff: float = 1.0) -> None:
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = LowPass()
        self.dx = LowPass()
        self.t: float | None = None

    @staticmethod
    def alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x: float, t: float) -> float:
        if self.t is None or self.x.y is None:
            self.t = t
            self.dx.y = 0.0
            return self.x(x, 1.0)
        dt = t - self.t
        if dt <= 0:
            dt = 1.0 / 60.0
        self.t = t
        dx = (x - self.x.y) / dt
        edx = self.dx(dx, self.alpha(self.d_cutoff, dt))
        cutoff = self.min_cutoff + self.beta * abs(edx)
        return self.x(x, self.alpha(cutoff, dt))

    def reset(self) -> None:
        self.x = LowPass()
        self.dx = LowPass()
        self.t = None


class Kalman2D:
    """Constant-velocity Kalman filter on x, y (points). ``q``: acceleration noise, pt/s^2;
    ``r``: measurement noise SD, pt."""

    def __init__(self, q: float, r: float) -> None:
        self.q, self.r = q, r
        self.s: np.ndarray | None = None
        self.p = np.eye(4)
        self.t: float | None = None

    def __call__(self, x: float, y: float, t: float, r_scale: float = 1.0) -> tuple[float, float]:
        z = np.array([x, y])
        if self.s is None or self.t is None:
            self.s = np.array([x, y, 0.0, 0.0])
            self.p = np.diag([self.r**2, self.r**2, 1e6, 1e6])
            self.t = t
            return x, y
        dt = t - self.t
        if dt <= 0:
            dt = 1.0 / 60.0
        self.t = t
        f = np.eye(4)
        f[0, 2] = f[1, 3] = dt
        g = np.array([[dt * dt / 2, 0], [0, dt * dt / 2], [dt, 0], [0, dt]])
        qm = g @ g.T * self.q**2
        self.s = f @ self.s
        self.p = f @ self.p @ f.T + qm
        h = np.hstack([np.eye(2), np.zeros((2, 2))])
        rm = np.eye(2) * (self.r * r_scale) ** 2
        k = self.p @ h.T @ np.linalg.inv(h @ self.p @ h.T + rm)
        self.s = self.s + k @ (z - h @ self.s)
        self.p = (np.eye(4) - k @ h) @ self.p
        return float(self.s[0]), float(self.s[1])

    def reset(self) -> None:
        self.s = None
        self.t = None


# ---------------------------------------------------------------------------------------------
# The filter
# ---------------------------------------------------------------------------------------------


class PassFilter:
    def update(self, point: GazePoint | None, obs: Observation | None) -> GazePoint | None:
        return point

    def reset(self) -> None:
        pass


class SmoothingFilter:
    """Blink hold + saccade detection + fixation state around one smoother (module docstring)."""

    FIXATION_MIN_S = 0.06
    POST_SACCADE_S = 0.1

    def __init__(self, config: FiltersConfig, screen: ScreenInfo | None = None) -> None:
        self.config = config
        self.kind = config.kind
        self.screen = screen
        self.reset()

    def set_screen(self, screen: ScreenInfo | None) -> None:
        self.screen = screen

    def reset(self) -> None:
        c = self.config
        self.ex = OneEuro(c.min_cutoff, c.beta)
        self.ey = OneEuro(c.min_cutoff, c.beta)
        ppd = self._fallback_ppd()
        self.kalman = Kalman2D(q=200.0 * ppd, r=0.7 * ppd)
        self.last_out: GazePoint | None = None
        self.last_valid_t: float | None = None
        self.fix_centre: np.ndarray | None = None
        self.fix_start: float | None = None
        self.fix_t: float | None = None
        self.candidate: np.ndarray | None = None
        self.saccade_t: float | None = None

    # --- helpers -----------------------------------------------------------------------------

    def _fallback_ppd(self) -> float:
        return float(getattr(self.config, "points_per_degree", 45.0) or 45.0)

    def points_per_degree(self, obs: Observation | None) -> float:
        s = self.screen
        if s is not None and s.mm_per_point is not None:
            d = obs.distance if obs is not None and obs.distance else 0.6
            mm_per_deg = d * 1000.0 * math.tan(math.radians(1.0))
            return mm_per_deg / float(np.mean(s.mm_per_point))
        return self._fallback_ppd()

    @staticmethod
    def _time(point: GazePoint | None, obs: Observation | None) -> float | None:
        if point is not None:
            return point.t
        if obs is not None:
            return obs.t
        return None

    def _hold(self, t: float | None) -> GazePoint | None:
        last = self.last_out
        if last is None:
            return None
        hold_s = self.config.blink_hold_ms / 1000.0
        if t is not None and self.last_valid_t is not None and 0 <= t - self.last_valid_t <= hold_s:
            extra = dict(last.extra)
            extra["held"] = True
            return replace(last, t=t, confidence=last.confidence * 0.5, extra=extra)
        self.fix_centre = None
        self.fix_start = None
        out = replace(last, t=t if t is not None else last.t, valid=False, confidence=0.0, fixation=False, extra={**last.extra, "held": False, "lost": True})
        return out

    # --- update ------------------------------------------------------------------------------

    def update(self, point: GazePoint | None, obs: Observation | None) -> GazePoint | None:
        t = self._time(point, obs)
        blinking = obs is not None and bool(obs.left.blink) and bool(obs.right.blink)
        if self.kind == "none":
            return point
        if point is None or not point.valid or blinking or not (math.isfinite(point.x) and math.isfinite(point.y)):
            return self._hold(t)
        assert t is not None
        ppd = self.points_per_degree(obs)
        p = np.array([point.x, point.y])
        sacc_pt = float(getattr(self.config, "saccade_deg", 2.5)) * ppd
        fix_pt = self.config.fixation_deg * ppd

        saccade = False
        if self.fix_centre is None:
            self._start_fixation(p, t)
            saccade = True
        else:
            d = float(np.linalg.norm(p - self.fix_centre))
            if d > sacc_pt:
                if self.candidate is not None and np.linalg.norm(p - self.candidate) < sacc_pt:
                    saccade = True
                    p_new = (p + self.candidate) / 2
                    self.candidate = None
                    self._start_fixation(p_new, t)
                else:
                    self.candidate = p
            else:
                self.candidate = None
        if saccade:
            if self.fix_centre is None or np.linalg.norm(p - self.fix_centre) > sacc_pt:
                self._start_fixation(p, t)
            self.ex.reset()
            self.ey.reset()
            self.kalman.reset()
            self.saccade_t = t
        elif self.candidate is None:
            # inside the fixation: update its centre
            tau = float(getattr(self.config, "fixation_tau_ms", 250)) / 1000.0
            dt = max(t - (self.fix_t or t), 1e-3)
            a = 1.0 - math.exp(-dt / tau)
            assert self.fix_centre is not None
            self.fix_centre = self.fix_centre + a * (p - self.fix_centre)
        self.fix_t = t

        # smoother
        if self.candidate is not None and self.last_out is not None and self.last_out.valid:
            # a possible saccade not yet confirmed: hold, so a single outlier never shows
            sx, sy = self.last_out.x, self.last_out.y
        elif self.kind == "fixation":
            sx, sy = self.fix_centre.tolist()  # type: ignore[union-attr]
        elif self.kind == "kalman":
            sx, sy = self.kalman(float(p[0]), float(p[1]), t)
        else:
            sx, sy = self.ex(float(p[0]), t), self.ey(float(p[1]), t)

        assert self.fix_centre is not None and self.fix_start is not None
        in_fix = self.candidate is None and float(np.linalg.norm(p - self.fix_centre)) <= fix_pt and t - self.fix_start >= self.FIXATION_MIN_S
        conf = point.confidence
        if self.saccade_t is not None and t - self.saccade_t < self.POST_SACCADE_S:
            conf *= 0.7
        if self.candidate is not None:
            conf *= 0.8
        out = replace(point, x=float(sx), y=float(sy), confidence=float(max(0.0, min(1.0, conf))), fixation=bool(in_fix), extra={**point.extra, "filter": self.kind, "saccade": bool(saccade)})
        self.last_out = out
        self.last_valid_t = t
        return out

    def _start_fixation(self, p: np.ndarray, t: float) -> None:
        self.fix_centre = np.array(p, float)
        self.fix_start = t
        self.candidate = None


def build_filter(config: FiltersConfig, screen: ScreenInfo | None = None) -> GazeFilter:
    """The filter named by ``config.kind`` (``"none"`` passes points through)."""
    if config.kind == "none":
        return PassFilter()
    if config.kind not in ("one_euro", "kalman", "fixation"):
        raise ValueError(f"unknown filter kind {config.kind!r}")
    return SmoothingFilter(config, screen)


def describe(f: Any) -> dict[str, Any]:
    """Small JSON description of a filter's state, for the UI."""
    if isinstance(f, SmoothingFilter):
        return {"kind": f.kind, "fixation_centre": None if f.fix_centre is None else f.fix_centre.tolist()}
    return {"kind": "none"}
