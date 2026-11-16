"""Iris edge estimator: sub-pixel limbus ellipse on the native-resolution eye crops. Owner: Vision.

Uses the algorithms ported from ``tools/eye-capture/analysis/eyes.py`` (see :mod:`.eyes`):
a rough iris position (from landmarks, ARKit, this estimator's previous frame, or the direct
finder run on the crop itself) seeds a limbus search along rays and a RANSAC ellipse fit. The
result is mapped back to upright full-frame pixels through the crop's ``to_full`` affine.

Fills per eye: ``found``, ``iris_center``, ``iris_radius`` (mean semi-axis), ``iris_ellipse``,
``iris_edge_sharpness`` (10-90 % edge width, full-frame pixels), ``confidence``; and refines
``distance`` from the iris's apparent size (unless ARKit set it), then recomputes ``gaze_dir``
with :func:`.geometry.fill_eye_model` when an eyeball centre or head pose is known.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..types import DecodedFrame, DecodedImage, Observation, Vec2
from . import distance as D
from . import eyes as E
from .geometry import combine, depth_from_iris, distance_from_depth, fill_eye_model, iris_ellipse_full
from .settings import opt

MIN_RADIUS_PX = 4.0
"""Below this iris radius (in the image used) the fit is not attempted."""


def _image_for(frame: DecodedFrame, side: str, center_full: Vec2 | None) -> DecodedImage | None:
    """The most detailed image that shows this eye: its named ROI, another ROI containing the
    rough centre, else the wide image."""
    named = frame.images.get(f"{side}_eye")
    if named is not None and named.kind == "roi":
        if center_full is None or _inside(named, center_full, 0.0):
            return named
    if center_full is not None:
        best = None
        for im in frame.rois():
            if _inside(im, center_full, 0.0) and (best is None or im.scale > best.scale):
                best = im
        if best is not None:
            return best
        wide = frame.wide
        if wide is not None and _inside(wide, center_full, 0.0):
            return wide
        return None
    return named


def _inside(im: DecodedImage, p: Vec2, margin: float) -> bool:
    x, y, w, h = im.rect_full
    return x + margin <= p[0] <= x + w - margin and y + margin <= p[1] <= y + h - margin


class IrisEdgeEstimator:
    """[``iris_edge``] Sub-pixel limbus ellipse per eye."""

    name = "iris_edge"

    def __init__(self, config: Any = None, ransac: int = 80, max_gap_frames: int = 6) -> None:
        self.config = config
        self.ransac = ransac
        self.max_gap_frames = max_gap_frames
        self._last: dict[str, tuple[int, Vec2, float]] = {}
        self.debug: dict[str, dict[str, Any]] = {}
        """Last fit per eye for the Tuning page: ``{"seq", "edge_points"}`` (full-frame pixels).
        Not part of the observation, so recordings stay small."""
        self._rng = np.random.default_rng(0)

    def reset(self) -> None:
        self._last.clear()
        self.debug.clear()
        self._rng = np.random.default_rng(0)

    # -----------------------------------------------------------------------------------------

    def _seed(self, frame: DecodedFrame, obs: Observation, side: str) -> tuple[Vec2, float, str] | None:
        eye = obs.eye(side)
        if eye.iris_center is not None and eye.iris_radius:
            return eye.iris_center, float(eye.iris_radius), obs.provenance.get(f"{side}.iris_center", "?")
        last = self._last.get(side)
        gap = int(opt(self.config, "iris_track_frames", self.max_gap_frames))
        if last is not None and 0 <= frame.frame.seq - last[0] <= gap:
            return last[1], last[2], "previous"
        return None

    def _fit_eye(self, frame: DecodedFrame, obs: Observation, side: str) -> dict[str, Any] | None:
        seed = self._seed(frame, obs, side)
        im = _image_for(frame, side, seed[0] if seed else None)
        if im is None:
            return None
        gray = im.gray
        s = im.scale
        if seed is not None:
            c_img = np.array(im.point_from_full(seed[0])) - 0.5
            r_img = seed[1] * s
            method = seed[2]
        else:
            # Locate it ourselves: only on a crop named for this eye.
            if im.kind != "roi" or frame.intrinsics is None:
                return None
            lo, hi = E.radius_range(frame.intrinsics.fx, diameter_mm=float(opt(self.config, "iris_diameter_mm", 11.7)))
            # The finder scores a ring out to 1.6 radii, so larger irises cannot fit the crop.
            hi_img = min(hi * s, min(gray.shape) / 3.2)
            if hi_img <= lo * s:
                return None
            # Hough's radius estimate is unreliable over a wide range, so search overlapping
            # bands (each about 1.5x) and keep the best-scoring eye.
            found = []
            a = lo * s
            while a < hi_img:
                b = min(hi_img, a * 1.5)
                found += E.direct_eyes(im.pixels, a, b, max_eyes=1)
                a *= 1.3
            if not found:
                return None
            found.sort(key=lambda g: -g.score)
            c_img, r_img, method = found[0].centre, found[0].radius, "direct"
        if r_img < MIN_RADIUS_PX:
            return None
        h, w = gray.shape
        if not (0 <= c_img[0] < w and 0 <= c_img[1] < h):
            return None
        cfg = self.config
        fit = E.fit_iris(
            gray,
            c_img,
            r_img,
            rng=self._rng,
            ransac=int(opt(cfg, "iris_ransac", self.ransac)),
            shape=str(opt(cfg, "iris_fit", "ellipse")),
            edge_keep=float(opt(cfg, "iris_edge_keep", 0.35)),
            subpixel=bool(opt(cfg, "iris_subpixel", True)),
            lid_upper_deg=float(opt(cfg, "iris_lid_mask_upper_deg", 0.0)),
            lid_lower_deg=float(opt(cfg, "iris_lid_mask_lower_deg", 0.0)),
            inlier_frac=float(opt(cfg, "iris_inlier_px", 0.04)),
        )
        if fit is None:
            return None
        r_fit = (fit["major"] + fit["minor"]) / 4
        gate = float(opt(cfg, "iris_radius_gate", 1.6))
        if not (0.6 * 1.6 / gate < r_fit / r_img < gate) or np.linalg.norm(fit["centre"] - c_img) > 0.6 * r_img + 2:
            return None
        width, n_w, contrast = E.edge_width(gray, fit)
        centre_img = (float(fit["centre"][0]) + 0.5, float(fit["centre"][1]) + 0.5)
        (_, _), (ew, eh), ang = fit["ellipse"]
        ell = iris_ellipse_full(centre_img, (ew, eh), ang, im.to_full)
        inl_frac = fit["inliers"] / max(1, fit["rays"])
        # Under half the rays agreeing usually means lids or a corner hide much of the limbus.
        conf = float(np.clip((inl_frac - 0.3) / 0.5, 0, 1) * math.exp(-fit["rms_px"] / max(0.5, 0.04 * r_fit)))
        if conf < float(opt(cfg, "iris_min_confidence", 0.05)):
            return None
        return {
            "ellipse": ell,
            "center": (ell[0], ell[1]),
            "radius": (ell[2] + ell[3]) / 2,
            "major": ell[2],
            "edge_width": None if width is None else width / s,
            "contrast": contrast,
            "confidence": conf,
            "image": im.name,
            "rms_px": fit["rms_px"] / s,
            "inliers": fit["inliers"],
            "seed": method,
            "points": [im.point_to_full((float(p[0]) + 0.5, float(p[1]) + 0.5)) for p in fit["points"]],
        }

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        obs = previous if previous is not None else Observation.empty(frame)
        n = self.name
        results = {}
        for side in ("left", "right"):
            r = self._fit_eye(frame, obs, side)
            if r is None:
                continue
            results[side] = r
            self.debug[side] = {"seq": frame.frame.seq, "edge_points": r["points"]}
            self._last[side] = (frame.frame.seq, r["center"], r["radius"])
            eye = obs.eye(side)
            obs.set(f"{side}.found", True, n)
            obs.set(f"{side}.iris_center", r["center"], n)
            obs.set(f"{side}.iris_radius", float(r["radius"]), n)
            obs.set(f"{side}.iris_ellipse", tuple(float(v) for v in r["ellipse"]), n)
            if r["edge_width"] is not None:
                obs.set(f"{side}.iris_edge_sharpness", float(r["edge_width"]), n)
            prev_conf = eye.confidence
            obs.set(f"{side}.confidence", r["confidence"] if prev_conf is None else max(r["confidence"], 0.5 * prev_conf), n)
            eye.extra[n] = {
                "image": r["image"],
                "rms_px": r["rms_px"],
                "inliers": r["inliers"],
                "seed": r["seed"],
                "contrast": r["contrast"],
                "fit_confidence": r["confidence"],
            }
        if not results:
            return None

        intr = frame.intrinsics
        src = D.source(self.config)
        locked = obs.provenance.get("distance") == "arkit" or src in ("head", "fixed") or (src == "depth" and (obs.extra.get("distance") or {}).get("source") == "depth")
        if intr is not None and not locked:
            diameter = float(opt(self.config, "iris_diameter_mm", 11.7))
            pairs = []
            for side, r in results.items():
                depth = depth_from_iris(r["major"], intr.fx, diameter)
                if depth is not None:
                    pairs.append((distance_from_depth(intr, r["center"], depth), r["confidence"]))
            d = combine(pairs)
            if d is not None and 0.1 < d < 3.0:
                old = obs.distance if obs.provenance.get("distance") == "landmarks" else None
                obs.set("distance", float(d), n)
                D.note(obs, "iris_fit", {"iris_fit": d})
                if old:
                    # The landmarks estimator placed the eyeball centres at its own, rougher
                    # distance (canthi span and the low-resolution iris). Scaling a point about the
                    # camera keeps its pixel and moves it to the refined depth.
                    k = float(d) / float(old)
                    for side in ("left", "right"):
                        c = obs.eye(side).eyeball_center
                        if c is not None and obs.provenance.get(f"{side}.eyeball_center") == "landmarks":
                            obs.set(f"{side}.eyeball_center", tuple(float(v) * k for v in c), n)
                    if obs.head_position is not None and obs.provenance.get("head_position") == "landmarks":
                        obs.set("head_position", tuple(float(v) * k for v in obs.head_position), n)
        fill_eye_model(obs, n)
        return obs
