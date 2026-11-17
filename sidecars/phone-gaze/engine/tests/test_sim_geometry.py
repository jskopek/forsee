"""Simulator geometry: eye model, reflection law, ellipse fit, gravity and orientation."""

from __future__ import annotations

import math

import numpy as np
import pytest

from phonegaze.sim.person import CORNEA_CENTER_M, CORNEA_RADIUS_M, EYEBALL_RADIUS_M, IRIS_PLANE_M, LIMBUS_RADIUS_M, fick, normalize
from phonegaze.sim.scene import SimScene, corneal_reflection_point, ellipse_from_points
from phonegaze.types import Intrinsics, upright_rotation


def test_eye_constants_are_consistent():
    # The sclera sphere passes exactly through the limbus, and so does the corneal sphere.
    assert math.isclose(math.hypot(IRIS_PLANE_M, LIMBUS_RADIUS_M), EYEBALL_RADIUS_M)
    assert math.isclose(math.hypot(IRIS_PLANE_M - CORNEA_CENTER_M, LIMBUS_RADIUS_M), CORNEA_RADIUS_M)
    assert 4e-3 < CORNEA_CENTER_M < 6e-3


def test_fick_maps_vector_exactly():
    rng = np.random.default_rng(3)
    for _ in range(50):
        # Eye-like vectors: a kappa-sized offset from -z, and gaze within about 45 degrees.
        a = normalize(rng.normal(0, 0.1, size=3) + [0, 0, -1])
        b = normalize(rng.normal(0, 0.5, size=3) + [0, 0, -1])
        R = fick(a, b)
        assert np.allclose(R @ a, b, atol=1e-9)
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-12)


def _still_scene(**kw) -> SimScene:
    sc = SimScene(4, **kw)
    sc.knobs.jitter_deg = 0.0
    sc.knobs.blink_rate_per_min = 0.0
    return sc


@pytest.mark.parametrize("point", [(100.0, 80.0), (756.0, 491.0), (1400.0, 900.0)])
def test_visual_axes_hit_the_target(point):
    sc = _still_scene()
    sc.look_at(*point, human=False)
    sc.step(1 / 30)
    truth = sc.capture().truth
    assert truth["gaze"] == pytest.approx(list(point), abs=1e-6)
    # Each eye's visual axis, from its cornea centre, meets the screen at the target.
    for side in ("left", "right"):
        eye = sc.person.eye_states()[side]
        hit = sc.ray_to_screen(eye.cornea_center, eye.visual)
        assert hit == pytest.approx(point, abs=1e-6)
        # Kappa: the visual axis is turned from the optical axis by the person's kappa.
        ang = math.degrees(math.acos(float(eye.visual @ eye.optical)))
        p = sc.person.params
        i = 0 if side == "left" else 1
        assert ang == pytest.approx(math.hypot(p.kappa_h_deg[i], p.kappa_v_deg[i]), abs=0.05)


def test_kappa_is_nasal():
    sc = _still_scene()
    sc.step(1 / 30)
    for side, sign in (("left", -1), ("right", 1)):
        eye = sc.person.eye_states()[side]
        Rh = sc.person.current_head_rotation()
        vis, opt = Rh.T @ eye.visual, Rh.T @ eye.optical
        # Head +x is the person's left; the nose side of the left eye is -x.
        assert sign * (vis[0] - opt[0]) > 0


def test_reflection_point_obeys_the_law_of_reflection():
    rng = np.random.default_rng(1)
    for _ in range(20):
        cc = rng.normal(0, 0.05, 3) + [0, 0, 0.6]
        cam = np.zeros(3)
        target = rng.normal(0, 0.1, 3) + [0, -0.15, 0.0]
        p = corneal_reflection_point(cc, cam, target)
        n = normalize(p - cc)
        assert np.linalg.norm(p - cc) == pytest.approx(CORNEA_RADIUS_M, rel=1e-9)
        a, b = normalize(cam - p), normalize(target - p)
        assert float(a @ n) == pytest.approx(float(b @ n), abs=1e-9)
        assert abs(float(np.cross(a, b) @ n)) < 1e-9  # coplanar with the normal


