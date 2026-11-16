"""Combinations of models. Owner: Models.

- ``ResidualModel`` (registry ``residual``): a base model (geometric by default) plus a small
  ridge correction of what it gets wrong, learned from the base prediction and head pose
  (research note 01, "what to build" 5). The correction is kept only if leave-one-dot-out says
  it helps by at least 3 %; otherwise the model is exactly its base, and the report says so.
- ``BlendModel`` (registry ``blend``): a weighted average of member models, each weighted by
  ``1 / error^2`` with its leave-one-dot-out error. Members that have nothing to say for a frame
  (no reflection, say) drop out and the rest are renormalised.

``calibration.fit_all`` hands the blend its already-fitted members and their leave-one-dot-out
predictions (``fit_from_members``) so nothing is fitted twice; ``fit`` alone does it all itself.
"""

from __future__ import annotations

import copy
from typing import Any

import numpy as np

from ..types import CalibSample, FitReport, GazePoint, Observation, ScreenInfo
from . import features as F
from .base import BaseModel, dot_groups, fit_ridge, fit_samples, grouped_cv_alpha, loo_predictions, report_from_predictions, ridge_predict


BLEND_OUTLIER_FRACTION = 0.08
"""A blend member further than this fraction of the screen diagonal from the members' weighted
median is left out of that frame's average."""


def _registry() -> dict[str, type]:
    from . import REGISTRY

    return REGISTRY


class ResidualModel(BaseModel):
    """Base model + learned residual. Registry name ``residual``."""

    name = "residual"

    def __init__(self, base: str = "geometric", base_options: dict[str, Any] | None = None, min_gain: float = 0.03, **options: Any) -> None:
        super().__init__(base=base, base_options=dict(base_options or {}), min_gain=min_gain, **options)
        self.base: BaseModel | None = None
        self.coef: np.ndarray | None = None
        self.x_mean: np.ndarray | None = None
        self.x_std: np.ndarray | None = None

    def warm_start(self, other: BaseModel) -> None:
        if isinstance(other, ResidualModel) and other.base is not None:
            self.base = other.base.clone()
            warm = getattr(self.base, "warm_start", None)
            if warm is not None:
                warm(other.base)

    def _rows(self, preds: np.ndarray, observations: list[Observation]) -> np.ndarray:
        assert self.screen_size is not None
        w, h = self.screen_size
        px = (preds[:, 0] / w - 0.5)[:, None]
        py = (preds[:, 1] / h - 0.5)[:, None]
        head = np.array([F.head_row(o) for o in observations]).reshape(len(observations), len(F.HEAD_COLUMNS))
        return np.hstack([px, py, px * px, py * py, px * py, head])

    def _standardise(self, x: np.ndarray, fit: bool) -> np.ndarray:
        if fit:
            self.x_mean = np.nanmean(x, axis=0)
            self.x_mean = np.where(np.isfinite(self.x_mean), self.x_mean, 0.0)
            std = np.nanstd(x, axis=0)
            floor = np.array([1e-3] * 5 + [0.05] * 5 + [0.3])
            self.x_std = np.maximum(np.where(np.isfinite(std), std, 0.0), floor)
        assert self.x_mean is not None and self.x_std is not None
        z = (x - self.x_mean) / self.x_std
        return np.where(np.isfinite(z), z, 0.0)

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        if self.base is None:
            cls = _registry()[self.options["base"]]
            self.base = cls(**self.options["base_options"])
        rep = self.base.fit(samples, screen)
        if not rep.ok:
            raise ValueError(f"base model {self.base.name} failed: {rep.message}")
        pred = self.base.predict_samples(samples, raw=True)
        ok = np.all(np.isfinite(pred), axis=1)
        # One row per dot: mean base prediction, mean head features, mean target error. Per-frame
        # jitter is the filters' business; the residual should learn only systematic error.
        dots = np.array([s.dot_id for s in samples])
        rows, ys, ws = [], [], []
        for d in dict.fromkeys(dots[ok].tolist()):
            m = ok & (dots == d)
            idx = np.flatnonzero(m)
            x_d = self._rows(pred[m], [samples[i].obs for i in idx])
            rows.append(np.nanmean(x_d, axis=0) if np.isfinite(x_d).any() else x_d[0])
            ys.append(np.mean(np.array([samples[i].target for i in idx], float) - pred[m], axis=0))
            ws.append(0.5 if samples[idx[0]].kind == "pursuit" else 1.0)
        msg = ""
        self.coef = None
        if len(rows) >= 5:
            x = self._standardise(np.array(rows), fit=True)
            y = np.array(ys)
            g = np.arange(len(rows))
            w = np.array(ws)
            alpha, scores = grouped_cv_alpha(x, y, g, w, alphas=(1.0, 3.0, 10.0, 30.0, 100.0, 1000.0))
            base_err = float(np.mean(np.linalg.norm(y, axis=1)))
            if scores and scores[alpha] < (1.0 - float(self.options["min_gain"])) * base_err:
                self.coef = fit_ridge(x, y, alpha, w)
                msg = f"residual kept: cross-validated dot error {scores[alpha]:.1f} pt vs {base_err:.1f} pt for {self.base.name} alone"
            else:
                msg = f"residual dropped (did not help in cross-validation); this is {self.base.name} alone"
        else:
            msg = "too few dots for a residual; this is the base model alone"
        self.fitted = True
        out = self.predict_samples(samples, raw=True)
        params = {"base": self.base.name, "residual": self.coef is not None}
        if hasattr(self.base, "summary"):
            params["base_params"] = self.base.summary()  # type: ignore[attr-defined]
        return report_from_predictions(self.name, samples, out, screen, self.base.degree_distance(), params=params, message=msg)

    def degree_distance(self) -> float | None:
        return None if self.base is None else self.base.degree_distance()

    def refine_pose(self, samples: list[CalibSample], screen: ScreenInfo) -> bool:
        fn = getattr(self.base, "refine_pose", None)
        return bool(fn(samples, screen)) if fn is not None else False

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        if self.base is None:
            return None
        p = self.base.predict(obs) if self._live else self.base.predict_raw(obs)
        if p is None or self.coef is None:
            return p
        x = self._standardise(self._rows(np.array([[p.x, p.y]]), [obs]), fit=False)
        d = ridge_predict(x, self.coef)[0]
        p.x, p.y = p.x + float(d[0]), p.y + float(d[1])
        p.left = None if p.left is None else (p.left[0] + float(d[0]), p.left[1] + float(d[1]))
        p.right = None if p.right is None else (p.right[0] + float(d[0]), p.right[1] + float(d[1]))
        return p

    def _state(self) -> dict[str, Any]:
        assert self.base is not None
        return {
            "base": self.base.to_dict(),
            "coef": None if self.coef is None else self.coef.tolist(),
            "x_mean": None if self.x_mean is None else self.x_mean.tolist(),
            "x_std": None if self.x_std is None else self.x_std.tolist(),
        }

    def _load_state(self, state: dict[str, Any]) -> None:
        from . import load_model

        self.base = load_model(state["base"])  # type: ignore[assignment]
        self.coef = None if state.get("coef") is None else np.array(state["coef"], float)
        self.x_mean = None if state.get("x_mean") is None else np.array(state["x_mean"], float)
        self.x_std = None if state.get("x_std") is None else np.array(state["x_std"], float)


