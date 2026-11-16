"""Drift correction from selections (``phonegaze/models/drift.py``): the update rule, scoring
before the update, weighting by target size, outlier rejection, undo, resets, and a simulator
session with a slowly creeping phone. Owner: Models.

The simulator here is the Models area's geometric one (``models_sim.py``): synthetic
observations of a person looking at known points. Passing these tests means the arithmetic and
the plumbing are right against a simulated person; it says nothing about a real phone."""

from __future__ import annotations

import math

import numpy as np
import pytest

from models_sim import HOME, Sim, calibrate
from phonegaze.models.drift import DriftCorrector, DriftSettings, points_per_degree, rect_distance
from phonegaze.replay import drift_replay, format_drift
from phonegaze.types import ScreenInfo

PPD = 40.0  # points per degree for the unit tests
SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.4, height_mm=196.4, scale=2.0, source="sim")


def feed(dc: DriftCorrector, t_end: float, x: float, y: float, n: int = 15, dt: float = 1 / 30) -> None:
    """``n`` predictions at ``(x, y)`` ending at ``t_end``."""
    for i in range(n):
        dc.add_prediction(t_end - (n - 1 - i) * dt, x, y)


def key(cx: float, cy: float, w: float = 80.0, h: float = 80.0) -> tuple[float, float, float, float]:
    return (cx - w / 2, cy - h / 2, w, h)


# --- update rule ------------------------------------------------------------------------------


def test_first_selection_follows_the_kalman_gain():
    s = DriftSettings(prior_sd_deg=1.0, gaze_sd_deg=0.5, max_step_deg=10.0)
    dc = DriftCorrector(s)
    feed(dc, 10.0, 500.0, 300.0)
    out = dc.selection(520.0, 300.0, 10.0, PPD, rect=key(520, 300, 40, 40))
    assert out["used"]
    size = 40.0 / PPD
    r = 0.5**2 + size**2 / 12
    gain = 1.0 / (1.0 + r)
    assert dc.offset[0] == pytest.approx(gain * 20.0)
    assert dc.offset[1] == pytest.approx(0.0)
    assert dc.var[0] == pytest.approx((1 - gain) * 1.0)
    # The offset is applied by apply(); the uncorrected stream is untouched.
    assert dc.apply(500.0, 300.0) == pytest.approx((500.0 + gain * 20.0, 300.0))


def test_repeated_selections_converge_without_overshoot():
    dc = DriftCorrector(DriftSettings(rate_deg_per_min=0.5))
    t = 0.0
    for _ in range(60):
        t += 1.5
        feed(dc, t, 500.0, 300.0)
        dc.selection(530.0, 290.0, t, PPD, rect=key(530, 290))
    assert dc.offset == pytest.approx([30.0, -10.0], abs=1.5)
    assert np.all(np.abs(dc.offset) <= np.array([30.0, 10.0]) + 1e-6)


def test_steps_and_the_offset_are_capped():
    s = DriftSettings(prior_sd_deg=3.0, max_step_deg=0.25, max_offset_deg=0.6, max_outside_deg=10.0)
    dc = DriftCorrector(s)
    t = 0.0
    for i in range(10):
        t += 1.0
        feed(dc, t, 500.0, 300.0)
        before = dc.offset.copy()
        dc.selection(500.0 + 200.0, 300.0, t, PPD, rect=key(700, 300, 20, 20))
        assert np.linalg.norm(dc.offset - before) <= 0.25 * PPD + 1e-9
    assert np.linalg.norm(dc.offset) == pytest.approx(0.6 * PPD)


def test_rate_sets_how_fast_it_adapts():
    def after(rate: float) -> float:
        dc = DriftCorrector(DriftSettings(rate_deg_per_min=rate))
        t = 0.0
        for _ in range(40):  # settle at zero first
            t += 1.5
            feed(dc, t, 500.0, 300.0)
            dc.selection(500.0, 300.0, t, PPD, rect=key(500, 300))
        for _ in range(5):  # then a sudden 20 pt drift
            t += 1.5
            feed(dc, t, 500.0, 300.0)
            dc.selection(520.0, 300.0, t, PPD, rect=key(520, 300))
        return float(dc.offset[0])

    assert after(2.0) > after(0.5) > after(0.1) > 0


