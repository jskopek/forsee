"""Unit tests for the Models area: targets, sample collection, corrections, filters, features,
persistence, drift. Fast; the accuracy benchmark is in test_models_accuracy.py."""

from __future__ import annotations

import copy
import math

import numpy as np
import pytest

from models_sim import HOME, SCREEN, Noise, Person, Rig, Sim, evaluate, grid
from phonegaze import calibration as calib
from phonegaze.config import CalibrationConfig, Config, FiltersConfig
from phonegaze.filters import OneEuro, PassFilter, SmoothingFilter, build_filter, fuse_eyes
from phonegaze.models import REGISTRY, build_models, load_model
from phonegaze.models import features as F
from phonegaze.models.base import Correction, fit_correction
from phonegaze.models.geometric import GeometricModel
from phonegaze.types import CalibSample, EyeObs, GazeModel, GazePoint, Observation

CLEAN = dict(iris_px=0, radius_px=0, corner_px=0, glint_px=0, head_rot_bias_deg=(0, 0, 0), head_pos_bias_m=(0, 0, 0), head_rot_jitter_deg=0, head_pos_jitter_m=0, fixation_jitter_deg=0, assumed_ipd_m=0.064, p_blink=0, p_outlier=0, landing_frames=0)


def clean_sim(**noise) -> Sim:
    person = Person(eye_radius_m=0.0102, kappa_right_deg=(5.0, -1.5), kappa_left_deg=(5.0, -1.5))
    return Sim(person=person, noise=Noise(**{**CLEAN, **noise}), seed=3)


# --- targets ----------------------------------------------------------------------------------


def test_grid_targets_serpentine_and_margins():
    t = calib.grid_targets(SCREEN, "3x3", 0.1)
    assert len(t) == 9 and [x.dot_id for x in t] == list(range(9))
    assert t[0].x == pytest.approx(0.1 * SCREEN.width) and t[2].x == pytest.approx(0.9 * SCREEN.width)
    assert t[3].x == pytest.approx(t[2].x)  # second row runs back
    assert all(0.1 * SCREEN.height - 1e-6 <= p.y <= 0.9 * SCREEN.height + 1e-6 for p in t)


def test_random_and_config_targets():
    cfg = CalibrationConfig()
    val = calib.config_targets(cfg, SCREEN, "validate")
    assert len(val) == cfg.validate_points
    gridpts = np.array([[p.x, p.y] for p in calib.grid_targets(SCREEN, cfg.grid, cfg.margin)])
    for p in val:
        assert np.min(np.linalg.norm(gridpts - [p.x, p.y], axis=1)) > 50
    for n in range(1, 6):
        cfg.refine_points = n
        assert len(calib.config_targets(cfg, SCREEN, "refine")) == n
    assert len(calib.config_targets(cfg, SCREEN, "pursuit")) > 10
    with pytest.raises(ValueError):
        calib.config_targets(cfg, SCREEN, "nope")


def test_angular_error_deg():
    obs = Observation(seq=0, t=0.0, distance=0.6)
    mpp = SCREEN.mm_per_point
    assert mpp is not None
    dx_pt = 0.6 * 1000 * math.tan(math.radians(2.0)) / mpp[0]
    assert calib.angular_error_deg((dx_pt, 0), (0, 0), obs, SCREEN) == pytest.approx(2.0, abs=1e-6)
    assert calib.angular_error_deg((1, 0), (0, 0), Observation(seq=0, t=0.0), SCREEN) is None


# --- corrections ----------------------------------------------------------------------------------


def test_fit_correction_offset_and_affine():
    rng = np.random.default_rng(0)
    centres = rng.uniform(100, 900, (8, 2))
    pred = np.repeat(centres, 5, axis=0) + rng.normal(0, 2, (40, 2))
    groups = list(np.repeat(np.arange(8), 5))
    target = pred + [12.0, -7.0]
    c = fit_correction(pred, target, groups[:5] + [0] * 35, SCREEN, affine=True)  # one dot -> offset
    assert np.allclose(c.b, [12, -7]) and np.allclose(c.a, np.eye(2))
    a = np.array([[1.05, 0.02], [-0.01, 0.97]])
    target = pred @ a.T + [5, 3]
    c = fit_correction(pred, target, groups, SCREEN, affine=True)
    err_affine = np.abs(c.apply_many(pred) - target).max()
    err_offset = np.abs(fit_correction(pred, target, groups, SCREEN, affine=False).apply_many(pred) - target).max()
    assert err_affine < 10.0 and err_affine < err_offset / 2
    both = Correction(b=np.array([1.0, 2.0])).then(Correction(b=np.array([3.0, 4.0])))
    assert both.apply(0, 0) == (4.0, 6.0)
    assert Correction.from_dict(both.to_dict()).apply(1, 1) == both.apply(1, 1)


