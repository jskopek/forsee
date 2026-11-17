"""Synthetic scene: a person looking at a screen, filmed by a phone. Owner: Simulator.

Frames:

- **World** (the rig frame): the DEFAULT upright camera frame of the active camera, metres, x
  right, y down, z forward towards the person. Gravity in it is ``(0, cos 8deg, -sin 8deg)``: the
  phone leans back 8 degrees. The screen and the person's base pose are fixed in it; moving the
  camera (``move_camera``) moves the camera, not the world.
- **Upright camera**: the current camera's frame, which is what every truth value and every
  ``Observation`` uses (``types.py`` conventions).
- **Sensor**: the upright camera turned by the sensor orientation (``orientation``, degrees the
  engine must turn the sensor image CLOCKWISE to get it upright). Gravity in the frame header is
  derived from it through ``types.SENSOR_AXES_IN_DEVICE``, so ``upright_rotation`` recovers it.

Every camera in the catalogue sits at (almost) the same place, facing the person. For the front
and ARKit cameras that means the simulated phone has been turned round; the sim does not model
a camera that faces away.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from ..types import SENSOR_AXES_IN_DEVICE, Intrinsics, ScreenInfo, rotation_3d, rotation_affine
from .person import (
    CORNEA_RADIUS_M,
    LID_RADIUS_M,
    LIMBUS_RADIUS_M,
    EyeState,
    Person,
    PersonParams,
    normalize,
    ypr_matrix,
)
from .render import RenderState, finish_image, lid_opening, render_region, shade_rays

PHONE_PITCH_DEG = 8.0


# --------------------------------------------------------------------------------------------
# Cameras
# --------------------------------------------------------------------------------------------


@dataclass
class SimCamera:
    """One simulated camera, shaped like the entries of ``/api/status`` ``cameras``."""

    id: str
    name: str
    position: str  # "back" | "front"
    type: str  # "wide" | "ultrawide" | "tele" | "arkit"
    formats: list[tuple[int, int, float]]
    hfov_deg: float  # horizontal field of view of the format at zoom 1
    zoom_presets: list[float]
    zoom_range: tuple[float, float]
    min_focus_mm: float
    aperture_m: float  # entrance pupil diameter, for defocus blur
    can_focus: bool = True
    principal_offset: tuple[float, float] = (0.0019, -0.0021)  # fraction of width/height
    offset_m: tuple[float, float, float] = (0.0, 0.0, 0.0)  # lens position in the rig frame
    depth_source: str | None = None

    def intrinsics(self, width: int, height: int, zoom: float = 1.0) -> Intrinsics:
        """Sensor-pixel intrinsics of the delivered buffer at ``zoom`` (zoom included)."""
        fx = (width / 2) / math.tan(math.radians(self.hfov_deg) / 2)
        cx = width / 2 + self.principal_offset[0] * width
        cy = height / 2 + self.principal_offset[1] * height
        return Intrinsics(fx * zoom, fx * zoom, width / 2 + (cx - width / 2) * zoom, height / 2 + (cy - height / 2) * zoom, width, height)

    def status_entry(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "position": self.position,
            "type": self.type,
            "minFocusDistanceMM": self.min_focus_mm if self.type != "arkit" else -1,
            "canFocus": self.can_focus,
            "formats": [{"width": w, "height": h, "maxFps": f} for w, h, f in self.formats],
            "zoomPresets": list(self.zoom_presets),
            "fieldOfView": self.hfov_deg,
        }
        if self.depth_source:
            d["depthSource"] = self.depth_source
        return d

    def pick_format(self, max_width: int) -> tuple[int, int, float]:
        fits = [f for f in self.formats if f[0] <= max_width]
        return max(fits, key=lambda f: f[0]) if fits else min(self.formats, key=lambda f: f[0])


def default_cameras() -> dict[str, SimCamera]:
    """Shaped like the owner's phone (iPhone 15 Pro Max class): wide with a 2x native crop,
    ultra wide with a 1.78x preset, a 5x telephoto that cannot focus closer than 135 cm, the
    front camera and ARKit face tracking."""
    pre = "com.apple.avfoundation.avcapturedevice.built-in_video:"
    big = [(3840, 2160, 60.0), (1920, 1080, 60.0), (1280, 720, 60.0)]
    cams = [
        SimCamera(pre + "0", "Back Camera", "back", "wide", big, 69.4, [2.0], (1.0, 10.0), 150.0, 6.86e-3 / 1.78),
        SimCamera(pre + "5", "Back Ultra Wide Camera", "back", "ultrawide", big, 106.0, [1.78], (1.0, 10.0), 20.0, 2.22e-3 / 2.2, offset_m=(0.0, 0.012, 0.0)),
        SimCamera(pre + "2", "Back Telephoto Camera", "back", "tele", big, 17.1, [], (1.0, 10.0), 1350.0, 15.66e-3 / 2.8, offset_m=(0.012, 0.006, 0.0)),
        SimCamera(pre + "1", "Front Camera", "front", "wide", [(1920, 1080, 60.0), (1280, 720, 60.0)], 70.0, [], (1.0, 5.0), 250.0, 2.69e-3 / 1.9),
        SimCamera("arkit-face", "Front TrueDepth camera with ARKit face tracking", "front", "arkit", [(1440, 1080, 30.0), (1280, 720, 60.0)], 63.8, [], (1.0, 1.0), 250.0, 2.69e-3 / 1.9, can_focus=False, depth_source="truedepth"),
    ]
    return {c.id: c for c in cams}


# --------------------------------------------------------------------------------------------
# Knobs
# --------------------------------------------------------------------------------------------


@dataclass
class Knobs:
    """Everything ``POST /sim/noise`` can change (snake_case keys)."""

    pixel_noise: float = 2.0  # sensor noise, standard deviation in 0-255 levels
    blur_px: float = 0.0  # extra Gaussian blur, native pixels (on top of computed defocus)
    defocus: bool = True  # thin-lens defocus from focus distance
    motion_blur: bool = True  # blur along the face's image motion during the exposure
    exposure_gain: float = 1.0  # brightness multiplier (also scaled by /api/lens exposureBias)
    exposure_s: float = 1 / 120
    glint_gain: float = 0.55  # brightness of the screen's corneal reflection (1 = white)
    screen_brightness: float = 1.0  # what the screen shows when not flashing (0-1)
    flash_dark: float = 0.08  # screen level for a "0" in a flash pattern
    flash_latency_ms: float = 40.0  # display-to-camera delay of the flash
    lamp: bool = True  # a ceiling lamp that gives a second corneal highlight
    lamp_gain: float = 0.7
    supersample_roi: int = 3  # sub-samples per axis on edge pixels (iris edge, lids, glints)
    supersample_wide: int = 2
    skin_scale_roi: int = 2  # ROI skin away from the eyes is shaded at 1/n resolution
    skin_scale_wide: int = 2
    jitter_deg: float = 0.08
    blink_rate_per_min: float = 12.0
    reaction_ms: float = 200.0
    arkit_eye_noise_deg: float = 1.0
    arkit_eye_bias_deg: tuple[float, float] = (1.5, -1.0)  # (yaw towards face +x, pitch up)
    arkit_head_noise_mm: float = 1.0
    arkit_head_noise_deg: float = 0.3
    arkit_tracked: bool = True
    arkit_eye_offset_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)  # constant error of ARKit's eye centres, face axes
    arkit_gaze_gain: float = 1.0  # ARKit's eye rotation = true rotation x gain (real ARKit under-reports)
    thermal: str = "nominal"  # "nominal" | "serious" | "critical"
    zoom_lag_frames: int = 0  # frames whose image still uses the previous zoom

    def update(self, changes: dict[str, Any]) -> list[str]:
        """Apply known keys; return the unknown ones."""
        unknown = []
        for k, v in changes.items():
            if not hasattr(self, k):
                unknown.append(k)
                continue
            cur = getattr(self, k)
            if isinstance(cur, bool):
                setattr(self, k, bool(v))
            elif isinstance(cur, int):
                setattr(self, k, int(v))
            elif isinstance(cur, float):
                setattr(self, k, float(v))
            elif isinstance(cur, tuple):
                setattr(self, k, tuple(float(x) for x in v))
            else:
                setattr(self, k, v)
        return unknown

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: list(v) if isinstance(v, tuple) else v for k, v in d.items()}


# --------------------------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------------------------


def ellipse_from_points(pts: np.ndarray) -> tuple[float, float, float, float, float]:
    """Exact ellipse through points that lie on one: ``(cx, cy, semi_major, semi_minor,
    angle_deg)``, angle of the major axis from +x towards +y (EyeObs convention)."""
    x, y = pts[:, 0], pts[:, 1]
    mx, my = float(x.mean()), float(y.mean())
    s = float(max(np.ptp(x), np.ptp(y), 1e-9))
    xn, yn = (x - mx) / s, (y - my) / s
    D = np.stack([xn * xn, xn * yn, yn * yn, xn, yn, np.ones_like(xn)], axis=1)
    _, _, vt = np.linalg.svd(D)
    A, B, C, Dd, E, F = vt[-1]
    M = np.array([[A, B / 2], [B / 2, C]])
    c = np.linalg.solve(2 * M, -np.array([Dd, E]))
    Fc = F + 0.5 * (Dd * c[0] + E * c[1])
    w, V = np.linalg.eigh(M)
    axes = np.sqrt(-Fc / w)
    i_major = int(np.argmax(axes))
    vec = V[:, i_major]
    ang = math.degrees(math.atan2(vec[1], vec[0]))
    ang = (ang + 90) % 180 - 90
    return (float(c[0] * s + mx), float(c[1] * s + my), float(axes[i_major] * s), float(axes[1 - i_major] * s), float(ang))


def corneal_reflection_point(cornea_center: np.ndarray, camera: np.ndarray, target: np.ndarray, iters: int = 30) -> np.ndarray:
    """Point on the corneal sphere where ``target`` is mirrored towards ``camera`` (world)."""
    n = normalize(normalize(camera - cornea_center) + normalize(target - cornea_center))
    for _ in range(iters):
        p = cornea_center + CORNEA_RADIUS_M * n
        n_new = normalize(normalize(camera - p) + normalize(target - p))
        if float(np.linalg.norm(n_new - n)) < 1e-13:
            n = n_new
            break
        n = n_new
    return cornea_center + CORNEA_RADIUS_M * n


@dataclass
class Capture:
    """One captured instant: what to render and what is true about it."""

    t: float  # scene time
    state: RenderState
    camera: SimCamera
    width: int
    height: int
    zoom: float  # zoom the header reports
    image_zoom: float  # zoom the image was rendered with (differs only with zoom_lag_frames)
    orientation: int
    K_sensor: Intrinsics  # header intrinsics (reported zoom)
    K_up: Intrinsics  # upright intrinsics the IMAGE uses
    gravity: list[float]
    focus_m: float
    face_motion_px_s: tuple[float, float]
    zoom_stable: bool = True
    truth: dict[str, Any] = field(default_factory=dict)
    arkit: dict[str, Any] | None = None


class SimScene:
    """A person looking at a screen, filmed by a phone.

    Geometry is in metres in the phone's UPRIGHT camera frame (x right, y down, z forward).
    """

    def __init__(self, seed: int = 1, *, orientation: int = 180, camera: str = "wide", person: PersonParams | None = None) -> None:
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.knobs = Knobs()
        self.cameras = default_cameras()
        self.camera_id = self._camera_by_kind(camera)
        cam = self.cameras[self.camera_id]
        w, h, _ = cam.pick_format(3840)
        self.width, self.height = w, h
        self.zoom = 1.0
        self._prev_zoom = 1.0
        self._zoom_changed_frames = 99
        self._zoom_t = -1e9
        self.orientation = int(orientation) % 360
        # Rig: camera pose relative to its default, screen pose, gravity.
        self.rig_R = np.eye(3)
        self.rig_t = np.zeros(3)
        g = math.radians(PHONE_PITCH_DEG)
        self.gravity_world = np.array([0.0, math.cos(g), -math.sin(g)])
        self._screen = ScreenInfo(1512.0, 982.0, 302.4, 196.4, 2.0, "Simulated 14-inch display", "sim")
        self.screen_corners = self._default_screen_corners()
        # Person.
        params = person or PersonParams.random(np.random.default_rng(seed + 1000))
        eye_mid = np.array([0.0, -0.03, 0.60])
        self.person = Person(params, eye_mid, self._facing(eye_mid, self.screen_center()), np.random.default_rng(seed + 2000))
        self.person.reaction_ms = self.knobs.reaction_ms
        self.target_xy: tuple[float, float] | None = None
        self.look_at(self._screen.width / 2, self._screen.height / 2, human=False)
        # Focus and flash.
        self.focus_locked = False
        self.focus_m = 0.6
        self.adjusting_focus = False
        self.flash: dict[str, Any] | None = None
        self._last_proj: tuple[float, float, float] | None = None
        self._look_around_t = 0.0

    # -- setup ---------------------------------------------------------------------------------

    def _camera_by_kind(self, kind: str) -> str:
        if kind in self.cameras:
            return kind
        for c in self.cameras.values():
            if kind == "arkit" and c.type == "arkit":
                return c.id
            if kind == "front" and c.position == "front" and c.type == "wide":
                return c.id
            if c.type == kind and c.position == "back":
                return c.id
        raise ValueError(f"unknown camera {kind!r}")

    def _up(self) -> np.ndarray:
        return -self.gravity_world

    def _default_screen_corners(self) -> np.ndarray:
        up = self._up()
        toward = normalize(np.array([0.0, 0.0, 1.0]) - up * up[2])
        centre = 0.03 * up + (self._screen.height_mm or 196.4) / 2000 * up - 0.05 * toward
        tilt = math.radians(12.0)
        normal = math.cos(tilt) * toward + math.sin(tilt) * up
        ex = np.array([-1.0, 0.0, 0.0])  # the user's right is the camera's left
        ex = normalize(ex - normal * (ex @ normal))
        ey = normalize(np.cross(normal, ex))
        if ey @ up > 0:
            ey = -ey
        hw = (self._screen.width_mm or 302.4) / 2000
        hh = (self._screen.height_mm or 196.4) / 2000
        tl = centre - ex * hw - ey * hh
        return np.array([tl, tl + 2 * hw * ex, tl + 2 * hw * ex + 2 * hh * ey, tl + 2 * hh * ey])

    def screen_center(self) -> np.ndarray:
        return self.screen_corners.mean(axis=0)

    def _facing(self, eye: np.ndarray, point: np.ndarray) -> np.ndarray:
        z = -normalize(point - eye)
        x = normalize(np.array([1.0, 0.0, 0.0]) - z * z[0])
        y = np.cross(z, x)
        if y @ self._up() > 0:
            y = -y
            x = -x
        return np.stack([x, y, z], axis=1)

    @property
    def screen(self) -> ScreenInfo:
        """The simulated display (``source="sim"``); the engine uses it instead of macOS's."""
        return self._screen

    @property
    def camera(self) -> SimCamera:
        return self.cameras[self.camera_id]

    def screen_point_3d(self, x: float, y: float) -> np.ndarray:
        tl, tr, _, bl = self.screen_corners
        return tl + (tr - tl) * (x / self._screen.width) + (bl - tl) * (y / self._screen.height)

    def screen_point_2d(self, p: np.ndarray) -> tuple[float, float]:
        tl, tr, _, bl = self.screen_corners
        ex, ey = tr - tl, bl - tl
        q = p - tl
        return (float(q @ ex / (ex @ ex) * self._screen.width), float(q @ ey / (ey @ ey) * self._screen.height))

    def ray_to_screen(self, origin: np.ndarray, direction: np.ndarray) -> tuple[float, float] | None:
        tl, tr, _, bl = self.screen_corners
        n = normalize(np.cross(tr - tl, bl - tl))
        den = float(direction @ n)
        if abs(den) < 1e-12:
            return None
        t = float((tl - origin) @ n) / den
        if t <= 0:
            return None
        return self.screen_point_2d(origin + t * direction)

    # -- control -------------------------------------------------------------------------------

    def look_at(self, x: float, y: float, human: bool = True) -> None:
        """Make the person look at screen point ``(x, y)`` (points)."""
        self.target_xy = (float(x), float(y))
        self.person.set_target(self.screen_point_3d(x, y), human=human)

    def set_head(self, position: list[float] | None = None, rotation_deg: list[float] | None = None, face_screen: bool = True) -> None:
        """Head base pose: ``position`` of the point between the eyes (world/rig metres);
        ``rotation_deg`` = yaw, pitch, roll offsets from facing the screen centre."""
        pos = np.asarray(position, dtype=float) if position is not None else self.person.head_position
        R = self._facing(pos, self.screen_center()) if face_screen else np.eye(3)
        if rotation_deg is not None:
            R = R @ ypr_matrix(*[float(v) for v in rotation_deg])
        self.person.set_head(pos, R)

    def move_camera(self, translation: list[float] | None = None, rotation_deg: list[float] | None = None) -> None:
        """Camera pose relative to its default: translation (m, rig frame) and yaw/pitch/roll."""
        if translation is not None:
            self.rig_t = np.asarray(translation, dtype=float)
        if rotation_deg is not None:
            self.rig_R = ypr_matrix(*[float(v) for v in rotation_deg])

    def set_camera(self, camera_id: str, width: int, height: int, zoom: float = 1.0) -> None:
        self.camera_id = camera_id
        self.width, self.height = width, height
        self.set_zoom(zoom)
        self._zoom_changed_frames = 99

    def set_zoom(self, zoom: float) -> float:
        lo, hi = self.camera.zoom_range
        z = float(min(hi, max(lo, zoom)))
        if z != self.zoom:
            self._prev_zoom = self.zoom
            self.zoom = z
            self._zoom_changed_frames = 0
            self._zoom_t = self.t
        return z

    def set_flash(self, pattern: str | None, rate_hz: float = 6.0, t0: float | None = None, repeat: bool = True) -> None:
        """Screen flash: ``pattern`` of '0'/'1' shown at ``rate_hz`` from scene time ``t0``."""
        if not pattern:
            self.flash = None
            return
        if any(ch not in "01" for ch in pattern):
            raise ValueError("pattern must be made of 0 and 1")
        self.flash = {"pattern": pattern, "rateHz": float(rate_hz), "t0": float(self.person.t if t0 is None else t0), "repeat": bool(repeat)}

    def screen_level(self, t: float) -> float:
        k = self.knobs
        if self.flash is None:
            return k.screen_brightness
        tt = t - k.flash_latency_ms / 1000.0 - self.flash["t0"]
        if tt < 0:
            return k.screen_brightness
        i = int(tt * self.flash["rateHz"])
        pat = self.flash["pattern"]
        if i >= len(pat):
            if not self.flash["repeat"]:
                return k.screen_brightness
            i %= len(pat)
        return k.screen_brightness if pat[i] == "1" else k.flash_dark

    # -- time ----------------------------------------------------------------------------------

    def step(self, dt: float) -> None:
        """Advance head motion, blinks and fixational noise by ``dt`` seconds."""
        k = self.knobs
        p = self.person
        p.jitter_deg = k.jitter_deg
        p.blink_rate_per_min = k.blink_rate_per_min
        p.reaction_ms = k.reaction_ms
        if p.script == "look_around" and p.t >= self._look_around_t:
            self._look_around_t = p.t + float(self.rng.uniform(0.8, 2.0))
            s = self._screen
            self.look_at(float(self.rng.uniform(0.05, 0.95) * s.width), float(self.rng.uniform(0.05, 0.95) * s.height))
        p.step(dt)
        # Autofocus on the face.
        if not self.focus_locked and self.camera.can_focus:
            d = max(self.camera.min_focus_mm / 1000.0, self.face_distance())
            a = 1 - math.exp(-dt / 0.15)
            self.focus_m += (d - self.focus_m) * a
            self.adjusting_focus = abs(1 / self.focus_m - 1 / d) > 0.02
        else:
            self.adjusting_focus = False

    @property
    def t(self) -> float:
        return self.person.t

    # -- geometry at this instant -----------------------------------------------------------

    def camera_pose(self) -> tuple[np.ndarray, np.ndarray]:
        """Current camera (upright) -> world rotation and position."""
        off = np.asarray(self.camera.offset_m, dtype=float)
        return self.rig_R, self.rig_t + self.rig_R @ off

    def face_distance(self) -> float:
        R, t = self.camera_pose()
        return float(np.linalg.norm(self.person.current_head_position() - t))

    def lamp_dir(self) -> np.ndarray | None:
        if not self.knobs.lamp:
            return None
        return normalize(self._up() * 1.0 + np.array([0.25, 0.0, 0.0]) + normalize(np.array([0.0, 0.0, -1.0])) * 0.35)

    def render_state(self) -> RenderState:
        p = self.person
        cam_R, cam_t = self.camera_pose()
        return RenderState(
            head_R=p.current_head_rotation(),
            head_t=p.current_head_position(),
            eyes=p.eye_states(),
            person=p.params,
            blink=p.blink,
            screen_corners=self.screen_corners.copy(),
            screen_level=self.screen_level(p.t),
            cam_R=cam_R,
            cam_t=cam_t,
            glint_gain=self.knobs.glint_gain,
            lamp_dir=self.lamp_dir(),
            lamp_gain=self.knobs.lamp_gain,
            seed=self.seed,
        )

    def gravity_device(self, cam_R: np.ndarray | None = None, camera: SimCamera | None = None) -> list[float]:
        """Gravity in the Core Motion device frame (g), consistent with ``orientation``."""
        camera = camera or self.camera
        if cam_R is None:
            cam_R, _ = self.camera_pose()
        g_up = cam_R.T @ self.gravity_world
        g_s = rotation_3d(self.orientation).T @ g_up  # type: ignore[arg-type]
        u_axis, v_axis = (np.asarray(a, dtype=float) for a in SENSOR_AXES_IN_DEVICE[camera.position])
        z_axis = np.cross(u_axis, v_axis)  # camera forward in device coordinates
        g = g_s[0] * u_axis + g_s[1] * v_axis + g_s[2] * z_axis
        return [float(v) for v in g]

    def capture(self) -> Capture:
        """Freeze the current instant (call after :meth:`step`)."""
        cam = self.camera
        st = self.render_state()
        lag = self._zoom_changed_frames < self.knobs.zoom_lag_frames
        image_zoom = self._prev_zoom if lag else self.zoom
        self._zoom_changed_frames += 1
        K_s = cam.intrinsics(self.width, self.height, self.zoom)
        K_img = cam.intrinsics(self.width, self.height, image_zoom).rotated(self.orientation)  # type: ignore[arg-type]
        # Image motion of the eyes, for motion blur.
        mid = 0.5 * (st.eyes["left"].center + st.eyes["right"].center)
        pc = st.cam_R.T @ (mid - st.cam_t)
        u, v = K_img.project(tuple(pc))  # type: ignore[arg-type]
        vel = (0.0, 0.0)
        if self._last_proj is not None and self.t > self._last_proj[2]:
            dt = self.t - self._last_proj[2]
            vel = ((u - self._last_proj[0]) / dt, (v - self._last_proj[1]) / dt)
        self._last_proj = (u, v, self.t)
        cap = Capture(
            t=self.t,
            state=st,
            camera=cam,
            width=self.width,
            height=self.height,
            zoom=self.zoom,
            image_zoom=image_zoom,
            orientation=self.orientation,
            K_sensor=K_s,
            K_up=K_img,
            gravity=self.gravity_device(st.cam_R, cam),
            focus_m=self.focus_m,
            face_motion_px_s=vel,
            zoom_stable=self.t - self._zoom_t >= 0.15,
        )
        cap.truth = self._truth(cap)
        if cam.type == "arkit":
            from .arkit import arkit_block

            cap.arkit = arkit_block(self, cap)
        return cap

    # -- truth -------------------------------------------------------------------------------

    def _to_cam(self, st: RenderState, p: np.ndarray) -> np.ndarray:
        return st.cam_R.T @ (p - st.cam_t)

    def _truth(self, cap: Capture) -> dict[str, Any]:
        st = cap.state
        K = cap.K_up
        gaze_pts = []
        eyes_px: dict[str, Any] = {}
        out: dict[str, Any] = {}
        for side, eye in st.eyes.items():
            g = self.ray_to_screen(eye.cornea_center, eye.visual)
            if g is not None:
                gaze_pts.append(g)
            out[f"{side}EyeCenter"] = self._to_cam(st, eye.center).tolist()
            out[f"{side}GazeDir"] = (st.cam_R.T @ eye.visual).tolist()
            out[f"{side}OpticalDir"] = (st.cam_R.T @ eye.optical).tolist()
            out[f"{side}CorneaCenter"] = self._to_cam(st, eye.cornea_center).tolist()
            eyes_px[side] = self.eye_pixel_truth(st, eye, K)
        gaze = np.mean(gaze_pts, axis=0).tolist() if gaze_pts else None
        Rh = st.cam_R.T @ st.head_R
        head = self._to_cam(st, st.head_t)
        res = {
            "gaze": gaze,
            **{k: out[k] for k in ("leftEyeCenter", "rightEyeCenter", "leftGazeDir", "rightGazeDir")},
            "blink": bool(st.blink > 0.5),
            "headRotation": Rh.tolist(),
            # Extras beyond PROTOCOL.md's list (all in the same frames and units):
            "t": cap.t,
            "target": list(self.target_xy) if self.target_xy else None,
            "blinkAmount": float(st.blink),
            "headPosition": head.tolist(),
            "distance": float(np.linalg.norm(head)),
            "rotation": cap.orientation,
            "imageZoom": cap.image_zoom,
            "screenLevel": st.screen_level,
            "screenCorners": [self._to_cam(st, c).tolist() for c in st.screen_corners],
            "eyes": eyes_px,
            **{k: v for k, v in out.items() if k not in ("leftEyeCenter", "rightEyeCenter", "leftGazeDir", "rightGazeDir")},
        }
        return res

    def eye_pixel_truth(self, st: RenderState, eye: EyeState, K: Intrinsics) -> dict[str, Any]:
        """Exact image-space facts about one eye, in UPRIGHT FULL-FRAME pixels of ``K``."""

        def proj(p: np.ndarray) -> list[float]:
            c = self._to_cam(st, p)
            return [float(v) for v in K.project(tuple(c))]  # type: ignore[arg-type]

        ang = np.linspace(0, 2 * math.pi, 48, endpoint=False)
        ring = eye.limbus_center + LIMBUS_RADIUS_M * (np.cos(ang)[:, None] * eye.iris_u + np.sin(ang)[:, None] * eye.iris_v)
        pts = np.array([proj(p) for p in ring])
        ell = ellipse_from_points(pts)
        pring = eye.limbus_center + eye.pupil_radius * (np.cos(ang)[:, None] * eye.iris_u + np.sin(ang)[:, None] * eye.iris_v)
        pell = ellipse_from_points(np.array([proj(p) for p in pring]))
        # Screen reflection.
        cam_pos = st.cam_t
        corners = [corneal_reflection_point(eye.cornea_center, cam_pos, c) for c in st.screen_corners]
        centre = corneal_reflection_point(eye.cornea_center, cam_pos, st.screen_corners.mean(axis=0))
        vis = self._ray_masks(st, centre)
        # Eye corners and lids, from the lid model.
        Rh, th = st.head_R, st.head_t
        sx = 1.0 if eye.side == "left" else -1.0
        C_h = Rh.T @ (eye.center - th)

        def lid_point(az_t: float, el: float) -> np.ndarray:
            a, e = math.radians(az_t), math.radians(el)
            v = np.array([sx * math.sin(a) * math.cos(e), -math.sin(e), -math.cos(a) * math.cos(e)]) * LID_RADIUS_M
            return th + Rh @ (C_h + v)

        nasal, temporal = st.person.corner_deg
        inner, outer = lid_point(-nasal, 0.0), lid_point(temporal, 0.0)
        _, up, lo = lid_opening(np.array([0.0]), np.array([0.0]), st.person, eye.gaze_elev_deg, st.blink)
        top, bottom = lid_point(0.0, float(up[0])), lid_point(0.0, float(lo[0]))
        width = float(np.linalg.norm(np.subtract(proj(inner), proj(outer))))
        height = float(max(0.0, np.linalg.norm(np.subtract(proj(top), proj(bottom))))) if up[0] > lo[0] else 0.0
        return {
            "irisCenter": proj(eye.limbus_center),
            "irisEllipse": list(ell),
            "irisRadius": 0.5 * (ell[2] + ell[3]),
            "pupilCenter": proj(eye.limbus_center),
            "pupilEllipse": list(pell),
            "eyeballCenter": proj(eye.center),
            "corneaCenter": proj(eye.cornea_center),
            "reflectionCenter": proj(centre),
            "reflectionCorners": [proj(c) for c in corners],
            "reflectionVisible": bool(vis.get("screen_glint", 0.0) > 0 and st.screen_level > 0),
            "innerCorner": proj(inner),
            "outerCorner": proj(outer),
            "upperLid": proj(top),
            "lowerLid": proj(bottom),
            "openness": height / width if width > 0 else None,
        }

    def _ray_masks(self, st: RenderState, point: np.ndarray) -> dict[str, float]:
        d = normalize(point - st.cam_t)
        _, masks = shade_rays(st, st.cam_t, d[None, :], want_masks=True)
        return {k: float(v[0]) for k, v in masks.items()}

    # -- rendering ---------------------------------------------------------------------------

    def blur_sigma_native(self, cap: Capture) -> float:
        """Defocus blur (Gaussian sigma, native sensor pixels) plus the extra blur knob."""
        return blur_sigma_native(cap, self.knobs)

    def render_part(self, cap: Capture, sensor_rect: tuple[float, float, float, float], out_w: int, out_h: int, ss: int = 1, gain: float = 1.0, skin_scale: int = 1) -> np.ndarray:
        """Render a SENSOR rectangle at ``out_w x out_h`` (sensor orientation), as the phone would
        deliver it: uint8 BGR, with defocus, motion blur, exposure and noise applied."""
        seed = int(self.rng.integers(1 << 31))
        return render_capture_part(cap, self.knobs, sensor_rect, out_w, out_h, ss=ss, gain=gain, skin_scale=skin_scale, seed=seed)

    def render(self, camera: str | None = None, zoom: float | None = None, width: int | None = None, height: int | None = None) -> tuple[np.ndarray, dict[str, Any]]:
        """A SENSOR-orientation BGR image of the whole frame (at ``width x height`` output
        pixels; defaults to the camera's buffer size) and the ``camera`` header fields
        (intrinsics included, ``intrinsicsIncludeZoom: true``)."""
        if camera is not None and self.cameras.get(camera, None) is None:
            camera = self._camera_by_kind(camera)
        if camera is not None and camera != self.camera_id:
            w0, h0, _ = self.cameras[camera].pick_format(3840)
            self.set_camera(camera, w0, h0, zoom or 1.0)
        elif zoom is not None:
            self.set_zoom(zoom)
            self._zoom_changed_frames = 99
        cap = self.capture()
        ow = width or cap.width
        oh = height or int(round(ow * cap.height / cap.width))
        img = self.render_part(cap, (0, 0, cap.width, cap.height), ow, oh, ss=1)
        return img, self.camera_header(cap)

    def camera_header(self, cap: Capture) -> dict[str, Any]:
        cam = cap.camera
        K = cap.K_sensor
        return {
            "id": cam.id,
            "position": cam.position,
            "type": cam.type,
            "zoom": cap.zoom,
            "zoomStable": cap.zoom_stable,
            "width": cap.width,
            "height": cap.height,
            "fx": K.fx,
            "fy": K.fy,
            "cx": K.cx,
            "cy": K.cy,
            "intrinsicsSource": "arkit" if cam.type == "arkit" else "sim",
            "intrinsicsIncludeZoom": True,
            "fieldOfView": cam.hfov_deg,
        }

    def truth(self) -> dict[str, Any]:
        """The ``sim`` header block (PROTOCOL.md "Simulator extensions") for the current instant."""
        return self.capture().truth

    def describe(self) -> dict[str, Any]:
        cam_R, cam_t = self.camera_pose()
        return {
            "seed": self.seed,
            "t": self.t,
            "camera": self.camera_id,
            "width": self.width,
            "height": self.height,
            "zoom": self.zoom,
            "orientation": self.orientation,
            "screen": self._screen.to_dict(),
            "screenCornersWorld": self.screen_corners.tolist(),
            "cameraRotationWorld": cam_R.tolist(),
            "cameraPositionWorld": cam_t.tolist(),
            "gravityWorld": self.gravity_world.tolist(),
            "headPositionWorld": self.person.current_head_position().tolist(),
            "person": self.person.describe(),
            "knobs": self.knobs.to_dict(),
            "flash": self.flash,
            "focusM": self.focus_m,
        }