class BlendModel(BaseModel):
    """Inverse-variance blend of member models. Registry name ``blend``."""

    name = "blend"

    def __init__(self, members: list[str] | None = None, **options: Any) -> None:
        super().__init__(members=list(members or ["geometric", "ridge", "kernel", "reflection"]), **options)
        self.members: dict[str, BaseModel] = {}
        self.weights: dict[str, float] = {}

    @staticmethod
    def _weights(loo: dict[str, np.ndarray], samples: list[CalibSample], exclude: int | None = None) -> dict[str, float]:
        target = np.array([s.target for s in samples], float)
        dots = np.array([s.dot_id for s in samples])
        mask = dots != exclude if exclude is not None else np.ones(len(samples), bool)
        out: dict[str, float] = {}
        for name, pred in loo.items():
            ok = mask & np.all(np.isfinite(pred), axis=1)
            if ok.sum() < 3 or ok.sum() < 0.5 * mask.sum():
                continue
            per_dot = [np.mean(np.linalg.norm(pred[ok & (dots == d)] - target[ok & (dots == d)], axis=1)) for d in np.unique(dots[ok])]
            err = float(np.mean(per_dot))
            out[name] = 1.0 / max(err, 1.0) ** 2
        total = sum(out.values())
        return {k: v / total for k, v in out.items()} if total > 0 else {}

    @staticmethod
    def _combine(preds: dict[str, np.ndarray], weights: dict[str, float]) -> np.ndarray:
        n = len(next(iter(preds.values()))) if preds else 0
        num = np.zeros((n, 2))
        den = np.zeros(n)
        for name, w in weights.items():
            p = preds.get(name)
            if p is None:
                continue
            ok = np.all(np.isfinite(p), axis=1)
            num[ok] += w * p[ok]
            den[ok] += w
        out = np.full((n, 2), np.nan)
        good = den > 0
        out[good] = num[good] / den[good, None]
        return out

    def fit_from_members(self, members: dict[str, BaseModel], loo: dict[str, np.ndarray], samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        """Fit from members fitted elsewhere and their leave-one-dot-out predictions (aligned
        with ``fit_samples(samples)``). Members are deep-copied so later refines of the
        originals do not change the blend."""
        from .base import mm_per_point

        samples = fit_samples(samples)
        mx, my, _ = mm_per_point(screen)
        self.mm_per_point = (mx, my)
        self.screen_size = (float(screen.width), float(screen.height))
        wanted = [m for m in self.options["members"] if m in members and m in loo and members[m].fitted]
        self.weights = self._weights({m: loo[m] for m in wanted}, samples)
        if len(self.weights) < 1:
            self.fitted = False
            self.report = FitReport(model=self.name, ok=False, n_samples=len(samples), message="no fitted members to blend")
            return self.report
        self.members = {m: copy.deepcopy(members[m]) for m in self.weights}
        for m in self.members.values():
            m.correction = type(m.correction)()
        self.fitted = True
        pred = self.predict_samples(samples, raw=True)
        dist = next((m.degree_distance() for m in self.members.values() if m.degree_distance()), None)
        self.report = report_from_predictions(self.name, samples, pred, screen, dist, params={"weights": self.weights})
        return self.report

    def loo_from_members(self, loo: dict[str, np.ndarray], samples: list[CalibSample]) -> np.ndarray:
        """Leave-one-dot-out predictions of the blend itself, from the members' (weights are
        recomputed without the held-out dot, so the score is honest)."""
        samples = fit_samples(samples)
        wanted = {m: loo[m] for m in self.options["members"] if m in loo}
        out = np.full((len(samples), 2), np.nan)
        dots = np.array([s.dot_id for s in samples])
        for d in np.unique(dots):
            w = self._weights(wanted, samples, exclude=int(d))
            if not w:
                continue
            idx = dots == d
            out[idx] = self._combine({k: v[idx] for k, v in wanted.items()}, w)
        return out

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        reg = _registry()
        members: dict[str, BaseModel] = {}
        loo: dict[str, np.ndarray] = {}
        for name in self.options["members"]:
            if name in ("blend",) or name not in reg:
                continue
            m = reg[name]()
            if m.fit(samples, screen).ok:
                members[name] = m
                loo[name] = loo_predictions(m, samples, screen)
        return self.fit_from_members(members, loo, samples, screen)

    def degree_distance(self) -> float | None:
        return next((m.degree_distance() for m in self.members.values() if m.degree_distance()), None)

    def refine(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        """Re-solve members' screen poses first (when 3+ dots), then the blend's own
        correction."""
        if len(dot_groups(fit_samples(samples))) >= 3:
            for m in self.members.values():
                fn = getattr(m, "refine_pose", None)
                if fn is not None:
                    fn(samples, screen)
        return super().refine(samples, screen)

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        pts = {}
        for name, m in self.members.items():
            p = m.predict(obs) if self._live else m.predict_raw(obs)
            if p is not None and p.valid:
                pts[name] = p
        if not pts:
            return None
        pts = self._drop_outliers(pts)
        total = sum(self.weights[n] for n in pts)
        x = sum(self.weights[n] * p.x for n, p in pts.items()) / total
        y = sum(self.weights[n] * p.y for n, p in pts.items()) / total
        conf = sum(self.weights[n] * p.confidence for n, p in pts.items()) / total
        first = next(iter(pts.values()))
        return GazePoint(x=float(x), y=float(y), t=obs.t, confidence=float(conf), model=self.name, t_local=obs.t_local, extra={"members": sorted(pts)}, left=first.left, right=first.right)

    def _drop_outliers(self, pts: dict[str, GazePoint]) -> dict[str, GazePoint]:
        """With three or more members, drop those far from the weighted median. A regression
        model asked about a head pose it never saw can extrapolate across the whole screen; one
        such member would otherwise drag the average with it."""
        if len(pts) < 3:
            return pts
        names = list(pts)
        w = np.array([self.weights[n] for n in names], float)
        xy = np.array([[pts[n].x, pts[n].y] for n in names], float)

        def wmedian(v: np.ndarray) -> float:
            order = np.argsort(v)
            cw = np.cumsum(w[order])
            return float(v[order][np.searchsorted(cw, cw[-1] / 2.0)])

        med = np.array([wmedian(xy[:, 0]), wmedian(xy[:, 1])])
        size = self.screen_size or (1500.0, 1000.0)
        limit = BLEND_OUTLIER_FRACTION * float(np.hypot(*size))
        keep = {n: pts[n] for n, p in zip(names, xy) if float(np.hypot(*(p - med))) <= limit}
        return keep or pts

    def _state(self) -> dict[str, Any]:
        return {"weights": self.weights, "members": {k: m.to_dict() for k, m in self.members.items()}}

    def _load_state(self, state: dict[str, Any]) -> None:
        from . import load_model

        self.weights = {k: float(v) for k, v in state["weights"].items()}
        self.members = {k: load_model(v) for k, v in state["members"].items()}  # type: ignore[misc]
