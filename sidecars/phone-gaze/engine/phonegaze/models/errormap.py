"""Error map: a smooth correction over the screen, learned from known look-points. Owner: Models.

After calibration, the remaining error is rarely a single offset: corners are usually worse
than the centre, one side drifts more than the other. An :class:`ErrorMap` learns
``target - prediction`` as a smooth function of the predicted screen point and adds it to the
model's output (after the quick-refine / drift correction, see ``BaseModel.predict``).

Kinds (``calibration.error_map``):

- ``affine``: shift, scale and shear (6 numbers);
- ``quadratic``: adds the five second-order terms (12 numbers);
- ``tps``: a regularised thin-plate spline through the dots (bends locally; needs the most dots).

All are ridge-regularised towards NO correction (``smoothing``; coordinates are normalised by the
screen's larger side, so the same smoothing means the same thing on every screen).
:func:`fit_error_map` keeps a map only if leave-one-dot-out says it lowers the error by at
least ``min_gain``; otherwise it returns ``None`` and the reason, so switching it on can never
make held-out accuracy worse on the dots it was judged on.

Imported by: ``models/base.py`` (applying, loading), ``calibration.py`` (fitting).
"""

from __future__ import annotations

from typing import Any

import numpy as np

KINDS = ("affine", "quadratic", "tps")
MIN_DOTS = {"affine": 3, "quadratic": 6, "tps": 5}


