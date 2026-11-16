"""The second camera inside the engine: owns the webcam thread, the face tracker and the
phone-pose solver, and offers the small hooks ``pipeline.Engine`` calls. With
``second_camera.enabled`` off every hook returns its input unchanged and the webcam is never
opened.
"""

from __future__ import annotations

import logging
import math
import time
from collections import deque
from typing import Any

import numpy as np

from ..types import Frame, GazePoint, Observation
from . import fusion
from .geometry import DEG, Pose, geometric_params, interpolate_pose, screen_from_webcam
from .models import Geometric2CamModel, WebcamGeometricModel
from .solver import PhonePoseSolver
from .tracker import WebcamTracker, face_ok, head_pose
from .webcam import SourceThread, WebcamError, make_source

log = logging.getLogger(__name__)

NAME = fusion.NAME
FALLBACK_CONFIDENCE = 0.25
"""Confidence given to the coarse webcam-only gaze the wide head box falls back on."""


def _eye_points(obs: Observation) -> np.ndarray:
    return np.array([obs.left.eyeball_center, obs.right.eyeball_center, obs.head_position], float)


class SecondCamera:
    """One per engine. All public methods are called on the engine's event-loop thread, except
    that the webcam thread feeds the tracker."""

    def __init__(self, engine: Any) -> None:
        self.engine = engine
        self.tracker: WebcamTracker | None = None
        self.thread: SourceThread | None = None
        self.source_name: str | None = None
        self.error: str | None = None
        self._key: tuple | None = None
        self.solver = self._new_solver()
        self.reference_segment: int | None = None
        self.reference_pose: Pose | None = None
        self._dist_pairs: deque = deque(maxlen=900)
        self._last_why = ""
        self._paired = 0
        self._moved_msg_t = -math.inf
        self._uncal: WebcamGeometricModel | None = None
        self._uncal_key: tuple | None = None
        self.last_transform: dict[str, Any] | None = None
        self.fallbacks = 0

    # -- config and life cycle --------------------------------------------------------------------

    @property
    def cfg(self) -> Any:
        return self.engine.config.second_camera

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.enabled)

    def _new_solver(self) -> PhonePoseSolver:
        c = self.engine.config.second_camera
        return PhonePoseSolver(c.solve_method, c.window_s, c.min_pairs, c.move_rotation_dps, c.move_gravity_deg, c.move_vision)

    def _sim_url(self) -> str | None:
        sim = getattr(self.engine, "_sim", None)
        return getattr(sim, "base_url", None) if self.engine.simulated and sim is not None else None

    def sync(self) -> None:
        """Start, restart or stop the webcam to match the config (cheap when nothing changed)."""
        c = self.cfg
        s = self.solver
        s.method, s.window_s, s.min_pairs = c.solve_method, c.window_s, c.min_pairs
        s.move_rotation_dps, s.move_gravity_deg, s.move_vision = c.move_rotation_dps, c.move_gravity_deg, c.move_vision
        if self.tracker is not None:
            self.tracker.hfov_deg = c.hfov_deg
        key = (c.enabled, c.source, c.camera_index, c.file_path, c.width, c.height, c.fps, self._sim_url())
        if key == self._key and (self.thread is None or self.thread.running or not c.enabled):
            return
        if key == self._key and self.thread is not None and not self.thread.running:
            return  # it stopped with an error; keep showing it until the settings change
        self._key = key
        self.stop()
        if not c.enabled:
            return
        try:
            source = make_source(c, self._sim_url())
            if getattr(source, "name", "") == "sim":
                source.setup = {"layout": "laptop"}
        except WebcamError as exc:
            self.error = str(exc)
            return
        self.error = None
        self.source_name = getattr(source, "name", "?")
        self.tracker = WebcamTracker(c.hfov_deg, landmarks_model=self.engine.config.estimators.landmarks_model)
        self.thread = SourceThread(source, self.tracker.process)
        self.thread.start()
        log.info("second camera: webcam source %s started", self.source_name)

    def attach_tracker(self, tracker: WebcamTracker, source_name: str = "injected") -> None:
        """Use ``tracker`` (fed by the caller) instead of opening a webcam: tests and replay."""
        c = self.cfg
        self.stop()
        self.tracker = tracker
        self.source_name = source_name
        self.error = None
        self._key = (c.enabled, c.source, c.camera_index, c.file_path, c.width, c.height, c.fps, self._sim_url())

    def stop(self) -> None:
        if self.thread is not None:
            self.thread.stop()
        self.thread = None

    def reset(self) -> None:
        """Forget the solved pose and start anchoring again."""
        self.solver = self._new_solver()
        self.reference_segment = None
        self.reference_pose = None
        self._dist_pairs.clear()

    # -- geometry ---------------------------------------------------------------------------------

    def screen_from_webcam(self) -> Pose | None:
        scr = self.engine.screen
        if scr is None or not scr.width_mm:
            return None
        return screen_from_webcam(scr.width_mm / 1000.0, self.cfg.offset_mm / 1000.0, self.cfg.tilt_deg)

    def phone_from_screen(self) -> Pose | None:
        e = self.solver.estimate
        sw = self.screen_from_webcam()
        if e is None or sw is None:
            return None
        return e.pose.inverse() @ sw.inverse()

    # -- the frame hook ---------------------------------------------------------------------------

    def _t_local(self, frame: Frame) -> float:
        t = None
        try:
            t = self.engine._to_local(frame.t)  # noqa: SLF001 - phone clock -> engine clock
        except Exception:  # noqa: BLE001
            t = None
        return float(t if t is not None else (frame.t_received or time.monotonic()))

    def _webcam_at(self, t: float) -> tuple[Pose | None, np.ndarray | None, Observation | None]:
        """The webcam's head pose and eye points interpolated to ``t``, and the nearest webcam
        observation (for its pixels)."""
        tr = self.tracker
        if tr is None:
            return None, None, None
        skew = self.cfg.max_skew_ms / 1000.0
        a, b = tr.bracket(t, skew)
        near = tr.nearest(t, max(skew, 0.15))
        if a is None and b is None:
            return None, None, near.obs if near else None
        if a is None or b is None:
            one = a or b
            assert one is not None
            if abs(one.t_local - t) > skew / 2:
                return None, None, near.obs if near else None
            return head_pose(one.obs, self.cfg.head_ray_correction), _eye_points(one.obs), one.obs
        pa, pb = head_pose(a.obs, self.cfg.head_ray_correction), head_pose(b.obs, self.cfg.head_ray_correction)
        if pa is None or pb is None:
            return None, None, near.obs if near else None
        if np.linalg.norm(pa.t - pb.t) > 0.03:  # the head moved fast: interpolation is unreliable
            return None, None, near.obs if near else None
        pose = interpolate_pose(t, a.t_local, pa, b.t_local, pb)
        w = 0.0 if b.t_local <= a.t_local else (t - a.t_local) / (b.t_local - a.t_local)
        pts = (1 - w) * _eye_points(a.obs) + w * _eye_points(b.obs)
        return pose, pts, (a if abs(a.t_local - t) <= abs(b.t_local - t) else b).obs

    def on_phone_frame(self, frame: Frame, obs: Observation) -> Observation:
        """Every phone frame: feed the solver, stamp ``obs.extra["second_camera"]`` and return the
        observation the models and calibration should see (``obs`` itself when nothing applies)."""
        if not self.enabled:
            return obs
        self.sync()
        t = self._t_local(frame)
        if self.solver.imu(t, frame.gravity, frame.rotation_rate):
            if t - self._moved_msg_t > 3.0:
                self._moved_msg_t = t
                self.engine.log("info", "Second camera: the phone moved; re-anchoring its position.")
        w_head, w_pts, w_obs = self._webcam_at(t)
        ok, why = face_ok(obs)
        if not ok:
            self._last_why = f"phone: {why}"
        elif w_head is None:
            self._last_why = "webcam: no good face at this time"
        else:
            p_head = head_pose(obs, self.cfg.head_ray_correction)
            assert p_head is not None
            self.solver.add(t, p_head, w_head, _eye_points(obs), w_pts)
            self._paired += 1
            self._last_why = ""
            if obs.distance and w_obs is not None and w_obs.distance:
                self._dist_pairs.append((t, float(obs.distance), float(np.linalg.norm(w_head.t)), p_head.t.copy(), w_head.t.copy()))
        est = self.solver.estimate
        st: dict[str, Any] = {"segment": self.solver.current.id, "status": self.solver.status(t)}
        sw = self.screen_from_webcam()
        if sw is not None:
            st["webcam_from_screen"] = geometric_params(sw.inverse()).tolist()
        pfs = self.phone_from_screen()
        if pfs is not None and est is not None and self.solver.usable():
            st["phone_from_screen"] = {"params": geometric_params(pfs).tolist(), "se_rot_deg": est.se_rot_deg, "se_t_m": est.se_t_m, "n": est.n, "segment": self.solver.current.id}
        if w_obs is not None:
            st["webcam"] = w_obs
        obs.extra[NAME] = st
        return self._for_models(obs, t, w_head, w_obs)

    def _for_models(self, obs: Observation, t: float, w_head: Pose | None, w_obs: Observation | None) -> Observation:
        c = self.cfg
        est = self.solver.estimate
        out = obs
        if est is not None and self.solver.usable():
            p = est.pose
            if c.distance_source == "triangulated" and w_obs is not None:
                tri = fusion.triangulate(out, w_obs, p)
                if tri is not None:
                    out = fusion.apply_triangulation(out, tri)
            if c.head_pose_source != "phone" and w_head is not None:
                out = fusion.replace_head_pose(out, p.inverse() @ w_head, c.head_pose_source)
        self.last_transform = None
        self.refresh_reference()
        if c.track_phone and self.reference_pose is not None and not self._grid_running():
            seg = self.solver.current
            if seg.id != self.reference_segment and seg.estimate is not None and self.solver.usable(seg):
                m = self.reference_pose.inverse() @ seg.estimate.pose
                out = fusion.to_reference(out, m)
                self.last_transform = {"angle_deg": m.angle_deg(), "shift_m": float(np.linalg.norm(m.t)), "from_segment": seg.id, "to_segment": self.reference_segment}
        return out

    def _grid_running(self) -> bool:
        run = getattr(self.engine, "active_run", None)
        return run is not None and run.kind in ("grid", "pursuit")

    # -- calibration and models -------------------------------------------------------------------

    def extra_models(self) -> list[Any]:
        """Models to fit alongside the configured candidates."""
        if not self.enabled:
            return []
        from ..models import _options

        opts = _options("geometric", self.engine.config.models)
        out: list[Any] = []
        if self.cfg.screen_pose in ("fixed", "prior"):
            out.append(Geometric2CamModel(pose_mode=self.cfg.screen_pose, **opts))
        if self.cfg.webcam_model:
            out.append(WebcamGeometricModel(**opts))
        return out

    def calibrated(self) -> None:
        """A full calibration was committed: its phone pose becomes the reference that
        ``track_phone`` corrects towards."""
        if not self.enabled:
            return
        seg = self.solver.current
        self.reference_segment = seg.id
        self.reference_pose = seg.estimate.pose if seg.estimate is not None else None

    def refresh_reference(self) -> None:
        """Keep the reference at the calibration segment's best (latest) estimate."""
        seg = self.solver.segments.get(self.reference_segment) if self.reference_segment is not None else None
        if seg is not None and seg.estimate is not None:
            self.reference_pose = seg.estimate.pose

    # -- wide head box ----------------------------------------------------------------------------

    def lens_obs(self, obs: Observation, intr: Any) -> Observation:
        """For eye crops and zoom only: when the phone lost the eyes, where the webcam says they
        are."""
        if not self.enabled or not self.cfg.wide_head_box or intr is None:
            return obs
        if obs.left.iris_center is not None or obs.right.iris_center is not None:
            return obs
        est = self.solver.estimate
        w = (obs.extra.get(NAME) or {}).get("webcam")
        if est is None or not self.solver.usable() or not isinstance(w, Observation):
            return obs
        pred = fusion.predicted_eyes(w, est.pose, intr)
        return fusion.lens_observation(obs, pred) if pred else obs

    def fallback(self, obs: Observation, raw: GazePoint | None) -> GazePoint | None:
        """When the phone gives no gaze, a coarse webcam-only estimate marked low confidence."""
        if not self.enabled or not self.cfg.wide_head_box or (raw is not None and raw.valid):
            return raw
        if (obs.extra.get(NAME) or {}).get("webcam") is None:
            return raw
        model = self.engine.models.get("webcam") if getattr(self.engine, "models", None) else None
        if model is None:
            model = self._uncalibrated()
        if model is None:
            return raw
        try:
            p = model.predict(obs)
        except Exception:  # noqa: BLE001
            return raw
        if p is None or not p.valid:
            return raw
        p.confidence = min(p.confidence, FALLBACK_CONFIDENCE)
        p.extra = {**p.extra, "source": "webcam", "low_confidence": True}
        p.model = "webcam fallback"
        self.fallbacks += 1
        return p

    def _uncalibrated(self) -> WebcamGeometricModel | None:
        sw = self.screen_from_webcam()
        scr = self.engine.screen
        if sw is None or scr is None:
            return None
        key = (self.cfg.offset_mm, self.cfg.tilt_deg, scr.width, scr.height, scr.width_mm)
        if self._uncal is None or self._uncal_key != key:
            self._uncal = WebcamGeometricModel.uncalibrated(geometric_params(sw.inverse()), scr)
            self._uncal_key = key
        return self._uncal

    # -- self-check -------------------------------------------------------------------------------

    def self_check(self) -> dict[str, Any]:
        """How the webcam's distances compare with the phone's.

        - ``phone_m`` / ``webcam_m``: median eye distance each camera measured (to itself).
        - ``expected_webcam_m``: the webcam-to-eyes distance predicted from the PHONE's eyes and
          the phone's calibrated screen pose (the geometric model's, independent of the webcam).
          ``ratio`` = measured / expected; a ratio away from 1 means the assumed field of view
          (or the camera offset) is off, and ``suggested_hfov_deg`` is the field of view that
          would make it 1.
        - ``depth_slope``: without a calibration, the slope of webcam distance against phone
          distance while the head moves in depth (needs 5 cm of movement)."""
        pairs = list(self._dist_pairs)
        out: dict[str, Any] = {"n": len(pairs)}
        if not pairs:
            return out
        d_phone = np.array([p[1] for p in pairs])
        d_web = np.array([p[2] for p in pairs])
        out["phone_m"] = float(np.median(d_phone))
        out["webcam_m"] = float(np.median(d_web))
        hfov = float(self.cfg.hfov_deg)
        ratio = None
        geo = (getattr(self.engine, "models", {}) or {}).get("geometric")
        sw = self.screen_from_webcam()
        if geo is not None and getattr(geo, "fitted", False) and sw is not None:
            try:
                from .geometry import pose_from_geometric_params

                pfs = pose_from_geometric_params(geo.params[0:6])
                webcam_in_phone = (pfs @ sw).t
                exp = np.array([np.linalg.norm(p[3] - webcam_in_phone) for p in pairs])
                out["expected_webcam_m"] = float(np.median(exp))
                ratio = float(np.median(d_web / exp))
                out["ratio"] = ratio
                out["basis"] = "phone calibration"
            except Exception:  # noqa: BLE001
                ratio = None
        if ratio is None and np.ptp(d_phone) > 0.05:
            a = np.polyfit(d_phone, d_web, 1)[0]
            out["depth_slope"] = float(a)
            ratio = float(a)
            out["basis"] = "depth movement"
        if ratio is not None and ratio > 0:
            out["suggested_hfov_deg"] = float(2 * math.degrees(math.atan(ratio * math.tan(math.radians(hfov) / 2))))
        return out

    # -- UI ------------------------------------------------------------------------------------

    def phone_in_screen(self) -> dict[str, Any] | None:
        """Where the phone camera is, in millimetres from the screen's top-left corner (x right,
        y down, z into the screen: negative is in front), where it points, and how sure."""
        e = self.solver.estimate
        sw = self.screen_from_webcam()
        if e is None or sw is None:
            return None
        sp = sw @ e.pose
        axis = sp.R[:, 2]
        return {
            "position_mm": (sp.t * 1000.0).tolist(),
            "axis": axis.tolist(),
            "se_mm": e.se_t_m * 1000.0,
            "se_deg": e.se_rot_deg,
            "sd_mm": e.sd_t_m * 1000.0,
            "sd_deg": e.sd_rot_deg,
            "elevation_deg": float(math.degrees(math.asin(max(-1.0, min(1.0, float(-axis[1])))))),
        }

    def state(self) -> dict[str, Any]:
        c = self.cfg
        if not c.enabled:
            return {"enabled": False}
        now = time.monotonic()
        tr = self.tracker
        thread = self.thread
        face = None
        if tr is not None and tr.last_obs is not None:
            ok, why = face_ok(tr.last_obs)
            face = {"ok": ok, "why": why, "distance_m": tr.last_obs.distance, "head_angles_deg": (tr.last_obs.extra.get("landmarks") or {}).get("head_angles_deg")}
        self.refresh_reference()
        scr = self.engine.screen
        return {
            "enabled": True,
            "source": self.source_name,
            "running": bool(thread and thread.running),
            "error": self.error or (thread.error if thread else None),
            "frames": tr.frames if tr else 0,
            "faces": tr.faces if tr else 0,
            "webcam_size": list(tr.last_frame.pixels.shape[1::-1]) if tr and tr.last_frame is not None else None,
            "face": face,
            "paired": self._paired,
            "why_not_paired": self._last_why,
            "solver": self.solver.describe(now),
            "phone": self.phone_in_screen(),
            "self_check": self.self_check(),
            "reference_segment": self.reference_segment,
            "transform": self.last_transform,
            "fallbacks": self.fallbacks,
            "screen_mm": [scr.width_mm, scr.height_mm] if scr is not None else None,
            "webcam_mm": [scr.width_mm / 2, -c.offset_mm] if scr is not None and scr.width_mm else None,
        }

    def preview_jpeg(self, quality: int = 75) -> bytes | None:
        import cv2

        tr = self.tracker
        if tr is None or tr.last_decoded is None:
            return None
        im = tr.last_decoded.images["wide"]
        pixels = im.pixels.copy()
        if tr.last_obs is not None:
            from ..pipeline import draw_overlay

            try:
                draw_overlay(pixels, im, tr.last_obs)
            except Exception:  # noqa: BLE001
                pass
        if pixels.shape[1] > 960:
            s = 960 / pixels.shape[1]
            pixels = cv2.resize(pixels, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        return bytes(buf) if ok else None


def rotation_angle_deg(r: np.ndarray) -> float:
    return float(math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2)))))


__all__ = ["SecondCamera", "DEG"]
