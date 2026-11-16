"""Face landmarks on webcam frames: the existing ``landmarks`` estimator run on the webcam
image, with intrinsics from the assumed field of view (the webcam's real intrinsics are not
known). Gives head pose, eye positions and distance in WEBCAM camera coordinates.
"""

from __future__ import annotations

import math
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..types import CameraInfo, DecodedFrame, DecodedImage, Frame, Intrinsics, LensState, Observation
from .geometry import Pose
from .webcam import WebcamFrame

WEBCAM_CAMERA_ID = "mac-webcam"


def webcam_intrinsics(width: int, height: int, hfov_deg: float) -> Intrinsics:
    """Square pixels, centred principal point, focal length from the horizontal field of view."""
    return Intrinsics.from_fov(int(width), int(height), float(hfov_deg))


def decode_webcam(frame: WebcamFrame, hfov_deg: float, mirror: bool = False) -> DecodedFrame:
    """Wrap a webcam image as the ``DecodedFrame`` the estimators expect (one ``wide`` image
    covering the whole frame, already upright)."""
    import cv2

    pixels = frame.pixels
    if mirror:
        pixels = cv2.flip(pixels, 1)
    h, w = pixels.shape[:2]
    intr = webcam_intrinsics(w, h, hfov_deg)
    cam = CameraInfo(id=WEBCAM_CAMERA_ID, position="front", type="webcam", zoom=1.0, width=w, height=h, intrinsics=intr, intrinsics_source="fov", fov_deg=hfov_deg)
    fr = Frame(seq=frame.seq, t=frame.t_local, mode="camera", camera=cam, lens=LensState(), gravity=None, rotation_rate=None, parts=[], t_received=frame.t_local, header={})
    img = DecodedImage(name="wide", kind="wide", pixels=pixels, to_full=np.eye(3), rect_full=(0.0, 0.0, float(w), float(h)))
    return DecodedFrame(frame=fr, rotation=0, width=w, height=h, intrinsics=intr, images={"wide": img}, sensor_to_upright=np.eye(3), sensor_to_upright_3d=np.eye(3))


def ray_rotation(p: np.ndarray) -> np.ndarray:
    """The rotation that turns the camera's axis (0, 0, 1) onto the line of sight to ``p`` with
    the least rotation."""
    d = np.asarray(p, float) / np.linalg.norm(p)
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(z, d)
    s, c = float(np.linalg.norm(v)), float(d[2])
    if s < 1e-12:
        return np.eye(3)
    k = v / s
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * kx + (1 - c) * (kx @ kx)


def head_pose(obs: Observation | None, ray_correct: bool = False) -> Pose | None:
    """``camera_from_head`` from an observation's head rotation and position.

    ``ray_correct``: MediaPipe's face rotation is relative to the line of sight to the face (it
    fits a face seen straight on), not to the camera's axis, so a face off to one side reads as
    turned by that angle. Correct it by the line of sight's rotation. Only for rotations from the
    ``landmarks`` estimator; in the simulator this took the webcam's head-rotation error from
    about 7 to 0.5 degrees with the face 7 degrees off axis."""
    if obs is None or obs.head_rotation is None or obs.head_position is None:
        return None
    r = np.asarray(obs.head_rotation, float)
    t = np.asarray(obs.head_position, float)
    if r.shape != (3, 3) or not np.all(np.isfinite(r)) or not np.all(np.isfinite(t)) or t[2] <= 0:
        return None
    if ray_correct and (obs.provenance or {}).get("head_rotation") == "landmarks":
        r = ray_rotation(t) @ r
    return Pose(r, t)


