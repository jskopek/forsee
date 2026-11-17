"""Lens, zoom, rotation and eye-crop logic for the frame loop. Owner: Core.

Pure functions and small stateful helpers, kept apart from ``pipeline.py`` so they can be tested
without a phone:

- :class:`UprightTracker`: the upright rotation with hysteresis (never flips on a flat phone or
  near a 45 degree boundary).
- :class:`RoiPlacer`: where to put the two native-resolution eye crops, from the latest
  observation, with padding, smoothing and a "moved enough to resend" test.
- :class:`ZoomController`: switches between 1x and the configured zoom when the eyes approach the
  frame edge (with hysteresis and a cooldown).
- :func:`aim_score`, :func:`aim_hints`, :func:`basic_quality`: comparing cameras and zooms, and
  plain-language advice for pointing the phone.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .types import (
    IRIS_DIAMETER_MM,
    SENSOR_AXES_IN_DEVICE,
    DecodedFrame,
    Observation,
    Rect,
    Rotation,
    rotate_vector2,
    upright_rotation,
)

DEFAULT_DISTANCE_M = 0.6

# --------------------------------------------------------------------------------------------
# Upright rotation with hysteresis
# --------------------------------------------------------------------------------------------


class UprightTracker:
    """Keeps a stable upright rotation.

    ``mode`` is ``"auto"`` (from gravity) or a fixed ``"0"``/``"90"``/``"180"``/``"270"``. In auto
    mode the rotation changes only when gravity, projected on the image, is at least
    ``min_g`` strong and within ``accept_deg`` of the new rotation's "down" (45 would be no
    hysteresis; 35 means gravity must be 10 degrees past the boundary).
    """

    def __init__(self, mode: str = "auto", min_g: float = 0.5, accept_deg: float = 35.0) -> None:
        self.mode = mode
        self.min_g = min_g
        self.accept_deg = accept_deg
        self.current: Rotation | None = None

    def reset(self) -> None:
        self.current = None

    def update(self, gravity: tuple[float, float, float] | None, position: str) -> Rotation:
        if self.mode != "auto":
            return int(self.mode)  # type: ignore[return-value]
        if gravity is None:
            return self.current if self.current is not None else 0
        u_axis, v_axis = SENSOR_AXES_IN_DEVICE.get(position, SENSOR_AXES_IN_DEVICE["back"])
        g = np.asarray(gravity, dtype=float)
        gu, gv = float(np.dot(g, u_axis)), float(np.dot(g, v_axis))
        strength = math.hypot(gu, gv)
        if strength < self.min_g:
            return self.current if self.current is not None else upright_rotation(gravity, position)
        candidate = upright_rotation(gravity, position)
        if self.current is None:
            self.current = candidate
            return candidate
        if candidate != self.current:
            x, y = rotate_vector2((gu, gv), candidate)
            off_deg = math.degrees(math.atan2(abs(x), y))
            if off_deg <= self.accept_deg:
                self.current = candidate
        return self.current


# --------------------------------------------------------------------------------------------
# Eye crops
# --------------------------------------------------------------------------------------------


def eye_centers(obs: Observation | None) -> dict[str, tuple[float, float]]:
    """Best available centre of each eye in upright full-frame pixels."""
    out: dict[str, tuple[float, float]] = {}
    if obs is None:
        return out
    for side in ("left", "right"):
        eye = obs.eye(side)
        for value in (eye.iris_center, eye.pupil_center):
            if value is not None:
                out[side] = (float(value[0]), float(value[1]))
                break
        else:
            if eye.inner_corner is not None and eye.outer_corner is not None:
                out[side] = (
                    (eye.inner_corner[0] + eye.outer_corner[0]) / 2,
                    (eye.inner_corner[1] + eye.outer_corner[1]) / 2,
                )
    return out


def estimate_distance(obs: Observation | None) -> float | None:
    """Metres from the camera to the eyes: the observation's own distance, else from iris size."""
    if obs is None:
        return None
    if obs.distance is not None and obs.distance > 0:
        return float(obs.distance)
    intr = obs.intrinsics
    radii = [e.iris_radius for e in (obs.left, obs.right) if e.iris_radius]
    if intr is None or not radii:
        return None
    r = float(np.median(radii))
    return float(intr.fx * IRIS_DIAMETER_MM / 1000.0 / (2.0 * r)) if r > 0 else None


@dataclass
class RoiPlan:
    rois: list[dict[str, Any]]
    """Wire ROIs: ``{"name", "x", "y", "w", "h"}`` normalised SENSOR rectangles."""
    upright: dict[str, Rect]
    """The same rectangles in upright full-frame pixels."""