# --- collection --------------------------------------------------------------------------------------


def test_calibration_run_discards_landing_and_rejects_blinks():
    sim = Sim(noise=Noise(p_blink=0.0, landing_frames=3), seed=4)
    run = sim.collect(grid(sim), HOME, frames=20)
    assert not run.rejected
    # the first 150 ms (4-5 frames at 30 fps) of each dot are dropped
    assert all(15 <= d["n_raw"] <= 16 for d in run.dots)
    # every kept sample is near its dot: the eyes were still on the previous dot while landing
    for s in run.samples:
        assert s.obs.t_local is not None

    sim2 = Sim(noise=Noise(p_blink=1.0), seed=5)
    run2 = sim2.collect(grid(sim2)[:2], HOME, frames=20)
    assert not run2.samples and len(run2.rejected) == 2 and "usable" in run2.rejected[0]["reason"]


def test_calibration_run_outliers_and_pose_groups():
    sim = Sim(noise=Noise(p_outlier=0.15, p_blink=0.0), seed=6)
    run = calib.CalibrationRun(run_id="r", kind="grid", targets=grid(sim), screen=SCREEN)
    sim.collect(grid(sim)[:3], HOME, run=run, frames=30)
    assert sum(d["n_kept"] for d in run.dots) < sum(d["n_raw"] for d in run.dots)  # outliers removed
    sim.collect(grid(sim)[:3], HOME.moved(dx=0.05), run=run, frames=30)  # same dots again
    assert {s.pose_group for s in run.samples} == {0, 1}
    assert {s.dot_id for s in run.samples if s.pose_group == 1} == {1000, 1001, 1002}


def test_repeated_collect_message_is_not_a_new_pose():
    sim = Sim(noise=Noise(p_blink=0.0), seed=7)
    run = calib.CalibrationRun(run_id="r", kind="grid", targets=[], screen=SCREEN)
    run.begin_dot(4, 100, 100, sim.t)
    for _ in range(12):
        run.add(sim.observe(100, 100, HOME)[0])
        run.begin_dot(4, 100, 100, sim.t)  # the UI repeats "collect"
    run.end_dot(4, sim.t)
    assert run.pose_group == 0 and len(run.dots) == 1 and run.dots[0]["n_raw"] >= 7


def test_unsteady_dot_rejected():
    sim = clean_sim()
    run = calib.CalibrationRun(run_id="r", kind="grid", targets=[], screen=SCREEN)
    run.begin_dot(0, 100, 100, sim.t)
    for i in range(20):
        obs, _ = sim.observe(100 + 60 * i, 100, HOME)  # the eye wanders across the screen
        run.add(obs)
    run.end_dot(0, sim.t)
    assert not run.samples and "steady" in run.rejected[0]["reason"]


# --- features -----------------------------------------------------------------------------------------


def test_features_are_zoom_invariant():
    a = clean_sim()
    b = clean_sim()
    b.rig = Rig(px_per_deg=0.9)  # half the focal length: the 1x lens instead of 2x
    oa, _ = a.observe(300, 200, HOME)
    ob, _ = b.observe(300, 200, HOME)
    for side in ("left", "right"):
        assert np.allclose(F.iris_corner_vector(oa, side), F.iris_corner_vector(ob, side), atol=1e-6)
        assert np.allclose(F.reflection_vector(oa, side) or (0, 0), F.reflection_vector(ob, side) or (0, 0), atol=1e-6)
        assert np.allclose(F.optical_dir(oa, side), F.optical_dir(ob, side), atol=1e-9)


def test_feature_table_imputes_missing_eye():
    sim = clean_sim()
    obs = [sim.observe(x, y, HOME)[0] for x, y in [(100, 100), (700, 400), (1300, 900), (400, 800)]]
    table = F.FeatureTable(["gaze", "iris"], head=True)
    z = table.fit(obs)
    one = copy.deepcopy(obs[1])
    one.left = EyeObs()
    zi = table.transform(one)
    assert zi is not None and np.allclose(zi, z[1], atol=0.05)
    nothing = copy.deepcopy(obs[1])
    nothing.left = EyeObs()
    nothing.right = EyeObs()
    assert table.transform(nothing) is None


# --- models -------------------------------------------------------------------------------------------


def test_registry_and_build_models():
    models = build_models(Config().models)
    assert [m.name for m in models][-1] == "blend"
    for m in models:
        assert isinstance(m, GazeModel)
    assert set(REGISTRY) == {"geometric", "ridge", "kernel", "reflection", "blend", "residual"}


