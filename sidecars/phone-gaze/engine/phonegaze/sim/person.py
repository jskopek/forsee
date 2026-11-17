"""The synthetic person: head, two eyeballs, gaze dynamics, blinks. Owner: Simulator.

Geometry is in metres. "World" is the simulator's rig frame: the default UPRIGHT camera frame
(x right, y down, z forward from the lens towards the person). The head frame follows
``types.Observation.head_rotation``: x from the person's right eye towards their left eye, y
down the face, z towards the back of the head (the face looks along -z).

Eye model (constants from docs/research/01, Le Grand style, one value per person):

- rotation centre ``C`` (what ``sim.leftEyeCenter`` reports);
- optical axis ``o`` through ``C``;
- iris (limbus) plane at ``IRIS_PLANE_M`` along ``o``, limbus radius ``LIMBUS_RADIUS_M``;
- eyeball (sclera) sphere centred on ``C`` that passes exactly through the limbus;
- cornea: sphere of radius ``CORNEA_RADIUS_M`` whose centre sits on ``o`` where the sphere meets
  the sclera exactly at the limbus (``CORNEA_CENTER_M`` from ``C``, derived);
- visual axis (true gaze): the optical axis turned by kappa (nasal, up), through the cornea
  centre. Gaze targets are hit EXACTLY by the visual axis (before fixational jitter).

Refraction by the cornea is not modelled: the pupil and iris texture are drawn on the iris
plane where they are, not where they would appear. The limbus itself sits at the corneal edge,
so its image is not affected.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

IRIS_PLANE_M = 10.2e-3
LIMBUS_RADIUS_M = 11.7e-3 / 2
EYEBALL_RADIUS_M = math.hypot(IRIS_PLANE_M, LIMBUS_RADIUS_M)  # 11.76 mm, passes the limbus
CORNEA_RADIUS_M = 7.8e-3
CORNEA_CENTER_M = IRIS_PLANE_M - math.sqrt(CORNEA_RADIUS_M**2 - LIMBUS_RADIUS_M**2)  # 5.04 mm
LID_RADIUS_M = EYEBALL_RADIUS_M + 0.4e-3

SIDES = ("left", "right")


def normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=float)


def rot_y(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=float)


def rot_z(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=float)


def ypr_matrix(yaw_deg: float, pitch_deg: float, roll_deg: float) -> np.ndarray:
    """Head-frame rotation offset: yaw about the head's y (down) axis, pitch about x, roll about z."""
    return rot_y(math.radians(yaw_deg)) @ rot_x(math.radians(pitch_deg)) @ rot_z(math.radians(roll_deg))


def fick(v_local: np.ndarray, v_target: np.ndarray) -> np.ndarray:
    """Rotation ``R = Ry(yaw) @ Rx(pitch)`` (no torsion) with ``R @ v_local == v_target``."""
    a, b, c = (float(x) for x in normalize(v_local))
    tx, ty, tz = (float(x) for x in normalize(v_target))
    # Rx(p) v = (a, b cos p - c sin p, b sin p + c cos p); its y must equal ty.
    r = math.hypot(b, c)
    phi = math.atan2(c, b)
    ratio = max(-1.0, min(1.0, ty / r)) if r > 0 else 0.0
    cands = [math.acos(ratio) - phi, -math.acos(ratio) - phi]
    best: tuple[float, float, np.ndarray] | None = None
    for p in cands:
        p = (p + math.pi) % (2 * math.pi) - math.pi
        rx = rot_x(p)
        w = rx @ np.array([a, b, c])
        yaw = math.atan2(tx, tz) - math.atan2(w[0], w[2])
        R = rot_y(yaw) @ rx
        err = float(np.linalg.norm(R @ np.array([a, b, c]) - np.array([tx, ty, tz])))
        key = (round(err, 9), abs(p))
        if best is None or key < (round(best[0], 9), best[1]):
            best = (err, abs(p), R)
    assert best is not None
    return best[2]


@dataclass
class EyeParams:
    """Fixed anatomy of one eye (per person)."""

    side: str
    center_head: np.ndarray  # rotation centre in the head frame
    kappa_h_deg: float  # visual axis turned this far towards the nose
    kappa_v_deg: float  # and this far up
    pupil_radius_m: float = 2.0e-3

    @property
    def nasal_sign(self) -> float:
        """+x of the head frame points to the person's left: the left eye's nose side is -x."""
        return -1.0 if self.side == "left" else 1.0

    def visual_local(self) -> np.ndarray:
        """Visual axis in the eye's rest frame (rest optical axis = head -z)."""
        h = math.radians(self.kappa_h_deg) * self.nasal_sign
        v = math.radians(self.kappa_v_deg)
        # Turning -z towards +x by h, and up (head -y) by v.
        d = np.array([math.sin(h) * math.cos(v), -math.sin(v), -math.cos(h) * math.cos(v)])
        return normalize(d)


