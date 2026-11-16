"""Second camera: accuracy with and without each option, in degrees, on the two-camera
observation simulator (``tests/second_camera_sim.py``). Run with ``-s`` for the tables.

Numbers are true visual angles (mean over validation samples) against the simulator's truth.
The generating model differs from what the engine assumes (eye radius, kappa form, biased and
jittery head poses in both cameras, a webcam field of view and offset the engine is not told),
so these are not the models grading their own homework. They are still a simulation: nothing
here has seen a real MacBook camera.
"""

from __future__ import annotations

import pytest

from second_camera_sim import convergence, format_rows, run_setup

pytestmark = pytest.mark.slow

SETUPS = {
    "fixed": dict(changes={"second_camera.screen_pose": "fixed", "second_camera.webcam_model": True}),
    "prior": dict(changes={"second_camera.screen_pose": "prior"}),
    "prior 2x2": dict(changes={"second_camera.screen_pose": "prior"}, layout="2x2"),
    "triangulated": dict(changes={"second_camera.distance_source": "triangulated"}),
    "head fused": dict(changes={"second_camera.head_pose_source": "fused"}),
    "fov 60 (true 69.5)": dict(changes={"second_camera.screen_pose": "prior", "second_camera.hfov_deg": 60.0}),
    "offset 25 mm (told 8)": dict(changes={"second_camera.screen_pose": "fixed"}, true_offset_m=0.025),
}


@pytest.fixture(scope="module")
def results() -> dict:
    out = {name: run_setup(**kw) for name, kw in SETUPS.items()}
    for name, r in out.items():
        print(f"\n## {name}: phone pose error {r['anchor_error'][0]:.2f} deg, {r['anchor_error'][1]:.1f} cm; after the move {r['moved_error'][0]:.2f} deg, {r['moved_error'][1]:.1f} cm")
        print(format_rows(r["rows"]))
    return out


def test_phone_pose_solve_converges_quickly() -> None:
    rows = convergence(times=(0.5, 1.0, 2.0, 5.0, 20.0))
    print("\nphone-pose error over time (s, deg, cm):", [tuple(round(v, 2) for v in r) for r in rows])
    by_t = {t: (r, c) for t, r, c in rows}
    # anchored (20 paired frames) within a second; then limited by the cameras' biases, not noise
    assert by_t[2.0][0] < 3.0 and by_t[2.0][1] < 5.0
    assert by_t[20.0][0] < 2.5 and by_t[20.0][1] < 4.0
    moving = convergence(times=(5.0, 20.0), method="points", wander_m=0.03)
    print("points, head wandering 3 cm:", [tuple(round(v, 2) for v in r) for r in moving])
    assert moving[-1][1] < 1.5 and moving[-1][2] < 4.0


def test_track_phone_recovers_a_moved_phone(results) -> None:
    for name in ("fixed", "prior", "triangulated"):
        r = results[name]["rows"]
        still, moved, tracked = r["still"]["geometric"], r["phone moved"]["geometric"], r["phone moved + track_phone"]["geometric"]
        assert results[name]["moves"] >= 1, name
        assert moved > still + 1.0, (name, still, moved)  # the move breaks the calibration ...
        assert tracked < moved - 0.8, (name, moved, tracked)  # ... track_phone repairs most of it
        assert tracked < still + 1.0, (name, still, tracked)


def test_screen_pose_from_the_solve(results) -> None:
    fixed, prior = results["fixed"]["rows"], results["prior"]["rows"]
    # as a prior it costs nothing and helps a little after a head move ...
    assert prior["still"]["geometric_2cam"] < prior["still"]["geometric"] + 0.3
    assert prior["head moved"]["geometric_2cam"] < prior["head moved"]["geometric"] + 0.3
    # ... and from four dots it matches the plain model from nine (fewer dots)
    assert results["prior 2x2"]["rows"]["still"]["geometric_2cam"] < prior["still"]["geometric"] + 0.3
    # fixed (no screen pose fitted at all) is worse: the solve's few-centimetre bias shows
    assert fixed["still"]["geometric_2cam"] < 2.0


def test_webcam_only_baseline_is_far_behind_the_phone(results) -> None:
    rows = results["fixed"]["rows"]
    assert rows["still"]["webcam"] > 3 * rows["still"]["geometric"]
    assert rows["still"]["webcam"] < 15.0  # but it is a working gaze estimate


def test_triangulated_eyes_and_fused_head_pose(results) -> None:
    tri = results["triangulated"]["rows"]
    base = results["prior"]["rows"]
    assert tri["still"]["geometric"] < base["still"]["geometric"] + 0.2
    fused = results["head fused"]["rows"]
    assert fused["still"]["geometric"] < base["still"]["geometric"] + 0.5


def test_wrong_field_of_view_or_offset_degrades_gracefully(results) -> None:
    fov = results["fov 60 (true 69.5)"]
    assert fov["anchor_error"][1] > 8.0  # the solve is clearly off (distances 18 % short) ...
    assert fov["rows"]["still"]["geometric_2cam"] < 1.6  # ... but as a prior it does little harm
    off = results["offset 25 mm (told 8)"]["rows"]
    assert off["still"]["geometric_2cam"] < 2.0
    for r in (fov["rows"], off):
        # track_phone uses only the CHANGE of the solved pose, so the same bias cancels
        assert r["phone moved + track_phone"]["geometric"] < r["phone moved"]["geometric"] - 0.5


def test_wide_head_box_keeps_a_coarse_gaze() -> None:
    from second_camera_sim import wide_head_box

    r = wide_head_box()
    print("\nwide head box (phone lost the eyes):", {k: round(v, 3) for k, v in r.items()})
    assert r["eye_crop_fraction"] < 0.3  # the predicted eyes land well inside a re-placed crop
    assert r["valid_fraction"] > 0.8  # gaze keeps flowing (marked low confidence) ...
    assert r["calibrated_deg"] < 12.0  # ... coarsely, once the webcam model is calibrated (before
    # that, with textbook eye parameters, it is tens of degrees off: reported, not bounded)
