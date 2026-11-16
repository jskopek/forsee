"""A two-camera observation simulator for the second-camera experiments. Owner: second camera.

Built on the Models area's geometric simulator (``tests/models_sim.py``): the same synthetic
person and phone, plus a webcam at the top centre of the screen that sees the same head. Like
that simulator it produces ``Observation`` objects as the estimators would (no images), so the
whole second-camera chain (pairing, phone-pose solve, move detection, the options, the models)
can be measured quickly and deterministically. ``tests/test_second_camera_render.py`` checks the
same chain on rendered images with the real face landmarker.

The generating model deliberately differs from what the engine assumes:

- the webcam's true field of view is not the assumed one (default 69.5 vs 68 degrees), so its
  distances are about 2.5 % short and its rays slightly wrong;
- its true offset above the screen's top edge can differ from the setting;
- both cameras' eye positions and head poses are biased (:class:`Bias`: fixed to the head, and
  a distance scale along the viewing ray, as a face model that does not fit the person and an
  assumed iris size would do), differently: the webcam by (3, -2, 1.5) degrees, (3, -4, 6) mm
  and +2 % distance, the phone by (2, -1.5, 0.5) degrees, (2, -2, 4) mm and +1.5 %;
- the webcam's per-frame jitter is much worse than the phone's: head rotation 2.5 degrees, eye
  positions 1.5 mm, distance 1.5 cm (phone: 0.3 degrees, 0.7 mm, 3 mm);
- iris and corner pixels are noisy at webcam resolution (1280 x 720);
- everything the phone side already does differently (eye radius, kappa form, biased head pose).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np
from scipy.spatial.transform import Rotation

from models_sim import HOME, HeadPose, Noise, Rig, Sim
from phonegaze.calibration import CalibrationRun, Target, grid_targets, random_targets
from phonegaze.config import Config
from phonegaze.second_camera.geometry import Pose
from phonegaze.second_camera.manager import SecondCamera
from phonegaze.second_camera.tracker import WebcamSample, WebcamTracker, face_ok
from phonegaze.types import CalibSample, Intrinsics, Observation

DEG = math.pi / 180.0


@dataclass
class WebcamRig(Rig):
    """The Mac's camera, in screen-local metres: ``offset_m`` above the top edge's middle, looking
    straight out of the screen (``tilt_deg`` down). Intrinsics from its TRUE field of view."""

    hfov_deg: float = 69.5
    offset_m: float = 0.008
    tilt_deg: float = 0.0
    width: int = 1280
    height: int = 720

    def __post_init__(self) -> None:
        w = 0.3024
        self.camera_at = (w / 2, -self.offset_m, 0.0)
        t = self.tilt_deg * DEG
        self.aim_at = (w / 2, -self.offset_m + math.sin(t), -math.cos(t))

    @property
    def fx(self) -> float:  # type: ignore[override]
        return (self.width / 2) / math.tan(math.radians(self.hfov_deg) / 2)


WEBCAM_NOISE = Noise(
    iris_px=0.7,
    radius_px=0.4,
    corner_px=1.5,
    head_rot_bias_deg=(0.0, 0.0, 0.0),
    head_pos_bias_m=(0.0, 0.0, 0.0),
    head_rot_jitter_deg=2.5,
    head_pos_jitter_m=0.002,
    p_blink=0.03,
    p_outlier=0.02,
    p_no_glint=1.0,
    landing_frames=3,
)
"""Per-frame noise of the emulated webcam estimator (biases are added by :class:`Bias`)."""


@dataclass
class Bias:
    """How an emulated estimator gets the eyes and head wrong.

    Eyeball centres are measured per eye (as from that eye's corners): the true centre plus a
    bias fixed to the HEAD (a face model that does not fit this person), per-frame jitter, and a
    distance scale along the viewing RAY (an assumed iris size or face width) with per-frame
    depth jitter. The head rotation is biased in the head frame on top of models_sim's per-frame
    jitter. ``camera_axes_*`` adds models_sim's kind of bias, fixed to the camera's axes, for
    comparison: with it, nothing that only knows how the camera moved can undo a move."""

    rot_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)  # head frame: yaw, pitch, roll
    pos_m: tuple[float, float, float] = (0.0, 0.0, 0.0)  # head frame
    eye_jitter_m: float = 0.001
    depth_scale: float = 1.0
    depth_jitter_m: float = 0.0
    camera_axes_rot_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)
    camera_axes_pos_m: tuple[float, float, float] = (0.0, 0.0, 0.0)


PHONE_BIAS = Bias(rot_deg=(2.0, -1.5, 0.5), pos_m=(0.002, -0.002, 0.004), eye_jitter_m=0.0007, depth_scale=1.015, depth_jitter_m=0.003)
WEBCAM_BIAS = Bias(rot_deg=(3.0, -2.0, 1.5), pos_m=(0.003, -0.004, 0.006), eye_jitter_m=0.0015, depth_scale=1.02, depth_jitter_m=0.015)
PHONE_NOISE = Noise(head_rot_bias_deg=(0.0, 0.0, 0.0), head_pos_bias_m=(0.0, 0.0, 0.0))
"""models_sim's phone noise without its camera-axis biases (:data:`PHONE_BIAS` has the phone's)."""


def apply_bias(obs: Observation, b: Bias, rng: np.random.Generator) -> None:
    """Replace an emulated estimator's eyeball centres, head pose and distance (in place) with
    :class:`Bias`'s error model. Needs ``obs.extra["truth"]`` (models_sim puts it there)."""
    truth = obs.extra.get("truth") or {}
    if obs.head_rotation is None or "eyes" not in truth:
        return
    r = np.asarray(obs.head_rotation, float)
    r = Rotation.from_euler("yxz", b.camera_axes_rot_deg, degrees=True).as_matrix() @ r @ Rotation.from_euler("yxz", b.rot_deg, degrees=True).as_matrix()
    centres = {}
    for side in ("left", "right"):
        c = np.asarray(truth["eyes"][side]["center"], float)
        centres[side] = c + r @ np.asarray(b.pos_m) + np.asarray(b.camera_axes_pos_m) + rng.normal(0.0, b.eye_jitter_m, 3)
    mid = (centres["left"] + centres["right"]) / 2
    scale = b.depth_scale * (1.0 + rng.normal(0.0, b.depth_jitter_m) / max(float(np.linalg.norm(mid)), 0.1))
    for side in ("left", "right"):
        e = obs.eye(side)
        if e.eyeball_center is not None:
            e.eyeball_center = tuple(float(v) for v in centres[side] * scale)  # type: ignore[assignment]
    obs.head_rotation = r.tolist()
    obs.head_position = tuple(float(v) for v in mid * scale)  # type: ignore[assignment]
    obs.distance = float(np.linalg.norm(mid * scale))


