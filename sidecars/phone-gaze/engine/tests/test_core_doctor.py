"""The doctor, the health strip, state-change logging, the log file and the diagnostics bundle.
Owner: Diagnostics. Runs against the in-process simulated phone, including failure cases: phone
unreachable, no face, eyes closed, wrong protocol and an old app."""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from phonegaze import diagnostics as D
from phonegaze import doctor as DR
from phonegaze.config import Config
from phonegaze.pipeline import Engine
from phonegaze.server import create_app
from phonegaze.sim.server import SimPhone
from phonegaze.types import EyeObs, Intrinsics, Observation


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sim_config(tmp_path: Path) -> Config:
    cfg = Config()
    cfg.sim.render_workers = 0
    cfg.sim.port = free_port()
    cfg.lens.auto_zoom = False
    cfg.recording.directory = str(tmp_path / "recordings")
    return cfg


async def sim_engine(tmp_path: Path, camera: str = "arkit") -> Engine:
    eng = Engine(sim_config(tmp_path), config_path=tmp_path / "config.json", sinks=[], hotkeys=False, no_cursor=True)
    await eng.start(autoconnect=False)
    await eng.connect(sim=True, sim_camera=camera)
    assert await DR.wait_for_frames(eng, 30.0), "the simulator sent no frames"
    return eng


stop = DR.stop_engine


# --------------------------------------------------------------------------------------------
# Health from synthetic observations
# --------------------------------------------------------------------------------------------


def make_obs(seq: int, *, face: bool = True, closed: bool = False, swap: bool = False, iris_px: float = 40.0, distance: float = 0.6) -> Observation:
    intr = Intrinsics(fx=3000.0, fy=3000.0, cx=1920, cy=1080, width=3840, height=2160)
    obs = Observation(seq=seq, t=seq / 30, t_local=seq / 30, camera_id="back-wide", intrinsics=intr)
    if not face:
        return obs
    r = iris_px / 2
    spacing = 5.4 * iris_px
    xl, xr = 1920 + spacing / 2, 1920 - spacing / 2  # the person's left eye is on the image's right
    if swap:
        xl, xr = xr, xl
    obs.left = EyeObs(found=True, iris_center=(xl, 1000.0), iris_radius=r, iris_ellipse=(xl, 1000.0, r, r, 0.0), confidence=0.8, blink=closed, eyeball_center=(0.0325, 0, distance), reflection_center=(xl + 2, 1001.0))
    obs.right = EyeObs(found=True, iris_center=(xr, 1000.0), iris_radius=r, iris_ellipse=(xr, 1000.0, r, r, 0.0), confidence=0.8, blink=closed, eyeball_center=(-0.0325, 0, distance))
    obs.face_rect = (1500.0, 700.0, 900.0, 900.0)
    obs.distance = distance
    obs.provenance["distance"] = "landmarks"
    obs.quality.update({"sharpness": 0.2, "brightness": 120.0, "usable": 0.0 if closed else 1.0})
    obs.extra["quality"] = {"reasons": ["blink"] if closed else []}
    return obs


def test_health_summary_and_strip_from_observations() -> None:
    mon = D.HealthMonitor(window_s=5.0)
    for i in range(60):
        mon.ingest(make_obs(i, face=i % 4 != 0), i / 30)
    s = mon.summary()
    assert s["frames"] == 60
    assert s["pct"]["face"] == pytest.approx(75.0)
    assert s["pct"]["left_eye"] == pytest.approx(75.0)
    assert s["pct"]["iris_fit"] == pytest.approx(75.0)
    assert s["pct"]["reflection"] == pytest.approx(75.0)
    assert s["pct"]["arkit"] is None  # not ARKit mode
    assert s["median"]["iris_px"] == pytest.approx(40.0)
    assert s["median"]["spacing_ratio"] == pytest.approx(5.4)
    assert s["median"]["iris_mm"] == pytest.approx(40 * 0.6 / 3000 * 1000)
    assert s["distance_source"] == "landmarks"
    geo = {g["name"]: g["ok"] for g in s["geometry"]}
    assert geo["eye_spacing_ratio"] and geo["eye_distance_mm"] and geo["left_right"]
    strip = mon.strip()
    assert strip["type"] == "health"
    items = {it["id"]: it for it in strip["items"]}
    assert items["face"]["status"] == "warn" and items["face"]["pct"] == pytest.approx(75.0)
    assert items["arkit"]["status"] == "na"
    json.dumps(strip, allow_nan=False)