class RoiPlacer:
    """Places ``left_eye``/``right_eye`` crops around the eyes (``roi_source = "mac"``)."""

    def __init__(self, width_mm: float = 30.0, aspect: float = 0.6, smoothing: float = 0.5, move_fraction: float = 0.1) -> None:
        self.width_mm = width_mm
        self.aspect = aspect
        self.smoothing = smoothing
        self.move_fraction = move_fraction
        self._centers: dict[str, tuple[float, float]] = {}
        self._width_px: float | None = None
        self.sent: dict[str, Rect] = {}

    def reset(self) -> None:
        self._centers.clear()
        self._width_px = None
        self.sent = {}

    def plan(self, decoded: DecodedFrame, obs: Observation | None) -> RoiPlan | None:
        """Rectangles for this frame, or ``None`` when no eye is known."""
        centers = eye_centers(obs)
        if not centers or decoded.intrinsics is None:
            return None
        distance = estimate_distance(obs) or DEFAULT_DISTANCE_M
        width_px = decoded.intrinsics.fx * (self.width_mm / 1000.0) / distance
        width_px = float(np.clip(width_px, 32, decoded.width / 2))
        a = self.smoothing
        self._width_px = width_px if self._width_px is None else a * self._width_px + (1 - a) * width_px
        for side, c in centers.items():
            old = self._centers.get(side)
            if old is None or math.hypot(c[0] - old[0], c[1] - old[1]) > self._width_px:
                self._centers[side] = c  # jump: no smoothing across a big move
            else:
                self._centers[side] = (a * old[0] + (1 - a) * c[0], a * old[1] + (1 - a) * c[1])
        w = self._width_px
        h = w * self.aspect
        upright: dict[str, Rect] = {}
        rois = []
        for side in ("left", "right"):
            c = self._centers.get(side)
            if c is None:
                continue
            x0 = float(np.clip(c[0] - w / 2, 0, max(0.0, decoded.width - w)))
            y0 = float(np.clip(c[1] - h / 2, 0, max(0.0, decoded.height - h)))
            rect = (x0, y0, w, h)
            upright[f"{side}_eye"] = rect
            nx, ny, nw, nh = decoded.rect_to_sensor_normalized(rect)
            nx, ny = max(0.0, nx), max(0.0, ny)
            nw, nh = min(nw, 1.0 - nx), min(nh, 1.0 - ny)
            rois.append({"name": f"{side}_eye", "x": round(nx, 5), "y": round(ny, 5), "w": round(nw, 5), "h": round(nh, 5)})
        return RoiPlan(rois, upright) if rois else None

    def should_send(self, plan: RoiPlan) -> bool:
        """True when a rectangle moved or resized by more than ``move_fraction`` of its size,
        or the set of rectangles changed."""
        if set(plan.upright) != set(self.sent):
            return True
        for name, rect in plan.upright.items():
            old = self.sent[name]
            tol = self.move_fraction * max(old[2], 1.0)
            if any(abs(a - b) > tol for a, b in zip(rect, old)):
                return True
        return False

    def mark_sent(self, plan: RoiPlan) -> None:
        self.sent = dict(plan.upright)


# --------------------------------------------------------------------------------------------
# Live zoom switching
# --------------------------------------------------------------------------------------------


def eye_margin(centers: dict[str, tuple[float, float]], width: float, height: float, zoom_ratio: float = 1.0) -> float | None:
    """Smallest distance (fraction of the frame) from an eye to the frame edge, if the image
    were zoomed by ``zoom_ratio`` about its centre."""
    if not centers:
        return None
    m = math.inf
    for x, y in centers.values():
        nx = 0.5 + (x / width - 0.5) * zoom_ratio
        ny = 0.5 + (y / height - 0.5) * zoom_ratio
        m = min(m, nx, 1 - nx, ny, 1 - ny)
    return float(m)


class ZoomController:
    """Decides when to switch between 1x and ``target`` zoom on the same camera.

    Zooms out at once when an eye is within ``edge_margin`` of the frame edge (or both eyes are
    lost for ``lost_s``); zooms back in when both eyes would sit at least ``2 * edge_margin`` from
    the edge at the target zoom for ``stable_s``. No switch within ``cooldown_s`` of the last.
    """

    def __init__(self, target: float = 2.0, edge_margin: float = 0.08, stable_s: float = 1.0, cooldown_s: float = 2.0, lost_s: float = 1.5) -> None:
        self.target = target
        self.edge_margin = edge_margin
        self.stable_s = stable_s
        self.cooldown_s = cooldown_s
        self.lost_s = lost_s
        self._last_switch = -math.inf
        self._good_since: float | None = None
        self._seen_at: float | None = None

    def note_switch(self, now: float) -> None:
        self._last_switch = now
        self._good_since = None

    def decide(self, obs: Observation | None, width: float, height: float, zoom: float, now: float) -> float | None:
        """The zoom to switch to, or ``None`` to stay."""
        if self.target <= 1.0 or now - self._last_switch < self.cooldown_s:
            return None
        centers = eye_centers(obs)
        if len(centers) == 2:
            self._seen_at = now
        zoomed_in = zoom > 1.0 + 1e-3
        if zoomed_in:
            margin = eye_margin(centers, width, height)
            lost = self._seen_at is None or now - self._seen_at > self.lost_s
            if (margin is not None and margin < self.edge_margin) or (lost and not centers):
                return 1.0
            return None
        if len(centers) < 2:
            self._good_since = None
            return None
        predicted = eye_margin(centers, width, height, self.target / max(zoom, 1e-3))
        if predicted is not None and predicted >= 2 * self.edge_margin:
            if self._good_since is None:
                self._good_since = now
            if now - self._good_since >= self.stable_s:
                return self.target
        else:
            self._good_since = None
        return None


