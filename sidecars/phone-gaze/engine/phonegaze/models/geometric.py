"""Geometric gaze model: per-eye rays intersected with a calibrated screen plane. Owner: Models.

Each eye gives a ray from its eyeball rotation centre ``c`` (camera coordinates, from the
estimators). In camera mode, with the iris centre pixel measured, the model re-derives the
optical axis itself: the ray through that pixel meets a sphere of radius ``R`` around ``c``
(research note 01, method 2b: iris centre minus eyeball centre). In ARKit mode it uses ARKit's
``gaze_dir`` with a gain (:data:`ARKIT_USES_GAZE`). A soft prior keeps the eyes' solved distance
to the screen near their measured distance to the camera (``distance_sd_m``). The optical axis becomes the visual axis with a per-eye
angular offset (kappa: about 5 degrees nasal and 1.5 up), and the visual axis is intersected
with the screen plane. Calibration solves, by robust non-linear least squares with priors as
penalty terms:

==================  =====  ============================================================
parameter           count  meaning
==================  =====  ============================================================
screen rotation     3      rotation vector relative to "screen faces the user, upright"
screen corner       3      top-left corner of the visible screen, camera coordinates, m
kappa right / left  2 + 2  nasal and vertical offset of the visual axis, radians
gain                2      multiplies eye-in-head yaw and pitch, for rows WITHOUT an iris
                           pixel (ARKit); prior 1 +- 0.3 (ARKit is said to under-report)
eye offset          3      added to both eyeball centres, head frame, m; only with several
                           head poses and ``eye_offset=True`` (off by default: in the test
                           simulator it made head-moved accuracy worse)
eye radius          1      rotation centre to iris plane, m; prior 10.2 +- 1 mm
==================  =====  ============================================================

From a single head position, kappa and the screen pose cannot be told apart (rotating the
screen looks like shifting both eyes' kappa), so with one pose kappa is held close to its prior
(SD ``single_pose_kappa_sd_deg``); the report says so. Several head positions
(``calibration.pose_rounds``) free it (SD ``kappa_sd_deg``).

The fit runs on each dot's MEAN eyeball centre and iris ray per eye (per-frame eyeball-centre
jitter costs about 5.6 degrees per millimetre and would bias a per-sample fit). Residuals are
screen errors divided by the eye-to-screen distance (degrees), each (dot, eye) weighted once,
made robust by iterative Huber reweighting; several starting poses (phone below, in front of,
beside or above the screen, tilted) are tried. Live predictions smooth the eyeball centre over
``smooth_centre_s``.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

from ..types import CalibSample, FitReport, GazePoint, Observation, ScreenInfo
from . import features as F
from .base import BaseModel, dot_groups, report_from_predictions

R_BASE = np.diag([-1.0, 1.0, -1.0])
"""Screen axes (x right, y down, normal into the screen) in camera coordinates for a camera that
faces the user squarely: the user's right is the camera's -x."""

DEG = math.pi / 180.0
I_ROT, I_T, I_KR, I_KL, I_GAIN, I_OFF, I_RAD = slice(0, 3), slice(3, 6), slice(6, 8), slice(8, 10), slice(10, 12), slice(12, 15), 15
N_PARAMS = 16

KAPPA_PRIOR = np.array([5.0 * DEG, -1.5 * DEG])
"""Nasal (positive = towards the nose) and vertical (negative = up, since y points down)."""

RADIUS_PRIOR_M = F.EYE_IRIS_DISTANCE_M

RADIUS_BOUNDS_M = (0.006, 0.025)
"""Sanity limits on the fitted eye radius. Deliberately wide: with a biased head-pose estimate the
fit often wants 15-20 mm (the prior is 10.2 +- 1 mm), and in the test simulator holding it to a
human 8.5-13 mm made accuracy after a head move WORSE (2.0 -> 2.6 degrees with three poses). So
the radius may absorb estimator bias; what must not happen is that the resulting implausible
viewing distance flatters the reported accuracy, so :meth:`GeometricModel.degree_distance` falls
back to the measured distance and the report says the solve is implausible."""

ARKIT_USES_GAZE = True
"""In ARKit mode, use ARKit's own eye direction (with the gain) rather than re-deriving the axis
from the measured iris pixel. The re-derived axis turns every millimetre of eye-centre error into
about 5.6 degrees, and ARKit's eye centres inherit the face tracker's jitter and bias; in the
simulator with realistic face-tracking noise this took the geometric model from about 3.5 to
0.5 degrees, and with ARKit's rotation under-reported (gain 0.7) from 5 to 1.5 degrees after a
head move."""

PLAUSIBLE_DISTANCE_RATIO = 0.2
"""The solved viewing distance is trusted for degree conversions only within this fraction of the
eye-to-camera distance the estimators measured."""


def screen_rotation(rv: np.ndarray) -> np.ndarray:
    return R_BASE @ Rotation.from_rotvec(rv).as_matrix()


class EyeData:
    """Per-eye inputs as arrays: eyeball centre ``c``, the estimator's optical axis ``g``, the
    unit ray through the iris centre pixel (NaN when unknown), head rotation, side (+1 right)."""

    def __init__(self) -> None:
        self.c: list[np.ndarray] | np.ndarray = []
        self.g: list[np.ndarray] | np.ndarray = []
        self.ray: list[np.ndarray] | np.ndarray = []
        self.rh: list[np.ndarray] | np.ndarray = []
        self.side: list[float] | np.ndarray = []

    def add(self, obs: Observation, name: str, centre: np.ndarray | None = None) -> bool:
        ci = F.eye_center(obs, name) if centre is None else centre
        gi = F.optical_dir(obs, name)
        if ci is None or gi is None:
            return False
        eye = obs.eye(name)
        ray = np.full(3, np.nan)
        # An iris centre that ARKit's estimator only projected from its own eye model (a seed for
        # the iris edge estimator) is not a measurement; and in ARKit mode ARKit's own direction
        # is preferred anyway (ARKIT_USES_GAZE). Both use the gaze direction with the gain.
        seeded = (obs.provenance or {}).get(f"{name}.iris_center") == "arkit"
        measured = not seeded and not (ARKIT_USES_GAZE and eye.extra.get("gaze_kind") == "arkit_eye_z")
        if measured and eye.iris_center is not None and obs.intrinsics is not None:
            rx, ry = obs.intrinsics.ray(*eye.iris_center)
            ray = np.array([rx, ry, 1.0]) / math.sqrt(rx * rx + ry * ry + 1.0)
        r = F.as_rotation(obs.head_rotation)
        self.c.append(ci)  # type: ignore[union-attr]
        self.g.append(gi)  # type: ignore[union-attr]
        self.ray.append(ray)  # type: ignore[union-attr]
        self.rh.append(np.eye(3) if r is None else r)  # type: ignore[union-attr]
        self.side.append(1.0 if name == "right" else -1.0)  # type: ignore[union-attr]
        return True

    def freeze(self) -> EyeData:
        self.c = np.array(self.c, float).reshape(-1, 3)
        self.g = np.array(self.g, float).reshape(-1, 3)
        self.ray = np.array(self.ray, float).reshape(-1, 3)
        self.rh = np.array(self.rh, float).reshape(-1, 3, 3)
        self.side = np.array(self.side, float)
        self.has_ray = np.all(np.isfinite(self.ray), axis=1)
        return self

    def __len__(self) -> int:
        return len(self.c)


class _Rows(EyeData):
    """Rows of (eye, target) for fitting, plus weights.

    With ``aggregate`` (the default) each (dot, eye) becomes ONE row: the mean eyeball centre,
    mean iris ray and mean head rotation of the dot's samples. Per-frame eyeball-centre jitter
    (about 5.6 degrees of axis error per millimetre) would otherwise bias the non-linear fit;
    averaging first removes most of it. Without ``aggregate``: one row per sample and eye.
    """

    def __init__(self, samples: list[CalibSample], mm: tuple[float, float], aggregate: bool = True) -> None:
        super().__init__()
        per: dict[tuple[int, float], EyeData] = {}
        meta: dict[tuple[int, float], tuple[tuple[float, float], str]] = {}
        tgt, dot, smp = [], [], []
        for i, s in enumerate(samples):
            for name in F.SIDES:
                key = (int(s.dot_id), 1.0 if name == "right" else -1.0)
                if aggregate:
                    if per.setdefault(key, EyeData()).add(s.obs, name):
                        meta[key] = ((s.target[0] * mm[0], s.target[1] * mm[1]), s.kind)
                elif self.add(s.obs, name):
                    tgt.append((s.target[0] * mm[0], s.target[1] * mm[1]))
                    dot.append(s.dot_id)
                    smp.append(s.kind)
        if aggregate:
            for key, ed in per.items():
                if not len(ed.c):
                    continue
                ed.freeze()
                self.c.append(np.mean(ed.c, axis=0))  # type: ignore[union-attr]
                g = np.mean(ed.g, axis=0)
                self.g.append(g / np.linalg.norm(g))  # type: ignore[union-attr]
                if ed.has_ray.all():
                    r = np.mean(ed.ray, axis=0)
                    self.ray.append(r / np.linalg.norm(r))  # type: ignore[union-attr]
                else:
                    self.ray.append(np.full(3, np.nan))  # type: ignore[union-attr]
                u, _, vt = np.linalg.svd(np.mean(ed.rh, axis=0))
                self.rh.append(u @ vt)  # type: ignore[union-attr]
                self.side.append(key[1])  # type: ignore[union-attr]
                tgt.append(meta[key][0])
                dot.append(key[0])
                smp.append(meta[key][1])
        self.freeze()
        self.target_mm = np.array(tgt, float).reshape(-1, 2)
        self.dot = np.array(dot)
        self.dist_mm = np.linalg.norm(self.c, axis=1) * 1000.0 if len(tgt) else np.zeros(0)
        # each (dot, eye) pair has total weight 1
        w = np.zeros(len(tgt))
        for d in np.unique(self.dot):
            for sd in (-1.0, 1.0):
                m = (self.dot == d) & (self.side == sd)
                if m.any():
                    w[m] = 1.0 / m.sum()
        kinds = np.array(smp) if smp else np.zeros(0, str)
        w[kinds == "pursuit"] *= 0.5
        self.weight = w


def forward(p: np.ndarray, d: EyeData) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Screen millimetres hit by each eye's visual axis, a validity mask, and the eye centres.

    Rows with an iris ray re-derive the optical axis from it: the ray is intersected with a
    sphere of radius ``p[I_RAD]`` around the corrected eyeball centre (so an eyeball-centre
    bias, which tilts the estimator's axis by about 5.6 degrees per millimetre, is modelled
    where it arises). Rows without one use the estimator's axis with the gain."""
    rs = screen_rotation(p[I_ROT])
    s0 = p[I_T]
    rh = d.rh
    cc = d.c + np.einsum("mij,j->mi", rh, p[I_OFF])
    g = np.array(d.g, copy=True)
    if d.has_ray.any():
        ray = d.ray[d.has_ray]
        c = cc[d.has_ray]
        b = np.einsum("mi,mi->m", ray, c)
        disc = b * b - (np.einsum("mi,mi->m", c, c) - p[I_RAD] ** 2)
        t = b - np.sqrt(np.maximum(disc, 0.0))
        gi = t[:, None] * ray - c
        g[d.has_ray] = gi / np.linalg.norm(gi, axis=1, keepdims=True)
    # eye-in-head angles of the optical axis
    dh = np.einsum("mji,mj->mi", rh, g)
    yaw = np.arctan2(dh[:, 0], -dh[:, 2])
    pitch = np.arctan2(dh[:, 1], np.hypot(dh[:, 0], dh[:, 2]))
    gain_x = np.where(d.has_ray, 1.0, p[10])
    gain_y = np.where(d.has_ray, 1.0, p[11])
    kr, kl = p[I_KR], p[I_KL]
    right = d.side > 0
    alpha = np.where(right, kr[0], kl[0])
    beta = np.where(right, kr[1], kl[1])
    yaw = gain_x * yaw + d.side * alpha  # nasal is +x (head) for the right eye, -x for the left
    pitch = gain_y * pitch + beta
    v = np.einsum("mij,mj->mi", rh, F.angles_dir(yaw, pitch))
    n = rs[:, 2]
    denom = v @ n
    t = ((s0 - cc) @ n) / np.where(np.abs(denom) < 1e-6, 1e-6, denom)
    hit = cc + t[:, None] * v
    local = (hit - s0) @ rs
    ok = (denom > 0.05) & (t > 0) & np.all(np.isfinite(local), axis=1)
    return local[:, :2] * 1000.0, ok, cc


