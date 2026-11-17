"""Fakes for Core tests: an in-process phone built on phonegaze.protocol, plus small stand-ins
for the Vision, Models and calibration interfaces in phonegaze.types. Owner: Core.

Not a test module (no ``test_`` prefix); imported by ``tests/test_core_*.py``.
All images are synthetic.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from aiohttp import web

from phonegaze.protocol import CONTENT_TYPE, encode
from phonegaze.types import CalibSample, DecodedFrame, FitReport, GazePoint, Observation, ScreenInfo

SENSOR_W, SENSOR_H = 1920, 1080
FX = 1500.0


def jpeg(width: int, height: int, value: int = 128) -> bytes:
    img = np.full((height, width, 3), value, np.uint8)
    cv2.circle(img, (width // 3, height // 2), max(2, width // 20), (30, 30, 30), -1)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return bytes(buf)


class FakePhone:
    """Serves the phone routes of docs/PROTOCOL.md with synthetic frames.

    ``gravity`` is sent in every frame; ``close_after`` closes the stream after that many frames
    (to test reconnects); ``requests`` records every control request ``(path, body)``.
    """

    def __init__(self, fps: float = 30.0, gravity: tuple[float, float, float] = (-1.0, 0.0, 0.0), close_after: int | None = None, sim_screen: dict[str, Any] | None = None, mode: str = "camera") -> None:
        self.fps = fps
        self.gravity = list(gravity)
        self.close_after = close_after
        self.sim_screen = sim_screen
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.zoom = 1.0
        self.camera_id = ""
        self.mode = "idle"
        self.start_mode = mode
        self.stream_config: dict[str, Any] = {"maxFps": 30, "wide": {"enabled": True, "width": 320, "quality": 0.6, "every": 1}, "rois": [], "roiQuality": 0.9, "roiSource": "mac"}
        self.streams_opened = 0
        self.frames_sent = 0
        self.seq = 0
        self.offset = 1000.0  # phone clock = monotonic - offset... (any constant)
        self.runner: web.AppRunner | None = None
        self.url = ""
        self.sim_gaze: list[tuple[float, float]] = []
        self.arkit_tracked = True
        self.lens: dict[str, Any] = {}  # what POST /api/lens set

    def now(self) -> float:
        return time.monotonic() - self.offset

    def status(self) -> dict[str, Any]:
        return {
            "app": {"name": "Fake", "version": "0"},
            "time": self.now(),
            "system": {},
            "cameras": [
                {"id": "back-wide", "name": "Back Wide", "position": "back", "type": "wide", "zoomPresets": [2.0], "formats": [{"width": SENSOR_W, "height": SENSOR_H, "maxFps": 60}]},
                {"id": "back-ultra", "name": "Back Ultra Wide", "position": "back", "type": "ultrawide", "zoomPresets": [], "formats": []},
                {"id": "arkit-face", "name": "ARKit", "position": "front", "type": "arkit"},
            ],
            "state": {"mode": self.mode, "cameraId": self.camera_id, "zoom": self.zoom},
        }

    def app(self) -> web.Application:
        app = web.Application()

        async def body(request: web.Request) -> dict[str, Any]:
            data = await request.json() if request.can_read_body else {}
            self.requests.append((request.path, data))
            return data

        async def time_route(request: web.Request) -> web.Response:
            return web.json_response({"t": self.now()})

        async def status(request: web.Request) -> web.Response:
            return web.json_response(self.status())

        async def configure(request: web.Request) -> web.Response:
            data = await body(request)
            if "cameraId" not in data:
                return web.json_response({"error": "cameraId missing"}, status=400)
            self.camera_id = data["cameraId"]
            self.zoom = float(data.get("zoom", 1))
            self.mode = "arkit" if self.camera_id == "arkit-face" else "camera"
            return web.json_response(self.status())

        async def zoom(request: web.Request) -> web.Response:
            data = await body(request)
            if self.mode != "camera":
                return web.json_response({"error": "not in camera mode"}, status=409)
            self.zoom = float(data["zoom"])
            return web.json_response(self.status())

        async def focus(request: web.Request) -> web.Response:
            await body(request)
            return web.json_response(self.status())

        async def lens(request: web.Request) -> web.Response:
            data = await body(request)
            if self.mode != "camera":
                return web.json_response({"error": "not in camera mode"}, status=409)
            self.lens.update(data)
            return web.json_response(self.status())

        async def stream_config(request: web.Request) -> web.Response:
            data = await body(request)
            for k, v in data.items():
                if isinstance(v, dict) and isinstance(self.stream_config.get(k), dict):
                    self.stream_config[k].update(v)
                else:
                    self.stream_config[k] = v
            return web.json_response(self.stream_config)

        async def sim_gaze(request: web.Request) -> web.Response:
            data = await body(request)
            self.sim_gaze.append((data["x"], data["y"]))
            return web.json_response({"ok": True})

        async def stream(request: web.Request) -> web.StreamResponse:
            self.streams_opened += 1
            resp = web.StreamResponse(status=200, headers={"Content-Type": CONTENT_TYPE, "Cache-Control": "no-store"})
            resp.enable_compression = False  # type: ignore[attr-defined]
            await resp.prepare(request)
            hello: dict[str, Any] = {"type": "hello", "protocol": 1, "t": self.now(), "capabilities": {"roiSources": ["mac", "arkit"]}, "cameras": self.status()["cameras"], "streamConfig": self.stream_config, "state": self.status()["state"]}
            if self.sim_screen is not None:
                hello["sim"] = {"screen": self.sim_screen, "seed": 1}
            await resp.write(encode(hello))
            sent_here = 0
            try:
                while True:
                    await asyncio.sleep(1.0 / self.fps)
                    if self.mode == "idle":
                        await resp.write(encode({"type": "status", "t": self.now(), "state": self.status()["state"]}))
                        continue
                    header, parts = self.frame()
                    await resp.write(encode(header, parts))
                    self.frames_sent += 1
                    sent_here += 1
                    if self.close_after is not None and sent_here >= self.close_after:
                        break
            except (ConnectionResetError, asyncio.CancelledError):
                pass
            return resp

        app.router.add_get("/api/time", time_route)
        app.router.add_get("/api/status", status)
        app.router.add_post("/api/configure", configure)
        app.router.add_post("/api/zoom", zoom)
        app.router.add_post("/api/focus", focus)
        app.router.add_post("/api/lens", lens)
        app.router.add_post("/api/stream/config", stream_config)
        app.router.add_post("/sim/gaze", sim_gaze)
        app.router.add_get("/stream", stream)
        return app

    def frame(self) -> tuple[dict[str, Any], list[bytes]]:
        self.seq += 1
        ww = 320
        wh = ww * SENSOR_H // SENSOR_W
        parts = [jpeg(ww, wh)]
        descs = [{"name": "wide", "kind": "wide", "format": "jpeg", "width": ww, "height": wh, "rect": [0, 0, SENSOR_W, SENSOR_H]}]
        for roi in self.stream_config.get("rois") or []:
            x, y = int(roi["x"] * SENSOR_W) // 2 * 2, int(roi["y"] * SENSOR_H) // 2 * 2
            w, h = max(2, int(roi["w"] * SENSOR_W) // 2 * 2), max(2, int(roi["h"] * SENSOR_H) // 2 * 2)
            parts.append(jpeg(w, h, 90))
            descs.append({"name": roi["name"], "kind": "roi", "format": "jpeg", "width": w, "height": h, "rect": [x, y, w, h]})
        header = {
            "type": "frame",
            "seq": self.seq,
            "t": self.now(),
            "tSent": self.now(),
            "mode": self.mode,
            "dropped": 0,
            "camera": {"id": self.camera_id, "position": "back", "type": "wide", "zoom": self.zoom, "width": SENSOR_W, "height": SENSOR_H, "fx": FX * self.zoom, "fy": FX * self.zoom, "cx": SENSOR_W / 2, "cy": SENSOR_H / 2, "intrinsicsSource": "sim", "intrinsicsIncludeZoom": True},
            "lens": {"position": 0.5, "adjustingFocus": False},
            "gravity": self.gravity,
            "rotationRate": [0, 0, 0],
            "parts": descs,
        }
        if self.mode == "arkit":
            header["camera"].update({"id": "arkit-face", "position": "front", "type": "arkit"})
            header["arkit"] = {"tracked": self.arkit_tracked}
        if self.sim_screen is not None:
            header["sim"] = {"gaze": [100.0, 200.0]}
        return header, parts

    async def start(self) -> str:
        self.runner = web.AppRunner(self.app())
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self.url = f"http://127.0.0.1:{port}"
        return self.url

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()


class FakeEstimator:
    """Puts the eyes at fixed fractions of the UPRIGHT frame (configurable), radius ``r`` px."""

    name = "fake_eyes"

    def __init__(self, left=(0.55, 0.45), right=(0.45, 0.45), r: float = 20.0, fail_every: int = 0) -> None:
        self.left, self.right, self.r = left, right, r
        self.fail_every = fail_every
        self.calls = 0

    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None:
        self.calls += 1
        if self.fail_every and self.calls % self.fail_every == 0:
            raise RuntimeError("synthetic failure")
        obs = previous or Observation.empty(frame)
        for side, frac in (("left", self.left), ("right", self.right)):
            obs.set(f"{side}.found", True, self.name)
            obs.set(f"{side}.iris_center", (frac[0] * frame.width, frac[1] * frame.height), self.name)
            obs.set(f"{side}.iris_radius", self.r, self.name)
        return obs

    def reset(self) -> None:
        pass


class FakeModel:
    """Predicts the screen point linearly from the left iris centre's x/y fraction."""

    def __init__(self, name: str = "fake", offset: tuple[float, float] = (0.0, 0.0)) -> None:
        self.name = name
        self.offset = offset
        self.fitted = False
        self.refined = 0

    def fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport:
        self.fitted = True
        dots = {s.dot_id for s in samples}
        return FitReport(model=self.name, ok=bool(samples), n_samples=len(samples), n_dots=len(dots), loo_error_pt=10.0 + self.offset[0])

    def predict(self, obs: Observation) -> GazePoint | None:
        c = obs.left.iris_center
        if c is None or obs.intrinsics is None:
            return None
        return GazePoint(x=c[0] + self.offset[0], y=c[1] + self.offset[1], t=obs.t, confidence=0.9, model=self.name)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.name}


