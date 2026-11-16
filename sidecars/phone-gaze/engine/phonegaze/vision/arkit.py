"""ARKit estimator: the phone's face-tracking block -> engine camera coordinates. Owner: Vision.

Spaces (PROTOCOL.md "ARKit spaces"): ``face`` maps face space to ARKit world, ``camera`` maps the
ARKit camera to world, ``left_eye``/``right_eye`` map each eye to face space and look along +z.
ARKit's camera has +x along the sensor image's +u, +y up the image and +z towards the viewer;
the engine's sensor camera frame is ``diag(1, -1, -1)`` of that, and
``DecodedFrame.sensor_to_upright_3d`` turns it upright. This module is the only place that
conversion happens (:func:`arkit_to_engine`).

Fills, per eye: ``found``, ``eyeball_center``, ``gaze_dir`` (ARKit's eye +z: an optical-axis-like
direction ARKit reports, uncalibrated), ``blink``, ``openness`` (rough, from the blink blend
shape), and a rough ``iris_center``/``iris_radius`` projected from the eye model so the iris edge
estimator has a seed. Whole face: ``head_rotation``, ``head_position``, ``distance``.

Only ever tested on hand-made matrices; the axis conventions have not been checked on a device.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from ..types import ArkitData, DecodedFrame, Observation, apply_affine
from .geometry import EYE_IRIS_DISTANCE_M, FLIP_YZ, IRIS_RADIUS_M, head_angles_deg, orthonormalize

BLINK_THRESHOLD = 0.5
"""Blink blend shape above which the eye counts as closed."""

OPEN_OPENNESS = 0.3
"""Openness reported for a fully open eye (blink shape 0); the scale of ``EyeObs.openness``."""


def arkit_to_engine(ar: ArkitData, sensor_to_upright_3d: np.ndarray) -> dict[str, Any] | None:
    """Convert one ARKit block. Returns ``None`` when the face or camera matrix is missing.

    Result keys (all upright engine camera coordinates, metres): ``head_rotation`` (3x3, head
    frame -> camera), ``face_origin`` (3,), and per side ``"left"``/``"right"`` either ``None``
    or ``{"center": (3,), "gaze": (3,) unit}``; ``look_at_dir`` (3,) or ``None``.
    """
    if ar.face is None or ar.camera is None:
        return None
    up = np.asarray(sensor_to_upright_3d, float)
    cam_from_face = np.linalg.inv(ar.camera) @ ar.face  # face -> ARKit camera
    to_engine = up @ FLIP_YZ  # ARKit camera axes -> upright engine camera axes

    r_cf = orthonormalize(cam_from_face[:3, :3])
    # Head frame (x to the person's left, y down, z into the head) = face frame with y, z flipped.
    head_rotation = to_engine @ r_cf @ FLIP_YZ
    face_origin = to_engine @ cam_from_face[:3, 3]

    out: dict[str, Any] = {"head_rotation": head_rotation, "face_origin": face_origin}
    for side, m in (("left", ar.left_eye), ("right", ar.right_eye)):
        if m is None:
            out[side] = None
            continue
        cam_from_eye = cam_from_face @ m
        center = to_engine @ cam_from_eye[:3, 3]
        gaze = to_engine @ orthonormalize(cam_from_eye[:3, :3]) @ np.array([0.0, 0.0, 1.0])
        out[side] = {"center": center, "gaze": gaze / np.linalg.norm(gaze)}
    out["look_at_dir"] = None
    if ar.look_at is not None:
        v = np.asarray(ar.look_at, float)
        n = np.linalg.norm(v)
        if n > 1e-9:
            out["look_at_dir"] = to_engine @ r_cf @ (v / n)
    return out


class ArkitEstimator:
    """[``arkit``] Eye and head geometry from ARKit. Does nothing without an ``arkit`` block."""

    name = "arkit"

    def __init__(self, config: Any = None) -> None:
        self.config = config

    def reset(self) -> None:
        pass

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        ar = frame.frame.arkit
        if ar is None or not ar.tracked:
            return None
        conv = arkit_to_engine(ar, frame.sensor_to_upright_3d)
        if conv is None:
            return None
        obs = previous if previous is not None else Observation.empty(frame)
        n = self.name
        hr = conv["head_rotation"]
        obs.set("head_rotation", [[float(v) for v in row] for row in hr], n)

        centers = []
        intr = frame.intrinsics
        for side in ("left", "right"):
            e = conv[side]
            eye = obs.eye(side)
            blink = ar.blend_shapes.get(f"blink_{side}")
            if blink is not None:
                obs.set(f"{side}.blink", bool(blink > BLINK_THRESHOLD), n)
                obs.set(f"{side}.openness", float(OPEN_OPENNESS * (1.0 - min(max(blink, 0.0), 1.0))), n)
            if e is None:
                continue
            c, g = e["center"], e["gaze"]
            centers.append(c)
            obs.set(f"{side}.found", True, n)
            obs.set(f"{side}.eyeball_center", tuple(float(v) for v in c), n)
            obs.set(f"{side}.gaze_dir", tuple(float(v) for v in g), n)
            if eye.confidence is None:
                obs.set(f"{side}.confidence", 0.8 if not eye.blink else 0.3, n)
            eye.extra["gaze_kind"] = "arkit_eye_z"
            px = ar.eye_pixels.get(side)
            if px is not None:
                eye.extra["arkit_eye_pixel"] = list(apply_affine(frame.sensor_to_upright, px))
            # Seed for the iris edge estimator: iris centre and size from the eye model.
            if intr is not None:
                p = c + EYE_IRIS_DISTANCE_M * g
                if p[2] > 0.01:
                    uv = intr.project((float(p[0]), float(p[1]), float(p[2])))
                    if eye.iris_center is None:
                        obs.set(f"{side}.iris_center", (float(uv[0]), float(uv[1])), n)
                        obs.set(f"{side}.iris_radius", float(intr.fx * IRIS_RADIUS_M / p[2]), n)

        if len(centers) == 2:
            hp = (centers[0] + centers[1]) / 2
        else:
            hp = conv["face_origin"]
        obs.set("head_position", tuple(float(v) for v in hp), n)
        obs.set("distance", float(np.linalg.norm(hp)), n)

        extra: dict[str, Any] = {"head_angles_deg": head_angles_deg(hr)}
        if conv["look_at_dir"] is not None:
            extra["look_at_dir"] = [float(v) for v in conv["look_at_dir"]]
        extra["blend_shapes"] = dict(ar.blend_shapes)
        obs.extra[n] = extra
        if intr is not None and len(centers) == 2:
            # Rough face box from the eye positions (useful for overlays and ROI placement).
            uvs = [intr.project(tuple(float(v) for v in c)) for c in centers]
            span = math.hypot(uvs[0][0] - uvs[1][0], uvs[0][1] - uvs[1][1])
            cx, cy = (uvs[0][0] + uvs[1][0]) / 2, (uvs[0][1] + uvs[1][1]) / 2
            if obs.face_rect is None and span > 1:
                obs.set("face_rect", (cx - 1.25 * span, cy - 0.9 * span, 2.5 * span, 2.8 * span), n)
        return obs
