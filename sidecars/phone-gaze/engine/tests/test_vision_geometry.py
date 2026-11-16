"""Vision geometry helpers and the ARKit axis conversion, on hand-made cases."""

from __future__ import annotations

import math

import numpy as np
import pytest

from phonegaze.types import ArkitData, Intrinsics, Observation, rotation_3d
from phonegaze.vision import geometry as G
from phonegaze.vision.arkit import ArkitEstimator, arkit_to_engine
from phonegaze.vision.synth import make_frame

INTR = Intrinsics(3000.0, 3000.0, 1920.0, 1080.0, 3840, 2160)


def test_depth_from_iris_round_trip() -> None:
    r_px = INTR.fx * G.IRIS_RADIUS_M / 0.6
    assert G.depth_from_iris(r_px, INTR.fx) == pytest.approx(0.6)
    assert G.depth_from_iris(0, INTR.fx) is None
    assert G.distance_from_depth(INTR, (INTR.cx, INTR.cy), 0.6) == pytest.approx(0.6)


@pytest.mark.parametrize("gaze", [(0, 0, -1), (0.2, -0.1, -1), (-0.3, 0.25, -1)])
def test_gaze_from_iris_inverts_projection(gaze) -> None:
    g = np.array(gaze, float)
    g /= np.linalg.norm(g)
    center = np.array([0.03, -0.02, 0.6])
    uv = G.project_gaze(INTR, center, g)
    res = G.gaze_from_iris(INTR, uv, center)
    assert res is not None
    got, p, exact = res
    assert exact
    assert np.linalg.norm(got - g) < 1e-9


def test_gaze_from_iris_miss_is_flagged() -> None:
    center = np.array([0.0, 0.0, 0.6])
    far = INTR.project((0.05, 0.0, 0.6))  # 5 cm off: the ray misses a 10 mm sphere
    got, _, exact = G.gaze_from_iris(INTR, far, center)
    assert not exact and abs(np.linalg.norm(got) - 1) < 1e-9


