"""Landmarks estimator on the one real face available offline (scikit-image's astronaut).

Skipped unless the face landmarker model is in the models folder and the image is available
(``skimage.data.astronaut()``, or a PNG path in ``$PHONEGAZE_TEST_FACE``). No face image is
stored in the repository.
"""

from __future__ import annotations

import os

import cv2
import numpy as np
import pytest

from phonegaze.download import model_path
from phonegaze.types import Observation
from phonegaze.vision.landmarks import LandmarkEstimator
from phonegaze.vision.synth import make_frame


def _face() -> np.ndarray | None:
    path = os.environ.get("PHONEGAZE_TEST_FACE")
    if path and os.path.exists(path):
        return cv2.imread(path)
    try:
        from skimage import data  # type: ignore[import-not-found]
    except ImportError:
        return None
    return cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR)


FACE = _face()
pytestmark = pytest.mark.skipif(
    FACE is None or not model_path("face_landmarker.task").exists(),
    reason="needs the face landmarker model and a test face image",
)


@pytest.fixture(scope="module")
def est() -> LandmarkEstimator:
    return LandmarkEstimator()


def _run(est: LandmarkEstimator, wide: np.ndarray, reset: bool = True) -> Observation | None:
    if reset:
        est.reset()
    h, w = wide.shape[:2]
    frame = make_frame({}, width=w * 3, height=h * 3, fx=w * 3 * 0.9, wide=wide)
    return est.process(frame, Observation.empty(frame))


def test_astronaut_eyes_pose_and_distance(est: LandmarkEstimator) -> None:
    obs = _run(est, FACE)
    assert obs is not None
    L, R = obs.left, obs.right
    assert L.found and R.found
    # Unmirrored image: the person's left eye is on the image's right.
    assert L.iris_center[0] > R.iris_center[0]
    assert R.outer_corner[0] < R.inner_corner[0] < L.inner_corner[0] < L.outer_corner[0]
    assert 0.2 < L.openness < 0.6 and not L.blink and not R.blink
    a = obs.extra["landmarks"]["head_angles_deg"]
    assert abs(a["yaw"]) < 15 and abs(a["roll"]) < 10
    assert 0.2 < obs.distance < 2.0
    assert L.gaze_dir is not None and L.gaze_dir[2] < -0.8
    assert abs(np.linalg.norm(L.gaze_dir) - 1) < 1e-6
    hp = np.asarray(obs.head_position)
    assert np.allclose(hp, (np.asarray(L.eyeball_center) + np.asarray(R.eyeball_center)) / 2)
    assert set(obs.extra["landmarks"]["eye_rects"]) == {"left", "right"}


def test_astronaut_roll_follows_image_rotation(est: LandmarkEstimator) -> None:
    base = _run(est, FACE).extra["landmarks"]["head_angles_deg"]["roll"]
    h, w = FACE.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), -20, 1.0)  # 20 degrees clockwise on screen
    rolled = _run(est, cv2.warpAffine(FACE, m, (w, h))).extra["landmarks"]["head_angles_deg"]["roll"]
    assert rolled - base == pytest.approx(20, abs=6)
    mirrored = _run(est, cv2.flip(FACE, 1)).extra["landmarks"]["head_angles_deg"]["roll"]
    assert np.sign(mirrored) == -np.sign(base)


def test_small_face_found_by_tiles_then_tracked(est: LandmarkEstimator) -> None:
    face = cv2.resize(FACE[10:250, 110:350], (110, 110), interpolation=cv2.INTER_AREA)
    wide = np.full((480, 640, 3), 90, np.uint8)
    wide[340:450, 500:610] = face
    est.reset()
    found = None
    for _ in range(20):
        found = _run(est, wide, reset=False)
        if found is not None:
            break
    assert found is not None
    again = _run(est, wide, reset=False)
    assert again is not None and again.extra["landmarks"]["attempt"] == "track"


def test_clipped_face_and_blank(est: LandmarkEstimator) -> None:
    clipped = np.zeros_like(FACE)
    clipped[:, :380] = FACE[:, 132:]
    assert _run(est, clipped) is not None
    assert _run(est, np.full((480, 640, 3), 128, np.uint8)) is None


def test_missing_model_fails_soft() -> None:
    class Cfg:
        landmarks_model = "no-such-model.task"
        landmarks_every = 1

    assert _run(LandmarkEstimator(Cfg()), FACE) is None