# --- scoring before the update ----------------------------------------------------------------


def test_scores_are_taken_before_the_selection_updates_anything():
    dc = DriftCorrector(DriftSettings())
    feed(dc, 1.0, 500.0, 300.0)
    first = dc.selection(520.0, 300.0, 1.0, PPD, rect=key(520, 300))
    # Nothing learned yet: with and without are the same, 20 pt = 0.5 deg.
    assert first["uncorrected_deg"] == pytest.approx(0.5)
    assert first["corrected_deg"] == pytest.approx(0.5)
    learned = dc.offset.copy()
    feed(dc, 2.5, 500.0, 300.0)
    second = dc.selection(520.0, 300.0, 2.5, PPD, rect=key(520, 300))
    # The second is scored with the offset learned from the first only.
    assert second["corrected_deg"] == pytest.approx((20.0 - learned[0]) / PPD)
    assert second["uncorrected_deg"] == pytest.approx(0.5)
    st = dc.stats(PPD)
    assert st["session"]["n"] == 2 and st["recent"]["n"] == 2
    assert st["session"]["uncorrected"]["mean_deg"] == pytest.approx(0.5)
    assert st["session"]["corrected"]["mean_deg"] == pytest.approx((0.5 + second["corrected_deg"]) / 2)
    assert st["session"]["corrected"]["median_deg"] < st["session"]["uncorrected"]["median_deg"]


def test_recent_window_keeps_the_last_n():
    dc = DriftCorrector(DriftSettings(recent=3))
    t = 0.0
    for dx in (40, 40, 40, 0, 0, 0):
        t += 1.5
        feed(dc, t, 500.0, 300.0)
        dc.selection(500.0 + dx, 300.0, t, PPD, rect=key(500 + dx, 300))
    st = dc.stats(PPD)
    assert st["session"]["n"] == 6 and st["recent"]["n"] == 3
    assert st["recent"]["uncorrected"]["mean_deg"] == pytest.approx(0.0)


def test_uses_the_fixation_before_the_selection_not_the_samples_after():
    dc = DriftCorrector(DriftSettings())
    feed(dc, 5.0, 500.0, 300.0)  # the dwell: looking at the key
    dc.add_prediction(5.02, 505.0, 300.0)  # one stray sample just after the threshold
    feed(dc, 5.6, 900.0, 300.0, n=10)  # already looking elsewhere when the message arrives
    out = dc.selection(500.0, 300.0, 5.0, PPD, rect=key(500, 300))
    assert out["estimate"] == pytest.approx([500.0, 300.0])
    # A saccade landing inside the window is dropped by the fixation filter.
    dc2 = DriftCorrector(DriftSettings())
    feed(dc2, 9.5, 100.0, 100.0, n=4)
    feed(dc2, 10.0, 500.0, 300.0, n=12)
    assert dc2.selection(500.0, 300.0, 10.0, PPD)["estimate"] == pytest.approx([500.0, 300.0])


def test_no_estimate_before_the_selection_is_not_used():
    dc = DriftCorrector(DriftSettings())
    feed(dc, 1.0, 500.0, 300.0)
    out = dc.selection(500.0, 300.0, 3.0, PPD)  # nothing in [2.4, 3.0]
    assert not out["used"] and "no gaze" in out["reason"]
    assert dc.stats()["session"]["n"] == 0 and not dc.offset.any()


# --- weighting --------------------------------------------------------------------------------


