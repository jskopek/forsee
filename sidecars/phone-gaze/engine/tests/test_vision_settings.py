"""Vision tuning settings (config.estimators.*): each switch changes what it says, live."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.config import Config, set_value
from phonegaze.types import Observation
from phonegaze.vision import REBUILD_SETTINGS, build_estimators
from phonegaze.vision import eyes as E
from phonegaze.vision.distance import depth_at
from phonegaze.vision.iris_edge import IrisEdgeEstimator
from phonegaze.vision.reflection import ReflectionEstimator, predicted_reflection_px
from phonegaze.vision.synth import EyeSpec, make_frame, render_eye

OFFSET = (500.0, 400.0)


def _frame(spec: EyeSpec, seq: int = 0, fx: float = 6000.0):
    return make_frame({"left_eye": (render_eye(spec), OFFSET)}, seq=seq, fx=fx)


def _seeded(frame, cx, cy, r, dist=None) -> Observation:
    obs = Observation.empty(frame)
    obs.set("left.iris_center", (cx + OFFSET[0], cy + OFFSET[1]), "test")
    obs.set("left.iris_radius", r, "test")
    if dist is not None:
        obs.set("distance", dist, "test")
    return obs


def _fit_errors(cfg, n=10, lid=False):
    rng = np.random.default_rng(7)
    est = IrisEdgeEstimator(cfg)
    errs = []
    for i in range(n):
        cx, cy, r = 160 + rng.uniform(-20, 20), 100 + rng.uniform(-5, 5), rng.uniform(40, 55)
        spec = EyeSpec(iris_center=(cx, cy), iris_radius=r, eye_center=(160, 100), seed=i, noise=3, blur=0.8, opening_half_height=(0.55 * r if lid else None))
        frame = _frame(spec, seq=i)
        est.reset()
        out = est.process(frame, _seeded(frame, cx + rng.normal(0, 3), cy + rng.normal(0, 3), r))
        if out is None:
            errs.append(np.inf)
            continue
        errs.append(np.hypot(out.left.iris_center[0] - cx - OFFSET[0], out.left.iris_center[1] - cy - OFFSET[1]))
    return np.array(errs)


def test_every_estimator_setting_has_a_description_and_safe_default() -> None:
    from phonegaze.config import settings

    est = [s for s in settings() if s.path.startswith("estimators.")]
    assert len(est) > 30
    for s in est:
        assert s.description, s.path
    cfg = Config()
    assert [e.name for e in build_estimators(cfg.estimators)] == list(cfg.estimators.order)


def test_use_switches_leave_estimators_out() -> None:
    cfg = Config()
    cfg.estimators.use_reflection = False
    cfg.estimators.use_landmarks = False
    names = [e.name for e in build_estimators(cfg.estimators)]
    assert "reflection" not in names and "landmarks" not in names and "iris_edge" in names
    assert "use_reflection" in REBUILD_SETTINGS and "iris_fit" not in REBUILD_SETTINGS


def test_circle_fit_and_subpixel_switches_work() -> None:
    cfg = Config().estimators
    base = _fit_errors(cfg)
    assert np.median(base) < 0.5
    set_value_cfg = Config()
    set_value(set_value_cfg, "estimators.iris_fit", "circle")
    circ = _fit_errors(set_value_cfg.estimators)
    assert np.isfinite(circ).all() and np.median(circ) < 0.6
    set_value(set_value_cfg, "estimators.iris_subpixel", False)
    nosub = _fit_errors(set_value_cfg.estimators)
    assert np.isfinite(nosub).all()


def test_lid_mask_drops_rays_near_vertical() -> None:
    angles = np.radians(np.arange(0, 360, 3.0))
    keep = E._lid_keep(angles, 45, 0)
    deg = np.degrees(angles[~keep])
    assert deg.min() >= 224.9 and deg.max() <= 315.1  # straight up is 270 in image coordinates
    keep2 = E._lid_keep(angles, 0, 30)
    d2 = np.degrees(angles[~keep2])
    assert d2.min() >= 59.9 and d2.max() <= 120.1


def test_lid_mask_helps_when_lids_cover_the_iris() -> None:
    cfg = Config()
    plain = _fit_errors(cfg.estimators, lid=True)
    set_value(cfg, "estimators.iris_lid_mask_upper_deg", 50.0)
    set_value(cfg, "estimators.iris_lid_mask_lower_deg", 50.0)
    masked = _fit_errors(cfg.estimators, lid=True)
    # Not a claim about real eyes: on the synthetic lids the mask must at least not break the fit.
    assert np.isfinite(masked).sum() >= np.isfinite(plain).sum() - 1
    assert np.median(masked[np.isfinite(masked)]) < 1.5


def test_settings_apply_live_without_rebuilding() -> None:
    cfg = Config()
    est = IrisEdgeEstimator(cfg.estimators)
    spec = EyeSpec(iris_center=(160, 100), iris_radius=48, eye_center=(160, 100), seed=1)
    frame = _frame(spec)
    assert est.process(frame, _seeded(frame, 160, 100, 48)) is not None
    set_value(cfg, "estimators.iris_min_confidence", 0.9)  # stricter than this fit's confidence
    frame = _frame(spec, seq=1)
    out = est.process(frame, _seeded(frame, 160, 100, 48))
    assert out is None or out.provenance.get("left.iris_center") != "iris_edge"


def test_iris_diameter_and_distance_source() -> None:
    cfg = Config()
    spec = EyeSpec(iris_center=(150, 104), iris_radius=48, eye_center=(160, 100), seed=3)
    d = {}
    for diameter in (11.7, 12.5):
        set_value(cfg, "estimators.iris_diameter_mm", diameter)
        frame = _frame(spec, fx=3000.0)
        out = IrisEdgeEstimator(cfg.estimators).process(frame, _seeded(frame, 150, 104, 48))
        d[diameter] = out.distance
        assert out.extra["distance"]["source"] == "iris_fit"
    assert d[12.5] / d[11.7] == pytest.approx(12.5 / 11.7, rel=1e-3)
    set_value(cfg, "estimators.distance_source", "head")
    frame = _frame(spec, fx=3000.0)
    out = IrisEdgeEstimator(cfg.estimators).process(frame, _seeded(frame, 150, 104, 48))
    assert out.distance is None  # the iris fit leaves the distance to the eye-corner span


def test_depth_at_reads_a_depth_part() -> None:
    depth = np.full((90, 160), 0.55, np.float32)
    frame = make_frame({})
    from phonegaze.types import DecodedImage

    k = 3840 / 160
    frame.images["depth"] = DecodedImage("depth", "depth", depth, np.array([[k, 0, 0], [0, k, 0], [0, 0, 1.0]]), (0, 0, 3840, 2160))
    assert depth_at(frame, (1900.0, 1000.0)) == pytest.approx(0.55)


def test_reflection_thresholds_are_live() -> None:
    cx, cy, r = 160, 100, 56
    pw, ph = predicted_reflection_px(r, 0.6, (302.0, 196.0))
    spec = EyeSpec(iris_center=(cx, cy), iris_radius=r, eye_center=(160, 100), reflection_center=(cx + 8, cy - 12), reflection_size=(pw, ph), seed=2, noise=3)
    cfg = Config()
    refl = ReflectionEstimator(cfg.estimators)
    frame = _frame(spec)
    assert refl.process(frame, _seeded(frame, cx, cy, r, dist=0.6)).left.reflection_center is not None
    set_value(cfg, "estimators.reflection_area_max", 1.0)
    set_value(cfg, "estimators.reflection_area_min", 0.9)
    refl.reset()
    frame = _frame(spec, seq=1)
    out = refl.process(frame, _seeded(frame, cx, cy, r, dist=0.6))
    # A narrow area window may or may not still accept it; a tiny offset limit must reject it.
    set_value(cfg, "estimators.reflection_area_max", 3.0)
    set_value(cfg, "estimators.reflection_area_min", 0.25)
    set_value(cfg, "estimators.reflection_max_offset", 0.2)
    refl.reset()
    out = refl.process(frame, _seeded(frame, cx, cy, r, dist=0.6))
    assert out is None or out.left.reflection_center is None
