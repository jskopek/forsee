"""The no-frames watchdog counts frames received from the phone, not frames processed.

Found by the Simulator wire test in CI: MediaPipe's first load took 25-40 s on a fresh Mac, the
estimators processed nothing meanwhile, and the engine restarted the phone's camera every 10 s
although frames were arriving the whole time."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

from core_fakes import FakeEstimator

from phonegaze.config import Config
from phonegaze.pipeline import Engine, _PassFilter
from phonegaze.types import ScreenInfo

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="sim")


class _Phone:
    def __init__(self) -> None:
        self.configured = 0

    async def configure(self, *args, **kwargs) -> dict:
        self.configured += 1
        return {"state": {"mode": "camera", "cameraId": "cam"}}


def _engine(tmp_path: Path) -> tuple[Engine, _Phone]:
    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.auto_zoom = False
    cfg.lens.aim_on_start = False
    engine = Engine(cfg, config_path=tmp_path / "config.json", estimators=[FakeEstimator()], filter=_PassFilter(), sinks=[], screen=SCREEN, hotkeys=False, profile_dir=None)
    phone = _Phone()
    engine.phone = phone  # type: ignore[assignment]
    engine.phone_state = "connected"
    engine.phone_status = {"state": {"mode": "camera", "cameraId": "cam"}}
    engine._connected_at = time.monotonic() - 60
    engine._last_restart = time.monotonic() - 60
    return engine, phone


async def test_frames_waiting_for_the_estimators_do_not_restart_the_camera(tmp_path) -> None:
    engine, phone = _engine(tmp_path)
    assert engine.last_frame is None  # nothing processed yet (the estimators are still loading)
    engine.submit_frame(SimpleNamespace(t_received=None))  # type: ignore[arg-type]
    engine._frame_watchdog()
    await asyncio.sleep(0)
    assert engine._restart_task is None and phone.configured == 0


async def test_no_frames_at_all_still_restarts_the_camera(tmp_path) -> None:
    engine, phone = _engine(tmp_path)
    engine._frame_watchdog()
    assert engine._restart_task is not None
    await engine._restart_task
    assert phone.configured == 1
