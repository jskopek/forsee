"""Geometry helpers shared by the estimators and usable by the gaze models. Owner: Vision.

All 3D values are metres in UPRIGHT camera coordinates (x right, y down, z forward, towards the
user); pixels are upright full-frame pixels in the continuous convention (see ``types.py``).

The eye model is deliberately simple (textbook constants, research note 01):

- the iris centre sits ``EYE_IRIS_DISTANCE_M`` (10.2 mm) in front of the eyeball's rotation
  centre, along the optical axis;
- the visible iris is ``IRIS_DIAMETER_MM`` (11.7 mm) across;
- the eyeball centre is fixed in the head frame, ``EYEBALL_BEHIND_CORNERS_M`` behind the midpoint
  of the eye corners.

Everything here is the optical axis. The visual axis differs by kappa (about 5 degrees nasal,
1.5 up), which the Models area fits per person.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from ..types import IRIS_DIAMETER_MM, Intrinsics, Observation, Vec2, Vec3

EYE_IRIS_DISTANCE_M = 0.0102
"""Eyeball rotation centre to the iris plane, metres (textbook value)."""

IRIS_RADIUS_M = IRIS_DIAMETER_MM / 2000.0
"""Visible iris radius, metres."""

EYEBALL_BEHIND_CORNERS_M = 0.0102
"""How far the rotation centre sits behind the midpoint of the eye corners, along the head's +z.
Looking straight ahead, the iris centre is then roughly level with the corners."""

INTER_EYE_M = 0.063
"""Typical distance between the two eyeball centres (adult interpupillary distance)."""

OUTER_CANTHI_M = 0.090
"""Typical distance between the outer eye corners (biocular width), used as a distance cue."""

FLIP_YZ = np.diag([1.0, -1.0, -1.0])
"""Turns a y-up, z-towards-the-viewer frame into x right, y down, z forward (and back)."""

GAZE_KIND = "optical_axis"
"""What ``EyeObs.gaze_dir`` means when set by these helpers (stored in ``extra``)."""


# ---------------------------------------------------------------------------------------------
# Distance
# ---------------------------------------------------------------------------------------------


def depth_from_iris(radius_px: float, fx: float, iris_diameter_mm: float = IRIS_DIAMETER_MM) -> float | None:
    """Depth (z, metres) of an iris whose radius in pixels is ``radius_px`` (use the ellipse's
    semi-MAJOR axis: a tilted circle keeps its true diameter along the major axis)."""
    if not radius_px or radius_px <= 0 or not fx:
        return None
    return float(fx * (iris_diameter_mm / 2000.0) / radius_px)


def distance_from_depth(intr: Intrinsics, uv: Vec2, depth: float) -> float:
    """Euclidean distance to the point at pixel ``uv`` and depth ``depth``."""
    rx, ry = intr.ray(*uv)
    return float(depth * math.sqrt(1.0 + rx * rx + ry * ry))


def backproject(intr: Intrinsics, uv: Vec2, depth: float) -> np.ndarray:
    """3D point at pixel ``uv`` with z = ``depth``."""
    rx, ry = intr.ray(*uv)
    return np.array([rx * depth, ry * depth, depth], dtype=float)


def depth_from_span(span_px: float, span_m: float, fx: float, foreshortening: float = 1.0) -> float | None:
    """Depth from a known physical span (e.g. outer eye corners) seen ``span_px`` wide.
    ``foreshortening`` (0-1) is how much of the span faces the camera (cos of the yaw)."""
    if span_px <= 0 or foreshortening <= 0.2:
        return None
    return float(fx * span_m * foreshortening / span_px)


def combine(values: Sequence[tuple[float | None, float]]) -> float | None:
    """Weighted mean of ``(value, weight)`` pairs, ignoring ``None`` and non-positive weights."""
    num = den = 0.0
    for v, w in values:
        if v is None or w <= 0 or not math.isfinite(v):
            continue
        num += v * w
        den += w
    return num / den if den > 0 else None


# ---------------------------------------------------------------------------------------------
# Rotations
# ---------------------------------------------------------------------------------------------


def orthonormalize(m: np.ndarray) -> np.ndarray:
    """Nearest proper rotation to ``m`` (SVD)."""
    u, _, vt = np.linalg.svd(np.asarray(m, dtype=float)[:3, :3])
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def head_angles_deg(r: np.ndarray) -> dict[str, float]:
    """Yaw, pitch, roll (degrees) of a head rotation (head frame -> upright camera).

    Yaw > 0: the face turns towards the camera's +x (image right). Pitch > 0: the face turns
    down (towards +y). Roll > 0: the head tilts clockwise in the image. Zero for the identity.
    """
    r = np.asarray(r, dtype=float)
    face = -r[:, 2]  # the face points along the head's -z; frontal = (0, 0, -1)
    yaw = math.degrees(math.atan2(face[0], -face[2]))
    pitch = math.degrees(math.atan2(face[1], math.hypot(face[0], face[2])))
    xh = r[:, 0]
    roll = math.degrees(math.atan2(xh[1], xh[0]))
    return {"yaw": yaw, "pitch": pitch, "roll": roll}


def rot_x(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=float)


def rot_y(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=float)


def rot_z(deg: float) -> np.ndarray:
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=float)


# ---------------------------------------------------------------------------------------------
# Eye model
# ---------------------------------------------------------------------------------------------


def eyeball_center_from_corners(
    intr: Intrinsics, inner: Vec2, outer: Vec2, depth: float, head_rotation: np.ndarray | None
) -> np.ndarray:
    """Eyeball rotation centre from the eye corners' midpoint at ``depth`` (z of the corners),
    pushed ``EYEBALL_BEHIND_CORNERS_M`` along the head's +z (into the head)."""
    mid = ((inner[0] + outer[0]) / 2, (inner[1] + outer[1]) / 2)
    p = backproject(intr, mid, depth)
    back = np.array([0.0, 0.0, 1.0]) if head_rotation is None else np.asarray(head_rotation)[:, 2]
    return p + EYEBALL_BEHIND_CORNERS_M * back


