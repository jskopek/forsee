"""Rigid-body helpers for the second camera: poses, the webcam's place on the screen, robust
averaging of rotations and translations, and triangulation. numpy and scipy only.

Conventions (as ``types.py``): metres; camera frames are x right, y down, z forward (towards the
user). A :class:`Pose` named ``a_from_b`` maps points in frame ``b`` to frame ``a``:
``p_a = R @ p_b + t``. Screen frame (as ``models/geometric.py``): origin at the top-left corner
of the visible area, x right, y down, z into the screen (away from the user).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

DEG = math.pi / 180.0

R_BASE = np.diag([-1.0, 1.0, -1.0])
"""Screen axes in the coordinates of a camera that faces the user squarely (same as the geometric
model's): the user's right (screen +x) is the camera's -x."""


@dataclass
class Pose:
    """A rigid transform ``p_a = R @ p_b + t`` (``a_from_b``)."""

    R: np.ndarray
    t: np.ndarray

    @staticmethod
    def identity() -> Pose:
        return Pose(np.eye(3), np.zeros(3))

    def inverse(self) -> Pose:
        return Pose(self.R.T, -self.R.T @ self.t)

    def __matmul__(self, other: Pose) -> Pose:
        """``self @ other``: first ``other``, then ``self`` (``a_from_b @ b_from_c = a_from_c``)."""
        return Pose(self.R @ other.R, self.R @ other.t + self.t)

    def apply(self, p: Sequence[float] | np.ndarray) -> np.ndarray:
        return self.R @ np.asarray(p, float) + self.t

    def rotate(self, v: Sequence[float] | np.ndarray) -> np.ndarray:
        return self.R @ np.asarray(v, float)

    def angle_deg(self) -> float:
        return float(np.linalg.norm(Rotation.from_matrix(self.R).as_rotvec()) / DEG)

    def to_dict(self) -> dict[str, Any]:
        return {"R": self.R.tolist(), "t": self.t.tolist()}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Pose:
        return cls(np.asarray(d["R"], float).reshape(3, 3), np.asarray(d["t"], float).reshape(3))


def difference(a: Pose, b: Pose) -> tuple[float, float]:
    """``(rotation degrees, translation metres)`` between two poses of the same thing."""
    d = a.inverse() @ b
    return d.angle_deg(), float(np.linalg.norm(a.t - b.t))


# ---------------------------------------------------------------------------------------------
# Where the webcam is
# ---------------------------------------------------------------------------------------------


def tilt_matrix(tilt_deg: float) -> np.ndarray:
    """Rotation of a camera about its own x axis; positive tilt makes it look further down
    (its z axis gains a +y, i.e. downward, component)."""
    c, s = math.cos(tilt_deg * DEG), math.sin(tilt_deg * DEG)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]])


def screen_from_webcam(screen_w_m: float, offset_m: float, tilt_deg: float = 0.0) -> Pose:
    """The webcam in the screen frame: lens centre ``offset_m`` above the middle of the top
    edge, in the screen's plane, looking straight out of the screen (tilted by ``tilt_deg``)."""
    return Pose(R_BASE @ tilt_matrix(tilt_deg), np.array([screen_w_m / 2.0, -offset_m, 0.0]))


def geometric_params(phone_from_screen: Pose) -> np.ndarray:
    """The geometric model's six pose parameters (rotation vector, top-left corner) for a screen
    whose pose in the phone camera is ``phone_from_screen``."""
    rv = Rotation.from_matrix(R_BASE @ phone_from_screen.R).as_rotvec()
    return np.concatenate([rv, phone_from_screen.t])


def pose_from_geometric_params(p: Sequence[float]) -> Pose:
    p = np.asarray(p, float)
    return Pose(R_BASE @ Rotation.from_rotvec(p[0:3]).as_matrix(), p[3:6].copy())


# ---------------------------------------------------------------------------------------------
# Robust averaging
# ---------------------------------------------------------------------------------------------


def project_rotation(m: np.ndarray) -> np.ndarray:
    u, _, vt = np.linalg.svd(m)
    r = u @ vt
    if np.linalg.det(r) < 0:
        u[:, -1] *= -1
        r = u @ vt
    return r


