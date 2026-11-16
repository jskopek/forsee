"""Presets, the tuning API, camera controls, live estimator settings and the fallback pointer."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from aiohttp.test_utils import TestClient, TestServer
from core_fakes import FakeEstimator, FakePhone, wait_for

from phonegaze import presets as P
from phonegaze.config import Config, load_config, settings
from phonegaze.fallback import FallbackPointer, gaze_angles
from phonegaze.lens import camera_for_preference, lens_controls_body
from phonegaze.pipeline import Engine, _PassFilter
from phonegaze.server import create_app
from phonegaze.types import Observation, ScreenInfo
from phonegaze.vision.synth import EyeSpec, make_frame, render_eye

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="sim")


# ------------------------------------------------------------------------------------ presets


def test_builtin_presets_are_valid_and_named_as_promised() -> None:
    names = [p["name"] for p in P.BUILTIN]
    for want in ("front camera, safe", "rear 2x, reflection", "rear 2x, geometric", "rear 1x, wide head box", "steady pointer", "fast pointer"):
        assert want in names
    for p in P.BUILTIN:
        clean = P.validate(p)
        assert clean["changes"] == p["changes"], p["name"]
        defaults = {s.path: s.default for s in settings()}
        for path, value in p["changes"].items():
            assert value != defaults[path], f"{p['name']}: {path} equals its default"


def test_preset_store_round_trip(tmp_path: Path) -> None:
    store = P.PresetStore(tmp_path / "presets.json")
    cfg = Config()
    cfg.filters.min_cutoff = 0.5
    cfg.outputs.cursor = True  # machine setting: never in a preset
    saved = store.save({"name": "mine", "changes": P.current_changes(cfg)})
    assert saved["changes"] == {"filters.min_cutoff": 0.5}
    with pytest.raises(P.PresetError):
        store.save({"name": "steady pointer", "changes": {}})  # built-in name
    with pytest.raises(P.PresetError):
        store.save({"name": "bad", "changes": {"server.port": 1}})
    with pytest.raises(P.PresetError):
        store.save({"name": "bad", "changes": {"filters.min_cutoff": "x"}})
    assert [p["name"] for p in P.PresetStore(tmp_path / "presets.json").all() if not p["builtin"]] == ["mine"]
    # Replace: everything else returns to its default; merge: only its own settings.
    cfg2 = Config()
    cfg2.estimators.iris_fit = "circle"
    assert P.changes_to_apply(store.get("mine"), cfg2) == {"filters.min_cutoff": 0.5, "estimators.iris_fit": "ellipse"}
    assert P.changes_to_apply(store.get("steady pointer"), cfg2) == store.get("steady pointer")["changes"]
    assert store.delete("mine") and not store.delete("mine")
    with pytest.raises(P.PresetError):
        store.delete("fast pointer")


# --------------------------------------------------------------------------------- lens body


def test_lens_controls_body() -> None:
    cfg = Config()
    assert lens_controls_body(cfg.lens, only_non_default=True) == {}
    cfg.lens.exposure_bias = 0.7
    cfg.lens.max_exposure_ms = 12.0
    cfg.lens.focus_locked = "locked"
    cfg.lens.face_driven_autofocus = "off"
    assert lens_controls_body(cfg.lens, only_non_default=True) == {"exposureBias": 0.7, "maxExposureS": 0.012, "focusLocked": True, "faceDrivenAutoFocus": False}
    cfg.lens.max_exposure_ms = 0.0
    assert lens_controls_body(cfg.lens, ["lens.max_exposure_ms"]) == {"maxExposureS": None}
    cams = FakePhone().status()["cameras"]
    assert camera_for_preference(cams, "arkit")["id"] == "arkit-face"
    assert camera_for_preference(cams, "back")["id"] == "back-wide"
    assert camera_for_preference(cams, "auto") is None


# ---------------------------------------------------------------------------- fallback pointer


def _obs_with_gaze(yaw_deg: float, pitch_deg: float, t: float) -> Observation:
    frame = make_frame({}, seq=int(t * 30), t=t)
    obs = Observation.empty(frame)
    # Camera coordinates: the person's right is the camera's -x; looking back at the camera is -z.
    y, p = np.radians(yaw_deg), np.radians(pitch_deg)
    v = np.array([-np.sin(y) * np.cos(p), -np.sin(p), -np.cos(y) * np.cos(p)])
    for side in ("left", "right"):
        obs.set(f"{side}.gaze_dir", tuple(float(x) for x in v), "test")
    obs.set("distance", 0.6, "test")
    return obs


def test_fallback_pointer_follows_the_eyes() -> None:
    cfg = Config().outputs
    cfg.fallback_smoothing_s = 0.0
    fb = FallbackPointer()
    assert gaze_angles(_obs_with_gaze(5, -3, 0))[:2] == pytest.approx((5, -3), abs=0.05)
    t = 0.0
    for _ in range(40):  # one second straight ahead sets the centre
        p = fb.update(_obs_with_gaze(0, 0, t), SCREEN, t, cfg)
        t += 1 / 30
    assert (p.x, p.y) == pytest.approx((756, 491), abs=1)
    right = fb.update(_obs_with_gaze(5, 0, t), SCREEN, t, cfg)
    up = fb.update(_obs_with_gaze(0, 5, t + 0.03), SCREEN, t + 0.03, cfg)
    ppd = 600 * np.tan(np.radians(1)) / (302 / 1512)
    assert right.x - 756 == pytest.approx(5 * ppd, rel=0.05) and right.model == "fallback"
    assert up.y < 491  # looking up moves the pointer up the screen
    cfg.fallback_flip_x = True
    left = fb.update(_obs_with_gaze(5, 0, t + 0.06), SCREEN, t + 0.06, cfg)
    assert left.x < 756
    assert fb.update(Observation.empty(make_frame({})), SCREEN, t + 0.1, cfg) is None


# ------------------------------------------------------------------------------- end to end


def make_engine(tmp_path: Path, **kw) -> Engine:
    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.auto_zoom = False
    return Engine(cfg, config_path=tmp_path / "config.json", estimators=kw.get("estimators") or [FakeEstimator()], filter=_PassFilter(), sinks=[], screen=SCREEN, hotkeys=False)


@pytest.fixture
async def phone():
    p = FakePhone(fps=60)
    await p.start()
    yield p
    await p.stop()


async def test_presets_and_camera_controls_through_the_api(tmp_path, phone) -> None:
    engine = make_engine(tmp_path)
    await engine.start()
    client = TestClient(TestServer(create_app(engine)))
    await client.start_server()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        assert not any(path == "/api/lens" for path, _ in phone.requests)  # defaults: phone left alone

        # A camera control applies live through POST /api/lens, and persists.
        r = await client.post("/api/config", json={"changes": {"lens.exposure_bias": 0.5, "lens.max_exposure_ms": 10}})
        assert (await r.json())["errors"] == {}
        assert phone.lens == {"exposureBias": 0.5, "maxExposureS": 0.01}
        assert load_config(tmp_path / "config.json").lens.exposure_bias == 0.5

        r = await client.get("/api/presets")
        listing = await r.json()
        assert {p["name"] for p in listing["presets"] if p["builtin"]} >= {"steady pointer", "rear 2x, reflection"}
        assert listing["current"] == {"lens.auto_zoom": False, "lens.exposure_bias": 0.5, "lens.max_exposure_ms": 10.0}
        steady = next(p for p in listing["presets"] if p["name"] == "steady pointer")
        assert {d["path"] for d in steady["diff"]} == set(steady["changes"]) and not steady["matches"]

        # Merge preset: only its own settings change.
        r = await client.post("/api/presets/apply", json={"name": "steady pointer"})
        body = await r.json()
        assert body["errors"] == {} and engine.config.filters.preset == "steady" and engine.config.lens.exposure_bias == 0.5
        # Save, export, delete, import.
        r = await client.post("/api/presets/save", json={"name": "my steady"})
        saved = (await r.json())["saved"]
        assert saved["changes"]["filters.preset"] == "steady" and saved["changes"]["lens.exposure_bias"] == 0.5
        r = await client.get("/api/presets/export", params={"name": "my steady"})
        exported = json.loads(await r.text())
        assert exported["changes"] == saved["changes"] and "attachment" in r.headers["Content-Disposition"]
        await client.post("/api/presets/delete", json={"name": "my steady"})
        r = await client.post("/api/presets/import", json={"preset": exported})
        assert r.status == 200
        assert json.loads((tmp_path / "presets.json").read_text())["presets"][0]["name"] == "my steady"
        r = await client.post("/api/presets/import", json={"preset": {"name": "x", "changes": {"nope.nope": 1}}})
        assert r.status == 400

        # Replace preset: everything else back to defaults (camera controls sent again).
        r = await client.post("/api/presets/apply", json={"name": "rear 2x, geometric"})
        body = await r.json()
        assert body["errors"] == {}
        assert engine.config.lens.exposure_bias == 0.0 and engine.config.filters.preset == "custom"
        assert engine.config.estimators.use_reflection is False and engine.config.models.eyeball_centre == "per_eye"
        assert phone.lens["exposureBias"] == 0.0 and phone.lens["maxExposureS"] is None
        assert next(p for p in body["presets"] if p["name"] == "rear 2x, geometric")["matches"]
    finally:
        await client.close()
        await engine.stop()


async def test_tuning_api_images_numbers_and_freeze(tmp_path) -> None:
    from phonegaze.vision.iris_edge import IrisEdgeEstimator

    engine = make_engine(tmp_path)
    client = TestClient(TestServer(create_app(engine)))
    await client.start_server()
    try:
        r = await client.get("/api/tuning/eye.jpg", params={"side": "left"})
        assert r.status == 503
        # Feed one synthetic frame through a real iris estimator, as the frame loop would.
        spec = EyeSpec(iris_center=(160, 100), iris_radius=48, eye_center=(160, 100), reflection_center=(168, 90), seed=1)
        frame = make_frame({"left_eye": (render_eye(spec), (500.0, 400.0))}, seq=5)
        est = IrisEdgeEstimator(engine.config.estimators)
        engine.estimators = [est]
        obs = est.process(frame, Observation.empty(frame))
        engine.last_decoded, engine.last_obs = frame, obs
        engine._recent_obs.append(obs)

        r = await client.get("/api/tuning/eye.jpg", params={"side": "left", "w": "300", "layers": "ellipse,edge,crop"})
        data = await r.read()
        assert r.status == 200 and data[:2] == b"\xff\xd8"
        import cv2

        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        assert img.shape[1] == 300
        r = await client.get("/api/tuning/eye.jpg", params={"side": "right"})
        assert r.status == 503  # no right-eye crop
        r = await client.get("/api/tuning/stats")
        st = await r.json()
        e = st["eyes"]["left"]
        assert e["iris_set_by"] == "iris_edge" and e["iris_radius_image_px"] == pytest.approx(48, abs=1.5)
        assert e["fit_confidence"] > 0.3 and e["sharpness"] is not None and e["fit_inliers"] > 20
        assert st["distance"]["source"] == "iris_fit" and st["rates"]["left_iris_fit"] == 1.0

        r = await client.post("/api/tuning/freeze", json={"frozen": True})
        assert (await r.json())["frozen"]
        frame2 = make_frame({}, seq=6)
        engine.last_decoded, engine.last_obs = frame2, Observation.empty(frame2)
        st = await (await client.get("/api/tuning/stats")).json()
        assert st["frozen"] and st["seq"] == 5
        r = await client.get("/api/tuning/eye.jpg", params={"side": "left"})
        assert r.status == 200  # still the frozen frame
        await client.post("/api/tuning/freeze", json={"frozen": False})
        st = await (await client.get("/api/tuning/stats")).json()
        assert not st["frozen"] and st["seq"] == 6
    finally:
        await client.close()


async def test_estimator_settings_apply_without_rebuild(tmp_path) -> None:
    cfg = Config()
    engine = Engine(cfg, config_path=tmp_path / "config.json", filter=_PassFilter(), sinks=[], screen=SCREEN, hotkeys=False)
    engine.estimators = engine._build_estimators()
    first = engine.estimators
    await engine.apply_config({"estimators.iris_fit": "circle", "estimators.reflection_k_mad": 3.0})
    assert engine.estimators is first and first[0].config.iris_fit == "circle"
    await engine.apply_config({"estimators.use_reflection": False})
    assert engine.estimators is not first and "reflection" not in [e.name for e in engine.estimators]
