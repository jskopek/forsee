"""Iris finding and limbus fitting, ported from ``tools/eye-capture/analysis/eyes.py``. Owner: Vision.

That file is the only vision code that has seen the owner's real footage, so the algorithms are
kept as they were: the direct finder (Hough circles of a plausible size scored by sclera,
corneal reflection and darkness cues), the limbus search along rays, the RANSAC ellipse fit with
an aspect and size gate, the 10-90 % edge width and the scale-normalised sharpness. Changes:

- functions take plain arrays and return plain values (no ``session`` import, no MediaPipe);
- the limbus peak is refined to sub-sample precision with a parabola through the gradient peak;
- RANSAC stops early once the consensus is large, and the iteration count is a parameter
  (the original always ran 150), to stay inside the per-frame budget;
- coordinates are OpenCV/numpy INDEX coordinates (pixel centre = integer), as in the original.
  Callers add 0.5 to get the continuous convention of ``types.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from ..types import IRIS_DIAMETER_MM

NEAR_MM, FAR_MM = 350.0, 1000.0
"""Plausible eye-to-camera range for the direct finder's iris size prior."""


@dataclass
class EyeGuess:
    centre: np.ndarray  # (x, y) index pixels
    radius: float  # rough iris radius in pixels
    method: str  # "mediapipe", "direct", "previous", ...
    side: str = ""
    score: float = 0.0
    corners: Any = None
    extra: dict[str, Any] = field(default_factory=dict)


def radius_range(fx: float, near_mm: float = NEAR_MM, far_mm: float = FAR_MM) -> tuple[float, float]:
    """Iris radius range in pixels for a lens with focal length ``fx`` pixels."""
    return fx * IRIS_DIAMETER_MM / 2 / far_mm, fx * IRIS_DIAMETER_MM / 2 / near_mm


def direct_eyes(bgr: np.ndarray, r_min: float, r_max: float, near=None, max_eyes: int = 2, max_width: int = 1920) -> list[EyeGuess]:
    """Find irises directly as circles of a plausible size, scored as eye-like.

    ``near`` = (x, y, radius) searches a window round a known eye with the radius fixed to +-20%.
    """
    H, W = bgr.shape[:2]
    x0 = y0 = 0
    if near is not None:
        nx, ny, nr = near
        half = int(4 * nr)
        x0, y0 = max(0, int(nx) - half), max(0, int(ny) - half)
        bgr = bgr[y0 : min(H, int(ny) + half), x0 : min(W, int(nx) + half)]
        r_min, r_max = 0.8 * nr, 1.2 * nr
    if bgr.size == 0:
        return []
    # Work at a scale where the iris is ~14 px in radius, and no wider than max_width.
    k = max(1.0, r_min / 14.0, bgr.shape[1] / max_width)
    small = cv2.resize(bgr, None, fx=1 / k, fy=1 / k, interpolation=cv2.INTER_AREA) if k > 1 else bgr
    raw = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(raw, (0, 0), 1.5)
    sat = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[..., 1]
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1,
        minDist=max(2, r_min / k),
        param1=60,
        param2=15,
        minRadius=max(2, int(r_min / k)),
        maxRadius=int(np.ceil(r_max / k)),
    )
    if circles is None:
        return []
    found = []
    for rank, (cx, cy, r) in enumerate(circles[0][:20]):
        score = iris_score(gray, sat, cx, cy, r, raw=raw)
        if score > 0:
            found.append(EyeGuess(np.array([cx * k + x0, cy * k + y0]), float(r * k), "direct", "", score - 0.02 * rank))
    found.sort(key=lambda e: -e.score)
    kept: list[EyeGuess] = []
    for e in found:  # drop overlapping circles (pupil inside iris, etc.)
        if all(np.linalg.norm(e.centre - o.centre) > 1.5 * max(e.radius, o.radius) for o in kept):
            kept.append(e)
    return kept[:max_eyes]


