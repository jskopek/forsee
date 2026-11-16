"""The Engine and the HTTP/WebSocket API against a fake phone and fake estimator/model/
calibration (the real ones belong to other areas). Owner: Core."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer
from core_fakes import FakeEstimator, FakeModel, FakePhone, patch_calibration, wait_for

from phonegaze.config import Config, load_config
from phonegaze.pipeline import Engine, _PassFilter
from phonegaze.server import create_app
from phonegaze.types import ScreenInfo

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="sim")


def make_engine(tmp_path: Path, estimator: FakeEstimator | None = None, **cfg_changes) -> Engine:
    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.auto_zoom = False
    for path, value in cfg_changes.items():
        section, name = path.split("__")
        setattr(getattr(cfg, section), name, value)
    return Engine(
        cfg,
        config_path=tmp_path / "config.json",
        estimators=[estimator or FakeEstimator()],
        filter=_PassFilter(),
        sinks=[],
        model_factory=lambda: [FakeModel("good"), FakeModel("worse", offset=(5.0, 0.0))],
        screen=SCREEN,
        hotkeys=False,
    )


@pytest.fixture
async def phone():
    p = FakePhone(fps=60)
    await p.start()
    yield p
    await p.stop()


async def test_frames_flow_and_eye_crops_are_placed(tmp_path, phone) -> None:
    est = FakeEstimator(fail_every=3)  # an estimator failing every third frame must not stop anything
    engine = make_engine(tmp_path, est)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 10)
        st = engine.state()
        assert st["phone"]["connected"] and st["camera"]["id"] == "back-wide"
        assert phone.camera_id == "back-wide" and phone.zoom == engine.config.lens.zoom  # idle phone got configured
        assert st["camera"]["rotation"] == 0
        # The engine sent ROIs around the fake eyes; frames now carry them, decoded upright.
        await wait_for(lambda: {r["name"] for r in phone.stream_config.get("rois", [])} == {"left_eye", "right_eye"})
        await wait_for(lambda: engine.last_decoded is not None and "left_eye" in engine.last_decoded.images)
        roi = engine.last_decoded.images["left_eye"]
        cx = roi.rect_full[0] + roi.rect_full[2] / 2
        assert cx == pytest.approx(0.55 * engine.last_decoded.width, rel=0.05)
        assert phone.stream_config["roiSource"] == "mac" and phone.stream_config["maxFps"] == 30
        assert st["pipeline"]["timings_ms"].get("decode") is not None
        assert engine.preview_jpeg("wide", overlay=True)[:2] == b"\xff\xd8"
        assert engine.preview_jpeg("nope") is None
    finally:
        await engine.stop()


async def test_auto_zoom_out_when_eyes_reach_the_edge(tmp_path, phone) -> None:
    engine = make_engine(tmp_path, FakeEstimator(left=(0.98, 0.5), right=(0.9, 0.5)), lens__auto_zoom=True)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        await wait_for(lambda: phone.zoom == 1.0)
    finally:
        await engine.stop()


async def test_rotation_from_gravity_portrait(tmp_path) -> None:
    phone = FakePhone(fps=60, gravity=(0.0, -1.0, 0.0))
    await phone.start()
    engine = make_engine(tmp_path)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.last_decoded is not None)
        d = engine.last_decoded
        assert d.rotation == 90 and (d.width, d.height) == (1080, 1920)
        assert d.intrinsics.cx == pytest.approx(1080 - 540)
        # Focus points come in upright 0-1 coordinates and go out as sensor 0-1.
        await engine.focus(0.25, 0.75, locked=True)
        path, body = phone.requests[-1]
        assert path == "/api/focus" and body["locked"] is True
        assert (body["x"], body["y"]) == pytest.approx((0.75, 0.75))
    finally:
        await engine.stop()
        await phone.stop()


async def test_sim_screen_and_ground_truth(tmp_path) -> None:
    phone = FakePhone(fps=60, sim_screen={"width": 1000, "height": 600, "width_mm": 300, "height_mm": 180, "scale": 2, "name": "sim", "source": "sim"})
    await phone.start()
    cfg = Config()
    cfg.recording.directory = str(tmp_path)
    engine = Engine(cfg, estimators=[FakeEstimator()], filter=_PassFilter(), sinks=[], hotkeys=False, model_factory=lambda: [FakeModel()])
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.last_obs is not None)
        assert engine.screen.source == "sim" and engine.screen.width == 1000
        assert engine.last_obs.extra["sim"]["gaze"] == [100.0, 200.0]
    finally:
        await engine.stop()
        await phone.stop()


async def ws_recv_type(ws, kind: str, timeout: float = 5.0) -> dict:
    async def go() -> dict:
        while True:
            msg = json.loads((await ws.receive()).data)
            if msg.get("type") == kind:
                return msg

    return await asyncio.wait_for(go(), timeout)


async def test_server_api_calibration_and_gaze_stream(tmp_path, phone, monkeypatch) -> None:
    patch_calibration(monkeypatch)
    engine = make_engine(tmp_path)
    await engine.start()
    engine.simulated = True  # exercise forwarding of dots to /sim/gaze
    client = TestClient(TestServer(create_app(engine)))
    await client.start_server()
    try:
        r = await client.get("/api/state")
        assert r.status == 200 and (await r.json())["phone"]["connected"] is False
        r = await client.get("/api/preview.jpg")
        assert r.status == 503
        r = await client.post("/api/phone/connect", json={"url": phone.url})
        assert r.status == 200
        engine.simulated = True
        await wait_for(lambda: engine.processed >= 3)

        # Config: valid changes apply and are saved; invalid ones are reported.
        r = await client.get("/api/config")
        body = await r.json()
        assert body["values"]["server"]["port"] == 8765 and any(s["path"] == "lens.zoom" for s in body["settings"])
        r = await client.post("/api/config", json={"changes": {"stream.max_fps": 20, "lens.zoom": 99}})
        body = await r.json()
        assert "lens.zoom" in body["errors"] and body["values"]["stream"]["max_fps"] == 20
        assert phone.stream_config["maxFps"] == 20
        assert load_config(tmp_path / "config.json").stream.max_fps == 20
        r = await client.post("/api/zoom", json={"zoom": 1.5})
        assert r.status == 200 and phone.zoom == 1.5

        # Refine before any calibration is a client error.
        r = await client.post("/api/calibration/start", json={"kind": "refine"})
        assert r.status == 400 and "calibrate first" in (await r.json())["error"]

        ui = await client.ws_connect("/ws")
        hello = await ws_recv_type(ui, "hello")
        assert hello["version"] == 1 and "pipeline" in hello["state"]
        await ui.send_json({"type": "ping", "t": 5})
        assert (await ws_recv_type(ui, "pong"))["t"] == 5

        r = await client.post("/api/calibration/start", json={"kind": "grid"})
        plan = await r.json()
        assert plan["kind"] == "grid" and len(plan["targets"]) == 3 and plan["screen"]["width"] == 1512
        for t in plan["targets"]:
            await ui.send_json({"type": "calib.dot", "run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"], "state": "show"})
            await ui.send_json({"type": "calib.dot", "run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"], "state": "collect"})
            n = engine.processed
            await wait_for(lambda: engine.processed >= n + 3)
            await ui.send_json({"type": "calib.dot", "run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"], "state": "done"})
        await asyncio.sleep(0.05)
        r = await client.post("/api/calibration/finish", json={"run_id": plan["run_id"]})
        report = await r.json()
        assert r.status == 200, report
        assert report["chosen"] == "good" and {x["model"] for x in report["reports"]} == {"good", "worse"}
        assert report["n_samples"] >= 9
        assert (await ws_recv_type(ui, "calib.report"))["run_id"] == plan["run_id"]
        assert phone.sim_gaze and phone.sim_gaze[0] == (plan["targets"][0]["x"], plan["targets"][0]["y"])

        # Gaze now flows to the UI and to Forsee's /gaze stream.
        g = await ws_recv_type(ui, "gaze")
        assert g["model"] == "good" and g["raw"] is not None
        preds = await ws_recv_type(ui, "predictions")
        assert set(preds["predictions"]) == {"good", "worse"}
        forsee = await client.ws_connect("/gaze")
        h = await ws_recv_type(forsee, "hello")
        assert h["version"] == 1 and h["screen"]["width"] == 1512
        sample = await ws_recv_type(forsee, "gaze")
        assert sample["valid"] is True and set(sample) >= {"x", "y", "t", "confidence", "valid", "nx", "ny"}
        await forsee.send_json({"type": "lookpoint", "x": 10, "y": 20})

        # Pin a model; validate; pause.
        r = await client.post("/api/model", json={"pinned": "worse"})
        assert (await r.json())["calibration"]["active"] == "worse"
        r = await client.post("/api/model", json={"pinned": "nonsense"})
        assert r.status == 400
        r = await client.post("/api/calibration/start", json={"kind": "validate"})
        vplan = await r.json()
        t = vplan["targets"][0]
        await ui.send_json({"type": "calib.dot", "run_id": vplan["run_id"], "dot_id": 0, "x": t["x"], "y": t["y"], "state": "collect"})
        n = engine.processed
        await wait_for(lambda: engine.processed >= n + 2)
        r = await client.post("/api/calibration/finish", json={"run_id": vplan["run_id"]})
        assert (await r.json())["validation"]["good"]["accuracy_deg"] == 1.0
        r = await client.post("/api/pause", json={"paused": True})
        assert (await r.json())["paused"] is True

        r = await client.get("/api/preview.jpg?image=wide&overlay=1")
        assert r.status == 200 and r.content_type == "image/jpeg"
        r = await client.get("/api/does-not-exist")
        assert r.status == 404 and "error" in await r.json()
        r = await client.get("/")
        assert r.status == 200 and "html" in r.content_type
        r = await client.get("/../../etc/passwd")
        assert r.status == 404
        await ui.close()
        await forsee.close()
    finally:
        await client.close()
        await engine.stop()


async def test_recording_through_engine_and_replay_score(tmp_path, phone, monkeypatch) -> None:
    from phonegaze.replay import iter_frames, read_events, score

    patch_calibration(monkeypatch)
    engine = make_engine(tmp_path)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 2)
        info = engine.start_recording("unit test")
        plan = engine.start_calibration("grid")
        for t in plan["targets"]:
            engine.handle_ui_message({"type": "calib.dot", "run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"], "state": "collect"})
            n = engine.processed
            await wait_for(lambda: engine.processed >= n + 3)
            engine.handle_ui_message({"type": "calib.dot", "run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"], "state": "done"})
        await engine.finish_calibration(plan["run_id"])
        summary = engine.stop_recording()
    finally:
        await engine.stop()
    rec = Path(info["path"])
    assert summary["frames"] >= 6 and (rec / "calibration.json").exists()
    assert [r["id"] for r in engine.recordings()] == [rec.name]
    frames = list(iter_frames(rec))
    assert len(frames) == summary["frames"] and all(f.t_received is not None for f in frames)
    assert {e["type"] for e in read_events(rec)} >= {"calib.start", "calib.dot", "calib.finish"}
    result = score(rec, [FakeEstimator()], [FakeModel("good"), FakeModel("worse", offset=(5.0, 0.0))])
    assert result["frames"] == len(frames) and result["n_fit_samples"] >= 6
    assert result["chosen"] == "good"
