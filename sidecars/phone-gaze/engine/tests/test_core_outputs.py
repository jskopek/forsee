"""Outputs with the platform calls mocked: cursor, dwell click, gaze WebSocket, hotkeys, screen.
Owner: Core."""

from __future__ import annotations

import asyncio
import json
import sys

import pytest

from phonegaze.config import Config, HotkeysConfig
from phonegaze.outputs import build_sinks
from phonegaze.outputs.cursor import CursorSink
from phonegaze.outputs.dwell import DwellClickSink
from phonegaze.outputs.hotkeys import HotkeyListener
from phonegaze.outputs.screen import get_screen_info, screen_from_browser
from phonegaze.outputs.websocket import GazeWebSocketSink
from phonegaze.types import GazePoint, ScreenInfo


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeQuartz:
    def __init__(self, allowed: bool = True) -> None:
        self.allowed = allowed
        self.moves: list[tuple[float, float]] = []
        self.warps: list[tuple[float, float]] = []
        self.clicks: list[tuple[float, float]] = []
        self.mouse = (0.0, 0.0)

    def can_post_events(self) -> bool:
        return self.allowed

    def display_bounds(self):
        return (0.0, 0.0, 1512.0, 982.0)

    def mouse_location(self):
        return self.mouse

    def move(self, x, y):
        self.moves.append((x, y))
        self.mouse = (x, y)

    def warp(self, x, y):
        self.warps.append((x, y))
        self.mouse = (x, y)

    def click(self, x, y):
        self.clicks.append((x, y))


def gp(x: float, y: float, valid: bool = True, t: float = 1.0) -> GazePoint:
    return GazePoint(x=x, y=y, t=t, confidence=0.8, valid=valid)


def test_cursor_rate_limit_min_move_clamp_and_mouse_pause() -> None:
    q, clock = FakeQuartz(), Clock()
    sink = CursorSink(max_rate_hz=60, min_move_pt=2, mouse_pause_s=1.0, backend=q, clock=clock)
    assert sink.available and sink.status == "ok"
    sink.emit(gp(100, 100), None)
    clock.t += 0.005
    sink.emit(gp(200, 200), None)  # too soon
    clock.t += 0.02
    sink.emit(gp(101, 100.5), None)  # moved < 2 pt
    clock.t += 0.02
    sink.emit(gp(5000, -40), None)  # clamped to the display
    sink.emit(None, None)
    sink.emit(gp(300, 300, valid=False), None)
    assert q.moves == [(100, 100), (1511, 0)]
    # The person moves the real mouse: output pauses for a second.
    q.mouse = (700, 700)
    clock.t += 0.02
    sink.emit(gp(400, 400), None)
    clock.t += 0.5
    sink.emit(gp(400, 400), None)
    assert len(q.moves) == 2
    clock.t += 0.6
    sink.emit(gp(400, 400), None)
    assert q.moves[-1] == (400, 400)


def test_cursor_without_permission_or_platform() -> None:
    q = FakeQuartz(allowed=False)
    sink = CursorSink(backend=q, clock=Clock())
    assert sink.available and sink.status.startswith("no permission")
    sink.emit(gp(10, 10), None)
    assert q.warps == [(10, 10)] and q.moves == []
    if sys.platform != "darwin":
        plain = CursorSink()
        assert not plain.available and "macOS" in plain.status
        plain.emit(gp(1, 1), None)  # no crash


def test_cursor_backend_failure_disables_output() -> None:
    class Broken(FakeQuartz):
        def move(self, x, y):
            raise OSError("boom")

    sink = CursorSink(backend=Broken(), clock=Clock())
    sink.emit(gp(1, 1), None)
    assert not sink.available and "boom" in sink.status


def test_dwell_click() -> None:
    q, clock = FakeQuartz(), Clock()
    clicked = []
    sink = DwellClickSink(dwell_ms=800, radius_pt=40, cooldown_ms=600, gap_ms=200, backend=q, clock=clock, on_click=lambda x, y: clicked.append((x, y)))
    for i in range(30):  # 0.9 s near (500, 500)
        sink.emit(gp(500 + (i % 3), 500), None)
        clock.t += 0.03
    assert len(q.clicks) == 1 and clicked == q.clicks
    assert q.clicks[0] == pytest.approx((501, 500), abs=1.5)
    # Staying put does not click again during the cooldown; a blink does not reset the dwell.
    for _ in range(10):
        sink.emit(gp(500, 500), None)
        clock.t += 0.03
    assert len(q.clicks) == 1
    sink.emit(gp(0, 0, valid=False), None)
    clock.t += 0.1
    # Moving away re-arms; a new dwell elsewhere clicks there.
    for _ in range(30):
        sink.emit(gp(900, 300), None)
        clock.t += 0.03
    assert len(q.clicks) == 2 and q.clicks[1] == pytest.approx((900, 300))
    assert 0.0 <= sink.progress <= 1.0


