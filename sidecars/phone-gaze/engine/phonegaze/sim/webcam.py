"""The simulator's second camera: a Mac's built-in webcam at the top centre of the simulated
screen, rendering the same synthetic person the phone sees. Owner: second camera (kept in its own
file; ``server.py`` only installs the routes).

Routes (added to the simulated phone's server):

- ``GET /sim/webcam.jpg``: render the current instant from the webcam. Headers: ``X-Monotonic``
  (``time.monotonic()`` at capture, the engine's clock on the same machine), ``X-Sim-Webcam``
  (JSON ground truth: head pose and eye centres in webcam coordinates, the true
  ``webcamFromPhone`` pose, the webcam's true field of view and offset).
- ``GET`` / ``POST /sim/webcam/config``: ``width``, ``height``, ``hfovDeg`` (the TRUE field of
  view, deliberately not the engine's default), ``offsetMm``, ``tiltDeg``, ``noise``, ``blurPx``,
  ``quality``, and ``layout`` (``"laptop"`` moves the simulated head up to the webcam's level and
  aims the phone at it; ``"desk"`` is the phone simulator's own layout).
- ``POST /sim/phone/move``: move the phone smoothly by ``translation`` (m, rig frame) and
  ``rotation`` (yaw/pitch/roll degrees, in the phone's own frame) over ``durationS``, relative to
  where it is (``"relative": false``: absolute, like ``/sim/camera``), reporting a rotation rate
  in the frame headers while it moves, as a real gyro would.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from dataclasses import replace
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from ..types import SENSOR_AXES_IN_DEVICE, Intrinsics, rotation_3d
from .person import normalize, ypr_matrix
from .scene import Capture, SimCamera, encode_capture_part

TRUE_HFOV_DEG = 69.5
"""The simulated webcam's real field of view. The engine assumes 68 by default and is never told
this one: the difference is the unknown-intrinsics error the self-check should find."""


def screen_axes(corners: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Screen x (right), y (down) and z (into the screen) in world coordinates."""
    tl, tr, _, bl = corners
    ex = normalize(tr - tl)
    ey = normalize(bl - tl)
    return ex, ey, normalize(np.cross(ex, ey))


