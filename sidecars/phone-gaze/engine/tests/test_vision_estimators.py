"""Iris edge, reflection and quality estimators on synthetic eye images (vision/synth.py)."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.config import Config
from phonegaze.types import Observation
from phonegaze.vision import REGISTRY, build_estimators
from phonegaze.vision.iris_edge import IrisEdgeEstimator
from phonegaze.vision.quality import QualityEstimator, measure_quality
from phonegaze.vision.reflection import ReflectionEstimator, parse_pattern, predicted_reflection_px
from phonegaze.vision.synth import EyeSpec, make_frame, render_eye

OFFSET = (500.0, 400.0)


def _eye_frame(spec: EyeSpec, seq: int = 0, t: float = 0.0, fx: float = 6000.0, side: str = "left"):
    return make_frame({f"{side}_eye": (render_eye(spec), OFFSET)}, seq=seq, t=t, fx=fx)


def _seeded(frame, cx, cy, r, side="left", dist=None) -> Observation:
    obs = Observation.empty(frame)
    obs.set(f"{side}.iris_center", (cx + OFFSET[0], cy + OFFSET[1]), "test")
    obs.set(f"{side}.iris_radius", r, "test")
    if dist is not None:
        obs.set("distance", dist, "test")
    return obs


def _chain(estimators, frame, obs):
    for est in estimators:
        res = est.process(frame, obs)
        if res is not None:
            obs = res
    return obs


def test_registry_and_build() -> None:
    assert set(REGISTRY) == {"arkit", "landmarks", "iris_edge", "reflection", "appearance", "quality"}
    cfg = Config().estimators
    names = [e.name for e in build_estimators(cfg)]
    assert names == list(cfg.order)
    for est in build_estimators(cfg):
        est.reset()


def test_iris_edge_subpixel_accuracy() -> None:
    rng = np.random.default_rng(1)
    est = IrisEdgeEstimator()
    errs, radius_errs = [], []
    for i in range(20):
        cx, cy = 160 + rng.uniform(-30, 30), 100 + rng.uniform(-8, 8)
        r = rng.uniform(35, 60)
        spec = EyeSpec(iris_center=(cx, cy), iris_radius=r, eye_center=(160, 100), reflection_center=(cx + 6, cy - 12), seed=i, noise=3, blur=0.8)
        frame = _eye_frame(spec, seq=i)
        obs = _seeded(frame, cx + rng.normal(0, 4), cy + rng.normal(0, 4), r * rng.uniform(0.85, 1.15))
        est.reset()
        out = est.process(frame, obs)
        assert out is not None and out.provenance["left.iris_center"] == "iris_edge"
        errs.append(np.hypot(out.left.iris_center[0] - cx - OFFSET[0], out.left.iris_center[1] - cy - OFFSET[1]))
        radius_errs.append(abs(out.left.iris_ellipse[2] - r))
    assert np.median(errs) < 0.4 and max(errs) < 1.5
    assert np.median(radius_errs) < 0.6


def test_iris_edge_finds_eye_without_seed_and_tracks() -> None:
    spec = EyeSpec(iris_center=(150.3, 104.7), iris_radius=48, eye_center=(160, 100), reflection_center=(156, 96), seed=3)
    frame = _eye_frame(spec, fx=3000.0)
    est = IrisEdgeEstimator()
    out = est.process(frame, Observation.empty(frame))
    assert out is not None
    assert out.left.iris_center == pytest.approx((650.3, 504.7), abs=0.6)
    # Distance from the iris size (fx 3000, 48 px radius -> depth 0.366 m, off-axis), then the
    # next frame is seeded from this one.
    rx, ry = frame.intrinsics.ray(650.3, 504.7)
    assert out.distance == pytest.approx(3000 * 0.00585 / 48 * np.sqrt(1 + rx * rx + ry * ry), rel=0.03)
    frame2 = _eye_frame(spec, seq=1, fx=3000.0)
    assert est.process(frame2, Observation.empty(frame2)).left.extra["iris_edge"]["seed"] == "previous"


def test_iris_edge_fails_soft_on_blank() -> None:
    frame = make_frame({"left_eye": (np.full((200, 320, 3), 128, np.uint8), OFFSET)})
    assert IrisEdgeEstimator().process(frame, _seeded(frame, 160, 100, 40)) is None
    assert IrisEdgeEstimator().process(make_frame({}), None) is None


def _refl_spec(i, cx, cy, r, rc, **kw):
    pw, ph = predicted_reflection_px(r, 0.6 * 56 / r, (302.0, 196.0))
    return EyeSpec(
        iris_center=(cx, cy), iris_radius=r, eye_center=(160, 100), reflection_center=rc,
        reflection_size=(pw, ph), seed=i, noise=3, blur=0.7, **kw
    )


@pytest.mark.parametrize("scale", [1.0, 0.5])
def test_reflection_centroid_accuracy(scale: float) -> None:
    rng = np.random.default_rng(3)
    iris_est, refl = IrisEdgeEstimator(), ReflectionEstimator()
    errs = []
    for i in range(20):
        cx, cy = 160 + scale * rng.uniform(-25, 25), 100 + scale * rng.uniform(-6, 6)
        r = 56 * scale * rng.uniform(0.85, 1.15)
        rc = (cx + rng.uniform(-0.4, 0.4) * r, cy + rng.uniform(-0.4, 0.2) * r)
        light = i % 2 == 0
        spec = _refl_spec(i, cx, cy, r, rc, iris_bgr=(120, 130, 110) if light else (40, 60, 90), reflection_level=215 if light else 200)
        frame = _eye_frame(spec, seq=i, fx=6000 * scale)
        obs = iris_est.process(frame, _seeded(frame, cx, cy, r))
        refl.reset()
        out = refl.process(frame, obs)
        assert out is not None and out.left.reflection_center is not None
        errs.append(np.hypot(out.left.reflection_center[0] - rc[0] - OFFSET[0], out.left.reflection_center[1] - rc[1] - OFFSET[1]))
        v = out.left.extra["reflection"]["vector"]
        assert v == pytest.approx(((rc[0] - cx) / r, (rc[1] - cy) / r), abs=0.05)
    assert np.median(errs) < 0.35 and max(errs) < 1.0


def test_reflection_corners_follow_mirror_order() -> None:
    cx, cy, r = 160, 100, 56
    rc = (168.0, 88.0)
    spec = _refl_spec(0, cx, cy, r, rc)
    frame = _eye_frame(spec)
    obs = ReflectionEstimator().process(frame, _seeded(frame, cx, cy, r, dist=0.6))
    corners = np.array(obs.left.reflection_corners) - OFFSET
    pw, ph = spec.reflection_size
    # Screen top-left reflects to the image's top-RIGHT of the blob.
    expected = [(rc[0] + pw / 2, rc[1] - ph / 2), (rc[0] - pw / 2, rc[1] - ph / 2), (rc[0] - pw / 2, rc[1] + ph / 2), (rc[0] + pw / 2, rc[1] + ph / 2)]
    assert np.abs(corners - expected).max() < 2.5


def test_reflection_rejects_when_unsure() -> None:
    cx, cy, r = 160, 100, 56
    refl = ReflectionEstimator()
    # No reflection at all.
    frame = _eye_frame(_refl_spec(0, cx, cy, r, None))
    assert refl.process(frame, _seeded(frame, cx, cy, r, dist=0.6)) is None
    # Two equally plausible highlights and nothing to choose between them.
    spec = _refl_spec(1, cx, cy, r, (cx + 8, cy - 14), distractors=[(cx - 18, cy + 10, 8.0, 225)])
    frame = _eye_frame(spec)
    out = refl.process(frame, _seeded(frame, cx, cy, r, dist=0.6))
    assert out is None or out.left.reflection_center is None
    # A blinking eye is skipped.
    frame = _eye_frame(_refl_spec(2, cx, cy, r, (cx + 8, cy - 14)))
    obs = _seeded(frame, cx, cy, r, dist=0.6)
    obs.left.blink = True
    assert refl.process(frame, obs) is None


def test_parse_pattern() -> None:
    assert parse_pattern("10110010@125") == ([1, 0, 1, 1, 0, 0, 1, 0], 0.125)
    assert parse_pattern("1100@200") == ([1, 1, 0, 0], 0.2)
    assert parse_pattern("calibration")[0] == [1, 0, 1, 1, 0, 0, 1, 0]


def test_coded_flash_finds_reflection_and_latency() -> None:
    cx0, cy0, r = 160.0, 100.0, 56.0
    lat = 0.1
    bits, step = parse_pattern("10110010@125")
    iris_est, refl = IrisEdgeEstimator(), ReflectionEstimator()

    def frame_at(i, t, gain, cx, cy):
        spec = _refl_spec(i, cx, cy, r, (cx + 8, cy - 14), reflection_gain=gain, distractors=[(cx - 18, cy + 10, 8.0, 225)])
        frame = _eye_frame(spec, seq=i, t=t)
        return frame, iris_est.process(frame, _seeded(frame, cx + 1, cy, r))

    t0 = 10.0
    refl.set_pattern("10110010@125", True, t0)
    rng = np.random.default_rng(0)
    for i in range(1, 60):
        t = t0 + i / 30.0
        k = int((t - lat - t0) / step) % len(bits) if t - lat >= t0 else 0
        frame, obs = frame_at(i, t, 0.15 + 0.85 * bits[k], cx0 + rng.normal(0, 1.5), cy0 + rng.normal(0, 1.0))
        refl.process(frame, obs)
    refl.set_pattern(None, False, t0 + 2.0)
    assert refl.latency_s == pytest.approx(lat, abs=1 / 60)
    prior = refl.priors["left"]
    assert (prior["dx"], prior["dy"]) == pytest.approx((8 / r, -14 / r), abs=0.05)

    # After the flash the distractor no longer confuses it.
    frame, obs = frame_at(100, t0 + 5.0, 1.0, 165.0, 98.0)
    out = refl.process(frame, obs)
    assert out.left.reflection_center == pytest.approx((165 + 8 + OFFSET[0], 98 - 14 + OFFSET[1]), abs=0.6)
    assert out.left.extra["reflection"]["mode"] == "prior"
    assert out.extra["reflection"]["latency_s"] == pytest.approx(lat, abs=1 / 60)


def test_quality_verdicts() -> None:
    cx, cy, r = 160, 100, 50
    spec = EyeSpec(iris_center=(cx, cy), iris_radius=r, reflection_center=(166, 92), seed=1)
    frame = _eye_frame(spec)
    chain = [IrisEdgeEstimator(), QualityEstimator()]
    obs = _chain(chain, frame, _seeded(frame, cx, cy, r))
    q = measure_quality(frame, obs)
    assert q["iris_px"] == pytest.approx(2 * r, rel=0.03) and q["sharpness"] > 0 and q["eyes_in_frame"] == 1
    assert obs.quality["usable"] == 1.0, obs.extra["quality"]

    blurry = EyeSpec(iris_center=(cx, cy), iris_radius=r, reflection_center=(166, 92), seed=1, blur=6.0)
    fb = _eye_frame(blurry)
    ob = _chain([QualityEstimator()], fb, _seeded(fb, cx, cy, r))
    assert ob.quality["sharpness"] < obs.quality["sharpness"]

    obs2 = _seeded(frame, cx, cy, r)
    obs2.left.blink = True
    out = QualityEstimator().process(frame, obs2)
    assert out.quality["usable"] == 0.0 and "blink" in out.extra["quality"]["reasons"]

    moving = make_frame({"left_eye": (render_eye(spec), OFFSET)}, rotation_rate=(0.5, 0.0, 0.0), exposure_s=1 / 60)
    out = QualityEstimator().process(moving, _seeded(moving, cx, cy, r))
    assert "motion_blur" in out.extra["quality"]["reasons"]

    empty = QualityEstimator().process(make_frame({}), None)
    assert empty.quality["usable"] == 0.0 and "no_eyes" in empty.extra["quality"]["reasons"]


def test_iris_edge_through_wire_decoding_with_rotation() -> None:
    """A JPEG ROI cut from a landscape sensor buffer and turned upright by 90 degrees: the iris
    centre must come back in upright full-frame pixels."""
    import cv2

    from phonegaze.types import CameraInfo, DecodedFrame, Frame, Intrinsics, LensState, Part, apply_affine, rotation_affine

    sw, sh = 3840, 2160
    upright_eye = render_eye(EyeSpec(width=200, height=320, iris_center=(97.3, 151.6), iris_radius=45, eye_center=(100, 160), opening_half_width=70, opening_half_height=110, reflection_center=(101, 143), seed=5))
    # The sensor image is the upright image turned back 90 degrees (counter-clockwise).
    sensor_eye = cv2.rotate(upright_eye, cv2.ROTATE_90_COUNTERCLOCKWISE)
    h, w = sensor_eye.shape[:2]
    rect = (1500.0, 700.0, float(w), float(h))
    ok, jpg = cv2.imencode(".jpg", sensor_eye, [cv2.IMWRITE_JPEG_QUALITY, 97])
    assert ok
    part = Part("left_eye", "roi", "jpeg", w, h, rect, jpg.tobytes())
    cam = CameraInfo("c", "back", "wide", 1.0, sw, sh, Intrinsics(3000, 3000, sw / 2, sh / 2, sw, sh), "sim")
    frame = Frame(0, 0.0, "camera", cam, LensState(), None, None, [part])
    decoded = DecodedFrame.from_frame(frame, rotation=90)
    # Where the true centre lands: upright crop pixel -> full frame through the same affines.
    im = decoded.images["left_eye"]
    truth = im.point_to_full((97.3, 151.6))
    s2u = rotation_affine(90, sw, sh)
    corner = apply_affine(s2u, (rect[0], rect[1] + rect[3]))
    assert im.rect_full[0] == pytest.approx(corner[0]) and im.rect_full[1] == pytest.approx(corner[1])
    obs = Observation.empty(decoded)
    obs.set("left.iris_center", (truth[0] + 3, truth[1] - 2), "test")
    obs.set("left.iris_radius", 45.0, "test")
    out = IrisEdgeEstimator().process(decoded, obs)
    assert out.left.iris_center == pytest.approx(truth, abs=0.5)


@pytest.mark.parametrize("fx,r", [(6000, 50), (6000, 80), (3000, 30), (3000, 56)])
def test_full_chain_without_landmarks(fx: float, r: float) -> None:
    """Default estimator order on an eye crop alone: the iris edge estimator finds the eye by
    itself, the reflection is found at near and far distances, the frame is usable."""
    d = fx * 0.00585 / r
    pw, ph = predicted_reflection_px(r, d, (302.0, 196.0))
    spec = EyeSpec(width=480, height=300, eye_center=(240, 150), iris_center=(237.2, 153.9), reflection_center=(243, 145), reflection_size=(pw, ph), iris_radius=r, seed=1)
    frame = _eye_frame(spec, fx=fx)
    obs = _chain(build_estimators(Config().estimators), frame, Observation.empty(frame))
    assert obs.left.iris_center == pytest.approx((237.2 + OFFSET[0], 153.9 + OFFSET[1]), abs=0.5)
    assert obs.left.reflection_center == pytest.approx((243 + OFFSET[0], 145 + OFFSET[1]), abs=0.3)
    assert obs.quality["usable"] == 1.0
    assert obs.distance == pytest.approx(d * np.sqrt(1 + sum(v * v for v in frame.intrinsics.ray(*obs.left.iris_center))), rel=0.03)