class FakeWS:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    async def send_str(self, text: str) -> None:
        self.sent.append(json.loads(text))


async def test_gaze_websocket_messages_and_rate() -> None:
    clock = Clock()
    sink = GazeWebSocketSink(rate_hz=30, clock=clock)
    sink.screen = ScreenInfo(width=1000, height=500)
    sink.to_local = lambda t: t + 50.0
    ws = FakeWS()
    sink.add(ws)
    assert sink.hello()["screen"]["width"] == 1000
    sink.emit(gp(250, 100, t=40.0), None)
    await asyncio.sleep(0.01)
    clock.t += 0.01
    sink.emit(gp(260, 100), None)  # rate-limited
    clock.t += 0.05
    sink.emit(gp(999, 999, valid=False), None)
    await asyncio.sleep(0.01)
    assert len(ws.sent) == 2
    first, second = ws.sent
    assert first == {**first, "type": "gaze", "x": 250, "y": 100, "t": 90.0, "valid": True, "nx": 0.25, "ny": 0.2}
    assert first["confidence"] == pytest.approx(0.8) and first["latency_ms"] == pytest.approx(10000.0)
    # Invalid samples repeat the last valid point.
    assert second["valid"] is False and (second["x"], second["y"]) == (250, 100)

    class Dead(FakeWS):
        async def send_str(self, text: str) -> None:
            raise ConnectionResetError

    dead = Dead()
    sink.add(dead)
    clock.t += 1
    sink.emit(gp(1, 1), None)
    await asyncio.sleep(0.01)
    assert dead not in sink.clients and ws in sink.clients


class FakeHotKey:
    @staticmethod
    def parse(combo: str):
        if "bad" in combo:
            raise ValueError("bad key")
        return [combo]


class FakeGlobalHotKeys:
    instances: list = []

    def __init__(self, mapping):
        self.mapping = mapping
        self.started = self.stopped = False
        FakeGlobalHotKeys.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class FakeKeyboard:
    HotKey = FakeHotKey
    GlobalHotKeys = FakeGlobalHotKeys


def test_hotkeys_with_fake_pynput() -> None:
    fired = []
    cfg = HotkeysConfig(validate="<bad>")
    hk = HotkeyListener(cfg, {"recalibrate": lambda: fired.append("c"), "pause": lambda: fired.append("p"), "validate": lambda: fired.append("v")}, keyboard_module=FakeKeyboard)
    hk.start()
    assert hk.available and hk.status == "ok"
    listener = FakeGlobalHotKeys.instances[-1]
    assert set(listener.mapping) == {cfg.recalibrate, cfg.pause}
    listener.mapping[cfg.pause]()
    assert fired == ["p"]
    hk.stop()
    assert listener.stopped and not hk.available


def test_hotkeys_degrade() -> None:
    off = HotkeyListener(HotkeysConfig(enabled=False), {})
    off.start()
    assert off.status == "off" and not off.available
    if sys.platform != "darwin":
        hk = HotkeyListener(HotkeysConfig(), {"pause": lambda: None})
        hk.start()
        assert not hk.available and hk.status.startswith("unavailable")
        hk.stop()


def test_screen_info_fallback_and_browser() -> None:
    s = get_screen_info()
    assert s.width > 0 and s.height > 0
    if sys.platform != "darwin":
        assert s.source == "fallback" and s.width_mm == 286.0
    assert screen_from_browser({"inner_width": 1512, "inner_height": 982, "fullscreen": False}) is None
    b = screen_from_browser({"inner_width": 1512, "inner_height": 982, "device_pixel_ratio": 2, "fullscreen": True})
    assert b is not None and b.source == "browser" and b.scale == 2 and b.width_mm == pytest.approx(302.4, abs=0.1)


def test_build_sinks_never_raises() -> None:
    cfg = Config()
    assert build_sinks(cfg) == []
    cfg.outputs.cursor = True
    cfg.outputs.dwell_click = True
    sinks = build_sinks(cfg)
    assert [s.name for s in sinks] == ["cursor", "dwell"]
    for s in sinks:
        s.emit(gp(1, 1), None)
        s.close()


@pytest.mark.macos
@pytest.mark.skipif(sys.platform != "darwin", reason="needs macOS")
def test_real_quartz_reads_the_display() -> None:
    from phonegaze.outputs._quartz import quartz

    q = quartz()
    assert q is not None
    s = get_screen_info()
    assert s.source == "macos" and s.width > 0 and s.scale >= 1
