"""Second camera on rendered images: the simulator's webcam renders the same synthetic person
the simulated phone does, the engine reads it like a real webcam, runs the real face landmarker
on both cameras' frames and solves the phone's pose. Checked against the simulator's truth.

The webcam's true field of view (69.5 degrees) is not the one the engine assumes (68), and
MediaPipe's head pose on the synthetic face is biased by a few degrees in both cameras: the
generating model is not the fitted one. Run with ``-s`` to see the numbers."""

from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest

from phonegaze.config import Config
from phonegaze.pipeline import Engine
from phonegaze.second_camera.geometry import Pose, difference

pytestmark = pytest.mark.slow


def truth(engine: Engine) -> Pose:
    _, t = engine._sim.webcam.capture()  # noqa: SLF001
    return Pose.from_dict(t["webcamFromPhone"])


async def wait_until(fn, timeout: float, step: float = 0.25):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        v = fn()
        if v:
            return v
        await asyncio.sleep(step)
    return fn()


# (absolute pose: rotation deg, translation m), (the change after a move: deg, m). With the ray
# correction the CHANGE is measured well (about 1 degree and 1 cm for a 4 degree, 2 cm move)
# but the absolute pose is worse (about 10 degrees, 10 cm: a pitch bias of MediaPipe on this
# synthetic face that the uncorrected webcam happens to share); without it the absolute pose is
# better (about 3 degrees, 4 cm) and the change is barely measured (about 4 degrees, 4 cm).
BOUNDS = {True: ((14.0, 0.14), (2.5, 0.025)), False: ((8.0, 0.08), (6.0, 0.05))}


@pytest.mark.parametrize("ray", [True, False], ids=["ray-corrected", "raw"])
async def test_phone_pose_from_rendered_webcam_and_phone(tmp_path, ray: bool) -> None:
    cfg = Config()
    cfg.sim.port = 0
    cfg.sim.camera = "wide"
    cfg.recording.directory = str(tmp_path)
    cfg.second_camera.enabled = True
    cfg.second_camera.fps = 10.0
    cfg.second_camera.head_ray_correction = ray
    (abs_r, abs_t), (d_r, d_t) = BOUNDS[ray]
    engine = Engine(cfg, hotkeys=False, no_cursor=True, sinks=[])
    await engine.start(autoconnect=False)
    try:
        await engine.connect(sim=True)
        sc = engine.second_camera
        t0 = time.monotonic()
        anchored = await wait_until(lambda: sc.solver.anchored(), 60.0)
        t_anchor = time.monotonic() - t0
        st = sc.state()
        assert anchored, st
        assert st["source"] == "sim" and st["faces"] >= 0.8 * st["frames"], st
        await asyncio.sleep(8.0)  # keep averaging
        before = truth(engine)
        r0, t_0 = difference(before, sc.solver.estimate.pose)
        print(f"\nrendered, ray correction {ray}: anchored after {t_anchor:.1f} s (solver says {sc.solver.describe(time.monotonic())['time_to_anchor_s']:.1f} s of paired frames); error {r0:.2f} deg, {t_0 * 100:.1f} cm; webcam {st['frames']} frames")
        # MediaPipe's head rotation on the synthetic face is off by degrees in each camera; one
        # degree of rotation error moves the solved phone by about a centimetre.
        assert r0 < abs_r and t_0 < abs_t
        ref = sc.solver.estimate.pose
        moves = sc.solver.moves

        # Move the phone 2 cm and about 4 degrees, smoothly, with the gyro reporting it.
        await engine._sim.webcam.move_phone([0.02, -0.01, 0.0], [3.0, -2.0, 1.0], 0.6)  # noqa: SLF001
        assert await wait_until(lambda: sc.solver.moves > moves, 5.0), "the move was not detected"
        assert sc.state()["solver"]["status"] in ("moving", "re-anchoring", "anchored")
        assert await wait_until(lambda: sc.solver.anchored(), 30.0), "did not re-anchor"
        await asyncio.sleep(8.0)
        after = truth(engine)
        r1, t_1 = difference(after, sc.solver.estimate.pose)
        m_true = before.inverse() @ after
        m_est = ref.inverse() @ sc.solver.estimate.pose
        dr, dt = difference(m_true, m_est)
        print(f"rendered: after the move error {r1:.2f} deg, {t_1 * 100:.1f} cm; the move itself ({m_true.angle_deg():.1f} deg, {np.linalg.norm(m_true.t) * 100:.1f} cm) is measured to {dr:.2f} deg, {dt * 100:.1f} cm")
        assert r1 < abs_r and t_1 < abs_t
        # what track_phone uses: the change, in which constant biases cancel
        assert dr < d_r and dt < d_t
        sc_state = sc.state()
        assert sc_state["self_check"]["n"] > 20 and 0.8 < sc_state["self_check"]["webcam_m"] / sc_state["self_check"]["phone_m"] < 1.3
    finally:
        await engine.stop()