def test_health_flags_closed_eyes_swapped_eyes_and_implausible_size() -> None:
    mon = D.HealthMonitor(window_s=5.0)
    for i in range(30):
        mon.ingest(make_obs(i, closed=True, swap=True, iris_px=12.0, distance=2.5), i / 30)
    s = mon.summary()
    assert s["closed_pct"] == 100.0 and s["pct"]["open"] == 0.0
    geo = {g["name"]: g for g in s["geometry"]}
    assert geo["left_right"]["ok"] is False
    assert geo["distance_m"]["ok"] is False
    assert s["unusable_reasons"] == {"blink": 100.0}
    checks = {c.id: c for c in DR.stage_checks(s, None)}
    assert checks["blinks"].status == "fail"
    assert checks["distance"].status == "warn"
    assert checks["iris_size"].status == "fail"  # 12 px in camera mode
    assert checks["geometry_left_right"].status == "warn"


def test_blink_rate_counts_onsets() -> None:
    mon = D.HealthMonitor(window_s=5.0)
    t = 0.0
    for i in range(30 * 30):  # 30 s at 30 fps, a blink every 3 s lasting 0.1 s
        t = i / 30
        mon.ingest(make_obs(i, closed=(t % 3.0) < 0.1), t)
    assert mon.blink_rate() == pytest.approx(20.0, abs=2.5)


# --------------------------------------------------------------------------------------------
# Log file and state-change lines
# --------------------------------------------------------------------------------------------


def test_file_logging_writes_header_and_rotates(tmp_path: Path) -> None:
    cfg = Config()
    cfg.diagnostics.log_max_mb = 0.1
    cfg.lens.zoom = 3.0
    root = logging.getLogger()
    old_level = root.level
    try:
        path = D.setup_file_logging(cfg, tmp_path / "logs", argv=["--sim"])
        assert path is not None and D.current_log_file() == path
        logging.getLogger("phonegaze.test").info("hello from the test")
        for _ in range(2000):
            logging.getLogger("phonegaze.test").info("x" * 100)
        assert (tmp_path / "logs" / "phonegaze.log.1").is_file()
        assert path.stat().st_size < 120_000
        assert len(list((tmp_path / "logs").glob("phonegaze.log*"))) <= 1 + cfg.diagnostics.log_backups
        cfg.diagnostics.log_file = False
        assert D.setup_file_logging(cfg, tmp_path / "logs") is None
        assert D.current_log_file() is None
    finally:
        cfg.diagnostics.log_file = False
        D.setup_file_logging(cfg)
        root.setLevel(old_level)


def test_file_logging_header_names_changed_settings(tmp_path: Path) -> None:
    cfg = Config()
    cfg.lens.zoom = 3.0
    try:
        path = D.setup_file_logging(cfg, tmp_path, argv=["--phone", "http://x"])
        text = path.read_text()
        assert "Phone Gaze" in text and "lens.zoom=3.0" in text and "--phone http://x" in text
    finally:
        cfg.diagnostics.log_file = False
        D.setup_file_logging(cfg)


async def test_state_logger_logs_changes_with_the_simulator(tmp_path: Path, caplog) -> None:
    caplog.set_level(logging.INFO, logger="phonegaze.events")
    eng = await sim_engine(tmp_path, "wide")
    try:
        mon = D.HealthMonitor(eng, window_s=2.0)
        sl = D.StateLogger()
        mon.poll()
        first = sl.update(eng, mon)
        assert first and first[0].startswith("state at start:") and "phone: connected" in first[0]
        eng.set_paused(True)
        lines = sl.update(eng, mon)
        assert "paused: no -> yes" in lines
        # The face leaves the picture: turn the camera away.
        eng._sim.scene.move_camera(None, [35, 0, 0])
        lost = False
        for _ in range(40):
            await asyncio.sleep(0.15)
            mon.poll()
            if any(line.startswith("face: found -> lost") for line in sl.update(eng, mon)):
                lost = True
                break
        assert lost, "no 'face lost' line"
        assert any("face: found -> lost" in r.getMessage() for r in caplog.records)
    finally:
        await stop(eng)


# --------------------------------------------------------------------------------------------
# Doctor against the simulator
# --------------------------------------------------------------------------------------------