class _NoEstimator:
    name = "none"

    def process(self, *a: Any) -> None:
        return None

    def reset(self) -> None:
        pass


class FakeEngine:
    """Just what :class:`SecondCamera` reads from the engine."""

    def __init__(self, config: Config, screen: Any) -> None:
        self.config = config
        self.screen = screen
        self.models: dict[str, Any] = {}
        self.simulated = False
        self._sim = None
        self.active_run: CalibrationRun | None = None
        self.logs: list[str] = []

    def _to_local(self, t: float) -> float:
        return t

    def log(self, level: str, message: str) -> None:
        self.logs.append(message)


@dataclass
class FakeFrame:
    t: float
    gravity: tuple[float, float, float] | None
    rotation_rate: tuple[float, float, float] | None
    t_received: float | None = None


@dataclass
class TwoCamSim:
    """``sim`` (phone + person) plus a webcam. ``assumed_hfov_deg`` / ``assumed_offset_m`` are
    what the ENGINE is told (``second_camera.hfov_deg`` / ``offset_mm``)."""

    seed: int = 1
    webcam: WebcamRig = field(default_factory=WebcamRig)
    webcam_noise: Noise = field(default_factory=lambda: replace(WEBCAM_NOISE))
    config: Config = field(default_factory=Config)
    phone_noise: Noise = field(default_factory=lambda: replace(PHONE_NOISE))
    phone_bias: Bias = field(default_factory=lambda: replace(PHONE_BIAS))
    webcam_bias: Bias = field(default_factory=lambda: replace(WEBCAM_BIAS))

    def __post_init__(self) -> None:
        self.sim = Sim(rig=Rig(px_per_deg=1.8), noise=self.phone_noise, seed=self.seed)
        self.rig = self.sim.rig
        c = self.config.second_camera
        c.enabled = True
        self.engine = FakeEngine(self.config, self.sim.screen)
        self.sc = SecondCamera(self.engine)
        self.tracker = WebcamTracker(c.hfov_deg, estimator=_NoEstimator())
        self.sc.attach_tracker(self.tracker, "two-camera simulator")
        self.rotation_rate: tuple[float, float, float] | None = (0.0, 0.0, 0.0)

    # -- one paired frame -------------------------------------------------------------------------

    def gravity(self, rig: Rig) -> tuple[float, float, float]:
        """Gravity in the phone's (upright camera) frame for a vertical screen: screen +y."""
        r, _ = rig.camera_axes()
        g = r.T @ np.array([0.0, 1.0, 0.0])
        return tuple(float(v) for v in g)  # type: ignore[return-value]

    def webcam_obs(self, x: float, y: float, head: HeadPose, t: float) -> Observation:
        sim = self.sim
        phone_noise, sim.noise = sim.noise, self.webcam_noise
        t_saved = sim.t
        try:
            obs, _ = sim.observe(x, y, head, rig=self.webcam)
        finally:
            sim.noise = phone_noise
            sim.t = t_saved
        apply_bias(obs, self.webcam_bias, sim.rng)
        assumed = self.config.second_camera.hfov_deg
        true_k = self.webcam.intrinsics()
        fa = (true_k.width / 2) / math.tan(math.radians(assumed) / 2)
        k = fa / true_k.fx  # the estimator's depth is off by this factor
        obs.intrinsics = Intrinsics(fa, fa, true_k.cx, true_k.cy, true_k.width, true_k.height)

        def zs(p: Any) -> Any:
            return None if p is None else (float(p[0]), float(p[1]), float(p[2]) * k)

        for side in ("left", "right"):
            e = obs.eye(side)
            e.eyeball_center = zs(e.eyeball_center)
        obs.head_position = zs(obs.head_position)
        obs.distance = float(np.linalg.norm(obs.head_position)) if obs.head_position else None
        obs.t = obs.t_local = t
        obs.camera_id = "mac-webcam"
        return obs

    def frame(self, x: float, y: float, head: HeadPose, rig: Rig | None = None) -> Observation:
        """One phone frame and the webcam's view of the same instant; returns the observation the
        models would see (after every enabled second-camera option)."""
        rig = rig or self.rig
        phone, _ = self.sim.observe(x, y, head, rig)
        apply_bias(phone, self.phone_bias, self.sim.rng)
        t = phone.t
        w = self.webcam_obs(x, y, head, t)
        ok, why = face_ok(w)
        self.tracker.samples.append(WebcamSample(t, w, ok, why))
        while len(self.tracker.samples) > 60:
            self.tracker.samples.popleft()
        self.tracker.last_obs = w
        return self.sc.on_phone_frame(FakeFrame(t, self.gravity(rig), self.rotation_rate, t), phone)  # type: ignore[arg-type]

    def idle(self, seconds: float, head: HeadPose = HOME, rig: Rig | None = None, look: tuple[float, float] | None = None, wander_m: float = 0.0) -> None:
        """Frames with the person looking around the screen (the solve keeps running)."""
        n = int(seconds * self.sim.fps)
        rng = self.sim.rng
        s = self.sim.screen
        for i in range(n):
            if look is None and i % 30 == 0:
                tx, ty = float(rng.uniform(0.1, 0.9) * s.width), float(rng.uniform(0.1, 0.9) * s.height)
            elif look is not None:
                tx, ty = look
            h = head if not wander_m else head.moved(*(rng.normal(0, wander_m, 3)), *(rng.normal(0, 3.0, 2)))
            self.frame(tx, ty, h, rig)

    def move_phone(self, new_rig: Rig, seconds: float = 0.6, head: HeadPose = HOME, gyro: bool = True) -> None:
        """The phone is moved: ``seconds`` of frames while it moves (rotation rate reported when
        ``gyro``), then it sits at ``new_rig``."""
        n = max(1, int(seconds * self.sim.fps))
        self.rotation_rate = (0.0, 0.35, 0.1) if gyro else (0.0, 0.0, 0.0)
        for _ in range(n):
            self.frame(self.sim.screen.width / 2, self.sim.screen.height / 2, head, new_rig)
        self.rotation_rate = (0.0, 0.0, 0.0)
        self.rig = new_rig

    # -- calibration and validation ---------------------------------------------------------------

    def collect(self, targets: list[Target], head: HeadPose = HOME, kind: str = "grid", frames: int = 27, rig: Rig | None = None, run: CalibrationRun | None = None, pose_group: int | None = None) -> CalibrationRun:
        """Like ``models_sim.Sim.collect``, through the second camera."""
        sim = self.sim
        run = run or CalibrationRun(run_id="sim", kind=kind, targets=list(targets), screen=sim.screen)
        self.engine.active_run = run
        prev = None
        for tg in targets:
            run.begin_dot(tg.dot_id, tg.x, tg.y, sim.t, pose_group=pose_group)
            wob = sim.rng.normal(0, 0.003, 3)
            h = head.moved(*wob, *sim.rng.normal(0, 0.5, 2))
            for i in range(frames):
                look = prev if (prev is not None and i < sim.noise.landing_frames) else (tg.x, tg.y)
                obs = self.frame(look[0], look[1], h, rig)
                obs.extra["truth"]["target_cam"] = sim.to_camera(sim.target_screen_m(tg.x, tg.y), rig or self.rig)
                run.add(obs)
            run.end_dot(tg.dot_id, sim.t)
            prev = (tg.x, tg.y)
        self.engine.active_run = None
        return run

    def validation(self, n: int = 16, head: HeadPose = HOME, rig: Rig | None = None, frames: int = 15, seed: int = 7) -> list[CalibSample]:
        targets = random_targets(self.sim.screen, n, seed=seed)
        out = []
        for tg in targets:
            for _ in range(frames):
                obs = self.frame(tg.x, tg.y, head, rig)
                if obs.left.blink:
                    continue
                out.append(CalibSample(target=(tg.x, tg.y), obs=obs, kind="validate", dot_id=tg.dot_id))
        return out

    def accuracy(self, model: Any, samples: list[CalibSample]) -> float:
        errs = []
        for s in samples:
            p = model.predict(s.obs)
            if p is None or not p.valid:
                continue
            errs.append(self.sim.angular_error((p.x, p.y), s.obs))
        return float(np.mean(errs)) if errs else float("nan")

    # -- truth ------------------------------------------------------------------------------------

    def true_webcam_from_phone(self, rig: Rig | None = None) -> Pose:
        """From the simulator's geometry (screen-local camera axes and positions)."""
        rp, qp = (rig or self.rig).camera_axes()
        rw, qw = self.webcam.camera_axes()
        screen_from_phone = Pose(rp, np.asarray(qp, float))
        screen_from_webcam = Pose(rw, np.asarray(qw, float))
        return screen_from_webcam.inverse() @ screen_from_phone

    def pose_error(self, rig: Rig | None = None) -> tuple[float, float] | None:
        """``(rotation degrees, translation cm)`` of the current solve against the truth."""
        e = self.sc.solver.estimate
        if e is None:
            return None
        truth = self.true_webcam_from_phone(rig)
        d = truth.inverse() @ e.pose
        return float(np.linalg.norm(Rotation.from_matrix(d.R).as_rotvec()) / DEG), float(np.linalg.norm(e.pose.t - truth.t) * 100)


