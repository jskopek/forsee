"""Features the models read from an ``Observation``. Owner: Models.

Everything here is zoom-invariant: directions in camera coordinates, rays (``(u - cx) / fx``)
and ratios of pixel lengths, never raw pixels. Missing inputs give ``None`` / NaN, never zero.

Conventions (``types.py``): camera x right, y down, z forward (towards the user). Head frame: x
from the person's right eye to their left, y down the face, z towards the back of the head (the
face looks along -z). Angles here: ``yaw`` positive towards +x, ``pitch`` positive towards +y
(down), both in radians.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

from ..types import EyeObs, Observation

SIDES = ("left", "right")

EYE_IRIS_DISTANCE_M = 0.0102
"""Rotation centre to iris plane (research note 01). Used only when an observation has an
eyeball centre and an iris pixel but no gaze direction."""


def as_rotation(value: Sequence[Sequence[float]] | None) -> np.ndarray | None:
    if value is None:
        return None
    r = np.asarray(value, float)
    if r.shape != (3, 3) or not np.all(np.isfinite(r)):
        return None
    return r


def unit(v: np.ndarray) -> np.ndarray | None:
    n = float(np.linalg.norm(v))
    if not math.isfinite(n) or n < 1e-12:
        return None
    return v / n


def dir_angles(d: np.ndarray) -> tuple[float, float]:
    """``(yaw, pitch)`` of a direction that points roughly along -z (towards the camera when
    ``d`` is in camera coordinates, out of the face when in head coordinates)."""
    return math.atan2(d[0], -d[2]), math.atan2(d[1], math.hypot(d[0], d[2]))


def angles_dir(yaw: np.ndarray, pitch: np.ndarray) -> np.ndarray:
    """Inverse of :func:`dir_angles`, vectorised: returns ``... x 3`` unit vectors."""
    cp = np.cos(pitch)
    return np.stack([cp * np.sin(yaw), np.sin(pitch), -cp * np.cos(yaw)], axis=-1)


def eye_center(obs: Observation, side: str) -> np.ndarray | None:
    eye = obs.eye(side)
    if eye.eyeball_center is None:
        return None
    c = np.asarray(eye.eyeball_center, float)
    return c if np.all(np.isfinite(c)) and c[2] > 0 else None


def optical_dir(obs: Observation, side: str) -> np.ndarray | None:
    """Unit optical-axis direction in camera coordinates: ``gaze_dir`` if an estimator set it,
    else the ray through the iris centre pixel intersected with a sphere around the eyeball
    centre."""
    eye = obs.eye(side)
    if eye.blink:
        return None
    if eye.gaze_dir is not None:
        g = unit(np.asarray(eye.gaze_dir, float))
        if g is not None:
            return g
    c = eye_center(obs, side)
    if c is None or eye.iris_center is None or obs.intrinsics is None:
        return None
    rx, ry = obs.intrinsics.ray(*eye.iris_center)
    ray = unit(np.array([rx, ry, 1.0]))
    if ray is None:
        return None
    # |t*ray - c| = R, nearest root (the front of the eye).
    b = float(ray @ c)
    disc = b * b - (float(c @ c) - EYE_IRIS_DISTANCE_M**2)
    t = b - math.sqrt(disc) if disc > 0 else b
    return unit(t * ray - c)


def eye_usable(eye: EyeObs) -> bool:
    return bool(eye.found or eye.iris_center is not None or eye.gaze_dir is not None) and not eye.blink


def eye_confidence(obs: Observation, side: str) -> float:
    eye = obs.eye(side)
    c = eye.confidence
    if c is None:
        return 1.0 if eye_usable(eye) else 0.0
    return float(min(max(c, 0.0), 1.0))


def head_angles(obs: Observation) -> tuple[float, float, float] | None:
    """``(yaw, pitch, roll)`` of the face in camera coordinates (0, 0, 0 = facing the camera)."""
    r = as_rotation(obs.head_rotation)
    if r is None:
        return None
    face = r @ np.array([0.0, 0.0, -1.0])
    yaw, pitch = dir_angles(face)
    roll = math.atan2(r[1, 0], r[0, 0])
    return yaw, pitch, roll


def head_position(obs: Observation) -> np.ndarray | None:
    if obs.head_position is not None:
        p = np.asarray(obs.head_position, float)
        if np.all(np.isfinite(p)) and p[2] > 0:
            return p
    cs = [c for c in (eye_center(obs, s) for s in SIDES) if c is not None]
    if cs:
        return np.mean(cs, axis=0)
    return None


def iris_corner_vector(obs: Observation, side: str) -> tuple[float, float] | None:
    """Iris centre relative to the midpoint of the eye corners, divided by the corner distance,
    in ray space (unitless; survives zoom and distance changes). x is the image x."""
    eye = obs.eye(side)
    if eye.blink or eye.iris_center is None or eye.inner_corner is None or eye.outer_corner is None or obs.intrinsics is None:
        return None
    intr = obs.intrinsics
    i = np.array(intr.ray(*eye.iris_center))
    a = np.array(intr.ray(*eye.inner_corner))
    b = np.array(intr.ray(*eye.outer_corner))
    span = float(np.linalg.norm(a - b))
    if span <= 1e-9:
        return None
    v = (i - (a + b) / 2) / span
    return float(v[0]), float(v[1])


def reflection_vector(obs: Observation, side: str, min_score: float = 0.0) -> tuple[float, float] | None:
    """(reflection centre - iris centre) / iris radius, in pixels of the same image (a ratio,
    so zoom-invariant). PCCR-style feature (research note 02)."""
    eye = obs.eye(side)
    if eye.blink or eye.reflection_center is None or eye.iris_center is None or not eye.iris_radius or eye.iris_radius <= 0:
        return None
    if eye.reflection_score is not None and eye.reflection_score < min_score:
        return None
    dx = (eye.reflection_center[0] - eye.iris_center[0]) / eye.iris_radius
    dy = (eye.reflection_center[1] - eye.iris_center[1]) / eye.iris_radius
    if math.hypot(dx, dy) > 1.5:  # outside the iris: not the corneal reflection
        return None
    return float(dx), float(dy)


def distance(obs: Observation) -> float | None:
    if obs.distance and obs.distance > 0:
        return float(obs.distance)
    p = head_position(obs)
    return float(np.linalg.norm(p)) if p is not None else None


# ---------------------------------------------------------------------------------------------
# Feature table for the regression-style models
# ---------------------------------------------------------------------------------------------

EYE_GROUPS = {
    "gaze": 2,  # optical axis yaw, pitch (camera frame), radians
    "iris": 2,  # iris-vs-corner vector
    "reflection": 2,  # iris-to-reflection vector / iris radius
    "lid": 2,  # lid opening / corner span, and a zero column (models.eyelid_feature)
}
EXTRA_GROUPS = ("lid",)
"""Groups that add to the eye groups but never stand for an eye on their own."""
HEAD_COLUMNS = ("head_yaw", "head_pitch", "head_roll", "head_rx", "head_ry", "inv_distance")


def eye_group(obs: Observation, side: str, group: str) -> tuple[float, float] | None:
    if group == "gaze":
        g = optical_dir(obs, side)
        return None if g is None else dir_angles(g)
    if group == "iris":
        return iris_corner_vector(obs, side)
    if group == "reflection":
        return reflection_vector(obs, side)
    if group == "lid":
        eye = obs.eye(side)
        # the second column is constant (standardised to 0): groups are two columns wide
        return None if eye.openness is None or eye.blink else (float(eye.openness), 0.0)
    raise ValueError(group)


def head_row(obs: Observation) -> np.ndarray:
    out = np.full(len(HEAD_COLUMNS), np.nan)
    ang = head_angles(obs)
    if ang is not None:
        out[0:3] = ang
    p = head_position(obs)
    if p is not None:
        out[3] = p[0] / p[2]
        out[4] = p[1] / p[2]
    d = distance(obs)
    if d:
        out[5] = 1.0 / d
    return out


class FeatureTable:
    """Turns observations into a dense feature matrix with missing values handled.

    Per-eye groups are kept per eye. When one eye is missing it is imputed from the other eye
    plus the mean left-right difference seen in training (the two eyes differ by vergence and
    kappa, so plain copying would bias the result). Head columns missing at prediction time take
    the training mean. Columns are standardised with training statistics.
    """

    def __init__(self, groups: list[str], head: bool) -> None:
        self.groups = list(groups)
        self.head = head
        self.lr_diff: dict[str, np.ndarray] = {}
        self.mean: np.ndarray | None = None
        self.std: np.ndarray | None = None

    @property
    def n_eye_columns(self) -> int:
        return sum(EYE_GROUPS[g] * 2 for g in self.groups)

    def _main_columns(self) -> list[int]:
        """Columns of the groups that stand for an eye (not the extra ones, such as the lid)."""
        out, i = [], 0
        for g in self.groups:
            n = EYE_GROUPS[g] * 2
            if g not in EXTRA_GROUPS:
                out.extend(range(i, i + n))
            i += n
        return out or list(range(self.n_eye_columns))

    def raw(self, obs: Observation) -> np.ndarray | None:
        """One row (NaN = missing), or ``None`` if no eye group is available at all."""
        cols: list[float] = []
        any_eye = False
        for g in self.groups:
            vals = {s: eye_group(obs, s, g) for s in SIDES}
            left, right = vals["left"], vals["right"]
            diff = self.lr_diff.get(g, np.zeros(2))
            if left is None and right is not None:
                left = tuple(np.asarray(right) + diff)
            if right is None and left is not None:
                right = tuple(np.asarray(left) - diff)
            if left is None or right is None:
                cols.extend([np.nan] * 4)
            else:
                any_eye = any_eye or g not in EXTRA_GROUPS
                cols.extend([*left, *right])
        if not any_eye:
            return None
        if self.head:
            cols.extend(head_row(obs).tolist())
        return np.asarray(cols, float)

    def fit(self, observations: list[Observation]) -> np.ndarray:
        """Learn imputation and scaling; returns the standardised matrix (rows with no eye data
        are NaN rows the caller must drop)."""
        for g in self.groups:
            diffs = []
            for o in observations:
                a, b = eye_group(o, "left", g), eye_group(o, "right", g)
                if a is not None and b is not None:
                    diffs.append(np.subtract(a, b))
            self.lr_diff[g] = np.median(diffs, axis=0) if diffs else np.zeros(2)
        rows = [self.raw(o) for o in observations]
        width = self.n_eye_columns + (len(HEAD_COLUMNS) if self.head else 0)
        mat = np.array([r if r is not None else np.full(width, np.nan) for r in rows], float).reshape(len(rows), width)
        self.mean = np.nanmean(mat, axis=0) if len(mat) else np.zeros(width)
        self.mean = np.where(np.isfinite(self.mean), self.mean, 0.0)
        std = np.nanstd(mat, axis=0) if len(mat) else np.ones(width)
        # Columns that hardly vary in training (head pose during a single-pose calibration) are
        # scaled by a floor, not blown up to unit variance from noise.
        floor = np.full(width, 1e-3)
        if self.head:
            floor[self.n_eye_columns :] = [0.05, 0.05, 0.05, 0.05, 0.05, 0.3]
        self.std = np.maximum(np.where(np.isfinite(std), std, 0.0), floor)
        return self.transform_matrix(mat)

    def transform_matrix(self, mat: np.ndarray) -> np.ndarray:
        assert self.mean is not None and self.std is not None
        z = (mat - self.mean) / self.std
        bad_rows = ~np.any(np.isfinite(z[:, self._main_columns()]), axis=1) if len(z) else np.zeros(0, bool)
        z = np.where(np.isfinite(z), z, 0.0)
        z[bad_rows] = np.nan
        return z

    def transform(self, obs: Observation) -> np.ndarray | None:
        r = self.raw(obs)
        if r is None:
            return None
        z = self.transform_matrix(r[None, :])[0]
        return None if not np.all(np.isfinite(z)) else z

    def to_dict(self) -> dict:
        return {
            "groups": self.groups,
            "head": self.head,
            "lr_diff": {k: v.tolist() for k, v in self.lr_diff.items()},
            "mean": None if self.mean is None else self.mean.tolist(),
            "std": None if self.std is None else self.std.tolist(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> FeatureTable:
        t = cls(list(data["groups"]), bool(data["head"]))
        t.lr_diff = {k: np.array(v, float) for k, v in (data.get("lr_diff") or {}).items()}
        t.mean = None if data.get("mean") is None else np.array(data["mean"], float)
        t.std = None if data.get("std") is None else np.array(data["std"], float)
        return t


def available_groups(observations: list[Observation], candidates: list[str], min_fraction: float = 0.6) -> list[str]:
    """Eye groups present (in at least one eye) in at least ``min_fraction`` of observations."""
    out = []
    n = max(len(observations), 1)
    for g in candidates:
        k = sum(1 for o in observations if any(eye_group(o, s, g) is not None for s in SIDES))
        if k / n >= min_fraction:
            out.append(g)
    return out


def poly2(z: np.ndarray, n_poly: int) -> np.ndarray:
    """Append squares and pairwise products of the first ``n_poly`` columns."""
    base = z[:, :n_poly]
    extra = [base[:, i : i + 1] * base[:, j : j + 1] for i in range(n_poly) for j in range(i, n_poly)]
    return np.hstack([z, *extra]) if extra else z