async def test_doctor_happy_path_arkit(tmp_path: Path) -> None:
    eng = await sim_engine(tmp_path, "arkit")
    try:
        rep = await DR.run_checks(eng, config=eng.config, config_path=tmp_path / "config.json", seconds=1.5, browser={"screen_width": 1512, "screen_height": 982, "device_pixel_ratio": 2, "screen_x": 0, "screen_y": 0})
        by = {c.id: c for c in rep.checks}
        for cid in ("python", "packages", "phone_reachable", "protocol", "face", "left_eye", "right_eye", "arkit", "distance"):
            assert by[cid].status == "ok", (cid, by[cid])
        # Speed depends on this machine (the simulator renders in a thread here): never a failure.
        for cid in ("network", "stream_fps", "latency"):
            assert by[cid].status in ("ok", "warn"), (cid, by[cid])
        assert by["app_version"].status == "info" and "simulator" in by["app_version"].verdict
        assert by["screen_browser"].status == "ok"
        assert by["calibration"].status == "warn"  # not calibrated yet
        assert "arkit" in by["distance"].verdict
        assert rep.worst != "fail"
        d = rep.to_dict()
        json.dumps(d, allow_nan=False)
        text = DR.format_report(d)
        assert "Phone reachable" in text and "Fix:" in text
    finally:
        await stop(eng)


async def test_doctor_no_face(tmp_path: Path) -> None:
    eng = await sim_engine(tmp_path, "wide")
    try:
        eng._sim.scene.move_camera(None, [35, 0, 0])  # the camera looks away from the person
        await asyncio.sleep(0.5)
        rep = await DR.run_checks(eng, config=eng.config, seconds=1.5)
        by = {c.id: c for c in rep.checks}
        assert by["face"].status == "fail" and "Sit in front" in by["face"].fix
        assert by["distance"].status == "fail"
        assert by["phone_reachable"].status == "ok"
        assert rep.worst == "fail"
    finally:
        await stop(eng)


async def test_doctor_eyes_closed(tmp_path: Path) -> None:
    eng = await sim_engine(tmp_path, "arkit")
    try:
        p = eng._sim.scene.person
        p.blink_duration_s = 1000.0
        p._blink_t0 = p.t - 350.0  # mid-blink of a very long blink: shut for over a minute
        await asyncio.sleep(0.5)
        rep = await DR.run_checks(eng, config=eng.config, seconds=1.5)
        by = {c.id: c for c in rep.checks}
        assert by["blinks"].status == "fail", by["blinks"]
        assert "closed" in by["blinks"].verdict
    finally:
        await stop(eng)


async def test_doctor_phone_unreachable(tmp_path: Path) -> None:
    url = f"http://127.0.0.1:{free_port()}"
    rep = await DR.run_checks(None, config=Config(), config_path=tmp_path / "config.json", phone_url=url, seconds=0.5)
    c = rep.get("phone_reachable")
    assert c is not None and c.status == "fail"
    assert "Local Network" in c.fix and "same Wi-Fi" in c.fix
    assert rep.get("stream_fps") is None  # nothing past the phone is checked
    assert rep.worst == "fail"


async def test_doctor_without_a_phone_skips(tmp_path: Path) -> None:
    rep = await DR.run_checks(None, config=Config(), config_path=tmp_path / "config.json", seconds=0.5)
    assert rep.get("phone_reachable").status == "skip"
    assert rep.get("face_model") is not None


class _FuturePhone(SimPhone):
    """A simulated phone that speaks a newer protocol and reports an old app version."""

    def hello(self):  # type: ignore[override]
        h = super().hello()
        h["protocol"] = 2
        h.pop("sim", None)
        h["app"] = {"name": "EyeCapture", "version": "0.1"}
        return h

    def status(self):  # type: ignore[override]
        s = super().status()
        s["app"] = {"name": "EyeCapture", "version": "0.1"}
        return s


async def test_doctor_wrong_protocol_and_old_app(tmp_path: Path) -> None:
    cfg = sim_config(tmp_path)
    phone = _FuturePhone(cfg.sim, render_workers=0)
    url = await phone.start(port=0)
    try:
        rep = await DR.run_checks(None, config=cfg, phone_url=url, seconds=0.5)
        assert rep.get("phone_reachable").status == "ok"
        assert rep.get("protocol").status == "fail" and "protocol 2" in rep.get("protocol").verdict
        assert rep.get("app_version").status == "warn" and "older" in rep.get("app_version").verdict
    finally:
        await phone.stop()


def test_expected_app_version_reads_the_ios_project() -> None:
    v = DR.expected_app_version()
    assert DR._version_tuple(v) is not None and DR._version_tuple(v) >= (0, 2, 1)