def face_ok(obs: Observation | None, max_angle_deg: float = 40.0) -> tuple[bool, str]:
    """Whether a face observation is good enough to anchor on, and why not."""
    if obs is None:
        return False, "no face"
    if head_pose(obs) is None:
        return False, "no head pose"
    for side in ("left", "right"):
        e = obs.eye(side)
        if not e.found or e.eyeball_center is None:
            return False, f"{side} eye not found"
        if e.blink:
            return False, "blink"
    if not obs.distance or not (0.2 < obs.distance < 2.0):
        return False, "implausible distance"
    r = np.asarray(obs.head_rotation, float)
    facing = -r[:, 2]  # the face points along the head frame's -z
    ang = math.degrees(math.acos(max(-1.0, min(1.0, float(-facing[2])))))
    if ang > max_angle_deg:
        return False, "head turned too far"
    return True, ""


@dataclass
class WebcamSample:
    t_local: float
    obs: Observation
    ok: bool
    why: str
    truth: dict[str, Any] | None = None


class WebcamTracker:
    """Runs the face landmarker on webcam frames (on the webcam thread) and keeps the last few
    seconds of observations for pairing with phone frames."""

    def __init__(self, hfov_deg: float = 68.0, mirror: bool = False, landmarks_model: str = "face_landmarker.task", keep_s: float = 3.0, estimator: Any = None) -> None:
        from ..vision.landmarks import LandmarkEstimator

        self.hfov_deg = float(hfov_deg)
        self.mirror = mirror
        self.keep_s = keep_s
        self.estimator = estimator or LandmarkEstimator(_Cfg(landmarks_model))
        self.samples: deque[WebcamSample] = deque()
        self.lock = threading.Lock()
        self.last_frame: WebcamFrame | None = None
        self.last_decoded: DecodedFrame | None = None
        self.last_obs: Observation | None = None
        self.frames = 0
        self.faces = 0

    def process(self, frame: WebcamFrame) -> WebcamSample:
        decoded = decode_webcam(frame, self.hfov_deg, self.mirror)
        obs = Observation.empty(decoded)
        try:
            res = self.estimator.process(decoded, obs)
        except Exception:  # noqa: BLE001
            res = None
        obs = res if res is not None else obs
        ok, why = face_ok(res)
        sample = WebcamSample(frame.t_local, obs, ok, why, frame.truth)
        with self.lock:
            self.frames += 1
            self.faces += 1 if res is not None else 0
            self.last_frame, self.last_decoded, self.last_obs = frame, decoded, obs
            self.samples.append(sample)
            while self.samples and self.samples[0].t_local < frame.t_local - self.keep_s:
                self.samples.popleft()
        return sample

    def bracket(self, t: float, max_skew_s: float) -> tuple[WebcamSample | None, WebcamSample | None]:
        """The good samples just before and just after ``t`` (each within ``max_skew_s``)."""
        before = after = None
        with self.lock:
            for s in reversed(self.samples):
                if not s.ok:
                    continue
                if s.t_local <= t:
                    if t - s.t_local <= max_skew_s:
                        before = s
                    break
                if s.t_local - t <= max_skew_s:
                    after = s
        return before, after

    def nearest(self, t: float, max_skew_s: float) -> WebcamSample | None:
        with self.lock:
            best = None
            for s in self.samples:
                if best is None or abs(s.t_local - t) < abs(best.t_local - t):
                    best = s
        return best if best is not None and abs(best.t_local - t) <= max_skew_s else None

    def close(self) -> None:
        """Close MediaPipe's landmarker now: left to interpreter shutdown it can hang the
        process."""
        close_mediapipe(self.estimator)

    def reset(self) -> None:
        with self.lock:
            self.samples.clear()
        try:
            self.estimator.reset()
        except Exception:  # noqa: BLE001
            pass


def close_mediapipe(obj: Any) -> None:
    """Close any MediaPipe task an estimator holds (its attributes)."""
    for value in list(vars(obj).values()) if hasattr(obj, "__dict__") else []:
        if type(value).__module__.startswith("mediapipe") and hasattr(value, "close"):
            try:
                value.close()
            except Exception:  # noqa: BLE001
                pass


class _Cfg:
    def __init__(self, model: str) -> None:
        self.landmarks_model = model
        self.landmarks_every = 1
