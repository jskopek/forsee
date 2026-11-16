"""Gaze models that use the second camera. They are added to a calibration by the engine (not
listed in ``phonegaze.models.REGISTRY``, which the Models area owns), so a saved calibration
reloads without them (logged) until the next calibration.

- ``geometric_2cam``: the geometric model with its camera-to-screen pose taken from the phone-pose
  solve, either ``fixed`` (calibration fits only the person: kappa, eye radius, gain) or as a
  ``prior`` around which the calibration's own pose solve may move. The pose comes from the
  ``second_camera`` stamp the engine puts on every observation, so a recorded calibration refits
  the same way.
- ``webcam``: the geometric model on the WEBCAM's observation alone, its screen pose known from the
  display geometry (held by a prior), as a baseline to measure the phone against.
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any

import numpy as np

from ..models.base import BaseModel, dot_groups, report_from_predictions
from ..models.geometric import DEG, GeometricModel, _Rows
from ..types import CalibSample, FitReport, GazePoint, Observation, ScreenInfo

NAME = "second_camera"

PRIOR_MIN_ROT_DEG = 3.0
PRIOR_MIN_T_M = 0.03
"""Floors for the prior's standard deviations: the solve's reported uncertainty covers its noise
but not the webcam's biases (field of view, head-pose bias), which are typically this large."""

WEBCAM_PRIOR_ROT_DEG = 3.0
WEBCAM_PRIOR_T_M = 0.03


def stamp(obs: Observation) -> dict[str, Any]:
    s = obs.extra.get(NAME)
    return s if isinstance(s, dict) else {}


def latest_pose_stamp(samples: list[CalibSample]) -> dict[str, Any] | None:
    """The most recent phone-pose stamp among the samples (the solve averages over time, so the
    last one has seen the most frames)."""
    best = None
    for s in samples:
        st = stamp(s.obs).get("phone_from_screen")
        if st and (best is None or (s.obs.t_local or 0) >= best[0]):
            best = (s.obs.t_local or 0, st)
    return None if best is None else best[1]


def webcam_obs(obs: Observation) -> Observation | None:
    w = stamp(obs).get("webcam")
    if w is None:
        return None
    if isinstance(w, Observation):
        return w
    if isinstance(w, dict):
        try:
            return Observation.from_dict(w)
        except (KeyError, TypeError, ValueError):
            return None
    return None


class _PoseFromStamp(GeometricModel):
    """Shared fitting with the screen pose given (fixed or as a prior)."""

    def _pose_and_sd(self, samples: list[CalibSample]) -> tuple[np.ndarray, float, float] | None:
        raise NotImplementedError

    def _fit_with_pose(self, samples: list[CalibSample], screen: ScreenInfo, mode: str) -> FitReport:
        init, self._warm = self._warm, None
        mm = self.mm_per_point
        screen_m = (screen.width * mm[0] / 1000.0, screen.height * mm[1] / 1000.0)
        self._screen_m = screen_m
        n_dots = len(dot_groups(samples))
        pose = self._pose_and_sd(samples)
        if pose is None:
            self.fitted = False
            return FitReport(model=self.name, ok=False, n_samples=len(samples), n_dots=n_dots, message="no screen pose from the second camera during calibration (is it anchored?)")
        p_pose, rot_sd, t_sd = pose
        rows = _Rows(samples, mm)
        min_dots = 2 if mode == "fixed" else 3
        if len(rows) < 4 or len(np.unique(rows.dot)) < min_dots:
            self.fitted = False
            return FitReport(model=self.name, ok=False, n_samples=len(samples), n_dots=n_dots, message=f"needs eyeball centres and gaze directions for at least {min_dots} dots")
        self.multi_pose = self._detect_multi_pose(samples)
        p0 = self.default_params() if init is None else init.copy()
        if self.person_prior is not None and init is None:
            p0[6:] = self.person_prior[6:]
        p0[0:6] = p_pose
        free = self._free_mask(True)
        if mode == "fixed":
            free[0:6] = False
            p, _ = self._solve(rows, p0, free)
        else:
            p, _ = self._solve(rows, p0, free, pose_prior=(p0.copy(), rot_sd, t_sd))
        self.params = p
        self.fitted = True
        self.viewing_distance_m = self._viewing_distance(rows, screen_m)
        self.measured_distance_m = float(np.median(np.linalg.norm(np.asarray(rows.c), axis=1))) if len(rows) else None
        pred = GeometricModel.predict_samples(self, samples, raw=True)  # samples are already the camera's own
        moved =float(np.linalg.norm(p[3:6] - p_pose[3:6]))
        msg = f"screen pose {'fixed' if mode == 'fixed' else 'from a prior'} from the second camera" + (f" (calibration moved it {moved * 100:.1f} cm)" if mode != "fixed" else "")
        params = {**self.summary(), "pose_mode": mode, "prior_rot_sd_deg": rot_sd / DEG, "prior_t_sd_m": t_sd, "pose_moved_m": moved}
        return report_from_predictions(self.name, samples, pred, screen, self.degree_distance(), params=params, message=msg)


