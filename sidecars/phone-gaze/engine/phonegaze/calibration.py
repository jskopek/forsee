"""Calibration: target layouts, collecting samples, fitting every model, choosing, metrics,
and the saved profile. Owner: Models.

The UI shows the dots; the engine decides where they go (so tests are deterministic) and
collects samples while the UI says a dot is being looked at (docs/INTERFACES.md,
"Calibration flow").

Tiers (ARCHITECTURE.md):

- **Full** (``grid``, ``pursuit``): :func:`fit_all` fits every candidate model, scores each by
  leave-one-dot-out and picks the best. Repeating the grid (``pose_rounds``) gives samples at
  several head positions: :class:`CalibrationRun` notices a dot shown again and starts a new
  ``pose_group``, and the geometric model then fits kappa and the eye offset.
- **Quick refine** (:func:`refine`): one dot corrects an offset; three to five re-solve the
  screen pose (geometric) or fit an affine correction (others), keeping the person parameters.
- **Validate** (:func:`validation_metrics`): accuracy and precision on fresh dots.
- **Drift** (:func:`refine` with ``kind="drift"`` samples, :func:`drift_correct`): a batch
  helper that folds known look-points into the model's own correction. The running engine does
  not use it: drift correction from selections lives in ``models/drift.py`` (a separate offset,
  scored side by side, switchable, with undo).

What is learned is saved by :class:`Profile` in three layers.

Switchable additions (all settings in ``calibration.*`` / ``models.*``; defaults keep the
behaviour from before unless noted):

- **Head sweep** (``head_sweep``, :func:`sweep_targets`): after the grid, the person looks at one
  dot (up to three) while slowly turning and moving the head. :class:`CalibrationRun` cuts it
  into windows (kind ``"sweep"``), each one fitting row at its own head pose, which lets the
  geometric model learn each eyeball's centre in the head's frame (``models.eyeball_centre``).
- **Moving dot, merged** (``pursuit_merge``, :func:`prepare_pursuit`): the eye's lag behind the
  dot is estimated, catch-up saccades and far-off samples are dropped, and what is left joins the
  grid fit at reduced weight, only if the grid dots' held-out error goes down (``"auto"``).
- **Quality gate** (``quality_gate``, :func:`quality_gate`): dots that were rejected, scattered or
  far off (quick held-out fit) are shown again once; the better attempt is kept.
- **Sample weighting** (``sample_weighting``, :func:`weight_samples`).
- **Eye choice** (``models.eye``): per-eye held-out scores in every geometric report; ``auto``
  picks one eye when it is clearly better (:func:`fit_all`).
- **Error map** (``error_map``, :func:`fit_validation_error_map`) learned from validation dots,
  and the touch-up flow that re-shows the worst ones (:func:`touchup_targets`).

:func:`fit_with_options` runs the whole full-calibration fit with these options.

Imported by: ``pipeline.py`` / ``server.py`` (runs, profile), ``replay.py`` (``fit_all``,
``validation_metrics``), the end-to-end test.
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .config import CalibrationConfig
from .models import features as F
from .models.base import BaseModel, Correction, error_stats, fit_samples, lopo_predictions, loo_predictions, mm_per_point, pose_groups, scored_dots
from .types import CalibSample, FitReport, GazeModel, GazePoint, Observation, ScreenInfo

log = logging.getLogger(__name__)


@dataclass
class Target:
    """One dot: ``dot_id`` unique in the run, ``x``/``y`` in screen points."""

    dot_id: int
    x: float
    y: float

    def to_dict(self) -> dict[str, Any]:
        return {"dot_id": self.dot_id, "x": self.x, "y": self.y}


# ---------------------------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------------------------


def _grid_size(grid: str) -> tuple[int, int]:
    cols, rows = (int(v) for v in grid.lower().split("x"))
    if cols < 1 or rows < 1:
        raise ValueError(grid)
    return cols, rows


def grid_targets(screen: ScreenInfo, grid: str = "3x3", margin: float = 0.08) -> list[Target]:
    """Dots on a ``"CxR"`` grid inset by ``margin`` (fraction of each dimension), in a
    serpentine order."""
    cols, rows = _grid_size(grid)
    xs = np.linspace(margin, 1 - margin, cols) if cols > 1 else np.array([0.5])
    ys = np.linspace(margin, 1 - margin, rows) if rows > 1 else np.array([0.5])
    out: list[Target] = []
    for r, fy in enumerate(ys):
        order = xs if r % 2 == 0 else xs[::-1]
        for fx in order:
            out.append(Target(len(out), float(fx * screen.width), float(fy * screen.height)))
    return out


def random_targets(screen: ScreenInfo, n: int, margin: float = 0.08, seed: int = 0, avoid: list[Target] | None = None) -> list[Target]:
    """``n`` well-spread dots for validation, avoiding the calibration grid positions
    (best-candidate sampling: each new dot is the candidate farthest from those placed)."""
    rng = np.random.default_rng(seed)
    avoid = avoid if avoid is not None else grid_targets(screen, "3x3", margin)
    placed = [np.array([t.x / screen.width, t.y / screen.height]) for t in avoid]
    n_avoid = len(placed)
    out: list[Target] = []
    for _ in range(n):
        cand = rng.uniform(margin, 1 - margin, size=(40, 2))
        if placed:
            d = np.min(np.linalg.norm(cand[:, None, :] - np.array(placed)[None, :, :], axis=2), axis=1)
            best = cand[int(np.argmax(d))]
        else:
            best = cand[0]
        placed.append(best)
        out.append(Target(len(out), float(best[0] * screen.width), float(best[1] * screen.height)))
    del n_avoid
    return out


def refine_targets(screen: ScreenInfo, n: int, margin: float = 0.15) -> list[Target]:
    """1: centre; 2: left and right; 3: a triangle; 4: corners; 5: corners and centre."""
    w, h = screen.width, screen.height
    lo, hi = margin, 1 - margin
    layouts = {
        1: [(0.5, 0.5)],
        2: [(lo, 0.5), (hi, 0.5)],
        3: [(0.5, lo), (lo, hi), (hi, hi)],
        4: [(lo, lo), (hi, lo), (hi, hi), (lo, hi)],
        5: [(0.5, 0.5), (lo, lo), (hi, lo), (hi, hi), (lo, hi)],
    }
    pts = layouts[max(1, min(5, n))]
    return [Target(i, float(fx * w), float(fy * h)) for i, (fx, fy) in enumerate(pts)]


def pursuit_targets(screen: ScreenInfo, n: int = 48, margin: float = 0.1) -> list[Target]:
    """Way-points of a smooth Lissajous path (3:2) for the moving-dot phase. The UI moves the dot
    through them in order at constant speed."""
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    fx = 0.5 + (0.5 - margin) * np.sin(3 * t)
    fy = 0.5 + (0.5 - margin) * np.sin(2 * t + math.pi / 4)
    return [Target(i, float(x * screen.width), float(y * screen.height)) for i, (x, y) in enumerate(zip(fx, fy))]


def layout_targets(screen: ScreenInfo, grid: str = "3x3", margin: float = 0.08, layout: str = "grid", order: str = "serpentine", seed: int = 0) -> list[Target]:
    """Full-calibration dots: the grid, plus (``"grid_plus"``) a dot in the middle of each cell
    of four, or (``"edges"``) extra dots half-way along the outer edges between grid dots;
    serpentine or shuffled (``order="random"``, seeded)."""
    base = grid_targets(screen, grid, margin)
    pts = [(t.x / screen.width, t.y / screen.height) for t in base]
    cols, rows = _grid_size(grid)
    xs = np.linspace(margin, 1 - margin, cols) if cols > 1 else np.array([0.5])
    ys = np.linspace(margin, 1 - margin, rows) if rows > 1 else np.array([0.5])
    extra: list[tuple[float, float]] = []
    if layout == "grid_plus":
        extra = [((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2) for j in range(len(ys) - 1) for i in range(len(xs) - 1)]
    elif layout == "edges":
        for i in range(len(xs) - 1):
            mx = (xs[i] + xs[i + 1]) / 2
            extra += [(mx, ys[0]), (mx, ys[-1])]
        for j in range(len(ys) - 1):
            my = (ys[j] + ys[j + 1]) / 2
            extra += [(xs[0], my), (xs[-1], my)]
    elif layout != "grid":
        raise ValueError(f"unknown layout {layout!r}")
    pts = pts + extra
    if extra and order != "random":
        # row-major serpentine over all dots
        ys_all = sorted({round(p[1], 6) for p in pts})
        ordered = []
        for r, yv in enumerate(ys_all):
            row = sorted([p for p in pts if round(p[1], 6) == yv], key=lambda p: p[0], reverse=bool(r % 2))
            ordered += row
        pts = ordered
    if order == "random":
        rng = np.random.default_rng(seed)
        pts = [pts[i] for i in rng.permutation(len(pts))]
    return [Target(i, float(fx * screen.width), float(fy * screen.height)) for i, (fx, fy) in enumerate(pts)]


SWEEP_DOT_BASE = 900
"""``dot_id`` of the first head-sweep dot in a grid plan (the second is 901, ...)."""

SWEEP_SAMPLE_BASE = 10000
"""Head-sweep samples get ``dot_id = SWEEP_SAMPLE_BASE + 1000 * k + window``."""


def sweep_targets(screen: ScreenInfo, n: int) -> list[Target]:
    """Head-sweep dots: the centre, then upper left and lower right (inset by a fifth)."""
    places = [(0.5, 0.5), (0.25, 0.3), (0.75, 0.7)]
    return [Target(SWEEP_DOT_BASE + i, float(fx * screen.width), float(fy * screen.height)) for i, (fx, fy) in enumerate(places[: max(0, min(3, n))])]


def config_targets(config: CalibrationConfig, screen: ScreenInfo, kind: str, seed: int = 0) -> list[Target]:
    """Targets for a run of ``kind`` using the configured grid / refine / validate counts."""
    if kind == "grid":
        layout = getattr(config, "layout", "grid")
        order = getattr(config, "dot_order", "serpentine")
        if layout == "grid" and order == "serpentine":
            return grid_targets(screen, config.grid, config.margin)
        return layout_targets(screen, config.grid, config.margin, layout, order, seed=seed or int(time.time()) % 100000)
    if kind == "pursuit":
        return pursuit_targets(screen, margin=max(config.margin, 0.05))
    if kind == "refine":
        return refine_targets(screen, config.refine_points)
    if kind == "validate":
        return random_targets(screen, config.validate_points, config.margin, seed=seed, avoid=grid_targets(screen, config.grid, config.margin))
    raise ValueError(f"unknown calibration kind {kind!r}")


# ---------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------


def angular_error_deg(predicted: tuple[float, float], target: tuple[float, float], obs: Observation, screen: ScreenInfo, distance_m: float | None = None) -> float | None:
    """Visual angle between two screen points as seen from the eyes in ``obs`` (uses the
    observation's distance, or ``distance_m`` when given, and the screen's millimetre size).
    ``None`` if either is unknown."""
    mpp = screen.mm_per_point
    d = distance_m or obs.distance
    if mpp is None or not d:
        return None
    dx = (predicted[0] - target[0]) * mpp[0]
    dy = (predicted[1] - target[1]) * mpp[1]
    return float(math.degrees(math.atan2(math.hypot(dx, dy), d * 1000.0)))


# ---------------------------------------------------------------------------------------------
# Collecting samples
# ---------------------------------------------------------------------------------------------


EYE_WIDTH_M = 0.03
"""Typical distance between the inner and outer eye corners, to turn the iris-to-corner vector
into approximate degrees of eye rotation."""

SPREAD_FACTOR = {"corner": 1.0, "iris": 1.5, "gaze": 1.0}
"""How much of ``max_spread_deg`` each stability feature may use. The raw iris ray also moves
with head translation (about 5.6 degrees per millimetre), so it gets more room."""


def _dot_features(obs: Observation) -> dict[str, np.ndarray]:
    """Per-sample measurements used to find outliers and judge stability, each in approximate
    degrees of eye rotation:

    - ``"corner"``: the iris centre relative to the eye corners. Head translation moves iris and
      corners together, so seated sway does not count, but corner noise does (a lot at low
      resolution);
    - ``"iris"``: the iris-centre ray. Precise, but head translation reaches it;
    - ``"gaze"``: the optical-axis angles (ARKit's eye direction, or the estimators' axis).

    All of them move when the eyes really move; :func:`clean_dot` judges a dot on whichever is
    steadiest, so each feature's own noise or blind spot does not reject good dots."""
    out: dict[str, np.ndarray] = {}
    vecs = [v for v in (F.iris_corner_vector(obs, s) for s in F.SIDES) if v is not None]
    if vecs:
        out["corner"] = np.degrees(np.mean(np.array(vecs, float), axis=0) * EYE_WIDTH_M / F.EYE_IRIS_DISTANCE_M)
    rays = [obs.intrinsics.ray(*obs.eye(s).iris_center) for s in F.SIDES if obs.intrinsics is not None and obs.eye(s).iris_center is not None and not obs.eye(s).blink]
    if rays:
        d = obs.distance or 0.6
        out["iris"] = np.mean(rays, axis=0) * d / (F.EYE_IRIS_DISTANCE_M * math.pi / 180.0)
    angs = [F.dir_angles(g) for g in (F.optical_dir(obs, s) for s in F.SIDES) if g is not None]
    if angs:
        out["gaze"] = np.degrees(np.mean(angs, axis=0))
    return out


