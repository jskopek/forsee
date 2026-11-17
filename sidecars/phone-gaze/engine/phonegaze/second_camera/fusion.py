"""What the second camera does to phone observations, once the phone's pose relative to the
webcam is known (``P = webcam_from_phone``):

- :func:`to_reference`: re-express an observation as if the phone were still where it was when
  the models were calibrated (option ``track_phone``). Pixel positions are moved through 3D at
  the eye's depth and re-projected with the same intrinsics, so every model (also the
  pixel-feature ones) sees the old viewpoint, approximately.
- :func:`triangulate`: eye positions and distance from both cameras (``distance_source``).
- :func:`replace_head_pose`: head rotation and position from the webcam or fused
  (``head_pose_source``).
- :func:`predicted_eyes`: where the webcam says the eyes are in the phone image
  (``wide_head_box``).
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any

import numpy as np

from ..types import EyeObs, Intrinsics, Observation
from ..vision.geometry import EYEBALL_BEHIND_CORNERS_M
from .geometry import Pose, average_two_rotations, closest_on_first_ray

NAME = "second_camera"


def clone(obs: Observation) -> Observation:
    """A copy whose fields can be changed without touching ``obs`` (shallow where safe)."""
    return dataclasses.replace(
        obs,
        left=dataclasses.replace(obs.left, extra=dict(obs.left.extra)),
        right=dataclasses.replace(obs.right, extra=dict(obs.right.extra)),
        quality=dict(obs.quality),
        estimators=list(obs.estimators),
        provenance=dict(obs.provenance),
        extra=dict(obs.extra),
    )


def _v(x: Any) -> np.ndarray | None:
    if x is None:
        return None
    a = np.asarray(x, float)
    return a if np.all(np.isfinite(a)) else None


def _move_pixel(intr: Intrinsics, uv: Any, depth: float, m: Pose) -> tuple[float, float] | None:
    if uv is None or depth <= 0:
        return None
    rx, ry = intr.ray(float(uv[0]), float(uv[1]))
    p = m.apply(np.array([rx * depth, ry * depth, depth]))
    if p[2] <= 1e-6:
        return None
    u, v = intr.project((float(p[0]), float(p[1]), float(p[2])))
    return (float(u), float(v))


def to_reference(obs: Observation, m: Pose) -> Observation:
    """``obs`` (current phone camera coordinates) re-expressed in a reference phone frame, where
    ``m = reference_from_current``. 3D values are transformed exactly; pixels are moved at the
    depth of their eye (the eyeball centre's z, or the distance)."""
    out = clone(obs)
    intr = obs.intrinsics
    head_depth = None
    if obs.head_position is not None:
        head_depth = float(obs.head_position[2])
    elif obs.distance:
        head_depth = float(obs.distance)
    for side in ("left", "right"):
        e: EyeObs = out.eye(side)
        c = _v(e.eyeball_center)
        depth = float(c[2]) if c is not None else head_depth
        if c is not None:
            e.eyeball_center = tuple(float(v) for v in m.apply(c))  # type: ignore[assignment]
        g = _v(e.gaze_dir)
        if g is not None:
            e.gaze_dir = tuple(float(v) for v in m.rotate(g))  # type: ignore[assignment]
        if intr is None or not depth:
            continue
        # the iris sits ~10 mm in front of the eyeball centre along the gaze (else: towards the
        # camera); corners about as far
        g0 = _v(obs.eye(side).gaze_dir)
        d_front = max(depth + (0.0102 * float(g0[2]) if g0 is not None else -0.01), 0.05)
        new_depth = None
        if e.iris_center is not None:
            rx, ry = intr.ray(*e.iris_center)
            new_depth = float(m.apply(np.array([rx * d_front, ry * d_front, d_front]))[2])
        for name in ("iris_center", "pupil_center", "inner_corner", "outer_corner", "reflection_center"):
            uv = getattr(e, name)
            if uv is not None:
                setattr(e, name, _move_pixel(intr, uv, d_front, m))
        if e.reflection_corners is not None:
            e.reflection_corners = [_move_pixel(intr, uv, d_front, m) or uv for uv in e.reflection_corners]
        scale = d_front / new_depth if new_depth else 1.0
        if e.iris_radius is not None:
            e.iris_radius = float(e.iris_radius * scale)
        if e.iris_ellipse is not None and e.iris_center is not None:
            cx, cy, a, b, ang = e.iris_ellipse
            moved = _move_pixel(intr, (cx, cy), d_front, m) or (cx, cy)
            e.iris_ellipse = (moved[0], moved[1], a * scale, b * scale, ang)
    if obs.head_rotation is not None:
        out.head_rotation = (m.R @ np.asarray(obs.head_rotation, float)).tolist()
    hp = _v(obs.head_position)
    if hp is not None:
        out.head_position = tuple(float(v) for v in m.apply(hp))  # type: ignore[assignment]
    if obs.distance is not None:
        ref = _v(out.head_position)
        if ref is not None:
            out.distance = float(np.linalg.norm(ref))
    if intr is not None and obs.face_rect is not None and head_depth:
        x, y, w, h = obs.face_rect
        a = _move_pixel(intr, (x, y), head_depth, m)
        b = _move_pixel(intr, (x + w, y + h), head_depth, m)
        if a and b:
            out.face_rect = (min(a[0], b[0]), min(a[1], b[1]), abs(b[0] - a[0]), abs(b[1] - a[1]))
    out.extra[NAME] = {**(obs.extra.get(NAME) or {}), "to_reference": {"angle_deg": m.angle_deg(), "shift_m": float(np.linalg.norm(m.t))}}
    return out


def _corner_mid(e: EyeObs) -> tuple[float, float] | None:
    if e.inner_corner is None or e.outer_corner is None:
        return None
    return ((e.inner_corner[0] + e.outer_corner[0]) / 2, (e.inner_corner[1] + e.outer_corner[1]) / 2)


def _ray(intr: Intrinsics, uv: tuple[float, float]) -> np.ndarray:
    rx, ry = intr.ray(*uv)
    d = np.array([rx, ry, 1.0])
    return d / np.linalg.norm(d)


def triangulate(phone: Observation, webcam: Observation, p_wp: Pose, max_gap_m: float = 0.03) -> dict[str, Any] | None:
    """Each eye's corner midpoint triangulated from both cameras, as the point on the PHONE's
    ray (the sharper view sets the direction) closest to the webcam's ray. Returns
    ``{"points": {side: xyz (phone coordinates)}, "gaps": {side: m}, "phone_mid": {side: xyz}}``
    or ``None`` when either camera lacks the corners or the rays miss each other."""
    if phone.intrinsics is None or webcam.intrinsics is None:
        return None
    p_pw = p_wp.inverse()
    o_w = p_pw.t  # webcam centre in phone coordinates
    head_r = np.asarray(phone.head_rotation, float) if phone.head_rotation is not None else None
    out: dict[str, Any] = {"points": {}, "gaps": {}, "phone_mid": {}}
    for side in ("left", "right"):
        a, b = _corner_mid(phone.eye(side)), _corner_mid(webcam.eye(side))
        if a is None or b is None:
            return None
        d_p = _ray(phone.intrinsics, a)
        d_w = p_pw.rotate(_ray(webcam.intrinsics, b))
        res = closest_on_first_ray(np.zeros(3), d_p, o_w, d_w)
        if res is None:
            return None
        pt, s, gap = res
        if s <= 0.1 or gap > max_gap_m:
            return None
        out["points"][side] = pt
        out["gaps"][side] = gap
        c = _v(phone.eye(side).eyeball_center)
        if c is not None:
            back = head_r[:, 2] if head_r is not None else np.array([0.0, 0.0, 1.0])
            out["phone_mid"][side] = c - EYEBALL_BEHIND_CORNERS_M * back
    return out


def apply_triangulation(obs: Observation, tri: dict[str, Any]) -> Observation:
    """Move each eyeball centre so its corner midpoint sits at the triangulated point; distance
    and head position follow. Gaze directions are re-derived by the models from the iris pixel
    (camera mode) and are left as they are."""
    out = clone(obs)
    centres = []
    for side in ("left", "right"):
        e = out.eye(side)
        c = _v(e.eyeball_center)
        mid = tri["phone_mid"].get(side)
        if c is None or mid is None:
            return obs
        new = c + (tri["points"][side] - mid)
        out.set(f"{side}.eyeball_center", tuple(float(v) for v in new), NAME)
        centres.append(new)
    head = (centres[0] + centres[1]) / 2
    out.set("head_position", tuple(float(v) for v in head), NAME)
    out.set("distance", float(np.linalg.norm(head)), NAME)
    return out


def replace_head_pose(obs: Observation, webcam_head_in_phone: Pose, mode: str) -> Observation:
    """Head rotation and position from the webcam (``mode="webcam"``) or the average of both
    (``"fused"``). Only the head pose fields change: eyeball centres and the distance stay the
    phone's (``distance_source`` is the option for those), because moving the eyes with a head
    position that carries the phone-pose solve's centimetre-level error would swamp the gaze."""
    if obs.head_rotation is None or obs.head_position is None:
        return obs
    old = Pose(np.asarray(obs.head_rotation, float), np.asarray(obs.head_position, float))
    if mode == "webcam":
        new = webcam_head_in_phone
    else:
        new = Pose(average_two_rotations(old.R, webcam_head_in_phone.R, 0.5), 0.5 * (old.t + webcam_head_in_phone.t))
    out = clone(obs)
    out.set("head_rotation", new.R.tolist(), NAME)
    out.set("head_position", tuple(float(v) for v in new.t), NAME)
    return out


def predicted_eyes(webcam: Observation, p_wp: Pose, phone_intr: Intrinsics) -> dict[str, Any] | None:
    """Where the eyes (eyeball centres pushed forward to the iris plane) project in the phone
    image, from the webcam's observation. ``{side: (u, v)}`` plus ``distance``."""
    p_pw = p_wp.inverse()
    out: dict[str, Any] = {}
    dists = []
    head_r = np.asarray(webcam.head_rotation, float) if webcam.head_rotation is not None else None
    for side in ("left", "right"):
        c = _v(webcam.eye(side).eyeball_center)
        if c is None:
            return None
        front = c - 0.01 * (head_r[:, 2] if head_r is not None else np.array([0.0, 0.0, 1.0]))
        p = p_pw.apply(front)
        if p[2] <= 0.05:
            return None
        out[side] = phone_intr.project((float(p[0]), float(p[1]), float(p[2])))
        dists.append(float(np.linalg.norm(p)))
    out["distance"] = float(np.mean(dists))
    return out


def lens_observation(obs: Observation, pred: dict[str, Any]) -> Observation:
    """A copy of ``obs`` with predicted eye positions, for placing eye crops and choosing zoom
    only (never for gaze)."""
    out = clone(obs)
    for side in ("left", "right"):
        e = out.eye(side)
        e.found = True
        e.iris_center = (float(pred[side][0]), float(pred[side][1]))
    out.distance = pred.get("distance") or out.distance
    out.extra[NAME] = {**(out.extra.get(NAME) or {}), "predicted_eyes": True}
    return out


def angle_between_deg(a: np.ndarray, b: np.ndarray) -> float:
    c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))
