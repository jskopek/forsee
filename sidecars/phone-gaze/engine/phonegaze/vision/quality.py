"""Image quality: sharpness, exposure, iris size, and a "this frame is unusable" verdict. Owner: Vision.

:func:`measure_quality` gives Core's lens and zoom search numbers it can compare across cameras
and zooms. :class:`QualityEstimator` [``quality``] adds them to every observation plus a verdict:
``quality["usable"]`` is 1.0 or 0.0, and ``extra["quality"]["reasons"]`` lists why not
(``"no_eyes"``, ``"blink"``, ``"motion_blur"``, ``"eyes_out_of_frame"``, ``"too_dark"``,
``"overexposed"``, ``"out_of_focus"``).

Sharpness is the Laplacian energy over local contrast in a box round each iris, resampled so the
iris spans 100 px (``eyes.eye_sharpness``, from ``tools/eye-capture``), so a blurry 2x crop and a
sharp 1x frame are compared on detail at the same scale on the eye. Motion blur is predicted
from the phone's rotation rate times the exposure time (pixels smeared across the frame), and
measured as the limbus edge width when the iris edge estimator ran.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ..types import DecodedFrame, DecodedImage, Observation
from . import eyes as E

MOTION_BLUR_PX = 2.0
"""Predicted smear (full-frame pixels) above which a frame is unusable."""

EDGE_WIDTH_FRACTION = 0.15
"""Limbus edge width / iris radius above which the eye counts as out of focus or smeared."""

MIN_SHARPNESS = 0.02
"""Sharpness below which the eye counts as out of focus (synthetic calibration; check on device)."""


def _best_image(frame: DecodedFrame, side: str, center) -> DecodedImage | None:
    from .iris_edge import _image_for

    return _image_for(frame, side, center)


def _eye_box_stats(im: DecodedImage, center_full, radius_full: float) -> dict[str, float] | None:
    gray = im.gray
    s = im.scale
    c = np.array(im.point_from_full(center_full)) - 0.5
    r = radius_full * s
    major = 2 * r
    h, w = gray.shape
    x0, x1 = int(max(0, c[0] - 1.2 * major)), int(min(w, c[0] + 1.2 * major))
    y0, y1 = int(max(0, c[1] - 0.6 * major)), int(min(h, c[1] + 0.6 * major))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    box = gray[y0:y1, x0:x1]
    out = {
        "brightness": float(box.mean()),
        "clipped": float(((box >= 250) | (box <= 3)).mean()),
        "iris_px": float(2 * radius_full),
        "image_iris_px": float(major),
    }
    sharp = E.eye_sharpness(gray, c, major) if major >= 6 else None
    if sharp is not None:
        out["sharpness"] = sharp
    return out


def _edge_margin(frame: DecodedFrame, obs: Observation) -> float | None:
    vals = []
    for eye in (obs.left, obs.right):
        if eye.iris_center is None:
            continue
        x, y = eye.iris_center
        vals.append(min(x / frame.width, 1 - x / frame.width, y / frame.height, 1 - y / frame.height))
    return float(min(vals)) if vals else None


def measure_quality(frame: DecodedFrame, obs: Observation | None) -> dict[str, Any]:
    """Numbers Core's aiming uses to compare cameras and zooms. Keys (all optional/None):
    ``iris_px`` (mean iris diameter, full-frame pixels), ``sharpness`` (higher is sharper,
    unitless, comparable across zooms), ``brightness`` (0-255 mean of the eye regions),
    ``eyes_in_frame`` (0, 1 or 2), ``edge_margin`` (smallest distance from an eye to the frame
    edge, fraction of the frame). Also ``clipped`` (fraction of eye-region pixels at 0 or 255)
    and ``motion_blur_px`` (predicted smear)."""
    out: dict[str, Any] = {
        "iris_px": None,
        "sharpness": None,
        "brightness": None,
        "eyes_in_frame": 0,
        "edge_margin": None,
        "clipped": None,
        "motion_blur_px": predicted_motion_blur_px(frame),
    }
    if obs is None:
        wide = frame.wide
        if wide is not None:
            out["brightness"] = float(wide.gray.mean())
        return out
    stats = []
    n_eyes = 0
    for side in ("left", "right"):
        eye = obs.eye(side)
        if eye.iris_center is None or not eye.iris_radius:
            continue
        x, y = eye.iris_center
        if 0 <= x <= frame.width and 0 <= y <= frame.height:
            n_eyes += 1
        im = _best_image(frame, side, eye.iris_center)
        if im is None:
            continue
        st = _eye_box_stats(im, eye.iris_center, eye.iris_radius)
        if st is not None:
            stats.append(st)
    out["eyes_in_frame"] = n_eyes
    out["edge_margin"] = _edge_margin(frame, obs)
    if stats:
        out["iris_px"] = float(np.mean([s["iris_px"] for s in stats]))
        out["brightness"] = float(np.mean([s["brightness"] for s in stats]))
        out["clipped"] = float(np.mean([s["clipped"] for s in stats]))
        sh = [s["sharpness"] for s in stats if "sharpness" in s]
        out["sharpness"] = float(np.mean(sh)) if sh else None
    return out


def predicted_motion_blur_px(frame: DecodedFrame) -> float | None:
    """Pixels the image smears during the exposure from the phone's own rotation."""
    rr = frame.frame.rotation_rate
    exp = frame.frame.lens.exposure_s
    if rr is None or exp is None or frame.intrinsics is None:
        return None
    w = float(np.hypot(rr[0], rr[1]))  # rotation about the optical axis smears less; ignored
    return float(w * exp * frame.intrinsics.fx)