def clean_dot(observations: list[Observation], outlier_mad: float = 3.0, min_samples: int = 4, max_spread_deg: float = 3.0) -> tuple[list[Observation], str]:
    """See :func:`clean_dot_info` (this drops the scatter)."""
    kept, reason, _ = clean_dot_info(observations, outlier_mad, min_samples, max_spread_deg)
    return kept, reason


def clean_dot_info(observations: list[Observation], outlier_mad: float = 3.0, min_samples: int = 4, max_spread_deg: float = 3.0) -> tuple[list[Observation], str, float | None]:
    """Drop blinks, missing eyes and outliers from one dot's observations; check stability.

    Each stability feature (:func:`_dot_features`) available in at least ``min_samples``
    observations is tried; the dot is judged on the one with the smallest spread relative to its
    limit, and its outliers are dropped. Returns the kept observations and ``""``, or ``[]`` and
    the reason the dot was rejected.
    """
    usable: list[tuple[Observation, dict[str, np.ndarray]]] = []
    for o in observations:
        if (o.left.blink and o.right.blink) or not (F.eye_usable(o.left) or F.eye_usable(o.right)):
            continue
        f = _dot_features(o)
        if f:
            usable.append((o, f))
    if not usable:
        return [], "no usable eye measurements (blinks or tracking lost)", None
    best: tuple[float, list[Observation], float] | None = None
    most = 0
    for kind, factor in SPREAD_FACTOR.items():
        rows = [(o, f[kind]) for o, f in usable if kind in f]
        most = max(most, len(rows))
        if len(rows) < min_samples:
            continue
        x = np.array([v for _, v in rows])
        med = np.median(x, axis=0)
        mad = np.median(np.abs(x - med), axis=0) * 1.4826
        mad = np.maximum(mad, 0.1)  # degrees: never call sub-0.1-degree noise an outlier
        keep = np.all(np.abs(x - med) <= outlier_mad * mad, axis=1)
        kept = [o for (o, _), k in zip(rows, keep) if k]
        if len(kept) < min_samples:
            continue
        spread = float(np.sqrt(np.sum(np.var(x[keep], axis=0))))
        score = spread / (max_spread_deg * factor)
        if best is None or score < best[0]:
            best = (score, kept, spread)
    if best is None:
        if most < min_samples:
            return [], f"only {most} usable samples (need {min_samples})", None
        return [], f"too few samples left after removing outliers (need {min_samples})", None
    score, kept, spread = best
    if score > 1.0:
        return [], f"gaze not steady (spread {spread:.1f} deg)", spread
    return kept, "", spread