def grid(sim: TwoCamSim, layout: str = "3x3") -> list[Target]:
    return grid_targets(sim.sim.screen, layout, 0.08)


def fit(sim: TwoCamSim, run: CalibrationRun, extra: list[Any] | None = None, names: tuple[str, ...] = ("geometric",)) -> dict[str, Any]:
    """Fit the plain models ``names`` plus whatever the second camera adds (``extra_models``)."""
    from phonegaze.calibration import fit_all
    from phonegaze.models import REGISTRY, _options

    models = [REGISTRY[n](**_options(n, sim.config.models)) for n in names] + sim.sc.extra_models() + list(extra or [])
    res = fit_all(run.samples, sim.sim.screen, models)
    sim.engine.models = dict(res.models)
    sim.sc.calibrated()
    return dict(res.models)


# ---------------------------------------------------------------------------------------------
# The benchmark behind tests/test_second_camera_accuracy.py (printable as a table)
# ---------------------------------------------------------------------------------------------

MOVED_HEAD = dict(dx=0.03, dz=0.04, yaw=8.0, pitch=6.0)
"""Head moved 5 cm and 10 degrees after calibration (as models_sim's benchmark)."""

PHONE_BUMP = dict(rot_deg=(3.0, -2.0, 1.0), shift_m=(0.015, 0.01, -0.01))
"""Phone moved after calibration: about 2 cm and 4 degrees."""