def iris_score(gray: np.ndarray, sat: np.ndarray, cx: float, cy: float, r: float, raw: np.ndarray | None = None) -> float:
    """How eye-like a circle is; 0 if not. Uses three cues that hold for any iris colour:
    the sclera left and right is less saturated than the skin of the lids above and below,
    the disc holds a bright corneal reflection, and the disc is darker than the sclera.

    ``raw`` (unblurred gray, optional; not in the original) is used for the reflection cue so a
    small highlight is not blurred away when the image was downscaled a lot.
    """
    h, w = gray.shape
    R = int(1.6 * r) + 1
    xa, xb, ya, yb = int(cx) - R, int(cx) + R, int(cy) - R, int(cy) + R
    if xa < 0 or ya < 0 or xb > w or yb > h:
        return 0.0  # iris and its surroundings must be in frame
    g = gray[ya:yb, xa:xb].astype(np.float32)
    s = sat[ya:yb, xa:xb].astype(np.float32)
    yy, xx = np.mgrid[ya:yb, xa:xb]
    d = np.hypot(xx - cx, yy - cy)
    ang = np.abs(np.degrees(np.arctan2(yy - cy, xx - cx)))
    ring = (d > 1.1 * r) & (d < 1.5 * r)
    sides = ring & ((ang < 30) | (ang > 150))
    lids = ring & (ang > 60) & (ang < 120)
    inner = (d < 0.85 * r) & (d > 0.35 * r)
    if sides.sum() < 10 or lids.sum() < 10 or inner.sum() < 20:
        return 0.0
    s_sides, s_lids = np.median(s[sides]), np.median(s[lids])
    sclera = (s_lids - s_sides) / (s_lids + 1)
    g_sides = np.median(g[sides])
    gr = g if raw is None else raw[ya:yb, xa:xb].astype(np.float32)
    reflection = (np.percentile(gr[d < 0.85 * r], 99.5) - g_sides) / 255
    darker = (g_sides - np.median(g[inner])) / 255
    if sclera < 0.1 or reflection < 0.05:
        return 0.0
    return float(sclera + reflection + max(darker, 0))


