"""Simulated phone HTTP server. Owner: Simulator.

Serves every route of docs/PROTOCOL.md for a :class:`~.scene.SimScene`, plus the simulator
routes (``/sim/...``) that tests and the engine use to steer the synthetic person.

Simulator control API (JSON bodies, camelCase or snake_case keys both accepted where noted):

- ``POST /sim/gaze {"x", "y", "instant"?}``: look at a screen point (points). With the default
  ``human_look`` the person reacts after ~200 ms with a main-sequence saccade (or smooth pursuit
  for small, frequent steps such as a moving dot); ``instant: true`` jumps.
- ``POST /sim/script {"name"}``: ``still``, ``drift``, ``sway``, ``move``, ``look_around``;
  ``blink`` triggers one blink now.
- ``GET /sim/truth``: the latest ``sim`` block.
- ``POST /sim/head {"position"?: [x, y, z] m, "rotation"?: [yaw, pitch, roll] deg}``: base head
  pose in the rig frame (rotation relative to facing the screen centre).
- ``POST /sim/camera {"translation"?: [x, y, z] m, "rotation"?: [yaw, pitch, roll] deg,
  "orientation"?: 0|90|180|270}``: move the phone (a bump) or turn it.
- ``GET|POST /sim/noise``: read or change :class:`~.scene.Knobs` (noise, blur, exposure,
  glints, ARKit noise and bias, thermal state...). Unknown keys are a 400.
- ``POST /sim/flash {"pattern": "0110…" | null, "rateHz"?, "repeat"?}``: flash the screen (the
  corneal reflection follows, after ``flash_latency_ms``).
- ``GET /sim/scene``: the full geometry (screen corners, camera pose, person anatomy, knobs).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import os
import re
import time
from collections import deque
from concurrent.futures import BrokenExecutor, Executor, ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import replace
from typing import Any

import numpy as np
from aiohttp import web

from ..config import SimConfig
from ..protocol import CONTENT_TYPE, encode
from ..types import rotation_affine
from .scene import Capture, SimScene, encode_capture_part

log = logging.getLogger("phonegaze.sim")

APP = {"name": "EyeCapture", "version": "0.2-sim"}
DEVICE = {"model": "iPhone16,2 (simulated)", "system": "phonegaze.sim"}
ROI_NAME = re.compile(r"^[A-Za-z0-9_]{1,32}$")
SCRIPTS = ("still", "drift", "sway", "move", "look_around")

DEFAULT_STREAM_CONFIG: dict[str, Any] = {
    "maxFps": 30,
    "wide": {"enabled": True, "width": 640, "quality": 0.6, "every": 1},
    "rois": [],
    "roiQuality": 0.9,
    "roiSource": "mac",
    "roiSize": {"w": 0.12, "h": 0.07},
    "arkit": True,
    "depth": False,
}


class BadRequest(Exception):
    pass


def _json_error(status: int, text: str) -> web.Response:
    return web.json_response({"error": text}, status=status)


def _num(v: Any, name: str, lo: float | None = None, hi: float | None = None) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise BadRequest(f"{name} must be a number")
    v = float(v)
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise BadRequest(f"{name} must be between {lo} and {hi}")
    return v


def _bool(v: Any, name: str) -> bool:
    if not isinstance(v, bool):
        raise BadRequest(f"{name} must be true or false")
    return v


def validate_stream_config(cur: dict[str, Any], body: Any, roi_sources: list[str]) -> dict[str, Any]:
    """Merge a partial stream config into ``cur``; raise :class:`BadRequest` on anything invalid
    (unknown keys included). Returns a new dict; ``cur`` is not modified."""
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    new = {**cur, "wide": dict(cur["wide"]), "roiSize": dict(cur["roiSize"]), "rois": list(cur["rois"])}
    for key, v in body.items():
        if key == "maxFps":
            new["maxFps"] = _num(v, "maxFps", 1, 120)
        elif key == "wide":
            if not isinstance(v, dict):
                raise BadRequest("wide must be an object")
            for wk, wv in v.items():
                if wk == "enabled":
                    new["wide"]["enabled"] = _bool(wv, "wide.enabled")
                elif wk == "width":
                    if isinstance(wv, bool) or not isinstance(wv, int) or wv < 16 or wv > 7680:
                        raise BadRequest("wide.width must be an integer from 16 to 7680")
                    new["wide"]["width"] = wv
                elif wk == "quality":
                    new["wide"]["quality"] = _num(wv, "wide.quality", 0, 1)
                elif wk == "every":
                    if isinstance(wv, bool) or not isinstance(wv, int) or wv < 1:
                        raise BadRequest("wide.every must be an integer >= 1")
                    new["wide"]["every"] = wv
                else:
                    raise BadRequest(f"unknown key wide.{wk}")
        elif key == "rois":
            if not isinstance(v, list) or len(v) > 4:
                raise BadRequest("rois must be a list of at most 4 rectangles")
            names = set()
            rois = []
            for r in v:
                if not isinstance(r, dict) or set(r) - {"name", "x", "y", "w", "h"} or not {"name", "x", "y", "w", "h"} <= set(r):
                    raise BadRequest('each roi must be {"name", "x", "y", "w", "h"}')
                name = r["name"]
                if not isinstance(name, str) or not ROI_NAME.match(name) or name in names:
                    raise BadRequest("roi names must be unique and match [A-Za-z0-9_]{1,32}")
                names.add(name)
                x, y = _num(r["x"], "roi.x"), _num(r["y"], "roi.y")
                w, h = _num(r["w"], "roi.w", 0), _num(r["h"], "roi.h", 0)
                rois.append({"name": name, "x": x, "y": y, "w": w, "h": h})
            new["rois"] = rois
        elif key == "roiQuality":
            new["roiQuality"] = _num(v, "roiQuality", 0, 1)
        elif key == "roiSource":
            if v not in roi_sources:
                raise BadRequest(f"roiSource must be one of {roi_sources}")
            new["roiSource"] = v
        elif key == "roiSize":
            if not isinstance(v, dict) or set(v) - {"w", "h"}:
                raise BadRequest('roiSize must be {"w", "h"}')
            for sk, sv in v.items():
                new["roiSize"][sk] = _num(sv, f"roiSize.{sk}", 0.001, 1)
        elif key == "arkit":
            new["arkit"] = _bool(v, "arkit")
        elif key == "depth":
            new["depth"] = _bool(v, "depth")
        else:
            raise BadRequest(f"unknown key {key}")
    return new


def sensor_roi_rect(x: float, y: float, w: float, h: float, width: int, height: int) -> tuple[int, int, int, int] | None:
    """Normalised rectangle -> sensor pixels, clamped and rounded OUTWARDS to even integers."""
    x0 = max(0.0, min(float(width), x * width))
    y0 = max(0.0, min(float(height), y * height))
    x1 = max(0.0, min(float(width), (x + w) * width))
    y1 = max(0.0, min(float(height), (y + h) * height))
    x0i = int(math.floor(x0 / 2 + 1e-9) * 2)
    y0i = int(math.floor(y0 / 2 + 1e-9) * 2)
    x1i = min(width - width % 2, int(math.ceil(x1 / 2 - 1e-9) * 2))
    y1i = min(height - height % 2, int(math.ceil(y1 / 2 - 1e-9) * 2))
    if x1i - x0i < 2 or y1i - y0i < 2:
        return None
    return (x0i, y0i, x1i - x0i, y1i - y0i)


class _StreamClient:
    def __init__(self, resp: web.StreamResponse) -> None:
        self.resp = resp
        self.queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self.inflight = 0
        self.dropped_since = 0
        self.accepted = 0
        self.pending_status = 0
        self.closed = asyncio.Event()
        self.last_accept = -1e9


def _auto_workers() -> int:
    n = os.cpu_count() or 2
    return max(0, min(4, n - 1))


class SimPhone:
    """Serves the phone routes from docs/PROTOCOL.md for a :class:`~.scene.SimScene`."""

    def __init__(self, config: SimConfig, *, autostart: bool = False, render_workers: int | None = None, pipeline_depth: int = 2) -> None:
        self.config = config
        self.scene = SimScene(int(config.seed), orientation=int(getattr(config, "orientation", 180)), camera=str(config.camera))
        self.scene.person.script = str(getattr(config, "script", "still"))
        self.scene.knobs.pixel_noise = float(getattr(config, "noise", self.scene.knobs.pixel_noise))
        self.human_look = bool(getattr(config, "human_look", True))
        self.fps = float(config.fps)
        self.autostart = autostart
        workers = render_workers if render_workers is not None else int(getattr(config, "render_workers", -1))
        self.render_workers = _auto_workers() if workers < 0 else workers
        self.pipeline_depth = max(1, pipeline_depth)
        self.clock_offset = 5000.0 + 17.0 * (int(config.seed) % 13)  # the phone booted long ago
        self.mode = "idle"
        self.requested_fps = 30.0
        self.stream_config: dict[str, Any] = {k: (dict(v) if isinstance(v, dict) else (list(v) if isinstance(v, list) else v)) for k, v in DEFAULT_STREAM_CONFIG.items()}
        self.lens: dict[str, Any] = {
            "focusLocked": False,
            "exposureLocked": False,
            "whiteBalanceLocked": False,
            "faceDrivenAutoFocus": False,
            "exposureBias": 0.0,
            "maxExposureS": None,
        }
        self.seq = 0
        self.stats = {"sent": 0, "dropped": 0, "skipped": 0, "bytes": 0, "connections": 0}
        self._sent_times: deque[tuple[float, int]] = deque(maxlen=120)
        self._capture_times: deque[float] = deque(maxlen=60)
        self.last_error: str | None = None
        self.last_capture: Capture | None = None
        self._client: _StreamClient | None = None
        self._capture_task: asyncio.Task | None = None
        self._status_task: asyncio.Task | None = None
        self._runner: web.AppRunner | None = None
        self._executor: Executor | None = None
        self.base_url: str | None = None
        self.sessions: dict[str, dict[str, Any]] = {}

    # -- clock -----------------------------------------------------------------------------------

    def now(self) -> float:
        """Phone clock (seconds since the simulated phone booted)."""
        return time.monotonic() + self.clock_offset

    # -- lifecycle -------------------------------------------------------------------------------

    async def start(self, host: str = "127.0.0.1", port: int | None = None) -> str:
        """Start serving; returns the base URL (``port=0`` picks a free port)."""
        if port is None:
            port = int(self.config.port)
        if self.render_workers > 0:
            try:
                import multiprocessing as mp

                self._executor = ProcessPoolExecutor(max_workers=self.render_workers, mp_context=mp.get_context("spawn"), initializer=_init_worker)
                # Warm the workers (imports numpy, cv2) so the first frames are not late.
                loop = asyncio.get_running_loop()
                await asyncio.gather(*[loop.run_in_executor(self._executor, _warm) for _ in range(self.render_workers)])
            except Exception as exc:  # noqa: BLE001 - rendering in a thread still works
                log.warning("simulator: no render processes (%s); rendering in a thread", exc)
                self._executor = None
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sim-render")
        self._runner = web.AppRunner(self.app(), access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, host, port)
        await site.start()
        sockets = getattr(site._server, "sockets", None) or []  # noqa: SLF001
        real_port = sockets[0].getsockname()[1] if sockets else port
        self.base_url = f"http://{host}:{real_port}"
        self._status_task = asyncio.create_task(self._status_loop(), name="sim-status")
        if self.autostart:
            cam = self.scene.camera
            w, h, _ = cam.pick_format(3840)
            self._start_camera(cam.id, w, h, self.fps, 1.0)
        log.info("simulated phone at %s", self.base_url)
        return self.base_url

    async def stop(self) -> None:
        self.mode = "idle"
        for task in (self._capture_task, self._status_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._capture_task = self._status_task = None
        if self._client is not None:
            self._client.closed.set()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def app(self) -> web.Application:
        app = web.Application(client_max_size=16 << 20, middlewares=[_errors])
        r = app.router
        r.add_get("/", self.h_index)
        r.add_get("/api/time", self.h_time)
        r.add_get("/api/status", self.h_status)
        r.add_post("/api/configure", self.h_configure)
        r.add_post("/api/stop", self.h_stop)
        r.add_post("/api/focus", self.h_focus)
        r.add_post("/api/zoom", self.h_zoom)
        r.add_post("/api/lens", self.h_lens)
        r.add_get("/api/stream/config", self.h_stream_config_get)
        r.add_post("/api/stream/config", self.h_stream_config)
        r.add_get("/stream", self.h_stream)
        r.add_get("/preview.jpg", self.h_preview)
        r.add_post("/api/session/start", self.h_session_start)
        r.add_post("/api/events", self.h_events)
        r.add_post("/api/record/start", self.h_record_start)
        r.add_post("/api/record/stop", self.h_record_stop)
        r.add_get("/api/sessions", self.h_sessions)
        r.add_post("/api/sessions/delete", self.h_sessions_delete)
        r.add_get("/files/{session}/{file}", self.h_files)
        r.add_post("/sim/gaze", self.h_sim_gaze)
        r.add_post("/sim/script", self.h_sim_script)
        r.add_get("/sim/truth", self.h_sim_truth)
        r.add_post("/sim/head", self.h_sim_head)
        r.add_post("/sim/camera", self.h_sim_camera)
        r.add_get("/sim/noise", self.h_sim_noise_get)
        r.add_post("/sim/noise", self.h_sim_noise)
        r.add_post("/sim/flash", self.h_sim_flash)
        r.add_get("/sim/scene", self.h_sim_scene)
        from .webcam import install as install_webcam  # second camera (experimental)

        install_webcam(r, self)
        return app

    # -- descriptions ----------------------------------------------------------------------------

    def capabilities(self) -> dict[str, Any]:
        return {
            "arkit": True,
            "depth": False,
            "roiSources": ["mac", "arkit", "vision"],
            "formats": ["jpeg"],
            "maxRois": 4,
            "depthSources": [],
            "depthFormats": [],
            "fps60": True,
            "zoom": True,
            "lensControl": True,
        }

    def cameras(self) -> list[dict[str, Any]]:
        return [c.status_entry() for c in self.scene.cameras.values()]

    def lens_block(self, cap: Capture | None = None) -> dict[str, Any]:
        sc = self.scene
        if self.mode == "arkit":
            return {"exposureS": sc.knobs.exposure_s, "exposureOffset": 0.0}
        cam = sc.camera
        min_f = cam.min_focus_mm / 1000.0
        focus = cap.focus_m if cap is not None else sc.focus_m
        position = float(min(1.0, max(0.0, 1 - min_f / max(focus, min_f)))) if cam.can_focus else 0.5
        lens: dict[str, Any] = {
            "position": round(position, 4),
            "adjustingFocus": bool(sc.adjusting_focus),
            "adjustingExposure": False,
            "iso": 160.0,
            "exposureS": sc.knobs.exposure_s,
            "focusLocked": bool(self.lens["focusLocked"]),
            "exposureBias": float(self.lens["exposureBias"]),
            "exposureOffset": 0.0,
            "exposureLocked": bool(self.lens["exposureLocked"]),
            "whiteBalanceLocked": bool(self.lens["whiteBalanceLocked"]),
            "faceDrivenAutoFocus": bool(self.lens["faceDrivenAutoFocus"]),
            "lowLight": False,
        }
        if self.lens["maxExposureS"] is not None:
            lens["maxExposureS"] = self.lens["maxExposureS"]
        return lens

    def thermal_cap(self) -> float | None:
        th = self.scene.knobs.thermal
        return 30.0 if th == "serious" else 15.0 if th == "critical" else None

    def stream_state(self) -> dict[str, Any]:
        now = time.monotonic()
        recent = [(t, b) for t, b in self._sent_times if now - t < 2.0]
        fps = mbps = 0.0
        if len(recent) >= 2:
            span = max(1e-3, recent[-1][0] - recent[0][0])
            fps = (len(recent) - 1) / span
            mbps = sum(b for _, b in recent[1:]) * 8 / span / 1e6
        st = {
            "clients": 1 if self._client is not None else 0,
            "sent": self.stats["sent"],
            "dropped": self.stats["dropped"],
            "skipped": self.stats["skipped"],
            "bytes": self.stats["bytes"],
            "fps": round(fps, 2),
            "mbps": round(mbps, 3),
            "lastFrameBytes": recent[-1][1] if recent else 0,
            "connections": self.stats["connections"],
        }
        if self.last_error:
            st["lastError"] = self.last_error
        return st

    def state(self) -> dict[str, Any]:
        sc = self.scene
        cam = sc.camera
        running = self.mode != "idle"
        measured = 0.0
        if len(self._capture_times) >= 2:
            measured = (len(self._capture_times) - 1) / max(1e-3, self._capture_times[-1] - self._capture_times[0])
        st: dict[str, Any] = {
            "mode": self.mode,
            "cameraId": cam.id if running else None,
            "cameraName": cam.name if running else None,
            "position": cam.position if running else None,
            "width": sc.width if running else 0,
            "height": sc.height if running else 0,
            "requestedFps": self.requested_fps,
            "measuredFps": round(measured, 2),
            "zoom": sc.zoom,
            "minFocusDistanceMM": cam.min_focus_mm,
            "binned": False,
            "focusLocked": bool(self.lens["focusLocked"]),
            "adjustingFocus": bool(sc.adjusting_focus),
            "faceTracked": bool(self.mode == "arkit" and sc.knobs.arkit_tracked),
            "recording": False,
            "segment": None,
            "framesWritten": 0,
            "framesSkipped": self.stats["skipped"],
            "framesDropped": self.stats["dropped"],
            "lastError": self.last_error,
            "stream": self.stream_state(),
            "lowLight": False,
        }
        if running:
            K = cam.intrinsics(sc.width, sc.height, sc.zoom)
            st.update(
                {
                    "fieldOfView": cam.hfov_deg,
                    "intrinsics": {"fx": K.fx, "fy": K.fy, "cx": K.cx, "cy": K.cy, "width": sc.width, "height": sc.height},
                    "gravity": sc.gravity_device(),
                    "zoomRange": list(cam.zoom_range),
                    "nativeZoomFactors": list(cam.zoom_presets),
                    "cameraType": cam.type,
                    "lens": self.lens_block(self.last_capture),
                    "exposureSeconds": sc.knobs.exposure_s,
                    "iso": 160.0,
                }
            )
            if self.mode != "arkit":
                st["lensPosition"] = st["lens"].get("position")
            if cam.depth_source:
                st["depthSource"] = cam.depth_source
        return st

    def status(self) -> dict[str, Any]:
        return {"app": APP, "time": self.now(), "system": {"thermalState": self.scene.knobs.thermal, "simulated": True}, "cameras": self.cameras(), "state": self.state()}

    def hello(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "protocol": 1,
            "t": self.now(),
            "app": APP,
            "device": DEVICE,
            "capabilities": self.capabilities(),
            "cameras": self.cameras(),
            "streamConfig": self.stream_config,
            "state": self.state(),
            "sim": {"screen": self.scene.screen.to_dict(), "seed": self.scene.seed},
        }

    def status_message(self) -> dict[str, Any]:
        st = self.stream_state()
        return {"type": "status", "t": self.now(), "state": self.state(), "stream": {"clients": st["clients"], "sent": st["sent"], "dropped": st["dropped"]}}

    # -- camera ----------------------------------------------------------------------------------

    def _start_camera(self, camera_id: str, width: int, height: int, fps: float, zoom: float) -> None:
        self.scene.set_camera(camera_id, width, height, zoom)
        cam = self.scene.camera
        self.mode = "arkit" if cam.type == "arkit" else "camera"
        self.requested_fps = fps
        self.fps = fps
        self._capture_times.clear()
        if self._capture_task is None or self._capture_task.done():
            self._capture_task = asyncio.create_task(self._capture_loop(), name="sim-capture")
        self._push_status()

    def _push_status(self) -> None:
        c = self._client
        if c is None:
            return
        c.pending_status += 1
        if c.pending_status > 16:
            c.closed.set()
            return
        c.queue.put_nowait(("status", self.status_message()))

    async def _capture_loop(self) -> None:
        loop = asyncio.get_running_loop()
        last = time.monotonic()
        next_t = last
        while self.mode != "idle":
            period = 1.0 / max(1.0, self.fps)
            next_t += period
            delay = next_t - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                await asyncio.sleep(0)
                if delay < -period:
                    next_t = time.monotonic()  # we are late; do not try to catch up
            if self.mode == "idle":
                break
            now = time.monotonic()
            self.scene.step(now - last)
            last = now
            self.seq += 1
            self._capture_times.append(now)
            t_capture = now + self.clock_offset
            client = self._client
            if client is None or client.closed.is_set():
                # Nobody streams: keep the truth fresh for /sim/truth now and then.
                if self.seq % 5 == 0:
                    self.last_capture = self.scene.capture()
                continue
            max_fps = float(self.stream_config["maxFps"])
            cap_fps = self.thermal_cap()
            if cap_fps is not None:
                max_fps = min(max_fps, cap_fps)
            if now - client.last_accept < 1.0 / max_fps - 0.3 * period:
                self.stats["skipped"] += 1
                continue
            if client.inflight >= self.pipeline_depth:
                self.stats["dropped"] += 1
                client.dropped_since += 1
                continue
            client.last_accept = now
            client.inflight += 1
            cap = self.scene.capture()
            self.last_capture = cap
            dropped = client.dropped_since
            client.dropped_since = 0
            index = client.accepted
            client.accepted += 1
            task = loop.create_task(self._build_frame(cap, self.seq, t_capture, dropped, index, cap_fps))
            client.queue.put_nowait(("frame", task))

    def _eye_sensor_px(self, cap: Capture, source: str) -> dict[str, tuple[float, float]]:
        """Where the eyes are in SENSOR pixels, as ARKit or on-phone landmarks would say."""
        out: dict[str, tuple[float, float]] = {}
        if source == "arkit":
            if cap.arkit is None or not cap.arkit.get("tracked") or "eyePixels" not in cap.arkit:
                return out
            return {k: (float(v[0]), float(v[1])) for k, v in cap.arkit["eyePixels"].items()}
        inv = np.linalg.inv(rotation_affine(cap.orientation, cap.width, cap.height))  # type: ignore[arg-type]
        for side in ("left", "right"):
            e = cap.truth["eyes"][side]
            if cap.state.blink > 0.9:
                continue
            u, v = e["irisCenter"]
            x, y, _ = inv @ np.array([u, v, 1.0])
            out[side] = (float(x), float(y))
        return out

    def _part_jobs(self, cap: Capture, index: int, cap_fps: float | None) -> list[tuple[dict[str, Any], tuple[float, float, float, float], int, int, float, int, int]]:
        cfg = self.stream_config
        k = self.scene.knobs
        jobs = []
        W, H = cap.width, cap.height
        wide = cfg["wide"]
        if wide["enabled"] and index % int(wide["every"]) == 0 and not (cap_fps is not None and cap_fps <= 15):
            ww = min(int(wide["width"]), W)
            wh = max(1, int(round(ww * H / W)))
            jobs.append(({"name": "wide", "kind": "wide", "format": "jpeg", "width": ww, "height": wh, "rect": [0, 0, W, H]}, (0.0, 0.0, float(W), float(H)), ww, wh, float(wide["quality"]), k.supersample_wide, k.skin_scale_wide))
        src = cfg["roiSource"]
        rects: list[tuple[str, tuple[int, int, int, int]]] = []
        if src == "mac":
            for r in cfg["rois"]:
                rr = sensor_roi_rect(r["x"], r["y"], r["w"], r["h"], W, H)
                if rr is not None:
                    rects.append((r["name"], rr))
        elif not (src == "arkit" and self.mode != "arkit"):
            size = cfg["roiSize"]
            for side, (px, py) in self._eye_sensor_px(cap, src).items():
                rw, rh = size["w"] * W, size["h"] * H
                rr = sensor_roi_rect((px - rw / 2) / W, (py - rh / 2) / H, rw / W, rh / H, W, H)
                if rr is not None:
                    rects.append((f"{side}_eye", rr))
        for name, (x, y, w, h) in rects:
            jobs.append(({"name": name, "kind": "roi", "format": "jpeg", "width": w, "height": h, "rect": [x, y, w, h]}, (float(x), float(y), float(w), float(h)), w, h, float(cfg["roiQuality"]), k.supersample_roi, k.skin_scale_roi))
        return jobs

    async def _build_frame(self, cap: Capture, seq: int, t_capture: float, dropped: int, index: int, cap_fps: float | None) -> bytes:
        loop = asyncio.get_running_loop()
        jobs = self._part_jobs(cap, index, cap_fps)
        lite = replace(cap, truth={}, arkit=None)
        knobs = self.scene.knobs
        gain = 2.0 ** float(self.lens["exposureBias"])
        args = [(lite, knobs, rect, ow, oh, q, ss, skin, gain, int(self.scene.rng.integers(1 << 31))) for _, rect, ow, oh, q, ss, skin in jobs]
        try:
            datas = await asyncio.gather(*[loop.run_in_executor(self._executor, encode_capture_part, *a) for a in args])
        except BrokenExecutor:
            # A render process died (or we are shutting down): carry on in a thread.
            if self._runner is None:
                raise
            log.warning("simulator render processes stopped; rendering in a thread from now on")
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sim-render")
            datas = await asyncio.gather(*[loop.run_in_executor(self._executor, encode_capture_part, *a) for a in args])
        sc = self.scene
        header: dict[str, Any] = {
            "type": "frame",
            "seq": seq,
            "t": t_capture,
            "tSent": self.now(),
            "mode": self.mode,
            "dropped": dropped,
            "camera": sc.camera_header(cap),
            "lens": self.lens_block(cap),
            "gravity": cap.gravity,
            "rotationRate": list(getattr(sc, "rotation_rate", None) or [0.0, 0.0, 0.0]),  # set while /sim/phone/move runs
            "parts": [d for d, *_ in jobs],
        }
        if self.mode == "arkit" and self.stream_config.get("arkit", True) and cap.arkit is not None:
            header["arkit"] = cap.arkit
        if self.stream_config["roiSource"] != "mac" or jobs:
            header["roiSource"] = self.stream_config["roiSource"]
        if cap_fps is not None:
            header["thermalCapFps"] = cap_fps
        header["sim"] = cap.truth
        return encode(header, list(datas))

    async def _writer(self, client: _StreamClient) -> None:
        while not client.closed.is_set():
            getter = asyncio.ensure_future(client.queue.get())
            closer = asyncio.ensure_future(client.closed.wait())
            done, _ = await asyncio.wait({getter, closer}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                closer.cancel()
                break
            closer.cancel()
            kind, item = getter.result()
            try:
                if kind == "status":
                    client.pending_status -= 1
                    await client.resp.write(encode(item))
                else:
                    try:
                        data = await item
                    except Exception as exc:  # noqa: BLE001
                        if self._runner is None:
                            break  # stopping
                        self.last_error = f"render failed: {exc}"
                        log.exception("simulator frame failed")
                        continue
                    finally:
                        client.inflight -= 1
                    await client.resp.write(data)
                    self.stats["sent"] += 1
                    self.stats["bytes"] += len(data)
                    self._sent_times.append((time.monotonic(), len(data)))
            except (ConnectionResetError, RuntimeError, asyncio.CancelledError):
                break
        client.closed.set()
        # Drop anything still queued.
        while not client.queue.empty():
            kind, item = client.queue.get_nowait()
            if kind == "frame":
                item.cancel()

    async def _status_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            self._push_status()

    # -- handlers: phone protocol ---------------------------------------------------------------

    async def _body(self, request: web.Request) -> dict[str, Any]:
        if not request.can_read_body:
            return {}
        try:
            body = await request.json()
        except ValueError as exc:
            raise BadRequest("body must be JSON") from exc
        if body is None:
            return {}
        if not isinstance(body, dict):
            raise BadRequest("body must be a JSON object")
        return body

    async def h_index(self, request: web.Request) -> web.Response:
        return web.Response(text="<!doctype html><title>Phone Gaze simulator</title><h1>Phone Gaze simulator</h1><p>A simulated phone. See /api/status, /stream and /sim/scene.</p>", content_type="text/html")

    async def h_time(self, request: web.Request) -> web.Response:
        return web.json_response({"t": self.now()})

    async def h_status(self, request: web.Request) -> web.Response:
        return web.json_response(self.status())

    async def h_configure(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        cam_id = body.get("cameraId")
        if not isinstance(cam_id, str) or cam_id not in self.scene.cameras:
            raise BadRequest(f"unknown cameraId {cam_id!r}")
        max_width = int(_num(body.get("maxWidth", 3840), "maxWidth", 16))
        fps = _num(body.get("fps", 30), "fps", 1, 240)
        zoom = _num(body.get("zoom", 1), "zoom", 0.5, 100)
        cam = self.scene.cameras[cam_id]
        w, h, max_fps = cam.pick_format(max_width)
        if fps > max_fps:
            fps = 30.0 if max_fps >= 30 else max_fps
        self._start_camera(cam_id, w, h, fps, zoom if cam.type != "arkit" else 1.0)
        return web.json_response(self.status())

    async def h_stop(self, request: web.Request) -> web.Response:
        self.mode = "idle"
        self._push_status()
        return web.json_response(self.status())

    async def h_focus(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        if self.mode == "idle":
            return _json_error(409, "no camera is running")
        for key in ("x", "y"):
            if key in body:
                _num(body[key], key, 0, 1)
        if "locked" in body:
            locked = _bool(body["locked"], "locked")
            self.lens["focusLocked"] = locked
            self.scene.focus_locked = locked
        self._push_status()
        return web.json_response(self.status())

    async def h_zoom(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        if self.mode != "camera":
            return _json_error(409, "zoom needs a running camera (not ARKit)")
        self.scene.set_zoom(_num(body.get("zoom"), "zoom"))
        self._push_status()
        return web.json_response(self.status())

    async def h_lens(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        if self.mode != "camera":
            return _json_error(409, "lens control needs a running camera (not ARKit)")
        new = dict(self.lens)
        for key, v in body.items():
            if key in ("focusLocked", "exposureLocked", "whiteBalanceLocked", "faceDrivenAutoFocus"):
                new[key] = _bool(v, key)
            elif key == "exposureBias":
                new[key] = max(-8.0, min(8.0, _num(v, key)))
            elif key == "maxExposureS":
                if v is None:
                    new[key] = None
                else:
                    if new["exposureLocked"]:
                        raise BadRequest("maxExposureS needs automatic exposure")
                    new[key] = _num(v, key, 1e-5, 1.0)
            else:
                raise BadRequest(f"unknown key {key}")
        self.lens = new
        self.scene.focus_locked = bool(new["focusLocked"])
        k = self.scene.knobs
        if new["maxExposureS"] is not None:
            k.exposure_s = min(k.exposure_s, float(new["maxExposureS"]))
        self._push_status()
        return web.json_response(self.status())

    async def h_stream_config_get(self, request: web.Request) -> web.Response:
        return web.json_response(self.stream_config)

    async def h_stream_config(self, request: web.Request) -> web.Response:
        body = await request.json() if request.can_read_body else {}
        self.stream_config = validate_stream_config(self.stream_config, body, self.capabilities()["roiSources"])
        self._push_status()
        return web.json_response(self.stream_config)

    async def h_stream(self, request: web.Request) -> web.StreamResponse:
        if self._client is not None:
            self._client.closed.set()  # one stream client at a time
        resp = web.StreamResponse(status=200, headers={"Content-Type": CONTENT_TYPE, "Cache-Control": "no-store", "Connection": "close"})
        # PROTOCOL.md: no Content-Length and no chunked encoding; the body ends when the
        # connection closes. aiohttp would choose chunked for HTTP/1.1; its WebSocket switch
        # (_length_check) turns that off.
        resp._length_check = False  # noqa: SLF001
        resp.force_close()
        await resp.prepare(request)
        client = _StreamClient(resp)
        self._client = client
        self.stats["connections"] += 1
        await resp.write(encode(self.hello()))
        try:
            await self._writer(client)
        finally:
            if self._client is client:
                self._client = None
        return resp

    async def h_preview(self, request: web.Request) -> web.Response:
        if self.mode == "idle":
            return _json_error(503, "no camera is running")
        cap = self.last_capture or self.scene.capture()
        q = request.query
        W, H = cap.width, cap.height
        if q.get("kind", "full") == "crop":
            cx, cy, w = float(q.get("cx", 0.5)), float(q.get("cy", 0.5)), float(q.get("w", 0.2))
            rr = sensor_roi_rect(cx - w / 2, cy - w * W / H / 2, w, w * W / H, W, H)
            if rr is None:
                raise BadRequest("empty crop")
            rect = tuple(float(v) for v in rr)
            ow = min(rr[2], 1024)
            oh = max(1, int(round(ow * rr[3] / rr[2])))
        else:
            rect, ow, oh = (0.0, 0.0, float(W), float(H)), 960, int(round(960 * H / W))
        loop = asyncio.get_running_loop()
        data = await loop.run_in_executor(self._executor, encode_capture_part, replace(cap, truth={}, arkit=None), self.scene.knobs, rect, ow, oh, 0.8, 2, 1, 1.0, 0)
        return web.Response(body=data, content_type="image/jpeg")

    async def h_session_start(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        sid = f"sim-{len(self.sessions) + 1}"
        self.sessions[sid] = {"sessionId": sid, "label": body.get("label", ""), "events": 0}
        return web.json_response({"sessionId": sid})

    async def h_events(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        s = self.sessions.get(str(body.get("sessionId")))
        if s is None:
            return _json_error(404, "no such session")
        n = len(body.get("events") or [])
        s["events"] += n
        return web.json_response({"stored": n})

    async def h_record_start(self, request: web.Request) -> web.Response:
        return _json_error(409, "the simulator does not record on the phone; record in the engine")

    async def h_record_stop(self, request: web.Request) -> web.Response:
        return _json_error(409, "not recording")

    async def h_sessions(self, request: web.Request) -> web.Response:
        return web.json_response({"sessions": list(self.sessions.values())})

    async def h_sessions_delete(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        self.sessions.pop(str(body.get("sessionId")), None)
        return web.json_response({"sessions": list(self.sessions.values())})

    async def h_files(self, request: web.Request) -> web.Response:
        return _json_error(404, "no such file")

    # -- handlers: simulator control -----------------------------------------------------------

    async def h_sim_gaze(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        x, y = _num(body.get("x"), "x"), _num(body.get("y"), "y")
        instant = bool(body.get("instant", not self.human_look))
        self.scene.look_at(x, y, human=not instant)
        return web.json_response({"ok": True})

    async def h_sim_script(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        name = body.get("name")
        if name == "blink":
            self.scene.person.force_blink()
        elif name in SCRIPTS:
            self.scene.person.script = str(name)
        else:
            raise BadRequest(f"name must be one of {list(SCRIPTS) + ['blink']}")
        return web.json_response({"ok": True, "script": self.scene.person.script})

    async def h_sim_truth(self, request: web.Request) -> web.Response:
        cap = self.last_capture or self.scene.capture()
        return web.json_response(cap.truth)

    async def h_sim_head(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        pos = body.get("position")
        rot = body.get("rotation")
        if pos is not None and (not isinstance(pos, list) or len(pos) != 3):
            raise BadRequest("position must be [x, y, z] metres")
        if rot is not None and (not isinstance(rot, list) or len(rot) != 3):
            raise BadRequest("rotation must be [yaw, pitch, roll] degrees")
        self.scene.set_head(pos, rot)
        return web.json_response({"ok": True, "scene": self.scene.describe()})

    async def h_sim_camera(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        tr, rot = body.get("translation"), body.get("rotation")
        if tr is not None and (not isinstance(tr, list) or len(tr) != 3):
            raise BadRequest("translation must be [x, y, z] metres")
        if rot is not None and (not isinstance(rot, list) or len(rot) != 3):
            raise BadRequest("rotation must be [yaw, pitch, roll] degrees")
        if "orientation" in body:
            o = body["orientation"]
            if o not in (0, 90, 180, 270):
                raise BadRequest("orientation must be 0, 90, 180 or 270")
            self.scene.orientation = int(o)
        self.scene.move_camera(tr, rot)
        self._push_status()
        return web.json_response({"ok": True, "scene": self.scene.describe()})

    async def h_sim_noise_get(self, request: web.Request) -> web.Response:
        return web.json_response(self.scene.knobs.to_dict())

    async def h_sim_noise(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        changes = {_snake(k): v for k, v in body.items()}
        trial = replace(self.scene.knobs)
        try:
            unknown = trial.update(changes)
        except (TypeError, ValueError) as exc:
            raise BadRequest(f"bad value: {exc}") from exc
        if unknown:
            raise BadRequest(f"unknown keys: {unknown}; known: {sorted(self.scene.knobs.to_dict())}")
        if trial.thermal not in ("nominal", "fair", "serious", "critical"):
            raise BadRequest("thermal must be nominal, fair, serious or critical")
        self.scene.knobs = trial
        self._push_status()
        return web.json_response(trial.to_dict())

    async def h_sim_flash(self, request: web.Request) -> web.Response:
        body = await self._body(request)
        pattern = body.get("pattern")
        try:
            self.scene.set_flash(pattern, float(body.get("rateHz", body.get("rate_hz", 6.0))), repeat=bool(body.get("repeat", True)))
        except ValueError as exc:
            raise BadRequest(str(exc)) from exc
        return web.json_response({"ok": True, "flash": self.scene.flash})

    async def h_sim_scene(self, request: web.Request) -> web.Response:
        return web.json_response(self.scene.describe())


def _snake(key: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()


def _init_worker() -> None:
    # Ctrl-C reaches the whole process group; the parent shuts the workers down itself.
    import signal

    signal.signal(signal.SIGINT, signal.SIG_IGN)


def _warm() -> int:
    import cv2  # noqa: F401

    from . import render  # noqa: F401

    return os.getpid()


@web.middleware
async def _errors(request: web.Request, handler: Any) -> web.StreamResponse:
    try:
        return await handler(request)
    except BadRequest as exc:
        return _json_error(400, str(exc))
    except web.HTTPException as exc:
        if exc.status >= 400:
            return _json_error(exc.status, exc.reason or "error")
        raise
    except ValueError as exc:  # bad JSON in a body
        return _json_error(400, str(exc))


async def run_sim(config: SimConfig) -> SimPhone:
    """Start a simulator on ``config.port``."""
    phone = SimPhone(config, autostart=True)
    await phone.start(port=int(config.port))
    return phone
