"""The landmarks oracle turns the simulator's truth into a correct Observation."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.protocol import Message
from phonegaze.sim.oracle import OracleEstimator
from phonegaze.sim.scene import SimScene
from phonegaze.types import DecodedFrame, Frame, Observation, rotation_affine


def _frame(orientation: int) -> tuple[SimScene, Frame]:
    sc = SimScene(3, orientation=orientation)
    sc.knobs.blink_rate_per_min = 0
    sc.step(0.05)
    cap = sc.capture()
    header = {"type": "frame", "seq": 7, "t": 2.0, "mode": "camera", "camera": sc.camera_header(cap), "gravity": cap.gravity, "sim": cap.truth}
    return sc, Frame.from_message(Message(header, []))


@pytest.mark.parametrize("truth_rot,engine_rot", [(180, 180), (180, 0), (90, 270), (0, 90)])
def test_oracle_matches_truth_in_the_engines_rotation(truth_rot, engine_rot):
    _, frame = _frame(truth_rot)
    dec = DecodedFrame.from_frame(frame, rotation=engine_rot)
    obs = OracleEstimator().process(dec, Observation.empty(dec))
    assert obs is not None
    truth = frame.header["sim"]
    for side in ("left", "right"):
        eye = obs.eye(side)
        assert eye.found and eye.confidence == 1.0
        # 3D and 2D agree under the engine's own upright intrinsics.
        u, v = dec.intrinsics.project(eye.eyeball_center)
        # The truth's eyeball pixel, carried through the same rotation as every other pixel:
        A = dec.sensor_to_upright @ np.linalg.inv(rotation_affine(truth_rot, frame.camera.width, frame.camera.height))
        ex, ey, _ = A @ np.array([*truth["eyes"][side]["eyeballCenter"], 1.0])
        assert (u, v) == pytest.approx((ex, ey), abs=1e-6)
        assert np.linalg.norm(eye.gaze_dir) == pytest.approx(1.0)
        assert eye.iris_radius == pytest.approx(truth["eyes"][side]["irisRadius"])
        assert obs.provenance[f"{side}.iris_center"] == "sim_oracle"
    if truth_rot == engine_rot:
        # The person's left eye is on the right of the upright image.
        assert obs.left.iris_center[0] > obs.right.iris_center[0]
        assert obs.left.iris_center == pytest.approx(truth["eyes"]["left"]["irisCenter"])
    R = np.asarray(obs.head_rotation)
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)
    assert obs.distance == pytest.approx(0.6, abs=0.02)


def test_oracle_noise_and_missing_truth():
    _, frame = _frame(180)
    dec = DecodedFrame.from_frame(frame)
    clean = OracleEstimator().process(dec, Observation.empty(dec))
    noisy = OracleEstimator(noise_px=0.5, seed=1).process(dec, Observation.empty(dec))
    d = np.subtract(clean.left.iris_center, noisy.left.iris_center)
    assert 0 < np.linalg.norm(d) < 3
    frame.header.pop("sim")
    assert OracleEstimator().process(DecodedFrame.from_frame(frame), None) is None
