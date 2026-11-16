"""The head-movement options measured in the ``phonegaze.sim`` loop. Owner: Models.

The simulator's scene (``phonegaze.sim.scene.SimScene``: a person with their own eye geometry,
lids, kappa and fixational jitter, filmed by the simulated phone) gives the truth per frame; the
landmarks oracle (``phonegaze.sim.oracle``) reads the iris and eye-corner pixels and the head pose
from it with pixel noise; and the eyeball centres are then derived from the eye CORNERS exactly as
the landmarks estimator does (``vision.geometry.eyeball_center_from_corners`` and
``fill_eye_model``; the head position is the midpoint of the two). Optionally the corners slide
in the image as the face turns (``corner_slide_px_per_10deg``), the effect seen on real
landmarks. No images are rendered (the oracle reads the truth), so this measures the
calibration and models, not the vision.

Not a test module: ``tests/models_options_test.py`` runs a small case, and
``python tests/models_simloop.py`` prints the table.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from phonegaze import calibration as calib  # noqa: E402
from phonegaze.config import CalibrationConfig  # noqa: E402
from phonegaze.models.geometric import GeometricModel  # noqa: E402
from phonegaze.protocol import Message  # noqa: E402
from phonegaze.sim.oracle import OracleEstimator  # noqa: E402
from phonegaze.sim.scene import SimScene  # noqa: E402
from phonegaze.types import CalibSample, DecodedFrame, Frame, Observation  # noqa: E402
from phonegaze.vision import geometry as G  # noqa: E402

FPS = 30.0


class Loop:
    """A simulated session: ``SimScene`` + oracle + corner-derived eyeball centres."""

    def __init__(self, seed: int = 1, noise_px: float = 0.4, corner_slide_px_per_10deg: float = 0.0) -> None:
        self.scene = SimScene(seed, orientation=0)
        self.scene.knobs.blink_rate_per_min = 6.0
        self.oracle = OracleEstimator(noise_px=noise_px, seed=seed, fields=("openness", "corners", "iris", "head"))
        self.slide = corner_slide_px_per_10deg
        self.base_pos = np.array(self.scene.person.head_position, float)
        self.seq = 0

    @property
    def screen(self):
        return self.scene.screen

    def head(self, dx: float = 0.0, dz: float = 0.0, yaw: float = 0.0, pitch: float = 0.0) -> None:
        p = self.base_pos + np.array([dx, 0.0, dz])
        self.scene.set_head(p.tolist(), [yaw, pitch, 0.0])

    def frame(self, yaw_for_slide: float = 0.0, pitch_for_slide: float = 0.0) -> Observation:
        self.scene.step(1.0 / FPS)
        cap = self.scene.capture()
        self.seq += 1
        header = {"type": "frame", "seq": self.seq, "t": cap.t, "mode": "camera", "camera": self.scene.camera_header(cap), "gravity": cap.gravity, "sim": cap.truth}
        dec = DecodedFrame.from_frame(Frame.from_message(Message(header, [])), rotation=0)
        obs = self.oracle.process(dec, Observation.empty(dec))
        assert obs is not None
        obs.t_local = cap.t
        intr = obs.intrinsics
        hr = np.asarray(obs.head_rotation, float) if obs.head_rotation is not None else None
        centres = []
        for side in ("left", "right"):
            eye = obs.eye(side)
            if eye.inner_corner is None or eye.outer_corner is None or intr is None or obs.distance is None:
                continue
            if self.slide:
                # corners slide sideways with the face's turn (both the same way)
                s = self.slide * (yaw_for_slide / 10.0)
                v = self.slide * (pitch_for_slide / 10.0)
                eye.inner_corner = (eye.inner_corner[0] + s, eye.inner_corner[1] + v)
                eye.outer_corner = (eye.outer_corner[0] + s, eye.outer_corner[1] + v)
            mid = ((eye.inner_corner[0] + eye.outer_corner[0]) / 2, (eye.inner_corner[1] + eye.outer_corner[1]) / 2)
            rx, ry = intr.ray(*mid)
            depth = obs.distance / math.sqrt(1 + rx * rx + ry * ry)
            c = G.eyeball_center_from_corners(intr, eye.inner_corner, eye.outer_corner, depth, hr)
            obs.set(f"{side}.eyeball_center", tuple(float(x) for x in c), "lm_emul")
            centres.append(c)
        if len(centres) == 2:
            obs.set("head_position", tuple(float(x) for x in (centres[0] + centres[1]) / 2), "lm_emul")
        G.fill_eye_model(obs, "lm_emul")
        return obs

    def look(self, x: float, y: float, frames: int, settle: int = 12, **slide) -> list[Observation]:
        self.scene.look_at(x, y, human=False)
        out = []
        for i in range(frames + settle):
            o = self.frame(**slide)
            if i >= settle:
                out.append(o)
        return out


POSES = {"still": {}, "moved": dict(dx=0.03, dz=0.04, yaw=8.0, pitch=6.0), "turned": dict(dx=-0.02, yaw=-15.0, pitch=-4.0)}


def calibrate(loop: Loop, sweeps: int = 0, sweep_s: float = 8.0) -> list[CalibSample]:
    cfg = CalibrationConfig(head_sweep=sweeps)
    dots = calib.grid_targets(loop.screen, "3x3", 0.08)
    run = calib.make_run(cfg, "g", "grid", dots, loop.screen)
    loop.head()
    for d in dots:
        loop.scene.look_at(d.x, d.y, human=False)
        for _ in range(12):
            loop.frame()
        run.begin_dot(d.dot_id, d.x, d.y, loop.scene.t, pose_group=0)
        for _ in range(27):
            run.add(loop.frame())
        run.end_dot(d.dot_id, loop.scene.t)
    for t in calib.sweep_targets(loop.screen, sweeps):
        loop.scene.look_at(t.x, t.y, human=False)
        run.begin_dot(t.dot_id, t.x, t.y, loop.scene.t)
        n = int(sweep_s * FPS)
        for i in range(n):
            ph = i / max(n - 1, 1)
            yaw, pitch = 15.0 * math.sin(2 * math.pi * ph * 2), 10.0 * math.sin(2 * math.pi * ph * 3 + 0.5)
            loop.head(dx=0.02 * math.sin(2 * math.pi * ph * 1.5), dz=0.02 * math.sin(2 * math.pi * ph), yaw=yaw, pitch=pitch)
            loop.scene.look_at(t.x, t.y, human=False)
            run.add(loop.frame(yaw_for_slide=yaw, pitch_for_slide=pitch))
        run.end_dot(t.dot_id, loop.scene.t)
    loop.head()
    return run.samples


def validate(loop: Loop, model, pose: dict, n: int = 9, seed: int = 7) -> float:
    targets = calib.random_targets(loop.screen, n, seed=seed)
    loop.head(**pose)
    slide = {"yaw_for_slide": pose.get("yaw", 0.0), "pitch_for_slide": pose.get("pitch", 0.0)}
    errs = []
    for t in targets:
        for o in loop.look(t.x, t.y, 15, **slide):
            p = model.predict(o)
            if p is None or not p.valid:
                continue
            e = calib.angular_error_deg((p.x, p.y), (t.x, t.y), o, loop.screen)
            if e is not None:
                errs.append(e)
    loop.head()
    return float(np.mean(errs)) if errs else float("nan")


def rows(seed: int = 1, slide: float = 0.0, configs=None) -> dict[str, dict[str, float]]:
    configs = configs or [
        ("grid, centre=estimator (default)", 0, {}),
        ("grid + 1 sweep, centre=estimator", 1, {}),
        ("grid + 1 sweep, centre=per_eye", 1, {"centre": "per_eye"}),
        ("grid + 1 sweep, centre=head", 1, {"centre": "head"}),
    ]
    out = {}
    for label, sweeps, opts in configs:
        loop = Loop(seed=seed, corner_slide_px_per_10deg=slide)
        samples = calibrate(loop, sweeps=sweeps)
        res = calib.fit_all(samples, loop.screen, [GeometricModel(**opts)])
        m = res.models["geometric"]
        out[label] = {k: validate(loop, m, pose, seed=7 + i) for i, (k, pose) in enumerate(POSES.items())}
    return out


if __name__ == "__main__":
    import time

    for slide in (0.0, 3.0):
        t0 = time.time()
        acc: dict = {}
        seeds = [1, 2]
        for sd in seeds:
            for k, v in rows(seed=sd, slide=slide).items():
                acc.setdefault(k, {p: [] for p in POSES})
                for p in POSES:
                    acc[k][p].append(v[p])
        print(f"### phonegaze.sim loop, corner slide {slide} px per 10 deg (seeds {seeds}, {time.time() - t0:.0f} s)\n")
        print("| option | " + " | ".join(POSES) + " |\n| --- |" + " --- |" * len(POSES))
        for k, v in acc.items():
            print(f"| {k} | " + " | ".join(f"{np.mean(v[p]):.2f}" for p in POSES) + " |")
        print()