# --------------------------------------------------------------------------------------------
# Aiming: scoring and hints
# --------------------------------------------------------------------------------------------


def basic_quality(decoded: DecodedFrame, obs: Observation | None) -> dict[str, Any]:
    """Core's own fallback for :func:`phonegaze.vision.quality.measure_quality` (same keys)."""
    centers = eye_centers(obs)
    radii = [e.iris_radius for e in (obs.left, obs.right)] if obs else []
    radii = [r for r in radii if r]
    q: dict[str, Any] = {
        "iris_px": float(2 * np.mean(radii)) if radii else None,
        "sharpness": None,
        "brightness": None,
        "eyes_in_frame": len(centers),
        "edge_margin": eye_margin(centers, decoded.width, decoded.height),
    }
    try:
        import cv2

        images = decoded.rois() or ([decoded.wide] if decoded.wide is not None else [])
        if images:
            grays = [im.gray for im in images]
            q["brightness"] = float(np.mean([g.mean() for g in grays]))
            # Laplacian variance per unit of full-frame scale, so crops and the downscaled frame compare.
            sharp = [float(cv2.Laplacian(g, cv2.CV_64F).var()) * (im.scale**2) for g, im in zip(grays, images)]
            q["sharpness"] = float(np.mean(sharp))
    except Exception:  # noqa: BLE001 - quality is advisory
        pass
    return q


def aim_score(quality: dict[str, Any], *, adjusting_focus: bool | None = None) -> float:
    """Higher is better. Iris size in pixels matters most; out-of-frame or blurry loses.

    ``score = iris_px * sharp_factor * eyes_factor * margin_factor``.
    """
    iris = quality.get("iris_px") or 0.0
    eyes = int(quality.get("eyes_in_frame") or 0)
    if iris <= 0 or eyes == 0:
        return 0.0
    eyes_factor = 1.0 if eyes >= 2 else 0.4
    sharp = quality.get("sharpness")
    sharp_factor = 1.0 if sharp is None else float(min(1.0, max(0.1, math.log10(1.0 + sharp) / 2.5)))
    margin = quality.get("edge_margin")
    margin_factor = 1.0 if margin is None else float(min(1.0, max(0.0, margin / 0.08)) ** 0.5)
    focus_factor = 0.7 if adjusting_focus else 1.0
    return float(iris * sharp_factor * eyes_factor * max(margin_factor, 0.05) * focus_factor)


def aim_hints(obs: Observation | None, quality: dict[str, Any], width: float, height: float, *, adjusting_focus: bool | None = None, min_iris_px: float = 40.0) -> list[str]:
    """Plain-language advice for pointing the phone. Empty when everything looks fine.

    Direction words assume an unmirrored camera facing the person (the back camera): the
    picture's right is the person's left.
    """
    hints: list[str] = []
    centers = eye_centers(obs)
    if not centers:
        b = quality.get("brightness")
        if b is not None and b < 35:
            return ["It is too dark to see your face: add light in front of you."]
        return ["No eyes found: point the phone at your face."]
    if len(centers) == 1:
        hints.append("Only one eye is visible: move so both eyes are in the picture.")
    xs = [c[0] / width for c in centers.values()]
    ys = [c[1] / height for c in centers.values()]
    cx, cy = float(np.mean(xs)), float(np.mean(ys))
    if cx > 0.65:
        hints.append("Your eyes are near the right of the picture: turn the phone a little towards your left.")
    elif cx < 0.35:
        hints.append("Your eyes are near the left of the picture: turn the phone a little towards your right.")
    if cy < 0.3:
        hints.append("Your eyes are near the top of the picture: tilt the phone up a little.")
    elif cy > 0.7:
        hints.append("Your eyes are near the bottom of the picture: tilt the phone down a little.")
    iris = quality.get("iris_px")
    if iris is not None and iris < min_iris_px:
        hints.append(f"Your irises are small in the picture ({iris:.0f} px): move closer or zoom in.")
    margin = quality.get("edge_margin")
    if margin is not None and margin < 0.03 and len(centers) == 2:
        hints.append("Your eyes are at the edge of the picture: move back a little or zoom out.")
    b = quality.get("brightness")
    if b is not None and b < 60:
        hints.append("Too dark: add light in front of you.")
    elif b is not None and b > 210:
        hints.append("Too bright: the picture is washed out.")
    if adjusting_focus:
        hints.append("Focusing...")
    else:
        s = quality.get("sharpness")
        if s is not None and s < 15:
            hints.append("The picture looks blurry: click an eye in the preview to focus there.")
    return hints


