"""A geometric test simulator for the Models area (not the ``phonegaze.sim`` package). Owner: Models.

It produces ``Observation`` objects as the estimators would, from a synthetic person looking at
known screen points, so the gaze models and calibration can be measured without images.

The generating model deliberately differs from what the models assume:

- the true eyeball radius (rotation centre to iris) is 11.5 mm; the estimator emulation and the
  models assume 10.2 mm;
- kappa is applied as a rotation of the eye (not additive yaw/pitch) and differs per eye;
- the estimated head pose has a fixed bias (rotation and position) plus per-frame jitter, and
  the eyeball centres are placed from it with a slightly wrong inter-eye distance;
- the corneal reflection comes from a sphere of a different radius and centre than any model
  assumes, and goes missing in some frames;
- blinks, outlier frames and eyes still landing at the start of each dot.

Not a test module (no ``test_`` prefix); imported by ``tests/test_models_*.py``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np
from scipy.spatial.transform import Rotation

from phonegaze.calibration import CalibrationRun, Target, grid_targets, random_targets
from phonegaze.types import CalibSample, EyeObs, Intrinsics, Observation, ScreenInfo

DEG = math.pi / 180.0
SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.4, height_mm=196.4, scale=2.0, name="sim 14in", source="sim")

ASSUMED_RADIUS_M = 0.0102
"""What the emulated estimator (and the models) assume."""


@dataclass
class Person:
    eye_radius_m: float = 0.0115
    kappa_right_deg: tuple[float, float] = (4.0, -1.0)  # (nasal, vertical: negative = up)
    kappa_left_deg: tuple[float, float] = (6.0, -2.2)
    ipd_m: float = 0.064
    cornea_centre_m: float = 0.0056  # rotation centre to corneal centre of curvature
    cornea_radius_m: float = 0.0078
    iris_radius_m: float = 0.00585


@dataclass
class HeadPose:
    """Head in SCREEN-local coordinates: ``position`` (m, z negative = in front of the screen)
    of the point between the eyeball centres; ``turn_deg`` = (yaw, pitch, roll) away from
    facing the screen squarely."""

    position: tuple[float, float, float]
    turn_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def moved(self, dx: float = 0.0, dy: float = 0.0, dz: float = 0.0, yaw: float = 0.0, pitch: float = 0.0, roll: float = 0.0) -> HeadPose:
        p = self.position
        t = self.turn_deg
        return HeadPose((p[0] + dx, p[1] + dy, p[2] + dz), (t[0] + yaw, t[1] + pitch, t[2] + roll))


@dataclass
class Rig:
    """Camera placement relative to the screen, in screen-local metres (x right, y down, z into
    the screen) and its intrinsics."""

    px_per_deg: float = 1.8
    camera_at: tuple[float, float, float] = (0.171, 0.226, -0.05)  # below the screen, 5 cm in front
    aim_at: tuple[float, float, float] = (0.151, 0.06, -0.6)
    extra_rot_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)
    width: int = 3840
    height: int = 2160

    @property
    def fx(self) -> float:
        # px per degree of eye rotation at 60 cm for a 10.2 mm eye radius (research note 01)
        return self.px_per_deg * 0.6 / (ASSUMED_RADIUS_M * DEG)

    def intrinsics(self) -> Intrinsics:
        return Intrinsics(self.fx, self.fx, self.width / 2, self.height / 2, self.width, self.height)

    def camera_axes(self) -> tuple[np.ndarray, np.ndarray]:
        """``(R_cs, q)``: camera axes as columns in screen coordinates, camera position."""
        q = np.asarray(self.camera_at, float)
        z = np.asarray(self.aim_at, float) - q
        z /= np.linalg.norm(z)
        x = np.cross([0.0, 1.0, 0.0], z)
        x /= np.linalg.norm(x)
        y = np.cross(z, x)
        r = np.stack([x, y, z], axis=1)
        r = r @ Rotation.from_euler("yxz", self.extra_rot_deg, degrees=True).as_matrix()
        return r, q

    def bumped(self, rot_deg: tuple[float, float, float] = (3.0, -2.0, 1.0), shift_m: tuple[float, float, float] = (0.015, 0.01, -0.01)) -> Rig:
        c = self.camera_at
        e = self.extra_rot_deg
        return replace(self, camera_at=(c[0] + shift_m[0], c[1] + shift_m[1], c[2] + shift_m[2]), extra_rot_deg=(e[0] + rot_deg[0], e[1] + rot_deg[1], e[2] + rot_deg[2]))


@dataclass
class Noise:
    iris_px: float = 0.5
    radius_px: float = 0.5
    corner_px: float = 1.0
    glint_px: float = 0.3
    head_rot_bias_deg: tuple[float, float, float] = (2.0, -1.5, 0.5)
    head_pos_bias_m: tuple[float, float, float] = (0.004, -0.003, 0.012)
    head_rot_jitter_deg: float = 0.3
    head_pos_jitter_m: float = 0.001
    fixation_jitter_deg: float = 0.15
    assumed_ipd_m: float = 0.063
    p_blink: float = 0.03
    p_outlier: float = 0.02
    p_no_glint: float = 0.3
    landing_frames: int = 3


@dataclass
class Sim:
    person: Person = field(default_factory=Person)
    rig: Rig = field(default_factory=Rig)
    noise: Noise = field(default_factory=Noise)
    screen: ScreenInfo = field(default_factory=lambda: SCREEN)
    seed: int = 0
    fps: float = 30.0

    def __post_init__(self) -> None:
        self.rng = np.random.default_rng(self.seed)
        self.t = 100.0

    # --- geometry ------------------------------------------------------------------------

    @property
    def screen_m(self) -> tuple[float, float]:
        return self.screen.width_mm / 1000.0, self.screen.height_mm / 1000.0  # type: ignore[operator]

    def to_camera(self, p_screen: np.ndarray, rig: Rig | None = None) -> np.ndarray:
        r, q = (rig or self.rig).camera_axes()
        return r.T @ (np.asarray(p_screen, float) - q)

    def dir_to_camera(self, d_screen: np.ndarray, rig: Rig | None = None) -> np.ndarray:
        r, _ = (rig or self.rig).camera_axes()
        return r.T @ np.asarray(d_screen, float)

    def target_screen_m(self, x_pt: float, y_pt: float) -> np.ndarray:
        w, h = self.screen_m
        return np.array([x_pt / self.screen.width * w, y_pt / self.screen.height * h, 0.0])

    def head_in_camera(self, head: HeadPose, rig: Rig | None = None) -> tuple[np.ndarray, np.ndarray]:
        """``(R_head -> camera, position in camera)``."""
        r_hs = np.diag([-1.0, 1.0, -1.0]) @ Rotation.from_euler("yxz", head.turn_deg, degrees=True).as_matrix()
        r_cs, _ = (rig or self.rig).camera_axes()
        return r_cs.T @ r_hs, self.to_camera(np.asarray(head.position), rig)

    # --- one frame -------------------------------------------------------------------------

    def observe(self, x_pt: float, y_pt: float, head: HeadPose, rig: Rig | None = None, look_jitter: bool = True) -> tuple[Observation, dict]:
        rig = rig or self.rig
        n, p, rng = self.noise, self.person, self.rng
        intr = rig.intrinsics()
        r_head, h_pos = self.head_in_camera(head, rig)
        target = self.to_camera(self.target_screen_m(x_pt, y_pt), rig)
        light = self.to_camera(self.target_screen_m(self.screen.width / 2, self.screen.height / 2), rig)
        self.t += 1.0 / self.fps
        obs = Observation(seq=int(self.t * 1000), t=self.t, t_local=self.t, camera_id="sim", zoom=2.0, intrinsics=intr)
        blink = rng.random() < n.p_blink
        outlier = rng.random() < n.p_outlier
        # estimated head pose (biased + jitter)
        bias = Rotation.from_euler("yxz", n.head_rot_bias_deg, degrees=True).as_matrix()
        jit = Rotation.from_rotvec(rng.normal(0, n.head_rot_jitter_deg * DEG, 3)).as_matrix()
        r_est = bias @ jit @ r_head
        pos_est = h_pos + np.asarray(n.head_pos_bias_m) + rng.normal(0, n.head_pos_jitter_m, 3)
        truth: dict = {"eyes": {}}
        fix = rng.normal(0, n.fixation_jitter_deg * DEG, 2) if look_jitter else np.zeros(2)
        for side, sgn in (("right", 1.0), ("left", -1.0)):
            # head frame: x from the right eye to the left eye
            c = h_pos + r_head @ np.array([-sgn * p.ipd_m / 2, 0.0, 0.0])
            v = target - c
            v /= np.linalg.norm(v)
            # fixational jitter of the visual axis
            v = Rotation.from_rotvec(np.array([fix[1], fix[0], 0.0])).apply(v)
            alpha, beta = (p.kappa_right_deg if side == "right" else p.kappa_left_deg)
            # optical axis: undo kappa as a rotation of the eye, in head coordinates
            k = Rotation.from_euler("yx", [-sgn * alpha, beta], degrees=True).as_matrix()
            g = r_head @ (k.T @ (r_head.T @ v))
            iris = c + p.eye_radius_m * g
            eye = EyeObs()
            truth["eyes"][side] = {"center": c, "visual": v}
            if blink:
                eye.found = True
                eye.blink = True
                eye.openness = 0.02
                setattr(obs, side, eye)
                continue
            iu = np.array(intr.project(tuple(iris))) + rng.normal(0, n.iris_px, 2)
            if outlier:
                iu += rng.choice([-1, 1], 2) * 6.0
            rad = intr.fx * p.iris_radius_m / iris[2] + rng.normal(0, n.radius_px)
            corner_off = [np.array([sgn * 0.0145, 0.001, -0.0105]), np.array([-sgn * 0.0145, 0.001, -0.0105])]  # inner (nasal), outer
            corners = [np.array(intr.project(tuple(c + r_head @ o))) + rng.normal(0, n.corner_px, 2) for o in corner_off]
            # emulated estimator: eyeball centre from the (biased) head pose, gaze from the iris ray
            c_est = pos_est + r_est @ np.array([-sgn * n.assumed_ipd_m / 2, 0.0, 0.0])
            ray = np.array([*intr.ray(*iu), 1.0])
            ray /= np.linalg.norm(ray)
            b = float(ray @ c_est)
            disc = b * b - (float(c_est @ c_est) - ASSUMED_RADIUS_M**2)
            tt = b - math.sqrt(disc) if disc > 0 else b
            g_est = tt * ray - c_est
            g_est /= np.linalg.norm(g_est)
            eye.found = True
            eye.blink = False
            eye.openness = 0.3
            eye.iris_center = (float(iu[0]), float(iu[1]))
            eye.iris_radius = float(rad)
            eye.inner_corner = (float(corners[0][0]), float(corners[0][1]))
            eye.outer_corner = (float(corners[1][0]), float(corners[1][1]))
            eye.eyeball_center = tuple(float(v) for v in c_est)  # type: ignore[assignment]
            eye.gaze_dir = tuple(float(v) for v in g_est)  # type: ignore[assignment]
            eye.confidence = 0.9
            if rng.random() >= n.p_no_glint:
                cc = c + p.cornea_centre_m * g
                nrm = -cc / np.linalg.norm(cc) + (light - cc) / np.linalg.norm(light - cc)
                nrm /= np.linalg.norm(nrm)
                glint = np.array(intr.project(tuple(cc + p.cornea_radius_m * nrm))) + rng.normal(0, n.glint_px, 2)
                eye.reflection_center = (float(glint[0]), float(glint[1]))
                eye.reflection_score = 0.8
            setattr(obs, side, eye)
        obs.head_rotation = r_est.tolist()
        obs.head_position = tuple(float(v) for v in pos_est)  # type: ignore[assignment]
        obs.distance = float(np.linalg.norm(pos_est))
        truth["target_cam"] = target
        truth["rig"] = rig
        obs.extra["truth"] = truth
        return obs, truth

    # --- scoring --------------------------------------------------------------------------------

    def angular_error(self, pred_pt: tuple[float, float], obs: Observation) -> float:
        """True visual angle at the midpoint of the true eyeball centres between the target and
        the predicted screen point."""
        truth = obs.extra["truth"]
        rig = truth["rig"]
        eye = (truth["eyes"]["left"]["center"] + truth["eyes"]["right"]["center"]) / 2
        p = self.to_camera(self.target_screen_m(*pred_pt), rig)
        a, b = truth["target_cam"] - eye, p - eye
        cosang = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
        return math.degrees(math.acos(max(-1.0, min(1.0, cosang))))

    # --- sessions ------------------------------------------------------------------------------

    def collect(self, targets: list[Target], head: HeadPose, kind: str = "grid", frames: int = 27, rig: Rig | None = None, run: CalibrationRun | None = None, pose_group: int | None = None, head_wobble_m: float = 0.003) -> CalibrationRun:
        """Run targets through a ``CalibrationRun`` like the engine does. The eyes take
        ``noise.landing_frames`` frames to land on each dot (still at the previous one)."""
        run = run or CalibrationRun(run_id="sim", kind=kind, targets=list(targets), screen=self.screen)
        prev = None
        for tg in targets:
            run.begin_dot(tg.dot_id, tg.x, tg.y, self.t, pose_group=pose_group)
            wob = self.rng.normal(0, head_wobble_m, 3)
            h = head.moved(*wob, *self.rng.normal(0, 0.5, 2))
            for i in range(frames):
                look = prev if (prev is not None and i < self.noise.landing_frames) else (tg.x, tg.y)
                obs, _ = self.observe(look[0], look[1], h, rig)
                # the truth the scoring uses is the dot, not where the eyes still were
                obs.extra["truth"]["target_cam"] = self.to_camera(self.target_screen_m(tg.x, tg.y), rig or self.rig)
                run.add(obs)
            run.end_dot(tg.dot_id, self.t)
            prev = (tg.x, tg.y)
        return run

    def validation_samples(self, n: int, head: HeadPose, rig: Rig | None = None, frames: int = 15, seed: int = 7) -> list[CalibSample]:
        targets = random_targets(self.screen, n, seed=seed)
        out = []
        for tg in targets:
            for _ in range(frames):
                obs, _ = self.observe(tg.x, tg.y, head, rig)
                if obs.left.blink:
                    continue
                out.append(CalibSample(target=(tg.x, tg.y), obs=obs, kind="validate", dot_id=tg.dot_id))
        return out


HOME = HeadPose((0.151, 0.07, -0.60))


def evaluate(model, sim: Sim, samples: list[CalibSample]) -> dict:
    """True accuracy in degrees: mean over samples, plus the fraction predicted."""
    errs = []
    for s in samples:
        p = model.predict(s.obs)
        if p is None or not p.valid:
            continue
        errs.append(sim.angular_error((p.x, p.y), s.obs))
    return {"deg": float(np.mean(errs)) if errs else float("nan"), "valid": len(errs) / max(len(samples), 1)}


def grid(sim: Sim) -> list[Target]:
    return grid_targets(sim.screen, "3x3", 0.08)


# ---------------------------------------------------------------------------------------------
# The benchmark used by the tests (and printable as a table)
# ---------------------------------------------------------------------------------------------

MODEL_NAMES = ("geometric", "ridge", "kernel", "reflection", "residual", "blend")
MOVED = dict(dx=0.03, dz=0.04, yaw=8.0, pitch=6.0)  # 5 cm and 10 degrees
EXTRA_POSES = (dict(dx=-0.04, yaw=-7.0), dict(dx=0.03, dz=0.05, pitch=5.0))


def fresh_models(names: tuple[str, ...] = MODEL_NAMES) -> list:
    from phonegaze.models import REGISTRY

    return [REGISTRY[n]() for n in names]


def calibrate(sim: Sim, poses: list[HeadPose], names: tuple[str, ...] = MODEL_NAMES):
    from phonegaze.calibration import fit_all

    run = None
    for pose in poses:
        run = sim.collect(grid(sim), pose, run=run)
    assert run is not None
    return fit_all(run.samples, sim.screen, fresh_models(names)), run


def refine_run(sim: Sim, n: int, head: HeadPose, rig: Rig) -> list[CalibSample]:
    from phonegaze.calibration import refine_targets

    run = CalibrationRun(run_id="refine", kind="refine", targets=refine_targets(sim.screen, n), screen=sim.screen)
    return sim.collect(run.targets, head, kind="refine", rig=rig, run=run).samples


def benchmark(px_per_deg: float = 1.8, seed: int = 1, names: tuple[str, ...] = MODEL_NAMES, noise: Noise | None = None) -> dict:
    """Accuracy (true visual angle, degrees, mean over validation samples) per model and
    scenario. Returns ``{"rows": {scenario: {model: deg}}, "chosen": {...}, "reports": ...}``."""
    import copy

    from phonegaze.calibration import refine

    sim = Sim(rig=Rig(px_per_deg=px_per_deg), noise=noise or Noise(), seed=seed)
    moved = HOME.moved(**MOVED)
    rows: dict[str, dict[str, float]] = {}
    chosen: dict[str, str | None] = {}

    single, _ = calibrate(sim, [HOME], names)
    chosen["single"] = single.chosen
    val_home = sim.validation_samples(16, HOME)
    val_moved = sim.validation_samples(16, moved)
    rows["still, 1 pose"] = {n: evaluate(m, sim, val_home)["deg"] for n, m in single.models.items()}
    rows["head moved, 1 pose"] = {n: evaluate(m, sim, val_moved)["deg"] for n, m in single.models.items()}

    multi, _ = calibrate(sim, [HOME] + [HOME.moved(**p) for p in EXTRA_POSES], names)
    chosen["multi"] = multi.chosen
    rows["still, 3 poses"] = {n: evaluate(m, sim, val_home)["deg"] for n, m in multi.models.items()}
    rows["head moved, 3 poses"] = {n: evaluate(m, sim, val_moved)["deg"] for n, m in multi.models.items()}

    bumped = sim.rig.bumped()
    val_bumped = sim.validation_samples(16, HOME, rig=bumped)
    rows["camera bumped"] = {n: evaluate(m, sim, val_bumped)["deg"] for n, m in single.models.items()}
    for k in (1, 5):
        ref = refine_run(sim, k, HOME, bumped)
        out = {}
        for n, m in single.models.items():
            m2 = copy.deepcopy(m)
            refine(m2, ref, sim.screen)
            out[n] = evaluate(m2, sim, val_bumped)["deg"]
        rows[f"bumped + refine {k}"] = out
    return {"rows": rows, "chosen": chosen, "single": single, "multi": multi}


def format_table(result: dict) -> str:
    rows = result["rows"]
    names = list(next(iter(rows.values())).keys())
    lines = ["| scenario | " + " | ".join(names) + " |", "| --- | " + " | ".join("---" for _ in names) + " |"]
    for scen, vals in rows.items():
        lines.append(f"| {scen} | " + " | ".join(f"{vals.get(n, float('nan')):.2f}" for n in names) + " |")
    lines.append(f"chosen: {result['chosen']}")
    return "\n".join(lines)