@dataclass
class EyeState:
    """One eye at one instant, in WORLD coordinates."""

    side: str
    center: np.ndarray
    optical: np.ndarray
    visual: np.ndarray
    cornea_center: np.ndarray
    limbus_center: np.ndarray
    iris_u: np.ndarray  # unit vectors spanning the iris plane
    iris_v: np.ndarray
    pupil_radius: float
    rot_head: np.ndarray  # eye rotation in the head frame
    gaze_elev_deg: float  # elevation of the visual axis in the head frame (lids follow it)


@dataclass
class PersonParams:
    ipd_m: float = 0.063
    kappa_h_deg: tuple[float, float] = (5.0, 5.0)  # (left, right)
    kappa_v_deg: tuple[float, float] = (1.5, 1.5)
    iris_color: str = "brown"
    upper_lid_deg: float = 23.0  # upper lid height at the centre, degrees above the eye centre
    lower_lid_deg: float = 26.0  # lower lid depth at the centre, degrees below
    corner_deg: tuple[float, float] = (58.0, 62.0)  # half-width of the opening (nasal, temporal)
    lid_follow: float = 0.9  # how much the upper lid follows vertical gaze
    lower_lid_follow: float = 0.3

    @classmethod
    def random(cls, rng: np.random.Generator) -> PersonParams:
        return cls(
            ipd_m=float(np.clip(rng.normal(0.063, 0.003), 0.055, 0.072)),
            kappa_h_deg=tuple(float(np.clip(rng.normal(5.0, 1.2), 1.0, 9.0)) for _ in SIDES),  # type: ignore[arg-type]
            kappa_v_deg=tuple(float(np.clip(rng.normal(1.5, 1.0), -2.0, 4.0)) for _ in SIDES),  # type: ignore[arg-type]
            iris_color=str(rng.choice(["brown", "blue", "green", "dark"])),
        )


def _ou(x: np.ndarray, dt: float, tau: float, sigma: float, rng: np.random.Generator) -> np.ndarray:
    """Ornstein-Uhlenbeck step with stationary standard deviation ``sigma``."""
    if sigma <= 0 or tau <= 0:
        return np.zeros_like(x)
    a = math.exp(-dt / tau)
    return x * a + rng.normal(0, sigma * math.sqrt(max(0.0, 1 - a * a)), size=x.shape)


@dataclass
class Saccade:
    t0: float
    duration: float
    start: np.ndarray
    end: np.ndarray