def _sample(gray: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    return cv2.remap(gray, xs.astype(np.float32), ys.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def limbus_points(gray: np.ndarray, centre, r0: float, step_deg: float = 3.0):
    """Strongest dark-to-bright step outward along rays from the centre, between 0.6 and 1.45 r0.
    The peak is refined with a parabola through the gradient (sub-sample precision)."""
    angles = np.radians(np.arange(0, 360, step_deg))
    dr = max(0.25, r0 / 200)
    rho = np.arange(0.6 * r0, 1.45 * r0, dr)
    xs = centre[0] + np.outer(np.cos(angles), rho)
    ys = centre[1] + np.outer(np.sin(angles), rho)
    prof = _sample(gray, xs, ys)
    sigma = max(1.0, r0 / 40) / dr
    prof = cv2.GaussianBlur(prof, (0, 0), sigmaX=sigma, sigmaY=0.01)
    grad = np.gradient(prof, axis=1)
    n = len(angles)
    i = grad.argmax(axis=1)
    rows = np.arange(n)
    strength = grad[rows, i]
    ic = np.clip(i, 1, grad.shape[1] - 2)
    gm, g0, gp = grad[rows, ic - 1], grad[rows, ic], grad[rows, ic + 1]
    den = gm - 2 * g0 + gp
    frac = np.where((np.abs(den) > 1e-9) & (i == ic), 0.5 * (gm - gp) / np.where(np.abs(den) > 1e-9, den, 1.0), 0.0)
    frac = np.clip(frac, -0.5, 0.5)
    r_at = rho[0] + (ic + frac) * dr
    r_at = np.where(i == ic, r_at, rho[i])
    pts = np.stack([centre[0] + np.cos(angles) * r_at, centre[1] + np.sin(angles) * r_at], 1)
    return pts, strength, angles


def _ellipse_residual(pts: np.ndarray, ell) -> np.ndarray:
    (cx, cy), (w, h), ang = ell
    a, b = w / 2, h / 2
    t = np.radians(ang)
    dx, dy = pts[:, 0] - cx, pts[:, 1] - cy
    u = dx * np.cos(t) + dy * np.sin(t)
    v = -dx * np.sin(t) + dy * np.cos(t)
    return (np.hypot(u / a, v / b) - 1) * (a + b) / 2


def fit_iris(gray: np.ndarray, centre, r0: float, rng=None, iterations: int = 2, major_range=None, ransac: int = 150, early_stop: float = 0.85):
    """Fit an ellipse to the limbus. Returns dict or None.

    major_range = (lo, hi) limits the ellipse's long axis. The long axis of a tilted circle is
    its true diameter, so with a known iris size it barely changes with gaze direction.
    """
    rng = rng or np.random.default_rng(0)
    centre = np.asarray(centre, float)
    best = None
    ell = None
    tol = 1.0
    for _ in range(iterations):
        pts, strength, angles = limbus_points(gray, centre, r0)
        keep = strength > 0.35 * np.percentile(strength, 90)
        pts, strength, angles = pts[keep], strength[keep], angles[keep]
        if len(pts) < 8:
            return None
        tol = max(1.0, 0.04 * r0)
        best = None
        for _ in range(ransac):
            sample = pts[rng.choice(len(pts), 5, replace=False)]
            try:
                e = cv2.fitEllipse(sample.astype(np.float32))
            except cv2.error:
                continue
            (cx, cy), (w, h), _a = e
            if not (min(w, h) > 0 and 0.55 < min(w, h) / max(w, h + 1e-9) and 1.2 * r0 < (w + h) / 2 < 2.6 * r0):
                continue
            if major_range and not (major_range[0] <= max(w, h) <= major_range[1]):
                continue
            inl = np.abs(_ellipse_residual(pts, e)) < tol
            if best is None or inl.sum() > best[1].sum():
                best = (e, inl)
                if inl.mean() >= early_stop:
                    break
        if best is None or best[1].sum() < 8:
            return None
        ell = cv2.fitEllipse(pts[best[1]].astype(np.float32))
        centre = np.array(ell[0])
        r0 = (ell[1][0] + ell[1][1]) / 4
    # Final polish (not in the original): refit on the tighter half of the tolerance, which
    # drops eyelid points that sit just inside the limbus. Kept only if enough points remain.
    tight = np.abs(_ellipse_residual(pts, ell)) < 0.5 * tol
    if tight.sum() >= max(8, 0.5 * best[1].sum()):
        try:
            ell = cv2.fitEllipse(pts[tight].astype(np.float32))
        except cv2.error:
            pass
    inl = np.abs(_ellipse_residual(pts, ell)) < tol
    if inl.sum() < 5:
        return None
    (cx, cy), (w, h), ang = ell
    return {
        "centre": np.array([cx, cy]),
        "major": max(w, h),
        "minor": min(w, h),
        "angle": ang,
        "ellipse": ell,
        "inliers": int(inl.sum()),
        "rays": int(round(360 / 3.0)),
        "rms_px": float(np.sqrt(np.mean(_ellipse_residual(pts[inl], ell) ** 2))),
        "points": pts[inl],
        "angles": angles[inl],
    }


def edge_width(gray: np.ndarray, fit: dict, max_angle: float = 35):
    """10-90% width of the limbus edge, in pixels, on rays towards the sclera (near horizontal).

    Profiles are sampled unsmoothed across the fitted edge. Each is normalised between the iris
    level just inside and the sclera level just outside, and the distance between the 10% and
    90% crossings either side of the edge is taken. Returns the median over rays, the number of
    usable rays and the median iris-to-sclera contrast.
    """
    c, r = fit["centre"], (fit["major"] + fit["minor"]) / 4
    ang = np.degrees(fit["angles"]) % 180
    lateral = (ang < max_angle) | (ang > 180 - max_angle)
    pts, angs = fit["points"][lateral], fit["angles"][lateral]
    if len(pts) == 0:
        return None, 0, None
    # Vectorised over rays (same result as sampling ray by ray).
    step = 0.2
    offs = np.arange(-0.4 * r, 0.35 * r, step)
    rho_e = np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1])
    rho = rho_e[:, None] + offs[None, :]
    prof = _sample(gray, c[0] + rho * np.cos(angs)[:, None], c[1] + rho * np.sin(angs)[:, None])
    e = min(int(np.searchsorted(offs, 0.0)), len(offs) - 1)
    lo = np.median(prof[:, offs < -0.2 * r], axis=1)
    hi = np.median(prof[:, offs > 0.15 * r], axis=1)
    contrast = hi - lo
    ok = contrast >= 8
    n = (prof - lo[:, None]) / np.where(ok, contrast, 1.0)[:, None]
    idx = np.arange(len(offs))[None, :]
    below = (n <= 0.1) & (idx <= e)
    i10 = np.where(below.any(1), np.where(below, idx, -1).max(1), 0)
    above = (n >= 0.9) & (idx >= e)
    i90 = np.where(above.any(1), np.where(above, idx, len(offs)).min(1), len(offs) - 1)
    ok &= (i10 > 0) & (i90 < len(offs) - 1)
    if not ok.any():
        return None, 0, None
    widths = (i90[ok] - i10[ok]) * step
    return float(np.median(widths)), int(ok.sum()), float(np.median(contrast[ok]))


def eye_sharpness(gray: np.ndarray, centre, major: float, iris_px: float = 100) -> float | None:
    """Laplacian energy over local contrast in a box round the iris, at a common scale.

    The box is resampled so the iris spans ``iris_px`` pixels (about the 2x camera's native size
    on the owner's phone), so cameras are compared on detail at the same scale on the eye.
    """
    half_w, half_h = 1.2 * major, 0.6 * major
    x0, x1 = int(centre[0] - half_w), int(centre[0] + half_w)
    y0, y1 = int(centre[1] - half_h), int(centre[1] + half_h)
    H, W = gray.shape
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H or x1 - x0 < 4 or y1 - y0 < 4:
        return None
    box = gray[y0:y1, x0:x1].astype(np.float32)
    s = iris_px / major
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC
    box = cv2.resize(box, None, fx=s, fy=s, interpolation=interp)
    lap = cv2.Laplacian(box, cv2.CV_32F, ksize=3)
    return float(lap.var() / (box.var() + 1e-6))