def webcam_pose(corners: np.ndarray, offset_m: float, tilt_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """World-from-webcam rotation and position: ``offset_m`` above the middle of the top edge,
    looking out of the screen, tilted ``tilt_deg`` down."""
    tl, tr = corners[0], corners[1]
    ex, ey, ez = screen_axes(corners)
    pos = (tl + tr) / 2 - ey * offset_m
    base = np.stack([-ex, ey, -ez], axis=1)
    c, s = math.cos(math.radians(tilt_deg)), math.sin(math.radians(tilt_deg))
    tilt = np.array([[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]])
    return base @ tilt, pos


def laptop_screen_corners(scene: Any, tilt_deg: float = 6.0) -> np.ndarray:
    """The phone simulator's screen, but leaning back only ``tilt_deg`` (a laptop lid)."""
    s = scene.screen
    up = -scene.gravity_world
    toward = normalize(np.array([0.0, 0.0, 1.0]) - up * up[2])
    centre = 0.03 * up + (s.height_mm or 196.4) / 2000 * up - 0.05 * toward
    t = math.radians(tilt_deg)
    normal = math.cos(t) * toward + math.sin(t) * up
    ex = np.array([-1.0, 0.0, 0.0])
    ex = normalize(ex - normal * (ex @ normal))
    ey = normalize(np.cross(normal, ex))
    if ey @ up > 0:
        ey = -ey
    hw, hh = (s.width_mm or 302.4) / 2000, (s.height_mm or 196.4) / 2000
    tl = centre - ex * hw - ey * hh
    return np.array([tl, tl + 2 * hw * ex, tl + 2 * hw * ex + 2 * hh * ey, tl + 2 * hh * ey])


def aim_rotation(direction_world: np.ndarray) -> np.ndarray:
    """Camera-to-world rotation (from the default) that points the camera's z along
    ``direction_world`` with the least rotation."""
    r, _ = Rotation.align_vectors([normalize(direction_world)], [[0.0, 0.0, 1.0]])
    return r.as_matrix()


def to_device(scene: Any, v_cam: np.ndarray) -> list[float]:
    """A vector in the phone's upright camera frame -> the Core Motion device frame (as
    ``SimScene.gravity_device`` does for gravity)."""
    v_s = rotation_3d(scene.orientation).T @ np.asarray(v_cam, float)
    u_axis, v_axis = (np.asarray(a, dtype=float) for a in SENSOR_AXES_IN_DEVICE[scene.camera.position])
    z_axis = np.cross(u_axis, v_axis)
    return [float(x) for x in v_s[0] * u_axis + v_s[1] * v_axis + v_s[2] * z_axis]


class SimWebcamCamera:
    """The webcam of one :class:`~phonegaze.sim.server.SimPhone`."""

    def __init__(self, phone: Any) -> None:
        self.phone = phone
        self.width, self.height = 1280, 720
        self.hfov_deg = TRUE_HFOV_DEG
        self.offset_mm = 8.0
        self.tilt_deg = 0.0
        self.noise = 3.0
        self.blur_px = 0.6
        self.quality = 0.85
        self.layout = "desk"
        self.frames = 0
        self._move_task: asyncio.Task | None = None

    @property
    def scene(self) -> Any:
        return self.phone.scene

    def config(self) -> dict[str, Any]:
        return {"width": self.width, "height": self.height, "hfovDeg": self.hfov_deg, "offsetMm": self.offset_mm, "tiltDeg": self.tilt_deg, "noise": self.noise, "blurPx": self.blur_px, "quality": self.quality, "layout": self.layout, "frames": self.frames}

    def configure(self, body: dict[str, Any]) -> None:
        for key, attr, cast in (("width", "width", int), ("height", "height", int), ("hfovDeg", "hfov_deg", float), ("offsetMm", "offset_mm", float), ("tiltDeg", "tilt_deg", float), ("noise", "noise", float), ("blurPx", "blur_px", float), ("quality", "quality", float)):
            if key in body:
                setattr(self, attr, cast(body[key]))
        self.width = max(64, min(3840, self.width))
        self.height = max(48, min(2160, self.height))
        if body.get("layout") and body["layout"] != self.layout:
            self.apply_layout(str(body["layout"]))

    def apply_layout(self, layout: str) -> None:
        """``laptop``: screen leaning back 6 degrees, eyes 1.5 cm below the webcam and 60 cm in
        front of it, the phone (still below the screen) aimed at the eyes. ``desk``: the phone
        simulator's default (screen leaning back 12 degrees, eyes level with the phone)."""
        sc = self.scene
        if layout == "laptop":
            sc.screen_corners = laptop_screen_corners(sc)
            r_w, p_w = webcam_pose(sc.screen_corners, self.offset_mm / 1000.0, 0.0)
            up = -sc.gravity_world
            toward = normalize(r_w[:, 2] - up * (r_w[:, 2] @ up))
            eyes = p_w + 0.60 * toward - 0.015 * up
            sc.set_head(eyes.tolist(), [0.0, 0.0, 0.0])
            sc.rig_R = aim_rotation(eyes - sc.rig_t)
        elif layout == "desk":
            sc.screen_corners = sc._default_screen_corners()  # noqa: SLF001
            sc.set_head([0.0, -0.03, 0.60], [0.0, 0.0, 0.0])
            sc.rig_R = np.eye(3)
        else:
            raise ValueError("layout must be 'laptop' or 'desk'")
        sc.look_at(sc.screen.width / 2, sc.screen.height / 2, human=False)
        self.layout = layout

    def pose(self) -> tuple[np.ndarray, np.ndarray]:
        return webcam_pose(self.scene.screen_corners, self.offset_mm / 1000.0, self.tilt_deg)

    def capture(self) -> tuple[Capture, dict[str, Any]]:
        sc = self.scene
        base = sc.capture()
        r_w, p_w = self.pose()
        st = replace(base.state, cam_R=r_w, cam_t=p_w)
        cam = SimCamera("sim-webcam", "Simulated FaceTime HD camera", "front", "webcam", [(self.width, self.height, 30.0)], self.hfov_deg, [], (1.0, 1.0), 300.0, 1e-4, can_focus=False, principal_offset=(0.0, 0.0))
        k = cam.intrinsics(self.width, self.height)
        cap = Capture(t=base.t, state=st, camera=cam, width=self.width, height=self.height, zoom=1.0, image_zoom=1.0, orientation=0, K_sensor=k, K_up=k, gravity=[0.0, 1.0, 0.0], focus_m=0.6, face_motion_px_s=(0.0, 0.0))
        truth = sc._truth(cap)  # noqa: SLF001 - the same truth, seen from the webcam
        cam_R, cam_t = sc.camera_pose()
        webcam_from_phone_R = r_w.T @ cam_R
        webcam_from_phone_t = r_w.T @ (cam_t - p_w)
        out = {k2: truth[k2] for k2 in ("headRotation", "headPosition", "distance", "leftEyeCenter", "rightEyeCenter", "blink", "gaze", "t") if k2 in truth}
        out["webcamFromPhone"] = {"R": webcam_from_phone_R.tolist(), "t": webcam_from_phone_t.tolist()}
        out["hfovDeg"] = self.hfov_deg
        out["offsetMm"] = self.offset_mm
        out["tiltDeg"] = self.tilt_deg
        return cap, out

    async def render_jpeg(self) -> tuple[bytes, float, dict[str, Any]]:
        cap, truth = self.capture()
        t_mono = time.monotonic()
        knobs = replace(self.scene.knobs, pixel_noise=self.noise, defocus=False, motion_blur=False, blur_px=self.blur_px)
        lite = replace(cap, truth={}, arkit=None)
        seed = int(self.scene.rng.integers(1 << 31))
        loop = asyncio.get_running_loop()
        args = (lite, knobs, (0.0, 0.0, float(self.width), float(self.height)), self.width, self.height, self.quality, 1, 2, 1.0, seed)
        executor = getattr(self.phone, "_executor", None)
        data = await loop.run_in_executor(executor, encode_capture_part, *args)
        self.frames += 1
        return data, t_mono, truth

    # -- moving the phone smoothly ---------------------------------------------------------------

    async def move_phone(self, translation: list[float] | None, rotation: list[float] | None, duration_s: float, relative: bool = True) -> None:
        sc = self.scene
        r0, t0 = sc.rig_R.copy(), sc.rig_t.copy()
        if relative:
            r1 = r0 @ ypr_matrix(*rotation) if rotation is not None else r0
            t1 = t0 + np.asarray(translation, float) if translation is not None else t0
        else:
            r1 = ypr_matrix(*rotation) if rotation is not None else r0
            t1 = np.asarray(translation, float) if translation is not None else t0
        n = max(1, int(duration_s / 0.02))
        slerp = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([r0, r1])))
        prev = r0
        for i in range(1, n + 1):
            a = i / n
            a = 0.5 - 0.5 * math.cos(math.pi * a)  # ease in and out
            r = slerp([a]).as_matrix()[0]
            sc.rig_R, sc.rig_t = r, (1 - a) * t0 + a * t1
            dr = Rotation.from_matrix(prev.T @ r).as_rotvec() / (duration_s / n)  # in the camera frame
            sc.rotation_rate = to_device(sc, dr)
            prev = r
            await asyncio.sleep(duration_s / n)
        sc.rotation_rate = [0.0, 0.0, 0.0]