@dataclass
class CalibrationRun:
    """One full, refine or validate run.

    The server creates it with the targets, then calls ``begin_dot`` / ``end_dot`` as the UI
    reports, and ``add`` for every observation in between.

    Collection rules: samples in the first ``discard_ms`` after ``begin_dot`` are dropped (the
    eyes are still landing; the UI's settle time already passed). At ``end_dot`` the dot's
    samples are cleaned (:func:`clean_dot`); a dot that fails is listed in ``rejected`` and
    contributes nothing. A grid dot shown again after it ended starts a new ``pose_group`` (the
    "move your head and repeat" round); its samples get ``dot_id + 1000 * pose_group`` so each
    (dot, pose) is its own group for leave-one-dot-out.
    """

    run_id: str
    kind: str  # "grid" | "pursuit" | "refine" | "validate"
    targets: list[Target]
    screen: ScreenInfo
    samples: list[CalibSample] = field(default_factory=list)
    discard_ms: float = 150.0
    outlier_mad: float = 3.0
    min_samples: int = 4
    max_spread_deg: float = 3.0
    rejected: list[dict[str, Any]] = field(default_factory=list)
    dots: list[dict[str, Any]] = field(default_factory=list)
    pose_group: int = 0
    sweep_ids: set[int] = field(default_factory=set)
    sweep_window_ms: float = 300.0
    sweep_weight: float = 3.0
    _current: dict[str, Any] | None = None
    _pending: list[Observation] = field(default_factory=list)
    _done: set[int] = field(default_factory=set)

    def __post_init__(self) -> None:
        if self.kind == "pursuit":
            self.discard_ms = 0.0
            self.min_samples = 2
            self.max_spread_deg = 6.0

    def begin_dot(self, dot_id: int, x: float, y: float, t_local: float, pose_group: int | None = None) -> None:
        if self._current is not None and self._current["dot_id"] == int(dot_id) and pose_group in (None, self._current["pose_group"]):
            return  # a repeated "collect" for the dot already being collected
        if self._current is not None:
            self.end_dot(self._current["dot_id"], t_local)
        if pose_group is not None:
            self.pose_group = int(pose_group)
        elif self.kind == "grid" and dot_id in self._done:
            self.pose_group += 1
            self._done = set()
        self._current = {"dot_id": int(dot_id), "x": float(x), "y": float(y), "t0": float(t_local), "pose_group": self.pose_group}
        self._pending = []

    def end_dot(self, dot_id: int, t_local: float) -> None:
        cur = self._current
        if cur is None or cur["dot_id"] != int(dot_id):
            return
        self._current = None
        pending, self._pending = self._pending, []
        self._done.add(int(dot_id))
        if int(dot_id) in self.sweep_ids:
            self._end_sweep(cur, pending)
            return
        kept, reason, spread = clean_dot_info(pending, self.outlier_mad, self.min_samples, self.max_spread_deg)
        pg = cur["pose_group"]
        sid = cur["dot_id"] + 1000 * pg if self.kind in ("grid", "validate", "refine") else cur["dot_id"]
        info = {"dot_id": sid, "target": [cur["x"], cur["y"]], "pose_group": pg, "n_raw": len(pending), "n_kept": len(kept), "reason": reason, "scatter_deg": spread, "t0": cur["t0"]}
        prev = next((d for d in self.dots if d["dot_id"] == sid and not d.get("replaced")), None)
        if prev is not None and self.kind != "pursuit":
            # Shown again (quality gate): keep the better attempt.
            prev_ok = not prev["reason"]
            better = bool(reason) is False and (not prev_ok or (spread or 0.0) <= (prev.get("scatter_deg") or 0.0))
            if not better:
                info["replaced"] = True
                info["retry"] = True
                self.dots.append(info)
                return
            prev["replaced"] = True
            self.samples = [s for s in self.samples if s.dot_id != sid]
            self.rejected = [d for d in self.rejected if d is not prev]
            info["retry"] = True
        self.dots.append(info)
        if reason:
            self.rejected.append(info)
            return
        kind = self.kind if self.kind in ("grid", "pursuit", "refine", "validate") else "grid"
        for o in kept:
            self.samples.append(CalibSample(target=(cur["x"], cur["y"]), obs=o, kind=kind, dot_id=sid, run_id=self.run_id, pose_group=pg, t_local=o.t_local))

    def _end_sweep(self, cur: dict[str, Any], pending: list[Observation]) -> None:
        """A head-sweep dot: keep frames with a usable eye, cut them into windows of
        ``sweep_window_ms`` (each its own ``dot_id``, all in pose group ``100 + k``), and give
        each window an equal share of ``sweep_weight``. No steadiness check: the iris moves in
        the image as the head turns, which is the point."""
        k = int(cur["dot_id"]) - SWEEP_DOT_BASE
        usable = [o for o in pending if not (o.left.blink and o.right.blink) and (F.eye_usable(o.left) or F.eye_usable(o.right))]
        t0 = cur["t0"]
        win = max(self.sweep_window_ms, 1.0) / 1000.0
        groups: dict[int, list[Observation]] = {}
        for i, o in enumerate(usable):
            t = o.t_local if o.t_local is not None else t0 + i / 30.0
            groups.setdefault(int(max(0.0, t - t0) // win), []).append(o)
        groups = {w: obs for w, obs in groups.items() if len(obs) >= 2}
        pg = 100 + k
        info = {"dot_id": SWEEP_SAMPLE_BASE + 1000 * k, "target": [cur["x"], cur["y"]], "pose_group": pg, "n_raw": len(pending), "n_kept": sum(len(v) for v in groups.values()), "reason": "", "sweep": True, "windows": len(groups), "t0": t0}
        if len(groups) < 3:
            info["reason"] = f"head sweep too short or tracking lost ({len(groups)} usable windows)"
            self.dots.append(info)
            self.rejected.append(info)
            return
        self.dots.append(info)
        share = self.sweep_weight / len(groups)
        for j, (w, obs) in enumerate(sorted(groups.items())):
            for o in obs:
                self.samples.append(CalibSample(target=(cur["x"], cur["y"]), obs=o, kind="sweep", dot_id=SWEEP_SAMPLE_BASE + 1000 * k + min(j, 999), run_id=self.run_id, pose_group=pg, t_local=o.t_local, weight=share))

    def add(self, obs: Observation) -> None:
        """Store ``obs`` as a sample of the current dot (ignored between dots)."""
        cur = self._current
        if cur is None:
            return
        if obs.t_local is not None and obs.t_local < cur["t0"] + self.discard_ms / 1000.0:
            return
        self._pending.append(obs)


# ---------------------------------------------------------------------------------------------
# Fitting and choosing
# ---------------------------------------------------------------------------------------------


@dataclass
class CalibrationResult:
    reports: list[FitReport]
    chosen: str | None
    models: dict[str, GazeModel]
    info: dict[str, Any] = field(default_factory=dict)
    """What :func:`fit_with_options` decided (moving-dot merge, weighting, ...), for the report."""


MIN_LOO_COVERAGE = 0.7
"""A model must predict at least this fraction of held-out samples to be chosen."""


REGRESSION_MODELS = ("ridge", "kernel")
"""Models that learn a mapping from features and cannot extrapolate to head positions they never
saw. From one head position they are chosen only by a clear margin (:data:`REGRESSION_MARGIN`)."""

REGRESSION_MARGIN = 0.5
"""From a single head position a regression model (or a blend whose weight is mostly regression
models, ``params["regression_share"]`` above one half) must score below this fraction of the best
physical model's score (geometric, reflection, residual) to be chosen."""


def _regression_like(r: FitReport) -> bool:
    return r.model in REGRESSION_MODELS or float((r.params or {}).get("regression_share") or 0.0) > 0.5


def fit_all(samples: list[CalibSample], screen: ScreenInfo, models: list[GazeModel]) -> CalibrationResult:
    """Fit every candidate, score each held-out, choose the best.

    Scores: ``loo_error_deg`` is leave-one-dot-out. With samples from more than one head
    position (``pose_group``), each model is also scored leave-one-POSE-out
    (``params["lopo_error_deg"]``) and the selection score (``params["selection_error_deg"]``) is
    the worse of the two, so a model that only interpolates between the head positions it saw
    is not chosen over one that generalises. See :func:`choose`.

    Errors (``train_error_*``, ``loo_error_*``) are the error of each dot's MEAN prediction,
    averaged over dots: accuracy, separate from the frame-to-frame noise that ``precision_deg``
    reports and the filters remove. ``params["loo_sample_error_deg"]`` is the per-sample mean.
    Degrees use each observation's measured eye-to-camera distance, the same for every model.
    """
    from .models.blend import BlendModel

    train = fit_samples(samples)
    reports: dict[str, FitReport] = {}
    fitted: dict[str, GazeModel] = {}
    loo: dict[str, np.ndarray] = {}
    lopo: dict[str, np.ndarray] = {}
    multi_pose = len(pose_groups(train)) > 1
    plain = [m for m in models if not isinstance(m, BlendModel)]
    blends = [m for m in models if isinstance(m, BlendModel)]
    for m in plain:
        rep = m.fit(train, screen)
        reports[m.name] = rep
        fitted[m.name] = m
        if rep.ok and isinstance(m, BaseModel):
            t0 = time.perf_counter()
            loo[m.name] = loo_predictions(m, train, screen)
            if multi_pose:
                lopo[m.name] = lopo_predictions(m, train, screen)
            rep.fit_seconds = (rep.fit_seconds or 0.0) + time.perf_counter() - t0
    for name in list(loo):
        eyes = getattr(fitted[name], "loo_eyes", None)
        if eyes:
            _eye_choice(fitted[name], reports[name], loo, eyes, train, screen)
    for b in blends:
        members = {k: v for k, v in fitted.items() if reports[k].ok and isinstance(v, BaseModel)}
        # Weight members by their leave-one-pose-out predictions when there are several poses.
        rep = b.fit_from_members(members, {k: lopo.get(k, loo.get(k)) for k in loo}, train, screen)
        reports[b.name] = rep
        fitted[b.name] = b
        if rep.ok:
            share = sum(w for n, w in b.weights.items() if n in REGRESSION_MODELS) / max(sum(b.weights.values()), 1e-12)
            rep.params = {**rep.params, "regression_share": share}
            loo[b.name] = b.loo_from_members(loo, train)
            if multi_pose and lopo:
                lopo[b.name] = b.loo_from_members(lopo, train)
    # One distance rule for every model: each observation's measured eye-to-camera distance. A
    # geometric solve can fit well while placing the camera tens of centimetres from where it is,
    # and its solved viewing distance would then flatter some models and not others.
    dist = None
    # Held-out scores count only the dots that are held out (not head-sweep or moving-dot
    # pieces when there are ordinary dots: models/base.py, scored_dots).
    scored = scored_dots(train)
    smask = np.array([int(s.dot_id) in scored for s in train], bool)
    held = [s for s, k in zip(train, smask) if k]
    for name, rep in reports.items():
        if not rep.ok:
            continue
        model = fitted[name]
        if isinstance(model, BaseModel):
            tr = error_stats(train, model.predict_samples(train, raw=True), screen, dist)
            rep.train_error_deg, rep.train_error_pt, rep.precision_deg, rep.per_dot = tr["error_of_mean_deg"], tr["error_of_mean_pt"], tr["precision_deg"], tr["per_dot"]
        if name in loo:
            st = error_stats(held, loo[name][smask], screen, dist)
            rep.loo_error_deg, rep.loo_error_pt = st["error_of_mean_deg"], st["error_of_mean_pt"]
            coverage = st["n_valid"] / max(st["n"], 1)
            rep.params = {**rep.params, "loo_coverage": coverage, "loo_sample_error_deg": st["error_deg"]}
            score_deg, score_pt = rep.loo_error_deg, rep.loo_error_pt
            if name in lopo:
                sp = error_stats(held, lopo[name][smask], screen, dist)
                lp_cov = sp["n_valid"] / max(sp["n"], 1)
                rep.params = {**rep.params, "lopo_error_deg": sp["error_of_mean_deg"], "lopo_error_pt": sp["error_of_mean_pt"], "lopo_coverage": lp_cov}
                # A head position whose fold could not be fitted (too few dots left) says nothing
                # about the model: the leave-one-pose-out score counts only when it covers enough.
                if lp_cov >= MIN_LOO_COVERAGE:
                    if sp["error_of_mean_deg"] is not None and score_deg is not None:
                        score_deg = max(score_deg, sp["error_of_mean_deg"])
                    if sp["error_of_mean_pt"] is not None and score_pt is not None:
                        score_pt = max(score_pt, sp["error_of_mean_pt"])
            rep.params = {**rep.params, "selection_error_deg": score_deg, "selection_error_pt": score_pt}
            if coverage < MIN_LOO_COVERAGE:
                rep.message = (rep.message + " " if rep.message else "") + f"Predicted only {coverage:.0%} of held-out samples; not eligible for automatic choice."
    chosen = choose(list(reports.values()), multi_pose=multi_pose)
    if chosen is not None and not multi_pose:
        rep = reports[chosen]
        rep.message = (rep.message + " " if rep.message else "") + "Calibrated from one head position: how well it copes with head movement was not tested (repeat the grid from more head positions to test it)."
    return CalibrationResult(reports=[reports[m.name] for m in models if m.name in reports], chosen=chosen, models={k: v for k, v in fitted.items()})


def _eye_choice(model: Any, rep: FitReport, loo: dict[str, np.ndarray], eyes: dict[str, np.ndarray], train: list[CalibSample], screen: ScreenInfo) -> None:
    """Per-eye held-out scores into the report (``params["eye_loo_deg"]``: both, left, right, and
    ``weighted`` = both eyes weighted by their inverse squared held-out error); with the model's
    ``eye="auto"``, switch it to one eye or to the weighted pair when that is at least
    ``eye_auto_margin`` lower than both together (and it predicted enough held-out samples). The
    choice among three candidates is itself made on the held-out errors, a small optimism the
    margin is there to cover."""
    scores: dict[str, float | None] = {}
    cover: dict[str, float] = {}
    scored = scored_dots(train)
    smask = np.array([int(s.dot_id) in scored for s in train], bool)
    held = [s for s, k in zip(train, smask) if k]
    for side, pred in [("both", loo[rep.model])] + sorted(eyes.items()):
        st = error_stats(held, pred[smask], screen, None)
        scores[side] = st["error_of_mean_deg"]
        cover[side] = st["n_valid"] / max(st["n"], 1)
    # Both eyes weighted by inverse squared per-eye held-out error (an approximation of what
    # the model's confidence-weighted fusion would give with those weights).
    weights = None
    if scores.get("left") and scores.get("right") and "left" in eyes and "right" in eyes:
        wl, wr = 1.0 / max(float(scores["left"]), 0.1) ** 2, 1.0 / max(float(scores["right"]), 0.1) ** 2  # type: ignore[arg-type]
        k = 2.0 / (wl + wr)
        weights = {"left": wl * k, "right": wr * k}
        pl, pr = eyes["left"], eyes["right"]
        okl, okr = np.all(np.isfinite(pl), axis=1), np.all(np.isfinite(pr), axis=1)
        pw = np.where(okl[:, None], pl, pr)
        both_ok = okl & okr
        pw[both_ok] = (weights["left"] * pl[both_ok] + weights["right"] * pr[both_ok]) / (weights["left"] + weights["right"])
        eyes = {**eyes, "weighted": pw}
        st = error_stats(held, pw[smask], screen, None)
        scores["weighted"] = st["error_of_mean_deg"]
        cover["weighted"] = st["n_valid"] / max(st["n"], 1)
    rep.params = {**(rep.params or {}), "eye_loo_deg": scores, "eye_loo_coverage": cover}
    opts = getattr(model, "options", {}) or {}
    if opts.get("eye") != "auto" or scores.get("both") is None:
        return
    margin = float(opts.get("eye_auto_margin", 0.15))
    cands = [(v, k) for k, v in scores.items() if k != "both" and v is not None and cover.get(k, 0) >= max(MIN_LOO_COVERAGE, 0.9 * cover["both"])]
    if not cands:
        return
    best, side = min(cands)
    if best < (1.0 - margin) * float(scores["both"]):  # type: ignore[arg-type]
        model.eye_use = side
        if side == "weighted" and weights is not None:
            model.eye_weights = weights
        loo[rep.model] = eyes[side]
        what = f"both eyes weighted left {weights['left']:.2f} / right {weights['right']:.2f}" if side == "weighted" and weights else f"the {side} eye only"
        rep.message = (rep.message + " " if rep.message else "") + f"Eye 'auto': using {what} (held-out {best:.2f} deg vs {scores['both']:.2f} deg with both)."
    else:
        model.eye_use = "both"
    rep.params = {**rep.params, "eye_used": model.eye_use}


def _score(r: FitReport, unit: str) -> float | None:
    p = r.params or {}
    v = p.get(f"selection_error_{unit}")
    if v is None:
        v = r.loo_error_deg if unit == "deg" else r.loo_error_pt
    return None if v is None else float(v)


def choose(reports: list[FitReport], multi_pose: bool = False) -> str | None:
    """The eligible report with the lowest selection score (degrees, else points).

    The score is the leave-one-dot-out error, or with several head positions the worse of that
    and the leave-one-pose-out error. From a single head position nothing measures how a model
    copes with head movement, so a regression model (:data:`REGRESSION_MODELS`) is chosen only
    if it beats the best physical model by a clear margin (:data:`REGRESSION_MARGIN`)."""
    ok = [r for r in reports if r.ok and (r.params or {}).get("loo_coverage", 1.0) >= MIN_LOO_COVERAGE]
    for unit in ("deg", "pt"):
        scored = [(s, r) for r in ok if (s := _score(r, unit)) is not None]
        if not scored:
            continue
        best_s, best = min(scored, key=lambda t: t[0])
        if not multi_pose and _regression_like(best):
            physical = [(s, r) for s, r in scored if not _regression_like(r)]
            if physical:
                phys_s, phys = min(physical, key=lambda t: t[0])
                if best_s > REGRESSION_MARGIN * phys_s:
                    return phys.model
        return best.model
    return ok[0].model if ok else None


# ---------------------------------------------------------------------------------------------
# Quick refine and drift
# ---------------------------------------------------------------------------------------------


def refine(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
    """Quick refine: 1 dot corrects an offset; 3-5 re-solve the screen pose (geometric) or an
    affine correction (others), keeping person parameters. Samples of kind ``"drift"`` (known
    look-points from clicks or dwell selections) go to :func:`drift_correct` instead."""
    if samples and all(s.kind == "drift" for s in samples):
        return drift_correct(model, samples, screen)
    if not isinstance(model, BaseModel):
        return FitReport(model=getattr(model, "name", "?"), ok=False, message="this model cannot be refined")
    return model.refine(samples, screen)


def drift_correct(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo, rate: float = 0.3, max_step_deg: float = 0.5, max_residual_deg: float = 4.0) -> FitReport:
    """Conservative online offset correction from known look-points.

    Per look-point (``dot_id``), ``target - mean prediction`` (``dot_predictions``). Look-points whose
    residual exceeds ``max_residual_deg`` are ignored (the person was probably not looking
    there). The offset moves ``rate`` of the way to the median of the rest, at most
    ``max_step_deg`` per call. Repeated calls with the same look-points converge rather than
    accumulate, because residuals are measured with the current correction applied.
    """
    name = getattr(model, "name", "?")
    if not isinstance(model, BaseModel) or not samples:
        return FitReport(model=name, ok=False, message="drift correction needs a fitted model and look-points")
    mx, my, _ = mm_per_point(screen)
    measured = [s.obs.distance for s in samples if s.obs.distance]
    dist = float(np.median(measured)) if measured else (model.degree_distance() or 0.6)
    pt_per_deg = dist * 1000.0 * math.tan(math.radians(1.0)) / ((mx + my) / 2)
    _, pred, target, _ = model.dot_predictions(samples)
    resid = []
    for p_d, t_d in zip(pred, target):
        if not np.all(np.isfinite(p_d)):
            continue
        r = t_d - p_d
        if np.linalg.norm(r) <= max_residual_deg * pt_per_deg:
            resid.append(r)
    if not resid:
        return FitReport(model=name, ok=False, n_samples=len(samples), message="no look-point close enough to the prediction to trust")
    step = rate * np.median(np.array(resid), axis=0)
    cap = max_step_deg * pt_per_deg
    n = float(np.linalg.norm(step))
    if n > cap:
        step *= cap / n
    model.correction = model.correction.then(Correction(b=step))
    return FitReport(model=name, ok=True, n_samples=len(samples), n_dots=len(resid), params={"method": "drift", "step_pt": step.tolist(), "correction": model.correction.to_dict()}, message=f"drift correction from {len(resid)} look-point(s)")


# ---------------------------------------------------------------------------------------------
# Validation and prediction
# ---------------------------------------------------------------------------------------------


def validation_metrics(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo) -> dict[str, Any]:
    """Accuracy (mean angular error) and precision (RMS sample-to-sample) in degrees on
    validation samples: ``{"accuracy_deg", "precision_deg", "accuracy_pt", "n", "per_dot"}``.

    Also ``n_valid`` / ``valid_fraction`` (samples the model predicted) and
    ``accuracy_of_mean_deg`` (error of each dot's mean prediction, averaged over dots)."""
    if isinstance(model, BaseModel):
        pred = model.predict_samples(samples)
        dist = None  # each observation's measured distance, the same for every model (see fit_all)
    else:
        pred = np.full((len(samples), 2), np.nan)
        for i, s in enumerate(samples):
            p = model.predict(s.obs)
            if p is not None and p.valid:
                pred[i] = (p.x, p.y)
        dist = None
    st = error_stats(samples, pred, screen, dist)
    dot_err = [d["error_deg"] for d in st["per_dot"] if d.get("error_deg") is not None]
    return {
        "accuracy_deg": st["error_deg"],
        "precision_deg": st["precision_deg"],
        "accuracy_pt": st["error_pt"],
        "accuracy_of_mean_deg": float(np.mean(dot_err)) if dot_err else None,
        "n": st["n"],
        "n_valid": st["n_valid"],
        "valid_fraction": st["n_valid"] / st["n"] if st["n"] else 0.0,
        "per_dot": st["per_dot"],
    }


def predict_all(models: dict[str, GazeModel], obs: Observation) -> dict[str, GazePoint | None]:
    out: dict[str, GazePoint | None] = {}
    for name, m in models.items():
        try:
            out[name] = m.predict(obs)
        except Exception:  # noqa: BLE001 - one broken model must not hide the others
            out[name] = None
    return out


# ---------------------------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------------------------


def _geometric_of(result: CalibrationResult) -> Any:
    from .models.blend import BlendModel, ResidualModel
    from .models.geometric import GeometricModel

    ordered = list(result.models.values())
    if result.chosen in result.models:
        ordered.insert(0, result.models[result.chosen])
    for m in ordered:
        if isinstance(m, GeometricModel) and m.fitted:
            return m
        if isinstance(m, ResidualModel) and isinstance(m.base, GeometricModel) and m.base.fitted:
            return m.base
        if isinstance(m, BlendModel) and isinstance(m.members.get("geometric"), GeometricModel):
            return m.members["geometric"]
    return None


def _write_json(path: Path, data: dict[str, Any]) -> None:
    from .types import _jsonable

    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(_jsonable(data), indent=1))
    os.replace(tmp, path)


class Profile:
    """What is learned, saved in three layers under ``~/.phonegaze/profiles/<name>/``:
    ``person.json`` (per-eye angular offsets, eye geometry), ``setup.json`` (camera-to-screen
    pose, chosen camera and zoom, screen), ``session.json`` (latest fitted models and reports).

    ``load`` rebuilds the session's models; with no session but a person and a setup, it
    rebuilds a geometric model from those two layers alone."""

    VERSION = 1

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = Path(directory) if directory is not None else Path.home() / ".phonegaze" / "profiles" / "default"

    def save(self, result: CalibrationResult, screen: ScreenInfo, camera: dict[str, Any] | None = None) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        now = time.time()
        geo = _geometric_of(result)
        if geo is not None:
            _write_json(self.directory / "person.json", {"version": self.VERSION, "saved_at": now, "geometric": geo.person_params()})
        setup: dict[str, Any] = {"version": self.VERSION, "saved_at": now, "screen": screen.to_dict()}
        if geo is not None:
            setup["geometric"] = geo.setup_params()
        if camera:
            setup["camera"] = camera
        _write_json(self.directory / "setup.json", setup)
        models = {}
        for name, m in result.models.items():
            try:
                models[name] = m.to_dict()
            except Exception as exc:  # noqa: BLE001
                log.warning("cannot save model %s: %s", name, exc)
        _write_json(
            self.directory / "session.json",
            {"version": self.VERSION, "saved_at": now, "chosen": result.chosen, "reports": [r.to_dict() for r in result.reports], "models": models},
        )

    def _read(self, name: str) -> dict[str, Any] | None:
        path = self.directory / name
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            log.warning("cannot read %s: %s", path, exc)
            return None

    def person(self) -> dict[str, Any] | None:
        return self._read("person.json")

    def setup(self) -> dict[str, Any] | None:
        return self._read("setup.json")

    def load(self) -> CalibrationResult | None:
        from .models import load_model
        from .models.geometric import GeometricModel

        session = self._read("session.json")
        if session and session.get("models"):
            models: dict[str, GazeModel] = {}
            for name, data in session["models"].items():
                try:
                    m = load_model(data)
                except Exception as exc:  # noqa: BLE001
                    log.warning("cannot load saved model %s: %s", name, exc)
                    continue
                if getattr(m, "fitted", True):
                    models[name] = m
            reports = [FitReport.from_dict(r) for r in session.get("reports") or []]
            chosen = session.get("chosen")
            if chosen not in models:
                chosen = next(iter(models), None)
            if models:
                return CalibrationResult(reports=reports, chosen=chosen, models=models)
        person, setup = self.person(), self.setup()
        if person and setup and person.get("geometric") and setup.get("geometric"):
            m = GeometricModel()
            params = np.concatenate([np.asarray(setup["geometric"]["params"], float), np.asarray(person["geometric"]["params"], float)])
            full = GeometricModel.default_params()
            full[: min(len(params), len(full))] = params[: len(full)]
            m.params = full
            m.viewing_distance_m = setup["geometric"].get("viewing_distance_m")
            scr = ScreenInfo.from_dict(setup["screen"]) if setup.get("screen") else None
            if scr is not None:
                mx, my, _ = mm_per_point(scr)
                m.mm_per_point = (mx, my)
                m.screen_size = (scr.width, scr.height)
            m.fitted = True
            return CalibrationResult(reports=[FitReport(model="geometric", ok=True, message="rebuilt from the saved person and setup")], chosen="geometric", models={"geometric": m})
        return None


# ---------------------------------------------------------------------------------------------
# Switchable additions: runs from config, sample weighting, the moving dot merged, the quality
# gate, the error map and touch-up. See the module docstring.
# ---------------------------------------------------------------------------------------------


def make_run(config: CalibrationConfig, run_id: str, kind: str, targets: list[Target], screen: ScreenInfo) -> CalibrationRun:
    """A :class:`CalibrationRun` with the configured collection knobs (discard time, stability
    threshold, minimum samples, outlier threshold) and, for a grid run, the head-sweep dots."""
    run = CalibrationRun(run_id=run_id, kind=kind, targets=list(targets), screen=screen)
    knobs: dict[str, Any] = {"outlier_mad": float(getattr(config, "outlier_mad", 3.0))}
    if kind != "pursuit":
        knobs.update(discard_ms=float(getattr(config, "discard_ms", 150)), max_spread_deg=float(getattr(config, "stability_deg", 3.0)), min_samples=int(getattr(config, "min_samples", 4)))
    if kind == "grid":
        knobs.update(
            sweep_ids={t.dot_id for t in sweep_targets(screen, int(getattr(config, "head_sweep", 0)))},
            sweep_window_ms=float(getattr(config, "sweep_window_ms", 300)),
            sweep_weight=float(getattr(config, "sweep_weight", 3.0)),
        )
    for k, v in knobs.items():
        if hasattr(run, k):  # test doubles may not have every knob
            setattr(run, k, v)
    return run


SWEEP_PROMPTS = [
    "Keep looking at the dot. Slowly turn your head left and right, then up and down, and lean a little closer and further. Keep your eyes on the dot the whole time.",
    "Again with this dot: keep your eyes on it while you slowly turn and move your head.",
    "Last one: eyes on the dot, head moving slowly.",
]


def plan_extras(config: CalibrationConfig, kind: str, screen: ScreenInfo) -> dict[str, Any]:
    """Extra fields for a run's plan (docs/INTERFACES.md "Calibration flow"): ``sweep`` (head-sweep
    dots, seconds per dot, prompts) and ``quality_gate`` for a grid run."""
    out: dict[str, Any] = {}
    if kind == "grid":
        sw = sweep_targets(screen, int(getattr(config, "head_sweep", 0)))
        out["sweep"] = {"targets": [t.to_dict() for t in sw], "seconds": float(getattr(config, "sweep_s", 10.0)), "prompts": SWEEP_PROMPTS[: len(sw)]}
        out["quality_gate"] = bool(getattr(config, "quality_gate", False))
    return out


def weight_samples(samples: list[CalibSample], mode: str = "per_dot") -> list[CalibSample]:
    """Set each ordinary dot's sample ``weight`` by ``calibration.sample_weighting``:

    - ``per_dot``: unchanged (every dot counts the same);
    - ``precision``: ``(0.5^2 + 0.25^2) / (scatter^2 + 0.25^2)`` with the dot's scatter in degrees
      (:func:`clean_dot_info`), clipped to 0.25-3: a dot scattering 0.5 degrees counts 1;
    - ``per_sample``: the dot's sample count over the median count (clipped 0.25-4).

    Head-sweep and moving-dot samples keep their own weights. Returns new samples."""
    from dataclasses import replace as _replace

    if mode not in ("precision", "per_sample"):
        return list(samples)
    groups: dict[int, list[int]] = {}
    for i, s in enumerate(samples):
        if s.kind not in ("sweep", "pursuit"):
            groups.setdefault(int(s.dot_id), []).append(i)
    if not groups:
        return list(samples)
    factor: dict[int, float] = {}
    if mode == "per_sample":
        med = float(np.median([len(v) for v in groups.values()]))
        for d, idx in groups.items():
            factor[d] = float(np.clip(len(idx) / max(med, 1.0), 0.25, 4.0))
    else:
        for d, idx in groups.items():
            _, _, spread = clean_dot_info([samples[i].obs for i in idx], outlier_mad=1e9, min_samples=1, max_spread_deg=1e9)
            sp = 0.5 if spread is None else spread
            factor[d] = float(np.clip((0.25 + 0.0625) / (sp * sp + 0.0625), 0.25, 3.0))
    out = list(samples)
    for d, idx in groups.items():
        for i in idx:
            out[i] = _replace(samples[i], weight=float(samples[i].weight) * factor[d])
    return out


def _sample_time(s: CalibSample) -> float:
    return float(s.t_local if s.t_local is not None else s.obs.t_local if s.obs.t_local is not None else s.obs.t)


def _points_per_degree(samples: list[CalibSample], screen: ScreenInfo) -> float:
    mx, my, _ = mm_per_point(screen)
    d = [s.obs.distance for s in samples if s.obs.distance]
    dist = float(np.median(d)) if d else 0.6
    return dist * 1000.0 * math.tan(math.radians(1.0)) / ((mx + my) / 2)


PURSUIT_SAMPLE_BASE = 20000
"""Merged moving-dot samples get ``dot_id = PURSUIT_SAMPLE_BASE + way-point``."""

PURSUIT_SMOOTH_FRAMES = 5
"""Running-median window (frames) for judging moving-dot samples in :func:`prepare_pursuit`."""


def prepare_pursuit(pursuit: list[CalibSample], model: BaseModel, screen: ScreenInfo, config: CalibrationConfig | None = None) -> tuple[list[CalibSample], dict[str, Any]]:
    """Make moving-dot samples fit to merge with the grid.

    1. Rebuild the dot's path: each way-point's position at the time its first sample arrived
       (the UI moves the dot between way-points at constant speed), linearly interpolated.
    2. Predict every sample with ``model`` (fitted on the grid alone), in time order through its
       live path (eyeball centres smoothed as in use).
    3. The eye's lag: the delay (0-400 ms, 10 ms steps) for which the dot's path that long before,
       through the best affine map, is closest to the predicted gaze (median distance), or
       ``pursuit_lag_ms`` when fixed.
    4. Drop catch-up saccades (gaze faster than ``pursuit_saccade_deg_s``, with the frames next to
       them) and samples further than ``pursuit_max_error_deg`` from the lagged dot.
    5. What is left gets the lagged dot position as its target and weight ``pursuit_weight`` per
       way-point (relative to a grid dot).

    Returns ``(samples, info)``; ``info`` has ``lag_ms``, ``n_in``, ``n_out``, ``dropped_saccade``,
    ``dropped_far``, ``median_error_deg_before`` / ``_after`` (the lag's effect)."""
    from dataclasses import replace as _replace

    cfg = config if config is not None else CalibrationConfig()
    info: dict[str, Any] = {"n_in": len(pursuit)}
    ps = sorted([s for s in pursuit if s.kind == "pursuit"], key=_sample_time)
    if len(ps) < 10 or not getattr(model, "fitted", False):
        info.update(n_out=0, reason="too few moving-dot samples or no grid fit")
        return [], info
    t = np.array([_sample_time(s) for s in ps])
    first: dict[int, tuple[float, tuple[float, float]]] = {}
    for s, ti in zip(ps, t):
        if int(s.dot_id) not in first:
            first[int(s.dot_id)] = (float(ti), (float(s.target[0]), float(s.target[1])))
    way = sorted(first.values())
    wt = np.array([w[0] for w in way])
    wx = np.array([w[1][0] for w in way])
    wy = np.array([w[1][1] for w in way])

    def path(tt: np.ndarray) -> np.ndarray:
        return np.stack([np.interp(tt, wt, wx), np.interp(tt, wt, wy)], axis=1)

    # In time order through the live path (a copy, so the model's own live state is untouched):
    # the geometric model smooths its eyeball centres over time there, as it will when in use.
    import copy as _copy

    pred = _copy.deepcopy(model).predict_samples(ps, raw=False)
    ok = np.all(np.isfinite(pred), axis=1)
    ppd = _points_per_degree(ps, screen)
    # Per-frame predictions are noisy (eyeball-centre jitter); judge speed and distance on a
    # centred running median over SMOOTH_FRAMES valid frames, which keeps catch-up steps.
    smooth = pred.copy()
    vidx = np.flatnonzero(ok)
    half = PURSUIT_SMOOTH_FRAMES // 2
    for j, i in enumerate(vidx):
        win = vidx[max(0, j - half) : j + half + 1]
        smooth[i] = np.median(pred[win], axis=0)
    if ok.sum() < 10:
        info.update(n_out=0, reason="the grid fit predicted too few moving-dot samples")
        return [], info
    fixed = float(getattr(cfg, "pursuit_lag_ms", -1.0))
    lags = np.arange(0.0, 401.0, 10.0)
    curve = [float(np.median(np.linalg.norm(smooth[ok] - path(t[ok] - lag / 1000.0), axis=1))) / ppd for lag in lags]
    # The lag: after the best affine map from the dot's lagged path to the (smoothed) gaze, the
    # residual is smallest. The affine map absorbs a constant offset or a gain error of the grid
    # fit, which would otherwise pull the estimate (a plain distance prefers whichever lag
    # happens to cancel them).
    vi = np.flatnonzero(ok)
    yv = smooth[vi]

    def resid(lag_ms: float) -> float:
        x = np.hstack([path(t[vi] - lag_ms / 1000.0), np.ones((len(vi), 1))])
        coef = np.linalg.lstsq(x, yv, rcond=None)[0]
        return float(np.median(np.linalg.norm(x @ coef - yv, axis=1)))

    rcurve = [resid(lag_ms) for lag_ms in lags]
    best = float(lags[int(np.argmin(rcurve))])
    lag = fixed if fixed >= 0 else best
    info["lag_ms"] = lag
    info["lag_estimated"] = fixed < 0
    info["median_error_deg_before"] = curve[0]
    tgt = path(t - lag / 1000.0)
    err = np.linalg.norm(smooth - tgt, axis=1) / ppd
    info["median_error_deg_after"] = float(np.median(err[ok]))
    # catch-up saccades: gaze speed between consecutive predicted samples
    sacc = np.zeros(len(ps), bool)
    vmax = float(getattr(cfg, "pursuit_saccade_deg_s", 60.0))
    idx = np.flatnonzero(ok)
    if len(idx) > 1:
        dt = np.maximum(np.diff(t[idx]), 1e-3)
        v = np.linalg.norm(np.diff(smooth[idx], axis=0), axis=1) / ppd / dt
        fast = np.flatnonzero(v > vmax)
        for f in fast:
            for j in (f - 1, f, f + 1, f + 2):  # the jump, its landing and a frame either side
                if 0 <= j < len(idx):
                    sacc[idx[j]] = True
    far = err > float(getattr(cfg, "pursuit_max_error_deg", 5.0))
    keep = ok & ~sacc & ~far
    info["dropped_saccade"] = int((ok & sacc).sum())
    info["dropped_far"] = int((ok & ~sacc & far).sum())
    w = float(getattr(cfg, "pursuit_weight", 0.25)) / 0.5  # kind "pursuit" already counts half
    # own dot ids (the moving-dot run numbers its way-points from 0, like the grid)
    out = [_replace(s, target=(float(tgt[i, 0]), float(tgt[i, 1])), weight=float(s.weight) * w, dot_id=PURSUIT_SAMPLE_BASE + int(s.dot_id)) for i, s in enumerate(ps) if keep[i]]
    info["n_out"] = len(out)
    return out, info


def _chosen_score(result: CalibrationResult) -> float | None:
    rep = next((r for r in result.reports if r.model == result.chosen), None)
    return None if rep is None else _score(rep, "deg")


def fit_with_options(samples: list[CalibSample], screen: ScreenInfo, make_models: Any, config: CalibrationConfig | None = None, pursuit: list[CalibSample] | None = None) -> CalibrationResult:
    """The full-calibration fit with the switchable options: sample weighting, then
    :func:`fit_all`; with moving-dot samples (from the moving-dot run before the grid) and
    ``pursuit_merge`` not ``"off"``, :func:`prepare_pursuit` against the grid fit's geometric (or
    chosen) model, a second :func:`fit_all` with them merged, and (``"auto"``) the merged fit kept
    only if the chosen model's held-out score on the grid dots is lower. ``make_models()``
    returns fresh candidate models. ``result.info`` says what happened."""
    cfg = config if config is not None else CalibrationConfig()
    info: dict[str, Any] = {"sample_weighting": getattr(cfg, "sample_weighting", "per_dot")}
    samples = weight_samples(samples, str(getattr(cfg, "sample_weighting", "per_dot")))
    n_sweep = len({s.dot_id for s in samples if s.kind == "sweep"})
    if n_sweep:
        info["sweep_windows"] = n_sweep
    result = fit_all(samples, screen, make_models())
    merge = str(getattr(cfg, "pursuit_merge", "off"))
    if pursuit and merge != "off" and any(s.kind not in ("pursuit",) for s in samples):
        base = result.models.get(result.chosen) if result.chosen else None
        geo = _geometric_of(result)
        ref = geo if geo is not None else base
        if isinstance(ref, BaseModel):
            prepped, pinfo = prepare_pursuit(pursuit, ref, screen, cfg)
            info["pursuit"] = pinfo
            if prepped:
                merged = fit_all(samples + prepped, screen, make_models())
                before, after = _chosen_score(result), _chosen_score(merged)
                pinfo["grid_heldout_deg_without"] = before
                pinfo["grid_heldout_deg_with"] = after
                use = merge == "on" or (before is not None and after is not None and after < before)
                pinfo["merged"] = bool(use)
                if use:
                    result = merged
    result.info = info
    return result


def _quick_dot_residuals(samples: list[CalibSample], screen: ScreenInfo) -> dict[int, float]:
    """Per dot, the held-out error (degrees) of a quick affine map from the dot's median eye
    feature (iris relative to the eye corners, else the optical axis: :func:`_dot_features`; the
    raw iris ray moves with the head between dots)
    to the target, fitted per head position (pose group) when
    it has at least 5 dots. Coarse, but enough to spot a dot where the person looked elsewhere."""
    ppd = _points_per_degree(samples, screen)
    per: dict[int, tuple[np.ndarray, np.ndarray, int]] = {}
    for d, idx in dict_groups(samples).items():
        feats = [_dot_features(samples[i].obs) for i in idx]
        for kind in ("corner", "gaze"):
            vals = [f[kind] for f in feats if kind in f]
            if len(vals) >= max(2, len(idx) // 2):
                per[d] = (np.median(np.array(vals, float), axis=0), np.asarray(samples[idx[0]].target, float), int(samples[idx[0]].pose_group or 0))
                break
    out: dict[int, float] = {}
    groups: dict[int, list[int]] = {}
    for d, (_, _, pg) in per.items():
        groups.setdefault(pg, []).append(d)
    if any(len(v) < 5 for v in groups.values()):
        groups = {0: list(per)}
    for ids in groups.values():
        if len(ids) < 5:
            continue
        x = np.array([[*per[d][0], 1.0] for d in ids])
        y = np.array([per[d][1] for d in ids])
        for k, d in enumerate(ids):
            tr = np.arange(len(ids)) != k
            reg = np.diag([1e-3, 1e-3, 0.0]) * len(ids)
            coef = np.linalg.solve(x[tr].T @ x[tr] + reg, x[tr].T @ y[tr])
            out[d] = float(np.linalg.norm(x[k] @ coef - y[k])) / ppd
    return out


def dict_groups(samples: list[CalibSample]) -> dict[int, list[int]]:
    groups: dict[int, list[int]] = {}
    for i, s in enumerate(samples):
        groups.setdefault(int(s.dot_id), []).append(i)
    return groups


def quality_gate(run: CalibrationRun, config: CalibrationConfig | None = None) -> list[dict[str, Any]]:
    """Dots of a grid run worth showing again, worst first, at most ``gate_max_dots``: rejected
    dots, dots whose samples scattered more than ``gate_scatter_deg``, and dots whose quick
    held-out error (:func:`_quick_dot_residuals`) is above ``gate_residual_deg`` and above twice
    the median dot. A dot already shown again is never listed ("once"). Each entry: ``dot_id``
    (the UI's id), ``x``, ``y``, ``pose_group``, ``reason``."""
    cfg = config if config is not None else CalibrationConfig()
    if run.kind != "grid" or int(getattr(cfg, "gate_max_dots", 4)) <= 0:
        return []
    retried = {d["dot_id"] for d in run.dots if d.get("retry")}
    latest: dict[int, dict[str, Any]] = {}
    for d in run.dots:
        if d.get("sweep") or d.get("replaced"):
            continue
        latest[d["dot_id"]] = d
    resid = _quick_dot_residuals([s for s in run.samples if s.kind == "grid"], run.screen)
    med = float(np.median(list(resid.values()))) if resid else 0.0
    out: list[tuple[float, dict[str, Any]]] = []
    for sid, d in latest.items():
        if sid in retried:
            continue
        pg = int(d.get("pose_group") or 0)
        entry = {"dot_id": int(sid - 1000 * pg), "x": d["target"][0], "y": d["target"][1], "pose_group": pg}
        if d.get("reason"):
            out.append((100.0, {**entry, "reason": d["reason"]}))
            continue
        sc = d.get("scatter_deg")
        if sc is not None and sc > float(getattr(cfg, "gate_scatter_deg", 1.5)):
            out.append((10.0 + sc, {**entry, "reason": f"samples scattered {sc:.1f} deg"}))
            continue
        r = resid.get(sid)
        if r is not None and r > float(getattr(cfg, "gate_residual_deg", 2.5)) and r > 2.0 * med:
            out.append((r, {**entry, "reason": f"{r:.1f} deg off the others (median {med:.1f})"}))
    out.sort(key=lambda t: -t[0])
    return [e for _, e in out[: int(getattr(cfg, "gate_max_dots", 4))]]


def pool_validation(pool: list[CalibSample], new: list[CalibSample]) -> list[CalibSample]:
    """Validation samples of all validation runs since the last full calibration, with dot ids
    made unique across runs (each run's dots are numbered from 0)."""
    from dataclasses import replace as _replace

    base = (max((int(s.dot_id) for s in pool), default=-1) // 100 + 1) * 100
    return list(pool) + [_replace(s, dot_id=base + int(s.dot_id)) for s in new]


def fit_validation_error_map(model: GazeModel, samples: list[CalibSample], screen: ScreenInfo, config: CalibrationConfig | None = None) -> dict[str, Any]:
    """Learn (or drop) the model's error map from validation dots (``calibration.error_map``):
    each dot's mean prediction (with the current correction, without any old map) against its
    target, kept only if leave-one-dot-out says it helps (:func:`~phonegaze.models.errormap.fit_error_map`).
    Returns the decision; sets ``model.error_map``."""
    from .models.errormap import fit_error_map

    cfg = config if config is not None else CalibrationConfig()
    kind = str(getattr(cfg, "error_map", "off"))
    if not isinstance(model, BaseModel) or not model.fitted:
        return {"kind": kind, "kept": False, "reason": "model not fitted"}
    if kind == "off":
        model.error_map = None
        return {"kind": kind, "kept": False, "reason": "off"}
    saved, model.error_map = model.error_map, None
    try:
        _, pred, target, _ = model.dot_predictions(samples)
    except Exception as exc:  # noqa: BLE001
        model.error_map = saved
        return {"kind": kind, "kept": False, "reason": f"failed: {exc}"}
    size = model.screen_size or (float(screen.width), float(screen.height))
    emap, info = fit_error_map(pred, target, size, kind, float(getattr(cfg, "error_map_smoothing", 1.0)), float(getattr(cfg, "error_map_min_gain", 0.05)))
    model.error_map = emap
    ppd = _points_per_degree(samples, screen)
    for k in ("loo_before_pt", "loo_after_pt"):
        if info.get(k) is not None:
            info[k.replace("_pt", "_deg")] = info[k] / ppd
    return {k: v for k, v in info.items() if not k.startswith("per_dot")}


def touchup_targets(validation: dict[str, Any], n: int = 4) -> list[Target]:
    """The ``n`` validation dots with the largest error (``validation_metrics(...)["per_dot"]``),
    as new targets for a touch-up run."""
    per = [d for d in (validation or {}).get("per_dot") or [] if d.get("error_deg") is not None or d.get("error_pt") is not None]
    per.sort(key=lambda d: -(d.get("error_deg") if d.get("error_deg") is not None else d.get("error_pt") or 0.0))
    return [Target(i, float(d["target"][0]), float(d["target"][1])) for i, d in enumerate(per[: max(1, n)])]


async def sim_head_sweep(request: Any, seconds: float, yaw_deg: float = 15.0, pitch_deg: float = 10.0, move_m: float = 0.04, rate_hz: float = 10.0) -> None:
    """Simulator only: move the simulated head through a head sweep (``request`` is the phone
    client's ``request(method, path, body)``; the simulator's ``/sim/head`` and ``/sim/scene``).
    Yaw and pitch follow slow sines, the head moves sideways and in depth, and it returns to
    where it was at the end. Failures are logged and end the sweep."""
    import asyncio

    try:
        scene = await request("GET", "/sim/scene")
        base = [float(v) for v in scene["headPositionWorld"]]
        n = max(1, int(seconds * rate_hz))
        for i in range(n):
            ph = i / max(n - 1, 1)
            pos = [base[0] + move_m * math.sin(2 * math.pi * ph * 1.5) / 2, base[1], base[2] - move_m * math.sin(2 * math.pi * ph) / 2]
            rot = [yaw_deg * math.sin(2 * math.pi * ph * 2), pitch_deg * math.sin(2 * math.pi * ph * 3 + 0.5), 0.0]
            await request("POST", "/sim/head", {"position": pos, "rotation": rot})
            await asyncio.sleep(1.0 / rate_hz)
        await request("POST", "/sim/head", {"position": base, "rotation": [0.0, 0.0, 0.0]})
    except Exception as exc:  # noqa: BLE001
        log.warning("simulated head sweep failed: %s", exc)
