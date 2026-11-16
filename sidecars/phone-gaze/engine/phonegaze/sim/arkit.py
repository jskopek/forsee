"""The ``arkit`` block of a simulated ARKit frame (PROTOCOL.md "ARKit spaces"). Owner: Simulator.

Built from the scene's truth in exactly the spaces and layout the iPhone app writes:

- ARKit camera: +x along the sensor image's +u, +y up the image (-v), +z towards the viewer.
  From engine sensor-camera coordinates: ``diag(1, -1, -1)``.
- ARKit world: y up against gravity (the app's world alignment), an arbitrary origin and yaw.
- ``face``: face -> world; origin behind the nose, +x the person's left, +y up, +z out of the face.
- ``leftEye`` / ``rightEye``: eye -> face; origin at the eyeball centre, +z along the gaze.
- Matrices are 16 numbers, column-major (translation in elements 12, 13, 14).

Noise and bias (``Knobs.arkit_*``) are applied to what ARKit reports, never to the truth.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import numpy as np

from ..types import rotation_3d
from .person import normalize, rot_x, rot_y, ypr_matrix

if TYPE_CHECKING:  # pragma: no cover
    from .scene import Capture, SimScene

FLIP = np.diag([1.0, -1.0, -1.0])
FACE_ORIGIN_HEAD = np.array([0.0, 0.025, 0.025])  # 2.5 cm below and behind the eyes
ARKIT_WORLD_ORIGIN = np.array([0.031, -0.012, 0.047])  # where the session started, arbitrary
ARKIT_WORLD_YAW_DEG = 23.0


def col_major(m: np.ndarray) -> list[float]:
    return [float(v) for v in np.asarray(m, dtype=float).T.reshape(-1)]


def homogeneous(R: np.ndarray, t: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = t
    return m


def world_to_arkit_camera(cam_R: np.ndarray, cam_t: np.ndarray, orientation: int) -> np.ndarray:
    """4x4 map from the sim's world (rig frame) to ARKit camera space."""
    A = FLIP @ rotation_3d(orientation).T @ cam_R.T  # type: ignore[arg-type]
    return homogeneous(A, -A @ cam_t)