def install(router: Any, phone: Any) -> SimWebcamCamera:
    """Add the second camera's routes to the simulated phone's app."""
    from aiohttp import web

    cam = SimWebcamCamera(phone)
    phone.webcam = cam

    async def h_jpg(request: web.Request) -> web.Response:
        data, t_mono, truth = await cam.render_jpeg()
        headers = {"X-Monotonic": repr(t_mono), "X-Sim-Webcam": json.dumps(truth, separators=(",", ":")), "Cache-Control": "no-store"}
        return web.Response(body=data, content_type="image/jpeg", headers=headers)

    async def h_config_get(request: web.Request) -> web.Response:
        return web.json_response(cam.config())

    async def h_config(request: web.Request) -> web.Response:
        body = await request.json() if request.can_read_body else {}
        if not isinstance(body, dict):
            return web.json_response({"error": "body must be a JSON object"}, status=400)
        try:
            cam.configure(body)
        except (TypeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(cam.config())

    async def h_move(request: web.Request) -> web.Response:
        body = await request.json() if request.can_read_body else {}
        tr, rot = body.get("translation"), body.get("rotation")
        for v, name in ((tr, "translation"), (rot, "rotation")):
            if v is not None and (not isinstance(v, list) or len(v) != 3):
                return web.json_response({"error": f"{name} must be a list of 3 numbers"}, status=400)
        dur = float(body.get("durationS", body.get("duration_s", 0.5)))
        if cam._move_task is not None and not cam._move_task.done():  # noqa: SLF001
            cam._move_task.cancel()  # noqa: SLF001
        cam._move_task = asyncio.create_task(cam.move_phone(tr, rot, max(0.0, dur), bool(body.get("relative", True))))  # noqa: SLF001
        if body.get("wait", True):
            await cam._move_task  # noqa: SLF001
        return web.json_response({"ok": True, "scene": cam.scene.describe()})

    router.add_get("/sim/webcam.jpg", h_jpg)
    router.add_get("/sim/webcam/config", h_config_get)
    router.add_post("/sim/webcam/config", h_config)
    router.add_post("/sim/phone/move", h_move)
    return cam


__all__ = ["SimWebcamCamera", "install", "TRUE_HFOV_DEG", "webcam_pose", "Intrinsics"]