def test_head_angles_signs() -> None:
    assert G.head_angles_deg(np.eye(3)) == pytest.approx({"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, abs=1e-9)
    # Face turned towards image right: head frame rotated about the camera's y axis.
    a = G.head_angles_deg(G.rot_y(-20))
    assert a["yaw"] == pytest.approx(20.0)
    a = G.head_angles_deg(G.rot_x(20))
    assert a["pitch"] == pytest.approx(20.0)
    a = G.head_angles_deg(G.rot_z(15))
    assert a["roll"] == pytest.approx(15.0)


def test_iris_ellipse_full_maps_through_affine() -> None:
    # 90 degree rotation plus offset and 2x downscale (image px -> full px doubles lengths).
    to_full = np.array([[0.0, -2.0, 500.0], [2.0, 0.0, 100.0], [0, 0, 1]])
    cx, cy, a, b, ang = G.iris_ellipse_full((10.0, 20.0), (40.0, 20.0), 0.0, to_full)
    assert (cx, cy) == pytest.approx((500 - 40, 100 + 20))
    assert (a, b) == pytest.approx((40.0, 20.0))
    assert ang % 180 == pytest.approx(90.0)


def test_ellipse_normals_tilt() -> None:
    normals = G.ellipse_normals((0, 0, 10.0, 10.0 * math.cos(math.radians(30)), 0.0))
    assert len(normals) == 2
    for n in normals:
        assert np.degrees(np.arccos(-n[2])) == pytest.approx(30.0)
        assert abs(n[0]) < 1e-9  # minor axis along y -> tilt about x


# ------------------------------------------------------------------------------------- ARKit


def _m(r: np.ndarray | None = None, t=(0.0, 0.0, 0.0)) -> np.ndarray:
    m = np.eye(4)
    if r is not None:
        m[:3, :3] = r
    m[:3, 3] = t
    return m


def _ar(face, left=None, right=None, camera=None, tracked=True, blend=None) -> ArkitData:
    return ArkitData(
        tracked=tracked,
        face=face,
        left_eye=left,
        right_eye=right,
        camera=np.eye(4) if camera is None else camera,
        blend_shapes=blend or {},
    )


def test_arkit_frontal_face() -> None:
    ar = _ar(_m(t=(0, 0, -0.6)), left=_m(t=(0.032, 0.0, 0.02)), right=_m(t=(-0.032, 0.0, 0.02)))
    conv = arkit_to_engine(ar, np.eye(3))
    assert np.allclose(conv["head_rotation"], np.eye(3))
    assert np.allclose(conv["face_origin"], [0, 0, 0.6])
    # The person's left eye is at +x (image right in an unmirrored image), nearer the camera.
    assert np.allclose(conv["left"]["center"], [0.032, 0, 0.58])
    assert np.allclose(conv["right"]["center"], [-0.032, 0, 0.58])
    # Looking straight at the camera: towards -z.
    assert np.allclose(conv["left"]["gaze"], [0, 0, -1])


def test_arkit_yaw_pitch_and_eye_rotation() -> None:
    face = _m(G.rot_y(20), (0, 0, -0.6))  # ARKit y is up: +20 about y turns the face to +x
    conv = arkit_to_engine(_ar(face), np.eye(3))
    a = G.head_angles_deg(conv["head_rotation"])
    assert a["yaw"] == pytest.approx(20.0) and a["pitch"] == pytest.approx(0.0, abs=1e-9)

    face = _m(G.rot_x(15), (0, 0, -0.6))  # +15 about x tips the face's +z down (y up)
    a = G.head_angles_deg(arkit_to_engine(_ar(face), np.eye(3))["head_rotation"])
    assert a["pitch"] == pytest.approx(15.0) and a["yaw"] == pytest.approx(0.0, abs=1e-9)

    eye = _m(G.rot_y(10), (0.032, 0, 0.02))
    conv = arkit_to_engine(_ar(_m(t=(0, 0, -0.6)), left=eye), np.eye(3))
    s, c = math.sin(math.radians(10)), math.cos(math.radians(10))
    assert np.allclose(conv["left"]["gaze"], [s, 0, -c])


def test_arkit_camera_pose_cancels_and_upright_rotation_applies() -> None:
    face = _m(G.rot_y(12) @ G.rot_x(-7), (0.05, -0.02, -0.55))
    left = _m(G.rot_x(5), (0.03, 0.01, 0.02))
    base = arkit_to_engine(_ar(face, left=left), np.eye(3))
    world = _m(G.rot_z(33) @ G.rot_y(-50), (1.0, 2.0, -0.5))
    moved = arkit_to_engine(_ar(world @ face, left=left, camera=world @ np.eye(4)), np.eye(3))
    assert np.allclose(base["head_rotation"], moved["head_rotation"])
    assert np.allclose(base["left"]["center"], moved["left"]["center"])
    up = rotation_3d(90)
    turned = arkit_to_engine(_ar(face, left=left), up)
    assert np.allclose(turned["head_rotation"], up @ base["head_rotation"])
    assert np.allclose(turned["left"]["gaze"], up @ base["left"]["gaze"])


def test_arkit_wire_matrices_are_column_major() -> None:
    face = _m(G.rot_y(20), (0.01, 0.02, -0.6))
    header = {
        "tracked": True,
        "face": list(face.T.ravel()),
        "leftEye": list(_m(t=(0.032, 0, 0.02)).T.ravel()),
        "rightEye": list(_m(t=(-0.032, 0, 0.02)).T.ravel()),
        "camera": list(np.eye(4).ravel()),
        "blendShapes": {"blink_left": 0.9, "blink_right": 0.1},
    }
    ar = ArkitData.from_header(header)
    assert np.allclose(ar.face, face)
    frame = make_frame({}, arkit=ar)
    obs = ArkitEstimator().process(frame, Observation.empty(frame))
    assert obs is not None
    assert obs.left.blink is True and obs.right.blink is False
    assert obs.left.openness < obs.right.openness
    assert obs.distance == pytest.approx(np.linalg.norm(obs.head_position))
    assert obs.provenance["left.gaze_dir"] == "arkit"
    # The iris seed projects in front of the eyeball, on the person's left = image right.
    assert obs.left.iris_center[0] > obs.right.iris_center[0]
    assert obs.left.iris_radius == pytest.approx(frame.intrinsics.fx * G.IRIS_RADIUS_M / 0.57, rel=0.05)


def test_arkit_untracked_adds_nothing() -> None:
    frame = make_frame({}, arkit=_ar(_m(t=(0, 0, -0.6)), tracked=False))
    assert ArkitEstimator().process(frame, Observation.empty(frame)) is None
    assert ArkitEstimator().process(make_frame({}), None) is None
