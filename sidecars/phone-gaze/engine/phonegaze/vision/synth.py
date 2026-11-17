"""Synthetic eye images with known ground truth, for the Vision tests and benchmarks. Owner: Vision.

Not a face renderer (MediaPipe will not find a face here); it draws one eye region: skin, an
almond-shaped opening of low-saturation sclera, an elliptical iris with a pupil, an optional
screen reflection (a bright rounded rectangle) and optional distractor highlights. Edges are
anti-aliased analytically so sub-pixel ground truth is exact. Coordinates are continuous pixels
(pixel centre at +0.5), as in ``types.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class EyeSpec:
    width: int = 320
    height: int = 200
    iris_center: tuple[float, float] = (160.0, 100.0)
    iris_radius: float = 50.0
    """Semi-major axis of the iris ellipse, pixels."""
    iris_ratio: float = 1.0
    """Minor / major axis ratio (1 = frontal)."""
    iris_angle: float = 0.0
    """Major axis angle, degrees from +x towards +y."""
    eye_center: tuple[float, float] | None = None
    """Centre of the eye opening (defaults to the iris centre)."""
    opening_half_width: float | None = None
    opening_half_height: float | None = None
    iris_bgr: tuple[int, int, int] = (40, 60, 90)
    pupil_bgr: tuple[int, int, int] = (15, 15, 15)
    pupil_frac: float = 0.4
    sclera_bgr: tuple[int, int, int] = (180, 185, 190)
    skin_bgr: tuple[int, int, int] = (110, 140, 200)
    reflection_center: tuple[float, float] | None = None
    reflection_size: tuple[float, float] = (17.0, 11.0)
    reflection_gain: float = 1.0
    """0 = no reflection, 1 = full brightness (used for coded flashes)."""
    reflection_level: float = 235.0
    distractors: list[tuple[float, float, float, float]] = field(default_factory=list)
    """Extra highlights: ``(x, y, radius, level)``."""
    noise: float = 2.0
    blur: float = 0.0
    seed: int = 0


def _smooth_step(signed_dist: np.ndarray, width: float = 1.0) -> np.ndarray:
    """1 inside (negative distance), 0 outside, linear over ``width`` pixels (box-filtered edge)."""
    return np.clip(0.5 - signed_dist / width, 0.0, 1.0)


def render_eye(spec: EyeSpec) -> np.ndarray:
    """BGR uint8 image of one eye."""
    h, w = spec.height, spec.width
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    xx += 0.5
    yy += 0.5
    img = np.empty((h, w, 3), np.float64)
    img[:] = spec.skin_bgr

    ex, ey = spec.eye_center or spec.iris_center
    hw = spec.opening_half_width or 2.6 * spec.iris_radius
    hh = spec.opening_half_height or 0.95 * spec.iris_radius
    # Almond: |y - ey| < hh * (1 - (x/hw)^2)
    nx = (xx - ex) / hw
    lid = hh * (1 - nx**2)
    open_mask = _smooth_step(np.abs(yy - ey) - lid) * (np.abs(nx) < 1)

    cx, cy = spec.iris_center
    a = spec.iris_radius
    b = a * spec.iris_ratio
    t = np.radians(spec.iris_angle)
    dx, dy = xx - cx, yy - cy
    u = dx * np.cos(t) + dy * np.sin(t)
    v = -dx * np.sin(t) + dy * np.cos(t)
    rn = np.hypot(u / a, v / b)
    iris_mask = _smooth_step((rn - 1) * (a + b) / 2)
    pupil_mask = _smooth_step((rn - spec.pupil_frac) * (a + b) / 2)

    eye_layer = np.empty_like(img)
    eye_layer[:] = spec.sclera_bgr
    for c in range(3):
        col = eye_layer[..., c]
        col[:] = col * (1 - iris_mask) + spec.iris_bgr[c] * iris_mask
        col[:] = col * (1 - pupil_mask) + spec.pupil_bgr[c] * pupil_mask

    if spec.reflection_center is not None and spec.reflection_gain > 0:
        rx, ry = spec.reflection_center
        sw, sh = spec.reflection_size
        corner = min(sw, sh) * 0.15
        qx = np.maximum(np.abs(xx - rx) - (sw / 2 - corner), 0)
        qy = np.maximum(np.abs(yy - ry) - (sh / 2 - corner), 0)
        dist = np.hypot(qx, qy) - corner
        m = _smooth_step(dist) * spec.reflection_gain
        eye_layer = eye_layer * (1 - m[..., None]) + spec.reflection_level * m[..., None]
    for x, y, r, level in spec.distractors:
        m = _smooth_step(np.hypot(xx - x, yy - y) - r)
        eye_layer = eye_layer * (1 - m[..., None]) + level * m[..., None]

    img = img * (1 - open_mask[..., None]) + eye_layer * open_mask[..., None]
    if spec.blur > 0:
        img = cv2.GaussianBlur(img, (0, 0), spec.blur)
    if spec.noise > 0:
        img = img + np.random.default_rng(spec.seed).normal(0, spec.noise, img.shape)
    return np.clip(np.round(img), 0, 255).astype(np.uint8)


def make_frame(
    images: dict[str, tuple[np.ndarray, tuple[float, float]]],
    width: int = 3840,
    height: int = 2160,
    fx: float = 6000.0,
    seq: int = 0,
    t: float = 0.0,
    t_received: float | None = None,
    wide: np.ndarray | None = None,
    arkit=None,
    rotation_rate=None,
    exposure_s: float | None = None,
):
    """A :class:`~phonegaze.types.DecodedFrame` built directly from upright pixels, no JPEG.

    ``images`` maps a ROI name to ``(pixels, (x, y))``: a native-resolution crop whose top-left
    corner is at upright full-frame pixel ``(x, y)``. ``wide`` is an optional downscaled whole
    frame (any size; it is mapped onto the full frame). Rotation 0, so sensor == upright.
    """
    from ..types import CameraInfo, DecodedFrame, DecodedImage, Frame, Intrinsics, LensState

    intr = Intrinsics(fx, fx, width / 2, height / 2, width, height)
    cam = CameraInfo("synthetic", "back", "wide", 1.0, width, height, intr, "sim")
    frame = Frame(
        seq=seq,
        t=t,
        mode="arkit" if arkit is not None else "camera",
        camera=cam,
        lens=LensState(exposure_s=exposure_s),
        gravity=None,
        rotation_rate=rotation_rate,
        parts=[],
        arkit=arkit,
        t_received=t if t_received is None else t_received,
    )
    decoded: dict[str, DecodedImage] = {}
    for name, (pix, (x0, y0)) in images.items():
        h, w = pix.shape[:2]
        to_full = np.array([[1.0, 0, x0], [0, 1.0, y0], [0, 0, 1]])
        decoded[name] = DecodedImage(name, "roi", pix, to_full, (float(x0), float(y0), float(w), float(h)))
    if wide is not None:
        h, w = wide.shape[:2]
        to_full = np.array([[width / w, 0, 0], [0, height / h, 0], [0, 0, 1]])
        decoded["wide"] = DecodedImage("wide", "wide", wide, to_full, (0.0, 0.0, float(width), float(height)))
    return DecodedFrame(
        frame=frame,
        rotation=0,
        width=width,
        height=height,
        intrinsics=intr,
        images=decoded,
        sensor_to_upright=np.eye(3),
        sensor_to_upright_3d=np.eye(3),
    )
