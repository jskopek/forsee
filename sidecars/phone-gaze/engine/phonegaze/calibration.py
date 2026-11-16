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
- **Drift** (:func:`refine` with ``kind="drift"`` samples, :func:`drift_correct`): small,
  capped offset updates from known look-points; ignores look-points far from the prediction.

What is learned is saved by :class:`Profile` in three layers.

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
from .models.base import BaseModel, Correction, error_stats, fit_samples, lopo_predictions, loo_predictions, mm_per_point, pose_groups
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


def config_targets(config: CalibrationConfig, screen: ScreenInfo, kind: str, seed: int = 0) -> list[Target]:
    """Targets for a run of ``kind`` using the configured grid / refine / validate counts."""
    if kind == "grid":
        return grid_targets(screen, config.grid, config.margin)
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
        return [], "no usable eye measurements (blinks or tracking lost)"
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
            return [], f"only {most} usable samples (need {min_samples})"
        return [], f"too few samples left after removing outliers (need {min_samples})"
    score, kept, spread = best
    if score > 1.0:
        return [], f"gaze not steady (spread {spread:.1f} deg)"
    return kept, ""


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
        kept, reason = clean_dot(pending, self.outlier_mad, self.min_samples, self.max_spread_deg)
        pg = cur["pose_group"]
        sid = cur["dot_id"] + 1000 * pg if self.kind in ("grid", "validate", "refine") else cur["dot_id"]
        info = {"dot_id": sid, "target": [cur["x"], cur["y"]], "pose_group": pg, "n_raw": len(pending), "n_kept": len(kept), "reason": reason}
        self.dots.append(info)
        if reason:
            self.rejected.append(info)
            return
        kind = self.kind if self.kind in ("grid", "pursuit", "refine", "validate") else "grid"
        for o in kept:
            self.samples.append(CalibSample(target=(cur["x"], cur["y"]), obs=o, kind=kind, dot_id=sid, run_id=self.run_id, pose_group=pg, t_local=o.t_local))

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
    for name, rep in reports.items():
        if not rep.ok:
            continue
        model = fitted[name]
        if isinstance(model, BaseModel):
            tr = error_stats(train, model.predict_samples(train, raw=True), screen, dist)
            rep.train_error_deg, rep.train_error_pt, rep.precision_deg, rep.per_dot = tr["error_of_mean_deg"], tr["error_of_mean_pt"], tr["precision_deg"], tr["per_dot"]
        if name in loo:
            st = error_stats(train, loo[name], screen, dist)
            rep.loo_error_deg, rep.loo_error_pt = st["error_of_mean_deg"], st["error_of_mean_pt"]
            coverage = st["n_valid"] / max(st["n"], 1)
            rep.params = {**rep.params, "loo_coverage": coverage, "loo_sample_error_deg": st["error_deg"]}
            score_deg, score_pt = rep.loo_error_deg, rep.loo_error_pt
            if name in lopo:
                sp = error_stats(train, lopo[name], screen, dist)
                lp_cov = sp["n_valid"] / max(sp["n"], 1)
                rep.params = {**rep.params, "lopo_error_deg": sp["error_of_mean_deg"], "lopo_error_pt": sp["error_of_mean_pt"], "lopo_coverage": lp_cov}
                if sp["error_of_mean_deg"] is not None and score_deg is not None:
                    score_deg = max(score_deg, sp["error_of_mean_deg"])
                if sp["error_of_mean_pt"] is not None and score_pt is not None:
                    score_pt = max(score_pt, sp["error_of_mean_pt"])
                coverage = min(coverage, lp_cov)
                rep.params["loo_coverage"] = coverage
            rep.params = {**rep.params, "selection_error_deg": score_deg, "selection_error_pt": score_pt}
            if coverage < MIN_LOO_COVERAGE:
                rep.message = (rep.message + " " if rep.message else "") + f"Predicted only {coverage:.0%} of held-out samples; not eligible for automatic choice."
    chosen = choose(list(reports.values()), multi_pose=multi_pose)
    if chosen is not None and not multi_pose:
        rep = reports[chosen]
        rep.message = (rep.message + " " if rep.message else "") + "Calibrated from one head position: how well it copes with head movement was not tested (repeat the grid from more head positions to test it)."
    return CalibrationResult(reports=[reports[m.name] for m in models if m.name in reports], chosen=chosen, models={k: v for k, v in fitted.items()})


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
            m.params = np.concatenate([np.asarray(setup["geometric"]["params"], float), np.asarray(person["geometric"]["params"], float)])
            m.viewing_distance_m = setup["geometric"].get("viewing_distance_m")
            scr = ScreenInfo.from_dict(setup["screen"]) if setup.get("screen") else None
            if scr is not None:
                mx, my, _ = mm_per_point(scr)
                m.mm_per_point = (mx, my)
                m.screen_size = (scr.width, scr.height)
            m.fitted = True
            return CalibrationResult(reports=[FitReport(model="geometric", ok=True, message="rebuilt from the saved person and setup")], chosen="geometric", models={"geometric": m})
        return None