def gaze_from_iris(
    intr: Intrinsics, iris_uv: Vec2, eyeball_center: Sequence[float], radius: float = EYE_IRIS_DISTANCE_M
) -> tuple[np.ndarray, np.ndarray, bool] | None:
    """Optical axis from the eyeball centre and the iris centre's pixel.

    Intersects the camera ray through ``iris_uv`` with the sphere of radius ``radius`` about the
    eyeball centre, taking the intersection nearer the camera (the front of the eye). If the ray
    misses the sphere (the model and the measurement disagree), the closest point on the ray is
    pushed onto the sphere and ``exact`` is false.

    Returns ``(gaze_dir unit vector, iris centre 3D, exact)`` or ``None``.
    """
    c = np.asarray(eyeball_center, dtype=float)
    rx, ry = intr.ray(*iris_uv)
    d = np.array([rx, ry, 1.0])
    d /= np.linalg.norm(d)
    b = float(d @ c)
    disc = b * b - float(c @ c) + radius * radius
    if disc >= 0:
        t = b - math.sqrt(disc)
        p = t * d
        exact = True
    else:
        p_ray = b * d
        off = p_ray - c
        n = np.linalg.norm(off)
        if n < 1e-12:
            return None
        p = c + off / n * radius
        exact = False
    g = p - c
    n = np.linalg.norm(g)
    if n < 1e-12:
        return None
    return g / n, p, exact


def project_gaze(intr: Intrinsics, eyeball_center: Sequence[float], gaze_dir: Sequence[float]) -> Vec2:
    """Pixel of the iris centre predicted by the eye model (inverse of :func:`gaze_from_iris`)."""
    p = np.asarray(eyeball_center, float) + EYE_IRIS_DISTANCE_M * np.asarray(gaze_dir, float)
    return intr.project((float(p[0]), float(p[1]), float(p[2])))