class Geometric2CamModel(_PoseFromStamp):
    """Registry name ``geometric_2cam``. Option ``pose_mode``: ``"fixed"`` or ``"prior"``."""

    name = "geometric_2cam"

    def __init__(self, pose_mode: str = "fixed", **options: Any) -> None:
        super().__init__(pose_mode=pose_mode, **options)

    def _pose_and_sd(self, samples: list[CalibSample]) -> tuple[np.ndarray, float, float] | None:
        st = latest_pose_stamp(samples)
        if st is None:
            return None
        rot_sd = max(3.0 * float(st.get("se_rot_deg") or 0.0), PRIOR_MIN_ROT_DEG) * DEG
        t_sd = max(3.0 * float(st.get("se_t_m") or 0.0), PRIOR_MIN_T_M)
        return np.asarray(st["params"], float), rot_sd, t_sd

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        return self._fit_with_pose(samples, screen, str(self.options.get("pose_mode", "fixed")))


class WebcamGeometricModel(_PoseFromStamp):
    """Registry name ``webcam``: gaze from the webcam alone (the phone's observation is ignored
    apart from carrying the webcam's in its stamp)."""

    name = "webcam"

    def __init__(self, **options: Any) -> None:
        super().__init__(**options)

    # every entry point sees the webcam's observation instead of the phone's
    @staticmethod
    def _swap(samples: list[CalibSample]) -> tuple[list[CalibSample], list[int]]:
        out, idx = [], []
        for i, s in enumerate(samples):
            w = webcam_obs(s.obs)
            if w is not None:
                if "webcam_from_screen" not in stamp(w) and stamp(s.obs).get("webcam_from_screen") is not None:
                    w = dataclasses.replace(w, extra={**w.extra, NAME: {"webcam_from_screen": stamp(s.obs)["webcam_from_screen"]}})
                out.append(dataclasses.replace(s, obs=w))
                idx.append(i)
        return out, idx

    def _pose_and_sd(self, samples: list[CalibSample]) -> tuple[np.ndarray, float, float] | None:
        for s in reversed(samples):
            p = stamp(s.obs).get("webcam_from_screen")
            if p is not None:
                return np.asarray(p, float), WEBCAM_PRIOR_ROT_DEG * DEG, WEBCAM_PRIOR_T_M
        return None

    def _fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        swapped, _ = self._swap(samples)
        if not swapped:
            self.fitted = False
            return FitReport(model=self.name, ok=False, n_samples=len(samples), message="no webcam observations during calibration")
        return self._fit_with_pose(swapped, screen, "prior")

    def predict_samples(self, samples: list[CalibSample], raw: bool = False) -> np.ndarray:
        """``samples`` carry PHONE observations (as everywhere else): the live path swaps in
        :meth:`_predict_raw`, the raw batch path here."""
        if not raw:
            return BaseModel.predict_samples(self, samples, raw=False)
        out = np.full((len(samples), 2), np.nan)
        swapped, idx = self._swap(samples)
        if swapped:
            out[idx] = GeometricModel.predict_samples(self, swapped, raw=True)
        return out

    def dot_predictions(self, samples: list[CalibSample]) -> tuple[list[int], np.ndarray, np.ndarray, np.ndarray]:
        swapped, _ = self._swap(samples)
        return super().dot_predictions(swapped)

    def refine_pose(self, samples: list[CalibSample], screen: ScreenInfo, rot_sd_deg: float = 8.0, t_sd_m: float = 0.05) -> bool:
        swapped, _ = self._swap(samples)
        return super().refine_pose(swapped, screen, rot_sd_deg, t_sd_m)

    def _predict_raw(self, obs: Observation) -> GazePoint | None:
        w = webcam_obs(obs)
        if w is None:
            return None
        p = super()._predict_raw(w)
        if p is not None:
            p.t, p.t_local = obs.t, obs.t_local
        return p

    @classmethod
    def uncalibrated(cls, webcam_from_screen_params: np.ndarray, screen: ScreenInfo) -> WebcamGeometricModel:
        """Default person (textbook kappa, eye radius) and the geometry's screen pose: the
        coarse gaze the wide head box falls back on before any calibration."""
        from ..models.base import mm_per_point

        m = cls()
        mx, my, _ = mm_per_point(screen)
        m.mm_per_point = (mx, my)
        m.screen_size = (float(screen.width), float(screen.height))
        m.params[0:6] = np.asarray(webcam_from_screen_params, float)
        m.fitted = True
        return m


def degrees_between(a: np.ndarray, b: np.ndarray) -> float:
    c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))