def robust_rotation_mean(rs: np.ndarray, weights: np.ndarray | None = None, huber_deg: float = 3.0, iters: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Huber M-estimate of the mean of ``N x 3 x 3`` rotations. Starts from the chordal L2 mean
    and iterates in the tangent space. Returns ``(mean, residual angles in degrees)``."""
    rs = np.asarray(rs, float).reshape(-1, 3, 3)
    w0 = np.ones(len(rs)) if weights is None else np.asarray(weights, float)
    mean = project_rotation(np.einsum("n,nij->ij", w0, rs))
    k = huber_deg * DEG
    res = np.zeros(len(rs))
    for _ in range(iters):
        rel = Rotation.from_matrix(np.einsum("ji,njk->nik", mean, rs)).as_rotvec()
        res = np.linalg.norm(rel, axis=1)
        w = w0 * np.minimum(1.0, k / np.maximum(res, 1e-12))
        step = (w[:, None] * rel).sum(axis=0) / max(w.sum(), 1e-12)
        mean = mean @ Rotation.from_rotvec(step).as_matrix()
        if np.linalg.norm(step) < 1e-7:
            break
    rel = Rotation.from_matrix(np.einsum("ji,njk->nik", mean, rs)).as_rotvec()
    return mean, np.linalg.norm(rel, axis=1) / DEG


def robust_vector_mean(vs: np.ndarray, weights: np.ndarray | None = None, huber: float = 0.02, iters: int = 10) -> tuple[np.ndarray, np.ndarray]:
    """Huber M-estimate of the mean of ``N x D`` vectors, starting from the coordinate-wise
    median. Returns ``(mean, residual norms)``."""
    vs = np.asarray(vs, float)
    w0 = np.ones(len(vs)) if weights is None else np.asarray(weights, float)
    mean = np.median(vs, axis=0)
    for _ in range(iters):
        res = np.linalg.norm(vs - mean, axis=1)
        w = w0 * np.minimum(1.0, huber / np.maximum(res, 1e-12))
        new = (w[:, None] * vs).sum(axis=0) / max(w.sum(), 1e-12)
        if np.linalg.norm(new - mean) < 1e-9:
            mean = new
            break
        mean = new
    return mean, np.linalg.norm(vs - mean, axis=1)


def robust_sd(res: np.ndarray) -> float:
    """Robust root-mean-square size of 3D residuals from their norms: for isotropic Gaussian
    errors the median norm is 1.538 sigma and the RMS norm sqrt(3) sigma, hence 1.126 x median."""
    res = np.asarray(res, float)
    if len(res) == 0:
        return float("nan")
    return float(1.126 * np.median(res)) if len(res) > 2 else float(np.max(res))


def kabsch(src: np.ndarray, dst: np.ndarray, weights: np.ndarray | None = None) -> Pose:
    """Rigid transform ``dst ~ R @ src + t`` minimising weighted squared error (no scale)."""
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    w = np.ones(len(src)) if weights is None else np.asarray(weights, float)
    w = w / max(w.sum(), 1e-12)
    ms, md = w @ src, w @ dst
    h = ((src - ms) * w[:, None]).T @ (dst - md)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T)) or 1.0
    r = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
    return Pose(r, md - r @ ms)


def robust_kabsch(src: np.ndarray, dst: np.ndarray, huber: float = 0.01, iters: int = 6) -> tuple[Pose, np.ndarray]:
    """:func:`kabsch` with iterative Huber reweighting. Returns ``(pose, residual norms)``."""
    w = np.ones(len(src))
    pose = kabsch(src, dst, w)
    res = np.zeros(len(src))
    for _ in range(iters):
        res = np.linalg.norm(dst - (src @ pose.R.T + pose.t), axis=1)
        w = np.minimum(1.0, huber / np.maximum(res, 1e-12))
        pose = kabsch(src, dst, w)
    res = np.linalg.norm(dst - (src @ pose.R.T + pose.t), axis=1)
    return pose, res


def interpolate_pose(t: float, t0: float, p0: Pose, t1: float, p1: Pose) -> Pose:
    """Pose at time ``t`` between two timed poses: linear in translation, slerp in rotation."""
    if t1 <= t0:
        return p0
    a = float(np.clip((t - t0) / (t1 - t0), 0.0, 1.0))
    slerp = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([p0.R, p1.R])))
    return Pose(slerp([a]).as_matrix()[0], (1 - a) * p0.t + a * p1.t)


def average_two_rotations(a: np.ndarray, b: np.ndarray, wa: float = 0.5) -> np.ndarray:
    slerp = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([a, b])))
    return slerp([1.0 - wa]).as_matrix()[0]


# ---------------------------------------------------------------------------------------------
# Triangulation
# ---------------------------------------------------------------------------------------------


def closest_on_first_ray(o1: np.ndarray, d1: np.ndarray, o2: np.ndarray, d2: np.ndarray) -> tuple[np.ndarray, float, float] | None:
    """The point on ray 1 closest to ray 2, its parameter along ray 1 (``d1`` normalised) and
    the gap between the rays (metres). ``None`` for nearly parallel rays."""
    d1 = d1 / np.linalg.norm(d1)
    d2 = d2 / np.linalg.norm(d2)
    w = o1 - o2
    a, b, c = 1.0, float(d1 @ d2), 1.0
    d, e = float(d1 @ w), float(d2 @ w)
    den = a * c - b * b
    if den < 1e-6:
        return None
    s = (b * e - c * d) / den
    u = (a * e - b * d) / den
    p1, p2 = o1 + s * d1, o2 + u * d2
    return p1, s, float(np.linalg.norm(p1 - p2))