@dataclass
class FakeTarget:
    dot_id: int
    x: float
    y: float

    def to_dict(self) -> dict[str, Any]:
        return {"dot_id": self.dot_id, "x": self.x, "y": self.y}


@dataclass
class FakeRun:
    """Implements the documented ``CalibrationRun`` behaviour (begin_dot / end_dot / add)."""

    run_id: str
    kind: str
    targets: list
    screen: ScreenInfo
    samples: list = field(default_factory=list)
    _current: tuple | None = None

    def begin_dot(self, dot_id: int, x: float, y: float, t_local: float, pose_group: int | None = None) -> None:
        self._current = (dot_id, x, y)

    def end_dot(self, dot_id: int, t_local: float) -> None:
        self._current = None

    def add(self, obs: Observation) -> None:
        if self._current is None:
            return
        dot_id, x, y = self._current
        self.samples.append(CalibSample(target=(x, y), obs=obs, kind=self.kind, dot_id=dot_id, run_id=self.run_id, t_local=obs.t_local))


@dataclass
class FakeResult:
    reports: list
    chosen: str | None
    models: dict


def fake_fit_all(samples, screen, models):
    reports = [m.fit(samples, screen) for m in models]
    ok = [r for r in reports if r.ok]
    chosen = min(ok, key=lambda r: r.loo_error_pt).model if ok else None
    return FakeResult(reports, chosen, {m.name: m for m in models})


def fake_targets(config, screen, kind):
    if kind == "pursuit":
        return []
    return [FakeTarget(i, 100.0 + 50 * i, 100.0 + 30 * i) for i in range(3 if kind != "refine" else 1)]


def fake_validation(model, samples, screen):
    return {"accuracy_deg": 1.0, "precision_deg": 0.2, "accuracy_pt": 5.0, "n": len(samples), "per_dot": []}


def fake_refine(model, samples, screen):
    model.refined += 1
    return FitReport(model=model.name, ok=True, n_samples=len(samples))


def patch_calibration(monkeypatch) -> None:
    """Replace the Models area's calibration functions with the fakes above."""
    from phonegaze import calibration as calib

    monkeypatch.setattr(calib, "CalibrationRun", FakeRun)
    monkeypatch.setattr(calib, "fit_all", fake_fit_all)
    monkeypatch.setattr(calib, "config_targets", fake_targets)
    monkeypatch.setattr(calib, "validation_metrics", fake_validation)
    monkeypatch.setattr(calib, "refine", fake_refine)


async def wait_for(predicate, timeout: float = 5.0, interval: float = 0.02) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("condition not met in time")