def _step(rect, kind="dwell") -> float:
    dc = DriftCorrector(DriftSettings(max_step_deg=10.0, max_outside_deg=10.0))
    feed(dc, 1.0, 500.0, 300.0)
    dc.selection(510.0, 300.0, 1.0, PPD, rect=rect, kind=kind)
    return float(dc.offset[0])


def test_bigger_targets_and_clicks_are_weaker_evidence():
    small = _step(key(510, 300, 30, 30))
    large = _step(key(510, 300, 300, 30))
    unknown = _step(None)
    click = _step(key(510, 300, 30, 30), kind="click")
    assert small > large > 0
    assert small > unknown > 0
    assert small > click > 0
    # Width only weakens the horizontal axis.
    dc = DriftCorrector(DriftSettings(max_step_deg=10.0))
    feed(dc, 1.0, 500.0, 300.0)
    dc.selection(510.0, 310.0, 1.0, PPD, rect=(360.0, 290.0, 300.0, 40.0))
    assert dc.offset[1] > dc.offset[0] > 0


def test_points_per_degree_and_rect_distance():
    assert points_per_degree(SCREEN, 0.6) == pytest.approx(0.6 * 1000 * math.tan(math.radians(1)) / 0.2)
    assert points_per_degree(None, 0.6, fallback=33.0) == 33.0
    assert rect_distance(5, 5, (0, 0, 10, 10), 5, 5, 4) == 0.0
    assert rect_distance(13, 14, (0, 0, 10, 10), 5, 5, 4) == pytest.approx(5.0)
    assert rect_distance(9, 5, None, 5, 5, 4) == pytest.approx(2.0)


# --- outliers ---------------------------------------------------------------------------------


def test_far_outside_the_target_is_ignored():
    dc = DriftCorrector(DriftSettings(max_outside_deg=2.0))
    feed(dc, 1.0, 500.0, 300.0)
    out = dc.selection(800.0, 300.0, 1.0, PPD, rect=key(800, 300, 40, 40))  # 7 deg away
    assert not out["used"] and "outside" in out["reason"]
    assert not dc.offset.any() and dc.stats()["session"]["n"] == 0
    assert dc.stats()["rejected"] == {"gaze was far outside the target": 1}
    # Just outside a small key is fine (1 deg outside).
    feed(dc, 2.0, 500.0, 300.0)
    assert dc.selection(580.0, 300.0, 2.0, PPD, rect=key(580, 300, 80, 80))["used"]


def test_outlier_test_uses_the_estimate_that_was_shown():
    dc = DriftCorrector(DriftSettings(max_outside_deg=1.0))
    dc.offset = np.array([120.0, 0.0])  # 3 deg learned earlier
    feed(dc, 1.0, 500.0, 300.0)
    rect = key(620, 300, 40, 40)
    # With the correction applied the cursor was on the key: a good selection.
    assert dc.selection(620.0, 300.0, 1.0, PPD, rect=rect, applied=True)["used"]
    dc2 = DriftCorrector(DriftSettings(max_outside_deg=1.0))
    dc2.offset = np.array([120.0, 0.0])
    feed(dc2, 1.0, 500.0, 300.0)
    # Not applied: the uncorrected cursor was 2.5 deg outside it, so the user cannot have
    # selected it by looking there.
    assert not dc2.selection(620.0, 300.0, 1.0, PPD, rect=rect, applied=False)["used"]


# --- undo -------------------------------------------------------------------------------------


def test_undo_takes_back_the_step_and_the_score():
    dc = DriftCorrector(DriftSettings())
    feed(dc, 1.0, 500.0, 300.0)
    dc.selection(520.0, 300.0, 1.0, PPD, rect=key(520, 300), sel_id="s1")
    kept = dc.offset.copy()
    var = dc.var.copy()
    feed(dc, 2.5, 500.0, 300.0)
    dc.selection(560.0, 300.0, 2.5, PPD, rect=key(560, 300), sel_id="s2")  # a wrong key
    assert dc.offset[0] > kept[0]
    assert dc.undo("s2", 3.0)
    assert dc.offset == pytest.approx(kept)
    assert np.all(dc.var >= var - 1e-12)
    st = dc.stats()
    assert st["session"]["n"] == 1 and st["undone"] == 1
    assert not dc.undo("s2", 3.1)  # once only
    assert not dc.undo("nope", 3.1)