def test_screen_check_flags_browser_zoom() -> None:
    from phonegaze.types import ScreenInfo

    class E:
        screen = ScreenInfo(width=1512, height=982, width_mm=302, height_mm=196, scale=2.0, source="macos")

    checks = {c.id: c for c in DR.screen_checks(E(), {"screen_width": 1209.6, "screen_height": 785.6, "device_pixel_ratio": 2.5, "screen_x": 0, "screen_y": 0})}
    assert checks["screen_browser"].status == "warn" and "zoom" in checks["screen_browser"].verdict


# --------------------------------------------------------------------------------------------
# HTTP routes, the health feed and the bundle
# --------------------------------------------------------------------------------------------


async def test_routes_health_feed_doctor_and_bundle(tmp_path: Path) -> None:
    eng = await sim_engine(tmp_path, "arkit")
    client = TestClient(TestServer(create_app(eng)))
    await client.start_server()
    try:
        ws = await client.ws_connect("/ws")

        async def health_msg() -> dict:
            while True:
                msg = json.loads((await ws.receive()).data)
                if msg.get("type") == "health":
                    return msg

        h = await asyncio.wait_for(health_msg(), 10)
        assert {it["id"] for it in h["items"]} >= {"face", "left_eye", "right_eye", "iris_fit", "reflection", "distance", "usable", "open", "arkit"}
        assert h["frames"] > 0
        await ws.close()

        r = await client.get("/api/diagnostics/health")
        body = await r.json()
        assert r.status == 200 and body["summary"]["pct"]["face"] == 100.0

        r = await client.post("/api/diagnostics/doctor", json={"seconds": 1, "browser": {"screen_width": 1512, "screen_height": 982, "device_pixel_ratio": 2}})
        rep = await r.json()
        assert r.status == 200 and {c["id"] for c in rep["checks"]} >= {"python", "phone_reachable", "face", "calibration"}

        out = tmp_path / "bundles"
        r = await client.post("/api/diagnostics/bundle", json={"include_images": False, "seconds": 1, "out_root": str(out)})
        res = await r.json()
        assert r.status == 200, res
        folder = Path(res["path"])
        assert folder.parent == out and not (folder / "images").exists()
        for name in ("summary.txt", "doctor.json", "health.json", "observations.jsonl", "stream.json", "timings.json", "calibration.json", "config.json", "state.json", "system.json"):
            assert (folder / name).is_file(), name
        summary = (folder / "summary.txt").read_text()
        assert len(summary.splitlines()) <= 40 and "no images" in summary and "Health" in summary
        lines = (folder / "observations.jsonl").read_text().splitlines()
        assert lines and "left" in json.loads(lines[0])
        assert not list(folder.rglob("*.jpg"))

        r = await client.post("/api/diagnostics/bundle", json={"include_images": True, "run_doctor": False, "out_root": str(out)})
        res = await r.json()
        folder = Path(res["path"])
        assert folder.name.endswith("with-images") and (folder / "images" / "wide.jpg").is_file()
        assert (folder / "images" / "wide_overlay.jpg").is_file() and "face" in (folder / "images" / "README.txt").read_text()

        r = await client.get("/api/diagnostics/log?lines=5")
        assert r.status == 200 and "lines" in await r.json()
        r = await client.get("/diagnostics.html")
        assert r.status == 200 and "Diagnostics" in await r.text()
    finally:
        await client.close()
        await stop(eng)


def test_cli_doctor_and_bundle_standalone_with_the_simulator(tmp_path: Path, capsys) -> None:
    from phonegaze.__main__ import main

    cfg_path = tmp_path / "cfg" / "config.json"
    code = main(["doctor", "--sim", "arkit", "--seconds", "1", "--config", str(cfg_path), "--json"])
    out = capsys.readouterr().out
    rep = json.loads(out)
    assert code == 0 and rep["worst"] in ("ok", "warn")
    assert any(c["id"] == "face" and c["status"] == "ok" for c in rep["checks"])

    code = main(["bundle", "--standalone", "--config", str(cfg_path), "--out", str(tmp_path / "b")])
    out = capsys.readouterr().out
    assert code == 0 and "Phone Gaze diagnostics" in out
    folders = list((tmp_path / "b").iterdir())
    assert len(folders) == 1 and (folders[0] / "summary.txt").is_file() and (folders[0] / "doctor.json").is_file()


def test_diagnostics_settings_are_in_the_config_tree() -> None:
    from phonegaze.config import settings

    paths = {s.path for s in settings()}
    assert {"diagnostics.log_file", "diagnostics.health_window_s", "diagnostics.bundle_images", "diagnostics.doctor_seconds"} <= paths
    assert Config().diagnostics.bundle_images is False
