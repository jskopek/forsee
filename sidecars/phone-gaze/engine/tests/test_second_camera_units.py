"""Second camera: geometry, the phone-pose solver, move detection, the observation transforms,
the webcam sources, and that everything is inert by default. Fast; no images."""

from __future__ import annotations

import math
import sys

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from phonegaze.config import Config, settings
from phonegaze.second_camera import fusion
from phonegaze.second_camera.geometry import (
    Pose,
    closest_on_first_ray,
    difference,
    geometric_params,
    kabsch,
    pose_from_geometric_params,
    robust_rotation_mean,
    robust_vector_mean,
    screen_from_webcam,
)
from phonegaze.second_camera.solver import PhonePoseSolver
from phonegaze.second_camera.webcam import FileWebcam, OpenCVWebcam, WebcamError, make_source

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from second_camera_sim import PHONE_BUMP, TwoCamSim, WebcamRig  # noqa: E402

DEG = math.pi / 180


def rand_pose(rng: np.random.Generator, rot_deg: float = 30.0, t_m: float = 0.3) -> Pose:
    return Pose(Rotation.from_rotvec(rng.normal(0, rot_deg * DEG / 2, 3)).as_matrix(), rng.normal(0, t_m, 3))


# --- defaults: off means off ------------------------------------------------------------------


def test_everything_is_off_by_default() -> None:
    c = Config().second_camera
    assert c.enabled is False
    assert c.screen_pose == "off" and c.track_phone is False and c.wide_head_box is False and c.webcam_model is False
    assert c.distance_source == "phone" and c.head_pose_source == "phone"
    paths = [s.path for s in settings() if s.path.startswith("second_camera.")]
    assert len(paths) >= 20  # every switch is in the config tree (so on the Experiments page)


def test_disabled_second_camera_changes_nothing(tmp_path) -> None:
    from phonegaze.pipeline import Engine

    eng = Engine(Config(), hotkeys=False, estimators=[], sinks=[], profile_dir=None)
    sc = eng.second_camera
    sim = TwoCamSim()
    phone, _ = sim.sim.observe(700, 400, sim_home())
    out = sc.on_phone_frame(type("F", (), {"t": 1.0, "gravity": None, "rotation_rate": None, "t_received": 1.0})(), phone)
    assert out is phone and "second_camera" not in phone.extra
    assert sc.extra_models() == [] and sc.state() == {"enabled": False}
    assert sc.lens_obs(phone, phone.intrinsics) is phone and sc.fallback(phone, None) is None
    assert sc.thread is None and sc.tracker is None  # the webcam was never opened
    assert eng.state()["second_camera"] == {"enabled": False}


def sim_home():
    from models_sim import HOME

    return HOME


# --- geometry -----------------------------------------------------------------------------------


def test_pose_algebra_and_geometric_params_round_trip() -> None:
    rng = np.random.default_rng(3)
    a, b = rand_pose(rng), rand_pose(rng)
    p = rng.normal(size=3)
    assert np.allclose((a @ b).apply(p), a.apply(b.apply(p)))
    assert np.allclose((a @ a.inverse()).R, np.eye(3)) and np.allclose((a @ a.inverse()).t, 0)
    back = pose_from_geometric_params(geometric_params(a))
    assert difference(a, back) == pytest.approx((0.0, 0.0), abs=1e-9)


def test_webcam_sits_above_the_top_edge_looking_out() -> None:
    sw = screen_from_webcam(0.30, 0.008, 0.0)
    assert np.allclose(sw.t, [0.15, -0.008, 0.0])
    # the webcam looks along the screen's -z (out of the screen, towards the user)
    assert np.allclose(sw.R[:, 2], [0, 0, -1])
    down = screen_from_webcam(0.30, 0.008, 10.0)
    assert down.R[1, 2] > 0.15  # tilted down: its axis gains screen +y


def test_robust_means_ignore_outliers() -> None:
    rng = np.random.default_rng(1)
    truth = Rotation.from_euler("xyz", [10, -5, 3], degrees=True).as_matrix()
    rs = [truth @ Rotation.from_rotvec(rng.normal(0, 1 * DEG, 3)).as_matrix() for _ in range(60)]
    rs += [Rotation.from_rotvec(rng.normal(0, 40 * DEG, 3)).as_matrix() for _ in range(15)]
    mean, _ = robust_rotation_mean(np.stack(rs))
    assert np.degrees(np.linalg.norm(Rotation.from_matrix(truth.T @ mean).as_rotvec())) < 0.8
    vs = np.vstack([rng.normal([0.1, 0.2, 0.5], 0.01, (60, 3)), rng.normal(0, 1.0, (15, 3))])
    m, _ = robust_vector_mean(vs)
    assert np.linalg.norm(m - [0.1, 0.2, 0.5]) < 0.01