def test_undo_after_a_reset_or_too_late_keeps_the_offset():
    dc = DriftCorrector(DriftSettings(undo_window_s=10.0))
    feed(dc, 1.0, 500.0, 300.0)
    dc.selection(520.0, 300.0, 1.0, PPD, sel_id="s1")
    dc.reset("new calibration")
    assert not dc.offset.any()
    feed(dc, 2.0, 500.0, 300.0)
    dc.selection(520.0, 300.0, 2.0, PPD, sel_id="s2")
    after = dc.offset.copy()
    assert dc.undo("s1", 2.5)  # its score goes, but the new offset is not touched
    assert dc.offset == pytest.approx(after)
    assert dc.undo("s2", 30.0)  # too late to take the step back; the score still goes
    assert dc.offset == pytest.approx(after)
    assert dc.stats()["session"]["n"] == 0


# --- resets -----------------------------------------------------------------------------------


def test_reset_and_reanchor():
    dc = DriftCorrector(DriftSettings())
    t = 0.0
    for _ in range(20):
        t += 1.5
        feed(dc, t, 500.0, 300.0)
        dc.selection(520.0, 300.0, t, PPD, rect=key(520, 300))
    settled = dc.var.copy()
    off = dc.offset.copy()
    dc.reanchor("zoom changed")
    assert dc.offset == pytest.approx(off) and np.all(dc.var > settled)
    assert dc.stats()["used_since_reset"] == 20
    dc.reset("quick refine")
    st = dc.stats(PPD)
    assert not dc.offset.any() and st["used_since_reset"] == 0 and st["resets"] == 1
    assert st["last_reset_reason"] == "quick refine"
    assert st["session"]["n"] == 20  # the side-by-side numbers survive a reset
    # The prediction buffer is cleared: an old fixation cannot be used after a reset.
    assert not dc.selection(520.0, 300.0, t, PPD)["used"]


# --- simulator: a slowly creeping phone -------------------------------------------------------


def _keyboard(screen, cols=10, rows=3, w=120.0, h=100.0, gap=8.0):
    x0 = (screen.width - cols * (w + gap)) / 2
    y0 = screen.height * 0.45
    return [(x0 + c * (w + gap), y0 + r * (h + gap), w, h) for r in range(rows) for c in range(cols)]


@pytest.fixture(scope="module")
def sim_ridge():
    sim = Sim(seed=5)
    res, _ = calibrate(sim, [HOME], ("ridge",))
    return sim, res.models["ridge"]


def _typing_session(sim, model, minutes, shift_mm_per_min, tilt_deg_per_min, seed=0):
    """Type for ``minutes``: each selection is a dwell of 20 frames on a random spot of a random
    key while the phone slides and tilts at the given rates. The correction is applied (the
    outlier test sees the corrected estimate). Returns the corrector and, per selection, the TRUE
    angular error of the fixation estimate without and with the offset learned before it."""
    rng = np.random.default_rng(seed)
    keys = _keyboard(sim.screen)
    dc = DriftCorrector(DriftSettings(rate_deg_per_min=0.5))
    ppd = points_per_degree(sim.screen, 0.6)
    base = sim.rig
    t = 0.0
    err_u, err_c = [], []
    n = 0
    while t < minutes * 60:
        m = t / 60
        rig = base.bumped(rot_deg=(0.0, tilt_deg_per_min * m, 0.0), shift_m=(shift_mm_per_min * m / 1000, 0.0, 0.0))
        k = keys[rng.integers(len(keys))]
        lx, ly = k[0] + k[2] * rng.uniform(0.2, 0.8), k[1] + k[3] * rng.uniform(0.2, 0.8)
        preds = []
        for _ in range(20):
            obs, _ = sim.observe(lx, ly, HOME, rig)
            t += 1 / 30
            p = model.predict(obs)
            if p is not None and p.valid:
                dc.add_prediction(t, p.x, p.y)
                preds.append((p.x, p.y, obs))
        if preds:
            est = np.median(np.array([(a, b) for a, b, _ in preds]), axis=0)
            err_u.append(sim.angular_error(tuple(est), preds[-1][2]))
            err_c.append(sim.angular_error(tuple(est + dc.offset), preds[-1][2]))
        n += 1
        dc.selection(k[0] + k[2] / 2, k[1] + k[3] / 2, t, ppd, rect=k, sel_id=f"s{n}", applied=True)
        t += 0.8
    return dc, np.array(err_u), np.array(err_c)


