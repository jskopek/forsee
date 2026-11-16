"""Accuracy of every gaze model on the Models test simulator (tests/models_sim.py).

The simulator's person and estimator differ from what the models assume (eyeball radius, kappa
form, biased and jittery head pose, missing reflections), so these numbers are not the models
grading their own homework. They are still a simulation: nothing here has seen a real eye.

Run with ``-s`` to print the tables. Numbers are true visual angles in degrees, mean over 16
fresh validation dots.
"""

from __future__ import annotations

import pytest

from models_sim import ASSUMED_RADIUS_M, Noise, Person, benchmark, format_table

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def at_1_8():
    r = benchmark(px_per_deg=1.8, seed=1)
    print("\n1.8 px per degree (2x crop at 60 cm)\n" + format_table(r))
    return r


@pytest.fixture(scope="module")
def at_0_9():
    r = benchmark(px_per_deg=0.9, seed=1)
    print("\n0.9 px per degree (1x at 60 cm)\n" + format_table(r))
    return r


def test_simulator_is_not_the_model():
    assert abs(Person().eye_radius_m - ASSUMED_RADIUS_M) > 0.001
    n = Noise()
    assert any(n.head_pos_bias_m) and any(n.head_rot_bias_deg) and n.p_no_glint > 0 and n.head_pos_jitter_m > 0


def test_still_head_after_full_calibration(at_1_8):
    rows = at_1_8["rows"]["still, 1 pose"]
    chosen = at_1_8["chosen"]["single"]
    assert rows[chosen] < 1.0
    assert all(v < 2.5 for v in rows.values()), rows


def test_head_moved_5cm_and_10deg(at_1_8):
    one = at_1_8["rows"]["head moved, 1 pose"]
    three = at_1_8["rows"]["head moved, 3 poses"]
    # the iris-to-reflection feature is the most robust to head movement
    assert one["reflection"] < 2.0
    # pure regression learned no head compensation from one pose ...
    assert one["ridge"] > 2 * one["reflection"]
    # ... and learns some from three
    assert three["ridge"] < one["ridge"]
    assert one["geometric"] < 3.5 and three["geometric"] < 2.5


def test_quick_refine_after_the_camera_moved(at_1_8):
    rows = at_1_8["rows"]
    bumped, r1, r5 = rows["camera bumped"], rows["bumped + refine 1"], rows["bumped + refine 5"]
    for name in ("ridge", "kernel", "blend"):
        assert r1[name] < 0.5 * bumped[name], name
    assert r5["geometric"] < bumped["geometric"] - 1.0  # screen pose re-solved
    assert r1["geometric"] < bumped["geometric"]


def test_lower_resolution(at_0_9, at_1_8):
    still = at_0_9["rows"]["still, 1 pose"]
    assert still[at_0_9["chosen"]["single"]] < 1.3
    assert at_0_9["rows"]["head moved, 1 pose"]["reflection"] < 2.5
    # half the pixels per degree costs accuracy for the pixel-hungry models
    assert still["ridge"] > at_1_8["rows"]["still, 1 pose"]["ridge"]