@dataclass
class Person:
    """Head pose, eyes and gaze over time.

    The person looks at a 3D point (``look_point``). Targets arrive through :meth:`set_target`;
    with ``human=True`` they are taken up after a reaction delay with a main-sequence saccade
    (or, for small steps such as a moving dot, smooth pursuit). Head pose = base pose plus the
    active motion script. All randomness comes from ``rng`` so a seed reproduces a run.
    """

    params: PersonParams
    head_position: np.ndarray  # base pose, world (point midway between the eyeball centres)
    head_rotation: np.ndarray  # head frame -> world
    rng: np.random.Generator
    t: float = 0.0
    look_point: np.ndarray = field(default_factory=lambda: np.zeros(3))
    target_point: np.ndarray = field(default_factory=lambda: np.zeros(3))
    reaction_ms: float = 200.0
    reaction_sd_ms: float = 30.0
    jitter_deg: float = 0.08  # fixational drift, stationary SD per axis
    blink_rate_per_min: float = 12.0
    blink_duration_s: float = 0.16
    blinks_enabled: bool = True
    script: str = "still"
    blink: float = 0.0  # 0 open, 1 shut
    _pending: list[tuple[float, np.ndarray]] = field(default_factory=list)
    _saccade: Saccade | None = None
    _pursuit: bool = False
    _jitter: np.ndarray = field(default_factory=lambda: np.zeros(2))
    _blink_t0: float | None = None
    _head_dpos: np.ndarray = field(default_factory=lambda: np.zeros(3))
    _head_dang: np.ndarray = field(default_factory=lambda: np.zeros(3))
    _move_from: np.ndarray = field(default_factory=lambda: np.zeros(6))
    _move_to: np.ndarray = field(default_factory=lambda: np.zeros(6))
    _move_t0: float = -1e9
    _last_target_t: float = -1e9
    eyes: dict[str, EyeParams] = field(default_factory=dict)

    def __post_init__(self) -> None:
        p = self.params
        self.eyes = {
            "left": EyeParams("left", np.array([p.ipd_m / 2, 0.0, 0.0]), p.kappa_h_deg[0], p.kappa_v_deg[0]),
            "right": EyeParams("right", np.array([-p.ipd_m / 2, 0.0, 0.0]), p.kappa_h_deg[1], p.kappa_v_deg[1]),
        }

    # -- control -------------------------------------------------------------------------------

    def set_target(self, point: np.ndarray, human: bool = True) -> None:
        point = np.asarray(point, dtype=float)
        if not human:
            self._pending.clear()
            self._saccade = None
            self.target_point = point.copy()
            self.look_point = point.copy()
            self._jitter[:] = 0
            return
        amp = self._angle_deg(self.target_point, point)
        recent = self.t - self._last_target_t < 0.12
        self._last_target_t = self.t
        if amp < 2.0 and recent:
            # A dot moving at display rate: smooth pursuit (80 ms behind), no saccade.
            if not self._pursuit:
                self._pending.clear()
                self._saccade = None
            self._pursuit = True
            self._pending.append((self.t + 0.08, point))
            return
        self._pursuit = False
        delay = max(0.12, min(0.4, self.rng.normal(self.reaction_ms, self.reaction_sd_ms) / 1000.0))
        self._pending = [(self.t + delay, point)]

    def set_head(self, position: np.ndarray | None = None, rotation: np.ndarray | None = None) -> None:
        if position is not None:
            self.head_position = np.asarray(position, dtype=float)
        if rotation is not None:
            self.head_rotation = np.asarray(rotation, dtype=float)

    # -- dynamics ------------------------------------------------------------------------------

    def _angle_deg(self, a: np.ndarray, b: np.ndarray) -> float:
        eye = self.current_head_position()
        da, db = normalize(a - eye), normalize(b - eye)
        return math.degrees(math.acos(max(-1.0, min(1.0, float(da @ db)))))

    def step(self, dt: float) -> None:
        if dt <= 0:
            return
        self.t += dt
        rng = self.rng
        # Targets whose reaction delay is over.
        while self._pending and self._pending[0][0] <= self.t:
            _, point = self._pending.pop(0)
            self.target_point = point
            if self._pursuit:
                continue
            amp = self._angle_deg(self.look_point, point)
            if amp > 0.3:
                duration = (2.2 * amp + 21.0) / 1000.0  # main sequence
                # Slightly hypometric primary saccade; the correction follows as a second one.
                end = self.look_point + (point - self.look_point) * (0.93 if amp > 5 else 1.0)
                self._saccade = Saccade(self.t, duration, self.look_point.copy(), end)
        if self._pursuit:
            a = 1 - math.exp(-dt / 0.06)
            self.look_point = self.look_point + (self.target_point - self.look_point) * a
        elif self._saccade is not None:
            s = self._saccade
            x = min(1.0, (self.t - s.t0) / s.duration)
            prof = x**3 * (10 - 15 * x + 6 * x * x)  # minimum jerk
            self.look_point = s.start + (s.end - s.start) * prof
            if x >= 1.0:
                self._saccade = None
                if float(np.linalg.norm(s.end - self.target_point)) > 1e-9:
                    # Corrective saccade after ~120 ms.
                    self._pending.insert(0, (self.t + 0.12, self.target_point.copy()))
        # Fixational drift.
        self._jitter = _ou(self._jitter, dt, 0.25, self.jitter_deg, rng)
        # Blinks.
        if self._blink_t0 is None and self.blinks_enabled and self.blink_rate_per_min > 0:
            if rng.random() < 1 - math.exp(-dt * self.blink_rate_per_min / 60.0):
                self._blink_t0 = self.t
        if self._blink_t0 is not None:
            x = (self.t - self._blink_t0) / max(1e-3, self.blink_duration_s)
            if x >= 1:
                self._blink_t0 = None
                self.blink = 0.0
            else:
                # Fast close (35 %), slower open.
                self.blink = x / 0.35 if x < 0.35 else max(0.0, 1 - (x - 0.35) / 0.65)
                self.blink = min(1.0, self.blink * 1.15)
        else:
            self.blink = 0.0
        self._step_script(dt)

    def force_blink(self) -> None:
        self._blink_t0 = self.t

    def _step_script(self, dt: float) -> None:
        rng = self.rng
        name = self.script
        if name == "still":
            self._head_dpos[:] = 0
            self._head_dang[:] = 0
        elif name == "drift":
            self._head_dpos = _ou(self._head_dpos, dt, 3.0, 0.006, rng)
            self._head_dang = _ou(self._head_dang, dt, 3.0, 1.5, rng)
        elif name == "sway":
            w = 2 * math.pi * 0.2
            self._head_dpos = np.array([0.02 * math.sin(w * self.t), 0.005 * math.sin(2 * w * self.t), 0.015 * math.sin(0.5 * w * self.t)])
            self._head_dang = np.array([4 * math.sin(0.7 * w * self.t), 2 * math.sin(w * self.t + 1), 1.5 * math.sin(0.3 * w * self.t)])
        elif name == "move":
            if self.t - self._move_t0 > 6.0:
                self._move_t0 = self.t
                self._move_from = np.concatenate([self._head_dpos, self._head_dang])
                self._move_to = np.concatenate([rng.uniform(-0.06, 0.06, 3) * np.array([1, 0.6, 1]), rng.uniform(-8, 8, 3) * np.array([1, 0.6, 0.4])])
            x = min(1.0, (self.t - self._move_t0) / 0.8)
            prof = x**3 * (10 - 15 * x + 6 * x * x)
            cur = self._move_from + (self._move_to - self._move_from) * prof
            self._head_dpos, self._head_dang = cur[:3].copy(), cur[3:].copy()
        # "look_around" moves the eyes, not the head; handled by the scene.

    # -- state -------------------------------------------------------------------------------

    def current_head_position(self) -> np.ndarray:
        return self.head_position + self._head_dpos

    def current_head_rotation(self) -> np.ndarray:
        return self.head_rotation @ ypr_matrix(*self._head_dang)

    def gaze_point(self) -> np.ndarray:
        """Where the eyes are aimed now, including fixational drift (world)."""
        eye = self.current_head_position()
        d = self.look_point - eye
        dist = float(np.linalg.norm(d))
        if dist <= 0:
            return self.look_point.copy()
        R = self.current_head_rotation()
        jx, jy = (math.radians(float(v)) * dist for v in self._jitter)
        return self.look_point + R[:, 0] * jx + R[:, 1] * jy

    def eye_states(self) -> dict[str, EyeState]:
        Rh = self.current_head_rotation()
        th = self.current_head_position()
        g_head = Rh.T @ (self.gaze_point() - th)
        out: dict[str, EyeState] = {}
        for side, ep in self.eyes.items():
            vis_local = ep.visual_local()
            opt_local = np.array([0.0, 0.0, -1.0])
            R = np.eye(3)
            for _ in range(30):
                cornea = ep.center_head + CORNEA_CENTER_M * (R @ opt_local)
                want = normalize(g_head - cornea)
                R_new = fick(vis_local, want)
                done = float(np.abs(R_new - R).max()) < 1e-14
                R = R_new
                if done:
                    break
            opt = R @ opt_local
            vis = R @ vis_local
            u = R @ np.array([1.0, 0.0, 0.0])
            v = R @ np.array([0.0, 1.0, 0.0])
            c_head = ep.center_head
            out[side] = EyeState(
                side=side,
                center=th + Rh @ c_head,
                optical=Rh @ opt,
                visual=Rh @ vis,
                cornea_center=th + Rh @ (c_head + CORNEA_CENTER_M * opt),
                limbus_center=th + Rh @ (c_head + IRIS_PLANE_M * opt),
                iris_u=Rh @ u,
                iris_v=Rh @ v,
                pupil_radius=ep.pupil_radius_m,
                rot_head=R,
                gaze_elev_deg=math.degrees(math.asin(max(-1.0, min(1.0, -float(vis[1]))))),
            )
        return out

    def describe(self) -> dict[str, Any]:
        p = self.params
        return {
            "ipdM": p.ipd_m,
            "kappaHDeg": list(p.kappa_h_deg),
            "kappaVDeg": list(p.kappa_v_deg),
            "irisColor": p.iris_color,
            "irisRadiusM": LIMBUS_RADIUS_M,
            "irisPlaneM": IRIS_PLANE_M,
            "eyeballRadiusM": EYEBALL_RADIUS_M,
            "corneaRadiusM": CORNEA_RADIUS_M,
            "corneaCenterM": CORNEA_CENTER_M,
            "script": self.script,
        }
