"""Tests for the switchable calibration and model options (head sweep, eyeball centre in the head
frame, eye choice, moving dot merged, quality gate, error map, weighting, hybrid, filter
presets and fixation lock). Owner: Models.

Accuracy claims are checked in the geometric test simulator (``models_sim.py``) with landmark-like
eyeball centres (``models_options.LANDMARK_NOISE``); the generating model differs from the fitted
one. ``python tests/models_options.py`` prints the full before/after tables.
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import models_options as mo  # noqa: E402
from models_sim import HOME, Noise, Sim, evaluate  # noqa: E402

from phonegaze import calibration as calib  # noqa: E402
from phonegaze.config import CalibrationConfig, Config, FiltersConfig, settings  # noqa: E402
from phonegaze.filters import PRESETS, apply_preset, build_filter  # noqa: E402
from phonegaze.models import build_models  # noqa: E402
from phonegaze.models.errormap import ErrorMap, fit_error_map  # noqa: E402
from phonegaze.models.geometric import GeometricModel  # noqa: E402
from phonegaze.models.hybrid import HybridModel, _ramp  # noqa: E402
from phonegaze.types import GazePoint, Observation, ScreenInfo  # noqa: E402

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.4, height_mm=196.4, scale=2.0, name="t", source="test")


# --- settings -------------------------------------------------------------------------------


def test_new_settings_exist_with_safe_defaults():
    paths = {s.path: s for s in settings()}
    for p in (
        "models.eyeball_centre",
        "models.eye",
        "calibration.head_sweep",
        "calibration.pursuit_merge",
        "calibration.quality_gate",
        "calibration.error_map",
        "calibration.sample_weighting",
        "calibration.layout",
        "filters.preset",
        "filters.fixation_lock",
    ):
        assert p in paths and paths[p].description
    cfg = Config()
    assert cfg.models.eyeball_centre == "estimator" and cfg.models.eye == "both"
    assert cfg.calibration.head_sweep == 0 and cfg.calibration.error_map == "off"
    assert cfg.calibration.sample_weighting == "per_dot" and cfg.calibration.layout == "grid"
    assert cfg.filters.preset == "custom" and cfg.filters.fixation_lock is False
    assert "hybrid" not in cfg.models.candidates
    geo = build_models(replace(cfg.models, eyeball_centre="head", eye="auto"))[0]
    assert geo.options["centre"] == "head" and geo.options["eye"] == "auto"


def test_layouts_and_order():
    cfg = CalibrationConfig()
    assert len(calib.config_targets(cfg, SCREEN, "grid")) == 9
    plus = calib.config_targets(replace(cfg, layout="grid_plus"), SCREEN, "grid")
    edges = calib.config_targets(replace(cfg, layout="edges"), SCREEN, "grid")
    assert len(plus) == 13 and len(edges) == 17
    rnd = calib.config_targets(replace(cfg, dot_order="random"), SCREEN, "grid", seed=3)
    assert sorted((t.x, t.y) for t in rnd) == sorted((t.x, t.y) for t in calib.grid_targets(SCREEN))
    assert [t.dot_id for t in rnd] == list(range(9))


# --- runs: sweep windows and the quality gate ------------------------------------------------


def test_sweep_run_cuts_windows_with_weight_shares():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=4)
    cfg = CalibrationConfig(head_sweep=1, sweep_window_ms=300, sweep_weight=3.0)
    run = calib.make_run(cfg, "g", "grid", calib.grid_targets(sim.screen), sim.screen)
    assert run.sweep_ids == {calib.SWEEP_DOT_BASE}
    plan = calib.plan_extras(cfg, "grid", sim.screen)
    assert len(plan["sweep"]["targets"]) == 1 and plan["sweep"]["prompts"]
    sim.sweep(calib.sweep_targets(sim.screen, 1)[0], HOME, run, seconds=6.0)
    sw = [s for s in run.samples if s.kind == "sweep"]
    windows = {s.dot_id for s in sw}
    assert 15 <= len(windows) <= 21
    assert {s.pose_group for s in sw} == {100}
    per_window = {d: np.mean([s.weight for s in sw if s.dot_id == d]) for d in windows}
    assert sum(per_window.values()) == pytest.approx(3.0)


def test_quality_gate_reshows_a_bad_dot_once_and_keeps_the_better_attempt():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=5)
    dots = calib.grid_targets(sim.screen)
    run = calib.make_run(CalibrationConfig(), "g", "grid", dots, sim.screen)
    sim.collect(dots, HOME, run=run, pose_group=0)
    # dot 4 again, but the person looks at the far corner: a far-off dot
    bad = dots[4]
    run.begin_dot(bad.dot_id, bad.x, bad.y, sim.t, pose_group=0)
    for _ in range(25):
        obs, _ = sim.observe(sim.screen.width * 0.95, sim.screen.height * 0.95, HOME)
        run.add(obs)
    run.end_dot(bad.dot_id, sim.t)
    # the earlier, good attempt is kept (the new one is no steadier) - first make the old one bad
    run2 = calib.make_run(CalibrationConfig(), "g", "grid", dots, sim.screen)
    for t in dots:
        look = (sim.screen.width * 0.95, sim.screen.height * 0.05) if t.dot_id == 4 else (t.x, t.y)
        run2.begin_dot(t.dot_id, t.x, t.y, sim.t, pose_group=0)
        for _ in range(25):
            obs, _ = sim.observe(*look, HOME)
            run2.add(obs)
        run2.end_dot(t.dot_id, sim.t)
    retry = calib.quality_gate(run2, CalibrationConfig())
    assert [d["dot_id"] for d in retry] == [4]
    sim.collect([dots[4]], HOME, run=run2, pose_group=0)
    assert calib.quality_gate(run2, CalibrationConfig()) == []  # once
    kept = [s for s in run2.samples if s.dot_id == 4]
    assert kept and all(s.target == (dots[4].x, dots[4].y) for s in kept)
    assert sum(1 for d in run2.dots if d["dot_id"] == 4 and not d.get("replaced")) == 1


# --- eyeball centre in the head frame ---------------------------------------------------------


@pytest.fixture(scope="module")
def sweep_fits():
    out = {}
    for label, sweeps, opts in (("default", 0, {}), ("per_eye", 1, {"centre": "per_eye"}), ("head", 1, {"centre": "head"}), ("auto", 1, {"centre": "auto"}), ("auto_still", 0, {"centre": "auto"})):
        sim = Sim(noise=mo.LANDMARK_NOISE, seed=1)
        samples, _ = mo.collect(sim, sweeps=sweeps)
        res = calib.fit_all(samples, sim.screen, [GeometricModel(**opts)])
        out[label] = (res, mo._score(res.models["geometric"], sim, mo._val(sim)))
    return out


def test_head_sweep_with_head_frame_centres_copes_with_head_turns(sweep_fits):
    base = sweep_fits["default"][1]
    for label in ("per_eye", "head"):
        res, sc = sweep_fits[label]
        geo = res.models["geometric"]
        assert geo.multi_pose  # the sweep's head rotation frees the per-eye centres
        assert sc["turned"] < 0.8 * base["turned"], (label, sc, base)
        assert sc["moved"] < 0.9 * base["moved"], (label, sc, base)
        assert sc["still"] < base["still"] + 0.5, (label, sc, base)
        summ = geo.summary()
        assert summ["eyeball_centre"] == label and len(summ["centre_right_mm"]) == 3


def test_auto_centre_uses_the_head_frame_only_when_the_head_moved(sweep_fits):
    assert sweep_fits["auto"][0].models["geometric"].centre_used == "head"
    assert sweep_fits["auto"][1] == pytest.approx(sweep_fits["head"][1])
    still = sweep_fits["auto_still"][0].models["geometric"]
    assert still.centre_used == "estimator" and still.summary()["eyeball_centre"] == "estimator"
    assert sweep_fits["auto_still"][1] == pytest.approx(sweep_fits["default"][1])


def test_head_frame_centres_save_and_load(sweep_fits, tmp_path):
    res, _ = sweep_fits["head"]
    geo = res.models["geometric"]
    again = GeometricModel.from_dict(json.loads(json.dumps(geo.to_dict())))
    obs = mo.Sim(noise=mo.LANDMARK_NOISE, seed=9).observe(700, 400, HOME)[0]
    a, b = geo.predict_raw(obs), again.predict_raw(obs)
    assert (a.x, a.y) == pytest.approx((b.x, b.y))
    # profiles saved before the per-eye centres existed (10 person parameters) still load
    prof = calib.Profile(tmp_path)
    prof.save(res, SCREEN)
    person = json.loads((tmp_path / "person.json").read_text())
    person["geometric"]["params"] = person["geometric"]["params"][:10]
    (tmp_path / "person.json").write_text(json.dumps(person))
    (tmp_path / "session.json").unlink()
    loaded = calib.Profile(tmp_path).load()
    assert loaded is not None and len(loaded.models["geometric"].params) == 22
    assert loaded.models["geometric"].predict_raw(obs) is not None


# --- eye choice -------------------------------------------------------------------------------


def test_eye_auto_picks_a_better_eye_setting_and_reports_per_eye_scores():
    # the left eye tracks badly: a gaze-dependent, non-linear iris error of up to 20 px
    sim = Sim(noise=Noise(eye_warp_px=(0.0, 20.0)), seed=2)
    samples, _ = mo.collect(sim)
    res = calib.fit_all(samples, sim.screen, [GeometricModel(eye="auto")])
    rep = res.reports[0]
    scores = rep.params["eye_loo_deg"]
    assert set(scores) == {"both", "left", "right", "weighted"}
    assert scores["right"] < scores["left"]
    geo = res.models["geometric"]
    assert geo.eye_use in ("right", "weighted") and rep.params["eye_used"] == geo.eye_use
    if geo.eye_use == "weighted":
        assert geo.eye_weights["right"] > geo.eye_weights["left"]
    val = sim.validation_samples(12, HOME)
    both = calib.fit_all(samples, sim.screen, [GeometricModel()]).models["geometric"]
    assert evaluate(geo, sim, val)["deg"] < evaluate(both, sim, val)["deg"]
    again = GeometricModel.from_dict(json.loads(json.dumps(geo.to_dict())))
    assert again.eye_use == geo.eye_use and again.eye_weights == pytest.approx(geo.eye_weights)
    # a fixed single eye predicts from that eye only
    left = calib.fit_all(samples, sim.screen, [GeometricModel(eye="left")]).models["geometric"]
    p = left.predict(val[0].obs)
    assert p.right is None and p.left is not None


# --- moving dot ---------------------------------------------------------------------------------


def test_moving_dot_lag_is_estimated_and_saccades_dropped():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=3)
    cfg = CalibrationConfig()
    samples, ps = mo.collect(sim, pursuit=True, cfg=cfg)
    res = calib.fit_all(samples, sim.screen, [GeometricModel()])
    prepped, info = calib.prepare_pursuit(ps, res.models["geometric"], sim.screen, cfg)
    assert 80 <= info["lag_ms"] <= 170  # the simulated eyes trail by 120 ms (plus catch-ups)
    assert info["median_error_deg_after"] < info["median_error_deg_before"]
    assert info["dropped_saccade"] > 0 and 0.5 * len(ps) < len(prepped) < len(ps)
    assert all(s.dot_id >= calib.PURSUIT_SAMPLE_BASE for s in prepped)
    fixed, info2 = calib.prepare_pursuit(ps, res.models["geometric"], sim.screen, replace(cfg, pursuit_lag_ms=0.0))
    assert info2["lag_ms"] == 0.0 and not info2["lag_estimated"]


def test_moving_dot_merge_auto_never_worsens_the_grid_heldout_score():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=1)
    cfg = CalibrationConfig(pursuit_merge="auto")
    samples, ps = mo.collect(sim, pursuit=True, cfg=cfg)
    res = calib.fit_with_options(samples, sim.screen, mo.geo_factory(), cfg, pursuit=ps)
    p = res.info["pursuit"]
    assert p["merged"] == (p["grid_heldout_deg_with"] < p["grid_heldout_deg_without"])
    chosen = next(r for r in res.reports if r.model == res.chosen)
    assert chosen.params["selection_error_deg"] <= p["grid_heldout_deg_without"] + 1e-9


# --- error map ---------------------------------------------------------------------------------


def test_error_map_fixes_a_smooth_distortion_and_is_dropped_on_noise():
    rng = np.random.default_rng(0)
    size = (1512.0, 982.0)
    tgt = np.stack([rng.uniform(100, 1400, 16), rng.uniform(80, 900, 16)], axis=1)
    u = (tgt - np.array(size) / 2) / 1512
    warp = np.stack([40 * u[:, 0] ** 2 + 30 * u[:, 1], -25 * u[:, 0] * u[:, 1] + 20], axis=1) * 1512 / 100
    pred = tgt - warp + rng.normal(0, 3, tgt.shape)
    for kind in ("affine", "quadratic", "tps"):
        m, info = fit_error_map(pred, tgt, size, kind)
        assert m is not None and info["loo_after_pt"] < 0.7 * info["loo_before_pt"], (kind, info)
        assert np.mean(np.linalg.norm(m.apply_many(pred) - tgt, axis=1)) < np.mean(np.linalg.norm(pred - tgt, axis=1))
        back = ErrorMap.from_dict(json.loads(json.dumps(m.to_dict())))
        assert back.apply(700, 400) == pytest.approx(m.apply(700, 400))
    noisy = tgt + rng.normal(0, 15, tgt.shape)
    m, info = fit_error_map(noisy, tgt, size, "tps")
    assert m is None and not info["kept"]


def test_validation_error_map_on_a_model_is_guarded_and_persisted():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=1)
    samples, _ = mo.collect(sim)
    geo = calib.fit_all(samples, sim.screen, [GeometricModel()]).models["geometric"]
    val = sim.validation_samples(12, HOME, seed=101)
    # a smooth output distortion the model cannot know about: the map must learn it
    from phonegaze.models.base import Correction

    geo.correction = Correction(a=np.array([[1.06, 0.02], [0.0, 0.95]]), b=np.array([25.0, -15.0]))
    before = evaluate(geo, sim, sim.validation_samples(12, HOME, seed=55))["deg"]
    info = calib.fit_validation_error_map(geo, val, sim.screen, CalibrationConfig(error_map="affine"))
    assert info["kept"] and geo.error_map is not None
    after = evaluate(geo, sim, sim.validation_samples(12, HOME, seed=55))["deg"]
    assert after < before - 0.3
    again = GeometricModel.from_dict(json.loads(json.dumps(geo.to_dict())))
    assert again.error_map is not None
    off = calib.fit_validation_error_map(geo, val, sim.screen, CalibrationConfig(error_map="off"))
    assert off["kept"] is False and geo.error_map is None
    pooled = calib.pool_validation(val, val)
    assert len({s.dot_id for s in pooled}) == 2 * len({s.dot_id for s in val})
    top = calib.touchup_targets({"per_dot": [{"target": [1, 2], "error_deg": 1.0}, {"target": [3, 4], "error_deg": 3.0}]}, 1)
    assert [(t.x, t.y) for t in top] == [(3.0, 4.0)]


# --- weighting ---------------------------------------------------------------------------------


def test_sample_weighting_modes():
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=1)
    samples, _ = mo.collect(sim)
    same = calib.weight_samples(samples, "per_dot")
    assert all(s.weight == 1.0 for s in same)
    prec = calib.weight_samples(samples, "precision")
    w = {s.dot_id: s.weight for s in prec}
    assert all(0.25 <= v <= 3.0 for v in w.values()) and len(set(np.round(list(w.values()), 6))) > 1
    per = calib.weight_samples(samples, "per_sample")
    assert all(0.25 <= s.weight <= 4.0 for s in per)


# --- hybrid ---------------------------------------------------------------------------------------


def test_hybrid_leans_on_the_reflection_only_when_it_is_detected():
    assert _ramp(0.2, 0.3, 0.7) == 0.0 and _ramp(0.8, 0.3, 0.7) == 1.0 and 0 < _ramp(0.5, 0.3, 0.7) < 1
    sim = Sim(noise=mo.LANDMARK_NOISE, seed=1)
    samples, _ = mo.collect(sim)
    from phonegaze.models import REGISTRY

    res = calib.fit_all(samples, sim.screen, [REGISTRY[n]() for n in ("geometric", "reflection", "hybrid")])
    hyb = res.models["hybrid"]
    assert isinstance(hyb, HybridModel) and hyb.fitted and set(hyb.weights) == {"geometric", "reflection"}
    obs = sim.observe(700, 400, HOME)[0]
    for side in ("left", "right"):
        obs.eye(side).reflection_center = None
    p, g = hyb.predict_raw(obs), res.models["geometric"].predict_raw(obs)
    assert (p.x, p.y) == pytest.approx((g.x, g.y)) and p.extra["reflection_factor"] == 0.0
    rep = next(r for r in res.reports if r.model == "hybrid")
    assert rep.loo_error_deg is not None


# --- filters ---------------------------------------------------------------------------------------


def _trace(f, pts, dt=1 / 30):
    out = []
    for i, (x, y) in enumerate(pts):
        o = Observation(seq=i, t=i * dt, t_local=i * dt)
        out.append(f.update(GazePoint(x=x, y=y, t=i * dt, confidence=1.0), o))
    return out


def test_filter_presets_override_and_custom_keeps_settings():
    base = FiltersConfig(min_cutoff=3.3)
    assert apply_preset(base).min_cutoff == 3.3
    for name, over in PRESETS.items():
        c = apply_preset(replace(base, preset=name))
        assert all(getattr(c, k) == v for k, v in over.items())
    rng = np.random.default_rng(0)
    pts = [(700 + rng.normal(0, 10), 400 + rng.normal(0, 10)) for _ in range(90)]
    jit = {}
    for name in ("responsive", "steady"):
        out = _trace(build_filter(replace(base, preset=name)), pts)
        xy = np.array([[p.x, p.y] for p in out[30:]])
        jit[name] = float(np.mean(np.linalg.norm(np.diff(xy, axis=0), axis=1)))
    assert jit["steady"] < jit["responsive"]


def test_fixation_lock_holds_still_then_follows_a_saccade():
    rng = np.random.default_rng(1)
    fix1 = [(700 + rng.normal(0, 8), 400 + rng.normal(0, 8)) for _ in range(40)]
    fix2 = [(1100 + rng.normal(0, 8), 600 + rng.normal(0, 8)) for _ in range(40)]
    out = _trace(build_filter(FiltersConfig(fixation_lock=True)), fix1 + fix2)
    locked = [p for p in out[:40] if p.extra.get("locked")]
    assert len(locked) > 20 and len({(p.x, p.y) for p in locked}) == 1
    assert abs(out[-1].x - 1100) < 40 and abs(out[-1].y - 600) < 40
    unlocked = _trace(build_filter(FiltersConfig()), fix1)
    assert not any(p.extra.get("locked") for p in unlocked)


# --- the phonegaze.sim loop ---------------------------------------------------------------------


def test_sim_loop_head_sweep_with_head_frame_centres():
    """SimScene + oracle + eyeball centres from the eye corners as the landmarks estimator makes
    them: the grid-only geometric model degrades when the head moves; a head sweep with the
    ``head`` centre mode holds up."""
    import models_simloop as ml

    r = ml.rows(seed=1, configs=[("default", 0, {}), ("head", 1, {"centre": "head"})])
    assert r["default"]["turned"] > 2.0 * r["default"]["still"]
    assert r["head"]["turned"] < 0.5 * r["default"]["turned"]
    assert r["head"]["moved"] < 0.5 * r["default"]["moved"]
    assert r["head"]["still"] < r["default"]["still"] + 0.3