def _tps_kernel(r: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        k = r * r * np.log(r)
    return np.where(r > 0, k, 0.0)


class ErrorMap:
    """A fitted correction ``p -> p + f(p)`` in screen points."""

    def __init__(self, kind: str, screen_size: tuple[float, float], smoothing: float = 1.0) -> None:
        if kind not in KINDS:
            raise ValueError(f"unknown error map kind {kind!r}")
        self.kind = kind
        self.screen_size = (float(screen_size[0]), float(screen_size[1]))
        self.smoothing = float(smoothing)
        self.coef: np.ndarray | None = None  # polynomial: F x 2; tps: (N + 3) x 2
        self.centres: np.ndarray | None = None  # tps: N x 2 (normalised)
        self.info: dict[str, Any] = {}

    # --- coordinates ---------------------------------------------------------------------

    def _norm(self, pts: np.ndarray) -> np.ndarray:
        w, h = self.screen_size
        s = max(w, h)
        return (np.asarray(pts, float) - np.array([w / 2, h / 2])) / s

    def _poly(self, u: np.ndarray) -> np.ndarray:
        x, y = u[:, 0], u[:, 1]
        cols = [np.ones_like(x), x, y]
        if self.kind == "quadratic":
            cols += [x * x, x * y, y * y]
        return np.stack(cols, axis=1)

    # --- fit / apply -------------------------------------------------------------------------

    def fit(self, pred: np.ndarray, target: np.ndarray, weight: np.ndarray | None = None) -> ErrorMap:
        """Fit on per-dot mean predictions and targets (``N x 2`` screen points each)."""
        pred = np.asarray(pred, float).reshape(-1, 2)
        target = np.asarray(target, float).reshape(-1, 2)
        s = max(self.screen_size)
        u = self._norm(pred)
        r = (target - pred) / s
        w = np.ones(len(u)) if weight is None else np.asarray(weight, float)
        lam = 0.01 * self.smoothing
        if self.kind == "tps":
            n = len(u)
            d = np.linalg.norm(u[:, None, :] - u[None, :, :], axis=2)
            k = _tps_kernel(d) + np.diag(lam / np.maximum(w, 1e-6))
            pm = np.hstack([np.ones((n, 1)), u])
            a = np.zeros((n + 3, n + 3))
            a[:n, :n] = k
            a[:n, n:] = pm
            a[n:, :n] = pm.T
            # a little ridge on the affine part too: no correction is the prior
            a[n:, n:] = -np.eye(3) * lam * 1e-2
            b = np.vstack([r, np.zeros((3, 2))])
            self.coef = np.linalg.lstsq(a, b, rcond=None)[0]
            self.centres = u
        else:
            x = self._poly(u)
            xtw = x.T * w
            reg = lam * np.eye(x.shape[1]) * max(float(w.sum()), 1.0)
            self.coef = np.linalg.solve(xtw @ x + reg, xtw @ r)
        return self

    def delta(self, pts: np.ndarray) -> np.ndarray:
        """The correction (screen points) at each point."""
        assert self.coef is not None
        u = self._norm(np.asarray(pts, float).reshape(-1, 2))
        if self.kind == "tps":
            assert self.centres is not None
            n = len(self.centres)
            d = np.linalg.norm(u[:, None, :] - self.centres[None, :, :], axis=2)
            out = _tps_kernel(d) @ self.coef[:n] + np.hstack([np.ones((len(u), 1)), u]) @ self.coef[n:]
        else:
            out = self._poly(u) @ self.coef
        return out * max(self.screen_size)

    def apply_many(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, float).reshape(-1, 2)
        return pts + self.delta(pts)

    def apply(self, x: float, y: float) -> tuple[float, float]:
        p = self.apply_many(np.array([[x, y]]))[0]
        return float(p[0]), float(p[1])

    # --- persistence -------------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "screen_size": list(self.screen_size),
            "smoothing": self.smoothing,
            "coef": None if self.coef is None else self.coef.tolist(),
            "centres": None if self.centres is None else self.centres.tolist(),
            "info": self.info,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ErrorMap:
        m = cls(str(data["kind"]), tuple(data["screen_size"]), float(data.get("smoothing", 1.0)))  # type: ignore[arg-type]
        m.coef = None if data.get("coef") is None else np.asarray(data["coef"], float)
        m.centres = None if data.get("centres") is None else np.asarray(data["centres"], float)
        m.info = dict(data.get("info") or {})
        return m


def fit_error_map(
    pred: np.ndarray,
    target: np.ndarray,
    screen_size: tuple[float, float],
    kind: str,
    smoothing: float = 1.0,
    min_gain: float = 0.05,
    weight: np.ndarray | None = None,
) -> tuple[ErrorMap | None, dict[str, Any]]:
    """Fit an error map on per-dot means and judge it by leave-one-dot-out.

    Returns ``(map or None, info)``; ``info`` has ``n_dots``, ``loo_before_pt`` (mean error of
    the dots without a map), ``loo_after_pt`` (each dot corrected by a map fitted without it),
    ``kept`` and ``reason``."""
    pred = np.asarray(pred, float).reshape(-1, 2)
    target = np.asarray(target, float).reshape(-1, 2)
    ok = np.all(np.isfinite(pred), axis=1) & np.all(np.isfinite(target), axis=1)
    pred, target = pred[ok], target[ok]
    w = None if weight is None else np.asarray(weight, float)[ok]
    n = len(pred)
    info: dict[str, Any] = {"kind": kind, "n_dots": n, "kept": False}
    if kind not in KINDS:
        info["reason"] = "off"
        return None, info
    if n < MIN_DOTS[kind] + 1:
        info["reason"] = f"needs at least {MIN_DOTS[kind] + 1} dots (has {n})"
        return None, info
    before = np.linalg.norm(target - pred, axis=1)
    after = np.full(n, np.nan)
    for i in range(n):
        tr = np.arange(n) != i
        m = ErrorMap(kind, screen_size, smoothing).fit(pred[tr], target[tr], None if w is None else w[tr])
        after[i] = float(np.linalg.norm(target[i] - m.apply_many(pred[i : i + 1])[0]))
    info["loo_before_pt"] = float(np.mean(before))
    info["loo_after_pt"] = float(np.mean(after))
    info["per_dot_before_pt"] = before.tolist()
    info["per_dot_after_pt"] = after.tolist()
    if info["loo_after_pt"] > (1.0 - min_gain) * info["loo_before_pt"]:
        info["reason"] = f"did not help held-out ({info['loo_after_pt']:.1f} pt vs {info['loo_before_pt']:.1f} pt without)"
        return None, info
    m = ErrorMap(kind, screen_size, smoothing).fit(pred, target, w)
    info["kept"] = True
    info["reason"] = f"kept: held-out {info['loo_after_pt']:.1f} pt vs {info['loo_before_pt']:.1f} pt without"
    m.info = {k: v for k, v in info.items() if not k.startswith("per_dot")}
    return m, info