class GeometricModel(BaseModel):
    """Eye rays + calibrated camera-to-screen pose. Registry name ``geometric``."""

    name = "geometric"

    def __init__(
        self,
        gain: bool = True,
        eye_offset: bool = False,
        kappa_sd_deg: float = 2.5,
        single_pose_kappa_sd_deg: float = 1.0,
        gain_sd: float = 0.3,
        eye_offset_sd_mm: float = 3.0,
        radius: bool = True,
        radius_sd_mm: float = 1.0,
        robust_deg: float = 2.0,
        smooth_centre_s: float = 0.3,
        sigma_deg: float = 1.0,
        distance_sd_m: float = 0.1,
        **extra: Any,
    ) -> None:
        super().__init__(
            gain=gain,
            eye_offset=eye_offset,
            kappa_sd_deg=kappa_sd_deg,
            single_pose_kappa_sd_deg=single_pose_kappa_sd_deg,
            gain_sd=gain_sd,
            eye_offset_sd_mm=eye_offset_sd_mm,
            radius=radius,
            radius_sd_mm=radius_sd_mm,
            robust_deg=robust_deg,
            smooth_centre_s=smooth_centre_s,
            sigma_deg=sigma_deg,
            distance_sd_m=distance_sd_m,
            **extra,
        )
        self.params = self.default_params()
        self.multi_pose = False
        self.viewing_distance_m: float | None = None
        self.measured_distance_m: float | None = None
        self._screen_m: tuple[float, float] | None = None
        self.person_prior: np.ndarray | None = None
        self._warm: np.ndarray | None = None
        self._smooth: dict[str, tuple[float, np.ndarray]] = {}

    def warm_start(self, other: BaseModel) -> None:
        """Start the next fit from ``other``'s solution (leave-one-dot-out refits)."""
        if isinstance(other, GeometricModel) and other.fitted:
            self._warm = other.params.copy()
            self.person_prior = None if other.person_prior is None else other.person_prior.copy()

    # --- parameters ---------------------------------------------------------------------------

    @staticmethod
    def default_params() -> np.ndarray:
        p = np.zeros(N_PARAMS)
        p[I_KR] = KAPPA_PRIOR
        p[I_KL] = KAPPA_PRIOR
        p[I_GAIN] = 1.0
        p[I_RAD] = RADIUS_PRIOR_M
        return p

    def _prior(self, free: np.ndarray, pose_prior: tuple[np.ndarray, float, float] | None) -> tuple[np.ndarray, np.ndarray]:
        """Prior mean and SD for every parameter (inf SD = no prior)."""
        o = self.options
        mean = self.default_params()
        if self.person_prior is not None:
            mean[6:] = self.person_prior[6:]
        sd = np.full(N_PARAMS, np.inf)
        ksd = (o["kappa_sd_deg"] if self.multi_pose else o["single_pose_kappa_sd_deg"]) * DEG
        sd[6:10] = ksd
        sd[I_GAIN] = o["gain_sd"]
        sd[I_OFF] = o["eye_offset_sd_mm"] / 1000.0
        sd[I_RAD] = o["radius_sd_mm"] / 1000.0
        if pose_prior is not None:
            p0, rot_sd, t_sd = pose_prior
            mean[0:6] = p0[0:6]
            sd[I_ROT] = rot_sd
            sd[I_T] = t_sd
        return mean, sd

    def _free_mask(self, person: bool) -> np.ndarray:
        free = np.zeros(N_PARAMS, bool)
        free[0:6] = True
        if person:
            free[6:10] = True
            free[I_GAIN] = bool(self.options["gain"])
            free[I_OFF] = bool(self.options["eye_offset"]) and (self.multi_pose or bool(self.options.get("eye_offset_single")))
            free[I_RAD] = bool(self.options["radius"])
        return free

    # --- solving -----------------------------------------------------------------------------

    def _solve(self, rows: _Rows, p0: np.ndarray, free: np.ndarray, pose_prior: tuple[np.ndarray, float, float] | None = None, irls: int = 3, max_nfev: int = 200) -> tuple[np.ndarray, float]:
        mean, sd = self._prior(free, pose_prior)
        has_prior = free & np.isfinite(sd)
        sigma = float(self.options["sigma_deg"])
        k = float(self.options["robust_deg"])
        robust_w = np.ones(len(rows))
        p = p0.copy()
        cam_mu = float(self.options.get("camera_depth_m", -0.05))
        cam_sd = float(self.options.get("camera_depth_sd_m") or 0.0)
        dist_sd = float(self.options.get("distance_sd_m") or 0.0)
        screen_m = self._screen_m
        measured = float(np.mean(np.linalg.norm(np.asarray(rows.c), axis=1))) if len(rows) else 0.0

        def residuals(x: np.ndarray) -> np.ndarray:
            q = p.copy()
            q[free] = x
            mm, ok, _ = forward(q, rows)
            err = (mm - rows.target_mm) / rows.dist_mm[:, None] * (180.0 / math.pi)  # ~degrees
            err = np.where(ok[:, None], err, 30.0)
            r = (err * np.sqrt(rows.weight * robust_w)[:, None] / sigma).ravel()
            pr = (q[has_prior] - mean[has_prior]) / sd[has_prior]
            extra = []
            if cam_sd and pose_prior is None:
                cam = screen_rotation(q[I_ROT]).T @ (-q[I_T])
                extra.append((cam[2] - cam_mu) / cam_sd)
            if dist_sd and screen_m is not None and measured > 0 and pose_prior is None:
                # The eyes' distance to the screen centre is close to their measured distance to
                # the camera (the phone sits near the screen). Without this, a single head position
                # cannot tell "the screen is farther" from "the eye turns less than it should".
                centre = q[I_T] + screen_rotation(q[I_ROT]) @ np.array([screen_m[0] / 2, screen_m[1] / 2, 0.0])
                d_model = float(np.mean(np.linalg.norm(cc_rows(q) - centre, axis=1)))
                extra.append((d_model - measured) / dist_sd)
            return np.concatenate([r, pr, extra])

        def cc_rows(q: np.ndarray) -> np.ndarray:
            return np.asarray(rows.c) + np.einsum("mij,j->mi", rows.rh, q[I_OFF])

        lo = np.full(N_PARAMS, -np.inf)
        hi = np.full(N_PARAMS, np.inf)
        lo[I_RAD], hi[I_RAD] = RADIUS_BOUNDS_M
        p[I_RAD] = float(np.clip(p[I_RAD], RADIUS_BOUNDS_M[0] + 1e-6, RADIUS_BOUNDS_M[1] - 1e-6))
        bounds = (lo[free], hi[free])
        cost = math.inf
        for it in range(max(1, irls)):
            sol = least_squares(residuals, p[free], method="trf", x_scale="jac", max_nfev=max_nfev, bounds=bounds)
            p[free] = sol.x
            cost = float(sol.cost)
            if it == irls - 1:
                break
            mm, ok, _ = forward(p, rows)
            e = np.linalg.norm(mm - rows.target_mm, axis=1) / rows.dist_mm * (180.0 / math.pi)
            new_w = np.where(ok, np.minimum(1.0, k / np.maximum(e, 1e-9)), 0.0)
            if np.allclose(new_w, robust_w, atol=1e-3):
                break
            robust_w = new_w
        return p, cost

    def _starts(self, screen_m: tuple[float, float]) -> list[np.ndarray]:
        w, h = screen_m
        places = [
            (w / 2, h + 0.02, 0.0),  # below the screen, in its plane (phone on a stand under it)
            (w / 2, h + 0.02, -0.12),  # below and in front (phone on the desk, nearer the user)
            (w / 2, h + 0.10, -0.25),
            (-0.04, h * 0.6, 0.0),  # beside the screen
            (w + 0.04, h * 0.6, 0.0),
            (w / 2, -0.02, 0.0),  # above the screen
        ]
        tilts = (0.0, 0.3, -0.3)
        out = []
        for q in places:
            for tilt in tilts:
                rv = np.array([tilt, 0.0, 0.0])
                rs = screen_rotation(rv)
                p = self.default_params()
                if self.person_prior is not None:
                    p[6:] = self.person_prior[6:]
                p[I_ROT] = rv
                p[I_T] = -rs @ np.asarray(q)
                out.append(p)
        return out

    def _detect_multi_pose(self, samples: list[CalibSample]) -> bool:
        groups = {s.pose_group for s in samples}
        pos = [F.head_position(s.obs) for s in samples]
        pos = np.array([p for p in pos if p is not None])
        spread = float(np.max(np.ptp(pos, axis=0))) if len(pos) > 2 else 0.0
        return len(groups) > 1 and spread > 0.03 or spread > 0.06

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        init, self._warm = self._warm, None
        mm = self.mm_per_point
        screen_m = (screen.width * mm[0] / 1000.0, screen.height * mm[1] / 1000.0)
        self._screen_m = screen_m
        rows = _Rows(samples, mm)
        n_dots = len(dot_groups(samples))
        if len(rows) < 4 or len(np.unique(rows.dot)) < 3:
            self.fitted = False
            return FitReport(model=self.name, ok=False, n_samples=len(samples), n_dots=n_dots, message="needs eyeball centres and gaze directions for at least 3 dots")
        self.multi_pose = self._detect_multi_pose(samples)
        if init is not None:
            p, _ = self._solve(rows, init, self._free_mask(True), irls=2, max_nfev=100)
        else:
            best: tuple[float, np.ndarray] | None = None
            pose_only = self._free_mask(False)
            for start in self._starts(screen_m):
                p, cost = self._solve(rows, start, pose_only, irls=1, max_nfev=60)
                if best is None or cost < best[0]:
                    best = (cost, p)
            assert best is not None
            p, _ = self._solve(rows, best[1], self._free_mask(True))
        self.params = p
        self.fitted = True
        self.viewing_distance_m = self._viewing_distance(rows, screen_m)
        self.measured_distance_m = float(np.median(np.linalg.norm(np.asarray(rows.c), axis=1))) if len(rows) else None
        pred = self.predict_samples(samples, raw=True)
        msg = "several head positions: kappa and eye offset fitted" if self.multi_pose else "one head position: kappa held near its prior (repeat the grid from a second head position to fit it)"
        if not self.distance_plausible():
            msg += (
                f" The solved setup is implausible (viewing distance {self.viewing_distance_m:.2f} m, but the eyes were measured"
                f" {self.measured_distance_m:.2f} m from the camera): an estimator is probably biased; degrees use the measured distance."
            )
        return report_from_predictions(self.name, samples, pred, screen, self.degree_distance(), params=self.summary(), message=msg)

    def distance_plausible(self) -> bool:
        """Whether the solved viewing distance agrees with the measured eye-to-camera distance."""
        v, m = self.viewing_distance_m, self.measured_distance_m
        return not (v and m and abs(v - m) > PLAUSIBLE_DISTANCE_RATIO * m)

    def _viewing_distance(self, rows: _Rows, screen_m: tuple[float, float]) -> float | None:
        if not len(rows):
            return None
        rs = screen_rotation(self.params[I_ROT])
        centre = self.params[I_T] + rs @ np.array([screen_m[0] / 2, screen_m[1] / 2, 0.0])
        _, _, cc = forward(self.params, rows)
        return float(np.median(np.linalg.norm(cc - centre, axis=1)))

    # --- refine ------------------------------------------------------------------------------

    def refine_pose(self, samples: list[CalibSample], screen: ScreenInfo, rot_sd_deg: float = 8.0, t_sd_m: float = 0.05) -> bool:
        """Re-solve only the camera-to-screen pose, keeping the person parameters. Returns
        False when there is too little data."""
        if not self.fitted:
            return False
        rows = _Rows(samples, self.mm_per_point)
        if len(rows) < 4 or len(np.unique(rows.dot)) < 3:
            return False
        p, _ = self._solve(rows, self.params, self._free_mask(False), pose_prior=(self.params.copy(), rot_sd_deg * DEG, t_sd_m), irls=3)
        self.params = p
        return True

    # --- prediction ----------------------------------------------------------------------------

    def _smoothed_centre(self, obs: Observation, side: str) -> np.ndarray | None:
        """The eyeball centre, exponentially smoothed over time (``smooth_centre_s``).

        The rotation centre is fixed in the head and the head moves slowly, while per-frame
        estimates of it jitter (1 mm of jitter is about 5.6 degrees of gaze error). Resets on a
        jump of more than 2 cm, a gap of more than 1 s, or time going backwards (a new sequence).
        Calling again with the same ``obs.t`` returns the stored value (``predict`` and
        ``predict_all`` both see each frame)."""
        c = F.eye_center(obs, side)
        tau = float(self.options.get("smooth_centre_s") or 0.0)
        if c is None or tau <= 0:
            return c
        prev = self._smooth.get(side)
        if prev is not None and obs.t == prev[0]:
            return prev[1]
        if prev is None or obs.t < prev[0] or obs.t - prev[0] > 1.0 or np.linalg.norm(c - prev[1]) > 0.02:
            new = c
        else:
            a = 1.0 - math.exp(-(obs.t - prev[0]) / tau)
            new = prev[1] + a * (c - prev[1])
        self._smooth[side] = (obs.t, new)
        return new

    def eye_points(self, obs: Observation, smooth: bool = False) -> dict[str, tuple[float, float]]:
        """Per-eye screen points (before the output correction)."""
        d = EyeData()
        names = [n for n in F.SIDES if d.add(obs, n, self._smoothed_centre(obs, n) if smooth else None)]
        if not names:
            return {}
        mm, ok, _ = forward(self.params, d.freeze())
        mx, my = self.mm_per_point
        return {n: (float(m[0] / mx), float(m[1] / my)) for n, m, k in zip(names, mm, ok) if k}

    def predict_samples(self, samples: list[CalibSample], raw: bool = False) -> np.ndarray:
        """Vectorised batch prediction for the raw path (fitting and leave-one-dot-out score
        thousands of samples); the live path goes sample by sample."""
        if raw is False or not self.fitted:
            return super().predict_samples(samples, raw=raw)
        d = EyeData()
        owner, sides, conf = [], [], []
        for i, smp in enumerate(samples):
            for name in F.SIDES:
                if d.add(smp.obs, name):
                    owner.append(i)
                    sides.append(name)
                    conf.append(F.eye_confidence(smp.obs, name))
        out = np.full((len(samples), 2), np.nan)
        if not owner:
            return out
        mm, ok, _ = forward(self.params, d.freeze())
        pts = mm / np.array(self.mm_per_point)
        w = np.where(ok, np.maximum(np.array(conf), 1e-3), 0.0)
        num = np.zeros((len(samples), 2))
        den = np.zeros(len(samples))
        np.add.at(num, np.array(owner), pts * w[:, None])
        np.add.at(den, np.array(owner), w)
        good = den > 0
        out[good] = num[good] / den[good, None]
        return out

    def dot_predictions(self, samples: list[CalibSample]) -> tuple[list[int], np.ndarray, np.ndarray, np.ndarray]:
        """Per dot, the prediction from the dot's MEAN eyeball centre and iris ray per eye (as
        the fit uses), with the correction applied."""
        if not self.fitted:
            return super().dot_predictions(samples)
        rows = _Rows(samples, (1.0, 1.0))
        ids = list(dot_groups(samples))
        pred = np.full((len(ids), 2), np.nan)
        target = np.array([next(s.target for s in samples if s.dot_id == d) for d in ids], float).reshape(-1, 2)
        dist = np.full(len(ids), np.nan)
        if len(rows):
            mm, ok, cc = forward(self.params, rows)
            pts = mm / np.array(self.mm_per_point)
            for k, d in enumerate(ids):
                m = ok & (rows.dot == d)
                if m.any():
                    pred[k] = self.correction.apply_many(pts[m].mean(axis=0)[None, :])[0]
                    dist[k] = float(np.linalg.norm(cc[m].mean(axis=0)))
        return ids, pred, target, dist

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        pts = self.eye_points(obs, smooth=self._live)
        if not pts:
            return None
        from ..filters import fuse_eyes

        x, y, conf = fuse_eyes(pts.get("left"), pts.get("right"), F.eye_confidence(obs, "left"), F.eye_confidence(obs, "right"))
        return GazePoint(x=x, y=y, t=obs.t, confidence=conf, model=self.name, t_local=obs.t_local, left=pts.get("left"), right=pts.get("right"))

    def degree_distance(self) -> float | None:
        """Eye-to-screen distance for degree conversions: the solved viewing distance, or the
        measured eye-to-camera distance when the solve is implausible."""
        if not self.distance_plausible():
            return self.measured_distance_m
        return self.viewing_distance_m

    # --- description / persistence ------------------------------------------------------------

    def screen_pose(self) -> dict[str, Any]:
        """The solved camera-to-screen pose: screen axes and top-left corner in camera
        coordinates, the camera's position in screen coordinates (mm from the top-left corner,
        z towards the user is negative), and the viewing distance."""
        rs = screen_rotation(self.params[I_ROT])
        s0 = self.params[I_T]
        cam_local = rs.T @ (-s0)
        tilt = math.degrees(math.acos(max(-1.0, min(1.0, float(-rs[2, 2])))))
        return {
            "rotation": rs.tolist(),
            "top_left_m": s0.tolist(),
            "normal": rs[:, 2].tolist(),
            "camera_in_screen_mm": (cam_local * 1000.0).tolist(),
            "camera_tilt_deg": tilt,
            "viewing_distance_m": self.viewing_distance_m,
        }

    def summary(self) -> dict[str, Any]:
        p = self.params
        pose = self.screen_pose()
        return {
            "kappa_right_deg": [float(v / DEG) for v in p[I_KR]],
            "kappa_left_deg": [float(v / DEG) for v in p[I_KL]],
            "gain": [float(v) for v in p[I_GAIN]],
            "eye_offset_mm": [float(v * 1000) for v in p[I_OFF]],
            "eye_radius_mm": float(p[I_RAD] * 1000),
            "camera_in_screen_mm": [round(v, 1) for v in pose["camera_in_screen_mm"]],
            "camera_tilt_deg": round(pose["camera_tilt_deg"], 1),
            "viewing_distance_m": self.viewing_distance_m,
            "measured_distance_m": self.measured_distance_m,
            "distance_plausible": self.distance_plausible(),
            "multi_pose": self.multi_pose,
        }

    def person_params(self) -> dict[str, Any]:
        return {"params": self.params[6:].tolist(), "multi_pose": self.multi_pose, **{k: v for k, v in self.summary().items() if k.startswith(("kappa", "gain", "eye_"))}}

    def setup_params(self) -> dict[str, Any]:
        return {"params": self.params[:6].tolist(), **self.screen_pose()}

    def set_person(self, person: dict[str, Any]) -> None:
        self.params[6:] = np.asarray(person["params"], float)
        self.person_prior = self.params.copy()

    def _state(self) -> dict[str, Any]:
        return {"params": self.params.tolist(), "multi_pose": self.multi_pose, "viewing_distance_m": self.viewing_distance_m, "measured_distance_m": self.measured_distance_m, "summary": self.summary()}

    def _load_state(self, state: dict[str, Any]) -> None:
        params = np.asarray(state["params"], float)
        if len(params) < N_PARAMS:  # older saves had no eye radius
            params = np.concatenate([params, self.default_params()[len(params) :]])
        self.params = params
        self.multi_pose = bool(state.get("multi_pose", False))
        self.viewing_distance_m = state.get("viewing_distance_m")
        self.measured_distance_m = state.get("measured_distance_m")