def ellipse_normals(ellipse: Sequence[float]) -> list[np.ndarray]:
    """The two candidate iris-plane normals (weak perspective) of an iris ellipse
    ``(cx, cy, semi_major, semi_minor, angle_deg)``, as unit vectors pointing towards the camera
    (z < 0). The ambiguity is the classic two-fold one; the eye model picks between them.
    Poorly conditioned near frontal views (research note 01): use only to disambiguate."""
    _, _, a, b, ang = ellipse
    if a <= 0:
        return []
    tilt = math.acos(max(-1.0, min(1.0, b / a)))
    t = math.radians(ang)
    minor_dir = np.array([-math.sin(t), math.cos(t)])  # image direction of the minor axis
    out = []
    for s in (1.0, -1.0):
        xy = s * math.sin(tilt) * minor_dir
        out.append(np.array([xy[0], xy[1], -math.cos(tilt)]))
    return out


def iris_ellipse_full(
    center: Vec2, axes: tuple[float, float], angle_deg: float, to_full: np.ndarray
) -> tuple[float, float, float, float, float]:
    """Map an ellipse measured in an image (centre already in continuous image pixels, full
    axis LENGTHS as cv2 gives them, angle in degrees) to upright full-frame pixels through the
    image's ``to_full`` affine. Returns ``(cx, cy, semi_major, semi_minor, angle_deg)``."""
    a2 = np.asarray(to_full, float)[:2, :2]
    c = np.asarray(to_full, float) @ np.array([center[0], center[1], 1.0])
    t = math.radians(angle_deg)
    rot = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
    s = rot @ np.diag([(axes[0] / 2) ** 2, (axes[1] / 2) ** 2]) @ rot.T
    s2 = a2 @ s @ a2.T
    w, v = np.linalg.eigh(s2)
    major, minor = math.sqrt(max(w[1], 0)), math.sqrt(max(w[0], 0))
    ang = math.degrees(math.atan2(v[1, 1], v[0, 1])) % 180.0
    return (float(c[0]), float(c[1]), major, minor, ang)


def fill_eye_model(obs: Observation, estimator: str, recompute_center: bool = False) -> None:
    """Set ``eyeball_center`` (if missing) and ``gaze_dir`` for each eye from what ``obs``
    already holds: an eyeball centre, or the eye corners plus ``distance`` and head pose, or the
    head position plus head pose; and the iris centre. Eyes whose gaze ARKit set are left alone.
    """
    intr = obs.intrinsics
    if intr is None:
        return
    head_r = np.asarray(obs.head_rotation, float) if obs.head_rotation is not None else None
    hp = np.asarray(obs.head_position, float) if obs.head_position is not None else None
    for side in ("left", "right"):
        eye = obs.eye(side)
        if eye.iris_center is None or obs.provenance.get(f"{side}.gaze_dir") == "arkit":
            continue
        center = None
        if eye.eyeball_center is not None and not recompute_center:
            center = np.asarray(eye.eyeball_center, float)
        elif hp is not None and head_r is not None:
            sign = 1.0 if side == "left" else -1.0
            center = hp + head_r @ np.array([sign * INTER_EYE_M / 2, 0, 0])
        elif eye.inner_corner is not None and eye.outer_corner is not None and obs.distance:
            mid = ((eye.inner_corner[0] + eye.outer_corner[0]) / 2, (eye.inner_corner[1] + eye.outer_corner[1]) / 2)
            rx, ry = intr.ray(*mid)
            depth = obs.distance / math.sqrt(1 + rx * rx + ry * ry)
            center = eyeball_center_from_corners(intr, eye.inner_corner, eye.outer_corner, depth, head_r)
        if center is None:
            continue
        res = gaze_from_iris(intr, eye.iris_center, center)
        if res is None:
            continue
        g, _, exact = res
        if eye.eyeball_center is None or recompute_center:
            obs.set(f"{side}.eyeball_center", tuple(float(v) for v in center), estimator)
        obs.set(f"{side}.gaze_dir", tuple(float(v) for v in g), estimator)
        eye.extra["gaze_kind"] = GAZE_KIND
        eye.extra["eye_model_exact"] = bool(exact)


def head_position_from_eyes(obs: Observation) -> Vec3 | None:
    """Midpoint of the two eyeball centres, when both are known."""
    a, b = obs.left.eyeball_center, obs.right.eyeball_center
    if a is None or b is None:
        return None
    return tuple((np.asarray(a) + np.asarray(b)) / 2)  # type: ignore[return-value]
