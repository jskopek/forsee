"""Drift correction from selections, wired through the Engine and the API: look-points from a
``/gaze`` client (Forsee) and ``POST /api/lookpoint``, undo, the live switch, the side-by-side
numbers in the state and ``GET /api/drift``, resets, and the recorded events. Fake phone and
fake model. Owner: Core."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer
from core_fakes import FakeEstimator, FakeModel, FakePhone, wait_for

from phonegaze.config import Config
from phonegaze.pipeline import Engine, _PassFilter
from phonegaze.replay import read_events
from phonegaze.server import create_app
from phonegaze.types import ScreenInfo

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="sim")


def make_engine(tmp_path: Path) -> Engine:
    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.auto_zoom = False
    return Engine(cfg, config_path=tmp_path / "config.json", estimators=[FakeEstimator()], filter=_PassFilter(), sinks=[], screen=SCREEN, hotkeys=False)


@pytest.fixture
async def phone():
    p = FakePhone(fps=60)
    await p.start()
    yield p
    await p.stop()


def box(cx: float, cy: float, size: float = 60.0) -> dict:
    return {"x": cx - size / 2, "y": cy - size / 2, "width": size, "height": size}


async def test_selections_teach_score_undo_and_switch(tmp_path, phone) -> None:
    engine = make_engine(tmp_path)
    await engine.start()
    client = TestClient(TestServer(create_app(engine)))
    await client.start_server()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        engine.models = {"good": FakeModel("good"), "other": FakeModel("other", offset=(3.0, 0.0))}
        engine.chosen = "good"
        await wait_for(lambda: engine.last_raw is not None)
        px, py = engine.last_raw.x, engine.last_raw.y  # the fake model's constant estimate
        await asyncio.sleep(0.7)  # a full fixation window of predictions
        rec = engine.start_recording("drift")

        forsee = await client.ws_connect("/gaze")
        await forsee.receive()  # hello
        # The key is 20 pt to the right of where the estimate is: drift to learn.
        for i in range(5):
            await forsee.send_json({"type": "lookpoint", "x": px + 20, "y": py, "id": f"s{i}", "kind": "dwell", "rect": box(px + 20, py)})
        await wait_for(lambda: engine.drift.stats()["session"]["n"] == 5)
        r = await client.get("/api/drift")
        d = await r.json()
        assert d["enabled"] is False and d["applied"] is False
        assert d["session"]["n"] == 5 and d["recent"]["n"] == 5
        assert d["session"]["uncorrected"]["median_deg"] > 0
        assert d["session"]["corrected"]["mean_deg"] < d["session"]["uncorrected"]["mean_deg"]
        assert 0 < d["offset_pt"][0] < 20
        # Off: measured, not applied; the output is the model's own estimate.
        n = engine.processed
        await wait_for(lambda: engine.processed > n)
        assert engine.last_gaze.x == pytest.approx(px)

        # Switch it on live: the output moves by the learned offset.
        r = await client.post("/api/config", json={"changes": {"calibration.drift_correction": True}})
        assert (await r.json())["errors"] == {}
        await wait_for(lambda: engine.last_gaze is not None and engine.last_gaze.x > px + 1)
        assert engine.state()["drift"]["applied"] is True
        offset = engine.drift.offset[0]
        assert engine.last_gaze.x == pytest.approx(px + offset)

        # Undo: a wrong key, then taken back.
        before = engine.drift.offset.copy()
        await forsee.send_json({"type": "lookpoint", "x": px + 60, "y": py, "id": "wrong", "rect": box(px + 60, py)})
        await wait_for(lambda: engine.drift.stats()["session"]["n"] == 6)
        assert engine.drift.offset[0] > before[0]
        await forsee.send_json({"type": "lookpoint.undo", "id": "wrong"})
        await wait_for(lambda: engine.drift.undone == 1)
        assert engine.drift.offset == pytest.approx(before)
        assert engine.drift.stats()["session"]["n"] == 5

        # Old clients send only x and y; still scored.
        await forsee.send_json({"type": "lookpoint", "x": px + 20, "y": py})
        await wait_for(lambda: engine.drift.stats()["session"]["n"] == 6)

        # Mouse clicks are a separate switch, off by default.
        r = await client.post("/api/lookpoint", json={"x": px + 20, "y": py, "kind": "click", "rect": box(px + 20, py)})
        assert (await r.json())["outcome"]["reason"] == "clicks are switched off"
        await client.post("/api/config", json={"changes": {"calibration.drift_clicks": True}})
        r = await client.post("/api/lookpoint", json={"x": px + 20, "y": py, "kind": "click", "rect": box(px + 20, py), "id": "c1"})
        assert (await r.json())["outcome"]["used"] is True
        r = await client.post("/api/lookpoint/undo", json={"id": "c1"})
        assert (await r.json())["changed"] is True
        r = await client.post("/api/lookpoint", json={"y": 1})
        assert r.status == 400

        # Forsee gone and no look-point for a while: the standalone cursor is left alone.
        await forsee.close()
        await wait_for(lambda: not engine.gaze_ws.clients)
        engine.drift.last_selection_t = time.monotonic() - 1000
        n = engine.processed
        await wait_for(lambda: engine.processed > n + 1)
        assert engine.drift_applied() is False
        assert engine.last_gaze.x == pytest.approx(px)

        # A zoom change keeps the offset (re-anchors); another model resets it.
        kept = engine.drift.offset.copy()
        await client.post("/api/zoom", json={"zoom": 1.5})
        assert engine.drift.offset == pytest.approx(kept)
        r = await client.post("/api/model", json={"pinned": "other"})
        assert r.status == 200
        st = (await r.json())["drift"]
        assert st["offset_pt"] == [0.0, 0.0] and st["last_reset_reason"] == "model changed"
        assert st["session"]["n"] == 6  # the numbers are kept

        # Reset buttons.
        r = await client.post("/api/drift/reset", json={"offset": True, "stats": True})
        assert (await r.json())["session"]["n"] == 0

        engine.stop_recording()
        events = read_events(Path(rec["path"]))
        looks = [e for e in events if e["type"] == "lookpoint"]
        assert len(looks) >= 8
        assert looks[0]["id"] == "s0" and looks[0]["rect"] == [px - 10, py - 30, 60.0, 60.0] and looks[0]["kind"] == "dwell"
        assert isinstance(looks[0]["t"], float) and looks[0]["outcome"]["used"] is True
        assert [e["id"] for e in events if e["type"] == "lookpoint.undo"] == ["wrong", "c1"]
    finally:
        await client.close()
        await engine.stop()


async def test_lookpoint_before_calibration_is_recorded_but_not_used(tmp_path) -> None:
    engine = make_engine(tmp_path)
    out = engine.lookpoint(100.0, 100.0, None, rect={"x": 0, "y": 0, "width": "bad", "height": 1})
    assert out == {"used": False, "reason": "not calibrated"}
    assert engine.drift.stats()["session"]["n"] == 0
    assert engine.state()["drift"]["enabled"] is False
