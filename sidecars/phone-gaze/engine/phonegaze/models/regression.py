"""Regression gaze models: ray-space features + head pose -> screen point. Owner: Models.

- ``RidgeModel`` (registry ``ridge``): ridge regression on per-eye features, second-order
  polynomial in the eye features (``degree=2``, the default) with linear head-pose terms.
- ``KernelModel`` (registry ``kernel``): kernel ridge with an RBF kernel plus a linear kernel.

Features (``features.FeatureTable``): per eye, the optical-axis yaw and pitch in camera
coordinates (when an estimator gave a gaze direction or an eyeball centre) and the
iris-versus-eye-corner vector (when corners are known); plus head yaw, pitch, roll, head
position as a ray, and 1 / distance. All are rays, angles or ratios, so they survive zoom
changes. A missing eye is imputed from the other one.

The regularisation (and the kernel width) is chosen by leave-one-dot-out cross-validation on the
calibration data. Regression learns head compensation only from what the calibration showed it:
after a single-pose calibration, expect it to degrade when the head moves (see the tests).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..types import CalibSample, FitReport, GazePoint, Observation, ScreenInfo
from . import features as F
from .base import ALPHAS, BaseModel, dot_groups, fit_ridge, grouped_cv_alpha, report_from_predictions, ridge_predict, sample_weights


class _FeatureModel(BaseModel):
    """Shared plumbing: feature table, sample matrix, prediction wrapper."""

    name = "_feature"
    eye_groups: tuple[str, ...] = ("gaze", "iris")
    min_fraction = 0.6

    def __init__(self, head: bool = True, max_samples: int = 600, **options: Any) -> None:
        super().__init__(head=head, max_samples=max_samples, **options)
        self.table: F.FeatureTable | None = None

    def _matrix(self, samples: list[CalibSample]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[CalibSample]]:
        obs = [s.obs for s in samples]
        groups = F.available_groups(obs, list(self.eye_groups), self.min_fraction)
        if not groups:
            raise ValueError(f"no usable features ({', '.join(self.eye_groups)}) in the calibration samples")
        self.table = F.FeatureTable(groups, head=bool(self.options["head"]))
        z = self.table.fit(obs)
        keep = np.all(np.isfinite(z), axis=1)
        samples = [s for s, k in zip(samples, keep) if k]
        z = z[keep]
        if len(samples) > int(self.options["max_samples"]):
            pick = np.linspace(0, len(samples) - 1, int(self.options["max_samples"])).round().astype(int)
            samples = [samples[i] for i in pick]
            z = z[pick]
        y = np.array([s.target for s in samples], float).reshape(-1, 2)
        g = np.array([s.dot_id for s in samples])
        w = sample_weights(samples) * len(dot_groups(samples))
        return z, y, g, w, samples

    def _features(self, obs: Observation) -> np.ndarray | None:
        return None if self.table is None else self.table.transform(obs)

    def _point(self, obs: Observation, xy: np.ndarray, n_eyes_cols: bool = True) -> GazePoint:
        conf = max(F.eye_confidence(obs, "left"), F.eye_confidence(obs, "right"))
        return GazePoint(x=float(xy[0]), y=float(xy[1]), t=obs.t, confidence=conf, model=self.name, t_local=obs.t_local)


class RidgeModel(_FeatureModel):
    """Ridge regression, polynomial in the eye features. Registry name ``ridge``."""

    name = "ridge"

    def __init__(self, degree: int = 2, alpha: float | None = None, **options: Any) -> None:
        super().__init__(degree=degree, alpha=alpha, **options)
        self.coef: np.ndarray | None = None
        self.alpha_used: float | None = None

    def warm_start(self, other: BaseModel) -> None:
        """Leave-one-dot-out refits reuse the regularisation chosen on all dots (much faster;
        the score is then very slightly optimistic)."""
        if isinstance(other, RidgeModel) and other.alpha_used is not None and self.options.get("alpha") is None:
            self.options = {**self.options, "alpha": other.alpha_used}

    def _expand(self, z: np.ndarray) -> np.ndarray:
        assert self.table is not None
        if int(self.options["degree"]) >= 2:
            return F.poly2(z, self.table.n_eye_columns)
        return z

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        z, y, g, w, used = self._matrix(samples)
        if len(np.unique(g)) < 3:
            raise ValueError("needs at least 3 dots")
        x = self._expand(z)
        alpha = self.options.get("alpha")
        scores: dict[float, float] = {}
        if alpha is None:
            alpha, scores = grouped_cv_alpha(x, y, g, w)
        self.alpha_used = float(alpha)
        self.coef = fit_ridge(x, y, self.alpha_used, w)
        self.fitted = True
        pred = self.predict_samples(samples, raw=True)
        assert self.table is not None
        return report_from_predictions(self.name, samples, pred, screen, None, params={"alpha": self.alpha_used, "features": self.table.groups, "head": self.table.head, "degree": self.options["degree"], "cv": {str(k): v for k, v in scores.items()}})

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        z = self._features(obs)
        if z is None or self.coef is None:
            return None
        xy = ridge_predict(self._expand(z[None, :]), self.coef)[0]
        return self._point(obs, xy)

    def _state(self) -> dict[str, Any]:
        assert self.table is not None and self.coef is not None
        return {"table": self.table.to_dict(), "coef": self.coef.tolist(), "alpha": self.alpha_used}

    def _load_state(self, state: dict[str, Any]) -> None:
        self.table = F.FeatureTable.from_dict(state["table"])
        self.coef = np.array(state["coef"], float)
        self.alpha_used = state.get("alpha")


class KernelModel(_FeatureModel):
    """Kernel ridge: RBF on the standardised features plus a linear kernel. Registry name
    ``kernel``. ``gamma`` and ``alpha`` are chosen by leave-one-dot-out."""

    name = "kernel"
    GAMMAS = (0.02, 0.05, 0.1, 0.3)
    KERNEL_ALPHAS = (1e-3, 1e-2, 0.1, 1.0)

    def __init__(self, gamma: float | None = None, alpha: float | None = None, max_samples: int = 400, **options: Any) -> None:
        super().__init__(gamma=gamma, alpha=alpha, max_samples=max_samples, **options)
        self.x_train: np.ndarray | None = None
        self.dual: np.ndarray | None = None
        self.y_mean: np.ndarray | None = None
        self.gamma_used: float | None = None
        self.alpha_used: float | None = None

    def warm_start(self, other: BaseModel) -> None:
        """As :meth:`RidgeModel.warm_start`: reuse the chosen ``gamma`` and ``alpha``."""
        if isinstance(other, KernelModel) and other.gamma_used is not None:
            self.options = {**self.options, "gamma": other.gamma_used, "alpha": other.alpha_used}

    @staticmethod
    def _kernel(a: np.ndarray, b: np.ndarray, gamma: float) -> np.ndarray:
        d2 = np.sum(a * a, axis=1)[:, None] + np.sum(b * b, axis=1)[None, :] - 2 * a @ b.T
        return np.exp(-gamma * np.maximum(d2, 0.0)) + 0.1 * (a @ b.T)

    def _solve(self, x: np.ndarray, y: np.ndarray, w: np.ndarray, gamma: float, alpha: float) -> tuple[np.ndarray, np.ndarray]:
        ym = np.average(y, axis=0, weights=w)
        k = self._kernel(x, x, gamma)
        # weighted kernel ridge: (K + alpha W^-1) c = y
        dual = np.linalg.solve(k + alpha * np.diag(1.0 / np.maximum(w, 1e-6)), y - ym)
        return dual, ym

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        z, y, g, w, used = self._matrix(samples)
        ids = np.unique(g)
        if len(ids) < 3:
            raise ValueError("needs at least 3 dots")
        # scale targets to ~1 so alpha is comparable across screens
        scale = max(screen.width, screen.height)
        ys = y / scale
        grid: dict[str, float] = {}
        gammas = self.GAMMAS if self.options.get("gamma") is None else (float(self.options["gamma"]),)
        alphas = self.KERNEL_ALPHAS if self.options.get("alpha") is None else (float(self.options["alpha"]),)
        best = (np.inf, gammas[0], alphas[0])
        if len(gammas) * len(alphas) > 1:
            for gm in gammas:
                for al in alphas:
                    errs = []
                    for d in ids:
                        tr, te = g != d, g == d
                        dual, ym = self._solve(z[tr], ys[tr], w[tr], gm, al)
                        p = self._kernel(z[te], z[tr], gm) @ dual + ym
                        errs.append(float(np.mean(np.linalg.norm(p - ys[te], axis=1))))
                    e = float(np.mean(errs))
                    grid[f"{gm}/{al}"] = e * scale
                    if e < best[0]:
                        best = (e, gm, al)
        self.gamma_used, self.alpha_used = float(best[1]), float(best[2])
        dual, ym = self._solve(z, ys, w, self.gamma_used, self.alpha_used)
        self.x_train, self.dual, self.y_mean = z, dual * scale, ym * scale
        self.fitted = True
        pred = self.predict_samples(samples, raw=True)
        assert self.table is not None
        return report_from_predictions(self.name, samples, pred, screen, None, params={"gamma": self.gamma_used, "alpha": self.alpha_used, "features": self.table.groups, "head": self.table.head, "n_support": len(z), "cv": grid})

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        z = self._features(obs)
        if z is None or self.x_train is None or self.dual is None or self.y_mean is None or self.gamma_used is None:
            return None
        xy = self._kernel(z[None, :], self.x_train, self.gamma_used) @ self.dual + self.y_mean
        return self._point(obs, xy[0])

    def _state(self) -> dict[str, Any]:
        assert self.table is not None and self.x_train is not None and self.dual is not None and self.y_mean is not None
        return {"table": self.table.to_dict(), "x": self.x_train.tolist(), "dual": self.dual.tolist(), "y_mean": self.y_mean.tolist(), "gamma": self.gamma_used, "alpha": self.alpha_used}

    def _load_state(self, state: dict[str, Any]) -> None:
        self.table = F.FeatureTable.from_dict(state["table"])
        self.x_train = np.array(state["x"], float)
        self.dual = np.array(state["dual"], float)
        self.y_mean = np.array(state["y_mean"], float)
        self.gamma_used = float(state["gamma"])
        self.alpha_used = float(state["alpha"])


__all__ = ["ALPHAS", "KernelModel", "RidgeModel"]