def test_ellipse_fit_is_exact():
    t = np.linspace(0, 2 * np.pi, 30, endpoint=False)
    a, b, ang, cx, cy = 31.5, 22.25, math.radians(27.0), 140.2, 77.7
    pts = np.stack([cx + a * np.cos(t) * math.cos(ang) - b * np.sin(t) * math.sin(ang), cy + a * np.cos(t) * math.sin(ang) + b * np.sin(t) * math.cos(ang)], 1)
    e = ellipse_from_points(pts)
    assert e[:4] == pytest.approx((cx, cy, a, b), abs=1e-6)
    assert e[4] == pytest.approx(27.0, abs=1e-6)


@pytest.mark.parametrize("orientation", [0, 90, 180, 270])
@pytest.mark.parametrize("camera", ["wide", "front", "arkit"])
def test_gravity_gives_back_the_orientation(orientation, camera):
    sc = _still_scene(orientation=orientation, camera=camera)
    g = sc.gravity_device()
    assert np.linalg.norm(g) == pytest.approx(1.0)
    assert upright_rotation(tuple(g), sc.camera.position) == orientation


def test_intrinsics_scale_with_zoom_about_the_centre():
    sc = _still_scene()
    cam = sc.camera
    k1 = cam.intrinsics(3840, 2160, 1.0)
    k2 = cam.intrinsics(3840, 2160, 2.0)
    assert k2.fx == pytest.approx(2 * k1.fx)
    assert k2.cx - 1920 == pytest.approx(2 * (k1.cx - 1920))
    # A point keeps its ray direction: pixels move away from the centre by the zoom factor.
    p = (0.05, -0.02, 0.6)
    u1, v1 = k1.project(p)
    u2, v2 = k2.project(p)
    assert (u2 - k2.cx) == pytest.approx(2 * (u1 - k1.cx))
    assert isinstance(k1, Intrinsics)


def test_truth_head_rotation_is_a_rotation_facing_the_screen():
    sc = _still_scene()
    sc.step(1 / 30)
    tr = sc.capture().truth
    R = np.asarray(tr["headRotation"])
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)
    assert np.linalg.det(R) == pytest.approx(1.0)
    # The face (-z of the head) points back towards the camera side (z < 0 in camera coords).
    assert (-R[:, 2])[2] < -0.8
    # Left eye appears at larger camera x than the right eye (unmirrored image).
    assert tr["leftEyeCenter"][0] > tr["rightEyeCenter"][0]
    assert tr["distance"] == pytest.approx(0.6, abs=0.01)


def test_human_saccade_reaches_the_target_after_a_delay():
    sc = _still_scene()
    sc.look_at(200.0, 150.0, human=False)
    sc.step(0.01)
    sc.look_at(1300.0, 800.0)  # about 30 degrees away
    sc.step(0.1)
    assert sc.capture().truth["gaze"] == pytest.approx([200.0, 150.0], abs=1.0)  # still reacting
    for _ in range(40):
        sc.step(0.01)
    assert sc.capture().truth["gaze"] == pytest.approx([1300.0, 800.0], abs=1.0)


def test_pursuit_follows_a_moving_dot():
    sc = _still_scene()
    sc.look_at(300.0, 400.0, human=False)
    x = 300.0
    for _ in range(60):
        x += 4.0  # 120 pt/s at 30 Hz
        sc.look_at(x, 400.0)
        sc.step(1 / 30)
    gx = sc.capture().truth["gaze"][0]
    assert x - 40 < gx < x  # lags a little, no saccades back and forth


def test_blinks_happen_at_the_configured_rate():
    sc = SimScene(5)
    sc.knobs.blink_rate_per_min = 30.0
    closed = 0
    for _ in range(30 * 60):
        sc.step(1 / 30)
        closed += sc.person.blink > 0.5
    # About 30 blinks/min x ~60 ms closed each over 60 s: a few dozen frames.
    assert 20 < closed < 200