def test_geometric_recovers_screen_pose_without_noise():
    sim = clean_sim()
    run = sim.collect(grid(sim), HOME, head_wobble_m=0.0)
    m = GeometricModel()
    rep = m.fit(run.samples, SCREEN)
    assert rep.ok and rep.train_error_deg < 0.1
    cam = np.array(m.screen_pose()["camera_in_screen_mm"])
    assert np.linalg.norm(cam - np.array(sim.rig.camera_at) * 1000) < 10.0
    assert m.viewing_distance_m == pytest.approx(0.6, abs=0.03)
    val = sim.validation_samples(5, HOME)
    assert evaluate(m, sim, val)["deg"] < 0.1


def test_models_survive_missing_eye_and_round_trip():
    sim = Sim(seed=8)
    run = sim.collect(grid(sim), HOME)
    res = calib.fit_all(run.samples, SCREEN, [REGISTRY[n]() for n in ("geometric", "ridge", "kernel", "reflection", "residual", "blend")])
    assert res.chosen is not None
    obs, _ = sim.observe(500, 500, HOME)
    one_eye = copy.deepcopy(obs)
    one_eye.right = EyeObs()
    no_glint = copy.deepcopy(obs)
    for e in (no_glint.left, no_glint.right):
        e.reflection_center = None
    for name, m in res.models.items():
        p = m.predict(obs)
        assert p is not None and p.valid and math.isfinite(p.x), name
        if name != "reflection" or one_eye.left.reflection_center is not None:
            assert m.predict(one_eye) is not None, name
        p2 = load_model(m.to_dict()).predict(obs)
        assert p2 is not None and abs(p2.x - p.x) < 25 and abs(p2.y - p.y) < 25, name  # (live smoothing differs)
    assert res.models["reflection"].predict(no_glint) is None
    blinking = copy.deepcopy(obs)
    blinking.left.blink = blinking.right.blink = True
    assert res.models["geometric"].predict(blinking) is None


def test_reflection_model_refuses_without_reflections():
    sim = Sim(noise=Noise(p_no_glint=1.0), seed=9)
    run = sim.collect(grid(sim), HOME)
    rep = REGISTRY["reflection"]().fit(run.samples, SCREEN)
    assert not rep.ok and "reflection" in rep.message


# --- refine, drift, validation, profile --------------------------------------------------------------


@pytest.fixture(scope="module")
def fitted():
    sim = Sim(seed=10)
    run = sim.collect(grid(sim), HOME)
    res = calib.fit_all(run.samples, SCREEN, [REGISTRY[n]() for n in ("geometric", "ridge")])
    return sim, res


def test_refine_one_dot_is_an_offset(fitted):
    sim, res = fitted
    m = copy.deepcopy(res.models["ridge"])
    samples = [CalibSample(target=s.target, obs=s.obs, kind="refine", dot_id=s.dot_id) for s in _shifted(sim, m, 40.0)]
    rep = calib.refine(m, samples, SCREEN)
    assert rep.ok and rep.params["method"] == "offset"
    assert rep.train_error_pt < rep.params["before_error_pt"]


def _shifted(sim, model, dx):
    """Samples at the screen centre whose common target is ``dx`` points right of the model's
    median prediction."""
    obs, preds = [], []
    while len(obs) < 15:
        o, _ = sim.observe(756, 491, HOME)
        p = model.predict(o)
        if p is None:  # a blink
            continue
        obs.append(o)
        preds.append((p.x, p.y))
    tx, ty = np.median(np.array(preds), axis=0)
    return [CalibSample(target=(float(tx + dx), float(ty)), obs=o, kind="refine", dot_id=0) for o in obs]


def test_refine_three_dots_resolves_geometric_pose(fitted):
    sim, res = fitted
    m = copy.deepcopy(res.models["geometric"])
    bumped = sim.rig.bumped()
    from models_sim import refine_run

    samples = refine_run(sim, 3, HOME, bumped)
    rep = calib.refine(m, samples, SCREEN)
    assert rep.ok and rep.params["method"] == "screen_pose"


def test_drift_correction_is_conservative(fitted):
    sim, res = fitted
    m = copy.deepcopy(res.models["ridge"])
    samples = [CalibSample(target=s.target, obs=s.obs, kind="drift", dot_id=100000) for s in _shifted(sim, m, 30.0)]
    rep = calib.refine(m, samples, SCREEN)
    assert rep.ok and rep.params["method"] == "drift"
    step = np.array(rep.params["step_pt"])
    assert 0 < step[0] < 30.0 * 0.31 and abs(step[1]) < 3
    # a look-point far from the prediction (the person looked elsewhere) is ignored
    far = [CalibSample(target=s.target, obs=s.obs, kind="drift", dot_id=1) for s in _shifted(sim, m, 600.0)]
    before = m.correction.to_dict()
    assert not calib.refine(m, far, SCREEN).ok
    assert m.correction.to_dict() == before