def test_kabsch_and_ray_closest_point() -> None:
    rng = np.random.default_rng(2)
    p = rand_pose(rng)
    src = rng.normal(size=(20, 3))
    got = kabsch(src, src @ p.R.T + p.t)
    assert difference(p, got) == pytest.approx((0.0, 0.0), abs=1e-6)
    x = np.array([0.05, -0.02, 0.6])
    o2 = np.array([0.0, -0.25, 0.05])
    pt, s, gap = closest_on_first_ray(np.zeros(3), x, o2, x - o2)
    assert np.allclose(pt, x) and gap < 1e-9 and s == pytest.approx(np.linalg.norm(x))


# --- the solver -----------------------------------------------------------------------------------


def _pairs(solver: PhonePoseSolver, truth: Pose, n: int, rng: np.random.Generator, t0: float = 0.0, rot_noise: float = 0.0, t_noise: float = 0.0, gravity=(0.0, 1.0, 0.0)) -> float:
    t = t0
    for _ in range(n):
        t += 1 / 30
        head_p = Pose(Rotation.from_rotvec(rng.normal(0, 5 * DEG, 3)).as_matrix(), np.array([0.0, 0.0, 0.6]) + rng.normal(0, 0.02, 3))
        head_w = truth @ head_p
        noisy = Pose(head_w.R @ Rotation.from_rotvec(rng.normal(0, rot_noise * DEG, 3)).as_matrix(), head_w.t + rng.normal(0, t_noise, 3))
        pts_p = np.array([head_p.apply([0.0315, 0, 0]), head_p.apply([-0.0315, 0, 0]), head_p.t])
        pts_w = np.array([noisy.apply([0.0315, 0, 0]), noisy.apply([-0.0315, 0, 0]), noisy.t])
        solver.imu(t, gravity, (0.0, 0.0, 0.0))
        solver.add(t, head_p, noisy, pts_p, pts_w)
    return t


@pytest.mark.parametrize("method", ["poses", "points", "hybrid"])
def test_solver_recovers_an_exact_pose(method: str) -> None:
    rng = np.random.default_rng(5)
    truth = Pose(Rotation.from_euler("xyz", [-20, 3, 1], degrees=True).as_matrix(), np.array([0.0, 0.25, 0.05]))
    s = PhonePoseSolver(method=method, min_pairs=10)
    _pairs(s, truth, 40, rng)
    assert s.anchored()
    r, t = difference(truth, s.estimate.pose)
    assert r < 1e-4 and t < 1e-5


def test_solver_averages_noise_and_reports_uncertainty() -> None:
    rng = np.random.default_rng(6)
    truth = Pose(Rotation.from_euler("xyz", [-20, 3, 1], degrees=True).as_matrix(), np.array([0.0, 0.25, 0.05]))
    s = PhonePoseSolver(method="poses", min_pairs=20)
    _pairs(s, truth, 600, rng, rot_noise=3.0, t_noise=0.02)
    r, t = difference(truth, s.estimate.pose)
    e = s.estimate
    assert r < 1.0 and t < 0.012, (r, t)  # 3 deg / 2 cm per frame -> under 1 deg / 1.2 cm
    assert 3.0 < e.sd_rot_deg < 7.0 and e.se_rot_deg < 1.5 and e.se_t_m < 0.02  # per-frame RMS about 3 x sqrt(3)


def test_gyro_and_gravity_start_a_new_segment() -> None:
    rng = np.random.default_rng(7)
    truth = Pose(np.eye(3), np.array([0.0, 0.25, 0.05]))
    s = PhonePoseSolver(min_pairs=10)
    t = _pairs(s, truth, 30, rng)
    assert s.status(t) == "anchored" and s.moves == 0
    s.imu(t + 0.01, (0.0, 1.0, 0.0), (0.0, 0.5, 0.0))  # 29 deg/s
    assert s.moves == 1 and s.status(t + 0.02) == "moving"
    t = _pairs(s, truth, 30, rng, t0=t + 0.5)
    assert s.status(t) == "anchored" and s.current.id == 1
    g = Rotation.from_euler("x", 3, degrees=True).apply([0.0, 1.0, 0.0])  # tilted 3 degrees, no gyro
    t = _pairs(s, truth, 5, rng, t0=t, gravity=tuple(g))
    assert s.moves == 2 and "tilted" in s.last_move["reason"]