def run_setup(seed: int = 1, *, changes: dict[str, Any] | None = None, true_offset_m: float = 0.008, true_hfov_deg: float = 69.5, layout: str = "3x3", anchor_s: float = 10.0, after_move_s: float = 3.0, models: tuple[str, ...] = ("geometric",)) -> dict[str, Any]:
    """One simulated session: anchor, calibrate, validate still / head moved / phone moved
    (with ``track_phone`` off and on). Returns ``{"rows": {scenario: {model: deg}}, ...}``."""
    from phonegaze.config import update

    cfg = Config()
    errors = update(cfg, {"second_camera.enabled": True, **(changes or {})})
    assert not errors, errors
    s = TwoCamSim(seed=seed, webcam=WebcamRig(hfov_deg=true_hfov_deg, offset_m=true_offset_m), config=cfg)
    s.idle(anchor_s)
    anchor_err = s.pose_error()
    run = s.collect(grid(s, layout))
    fitted = fit(s, run, names=models)
    rows: dict[str, dict[str, float]] = {}
    track = cfg.second_camera.track_phone
    cfg.second_camera.track_phone = False
    rows["still"] = {n: s.accuracy(m, s.validation(16, HOME)) for n, m in fitted.items()}
    rows["head moved"] = {n: s.accuracy(m, s.validation(16, HOME.moved(**MOVED_HEAD))) for n, m in fitted.items()}
    bumped = s.rig.bumped(**PHONE_BUMP)
    s.move_phone(bumped)
    s.idle(after_move_s, rig=bumped)
    moved_err = s.pose_error(bumped)
    rows["phone moved"] = {n: s.accuracy(m, s.validation(16, HOME, rig=bumped)) for n, m in fitted.items()}
    cfg.second_camera.track_phone = True
    rows["phone moved + track_phone"] = {n: s.accuracy(m, s.validation(16, HOME, rig=bumped)) for n, m in fitted.items()}
    cfg.second_camera.track_phone = track
    reports = {n: (m.report.to_dict() if getattr(m, "report", None) else None) for n, m in fitted.items()}
    return {"rows": rows, "anchor_error": anchor_err, "moved_error": moved_err, "moves": s.sc.solver.moves, "reports": reports, "logs": list(s.engine.logs)}