def arkit_camera_to_world(gravity_arcam: np.ndarray) -> np.ndarray:
    """ARKit camera -> ARKit world for a world whose y is up (against gravity)."""
    y = -normalize(gravity_arcam)
    ref = np.array([1.0, 0.0, 0.0]) if abs(y[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    x = normalize(ref - y * (ref @ y))
    z = np.cross(x, y)
    W = np.stack([x, y, z], axis=0)  # rows: world axes in camera coords -> maps cam -> world
    W = rot_y(math.radians(ARKIT_WORLD_YAW_DEG)) @ W  # arbitrary heading about world up
    return homogeneous(W, ARKIT_WORLD_ORIGIN)


def _eye_rotation(z: np.ndarray) -> np.ndarray:
    z = normalize(z)
    x = normalize(np.array([1.0, 0.0, 0.0]) - z * z[0])
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


def arkit_block(scene: SimScene, cap: Capture) -> dict[str, Any]:
    st = cap.state
    k = scene.knobs
    rng = scene.rng
    w2c = world_to_arkit_camera(st.cam_R, st.cam_t, cap.orientation)
    g_arcam = w2c[:3, :3] @ scene.gravity_world
    cam = arkit_camera_to_world(g_arcam)  # ARKit camera -> ARKit world
    w2arw = cam @ w2c  # sim world -> ARKit world

    # Face: head pose with ARKit's axes and origin, plus tracking noise.
    R_face = st.head_R @ FLIP
    p_face = st.head_t + st.head_R @ FACE_ORIGIN_HEAD
    if k.arkit_head_noise_deg > 0:
        n = rng.normal(0, k.arkit_head_noise_deg, 3)
        R_face_rep = R_face @ ypr_matrix(*n)
    else:
        R_face_rep = R_face
    p_face_rep = p_face + rng.normal(0, k.arkit_head_noise_mm / 1000.0, 3) if k.arkit_head_noise_mm > 0 else p_face
    face_world = homogeneous(R_face_rep, p_face_rep)
    face = w2arw @ face_world

    eyes: dict[str, np.ndarray] = {}
    gaze_face: list[np.ndarray] = []
    centres_face: list[np.ndarray] = []
    blend: dict[str, float] = {}
    for side in ("left", "right"):
        eye = st.eyes[side]
        # Eyes relative to the TRUE face, then reported on the NOISY face (``face`` above): as on a
        # device, where ARKit's eye transforms sit at fixed spots of its face model, face-tracking
        # jitter and bias reach the eye centres and directions instead of cancelling out.
        c_f = R_face.T @ (eye.center - p_face) + np.asarray(k.arkit_eye_offset_mm, float) / 1000.0
        g_f = R_face.T @ eye.visual
        if k.arkit_gaze_gain != 1.0:
            g_yaw = math.atan2(g_f[0], g_f[2]) * k.arkit_gaze_gain
            g_pitch = math.asin(max(-1.0, min(1.0, float(g_f[1])))) * k.arkit_gaze_gain
            g_f = np.array([math.cos(g_pitch) * math.sin(g_yaw), math.sin(g_pitch), math.cos(g_pitch) * math.cos(g_yaw)])
        bias_yaw, bias_pitch = k.arkit_eye_bias_deg
        R_bias = rot_y(math.radians(bias_yaw)) @ rot_x(-math.radians(bias_pitch))
        g_rep = R_bias @ g_f
        if k.arkit_eye_noise_deg > 0:
            n = np.radians(rng.normal(0, k.arkit_eye_noise_deg, 2))
            g_rep = rot_y(float(n[0])) @ rot_x(float(n[1])) @ g_rep
        eyes[side] = homogeneous(_eye_rotation(g_rep), c_f)
        gaze_face.append(normalize(g_rep))
        centres_face.append(c_f)
        yaw = math.degrees(math.atan2(g_rep[0], g_rep[2]))  # towards face +x (the person's left)
        pitch = math.degrees(math.asin(max(-1.0, min(1.0, float(g_rep[1])))))  # up
        out_amt = yaw if side == "left" else -yaw
        blend[f"blink_{side}"] = float(min(1.0, st.blink))
        blend[f"look_out_{side}"] = float(np.clip(out_amt / 35.0, 0, 1))
        blend[f"look_in_{side}"] = float(np.clip(-out_amt / 35.0, 0, 1))
        blend[f"look_up_{side}"] = float(np.clip(pitch / 25.0, 0, 1))
        blend[f"look_down_{side}"] = float(np.clip(-pitch / 25.0, 0, 1))
        blend[f"squint_{side}"] = 0.0
        blend[f"wide_{side}"] = 0.0
    mid = 0.5 * (centres_face[0] + centres_face[1])
    gz = normalize(gaze_face[0] + gaze_face[1])
    target = scene.person.look_point
    dist = float(np.linalg.norm(target - 0.5 * (st.eyes["left"].center + st.eyes["right"].center)))
    look_at = mid + gz * dist

    # Eye centres in sensor pixels.
    pix: dict[str, list[float]] = {}
    R3 = rotation_3d(cap.orientation)  # type: ignore[arg-type]
    for side in ("left", "right"):
        p_up = st.cam_R.T @ (st.eyes[side].center - st.cam_t)
        p_s = R3.T @ p_up
        if p_s[2] > 0:
            pix[side] = list(cap.K_sensor.project(tuple(p_s)))  # type: ignore[arg-type]
    tracked = bool(k.arkit_tracked)
    block: dict[str, Any] = {
        "tracked": tracked,
        "face": col_major(face),
        "leftEye": col_major(eyes["left"]),
        "rightEye": col_major(eyes["right"]),
        "camera": col_major(cam),
        "lookAt": [float(v) for v in look_at],
        "blendShapes": {k_: round(v, 4) for k_, v in sorted(blend.items())},
    }
    if tracked and len(pix) == 2:
        block["eyePixels"] = pix
    return block
