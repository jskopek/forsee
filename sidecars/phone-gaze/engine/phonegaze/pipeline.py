"""The frame loop and the Engine object that owns all running state. Owner: Core.

Per frame: ``Frame`` -> ``DecodedFrame.from_frame`` (upright) -> estimator chain
(:func:`run_estimators`) -> active ``GazeModel.predict`` -> filter -> every ``OutputSink``.
Also feeds calibration runs, the recorder, and the UI's WebSocket.

Threads: the asyncio event loop owns all state. Decoding and the estimator chain run on one
worker thread, one frame at a time. The stream reader keeps only the newest unprocessed frame
(older ones are dropped, never queued). Calibration, models, filter and outputs run on the loop
after each frame.

Imported by: ``server.py`` (``Engine``), ``__main__.py``, ``replay.py``, end-to-end tests.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import dataclasses
import json
import logging
import math
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from . import calibration as calib
from . import filters as filters_mod
from . import lens as lens_mod
from . import second_camera as _second_camera  # second camera (experimental)
from .config import Config, save_config, update
from .fallback import FallbackPointer
from .models.drift import DriftCorrector, DriftSettings, points_per_degree
from .phone import PhoneClient, PhoneError, run_with_reconnect
from .protocol import Message
from .recorder import Recorder, list_recordings, new_recording_id
from .types import (
    DecodedFrame,
    Estimator,
    FitReport,
    Frame,
    GazeModel,
    GazePoint,
    Observation,
    ScreenInfo,
    _jsonable,
    apply_affine,
)

log = logging.getLogger(__name__)

STALE_FRAME_S = 1.0
"""A frame older than this when its turn comes is dropped instead of processed."""


def run_estimators(estimators: list[Estimator], frame: DecodedFrame, timings: dict[str, float] | None = None) -> Observation:
    """Run the chain exactly as :class:`phonegaze.types.Estimator` specifies.

    Implemented by Foundation so every area (and replay) shares one definition. Core may add
    timing and rate-limited logging but must keep the semantics. ``timings`` (optional) receives
    milliseconds per estimator name.
    """
    obs = Observation.empty(frame)
    for est in estimators:
        name = getattr(est, "name", type(est).__name__)
        t0 = time.perf_counter()
        try:
            result = est.process(frame, obs)
        except Exception:  # noqa: BLE001 - one bad estimator must not stop the frame
            if _log_allowed(f"est:{name}"):
                log.exception("estimator %s failed on frame %s", name, frame.frame.seq)
            result = None
        finally:
            if timings is not None:
                timings[name] = (time.perf_counter() - t0) * 1000.0
        if result is not None:
            obs = result
            obs.estimators.append(est.name)
    return obs


_LOG_TIMES: dict[str, float] = {}


def _log_allowed(key: str, every_s: float = 10.0) -> bool:
    """Rate limit for repeated errors: at most one log line per ``key`` every ``every_s``."""
    now = time.monotonic()
    if now - _LOG_TIMES.get(key, -math.inf) >= every_s:
        _LOG_TIMES[key] = now
        return True
    return False


class _Rate:
    """``ready()`` is true at most ``hz`` times per second."""

    def __init__(self, hz: float) -> None:
        self.period = 1.0 / hz
        self.last = -math.inf

    def ready(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if now - self.last >= self.period:
            self.last = now
            return True
        return False


class _PassFilter:
    def update(self, point: GazePoint | None, obs: Observation | None) -> GazePoint | None:
        return point

    def reset(self) -> None:
        pass


def _fallback_targets(screen: ScreenInfo, kind: str, n_refine: int = 1, n_validate: int = 5, grid: str = "3x3", margin: float = 0.08) -> list[calib.Target]:
    """Used only if ``calibration.config_targets`` is not available yet."""
    w, h = screen.width, screen.height
    if kind == "pursuit":
        return []
    if kind == "refine":
        pts = [(0.5, 0.5), (margin, margin), (1 - margin, 1 - margin), (1 - margin, margin), (margin, 1 - margin)][: max(1, n_refine)]
    elif kind == "validate":
        pts = [(0.3, 0.3), (0.7, 0.3), (0.5, 0.5), (0.3, 0.7), (0.7, 0.7), (0.5, 0.2), (0.5, 0.8), (0.2, 0.5), (0.8, 0.5)][:n_validate]
    else:
        cols, rows = (int(v) for v in grid.split("x"))
        pts = []
        for r in range(rows):
            cs = range(cols) if r % 2 == 0 else range(cols - 1, -1, -1)
            for c in cs:
                fx = margin + (1 - 2 * margin) * (c / (cols - 1) if cols > 1 else 0.5)
                fy = margin + (1 - 2 * margin) * (r / (rows - 1) if rows > 1 else 0.5)
                pts.append((fx, fy))
    return [calib.Target(i, round(fx * w, 1), round(fy * h, 1)) for i, (fx, fy) in enumerate(pts)]


class Engine:
    """Everything that runs: config, phone client, estimators, models, filter, outputs,
    calibration, recorder. One instance per process; ``server.py`` wraps it in HTTP.

    Public attributes the server and tests read:

    - ``config: Config``
    - ``screen: ScreenInfo``
    - ``last_obs: Observation | None``, ``last_gaze: GazePoint | None``
    - ``paused: bool``

    Everything the Engine builds from other areas can be injected (tests use fakes):
    ``estimators``, ``filter``, ``sinks``, ``model_factory`` (``() -> list[GazeModel]``),
    ``screen``. ``profile_dir`` is where the calibration profile lives (``None``: no profile).
    """

    def __init__(
        self,
        config: Config,
        *,
        config_path: str | Path | None = None,
        estimators: list[Estimator] | None = None,
        filter: Any = None,  # noqa: A002
        sinks: list[Any] | None = None,
        model_factory: Callable[[], list[GazeModel]] | None = None,
        screen: ScreenInfo | None = None,
        profile_dir: str | Path | None = None,
        hotkeys: bool = True,
        no_cursor: bool = False,
    ) -> None:
        from .outputs.websocket import GazeWebSocketSink

        self.config = config
        self.config_path = Path(config_path) if config_path else None
        self.screen: ScreenInfo | None = screen
        self._screen_injected = screen is not None
        self.last_obs: Observation | None = None
        self.last_gaze: GazePoint | None = None
        self.last_raw: GazePoint | None = None
        self.last_decoded: DecodedFrame | None = None
        self.last_frame: Frame | None = None
        self.paused = False
        self.running = False

        self._estimators_injected = estimators is not None
        self.estimators: list[Estimator] = list(estimators or [])
        self._filter_injected = filter is not None
        self.filter: Any = filter or _PassFilter()
        self._sinks_injected = sinks is not None
        self.sinks: list[Any] = list(sinks or [])
        self.model_factory = model_factory
        self.gaze_ws = GazeWebSocketSink(config.outputs.websocket_rate_hz)
        self.gaze_ws.screen = screen
        self.profile_dir = Path(profile_dir).expanduser() if profile_dir else None
        self._want_hotkeys = hotkeys
        self.no_cursor = no_cursor
        """Never move or click the system pointer this run, whatever the config says."""
        self.hotkeys: Any = None

        # Phone
        self.phone: PhoneClient | None = None
        self.phone_url = ""
        self.simulated = False
        self.replaying: Path | None = None
        self.phone_state = "disconnected"
        self.phone_detail = ""
        self.phone_status: dict[str, Any] | None = None
        self.stream_config: dict[str, Any] | None = None
        self._sim: Any = None
        self._sim_pose_group: int | None = None
        self._sim_head_base: list[float] | None = None
        self._phone_stop: asyncio.Event | None = None
        self._connected_at = 0.0
        self._last_restart = 0.0
        self._restart_task: asyncio.Task | None = None
        self._phone_task: asyncio.Task | None = None

        # Frame loop
        self._latest: Frame | None = None
        self._last_received_at = 0.0
        self._frame_event: asyncio.Event | None = None
        self._loop_task: asyncio.Task | None = None
        self._ticker_task: asyncio.Task | None = None
        self._executor: concurrent.futures.ThreadPoolExecutor | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.dropped = 0
        self.processed = 0
        self.timings_ms: dict[str, float] = {}
        self._fps_times: deque = deque(maxlen=120)

        # Lens, rotation, crops
        self.upright = lens_mod.UprightTracker(config.stream.rotation)
        self.roi_placer = lens_mod.RoiPlacer(config.stream.roi_width_mm, config.stream.roi_aspect)
        self.zoom_ctl = lens_mod.ZoomController(config.lens.zoom, config.lens.edge_margin)
        self._roi_task: asyncio.Task | None = None
        self._zoom_task: asyncio.Task | None = None
        self.hints: list[str] = []
        self.quality: dict[str, Any] = {}
        self._quality_rate = _Rate(2.0)
        self._quality_fn: Callable[[DecodedFrame, Observation | None], dict[str, Any]] | None = None
        self.aim: dict[str, Any] = {"phase": "idle", "results": []}
        self._aim_task: asyncio.Task | None = None
        self._aim_samples: list[tuple[dict[str, Any], bool | None]] | None = None
        self.fallback = FallbackPointer()
        """``outputs.fallback_pointer``: a pointer without calibration (``fallback.py``)."""
        self._lens_ctl_task: asyncio.Task | None = None
        self._focus_task: asyncio.Task | None = None
        self._focus_eye_at = 0.0
        self.lens_controls: dict[str, Any] = {"sent": {}, "error": ""}
        """What was last sent to the phone with ``POST /api/lens``, and its error if refused."""

        # Models and calibration
        self.models: dict[str, GazeModel] = {}
        self.reports: list[FitReport] = []
        self.chosen: str | None = None
        self.models_setup: dict[str, Any] | None = None
        """The camera and screen the models in use were fitted with (``None``: unknown, e.g. models
        injected by a test). See :meth:`_check_setup`."""
        self._setup_key: tuple | None = None
        self.validation: dict[str, Any] = {}
        self.active_run: calib.CalibrationRun | None = None
        self._run_counter = 0
        self._pursuit_samples: list[Any] = []  # last moving-dot run, merged into the next grid fit
        self._validation_pool: list[Any] = []  # validation samples since the last full calibration
        self._pursuit_dot: int | None = None
        self._recent_obs: deque = deque(maxlen=90)
        self.drift = DriftCorrector(DriftSettings(rate_deg_per_min=config.calibration.drift_rate))
        """Drift correction from selections (``models/drift.py``): always learned and scored from
        look-points; added to the output only while :meth:`drift_applied`."""
        self._sim_gaze_task: asyncio.Task | None = None

        # Recording and UI
        self.recorder: Recorder | None = None
        self._subscribers: list[Callable[[dict[str, Any]], Any]] = []
        self._rates = {"gaze": _Rate(60), "obs": _Rate(10), "predictions": _Rate(10), "frame": _Rate(10)}
        self._last_state_json = ""

        # second camera (experimental; phonegaze/second_camera): inert unless second_camera.enabled
        self.second_camera = _second_camera.SecondCamera(self)
        self._obs_m: Observation | None = None

    # ------------------------------------------------------------------------------------------
    # Life cycle
    # ------------------------------------------------------------------------------------------

    async def start(self, autoconnect: bool = True) -> None:
        """Connect to the phone (or simulator), start the frame loop and outputs.
        ``autoconnect=False`` skips connecting to ``phone.url``."""
        if self.running:
            return
        self._loop = asyncio.get_running_loop()
        self._frame_event = asyncio.Event()
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="phonegaze-frames")
        if self.screen is None:
            from .outputs.screen import get_screen_info

            self.screen = get_screen_info()
        self.gaze_ws.screen = self.screen
        self.gaze_ws.to_local = self._to_local
        if not self._estimators_injected:
            self.estimators = self._build_estimators()
        if not self._filter_injected:
            self.filter = self._build_filter()
        if not self._sinks_injected:
            self.sinks = self._build_sinks()
        self._load_profile()
        if self._want_hotkeys:
            self._start_hotkeys()
        self.running = True
        self._loop_task = asyncio.create_task(self._frame_loop(), name="phonegaze-frame-loop")
        self._ticker_task = asyncio.create_task(self._ticker(), name="phonegaze-ticker")
        if autoconnect and self.config.phone.url:
            await self.connect(self.config.phone.url)

    async def stop(self) -> None:
        self.running = False
        await self.disconnect()
        for task in (self._loop_task, self._ticker_task, self._aim_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self._loop_task = self._ticker_task = self._aim_task = None
        if self.recorder is not None:
            self.stop_recording()
        for sink in self.sinks:
            try:
                sink.close()
            except Exception:  # noqa: BLE001
                pass
        self.gaze_ws.close()
        self.second_camera.stop()  # second camera
        if self.hotkeys is not None:
            self.hotkeys.stop()
            self.hotkeys = None
        if self._executor is not None:
            executor, self._executor = self._executor, None
            executor.shutdown(wait=False, cancel_futures=True)
            # Close MediaPipe's landmarker once the frame worker has left it: left to the garbage
            # collector at exit it can deadlock on macOS, and closing it mid-frame crashes.
            try:
                await asyncio.wait_for(asyncio.to_thread(executor.shutdown, True), timeout=10.0)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                return
            for est in list(self.estimators or []):
                lm = getattr(est, "_landmarker", None)
                if lm is not None:
                    try:
                        lm.close()
                    except Exception:  # noqa: BLE001
                        pass
                    est._landmarker = None

    # ------------------------------------------------------------------------------------------
    # Building parts from other areas (each degrades instead of failing)
    # ------------------------------------------------------------------------------------------

    def _build_estimators(self) -> list[Estimator]:
        try:
            from .vision import build_estimators

            return list(build_estimators(self.config.estimators))
        except NotImplementedError:
            self.log("warning", "Vision estimators are not implemented yet; frames are decoded but not measured.")
        except Exception as exc:  # noqa: BLE001
            log.exception("building estimators failed")
            self.log("error", f"Building estimators failed: {exc}")
        return []

    def _build_filter(self) -> Any:
        try:
            return filters_mod.build_filter(self.config.filters, screen=self.screen)
        except NotImplementedError:
            log.info("filters not implemented yet; passing gaze through unfiltered")
        except Exception as exc:  # noqa: BLE001
            log.exception("building the filter failed")
            self.log("error", f"Building the filter failed: {exc}")
        return _PassFilter()

    def _set_screen(self, screen: ScreenInfo | None) -> None:
        """Use ``screen`` everywhere: gaze WebSocket and the filter (degrees need the screen).
        The calibration is checked against it at the next frame (:meth:`_check_setup`)."""
        self.screen = screen
        self._setup_key = None
        self.gaze_ws.screen = screen
        fn = getattr(self.filter, "set_screen", None)
        if fn is not None:
            try:
                fn(screen)
            except Exception:  # noqa: BLE001
                log.exception("filter.set_screen failed")

    def _build_sinks(self) -> list[Any]:
        from .outputs import build_sinks

        sinks = build_sinks(self.config)
        if self.no_cursor:
            sinks = [s for s in sinks if getattr(s, "name", "") not in ("cursor", "dwell")]
        for s in sinks:
            status = getattr(s, "status", "ok")
            if status and status != "ok":
                self.log("warning", f"{s.name}: {status}")
        return sinks

    def _new_models(self) -> list[GazeModel]:
        if self.model_factory is not None:
            return list(self.model_factory()) + self.second_camera.extra_models()  # second camera
        from .models import build_models

        return list(build_models(self.config.models)) + self.second_camera.extra_models()  # second camera

    def _start_hotkeys(self) -> None:
        from .outputs.hotkeys import HotkeyListener

        def marshal(action: str) -> Callable[[], None]:
            def fire() -> None:
                if self._loop is not None:
                    self._loop.call_soon_threadsafe(self.hotkey, action)

            return fire

        actions = {a: marshal(a) for a in ("recalibrate", "quick_refine", "validate", "pause")}
        self.hotkeys = HotkeyListener(self.config.hotkeys, actions)
        try:
            self.hotkeys.start()
        except Exception as exc:  # noqa: BLE001
            log.warning("hotkeys failed: %s", exc)
        if self.hotkeys.status not in ("ok", "off"):
            log.info("global shortcuts: %s", self.hotkeys.status)

    def hotkey(self, action: str) -> None:
        """A global shortcut fired (on the loop thread)."""
        if action == "pause":
            self.set_paused(not self.paused)
        self.broadcast({"type": "hotkey", "action": action})

    def _load_profile(self) -> None:
        """Nothing to do at start: a calibration belongs to one camera and one screen, so the
        profile for the camera in use is loaded when the first frame says which camera that is
        (:meth:`_check_setup`)."""

    @staticmethod
    def _camera_slug(camera: dict[str, Any]) -> str:
        """Profile sub-directory for a camera: ``arkit``, ``back-wide``, ``front-wide``, ..."""
        if camera.get("type") == "arkit":
            return "arkit"
        return f"{camera.get('position') or 'unknown'}-{camera.get('type') or 'camera'}".replace("/", "_")

    def _current_setup(self) -> dict[str, Any] | None:
        """The camera (from the latest frame) and screen in use now, or ``None`` if unknown."""
        frame = self.last_frame
        if frame is None or self.screen is None:
            return None
        cam = frame.camera
        return {
            "camera": {"id": cam.id, "type": cam.type, "position": cam.position, "zoom": cam.zoom},
            "screen": {"width": round(float(self.screen.width)), "height": round(float(self.screen.height)), "source": self.screen.source},
        }

    @staticmethod
    def _setup_matches(saved: dict[str, Any] | None, now: dict[str, Any]) -> bool:
        if not saved or not isinstance(saved.get("camera"), dict) or not isinstance(saved.get("screen"), dict):
            return False
        a, b = saved["camera"], now["camera"]
        sa, sb = saved["screen"], now["screen"]
        return a.get("id") == b["id"] and a.get("type") == b["type"] and round(float(sa.get("width", -1))) == sb["width"] and round(float(sa.get("height", -1))) == sb["height"]

    @staticmethod
    def _describe_setup(setup: dict[str, Any]) -> str:
        cam, scr = setup.get("camera") or {}, setup.get("screen") or {}
        name = "ARKit" if cam.get("type") == "arkit" else f"the {cam.get('position', '')} {cam.get('type', '')} camera".replace("  ", " ")
        return f"{name} and a {scr.get('width')} x {scr.get('height')} pt screen"

    def _check_setup(self) -> None:
        """Use only a calibration made with the camera and screen in use now.

        Called for every frame; does work only when the camera or screen changed. If the models
        in use were fitted with another camera or screen they are put away, and the profile saved
        for this camera is loaded if it was made with this camera and screen. Otherwise there is
        no model (no gaze output) and the UI is told to calibrate."""
        now = self._current_setup()
        if now is None:
            return
        key = (now["camera"]["id"], now["camera"]["type"], now["screen"]["width"], now["screen"]["height"])
        if key == self._setup_key:
            return
        self._setup_key = key
        if self.models and (self.models_setup is None or self._setup_matches(self.models_setup, now)):
            if self.models_setup is None:
                self.models_setup = now
            return
        old = self.models_setup if self.models else None
        self.models, self.reports, self.chosen, self.validation, self.models_setup = {}, [], None, {}, None
        self.filter_reset()
        self._drift_reset("camera or screen changed")
        loaded = self._load_profile_for(now)
        if not loaded and old is not None:
            self.log("warning", f"The calibration in use was made with {self._describe_setup(old)}; this is {self._describe_setup(now)}. Calibrate again.")

    def _profile_path(self, setup: dict[str, Any]) -> Path | None:
        return None if self.profile_dir is None else self.profile_dir / self._camera_slug(setup["camera"])

    def _load_profile_for(self, now: dict[str, Any]) -> bool:
        path = self._profile_path(now)
        if path is None or not path.exists():
            return False
        try:
            profile = calib.Profile(path)
            setup = profile.setup() or {}
            saved = {"camera": setup.get("camera"), "screen": setup.get("screen")}
            if not self._setup_matches(saved, now):
                if saved["camera"]:
                    self.log("warning", f"The saved calibration for this camera was made with {self._describe_setup(saved)}; this is {self._describe_setup(now)}. Calibrate again.")
                return False
            result = profile.load()
        except Exception as exc:  # noqa: BLE001
            log.warning("cannot load the calibration profile %s: %s", path, exc)
            return False
        if result is None or not result.models:
            return False
        self.models = dict(result.models)
        self.reports = list(result.reports)
        self.chosen = result.chosen
        self.models_setup = now
        self._drift_reset("calibration profile loaded")
        self.log("info", f"Loaded the saved calibration for {self._describe_setup(now)} (model {self.chosen}).")
        return True

    # ------------------------------------------------------------------------------------------
    # Phone connection
    # ------------------------------------------------------------------------------------------

    async def connect(self, url: str | None = None, *, sim: bool = False, sim_camera: str | None = None) -> None:
        """Connect to a phone at ``url``, or start the in-process simulator (``sim=True``)."""
        await self.disconnect()
        if sim:
            from .sim.server import SimPhone

            if sim_camera:
                self.config.sim.camera = sim_camera
            self._sim = SimPhone(self.config.sim)
            try:
                url = await self._sim.start(port=self.config.sim.port)
            except OSError:
                url = await self._sim.start(port=0)
            self.simulated = True
        if not url:
            raise PhoneError("no phone URL given")
        self.phone_url = url
        self.phone = PhoneClient(url, self.config.phone.connect_timeout_s)
        self._phone_stop = asyncio.Event()
        self.phone_state = "connecting"
        self._phone_task = asyncio.create_task(
            run_with_reconnect(
                self.phone,
                self._on_message,
                self._phone_stop,
                on_connect=self._on_connect,
                on_state=self._on_phone_state,
                base_delay_s=self.config.phone.reconnect_s,
                clock_sync_interval_s=self.config.phone.clock_sync_interval_s,
            ),
            name="phonegaze-phone",
        )

    async def connect_replay(self, recording: str | Path, *, speed: float = 1.0, loop: bool = True) -> None:
        """Feed a recorded session through the engine as if it came from the phone."""
        from .replay import play, read_session

        await self.disconnect()
        path = Path(recording).expanduser()
        session = read_session(path)
        if session.get("screen") and not self._screen_injected:
            try:
                self._set_screen(ScreenInfo.from_dict(session["screen"]))
            except (KeyError, TypeError, ValueError):
                pass
        self.replaying = path
        self.phone_url = f"replay:{path}"
        self._phone_stop = asyncio.Event()
        self.phone_state = "connected"

        async def run() -> None:
            await play(path, self._on_message, self._phone_stop, speed=speed, loop=loop)
            self.phone_state = "disconnected"
            self.phone_detail = "replay finished"

        self._phone_task = asyncio.create_task(run(), name="phonegaze-replay")

    async def disconnect(self) -> None:
        if self._phone_stop is not None:
            self._phone_stop.set()
        if self._phone_task is not None:
            self._phone_task.cancel()
            try:
                await self._phone_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._phone_task = None
        self._phone_stop = None
        if self.phone is not None:
            await self.phone.close()
        self.phone = None
        if self._sim is not None:
            try:
                await self._sim.stop()
            except Exception:  # noqa: BLE001
                pass
            self._sim = None
        self.simulated = False
        self.replaying = None
        self.phone_state = "disconnected"
        self.phone_status = None
        self.upright.reset()
        self.roi_placer.reset()

    def _on_phone_state(self, state: str, detail: str) -> None:
        if state != self.phone_state:
            log.info("phone %s: %s", state, detail)
            if state == "connected":
                self._connected_at = time.monotonic()
        self.phone_state = state
        self.phone_detail = detail

    def _to_local(self, t_phone: float) -> float | None:
        return self.phone.clock.to_local(t_phone) if self.phone is not None else None

    def stream_config_body(self) -> dict[str, Any]:
        s = self.config.stream
        body: dict[str, Any] = {
            "maxFps": s.max_fps,
            "wide": {"enabled": True, "width": s.wide_width, "quality": s.wide_quality, "every": s.wide_every},
            "roiQuality": s.roi_quality,
            "roiSource": s.roi_source,
            "arkit": True,
            "depth": bool(getattr(s, "depth", False)),
        }
        if s.roi_source != "mac":
            body["rois"] = []
        return body

    async def send_stream_config(self) -> None:
        if self.phone is None:
            return
        try:
            self.stream_config = await self.phone.set_stream_config(self.stream_config_body())
        except PhoneError as exc:
            self.log("warning", f"The phone refused the stream settings: {exc}")
        self.roi_placer.sent = {}

    async def _on_connect(self) -> None:
        assert self.phone is not None
        self.phone_status = await self.phone.status()
        await self.send_stream_config()
        state = (self.phone_status or {}).get("state") or {}
        if state.get("mode", "idle") == "idle":
            cam = self._default_camera()
            if cam is not None:
                lens = self.config.lens
                zoom = lens.zoom if cam.get("type") != "arkit" else 1.0
                try:
                    self.phone_status = await self.phone.configure(cam["id"], lens.max_width, lens.fps, zoom)
                except PhoneError as exc:
                    self.log("warning", f"Could not start camera {cam.get('name') or cam['id']}: {exc}")
        await self.send_lens_controls(only_non_default=True)
        if self.config.lens.aim_on_start and self._aim_task is None:
            self._aim_task = asyncio.create_task(self._aim_later())

    async def _aim_later(self) -> None:
        await asyncio.sleep(2.0)
        self._aim_task = None
        await self.start_aim()

    def _default_camera(self) -> dict[str, Any] | None:
        cams = list((self.phone_status or {}).get("cameras") or [])
        if not cams:
            return None
        if self.config.lens.camera_id:
            for c in cams:
                if c.get("id") == self.config.lens.camera_id:
                    return c
        prefer = getattr(self.config.lens, "camera_prefer", "auto")
        if prefer != "auto":
            cam = lens_mod.camera_for_preference(cams, prefer)
            if cam is not None:
                return cam
        if self.simulated:
            want = self.config.sim.camera
            for c in cams:
                if want == "arkit" and c.get("type") == "arkit":
                    return c
                if want == "front" and c.get("position") == "front" and c.get("type") == "wide":
                    return c
                if c.get("type") == want and c.get("position") == "back":
                    return c
        ranked = lens_mod.pick_cameras(cams)
        return ranked[0] if ranked else None

    async def _on_message(self, msg: Message, t_received: float) -> None:
        if self.recorder is not None:
            self.recorder.write_message(msg, t_received)
        kind = msg.type
        if kind == "hello":
            screen = ((msg.header.get("sim") or {}).get("screen")) if isinstance(msg.header.get("sim"), dict) else None
            if screen and not self._screen_injected:
                try:
                    self._set_screen(ScreenInfo.from_dict(screen))
                    log.info("using the simulator's screen: %s x %s pt", self.screen.width, self.screen.height)
                except (KeyError, TypeError, ValueError):
                    pass
            if msg.header.get("streamConfig"):
                self.stream_config = msg.header["streamConfig"]
            self.roi_placer.sent = {}
        elif kind == "status":
            if self.phone_status is not None and isinstance(msg.header.get("state"), dict):
                self.phone_status["state"] = msg.header["state"]
        elif kind == "frame":
            try:
                frame = Frame.from_message(msg, t_received)
            except (KeyError, TypeError, ValueError) as exc:
                if _log_allowed("bad-frame"):
                    log.warning("skipping malformed frame: %s", exc)
                return
            self.submit_frame(frame)

    def submit_frame(self, frame: Frame) -> None:
        """Hand a frame to the loop. Only the newest unprocessed frame is kept."""
        if self._latest is not None:
            self.dropped += 1
        if frame.t_received is None:
            frame.t_received = time.monotonic()
        self._last_received_at = frame.t_received  # the watchdog counts frames received, not processed
        self._latest = frame
        if self._frame_event is not None:
            self._frame_event.set()

    # ------------------------------------------------------------------------------------------
    # Frame loop
    # ------------------------------------------------------------------------------------------

    async def _frame_loop(self) -> None:
        assert self._frame_event is not None
        loop = asyncio.get_running_loop()
        while self.running:
            await self._frame_event.wait()
            self._frame_event.clear()
            frame, self._latest = self._latest, None
            if frame is None:
                continue
            if frame.t_received is not None and time.monotonic() - frame.t_received > STALE_FRAME_S:
                self.dropped += 1
                continue
            try:
                decoded, obs, timings = await loop.run_in_executor(self._executor, self._process_sync, frame)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad frame must not stop the loop
                if _log_allowed("process"):
                    log.exception("frame %s failed", frame.seq)
                continue
            try:
                self._after_frame(frame, decoded, obs, timings)
            except Exception:  # noqa: BLE001
                if _log_allowed("after"):
                    log.exception("post-processing frame %s failed", frame.seq)

    def _process_sync(self, frame: Frame) -> tuple[DecodedFrame, Observation, dict[str, float]]:
        """Worker thread: upright decode and the estimator chain."""
        timings: dict[str, float] = {}
        t0 = time.perf_counter()
        rotation = self.upright.update(frame.gravity, frame.camera.position)
        decoded = DecodedFrame.from_frame(frame, rotation)
        timings["decode"] = (time.perf_counter() - t0) * 1000.0
        t1 = time.perf_counter()
        obs = run_estimators(list(self.estimators), decoded, timings)
        timings["estimators"] = (time.perf_counter() - t1) * 1000.0
        sim = frame.header.get("sim") if frame.header else None
        if sim is not None:
            obs.extra["sim"] = sim
        if self._want_quality():
            t2 = time.perf_counter()
            self.quality = self._measure_quality(decoded, obs)
            timings["quality"] = (time.perf_counter() - t2) * 1000.0
        return decoded, obs, timings

    def _want_quality(self) -> bool:
        return self._aim_samples is not None or self._quality_rate.ready()

    def _measure_quality(self, decoded: DecodedFrame, obs: Observation) -> dict[str, Any]:
        if self._quality_fn is None:
            try:
                from .vision.quality import measure_quality

                q = measure_quality(decoded, obs)
                self._quality_fn = measure_quality
                return dict(q)
            except NotImplementedError:
                self._quality_fn = lens_mod.basic_quality
            except Exception:  # noqa: BLE001
                if _log_allowed("quality"):
                    log.exception("measure_quality failed; using Core's basic quality")
                return lens_mod.basic_quality(decoded, obs)
        try:
            return dict(self._quality_fn(decoded, obs))
        except Exception:  # noqa: BLE001
            return lens_mod.basic_quality(decoded, obs)

    def _after_frame(self, frame: Frame, decoded: DecodedFrame, obs: Observation, timings: dict[str, float]) -> None:
        """Loop thread: calibration, models, filter, outputs, UI, recorder, lens control."""
        t0 = time.perf_counter()
        now = time.monotonic()
        self.last_frame, self.last_decoded, self.last_obs = frame, decoded, obs
        self.processed += 1
        self._fps_times.append(now)
        if obs.t_local is None:
            obs.t_local = frame.t_received
        self._recent_obs.append(obs)
        self._check_setup()

        zoom_stable = (frame.header.get("camera") or {}).get("zoomStable", True) if frame.header else True
        # Frames to hold on rather than estimate from: during a zoom change the image may still be
        # at the old zoom while the header has the new one (distance and gaze off by the zoom
        # ratio); in ARKit mode without a tracked face, only the image-based estimators ran, and
        # models fitted on ARKit's eyes must not be fed their output.
        arkit_lost = frame.camera.type == "arkit" and (frame.arkit is None or not frame.arkit.tracked)
        hold = zoom_stable is False or arkit_lost
        # second camera: the observation the models and calibration see (obs itself when off)
        obs_m = self._obs_m = self.second_camera.on_phone_frame(frame, obs)
        if self.active_run is not None and not hold:
            try:
                self.active_run.add(obs_m)
            except Exception:  # noqa: BLE001
                if _log_allowed("calib-add"):
                    log.exception("calibration add failed")

        if self._aim_samples is not None:
            self._aim_samples.append((dict(self.quality), frame.lens.adjusting_focus))

        raw = None if hold else self._predict(obs_m)
        fb_mode = getattr(self.config.outputs, "fallback_pointer", "off")
        if not hold and (fb_mode == "always" or (fb_mode == "uncalibrated" and self.active_model() is None)):
            raw = self.fallback.update(obs_m, self.screen, now, self.config.outputs, self.config.filters.points_per_degree)
            if raw is not None:
                raw.t_local = now
        raw = self.second_camera.fallback(obs_m, raw)  # second camera: wide head box
        if raw is not None and raw.valid:
            self.drift.add_prediction(self._gaze_time(raw), raw.x, raw.y)
            if self.drift_applied(now):
                cx, cy = self.drift.apply(raw.x, raw.y)
                raw = dataclasses.replace(raw, x=cx, y=cy, extra={**raw.extra, "drift_pt": self.drift.offset.tolist()})
        try:
            point = self.filter.update(raw, obs)
        except Exception:  # noqa: BLE001
            if _log_allowed("filter"):
                log.exception("filter failed; passing the raw point")
            point = raw
        point = self._off_screen_invalid(point)
        self.last_raw, self.last_gaze = raw, point

        if not self.paused:
            for sink in self.sinks:
                try:
                    sink.emit(point, obs)
                except Exception:  # noqa: BLE001
                    if _log_allowed(f"sink:{getattr(sink, 'name', sink)}"):
                        log.exception("output %s failed", getattr(sink, "name", sink))
            self.gaze_ws.emit(point, obs)

        if self.recorder is not None:
            self.recorder.write_observation(obs)
            if point is not None:
                self.recorder.write_gaze(point)
            if self.recorder.seconds > self.config.recording.max_minutes * 60:
                self.log("info", "Recording stopped: it reached the configured maximum length.")
                self.stop_recording()

        self._ui_messages(frame, decoded, obs, raw, point, now)
        self._lens_control(frame, decoded, self.second_camera.lens_obs(obs, decoded.intrinsics), now)  # second camera: wide head box
        timings["outputs"] = (time.perf_counter() - t0) * 1000.0
        if frame.t_received is not None:
            timings["total"] = (time.monotonic() - frame.t_received) * 1000.0
        for k, v in timings.items():
            old = self.timings_ms.get(k)
            self.timings_ms[k] = v if old is None else 0.9 * old + 0.1 * v

    OFF_SCREEN_FRACTION = 0.1
    """Gaze further outside the screen than this fraction of its width or height is reported as
    not valid (the cursor holds, ``/gaze`` repeats the last valid point)."""

    def _off_screen_invalid(self, point: GazePoint | None) -> GazePoint | None:
        scr = self.screen
        if point is None or not point.valid or scr is None:
            return point
        mx, my = self.OFF_SCREEN_FRACTION * scr.width, self.OFF_SCREEN_FRACTION * scr.height
        if -mx <= point.x <= scr.width + mx and -my <= point.y <= scr.height + my:
            return point
        return dataclasses.replace(point, valid=False)

    def active_model(self) -> GazeModel | None:
        pinned = self.config.models.pinned
        if pinned and pinned in self.models:
            return self.models[pinned]
        if self.chosen and self.chosen in self.models:
            return self.models[self.chosen]
        return None

    def _predict(self, obs: Observation) -> GazePoint | None:
        model = self.active_model()
        if model is None:
            return None
        try:
            point = model.predict(obs)
        except Exception:  # noqa: BLE001
            if _log_allowed(f"predict:{model.name}"):
                log.exception("model %s failed to predict", model.name)
            return None
        if point is not None:
            if not point.model:
                point.model = model.name
            if point.t_local is None:
                point.t_local = time.monotonic()
        return point

    def predict_all(self, obs: Observation) -> dict[str, GazePoint | None]:
        out: dict[str, GazePoint | None] = {}
        for name, model in self.models.items():
            try:
                out[name] = model.predict(obs)
            except Exception:  # noqa: BLE001
                out[name] = None
        return out

    def _ui_messages(self, frame: Frame, decoded: DecodedFrame, obs: Observation, raw: GazePoint | None, point: GazePoint | None, now: float) -> None:
        if not self._subscribers:
            return
        if point is not None and self._rates["gaze"].ready(now):
            msg = point.to_dict()
            msg["type"] = "gaze"
            msg["raw"] = raw.to_dict() if raw is not None else None
            self.broadcast(msg)
        if self._rates["obs"].ready(now):
            self.broadcast({"type": "obs", **obs.to_dict()})
        if self.models and self._rates["predictions"].ready(now):
            preds = self.predict_all(self._obs_m or obs)  # second camera
            dicts = {k: (v.to_dict() if v else None) for k, v in preds.items()}
            # Model names at the top level (as INTERFACES.md lists) and under "predictions".
            self.broadcast({**{k: v for k, v in dicts.items() if k not in ("type", "predictions")}, "type": "predictions", "predictions": dicts})
        if self._rates["frame"].ready(now):
            self.broadcast({"type": "frame", "seq": frame.seq, "t": frame.t, "fps": self.fps, "images": sorted(decoded.images)})

    @property
    def fps(self) -> float | None:
        if len(self._fps_times) < 2:
            return None
        newest = self._fps_times[-1]
        recent = [t for t in self._fps_times if newest - t <= 3.0]
        if len(recent) < 2 or recent[-1] == recent[0]:
            return None
        return (len(recent) - 1) / (recent[-1] - recent[0])

    # ------------------------------------------------------------------------------------------
    # Lens control: eye crops, live zoom, hints
    # ------------------------------------------------------------------------------------------

    def _lens_control(self, frame: Frame, decoded: DecodedFrame, obs: Observation, now: float) -> None:
        self.hints = lens_mod.aim_hints(obs, self.quality, decoded.width, decoded.height, adjusting_focus=frame.lens.adjusting_focus) if self.quality else self.hints
        if self.phone is None:
            return
        self.roi_placer.smoothing = float(getattr(self.config.stream, "roi_smoothing", self.roi_placer.smoothing))
        self.roi_placer.move_fraction = float(getattr(self.config.stream, "roi_move_fraction", self.roi_placer.move_fraction))
        self._focus_on_eye(decoded, obs, now)
        if self.config.stream.roi_source == "mac" and (self._roi_task is None or self._roi_task.done()):
            plan = self.roi_placer.plan(decoded, obs)
            if plan is not None and self.roi_placer.should_send(plan):
                self.roi_placer.mark_sent(plan)
                self._roi_task = asyncio.create_task(self._send_rois(plan.rois))
        if (
            self.config.lens.auto_zoom
            and frame.mode == "camera"
            and self._aim_samples is None
            and (self._zoom_task is None or self._zoom_task.done())
        ):
            self.zoom_ctl.target = self.config.lens.zoom
            self.zoom_ctl.edge_margin = self.config.lens.edge_margin
            lc = self.config.lens
            self.zoom_ctl.stable_s = float(getattr(lc, "zoom_stable_s", self.zoom_ctl.stable_s))
            self.zoom_ctl.cooldown_s = float(getattr(lc, "zoom_cooldown_s", self.zoom_ctl.cooldown_s))
            self.zoom_ctl.lost_s = float(getattr(lc, "zoom_lost_s", self.zoom_ctl.lost_s))
            new_zoom = self.zoom_ctl.decide(obs, decoded.width, decoded.height, frame.camera.zoom, now)
            if new_zoom is not None and abs(new_zoom - frame.camera.zoom) > 1e-3:
                self.zoom_ctl.note_switch(now)
                self._zoom_task = asyncio.create_task(self._apply_zoom(new_zoom, auto=True))

    async def _send_rois(self, rois: list[dict[str, Any]]) -> None:
        if self.phone is None:
            return
        try:
            await self.phone.set_stream_config({"rois": rois})
        except PhoneError as exc:
            self.roi_placer.sent = {}
            if _log_allowed("rois"):
                log.warning("sending eye crops failed: %s", exc)

    async def _apply_zoom(self, zoom: float, auto: bool = False) -> None:
        if self.phone is None:
            return
        try:
            self.phone_status = await self.phone.set_zoom(zoom)
            self.roi_placer.sent = {}
            if self.recorder is not None:
                self.recorder.write_event({"type": "zoom", "zoom": zoom, "auto": auto})
            if auto:
                log.info("auto zoom: %.2gx", zoom)
            self.drift.reanchor("zoom changed")
        except PhoneError as exc:
            if _log_allowed("zoom"):
                self.log("warning", f"Zoom change failed: {exc}")

    async def set_zoom(self, zoom: float) -> None:
        self.zoom_ctl.note_switch(time.monotonic())
        await self._apply_zoom(zoom)

    async def set_camera(self, camera_id: str, zoom: float | None = None, fps: float | None = None, max_width: int | None = None) -> None:
        if self.phone is None:
            raise PhoneError("no phone connected")
        lens = self.config.lens
        changes: dict[str, Any] = {"lens.camera_id": camera_id}
        if zoom is not None:
            changes["lens.zoom"] = zoom
        if fps is not None:
            changes["lens.fps"] = fps
        if max_width is not None:
            changes["lens.max_width"] = max_width
        update(self.config, changes)
        self._save_config()
        self.phone_status = await self.phone.configure(camera_id, lens.max_width, lens.fps, lens.zoom)
        self._camera_changed()
        if self.recorder is not None:
            self.recorder.write_event({"type": "camera", "camera_id": camera_id, "zoom": lens.zoom})

    def _focus_on_eye(self, decoded: DecodedFrame, obs: Observation, now: float) -> None:
        """``lens.focus_on_eye``: every ``focus_on_eye_s``, focus (and meter) on the left eye."""
        lc = self.config.lens
        if not getattr(lc, "focus_on_eye", False) or self.phone is None or getattr(lc, "focus_locked", "default") == "locked":
            return
        if decoded.frame.mode != "camera" or now - self._focus_eye_at < float(getattr(lc, "focus_on_eye_s", 5.0)):
            return
        if self._focus_task is not None and not self._focus_task.done():
            return
        eye = obs.left if obs.left.iris_center is not None else obs.right
        if eye.iris_center is None or not decoded.width or not decoded.height:
            return
        self._focus_eye_at = now
        x, y = eye.iris_center[0] / decoded.width, eye.iris_center[1] / decoded.height

        async def go() -> None:
            try:
                await self.focus(x, y)
            except PhoneError as exc:
                if _log_allowed("focus-eye", 60):
                    log.warning("focus on the eye failed: %s", exc)

        self._focus_task = asyncio.ensure_future(go())

    async def send_lens_controls(self, paths: list[str] | None = None, only_non_default: bool = False) -> None:
        """Send ``lens.exposure_bias`` and the other camera controls with ``POST /api/lens``."""
        if self.phone is None:
            return
        body = lens_mod.lens_controls_body(self.config.lens, paths, only_non_default=only_non_default)
        if not body:
            return
        try:
            self.phone_status = await self.phone.request("POST", "/api/lens", body)
            self.lens_controls = {"sent": body, "error": ""}
        except PhoneError as exc:
            self.lens_controls = {"sent": body, "error": str(exc)}
            if _log_allowed("lens-controls", 30):
                self.log("warning", f"The phone did not take the camera controls ({', '.join(body)}): {exc}. ARKit mode and an idle camera refuse them.")

    def _camera_changed(self) -> None:
        if self._loop is not None and self.phone is not None and (self._lens_ctl_task is None or self._lens_ctl_task.done()):
            try:
                self._lens_ctl_task = self._loop.create_task(self.send_lens_controls(only_non_default=True))
            except RuntimeError:
                pass
        self.fallback.reset()
        self._drift_reset("camera changed")
        self.upright.reset()
        self.roi_placer.reset()
        self.zoom_ctl.note_switch(time.monotonic())
        for est in self.estimators:
            try:
                est.reset()
            except Exception:  # noqa: BLE001
                pass

    async def focus(self, x: float | None = None, y: float | None = None, locked: bool | None = None) -> None:
        """``x``, ``y``: 0-1 of the UPRIGHT wide image; converted to normalised sensor coordinates."""
        if self.phone is None:
            raise PhoneError("no phone connected")
        point = None
        if x is not None and y is not None:
            point = self.upright_to_sensor_normalized(float(x), float(y))
        self.phone_status = await self.phone.set_focus(locked=locked, point=point)

    def upright_to_sensor_normalized(self, x: float, y: float) -> tuple[float, float]:
        d = self.last_decoded
        if d is None:
            return (x, y)
        sx, sy = apply_affine(d.upright_to_sensor, (x * d.width, y * d.height))
        return (sx / d.frame.camera.width, sy / d.frame.camera.height)

    # -- aiming ----------------------------------------------------------------------------

    async def start_aim(self, cameras: list[str] | None = None, zooms: list[float] | None = None) -> None:
        if self.phone is None:
            raise PhoneError("no phone connected")
        if self._aim_task is not None and not self._aim_task.done():
            return
        self._aim_task = asyncio.create_task(self.aim_search(cameras, zooms))

    async def aim_search(self, cameras: list[str] | None = None, zooms: list[float] | None = None, settle_s: float = 1.0, measure_s: float = 1.5) -> dict[str, Any]:
        """Try each camera and zoom for a moment; keep the best by :func:`lens.aim_score`."""
        assert self.phone is not None
        phone = self.phone
        results: list[dict[str, Any]] = []
        self.aim = {"phase": "trying", "results": results}
        try:
            status = await phone.status()
            cams = list(status.get("cameras") or [])
            previous = (status.get("state") or {}).get("cameraId")
            if cameras:
                tries = [c for c in cams if c.get("id") in cameras]
            else:
                tries = [c for c in lens_mod.pick_cameras(cams) if c.get("type") != "arkit"]
            lens = self.config.lens
            for cam in tries:
                options = lens_mod.zoom_options(cam, zooms)
                try:
                    await phone.configure(cam["id"], lens.max_width, lens.fps, options[0])
                except PhoneError as exc:
                    results.append({"camera_id": cam["id"], "zoom": options[0], "score": 0.0, "error": str(exc)})
                    continue
                self._camera_changed()
                for i, z in enumerate(options):
                    if i > 0:
                        try:
                            await phone.set_zoom(z)
                        except PhoneError as exc:
                            results.append({"camera_id": cam["id"], "zoom": z, "score": 0.0, "error": str(exc)})
                            continue
                        self.roi_placer.reset()
                    self.broadcast({"type": "aim", "phase": "trying", "camera_id": cam["id"], "zoom": z, "quality": self.quality, "results": results})
                    await asyncio.sleep(settle_s)
                    self._aim_samples = []
                    await asyncio.sleep(measure_s)
                    samples, self._aim_samples = self._aim_samples or [], None
                    quality = _summarise_quality([q for q, _ in samples])
                    adjusting = bool(samples) and sum(1 for _, a in samples if a) > len(samples) / 2
                    score = lens_mod.aim_score(quality, adjusting_focus=adjusting)
                    results.append({"camera_id": cam["id"], "camera_name": cam.get("name"), "type": cam.get("type"), "position": cam.get("position"), "zoom": z, "quality": quality, "frames": len(samples), "score": score})
                    self.broadcast({"type": "aim", "phase": "trying", "camera_id": cam["id"], "zoom": z, "quality": quality, "results": results})
            best = max(results, key=lambda r: r.get("score", 0.0), default=None)
            if best is None or best.get("score", 0.0) <= 0:
                self.aim = {"phase": "failed", "results": results}
                self.broadcast({"type": "aim", "phase": "failed", "camera_id": None, "zoom": None, "quality": {}, "results": results})
                self.log("warning", "Aiming found no eyes with any camera. Point the phone at your face and try again.")
                if previous:
                    try:
                        await phone.configure(previous, lens.max_width, lens.fps, lens.zoom)
                    except PhoneError:
                        pass
                return self.aim
            update(self.config, {"lens.camera_id": best["camera_id"], "lens.zoom": float(best["zoom"])})
            self._save_config()
            await phone.configure(best["camera_id"], lens.max_width, lens.fps, float(best["zoom"]))
            self._camera_changed()
            if lens.lock_focus_after_aim:
                await asyncio.sleep(settle_s)
                try:
                    centers = lens_mod.eye_centers(self.last_obs)
                    point = None
                    if centers and self.last_decoded is not None:
                        cx = float(np.mean([c[0] for c in centers.values()])) / self.last_decoded.width
                        cy = float(np.mean([c[1] for c in centers.values()])) / self.last_decoded.height
                        point = self.upright_to_sensor_normalized(cx, cy)
                    await phone.set_focus(locked=True, point=point)
                except PhoneError as exc:
                    log.info("focus lock after aiming failed: %s", exc)
            self.aim = {"phase": "done", "results": results, "best": best}
            self.broadcast({"type": "aim", "phase": "done", "camera_id": best["camera_id"], "zoom": best["zoom"], "quality": best.get("quality", {}), "results": results})
            return self.aim
        except PhoneError as exc:
            self.aim = {"phase": "failed", "results": results, "error": str(exc)}
            self.broadcast({"type": "aim", "phase": "failed", "camera_id": None, "zoom": None, "quality": {}, "results": results})
            self.log("error", f"Aiming failed: {exc}")
            return self.aim
        finally:
            self._aim_samples = None

    # ------------------------------------------------------------------------------------------
    # Calibration
    # ------------------------------------------------------------------------------------------

    def start_calibration(self, kind: str, pose_rounds: int | None = None, targets: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Start a run. ``pose_rounds`` (grid only) overrides ``calibration.pose_rounds`` for this
        run, so the UI's choice applies even if its config change has not landed yet. ``targets``
        (validate / refine only: the touch-up flow) replaces the configured dots."""
        if kind not in ("grid", "pursuit", "refine", "validate"):
            raise ValueError(f"unknown calibration kind {kind!r}")
        if kind in ("refine", "validate") and not self.models:
            raise ValueError("calibrate first: there is no fitted model to refine or validate")
        if self.screen is None:
            raise ValueError("the screen size is not known yet")
        self._run_counter += 1
        run_id = f"r{self._run_counter}"
        c = self.config.calibration
        if targets and kind in ("validate", "refine"):
            targets = [calib.Target(i, float(t["x"]), float(t["y"])) for i, t in enumerate(targets)]
        else:
            try:
                targets = calib.config_targets(c, self.screen, kind)
            except NotImplementedError:
                targets = _fallback_targets(self.screen, kind, c.refine_points, c.validate_points, c.grid, c.margin)
        make_run = getattr(calib, "make_run", None)
        if make_run is not None:
            self.active_run = make_run(c, run_id, kind, list(targets), self.screen)
        else:
            self.active_run = calib.CalibrationRun(run_id=run_id, kind=kind, targets=list(targets), screen=self.screen)
        self._pursuit_dot = None
        self._sim_pose_group = None
        self._sim_head_base = None
        self.filter_reset()
        plan = {
            "run_id": run_id,
            "kind": kind,
            "targets": [t.to_dict() for t in targets],
            "settle_ms": c.settle_ms,
            "collect_ms": c.collect_ms,
            "pose_rounds": max(1, min(10, int(pose_rounds if pose_rounds is not None else c.pose_rounds))) if kind == "grid" else 1,
            "screen": {"width": self.screen.width, "height": self.screen.height, "source": self.screen.source},
        }
        if hasattr(calib, "plan_extras"):
            plan.update(calib.plan_extras(c, kind, self.screen))
        if self.recorder is not None:
            self.recorder.write_event({"type": "calib.start", **plan})
        return plan

    def calib_dot(self, msg: dict[str, Any]) -> None:
        run = self.active_run
        if run is None or msg.get("run_id") != run.run_id:
            return
        state = msg.get("state")
        try:
            dot_id = int(msg["dot_id"])
            x, y = float(msg["x"]), float(msg["y"])
        except (KeyError, TypeError, ValueError):
            return
        now = time.monotonic()
        if self.recorder is not None:
            self.recorder.write_event({"type": "calib.dot", "run_id": run.run_id, "kind": run.kind, "dot_id": dot_id, "x": x, "y": y, "state": state, "pose_group": msg.get("pose_group", 0), "t_local": now})
        if self.simulated and state == "show" and run.kind == "grid":
            try:
                pg = int(msg.get("pose_group") or 0)
            except (TypeError, ValueError):
                pg = 0
            if pg != self._sim_pose_group:
                self._sim_pose(pg)
        if self.simulated and state in ("show", "collect"):
            self._sim_look(x, y)
        if self.simulated and state == "collect" and dot_id in getattr(run, "sweep_ids", ()):
            self._sim_head_sweep()
        if state == "collect":
            if run.kind == "pursuit":
                if self._pursuit_dot is not None and self._pursuit_dot != dot_id:
                    run.end_dot(self._pursuit_dot, now)
                    self._pursuit_dot = None
                if self._pursuit_dot is None:
                    run.begin_dot(dot_id, x, y, now)
                    self._pursuit_dot = dot_id
            else:
                pg = msg.get("pose_group")
                try:
                    pose_group = None if pg is None else int(pg)
                except (TypeError, ValueError):
                    pose_group = None
                run.begin_dot(dot_id, x, y, now, pose_group=pose_group)
        elif state == "done":
            run.end_dot(dot_id, now)
            if self._pursuit_dot == dot_id:
                self._pursuit_dot = None

    # Head poses the simulated person takes for calibration rounds 1, 2, ... (round 0 is where the
    # head was): metres sideways, down, towards the screen; yaw, pitch, roll in degrees.
    SIM_POSES = [(0.04, 0.0, 0.0, 6.0, 0.0, 0.0), (-0.04, 0.01, -0.04, -6.0, 3.0, 0.0), (0.0, -0.02, 0.05, 0.0, -5.0, 2.0), (0.03, 0.02, -0.03, 4.0, 4.0, -2.0)]

    def _sim_pose(self, pose_group: int) -> None:
        """Simulator only: move the simulated head for a new calibration round, as the UI asks a
        person to do, so multi-position calibrations learn head movement in the simulator too."""
        self._sim_pose_group = pose_group
        phone = self.phone
        if phone is None:
            return

        async def go() -> None:
            try:
                if self._sim_head_base is None:
                    scene = await phone.request("GET", "/sim/scene")
                    self._sim_head_base = [float(v) for v in scene["headPositionWorld"]]
                base = self._sim_head_base
                if pose_group <= 0:
                    body = {"position": base, "rotation": [0.0, 0.0, 0.0]}
                else:
                    dx, dy, dz, yaw, pitch, roll = self.SIM_POSES[(pose_group - 1) % len(self.SIM_POSES)]
                    # World z points from the screen towards the person: "towards the screen" is -z.
                    body = {"position": [base[0] + dx, base[1] + dy, base[2] - dz], "rotation": [yaw, pitch, roll]}
                await phone.request("POST", "/sim/head", body)
            except Exception as exc:  # noqa: BLE001
                if _log_allowed("sim-head"):
                    log.warning("simulator /sim/head failed: %s", exc)

        asyncio.ensure_future(go())

    def _sim_head_sweep(self) -> None:
        """Simulator only: turn and move the simulated head during a head-sweep dot
        (``calibration.sim_head_sweep``), as the UI asks a person to."""
        phone = self.phone
        if phone is None:
            return
        asyncio.ensure_future(calib.sim_head_sweep(phone.request, float(self.config.calibration.sweep_s)))

    def calibration_check(self, run_id: str) -> dict[str, Any]:
        """The quality gate (``calibration.quality_gate``): dots of the active grid run worth
        showing again, worst first. The UI shows them in the same run, then finishes."""
        run = self.active_run
        if run is None or run.run_id != run_id:
            raise ValueError(f"no active calibration run {run_id!r}")
        if not self.config.calibration.quality_gate:
            return {"run_id": run_id, "retry": []}
        return _jsonable({"run_id": run_id, "retry": calib.quality_gate(run, self.config.calibration)})

    def _sim_restore_pose(self) -> None:
        if self.simulated and self._sim_pose_group not in (None, 0):
            self._sim_pose(0)
        self._sim_pose_group = None
        self._sim_head_base = None

    def _sim_look(self, x: float, y: float) -> None:
        if self.phone is None or (self._sim_gaze_task is not None and not self._sim_gaze_task.done()):
            return

        async def go() -> None:
            try:
                await self.phone.sim_gaze(x, y)  # type: ignore[union-attr]
            except PhoneError as exc:
                if _log_allowed("sim-gaze"):
                    log.warning("simulator /sim/gaze failed: %s", exc)

        self._sim_gaze_task = asyncio.create_task(go())

    async def finish_calibration(self, run_id: str, commit: bool = True) -> dict[str, Any]:
        """Fit (grid, pursuit), refine or validate on the run's samples.

        ``commit=False`` (grid and pursuit only) fits and reports but keeps the models in use and
        the saved profile as they were: the full calibration's moving-dot phase uses it, so that
        cancelling the grid that follows does not leave the moving-dot fit in charge."""
        run = self.active_run
        if run is None or run.run_id != run_id:
            raise ValueError(f"no active calibration run {run_id!r}")
        if self._pursuit_dot is not None:
            run.end_dot(self._pursuit_dot, time.monotonic())
            self._pursuit_dot = None
        self.active_run = None
        self._sim_restore_pose()
        assert self.screen is not None
        screen = self.screen
        samples = list(run.samples)
        answer: dict[str, Any] = {"run_id": run.run_id, "kind": run.kind, "reports": [], "chosen": self.chosen, "n_samples": len(samples)}
        if run.kind in ("grid", "pursuit") and not commit:
            result = await asyncio.to_thread(calib.fit_all, samples, screen, self._new_models())
            answer["reports"] = [r.to_dict() for r in result.reports]
            answer["chosen"] = result.chosen
            answer["committed"] = False
            if run.kind == "pursuit":
                self._pursuit_samples = samples  # merged into the grid fit that follows (calibration.pursuit_merge)
        elif run.kind in ("grid", "pursuit"):
            pursuit, self._pursuit_samples = (self._pursuit_samples if run.kind == "grid" else []), []
            result = await asyncio.to_thread(calib.fit_with_options, samples, screen, self._new_models, self.config.calibration, pursuit)
            answer["calibration_info"] = result.info
            answer["run_dots"] = getattr(run, "dots", [])
            self._validation_pool = []
            fitted = {name: m for name, m in result.models.items()}
            ok = {r.model for r in result.reports if r.ok}
            self.models = {k: v for k, v in fitted.items() if k in ok} or fitted
            self.reports = list(result.reports)
            self.chosen = result.chosen
            self.models_setup = self._current_setup()
            self.validation = {}
            answer["reports"] = [r.to_dict() for r in result.reports]
            answer["chosen"] = result.chosen
            self._save_profile(result)
            self._drift_reset("new calibration")
            self.second_camera.calibrated()  # second camera: reference pose for track_phone
        elif run.kind == "refine":
            reports = []
            for name, model in list(self.models.items()):
                try:
                    rep = await asyncio.to_thread(calib.refine, model, samples, screen)
                except Exception as exc:  # noqa: BLE001
                    rep = FitReport(model=name, ok=False, message=f"refine failed: {exc}")
                reports.append(rep)
            answer["reports"] = [r.to_dict() for r in reports]
            self._save_profile(calib.CalibrationResult(self.reports, self.chosen, self.models))
            self._drift_reset("quick refine")
        elif run.kind == "validate":
            validation: dict[str, Any] = {}
            for name, model in list(self.models.items()):
                try:
                    validation[name] = await asyncio.to_thread(calib.validation_metrics, model, samples, screen)
                except Exception as exc:  # noqa: BLE001
                    validation[name] = {"error": str(exc)}
            self.validation = validation
            answer["validation"] = validation
            # Error map (calibration.error_map) from every validation dot since the calibration;
            # the numbers above were measured before it changed, on dots it had not seen.
            self._validation_pool = calib.pool_validation(self._validation_pool, samples)
            maps = {}
            for name, model in list(self.models.items()):
                try:
                    maps[name] = await asyncio.to_thread(calib.fit_validation_error_map, model, self._validation_pool, screen, self.config.calibration)
                except Exception as exc:  # noqa: BLE001
                    maps[name] = {"kept": False, "reason": f"failed: {exc}"}
            answer["error_map"] = maps
            chosen_val = validation.get(self.chosen or "") or {}
            answer["touchup"] = [t.to_dict() for t in calib.touchup_targets(chosen_val, int(self.config.calibration.touchup_dots))] if chosen_val.get("per_dot") else []
            self._save_profile(calib.CalibrationResult(self.reports, self.chosen, self.models))
        self.filter_reset()
        answer = _jsonable(answer)
        self.broadcast({"type": "calib.report", **answer})
        if self.recorder is not None:
            self.recorder.write_event({"type": "calib.finish", **answer})
            self.recorder.write_calibration({"run_id": run.run_id, "kind": run.kind, "samples": [s.to_dict() for s in samples], **answer})
        return answer

    def cancel_calibration(self, run_id: str) -> None:
        if self.active_run is not None and self.active_run.run_id == run_id:
            self.active_run = None
            self._pursuit_dot = None
            self._sim_restore_pose()
            if self.recorder is not None:
                self.recorder.write_event({"type": "calib.cancel", "run_id": run_id})

    def _save_profile(self, result: Any) -> None:
        setup = self._current_setup()
        if self.profile_dir is None or self.screen is None or setup is None:
            return
        try:
            calib.Profile(self._profile_path(setup)).save(result, self.screen, camera=setup["camera"])
        except NotImplementedError:
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("saving the calibration profile failed: %s", exc)

    def pin_model(self, name: str) -> None:
        if name and name not in self.models and name not in (self.config.models.candidates or []):
            raise ValueError(f"unknown model {name!r}")
        before = getattr(self.active_model(), "name", None)
        update(self.config, {"models.pinned": name})
        self._save_config()
        if getattr(self.active_model(), "name", None) != before:
            self._drift_reset("model changed")

    def filter_reset(self) -> None:
        try:
            self.filter.reset()
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------------------------------------
    # Drift correction from selections (models/drift.py)
    # ------------------------------------------------------------------------------------------

    DRIFT_APPLY_S = 120.0
    """Without a Forsee client on ``/gaze``, the drift offset is applied only this long after the
    last look-point, so the standalone cursor is left alone when nothing teaches it."""

    def _gaze_time(self, point: GazePoint) -> float:
        """The engine time ``/gaze`` stamps on this point (what Forsee's ``t`` refers to)."""
        t = None
        try:
            t = self._to_local(point.t)
        except Exception:  # noqa: BLE001
            t = None
        if t is None:
            t = point.t_local if point.t_local is not None else time.monotonic()
        return float(t)

    def drift_applied(self, now: float | None = None) -> bool:
        """Whether the learned offset is added to the output now: the setting is on, it has
        learned from a selection since the last reset, and selections are still coming (a Forsee
        client is connected to ``/gaze``, or a look-point arrived recently)."""
        if not self.config.calibration.drift_correction or self.drift.used_since_reset == 0:
            return False
        if self.gaze_ws.clients:
            return True
        now = time.monotonic() if now is None else now
        last = self.drift.last_selection_t
        return last is not None and now - last <= self.DRIFT_APPLY_S

    def _drift_ppd(self) -> float:
        dist = self.last_obs.distance if self.last_obs is not None else None
        return points_per_degree(self.screen, dist, float(self.config.filters.points_per_degree))

    def _drift_reset(self, reason: str) -> None:
        if self.drift.used_since_reset or self.drift.offset.any():
            log.info("drift correction reset: %s", reason)
        self.drift.reset(reason)

    def drift_state(self) -> dict[str, Any]:
        st = self.drift.stats(self._drift_ppd())
        st["enabled"] = bool(self.config.calibration.drift_correction)
        st["applied"] = self.drift_applied()
        st["clicks"] = bool(self.config.calibration.drift_clicks)
        return _jsonable(st)

    def lookpoint(
        self,
        x: float,
        y: float,
        t: float | None = None,
        *,
        rect: Any = None,
        kind: str = "dwell",
        sel_id: Any = None,
    ) -> dict[str, Any]:
        """A known look-point: a key selected in Forsee by dwell, a target on the Live page, or
        (``kind="click"``) a mouse click. ``t`` is engine time of the selection (default: now);
        ``rect`` the target's ``{x, y, width, height}`` in screen points, if known; ``sel_id`` lets
        :meth:`lookpoint_undo` take it back. Always scored; learned from by the drift corrector
        (clicks only when ``calibration.drift_clicks``). Returns the outcome."""
        now = time.monotonic()
        kind = "click" if kind == "click" else "dwell"
        box = _parse_rect(rect)
        t_sel = float(t) if isinstance(t, (int, float)) and math.isfinite(t) else now
        if t_sel > now + 1.0 or t_sel < now - 10.0:
            t_sel = now  # a clock the engine does not share; the sample at hand is the best guess
        sid = None if sel_id is None else str(sel_id)
        if kind == "click" and not self.config.calibration.drift_clicks:
            outcome: dict[str, Any] = {"used": False, "reason": "clicks are switched off"}
        elif self.screen is None or self.active_model() is None:
            outcome = {"used": False, "reason": "not calibrated"}
        else:
            outcome = self.drift.selection(float(x), float(y), t_sel, self._drift_ppd(), rect=box, kind=kind, sel_id=sid, applied=self.drift_applied(now))
        if self.recorder is not None:
            self.recorder.write_event({"type": "lookpoint", "x": x, "y": y, "t": t_sel, "rect": list(box) if box else None, "kind": kind, "id": sid, "outcome": outcome})
        return _jsonable(outcome)

    def lookpoint_undo(self, sel_id: Any) -> bool:
        """The look-point ``sel_id`` was undone in the app (backspace or undo straight after it)."""
        if sel_id is None:
            return False
        sid = str(sel_id)
        changed = self.drift.undo(sid, time.monotonic())
        if self.recorder is not None:
            self.recorder.write_event({"type": "lookpoint.undo", "id": sid, "changed": changed})
        return changed

    def handle_gaze_client_message(self, data: dict[str, Any]) -> None:
        """A message from a ``/gaze`` client (Forsee): ``lookpoint`` and ``lookpoint.undo``."""
        kind = data.get("type")
        if kind == "lookpoint":
            self.lookpoint(float(data["x"]), float(data["y"]), data.get("t"), rect=data.get("rect"), kind=str(data.get("kind") or "dwell"), sel_id=data.get("id"))
        elif kind == "lookpoint.undo":
            self.lookpoint_undo(data.get("id"))

    # ------------------------------------------------------------------------------------------
    # UI messages, config, pause, recording
    # ------------------------------------------------------------------------------------------

    def handle_ui_message(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        """A message from the UI WebSocket. Returns a reply to send, if any."""
        kind = msg.get("type")
        if kind == "ping":
            return {"type": "pong", "t": msg.get("t")}
        if kind == "calib.dot":
            self.calib_dot(msg)
        elif kind == "ui.screen":
            self._ui_screen(msg)
        elif kind == "ui.pattern":
            self._ui_pattern(msg)
        return None

    def _ui_screen(self, msg: dict[str, Any]) -> None:
        if self._screen_injected or (self.screen is not None and self.screen.source in ("macos", "sim")):
            return
        from .outputs.screen import screen_from_browser

        screen = screen_from_browser(msg)
        if screen is not None:
            self._set_screen(screen)
            log.info("using the browser's screen size: %s x %s pt", screen.width, screen.height)

    def _ui_pattern(self, msg: dict[str, Any]) -> None:
        """Forward the flash pattern state to estimators that want it (``set_pattern``)."""
        for est in self.estimators:
            fn = getattr(est, "set_pattern", None)
            if fn is not None:
                try:
                    fn(msg.get("pattern"), bool(msg.get("on")), time.monotonic())
                except Exception:  # noqa: BLE001
                    log.exception("set_pattern failed on %s", getattr(est, "name", est))
        if self.recorder is not None:
            self.recorder.write_event({"type": "ui.pattern", "pattern": msg.get("pattern"), "on": msg.get("on")})
        if self.simulated and self.phone is not None:
            self._sim_flash(msg.get("pattern"), bool(msg.get("on")))

    def _sim_flash(self, pattern: Any, on: bool) -> None:
        """Simulator only: make the simulated screen flash the same pattern (``/sim/flash``)."""
        body: dict[str, Any] = {"pattern": None}
        if on and isinstance(pattern, str):
            bits = "".join(ch for ch in pattern.split("@")[0] if ch in "01")
            try:
                step_ms = float(pattern.split("@")[1]) if "@" in pattern else 125.0
            except ValueError:
                step_ms = 125.0
            if bits and step_ms > 0:
                body = {"pattern": bits, "rateHz": 1000.0 / step_ms}
        phone = self.phone

        async def go() -> None:
            try:
                await phone.request("POST", "/sim/flash", body)  # type: ignore[union-attr]
            except Exception as exc:  # noqa: BLE001
                if _log_allowed("sim-flash"):
                    log.warning("simulator /sim/flash failed: %s", exc)

        asyncio.ensure_future(go())

    def set_paused(self, paused: bool) -> None:
        self.paused = bool(paused)
        self.filter_reset()
        if self.recorder is not None:
            self.recorder.write_event({"type": "pause", "paused": self.paused})
        if self.paused:
            self.gaze_ws.emit(None, None)

    def _save_config(self) -> None:
        if self.config_path is not None:
            try:
                save_config(self.config, self.config_path)
            except OSError as exc:
                log.warning("cannot save the config: %s", exc)

    async def apply_config(self, changes: dict[str, Any]) -> dict[str, str]:
        """Validate, apply and save; live-apply what can be applied. Returns ``{path: error}``."""
        errors = update(self.config, changes)
        applied = [p for p in changes if p not in errors]
        if not applied:
            return errors
        self._save_config()
        if self.recorder is not None:
            self.recorder.write_event({"type": "config", "changes": {p: changes[p] for p in applied}})
        sections = {p.split(".", 1)[0] for p in applied}
        if "calibration.drift_rate" in applied:
            self.drift.settings.rate_deg_per_min = float(self.config.calibration.drift_rate)
        try:
            if "stream" in sections:
                s = self.config.stream
                self.upright.mode = s.rotation
                self.upright.reset()
                self.roi_placer.width_mm, self.roi_placer.aspect = s.roi_width_mm, s.roi_aspect
                local_only = {"stream.roi_smoothing", "stream.roi_move_fraction"}  # engine-side, read each frame
                if any(p.startswith("stream.") and p not in local_only for p in applied):
                    await self.send_stream_config()
            if any(p in applied for p in ("lens.camera_id", "lens.max_width", "lens.fps")) and self.phone is not None and self.config.lens.camera_id:
                lens = self.config.lens
                self.phone_status = await self.phone.configure(lens.camera_id, lens.max_width, lens.fps, lens.zoom)
                self._camera_changed()
            elif "lens.camera_prefer" in applied and self.phone is not None and not self.config.lens.camera_id:
                cam = lens_mod.camera_for_preference(list((self.phone_status or {}).get("cameras") or []), self.config.lens.camera_prefer)
                if cam is not None:
                    lens = self.config.lens
                    self.phone_status = await self.phone.configure(cam["id"], lens.max_width, lens.fps, lens.zoom if cam.get("type") != "arkit" else 1.0)
                    self._camera_changed()
            elif "lens.zoom" in applied and self.phone is not None:
                await self.set_zoom(self.config.lens.zoom)
            if "estimators" in sections and not self._estimators_injected:
                from .vision import REBUILD_SETTINGS

                if any(p.split(".", 1)[1] in REBUILD_SETTINGS for p in applied if p.startswith("estimators.")):
                    self.estimators = self._build_estimators()
                # Other estimator settings are read live by the estimators (vision/settings.py),
                # so their state (tracking, reflection priors from a coded flash) is kept.
            lens_paths = [p for p in applied if p in lens_mod.LENS_CONTROL_SETTINGS]
            if lens_paths:
                await self.send_lens_controls(lens_paths)
            if "outputs.fallback_pointer" in applied:
                self.fallback.reset()
            if "filters" in sections and not self._filter_injected:
                self.filter = self._build_filter()
            if "outputs" in sections:
                self.gaze_ws.rate_hz = self.config.outputs.websocket_rate_hz
                if not self._sinks_injected:
                    for sink in self.sinks:
                        sink.close()
                    self.sinks = self._build_sinks()
            if "hotkeys" in sections and self._want_hotkeys:
                if self.hotkeys is not None:
                    self.hotkeys.stop()
                self._start_hotkeys()
            if "second_camera" in sections:  # second camera
                self.second_camera.sync()
            if "phone.url" in applied and self.config.phone.url:
                await self.connect(self.config.phone.url)
        except PhoneError as exc:
            self.log("warning", f"Saved, but the phone did not accept it: {exc}")
        return errors

    def start_recording(self, label: str = "") -> dict[str, Any]:
        if self.recorder is not None:
            return self.recorder.summary()
        root = Path(self.config.recording.directory).expanduser()
        rec_id = new_recording_id(label)
        meta = {
            "label": label,
            "config": self.config.to_dict(),
            "screen": self.screen.to_dict() if self.screen else None,
            "hello": self.phone.hello if self.phone else None,
            "phone_url": self.phone_url,
            "simulated": self.simulated,
            "app_version": _version(),
        }
        self.recorder = Recorder(root / rec_id, meta, record_stream=self.config.recording.record_stream, record_observations=self.config.recording.record_observations)
        # Replay needs the hello (cameras, sim screen) at the start of the stream.
        if self.phone is not None and self.phone.hello is not None:
            from .protocol import Message as _Msg

            self.recorder.write_message(_Msg(dict(self.phone.hello)), time.monotonic())
        return {"id": self.recorder.id, "path": str(self.recorder.directory)}

    def stop_recording(self) -> dict[str, Any] | None:
        if self.recorder is None:
            return None
        summary = self.recorder.close()
        self.recorder = None
        return summary

    def recordings(self) -> list[dict[str, Any]]:
        return list_recordings(Path(self.config.recording.directory).expanduser())

    # ------------------------------------------------------------------------------------------
    # State and subscribers
    # ------------------------------------------------------------------------------------------

    def state(self) -> dict[str, Any]:
        """The ``state`` object sent to the UI (shape in docs/INTERFACES.md)."""
        frame = self.last_frame
        st = (self.phone_status or {}).get("state") or {}
        if frame is not None:
            camera = {"id": frame.camera.id, "type": frame.camera.type, "position": frame.camera.position, "zoom": frame.camera.zoom, "rotation": self.last_decoded.rotation if self.last_decoded else 0, "width": frame.camera.width, "height": frame.camera.height, "mode": frame.mode, "intrinsics_source": frame.camera.intrinsics_source}
        else:
            camera = {"id": st.get("cameraId"), "type": None, "position": st.get("position"), "zoom": st.get("zoom"), "rotation": None, "mode": st.get("mode")}
        phone_stats = self.phone.stats.to_dict() if self.phone is not None else {}
        cursor = next((s for s in self.sinks if getattr(s, "name", "") == "cursor"), None)
        dwell = next((s for s in self.sinks if getattr(s, "name", "") == "dwell"), None)
        run = self.active_run
        return _jsonable(
            {
                "phone": {
                    "connected": self.phone_state == "connected",
                    "state": self.phone_state,
                    "detail": self.phone_detail,
                    "url": self.phone_url,
                    "simulated": self.simulated,
                    "replay": str(self.replaying) if self.replaying else None,
                    "hello": (self.phone.hello if self.phone else None) or {},
                    "status": st,
                    "clock_offset": self.phone.clock.offset if self.phone else None,
                    "clock_round_trip_ms": (self.phone.clock.round_trip * 1000.0) if self.phone and self.phone.clock.round_trip is not None else None,
                },
                "camera": camera,
                "pipeline": {
                    "running": self.running,
                    "fps": self.fps,
                    "stream_fps": phone_stats.get("fps"),
                    "latency_ms": phone_stats.get("latency_ms"),
                    "dropped": self.dropped + int(phone_stats.get("dropped_phone") or 0),
                    "dropped_engine": self.dropped,
                    "dropped_phone": phone_stats.get("dropped_phone"),
                    "processed": self.processed,
                    "timings_ms": {k: round(v, 2) for k, v in self.timings_ms.items()},
                },
                "estimators": [getattr(e, "name", type(e).__name__) for e in self.estimators],
                "calibration": {
                    "active_run": {"run_id": run.run_id, "kind": run.kind, "samples": len(run.samples)} if run else None,
                    "chosen": self.chosen,
                    "active": getattr(self.active_model(), "name", None),
                    "pinned": self.config.models.pinned,
                    "models": sorted(self.models),
                    "reports": [r.to_dict() for r in self.reports],
                    "validation": self.validation,
                },
                "screen": self.screen.to_dict() if self.screen else {},
                "outputs": {
                    "cursor": bool(cursor is not None and getattr(cursor, "available", False)),
                    "cursor_status": getattr(cursor, "status", "off") if cursor is not None else "off",
                    "dwell_click": bool(dwell is not None and getattr(dwell, "available", False)),
                    "dwell_status": getattr(dwell, "status", "off") if dwell is not None else "off",
                    "websocket_clients": len(self.gaze_ws.clients),
                    "hotkeys": getattr(self.hotkeys, "status", "off") if self.hotkeys is not None else "off",
                },
                "recording": {"id": self.recorder.id, "path": str(self.recorder.directory), "seconds": round(self.recorder.seconds, 1)} if self.recorder else None,
                "paused": self.paused,
                "drift": self.drift_state(),
                "hints": self.hints,
                "quality": self.quality,
                "aim": self.aim,
                "second_camera": self.second_camera.state(),  # second camera
            }
        )

    def subscribe(self, callback: Any) -> Any:
        """Register ``callback(message: dict)`` for UI WebSocket messages; returns an
        unsubscribe function."""
        self._subscribers.append(callback)

        def unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return unsubscribe

    def broadcast(self, message: dict[str, Any]) -> None:
        for cb in list(self._subscribers):
            try:
                cb(message)
            except Exception:  # noqa: BLE001
                if _log_allowed("subscriber"):
                    log.exception("UI subscriber failed")

    def log(self, level: str, message: str) -> None:
        getattr(log, level if level in ("debug", "info", "warning", "error") else "info")(message)
        self.broadcast({"type": "log", "level": level, "message": message})

    async def _ticker(self) -> None:
        """Sends ``state`` to the UI when it changed, at most 5 times a second."""
        while self.running:
            await asyncio.sleep(0.2)
            self._frame_watchdog()
            self.second_camera.sync()  # second camera: open or close the webcam as configured
            if not self._subscribers:
                continue
            try:
                state = self.state()
                text = json.dumps(state, sort_keys=True, default=str)
            except Exception:  # noqa: BLE001
                if _log_allowed("state"):
                    log.exception("building state failed")
                continue
            if text != self._last_state_json:
                self._last_state_json = text
                self.broadcast({"type": "state", "state": state})

    NO_FRAMES_RESTART_S = 3.0
    """With the phone connected and its camera supposedly running, this long without a frame
    (the app was backgrounded, another app took the camera, the phone got too hot) makes the
    engine ask the phone to start the camera again, at most every :data:`RESTART_EVERY_S`."""
    RESTART_EVERY_S = 10.0

    def _frame_watchdog(self) -> None:
        if self.phone is None or self.replaying is not None or self.phone_state != "connected":
            return
        if self._aim_task is not None or self.aim.get("phase") == "trying":
            return
        state = (self.phone_status or {}).get("state") or {}
        mode, camera_id = state.get("mode", "idle"), state.get("cameraId")
        if mode == "idle" or not camera_id or (self._restart_task is not None and not self._restart_task.done()):
            return
        now = time.monotonic()
        last = self.last_frame.t_received if self.last_frame is not None and self.last_frame.t_received else 0.0
        # Frames that arrived but are still waiting for the estimators (MediaPipe's first load
        # can take 30 s on a fresh Mac) mean the camera is running: do not restart it.
        last = max(last, getattr(self, "_last_received_at", 0.0) or 0.0)
        if now - max(last, self._connected_at) < self.NO_FRAMES_RESTART_S or now - self._last_restart < self.RESTART_EVERY_S:
            return
        self._last_restart = now
        phone = self.phone
        lens = self.config.lens
        zoom = 1.0 if mode == "arkit" else lens.zoom
        detail = state.get("lastError") or "no reason given"
        self.log("warning", f"No frames from the phone for {now - max(last, self._connected_at):.0f} s ({detail}); asking it to start the camera again.")

        async def go() -> None:
            try:
                self.phone_status = await phone.configure(str(camera_id), lens.max_width, lens.fps, zoom)
                self._camera_changed()
            except PhoneError as exc:
                if _log_allowed("restart-camera"):
                    log.warning("restarting the phone camera failed: %s", exc)

        self._restart_task = asyncio.ensure_future(go())

    # ------------------------------------------------------------------------------------------
    # Preview images
    # ------------------------------------------------------------------------------------------

    def preview_jpeg(self, image: str = "wide", overlay: bool = False, quality: int = 80) -> bytes | None:
        """The latest upright image as JPEG, with estimator overlays when ``overlay``."""
        import cv2

        decoded, obs = self.last_decoded, self.last_obs
        if decoded is None:
            return None
        im = decoded.images.get(image)
        if im is None or im.pixels.ndim != 3:
            return None
        pixels = im.pixels.copy() if overlay else im.pixels
        if overlay and obs is not None:
            draw_overlay(pixels, im, obs)
        ok, buf = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        return bytes(buf) if ok else None


def _parse_rect(rect: Any) -> tuple[float, float, float, float] | None:
    """``{x, y, width, height}`` (or a 4-list) in screen points, or ``None`` when absent or bad."""
    try:
        if isinstance(rect, dict):
            vals = (rect["x"], rect["y"], rect["width"], rect["height"])
        elif isinstance(rect, (list, tuple)) and len(rect) == 4:
            vals = tuple(rect)
        else:
            return None
        x, y, w, h = (float(v) for v in vals)
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w < 0 or h < 0:
        return None
    return x, y, w, h


def draw_overlay(pixels: np.ndarray, im: Any, obs: Observation) -> None:
    """Draw what the estimators found onto ``pixels`` (the upright image ``im``) in place.

    Upright images differ from the full frame only by an offset and a scale, so ellipse angles
    carry over unchanged."""
    import cv2

    from_full = im.from_full
    s = im.scale  # image pixels per full-frame pixel

    def to_img(p: tuple[float, float]) -> tuple[int, int]:
        x, y = apply_affine(from_full, p)
        return (int(round(x - 0.5)), int(round(y - 0.5)))

    lw = max(1, int(round(pixels.shape[1] / 400)))
    for side, color in (("left", (0, 200, 255)), ("right", (255, 160, 0))):
        eye = obs.eye(side)
        if eye.iris_ellipse is not None:
            cx, cy, a, b, ang = eye.iris_ellipse
            cv2.ellipse(pixels, to_img((cx, cy)), (max(1, int(a * s)), max(1, int(b * s))), float(ang), 0, 360, color, lw)
        elif eye.iris_center is not None and eye.iris_radius:
            cv2.circle(pixels, to_img(eye.iris_center), max(1, int(eye.iris_radius * s)), color, lw)
        if eye.iris_center is not None:
            cv2.drawMarker(pixels, to_img(eye.iris_center), color, cv2.MARKER_CROSS, max(6, 6 * lw), lw)
        if eye.reflection_center is not None:
            cv2.drawMarker(pixels, to_img(eye.reflection_center), (255, 255, 255), cv2.MARKER_DIAMOND, max(6, 6 * lw), lw)
        for corner in (eye.inner_corner, eye.outer_corner):
            if corner is not None:
                cv2.circle(pixels, to_img(corner), max(2, 2 * lw), (0, 255, 0), -1)
    if obs.face_rect is not None:
        x, y, w, h = obs.face_rect
        cv2.rectangle(pixels, to_img((x, y)), to_img((x + w, y + h)), (0, 255, 0), lw)


def _summarise_quality(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Median of each numeric quality key over a few frames."""
    out: dict[str, Any] = {}
    keys = {k for q in samples for k in q}
    for k in keys:
        values = [q[k] for q in samples if isinstance(q.get(k), (int, float)) and not isinstance(q.get(k), bool)]
        out[k] = float(np.median(values)) if values else None
    if "eyes_in_frame" in out and out["eyes_in_frame"] is not None:
        out["eyes_in_frame"] = int(round(out["eyes_in_frame"]))
    return out


def _version() -> str:
    try:
        from . import __version__  # type: ignore[attr-defined]

        return str(__version__)
    except Exception:  # noqa: BLE001
        return "0"