def pick_cameras(cameras: list[dict[str, Any]], position: str | None = None) -> list[dict[str, Any]]:
    """Cameras worth trying when aiming, best first: back wide, front wide, ultrawide, tele, ARKit
    last (it has its own estimator)."""
    order = {"wide": 0, "ultrawide": 2, "tele": 3, "arkit": 4}
    # The LiDAR entry is the wide camera again with a depth map ("type": "wide", "depthSource":
    # "lidar"); trying it would repeat the wide camera at a lower frame rate.
    out = [c for c in cameras if (position is None or c.get("position") == position) and c.get("depthSource") != "lidar"]
    return sorted(out, key=lambda c: (order.get(c.get("type", ""), 5), 0 if c.get("position") == "back" else 1))


def zoom_options(camera: dict[str, Any], wanted: list[float] | None = None) -> list[float]:
    """Zooms to try on ``camera``: the requested ones, else 1 and 2 (and the camera's presets up
    to 3x). ARKit only has 1."""
    if camera.get("type") == "arkit":
        return [1.0]
    if wanted:
        return sorted({float(z) for z in wanted if z >= 1.0})
    zooms = {1.0, 2.0}
    for z in camera.get("zoomPresets") or []:
        try:
            if 1.0 <= float(z) <= 3.0:
                zooms.add(round(float(z), 3))
        except (TypeError, ValueError):
            continue
    return sorted(zooms)


# --------------------------------------------------------------------------------------------
# Phone camera controls (POST /api/lens)
# --------------------------------------------------------------------------------------------

LENS_CONTROL_SETTINGS = (
    "lens.exposure_bias",
    "lens.max_exposure_ms",
    "lens.focus_locked",
    "lens.exposure_locked",
    "lens.white_balance_locked",
    "lens.face_driven_autofocus",
)
"""Settings sent to the phone with ``POST /api/lens`` (PROTOCOL.md)."""


def lens_controls_body(lens: Any, paths: list[str] | tuple[str, ...] | None = None, only_non_default: bool = False) -> dict[str, Any]:
    """The ``/api/lens`` body for ``config.lens``. ``paths``: only these settings (default: all
    of :data:`LENS_CONTROL_SETTINGS`); ``only_non_default``: leave out settings at their
    "leave it to the phone" value (used on connect, so a fresh phone keeps its own defaults)."""
    wanted = set(paths or LENS_CONTROL_SETTINGS)
    body: dict[str, Any] = {}
    if "lens.exposure_bias" in wanted:
        v = float(getattr(lens, "exposure_bias", 0.0))
        if v != 0.0 or not only_non_default:
            body["exposureBias"] = v
    if "lens.max_exposure_ms" in wanted:
        v = float(getattr(lens, "max_exposure_ms", 0.0))
        if v > 0:
            body["maxExposureS"] = v / 1000.0
        elif not only_non_default:
            body["maxExposureS"] = None
    if "lens.focus_locked" in wanted:
        v = getattr(lens, "focus_locked", "default")
        if v in ("locked", "continuous"):
            body["focusLocked"] = v == "locked"
    for path, key in (("lens.exposure_locked", "exposureLocked"), ("lens.white_balance_locked", "whiteBalanceLocked")):
        if path in wanted:
            v = bool(getattr(lens, path.split(".", 1)[1], False))
            if v or not only_non_default:
                body[key] = v
    if "lens.face_driven_autofocus" in wanted:
        v = getattr(lens, "face_driven_autofocus", "default")
        if v in ("on", "off"):
            body["faceDrivenAutoFocus"] = v == "on"
    return body


def camera_for_preference(cameras: list[dict[str, Any]], prefer: str) -> dict[str, Any] | None:
    """The camera ``lens.camera_prefer`` asks for, from ``/api/status`` ``cameras``."""
    if prefer == "arkit":
        return next((c for c in cameras if c.get("type") == "arkit"), None)
    if prefer == "front":
        return next((c for c in pick_cameras(cameras, "front") if c.get("type") != "arkit"), None)
    if prefer == "back":
        back = pick_cameras(cameras, "back")
        return next((c for c in back if c.get("type") == "wide"), None) or (back[0] if back else None)
    return None
