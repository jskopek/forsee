"""Drift correction from selections. Owner: Models.

While the person types in Forsee by dwell, every selected key is a known look-point: they were
looking somewhere on that key just before it fired. :class:`DriftCorrector` uses these points to
learn a slowly changing offset of the gaze output (the head settling, the phone creeping on the
desk), and scores, side by side, how far the estimate was from each selected target with and
without that offset.

How it works, per selection:

1. **The gaze that caused it.** The uncorrected predictions of the active model are kept for a
   few seconds (:meth:`DriftCorrector.add_prediction`). A selection at engine time ``t`` uses the
   predictions in ``[t - window_s, t]`` (the fixation that ran the dwell), takes their median,
   drops samples further than ``fixation_deg`` from it (a saccade into the key) and takes the
   median again. Fewer than ``min_samples`` left: no estimate, the selection is not used.
2. **Score first.** The error of the uncorrected estimate and of the estimate the correction
   would produce (uncorrected + the current offset), both to the target's centre in degrees, are
   recorded *before* the selection changes anything, so a score is never measured on the point
   it was learned from. This runs whether or not the correction is applied to the output.
3. **Reject the implausible.** If the estimate that was being output (corrected when the
   correction is applied, otherwise uncorrected) lay more than ``max_outside_deg`` outside the
   target's rectangle, the person was probably not looking at it (a wrong or stale selection):
   it is neither scored nor learned from.
4. **Weak evidence, small steps.** The offset is a Kalman filter per screen axis. A selection
   proves only that the person looked somewhere on the key, so its measurement variance is
   ``gaze_sd_deg^2 + size^2 / 12`` per axis (a uniform spot on the key; ``unknown_target_deg``
   when the size is not known); clicks are weaker still (variance divided by ``click_weight``).
   The offset's own variance grows between selections at ``rate_deg_per_min^2`` per minute (how
   fast drift is expected), which sets how much each selection may move it. A single step is
   capped at ``max_step_deg`` and the whole offset at ``max_offset_deg``.
5. **Undo.** Each update is remembered by the selection's id for ``undo_window_s``;
   :meth:`DriftCorrector.undo` subtracts its step again and removes its score.

:meth:`reset` forgets the offset (new calibration, quick refine, another camera or model);
:meth:`reanchor` keeps it but makes it uncertain again, so the next selections count more (zoom
change).

The offset is a translation in screen points. It cannot correct a scale or rotation error, and
it follows slow drift only. Pure numpy; no engine state. Used by ``pipeline.py`` and
``replay.py``.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from ..types import ScreenInfo
from .base import mm_per_point

KINDS = ("dwell", "click")


@dataclass
class DriftSettings:
    rate_deg_per_min: float = 0.5
    """Expected drift speed (1 SD of the offset's change per minute). Higher adapts faster."""
    prior_sd_deg: float = 1.0
    """Uncertainty of the offset right after a reset."""
    gaze_sd_deg: float = 0.5
    """Noise of one selection's gaze estimate, apart from the target's size."""
    unknown_target_deg: float = 1.5
    """Target size assumed when the rectangle is not known."""
    click_weight: float = 0.25
    """How much a mouse click counts compared with a dwell selection (its variance is divided by
    this)."""
    max_step_deg: float = 0.5
    max_offset_deg: float = 4.0
    max_outside_deg: float = 2.0
    window_s: float = 0.6
    min_samples: int = 3
    fixation_deg: float = 1.5
    undo_window_s: float = 30.0
    recent: int = 50
    """Size of the recent window of the side-by-side statistics."""
    buffer_s: float = 5.0


def points_per_degree(screen: ScreenInfo | None, distance_m: float | None, fallback: float = 45.0) -> float:
    """Screen points per degree of visual angle at the screen centre."""
    if screen is None:
        return fallback
    mx, my, measured = mm_per_point(screen)
    if not measured:
        return fallback
    d = distance_m if distance_m and 0.1 < distance_m < 3.0 else 0.6
    return d * 1000.0 * math.tan(math.radians(1.0)) / ((mx + my) / 2.0)


def rect_distance(px: float, py: float, rect: tuple[float, float, float, float] | None, cx: float, cy: float, unknown_pt: float) -> float:
    """Distance in points from ``(px, py)`` to a rectangle ``(x, y, w, h)``; 0 inside. Without a
    rectangle, a square of side ``unknown_pt`` around ``(cx, cy)``."""
    if rect is None:
        rect = (cx - unknown_pt / 2, cy - unknown_pt / 2, unknown_pt, unknown_pt)
    x, y, w, h = rect
    dx = max(x - px, 0.0, px - (x + w))
    dy = max(y - py, 0.0, py - (y + h))
    return math.hypot(dx, dy)


def _summary(errors: list[float]) -> dict[str, float | None]:
    if not errors:
        return {"median_deg": None, "mean_deg": None}
    a = np.asarray(errors, float)
    return {"median_deg": float(np.median(a)), "mean_deg": float(np.mean(a))}


@dataclass
class _Score:
    id: str
    t: float
    kind: str
    uncorrected_deg: float
    corrected_deg: float


@dataclass
class _Update:
    id: str
    t: float
    step_pt: np.ndarray
    var_before: np.ndarray
    epoch: int


@dataclass
class DriftCorrector:
    """Online offset from known look-points, plus side-by-side scoring. See the module doc."""

    settings: DriftSettings = field(default_factory=DriftSettings)

    def __post_init__(self) -> None:
        self.offset = np.zeros(2)
        """Screen points added to the uncorrected estimate."""
        self.var = np.full(2, self.settings.prior_sd_deg**2)
        """Variance of the offset per axis, degrees squared."""
        self.epoch = 0
        self.resets = 0
        self.last_reset_reason = ""
        self.used_since_reset = 0
        self.last_selection_t: float | None = None
        self._last_update_t: float | None = None
        self._predictions: deque[tuple[float, float, float]] = deque()
        self._scores: list[_Score] = []
        self._updates: deque[_Update] = deque()
        self.rejected: dict[str, int] = {}
        self.undone = 0
        self.last: dict[str, Any] | None = None
        self._auto_id = 0

    # --- inputs --------------------------------------------------------------------------------

    def add_prediction(self, t: float, x: float, y: float) -> None:
        """One valid, uncorrected prediction of the active model at engine time ``t``."""
        if not (math.isfinite(t) and math.isfinite(x) and math.isfinite(y)):
            return
        self._predictions.append((float(t), float(x), float(y)))
        while self._predictions and self._predictions[0][0] < t - self.settings.buffer_s:
            self._predictions.popleft()

    def fixation_estimate(self, t: float, ppd: float) -> tuple[np.ndarray | None, str]:
        """Median of the predictions in ``[t - window_s, t]`` after dropping samples far from it."""
        s = self.settings
        pts = np.array([(x, y) for (tp, x, y) in self._predictions if t - s.window_s <= tp <= t], float).reshape(-1, 2)
        if len(pts) < s.min_samples:
            return None, "no gaze estimate just before the selection"
        med = np.median(pts, axis=0)
        keep = pts[np.linalg.norm(pts - med, axis=1) <= s.fixation_deg * ppd]
        if len(keep) < s.min_samples:
            return None, "no steady fixation before the selection"
        return np.median(keep, axis=0), ""

    def apply(self, x: float, y: float) -> tuple[float, float]:
        return float(x + self.offset[0]), float(y + self.offset[1])

    def selection(
        self,
        x: float,
        y: float,
        t: float,
        ppd: float,
        *,
        rect: tuple[float, float, float, float] | None = None,
        kind: str = "dwell",
        sel_id: str | None = None,
        applied: bool = False,
    ) -> dict[str, Any]:
        """A known look-point: target centre ``(x, y)`` and optional rectangle ``(x, y, w, h)`` in
        screen points, at engine time ``t``. ``applied``: whether the correction was being added
        to the output (decides which estimate the outlier test uses). Returns what happened."""
        s = self.settings
        if sel_id is None:
            self._auto_id += 1
            sel_id = f"auto-{self._auto_id}"
        kind = kind if kind in KINDS else "dwell"
        ppd = float(ppd) if ppd and math.isfinite(ppd) and ppd > 0 else 45.0
        centre = np.array([float(x), float(y)])
        out: dict[str, Any] = {"id": sel_id, "kind": kind, "t": t, "x": float(x), "y": float(y), "rect": list(rect) if rect else None, "used": False}
        self.last_selection_t = t
        est, why = self.fixation_estimate(t, ppd)
        if est is None:
            return self._reject(out, why)
        corrected = est + self.offset
        shown = corrected if applied else est
        unknown_pt = s.unknown_target_deg * ppd
        outside = rect_distance(float(shown[0]), float(shown[1]), rect, x, y, unknown_pt) / ppd
        out.update({"estimate": est.tolist(), "outside_deg": outside})
        if outside > s.max_outside_deg:
            return self._reject(out, "gaze was far outside the target")

        # 1. Score, before anything changes.
        err_u = float(np.linalg.norm(centre - est)) / ppd
        err_c = float(np.linalg.norm(centre - corrected)) / ppd
        self._scores.append(_Score(sel_id, t, kind, err_u, err_c))
        out.update({"uncorrected_deg": err_u, "corrected_deg": err_c})

        # 2. Kalman update per axis (variances in degrees squared).
        if self._last_update_t is not None and t > self._last_update_t:
            self.var = self.var + (s.rate_deg_per_min**2) * (t - self._last_update_t) / 60.0
        self.var = np.minimum(self.var, s.max_offset_deg**2)
        self._last_update_t = t
        size_deg = np.array([rect[2], rect[3]], float) / ppd if rect else np.full(2, s.unknown_target_deg)
        meas_var = s.gaze_sd_deg**2 + size_deg**2 / 12.0
        if kind == "click":
            meas_var = meas_var / max(s.click_weight, 1e-3)
        gain = self.var / (self.var + meas_var)
        innovation = centre - corrected
        step = gain * innovation
        cap = s.max_step_deg * ppd
        n = float(np.linalg.norm(step))
        if n > cap:
            step *= cap / n
        before = self.var.copy()
        new = self.offset + step
        limit = s.max_offset_deg * ppd
        if np.linalg.norm(new) > limit:
            new *= limit / np.linalg.norm(new)
        step = new - self.offset
        self.offset = new
        self.var = (1.0 - gain) * self.var
        self.used_since_reset += 1
        self._updates.append(_Update(sel_id, t, step.copy(), before, self.epoch))
        while self._updates and (self._updates[0].t < t - s.undo_window_s or len(self._updates) > 200):
            self._updates.popleft()
        out.update({"used": True, "step_pt": step.tolist(), "gain": gain.tolist(), "offset_pt": self.offset.tolist()})
        self.last = out
        return out

    def _reject(self, out: dict[str, Any], reason: str) -> dict[str, Any]:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1
        out["reason"] = reason
        self.last = out
        return out

    def undo(self, sel_id: str, t: float | None = None) -> bool:
        """The selection ``sel_id`` was undone (backspace or undo right after it): take back its
        step (if it was learned from since the last reset and within ``undo_window_s``) and its
        score. Returns whether anything changed."""
        changed = False
        for i, sc in enumerate(self._scores):
            if sc.id == sel_id:
                del self._scores[i]
                changed = True
                break
        for up in list(self._updates):
            if up.id != sel_id:
                continue
            self._updates.remove(up)
            if up.epoch == self.epoch and (t is None or t - up.t <= self.settings.undo_window_s):
                self.offset = self.offset - up.step_pt
                self.var = np.maximum(self.var, up.var_before)
                self.used_since_reset = max(0, self.used_since_reset - 1)
                changed = True
            break
        if changed:
            self.undone += 1
        return changed

    # --- resets --------------------------------------------------------------------------------

    def reset(self, reason: str = "") -> None:
        """Forget the offset (recalibration, quick refine, camera, screen or model change). The
        side-by-side statistics are kept."""
        self.offset = np.zeros(2)
        self.var = np.full(2, self.settings.prior_sd_deg**2)
        self.epoch += 1
        self.resets += 1
        self.last_reset_reason = reason
        self.used_since_reset = 0
        self._last_update_t = None
        self._predictions.clear()
        self._updates.clear()

    def reanchor(self, reason: str = "") -> None:
        """Keep the offset but trust it less, so the next selections move it more (zoom change)."""
        self.var = np.maximum(self.var, self.settings.prior_sd_deg**2)
        self._predictions.clear()
        self.last_reset_reason = reason

    def clear_stats(self) -> None:
        self._scores.clear()
        self.rejected = {}
        self.undone = 0

    # --- reporting -----------------------------------------------------------------------------

    def stats(self, ppd: float | None = None) -> dict[str, Any]:
        """Side-by-side errors (degrees, to the selected target's centre, measured before each
        selection updated anything) over the session and the last ``recent`` selections."""

        def block(scores: list[_Score]) -> dict[str, Any]:
            return {
                "n": len(scores),
                "uncorrected": _summary([s.uncorrected_deg for s in scores]),
                "corrected": _summary([s.corrected_deg for s in scores]),
            }

        offset_deg = None
        if ppd:
            offset_deg = float(np.linalg.norm(self.offset)) / ppd
        return {
            "session": block(self._scores),
            "recent": block(self._scores[-self.settings.recent :]),
            "rejected": dict(self.rejected),
            "undone": self.undone,
            "offset_pt": self.offset.tolist(),
            "offset_deg": offset_deg,
            "sd_deg": [float(math.sqrt(v)) for v in self.var],
            "used_since_reset": self.used_since_reset,
            "resets": self.resets,
            "last_reset_reason": self.last_reset_reason,
            "last": self.last,
            "settings": asdict(self.settings),
        }