def blur_sigma_native(cap: Capture, k: Knobs) -> float:
    """Defocus blur (Gaussian sigma, native sensor pixels) plus the extra blur knob."""
    sigma = k.blur_px
    if k.defocus:
        d = max(1e-3, float(np.linalg.norm(cap.state.head_t - cap.state.cam_t)))
        coc = cap.K_up.fx * cap.camera.aperture_m * abs(1 / d - 1 / max(1e-3, cap.focus_m))
        sigma = math.hypot(sigma, coc / 2.4)
    return float(min(sigma, 80.0))


def render_capture_part(
    cap: Capture,
    k: Knobs,
    sensor_rect: tuple[float, float, float, float],
    out_w: int,
    out_h: int,
    *,
    ss: int = 1,
    gain: float = 1.0,
    skin_scale: int = 1,
    seed: int = 0,
) -> np.ndarray:
    """Pure (picklable inputs, no scene state): render a SENSOR rectangle of a capture at
    ``out_w x out_h`` in sensor orientation, uint8 BGR, with blur, exposure and noise."""
    r = cap.orientation
    A = rotation_affine(r, cap.width, cap.height)  # type: ignore[arg-type]
    x, y, w, h = sensor_rect
    c = np.array([[x, y, 1.0], [x + w, y + h, 1.0]]) @ A.T
    ux0, uy0 = c[:, 0].min(), c[:, 1].min()
    uw, uh = abs(c[1, 0] - c[0, 0]), abs(c[1, 1] - c[0, 1])
    ow, oh = (out_h, out_w) if r in (90, 270) else (out_w, out_h)
    sxs, sys_ = ow / uw, oh / uh  # output pixels per native pixel
    sigma = blur_sigma_native(cap, k) * sxs
    motion = (0.0, 0.0)
    if k.motion_blur:
        motion = (cap.face_motion_px_s[0] * k.exposure_s * sxs, cap.face_motion_px_s[1] * k.exposure_s * sys_)
    mlen = math.hypot(*motion)
    pad = int(math.ceil(3 * sigma + 0.5 * mlen)) + 1 if (sigma > 0.05 or mlen > 0.7) else 0
    rect = (ux0 - pad / sxs, uy0 - pad / sys_, uw + 2 * pad / sxs, uh + 2 * pad / sys_)
    img, _ = render_region(cap.state, cap.K_up, rect, ow + 2 * pad, oh + 2 * pad, ss=ss, skin_scale=skin_scale)
    rng = np.random.default_rng(seed)
    out = finish_image(img, rng, blur_sigma=sigma, motion=motion, gain=k.exposure_gain * gain, noise=k.pixel_noise)
    if pad:
        out = out[pad : pad + oh, pad : pad + ow]
    if r:
        out = np.rot90(out, k=r // 90)
    return np.ascontiguousarray(out)


def encode_capture_part(cap: Capture, k: Knobs, sensor_rect: tuple[float, float, float, float], out_w: int, out_h: int, quality: float, ss: int, skin_scale: int, gain: float, seed: int) -> bytes:
    """:func:`render_capture_part` plus JPEG encoding; what a render worker process runs."""
    import cv2

    img = render_capture_part(cap, k, sensor_rect, out_w, out_h, ss=ss, gain=gain, skin_scale=skin_scale, seed=seed)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), int(round(max(0.01, min(1.0, quality)) * 100))])
    if not ok:  # pragma: no cover
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


__all__ = ["blur_sigma_native", "render_capture_part", "encode_capture_part", "SimScene", "SimCamera", "Capture", "Knobs", "default_cameras", "ellipse_from_points", "corneal_reflection_point"]