def test_vision_notices_a_move_the_gyro_missed() -> None:
    rng = np.random.default_rng(8)
    before = Pose(np.eye(3), np.array([0.0, 0.25, 0.05]))
    after = Pose(Rotation.from_euler("x", 6, degrees=True).as_matrix(), np.array([0.04, 0.22, 0.05]))
    s = PhonePoseSolver(min_pairs=10)
    t = _pairs(s, before, 60, rng, rot_noise=1.0, t_noise=0.005)
    t = _pairs(s, after, 60, rng, t0=t, rot_noise=1.0, t_noise=0.005)
    assert s.moves == 1 and "disagree" in s.last_move["reason"]
    assert difference(after, s.estimate.pose)[1] < 0.01


# --- transforms -----------------------------------------------------------------------------------


def _quiet_sim() -> TwoCamSim:
    from models_sim import Noise

    from second_camera_sim import Bias

    quiet = Noise(iris_px=0, radius_px=0, corner_px=0, glint_px=0, head_rot_bias_deg=(0, 0, 0), head_pos_bias_m=(0, 0, 0), head_rot_jitter_deg=0, head_pos_jitter_m=0, fixation_jitter_deg=0, p_blink=0, p_outlier=0)
    s = TwoCamSim(phone_noise=quiet, webcam_noise=quiet, phone_bias=Bias(eye_jitter_m=0), webcam_bias=Bias(eye_jitter_m=0), webcam=WebcamRig(hfov_deg=68.0))
    return s


def test_to_reference_undoes_a_phone_move() -> None:
    s = _quiet_sim()
    rig0, rig1 = s.rig, s.rig.bumped(**PHONE_BUMP)
    o0, _ = s.sim.observe(500, 300, sim_home(), rig0, look_jitter=False)
    o1, _ = s.sim.observe(500, 300, sim_home(), rig1, look_jitter=False)
    m = s.true_webcam_from_phone(rig0).inverse() @ s.true_webcam_from_phone(rig1)
    back = fusion.to_reference(o1, m)
    for side in ("left", "right"):
        assert np.allclose(back.eye(side).eyeball_center, o0.eye(side).eyeball_center, atol=1e-9)
        assert np.allclose(back.eye(side).iris_center, o0.eye(side).iris_center, atol=0.5)  # pixels at the eye's depth
    assert np.allclose(back.head_rotation, o0.head_rotation, atol=1e-9)
    assert back is not o1 and o1.eye("left").iris_center != back.eye("left").iris_center  # o1 untouched


def test_triangulation_finds_the_eyes() -> None:
    s = _quiet_sim()
    phone, _ = s.sim.observe(700, 500, sim_home(), look_jitter=False)
    web = s.webcam_obs(700, 500, sim_home(), phone.t)
    # move the phone's eyes 2 cm along their rays (a wrong distance), keep the pixels
    for side in ("left", "right"):
        e = phone.eye(side)
        e.eyeball_center = tuple(np.asarray(e.eyeball_center) * 1.035)
    tri = fusion.triangulate(phone, web, s.true_webcam_from_phone())
    assert tri is not None and max(tri["gaps"].values()) < 0.002
    fixed = fusion.apply_triangulation(phone, tri)
    for side in ("left", "right"):
        truth = phone.extra["truth"]["eyes"][side]["center"]
        assert np.linalg.norm(np.asarray(fixed.eye(side).eyeball_center) - truth) < 0.003


# --- pairing in time ----------------------------------------------------------------------------


def test_webcam_frames_are_interpolated_to_the_phone_frame_time() -> None:
    from phonegaze.second_camera.tracker import WebcamSample

    s = TwoCamSim()
    sc = s.sc
    for i in range(10):  # the webcam at 15 fps, offset by 20 ms; the head moving 10 cm/s sideways
        t = 100.0 + i / 15 + 0.02
        obs = s.webcam_obs(700, 400, sim_home().moved(dx=0.1 * (t - 100.0)), t)
        s.tracker.samples.append(WebcamSample(t, obs, True, ""))
    t = 100.0 + 4.5 / 15 + 0.02
    pose, pts, near = sc._webcam_at(t)  # noqa: SLF001
    a, b = s.tracker.samples[4], s.tracker.samples[5]
    mid = (np.asarray(a.obs.head_position) + np.asarray(b.obs.head_position)) / 2
    assert pose is not None and np.allclose(pose.t, mid, atol=1e-6)
    assert near is a.obs or near is b.obs
    assert sc._webcam_at(200.0)[0] is None  # noqa: SLF001 - nothing near that time


# --- wide head box ------------------------------------------------------------------------------


