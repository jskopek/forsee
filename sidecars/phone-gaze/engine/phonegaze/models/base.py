"""Shared machinery for the gaze models. Owner: Models.

- :class:`BaseModel`: options, an output :class:`Correction` (what quick refine and drift
  correction adjust), ``to_dict`` / ``from_dict``, cloning for leave-one-dot-out.
- Sample helpers: grouping by dot, screen millimetres, robust per-dot statistics.
- :func:`fit_ridge` / :func:`grouped_cv_alpha`: closed-form ridge with the regularisation chosen
  by leave-one-dot-out cross-validation.

Units: model outputs are screen points; geometry is millimetres on the screen.
"""

from __future__ import annotations

import math
import time
from typing import Any, Callable

import numpy as np

from ..types import CalibSample, FitReport, GazePoint, Observation, ScreenInfo

DEFAULT_MM_PER_POINT = 0.2
"""Fallback when macOS did not report the screen's physical size (a 14-inch MacBook Pro is
about 0.2 mm per point). Reports say when it was used."""

DEFAULT_DISTANCE_M = 0.6
"""Viewing distance assumed for degree conversions only when nothing measured one."""


def mm_per_point(screen: ScreenInfo) -> tuple[float, float, bool]:
    """``(mm_x, mm_y, measured)``; falls back to :data:`DEFAULT_MM_PER_POINT`."""
    mpp = screen.mm_per_point
    if mpp is None or not all(math.isfinite(v) and v > 0 for v in mpp):
        return DEFAULT_MM_PER_POINT, DEFAULT_MM_PER_POINT, False
    return float(mpp[0]), float(mpp[1]), True


def fit_samples(samples: list[CalibSample]) -> list[CalibSample]:
    """Samples a model may fit on (never validation samples)."""
    return [s for s in samples if s.kind != "validate"]


def dot_groups(samples: list[CalibSample]) -> dict[int, list[int]]:
    """dot_id -> indices into ``samples``, in first-seen order."""
    groups: dict[int, list[int]] = {}
    for i, s in enumerate(samples):
        groups.setdefault(int(s.dot_id), []).append(i)
    return groups


def sample_weights(samples: list[CalibSample]) -> np.ndarray:
    """Equal total weight per dot (so a dot with many samples does not dominate); pursuit
    windows count half."""
    groups = dot_groups(samples)
    w = np.zeros(len(samples))
    for idx in groups.values():
        k = 0.5 if samples[idx[0]].kind == "pursuit" else 1.0
        w[idx] = k / len(idx)
    return w


def subsample_per_dot(samples: list[CalibSample], per_dot: int) -> list[CalibSample]:
    """At most ``per_dot`` evenly spaced samples of each dot (keeps fitting fast)."""
    out: list[CalibSample] = []
    for idx in dot_groups(samples).values():
        if len(idx) <= per_dot:
            out.extend(samples[i] for i in idx)
        else:
            pick = np.linspace(0, len(idx) - 1, per_dot).round().astype(int)
            out.extend(samples[idx[i]] for i in pick)
    return out


# ---------------------------------------------------------------------------------------------
# Output correction (quick refine, drift)
# ---------------------------------------------------------------------------------------------


class Correction:
    """An affine map applied to a model's output, in screen points: ``p' = A @ p + b``.

    Identity by default. Quick refine sets an offset (1 dot) or an affine (3+ dots); drift
    correction nudges the offset.
    """

    def __init__(self, a: np.ndarray | None = None, b: np.ndarray | None = None) -> None:
        self.a = np.eye(2) if a is None else np.asarray(a, float).reshape(2, 2)
        self.b = np.zeros(2) if b is None else np.asarray(b, float).reshape(2)

    @property
    def is_identity(self) -> bool:
        return bool(np.allclose(self.a, np.eye(2)) and np.allclose(self.b, 0))

    def apply(self, x: float, y: float) -> tuple[float, float]:
        p = self.a @ np.array([x, y]) + self.b
        return float(p[0]), float(p[1])

    def apply_many(self, pts: np.ndarray) -> np.ndarray:
        return pts @ self.a.T + self.b

    def then(self, other: Correction) -> Correction:
        """``other`` applied after ``self``."""
        return Correction(other.a @ self.a, other.a @ self.b + other.b)

    def to_dict(self) -> dict[str, Any]:
        return {"a": self.a.tolist(), "b": self.b.tolist()}

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Correction:
        if not data:
            return cls()
        return cls(np.array(data["a"], float), np.array(data["b"], float))