def convergence(seed: int = 1, times: tuple[float, ...] = (0.5, 1.0, 2.0, 5.0, 10.0, 20.0), method: str = "poses", wander_m: float = 0.0) -> list[tuple[float, float, float]]:
    """``[(seconds, rotation error deg, translation error cm)]`` of the phone-pose solve."""
    cfg = Config()
    cfg.second_camera.solve_method = method
    s = TwoCamSim(seed=seed, config=cfg)
    out, done = [], 0.0
    for t in times:
        s.idle(t - done, wander_m=wander_m)
        done = t
        err = s.pose_error()
        out.append((t, err[0], err[1]) if err else (t, float("nan"), float("nan")))
    return out


def format_rows(rows: dict[str, dict[str, float]]) -> str:
    names = list(dict.fromkeys(n for r in rows.values() for n in r))
    lines = ["| scenario | " + " | ".join(names) + " |", "| --- | " + " | ".join("---" for _ in names) + " |"]
    for scen, vals in rows.items():
        lines.append(f"| {scen} | " + " | ".join(f"{vals.get(n, float('nan')):.2f}" for n in names) + " |")
    return "\n".join(lines)


def wide_head_box(seed: int = 1, n: int = 12, frames: int = 10) -> dict[str, float]:
    """The phone loses the eyes: how far the webcam-predicted eye positions are from the true
    ones (pixels, and as a fraction of the eye crop's width), and the error of the coarse
    webcam-only gaze that keeps flowing (uncalibrated, then with the calibrated ``webcam`` model)."""
    from phonegaze.config import update
    from phonegaze.second_camera import fusion

    cfg = Config()
    update(cfg, {"second_camera.enabled": True, "second_camera.wide_head_box": True, "second_camera.webcam_model": True})
    s = TwoCamSim(seed=seed, config=cfg)
    s.idle(5.0)
    out: dict[str, list[float]] = {"eye_px": [], "uncalibrated_deg": [], "calibrated_deg": []}
    targets = random_targets(s.sim.screen, n, seed=11)

    def lost_frames(key: str) -> None:
        for tg in targets:
            for _ in range(frames):
                phone, _ = s.sim.observe(tg.x, tg.y, HOME, s.rig)
                apply_bias(phone, s.phone_bias, s.sim.rng)
                truth_px = phone.left.iris_center
                w = s.webcam_obs(tg.x, tg.y, HOME, phone.t)
                ok, why = face_ok(w)
                s.tracker.samples.append(WebcamSample(phone.t, w, ok, why))
                lost = fusion.clone(phone)
                for side in ("left", "right"):
                    e = lost.eye(side)
                    e.found, e.iris_center, e.eyeball_center, e.gaze_dir, e.inner_corner, e.outer_corner = False, None, None, None, None, None
                obs = s.sc.on_phone_frame(FakeFrame(phone.t, s.gravity(s.rig), (0.0, 0.0, 0.0), phone.t), lost)  # type: ignore[arg-type]
                lens = s.sc.lens_obs(obs, phone.intrinsics)
                if key == "uncalibrated_deg" and truth_px is not None and lens.left.iris_center is not None:
                    out["eye_px"].append(float(np.linalg.norm(np.subtract(lens.left.iris_center, truth_px))))
                p = s.sc.fallback(obs, None)
                if p is not None and p.valid:
                    out[key].append(s.sim.angular_error((p.x, p.y), phone))

    lost_frames("uncalibrated_deg")
    run = s.collect(grid(s))
    fit(s, run)
    lost_frames("calibrated_deg")
    crop_px = s.config.stream.roi_width_mm / 1000.0 * s.rig.intrinsics().fx / 0.6
    res = {k: float(np.median(v)) if v else float("nan") for k, v in out.items()}
    res["eye_crop_fraction"] = res["eye_px"] / crop_px
    res["valid_fraction"] = len(out["calibrated_deg"]) / (n * frames)
    return res