def test_wide_head_box_predicts_the_eyes_and_falls_back_to_webcam_gaze() -> None:
    s = _quiet_sim()
    s.config.second_camera.wide_head_box = True
    s.idle(2.0)
    phone, _ = s.sim.observe(700, 400, sim_home(), look_jitter=False)
    truth_px = {side: phone.eye(side).iris_center for side in ("left", "right")}
    w = s.webcam_obs(700, 400, sim_home(), phone.t)
    s.tracker.samples.append(__import__("phonegaze.second_camera.tracker", fromlist=["WebcamSample"]).WebcamSample(phone.t, w, True, ""))
    lost = fusion.clone(phone)
    for side in ("left", "right"):
        e = lost.eye(side)
        e.found, e.iris_center, e.eyeball_center, e.gaze_dir = False, None, None, None
    out = s.sc.on_phone_frame(type("F", (), {"t": phone.t, "gravity": s.gravity(s.rig), "rotation_rate": (0, 0, 0), "t_received": phone.t})(), lost)
    lens = s.sc.lens_obs(out, phone.intrinsics)
    for side in ("left", "right"):
        got = np.asarray(lens.eye(side).iris_center)
        assert np.linalg.norm(got - truth_px[side]) < 0.1 * phone.intrinsics.width  # within a crop
    p = s.sc.fallback(out, None)
    assert p is not None and p.valid and p.confidence <= 0.25 and p.extra["low_confidence"] is True


# --- sources --------------------------------------------------------------------------------------


def test_file_source_and_clear_errors() -> None:
    imgs = [np.full((48, 64, 3), i, np.uint8) for i in range(3)]
    src = FileWebcam(images=imgs, realtime=False)
    frames = [src.read() for _ in range(4)]
    assert [f.pixels[0, 0, 0] for f in frames[:3]] == [0, 1, 2] and frames[3] is None
    assert frames[1].t_local >= frames[0].t_local
    with pytest.raises(WebcamError, match="does not exist"):
        FileWebcam("/nonexistent/clip.mp4").read()
    cfg = Config().second_camera
    cfg.source = "sim"
    with pytest.raises(WebcamError, match="--sim"):
        make_source(cfg, None)
    cfg.source = "auto"
    assert make_source(cfg, "http://127.0.0.1:1").name == "sim"
    assert make_source(cfg, None).name == "opencv"


@pytest.mark.skipif(sys.platform == "darwin", reason="a Mac may really have camera 7")
def test_no_camera_is_a_clear_message() -> None:
    with pytest.raises(WebcamError, match="Could not open camera 7"):
        OpenCVWebcam(7).open()


def _wait(cond, timeout: float = 5.0) -> bool:
    import time

    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


@pytest.mark.skipif(sys.platform == "darwin", reason="a Mac may really have camera 7")
def test_switching_on_and_off_live_with_no_camera_and_permission_denied(monkeypatch) -> None:
    """The master switch opens and closes the webcam while the engine runs; "no camera" and
    "permission denied" end up as a message in the state, never as an exception."""
    from phonegaze.pipeline import Engine
    from phonegaze.second_camera import manager as manager_mod
    from phonegaze.second_camera.webcam import PERMISSION_HELP

    eng = Engine(Config(), hotkeys=False, estimators=[], sinks=[], profile_dir=None)
    sc = eng.second_camera
    c = eng.config.second_camera
    c.source, c.camera_index = "opencv", 7
    sc.sync()
    assert sc.thread is None and sc.state() == {"enabled": False}  # off: never opened

    c.enabled = True  # on, but there is no camera 7
    sc.sync()
    assert sc.thread is not None
    assert _wait(lambda: not sc.thread.running)
    st = sc.state()
    assert st["enabled"] is True and st["running"] is False and "Could not open camera 7" in st["error"]
    sc.sync()  # unchanged settings: the error stays, no retry loop
    assert "Could not open camera 7" in sc.state()["error"]

    c.enabled = False  # off again, live
    sc.sync()
    assert sc.thread is None and sc.state() == {"enabled": False}

    class Denied:
        name = "opencv"

        def read(self):
            raise WebcamError("Camera 0 opened but delivers no frames. " + PERMISSION_HELP)

        def close(self) -> None:
            pass

    monkeypatch.setattr(manager_mod, "make_source", lambda cfg, url: Denied())
    c.enabled, c.camera_index = True, 0
    sc.sync()
    assert _wait(lambda: not sc.thread.running)
    err = sc.state()["error"]
    assert "Privacy & Security > Camera" in err
    c.enabled = False
    sc.sync()
    assert sc.thread is None
    eng.second_camera.stop()