def fit_correction(pred: np.ndarray, target: np.ndarray, groups: list[int], screen: ScreenInfo, affine: bool) -> Correction:
    """Correction mapping ``pred`` onto ``target`` (both ``N x 2`` points).

    ``affine=False`` (or fewer than 3 distinct dots): offset only, the median of per-dot mean
    differences. Otherwise an affine fit on per-dot means, ridge-regularised towards the identity
    so that three nearly collinear dots cannot shear the screen.
    """
    g = np.asarray(groups)
    ids = list(dict.fromkeys(groups))
    pm = np.array([np.median(pred[g == d], axis=0) for d in ids])
    tm = np.array([np.median(target[g == d], axis=0) for d in ids])
    if not affine or len(ids) < 3:
        return Correction(b=np.median(tm - pm, axis=0))
    # Solve for A, b minimising |A pm + b - tm|^2 + lam |A - I|^2 (in units of the screen size).
    scale = max(screen.width, screen.height)
    p = (pm - np.array([screen.width, screen.height]) / 2) / scale
    t = (tm - np.array([screen.width, screen.height]) / 2) / scale
    x = np.hstack([p, np.ones((len(p), 1))])
    lam = 0.05 if len(ids) >= 4 else 0.2
    reg = np.diag([lam, lam, 0.0])
    prior = np.vstack([np.eye(2), np.zeros((1, 2))])
    m = np.linalg.solve(x.T @ x + reg, x.T @ t + reg @ prior)  # 3 x 2
    a = m[:2].T
    c = np.array([screen.width, screen.height]) / 2
    b = m[2] * scale + c - a @ c
    return Correction(a, b)


# ---------------------------------------------------------------------------------------------
# Base model
# ---------------------------------------------------------------------------------------------