class QualityEstimator:
    """[``quality``] Adds :func:`measure_quality` numbers and a usable / unusable verdict."""

    name = "quality"

    def __init__(self, config: Any = None) -> None:
        self.config = config

    def reset(self) -> None:
        pass

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        obs = previous if previous is not None else Observation.empty(frame)
        q = measure_quality(frame, obs)
        reasons = []
        if q["eyes_in_frame"] == 0:
            reasons.append("no_eyes")
        eyes = [e for e in (obs.left, obs.right) if e.iris_center is not None]
        if eyes and all(e.blink for e in eyes):
            reasons.append("blink")
        if q["motion_blur_px"] is not None and q["motion_blur_px"] > MOTION_BLUR_PX:
            reasons.append("motion_blur")
        if q["edge_margin"] is not None and q["edge_margin"] < 0.0:
            reasons.append("eyes_out_of_frame")
        for side in ("left", "right"):
            e = obs.eye(side)
            if e.iris_center is None:
                continue
            x, y = e.iris_center
            r = e.iris_radius or 0
            if x - r < 0 or y - r < 0 or x + r > frame.width or y + r > frame.height:
                if "eyes_out_of_frame" not in reasons:
                    reasons.append("eyes_out_of_frame")
        if q["brightness"] is not None and q["brightness"] < 25:
            reasons.append("too_dark")
        if q["clipped"] is not None and q["clipped"] > 0.25:
            reasons.append("overexposed")
        widths = [
            e.iris_edge_sharpness / e.iris_radius
            for e in (obs.left, obs.right)
            if e.iris_edge_sharpness is not None and e.iris_radius
        ]
        if widths and min(widths) > EDGE_WIDTH_FRACTION:
            reasons.append("out_of_focus")
        elif q["sharpness"] is not None and q["sharpness"] < MIN_SHARPNESS:
            reasons.append("out_of_focus")

        for key in ("iris_px", "sharpness", "brightness", "edge_margin", "clipped", "motion_blur_px"):
            if q[key] is not None:
                obs.quality[key] = float(q[key])
        obs.quality["eyes_in_frame"] = float(q["eyes_in_frame"])
        obs.quality["usable"] = 0.0 if reasons else 1.0
        for side in ("left", "right"):
            e = obs.eye(side)
            if e.iris_center is None or not e.iris_radius:
                continue
            im = _best_image(frame, side, e.iris_center)
            st = _eye_box_stats(im, e.iris_center, e.iris_radius) if im is not None else None
            if st and "sharpness" in st:
                obs.quality[f"sharpness_{side}"] = float(st["sharpness"])
        obs.provenance["quality"] = self.name
        obs.extra[self.name] = {"reasons": reasons}
        return obs