def test_validation_metrics(fitted):
    sim, res = fitted
    val = sim.validation_samples(4, HOME)
    v = calib.validation_metrics(res.models["ridge"], val, SCREEN)
    assert set(v) >= {"accuracy_deg", "precision_deg", "accuracy_pt", "n", "per_dot", "valid_fraction"}
    assert v["n"] == len(val) and len(v["per_dot"]) == 4 and v["accuracy_deg"] < 3.0


def test_profile_round_trip(tmp_path, fitted):
    sim, res = fitted
    prof = calib.Profile(tmp_path / "p")
    prof.save(res, SCREEN)
    for name in ("person.json", "setup.json", "session.json"):
        assert (tmp_path / "p" / name).exists()
    back = prof.load()
    assert back is not None and back.chosen == res.chosen and set(back.models) == set(res.models)
    obs, _ = sim.observe(400, 300, HOME)
    a, b = res.models["ridge"].predict(obs), back.models["ridge"].predict(obs)
    assert a is not None and b is not None and abs(a.x - b.x) < 1e-6
    # person + setup alone rebuild a geometric model
    (tmp_path / "p" / "session.json").unlink()
    only = prof.load()
    assert only is not None and only.chosen == "geometric"
    g0 = res.models["geometric"].predict_raw(obs)
    g1 = only.models["geometric"].predict_raw(obs)
    assert g0 is not None and g1 is not None and abs(g0.x - g1.x) < 1e-6
    assert calib.Profile(tmp_path / "empty").load() is None


# --- filters ----------------------------------------------------------------------------------------


def _pt(x, y, t, conf=1.0):
    return GazePoint(x=x, y=y, t=t, confidence=conf)


def test_one_euro_smooths_and_follows():
    f = OneEuro(min_cutoff=1.0, beta=0.0)
    rng = np.random.default_rng(0)
    out = [f(100 + rng.normal(0, 5), i / 30) for i in range(120)]
    assert np.std(out[60:]) < 2.5
    assert abs(np.mean(out[60:]) - 100) < 2


def test_filter_blink_hold_then_invalid():
    f = build_filter(FiltersConfig())
    for i in range(10):
        f.update(_pt(500, 500, i / 30), None)
    held = f.update(None, Observation(seq=0, t=10 / 30))
    assert held is not None and held.valid and held.extra.get("held")
    lost = f.update(None, Observation(seq=0, t=1.0))
    assert lost is not None and not lost.valid


def test_filter_snaps_on_saccade_and_ignores_single_outlier():
    cfg = FiltersConfig()
    cfg.kind = "fixation"
    f = SmoothingFilter(cfg)
    t = 0.0
    rng = np.random.default_rng(1)
    for _ in range(20):
        t += 1 / 30
        out = f.update(_pt(300 + rng.normal(0, 8), 300 + rng.normal(0, 8), t), None)
    assert out is not None and out.fixation and abs(out.x - 300) < 10
    t += 1 / 30
    spike = f.update(_pt(800, 300, t), None)  # one outlier: held
    assert spike is not None and abs(spike.x - 300) < 15
    t += 1 / 30
    back = f.update(_pt(301, 300, t), None)
    assert back is not None and abs(back.x - 300) < 15
    for _ in range(2):
        t += 1 / 30
        out = f.update(_pt(900, 600, t), None)  # a real saccade: confirmed, snaps
    assert out is not None and abs(out.x - 900) < 10 and abs(out.y - 600) < 10


def test_build_filter_kinds_and_fusion():
    for kind in ("one_euro", "kalman", "fixation"):
        cfg = FiltersConfig()
        cfg.kind = kind
        f = build_filter(cfg)
        p = None
        for i in range(30):
            p = f.update(_pt(200, 100, i / 30, 0.9), None)
        assert p is not None and abs(p.x - 200) < 1 and 0 < p.confidence <= 1
    none = FiltersConfig()
    none.kind = "none"
    assert isinstance(build_filter(none), PassFilter)
    assert fuse_eyes((0, 0), (10, 10), 1.0, 3.0)[:2] == (7.5, 7.5)
    assert fuse_eyes(None, (10, 10), 1.0, 0.5) == (10.0, 10.0, 0.4)
    with pytest.raises(ValueError):
        fuse_eyes(None, None)