class BaseModel:
    """Common behaviour. Subclasses define ``name``, ``_fit``, ``_predict_raw`` and
    ``_state`` / ``_load_state``. Options are plain JSON values passed to ``__init__``."""

    name = "base"

    def __init__(self, **options: Any) -> None:
        self.options: dict[str, Any] = dict(options)
        self.correction = Correction()
        self.fitted = False
        self.report: FitReport | None = None
        self.mm_per_point: tuple[float, float] = (DEFAULT_MM_PER_POINT, DEFAULT_MM_PER_POINT)
        self.screen_size: tuple[float, float] | None = None
        self._live = False

    # --- GazeModel protocol --------------------------------------------------------------

    def fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        t0 = time.perf_counter()
        samples = fit_samples(samples)
        mx, my, measured = mm_per_point(screen)
        self.mm_per_point = (mx, my)
        self.screen_size = (float(screen.width), float(screen.height))
        self.correction = Correction()
        try:
            report = self._fit(samples, screen)
        except Exception as exc:  # noqa: BLE001 - a failed fit is a report, not a crash
            self.fitted = False
            report = FitReport(model=self.name, ok=False, n_samples=len(samples), n_dots=len(dot_groups(samples)), message=f"fit failed: {exc}")
        if report.ok and not measured:
            report.message = (report.message + " " if report.message else "") + "Screen size unknown; assumed 0.2 mm per point."
        report.fit_seconds = time.perf_counter() - t0
        self.report = report
        return report

    def predict(self, obs: Observation) -> GazePoint | None:
        if not self.fitted:
            return None
        self._live = True
        try:
            point = self._predict_raw(obs)
        finally:
            self._live = False
        if point is None:
            return None
        corr = self.correction
        if not corr.is_identity:
            point.x, point.y = corr.apply(point.x, point.y)
            if point.left is not None:
                point.left = corr.apply(*point.left)
            if point.right is not None:
                point.right = corr.apply(*point.right)
        point.model = self.name
        return point

    def predict_raw(self, obs: Observation) -> GazePoint | None:
        """Prediction without the output correction and without any temporal state (models
        that smooth over time, like the geometric model's eyeball centres, do so only in
        :meth:`predict`, the live path; ``self._live`` tells ``_predict_raw`` which)."""
        return self._predict_raw(obs) if self.fitted else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.name,
            "options": dict(self.options),
            "fitted": self.fitted,
            "correction": self.correction.to_dict(),
            "mm_per_point": list(self.mm_per_point),
            "screen_size": list(self.screen_size) if self.screen_size else None,
            "state": self._state() if self.fitted else None,
            "report": self.report.to_dict() if self.report else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BaseModel:
        model = cls(**(data.get("options") or {}))
        model.correction = Correction.from_dict(data.get("correction"))
        model.mm_per_point = tuple(data.get("mm_per_point") or (DEFAULT_MM_PER_POINT, DEFAULT_MM_PER_POINT))  # type: ignore[assignment]
        size = data.get("screen_size")
        model.screen_size = (float(size[0]), float(size[1])) if size else None
        if data.get("report"):
            model.report = FitReport.from_dict(data["report"])
        if data.get("fitted") and data.get("state") is not None:
            model._load_state(data["state"])
            model.fitted = True
        return model

    def clone(self) -> BaseModel:
        """A fresh, unfitted model with the same options."""
        return type(self)(**self.options)

    def dot_predictions(self, samples: list[CalibSample]) -> tuple[list[int], np.ndarray, np.ndarray, np.ndarray]:
        """Per dot: ``(dot_ids, mean prediction WITH the correction (D x 2, NaN if none),
        target (D x 2), distance in metres (D))``. Deterministic (no live state), so quick
        refine and drift correction see the same numbers every time. Default: the median of
        the raw per-sample predictions; the geometric model averages its inputs instead."""
        raw = self.predict_samples(samples, raw=True)
        ids: list[int] = []
        pred, target, dist = [], [], []
        for dot, idx in dot_groups(samples).items():
            ids.append(dot)
            r = raw[idx]
            ok = np.all(np.isfinite(r), axis=1)
            pred.append(np.median(r[ok], axis=0) if ok.any() else np.full(2, np.nan))
            target.append(samples[idx[0]].target)
            d = [samples[i].obs.distance for i in idx if samples[i].obs.distance]
            dist.append(float(np.median(d)) if d else np.nan)
        p = np.array(pred, float).reshape(-1, 2)
        good = np.all(np.isfinite(p), axis=1)
        if good.any():
            p[good] = self.correction.apply_many(p[good])
        return ids, p, np.array(target, float).reshape(-1, 2), np.array(dist, float)

    def _dot_errors(self, samples: list[CalibSample], screen: ScreenInfo) -> tuple[float | None, float | None]:
        """Mean error of the dots' mean predictions: ``(points, degrees)``."""
        _, p, t, dist = self.dot_predictions(samples)
        ok = np.all(np.isfinite(p), axis=1)
        if not ok.any():
            return None, None
        mx, my, _ = mm_per_point(screen)
        d = self.degree_distance()
        dd = np.full(len(p), d) if d else dist
        e_pt = np.linalg.norm(p - t, axis=1)
        e_deg = np.degrees(np.arctan2(np.linalg.norm((p - t) * [mx, my], axis=1), dd * 1000.0))
        deg = e_deg[ok & np.isfinite(e_deg)]
        return float(np.mean(e_pt[ok])), (float(np.mean(deg)) if len(deg) else None)

    def refine(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        """Quick refine (ARCHITECTURE.md): 1-2 dots correct an offset; 3 or more re-solve the
        screen pose (models that have one, see ``refine_pose``) or fit an affine correction,
        keeping everything learned about the person. Composes with any earlier correction.
        Works on each dot's mean prediction (:meth:`dot_predictions`)."""
        samples = fit_samples(samples)
        if not samples or not self.fitted:
            return FitReport(model=self.name, ok=False, message="no refine samples" if samples else "the model is not fitted")
        n_dots = len(dot_groups(samples))
        before_pt, before_deg = self._dot_errors(samples, screen)
        refine_pose = getattr(self, "refine_pose", None)
        if n_dots >= 3 and refine_pose is not None and refine_pose(samples, screen):
            self.correction = Correction()
            method = "screen_pose"
        else:
            ids, pred, target, _ = self.dot_predictions(samples)
            ok = np.all(np.isfinite(pred), axis=1)
            if not ok.any():
                return FitReport(model=self.name, ok=False, n_samples=len(samples), n_dots=n_dots, message="the model predicted nothing on the refine samples")
            corr = fit_correction(pred[ok], target[ok], [i for i, k in zip(ids, ok) if k], screen, affine=int(ok.sum()) >= 3)
            self.correction = self.correction.then(corr)
            method = "affine" if int(ok.sum()) >= 3 else "offset"
        after_pt, after_deg = self._dot_errors(samples, screen)
        return FitReport(
            model=self.name,
            ok=True,
            n_samples=len(samples),
            n_dots=n_dots,
            train_error_deg=after_deg,
            train_error_pt=after_pt,
            params={"method": method, "before_error_deg": before_deg, "before_error_pt": before_pt, "correction": self.correction.to_dict()},
            message=f"quick refine ({method}) on {n_dots} dot(s)",
        )

    def degree_distance(self) -> float | None:
        """Eye-to-screen distance to convert errors to degrees (``None``: use each
        observation's distance)."""
        return None

    # --- for subclasses ---------------------------------------------------------------------

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        raise NotImplementedError

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        raise NotImplementedError

    def _state(self) -> dict[str, Any]:
        raise NotImplementedError

    def _load_state(self, state: dict[str, Any]) -> None:
        raise NotImplementedError

    # --- helpers ------------------------------------------------------------------------------

    def predict_samples(self, samples: list[CalibSample], raw: bool = False) -> np.ndarray:
        """``N x 2`` predictions (NaN where the model had nothing to say)."""
        out = np.full((len(samples), 2), np.nan)
        fn: Callable[[Observation], GazePoint | None] = self.predict_raw if raw else self.predict
        for i, s in enumerate(samples):
            p = fn(s.obs)
            if p is not None and p.valid:
                out[i] = (p.x, p.y)
        return out


def report_from_predictions(name: str, samples: list[CalibSample], pred: np.ndarray, screen: ScreenInfo, distance_m: float | None, **extra: Any) -> FitReport:
    """A ``FitReport`` with train errors and per-dot details from ``N x 2`` predictions."""
    stats = error_stats(samples, pred, screen, distance_m)
    groups = dot_groups(samples)
    return FitReport(
        model=name,
        ok=True,
        n_samples=len(samples),
        n_dots=len(groups),
        train_error_deg=stats["error_of_mean_deg"],
        train_error_pt=stats["error_of_mean_pt"],
        precision_deg=stats["precision_deg"],
        per_dot=stats["per_dot"],
        **extra,
    )


def error_stats(samples: list[CalibSample], pred: np.ndarray, screen: ScreenInfo, distance_m: float | None) -> dict[str, Any]:
    """Mean error (points and degrees), RMS sample-to-sample precision, per-dot details."""
    mx, my, _ = mm_per_point(screen)
    target = np.array([s.target for s in samples], float) if samples else np.zeros((0, 2))
    ok = np.all(np.isfinite(pred), axis=1) if len(pred) else np.zeros(0, bool)
    dist = np.array([_distance(s.obs, distance_m) for s in samples], float) if samples else np.zeros(0)
    err_pt = np.linalg.norm(pred - target, axis=1)
    diff_mm = (pred - target) * np.array([mx, my])
    err_deg = np.degrees(np.arctan2(np.linalg.norm(diff_mm, axis=1), dist * 1000.0))
    per_dot = []
    s2s_mm: list[float] = []
    s2s_d: list[float] = []
    for dot, idx in dot_groups(samples).items():
        idx = [i for i in idx if ok[i]]
        if not idx:
            per_dot.append({"dot_id": dot, "target": list(samples[dot_groups(samples)[dot][0]].target), "mean": None, "error_deg": None, "error_pt": None, "n": 0})
            continue
        mean = pred[idx].mean(axis=0)
        e_mm = np.linalg.norm((mean - target[idx[0]]) * np.array([mx, my]))
        d = float(np.nanmean(dist[idx]))
        per_dot.append(
            {
                "dot_id": dot,
                "target": [float(v) for v in target[idx[0]]],
                "mean": [float(v) for v in mean],
                "error_deg": float(np.degrees(np.arctan2(e_mm, d * 1000.0))) if math.isfinite(d) else None,
                "error_pt": float(np.linalg.norm(mean - target[idx[0]])),
                "n": len(idx),
                "pose_group": samples[idx[0]].pose_group,
            }
        )
        if len(idx) > 1:
            steps = np.diff(pred[idx], axis=0) * np.array([mx, my])
            s2s_mm.extend(np.linalg.norm(steps, axis=1).tolist())
            s2s_d.extend([d] * len(steps))
    n_ok = int(ok.sum())
    e_deg = err_deg[ok & np.isfinite(err_deg)]
    precision = None
    if s2s_mm:
        ang = np.degrees(np.arctan2(np.array(s2s_mm), np.array(s2s_d) * 1000.0))
        ang = ang[np.isfinite(ang)]
        precision = float(np.sqrt(np.mean(ang**2))) if len(ang) else None
    dot_deg = [d["error_deg"] for d in per_dot if d.get("error_deg") is not None]
    dot_pt = [d["error_pt"] for d in per_dot if d.get("error_pt") is not None]
    return {
        "error_of_mean_deg": float(np.mean(dot_deg)) if dot_deg else None,
        "error_of_mean_pt": float(np.mean(dot_pt)) if dot_pt else None,
        "error_pt": float(np.mean(err_pt[ok])) if n_ok else None,
        "error_deg": float(np.mean(e_deg)) if len(e_deg) else None,
        "precision_deg": precision,
        "per_dot": per_dot,
        "n": len(samples),
        "n_valid": n_ok,
    }


def _distance(obs: Observation, distance_m: float | None) -> float:
    if distance_m:
        return float(distance_m)
    if obs.distance:
        return float(obs.distance)
    return float("nan")


def loo_predictions(model: BaseModel, samples: list[CalibSample], screen: ScreenInfo) -> np.ndarray:
    """Leave-one-dot-out predictions (``N x 2``, raw, NaN where unavailable): for each dot, a
    fresh clone fitted on the other dots predicts that dot's samples."""
    samples = fit_samples(samples)
    out = np.full((len(samples), 2), np.nan)
    groups = dot_groups(samples)
    for dot, idx in groups.items():
        train = [s for s in samples if s.dot_id != dot]
        if len(dot_groups(train)) < 3:
            continue
        m = model.clone()
        warm = getattr(m, "warm_start", None)
        if warm is not None:
            warm(model)
        rep = m.fit(train, screen)
        if rep.ok:
            out[idx] = m.predict_samples([samples[i] for i in idx], raw=True)
    return out


def pose_groups(samples: list[CalibSample]) -> list[int]:
    """The distinct head-position rounds (``pose_group``) present in ``samples``."""
    return sorted({int(s.pose_group or 0) for s in samples})


def lopo_predictions(model: BaseModel, samples: list[CalibSample], screen: ScreenInfo) -> np.ndarray:
    """Leave-one-POSE-out predictions (``N x 2``, raw, NaN where unavailable): for each head
    position, a fresh clone fitted on the OTHER head positions predicts its samples. This is
    what tells a model that generalises to a new head position from one that only interpolates
    between the positions it saw. No warm start: each fold chooses its own hyperparameters."""
    samples = fit_samples(samples)
    out = np.full((len(samples), 2), np.nan)
    pg = np.array([int(s.pose_group or 0) for s in samples])
    for g in np.unique(pg):
        train = [s for s, p in zip(samples, pg) if p != g]
        if len(dot_groups(train)) < 3:
            continue
        m = model.clone()
        try:
            rep = m.fit(train, screen)
        except Exception:  # noqa: BLE001 - a fold that cannot be fitted simply has no score
            continue
        if rep.ok:
            idx = np.flatnonzero(pg == g)
            out[idx] = m.predict_samples([samples[i] for i in idx], raw=True)
    return out


# ---------------------------------------------------------------------------------------------
# Ridge
# ---------------------------------------------------------------------------------------------


def fit_ridge(x: np.ndarray, y: np.ndarray, alpha: float, w: np.ndarray | None = None) -> np.ndarray:
    """Weighted ridge with an unpenalised intercept (last column of the result's rows).
    ``x``: N x D (already standardised), ``y``: N x K. Returns (D+1) x K."""
    n, d = x.shape
    xa = np.hstack([x, np.ones((n, 1))])
    ww = np.ones(n) if w is None else w
    xtw = xa.T * ww
    reg = alpha * np.eye(d + 1)
    reg[-1, -1] = 0.0
    return np.linalg.solve(xtw @ xa + reg + 1e-9 * np.eye(d + 1), xtw @ y)


def ridge_predict(x: np.ndarray, coef: np.ndarray) -> np.ndarray:
    return np.hstack([x, np.ones((len(x), 1))]) @ coef


ALPHAS = (1e-3, 1e-2, 0.1, 1.0, 10.0, 100.0, 1000.0)


def grouped_cv_alpha(x: np.ndarray, y: np.ndarray, groups: np.ndarray, w: np.ndarray, alphas: tuple[float, ...] = ALPHAS) -> tuple[float, dict[float, float]]:
    """Choose ``alpha`` by leave-one-group-out mean error (Euclidean, in ``y`` units)."""
    ids = np.unique(groups)
    scores: dict[float, float] = {}
    if len(ids) < 3:
        return float(alphas[len(alphas) // 2]), scores
    for a in alphas:
        errs = []
        for g in ids:
            tr, te = groups != g, groups == g
            coef = fit_ridge(x[tr], y[tr], a, w[tr])
            e = np.linalg.norm(ridge_predict(x[te], coef) - y[te], axis=1)
            errs.append(float(np.mean(e)))
        scores[a] = float(np.mean(errs))
    best = min(scores, key=lambda k: scores[k])
    return float(best), scores