@pytest.mark.slow
def test_simulated_drift_is_corrected_from_selections(sim_ridge):
    """The phone slides 3 mm and tilts 0.3 deg per minute for 4 minutes while about 160 keys
    are selected. Without correction the error grows to several degrees; with it, it stays near
    the no-drift level."""
    sim, model = sim_ridge
    dc, u, c = _typing_session(sim, model, 4.0, 3.0, 0.3)
    half = len(u) // 2
    print(f"drift: true error without {u.mean():.2f} deg (last half {u[half:].mean():.2f}), with {c.mean():.2f} (last half {c[half:].mean():.2f}), n={len(u)}")
    assert len(u) > 120
    assert u[half:].mean() > 1.5  # the injected drift really hurts
    assert c[half:].mean() < 0.5 * u[half:].mean()
    assert c.mean() < u.mean()
    # The engine's own side-by-side numbers (to key centres) say the same.
    st = dc.stats(points_per_degree(sim.screen, 0.6))
    assert st["session"]["corrected"]["mean_deg"] < st["session"]["uncorrected"]["mean_deg"] - 0.5
    assert st["rejected"] == {}


@pytest.mark.slow
def test_without_drift_the_correction_does_no_harm(sim_ridge):
    sim, model = sim_ridge
    _, u, c = _typing_session(sim, model, 3.0, 0.0, 0.0, seed=1)
    print(f"no drift: true error without {u.mean():.2f} deg, with {c.mean():.2f}, n={len(u)}")
    assert len(u) > 90
    assert c.mean() <= u.mean() + 0.1


# --- offline replay of recorded selections ----------------------------------------------------


def test_drift_replay_runs_on_and_off_from_recorded_events():
    preds = []
    events = []
    t = 100.0
    for i in range(30):
        for _ in range(15):
            t += 1 / 30
            preds.append((t, 500.0 + i, 300.0, 0.6))  # the estimate creeps 1 pt per selection
        events.append({"type": "lookpoint", "x": 540.0, "y": 300.0, "t": t, "t_local": t + 0.05, "rect": [500.0, 260.0, 80.0, 80.0], "kind": "dwell", "id": f"s{i}"})
        t += 0.5
    events.append({"type": "lookpoint", "x": 900.0, "y": 300.0, "t": t, "t_local": t, "rect": [880.0, 280.0, 40.0, 40.0], "id": "bad"})
    events.append({"type": "lookpoint.undo", "id": "s29", "t_local": t + 0.1})
    events.append({"type": "calib.finish", "kind": "validate", "t_local": t + 0.2})
    out = drift_replay(preds, events, SCREEN)
    assert out["n_lookpoints"] == 31
    for label in ("on", "off"):
        run = out[label]
        assert run["session"]["n"] == 29 and run["undone"] == 1
        assert run["session"]["corrected"]["mean_deg"] < run["session"]["uncorrected"]["mean_deg"]
    assert out["off"]["rejected"] == {"gaze was far outside the target": 1}
    text = format_drift(out)
    assert "with correction" in text and "without" in text and "applied  on" in text
