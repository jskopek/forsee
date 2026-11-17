"""Webcam frame sources for the second camera: the Mac's camera through OpenCV (AVFoundation on
macOS), the simulator's second camera over HTTP, and a video file or image folder (tests).

Every source returns :class:`WebcamFrame` objects stamped with the engine's clock
(``time.monotonic()``), so they can be paired with phone frames (whose phone-clock times Core
converts to the same clock). ``read`` blocks until the next frame and returns ``None`` when the
source has ended; problems raise :class:`WebcamError` with a message meant for the person.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np

log = logging.getLogger(__name__)


class WebcamError(RuntimeError):
    """A webcam problem worth showing to the person (no camera, permission denied...)."""


@dataclass
class WebcamFrame:
    """One webcam image. ``pixels``: ``H x W x 3`` uint8 BGR, unmirrored. ``t_local``: engine
    ``time.monotonic()`` at capture. ``truth``: the simulator's ground truth, when simulated."""

    seq: int
    t_local: float
    pixels: np.ndarray
    truth: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)


PERMISSION_HELP = (
    "macOS did not give this program the camera. Open System Settings > Privacy & Security > Camera "
    "and turn it on for the app that runs the engine (Terminal, iTerm or your editor), then quit and "
    "reopen that app. If it is not listed, run the engine once from it so macOS asks."
)


class OpenCVWebcam:
    """The Mac's camera (or any camera OpenCV can open) by index.

    On macOS OpenCV uses AVFoundation. When the terminal has no camera permission, opening
    either fails or every read fails; both raise :class:`WebcamError` with
    :data:`PERMISSION_HELP`. Frames are stamped when ``read`` returns (minus nothing: OpenCV does
    not report the capture time; the latency is a few tens of milliseconds and roughly constant).
    """

    name = "opencv"

    def __init__(self, index: int = 0, width: int = 1280, height: int = 720, fps: float = 15.0) -> None:
        self.index, self.width, self.height, self.fps = int(index), int(width), int(height), float(fps)
        self._cap: Any = None
        self._seq = 0
        self._fails = 0

    def open(self) -> None:
        import cv2

        backend = cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY
        cap = cv2.VideoCapture(self.index, backend)
        if not cap or not cap.isOpened():
            if cap is not None:
                cap.release()
            if sys.platform == "darwin":
                raise WebcamError(f"Could not open camera {self.index}. Either there is no camera with that index or " + PERMISSION_HELP)
            raise WebcamError(f"Could not open camera {self.index}: no camera found (this machine may have none).")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_FPS, self.fps)
        self._cap = cap

    def read(self) -> WebcamFrame | None:
        if self._cap is None:
            self.open()
        while True:
            ok, img = self._cap.read()
            t = time.monotonic()
            if ok and img is not None:
                break
            self._fails += 1
            if self._fails >= 30:
                raise WebcamError(f"Camera {self.index} opened but delivers no frames. " + (PERMISSION_HELP if sys.platform == "darwin" else "Is another program using it?"))
            time.sleep(0.05)
        self._fails = 0
        self._seq += 1
        return WebcamFrame(self._seq, t, img)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None


class SimWebcam:
    """The simulator's second camera (``GET /sim/webcam.jpg`` on the simulated phone's server).

    Paced at ``fps`` by this client. Each answer carries the simulator's capture time on the
    engine's monotonic clock (same machine) and the ground truth in a header."""

    name = "sim"

    def __init__(self, base_url: str, width: int = 1280, height: int = 720, fps: float = 15.0, setup: dict[str, Any] | None = None, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.width, self.height, self.fps = int(width), int(height), float(fps)
        self.setup = dict(setup or {})
        self.timeout_s = timeout_s
        self._seq = 0
        self._next = 0.0
        self._opened = False

    def open(self) -> None:
        body = {"width": self.width, "height": self.height, **self.setup}
        try:
            self._post("/sim/webcam/config", body)
        except (urllib.error.URLError, OSError) as exc:
            raise WebcamError(f"The simulator's second camera did not answer at {self.base_url}: {exc}") from exc
        self._opened = True

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        req = urllib.request.Request(self.base_url + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310 - local simulator
            return json.loads(resp.read().decode() or "{}")

    def read(self) -> WebcamFrame | None:
        import cv2

        if not self._opened:
            self.open()
        now = time.monotonic()
        if self._next > now:
            time.sleep(self._next - now)
        self._next = max(time.monotonic(), self._next) + 1.0 / max(self.fps, 0.1)
        try:
            with urllib.request.urlopen(self.base_url + "/sim/webcam.jpg", timeout=self.timeout_s) as resp:  # noqa: S310
                data = resp.read()
                t_mono = float(resp.headers.get("X-Monotonic") or time.monotonic())
                truth = json.loads(resp.headers.get("X-Sim-Webcam") or "null")
            self._fails = 0
        except (urllib.error.URLError, OSError, ValueError) as exc:
            self._fails = getattr(self, "_fails", 0) + 1
            if self._fails >= 5:
                raise WebcamError(f"The simulator's second camera stopped answering: {exc}") from exc
            time.sleep(0.2)
            return None
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        self._seq += 1
        return WebcamFrame(self._seq, t_mono, img, truth=truth)

    def close(self) -> None:
        self._opened = False


class FileWebcam:
    """Frames from a video file, a folder of images (sorted by name), or an in-memory list of
    images (tests). Paced at ``fps`` unless ``realtime=False``; ``loop`` repeats."""

    name = "file"

    def __init__(self, path: str | Path | None = None, images: Iterable[np.ndarray] | None = None, fps: float = 15.0, loop: bool = False, realtime: bool = True) -> None:
        self.path = Path(path).expanduser() if path else None
        self._images = list(images) if images is not None else None
        self.fps, self.loop, self.realtime = float(fps), loop, realtime
        self._cap: Any = None
        self._files: list[Path] = []
        self._i = 0
        self._seq = 0
        self._next = 0.0

    def open(self) -> None:
        import cv2

        if self._images is not None:
            return
        if self.path is None or not self.path.exists():
            raise WebcamError(f"Webcam file source: {self.path or '(no path set)'} does not exist.")
        if self.path.is_dir():
            self._files = sorted(p for p in self.path.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".bmp"))
            if not self._files:
                raise WebcamError(f"Webcam file source: no images in {self.path}.")
        else:
            self._cap = cv2.VideoCapture(str(self.path))
            if not self._cap.isOpened():
                raise WebcamError(f"Webcam file source: OpenCV cannot read {self.path}.")

    def _next_image(self) -> np.ndarray | None:
        import cv2

        if self._images is not None:
            if self._i >= len(self._images):
                if not self.loop or not self._images:
                    return None
                self._i = 0
            img = self._images[self._i]
            self._i += 1
            return img
        if self._files:
            if self._i >= len(self._files):
                if not self.loop:
                    return None
                self._i = 0
            img = cv2.imread(str(self._files[self._i]), cv2.IMREAD_COLOR)
            self._i += 1
            return img
        if self._cap is None:
            return None
        ok, img = self._cap.read()
        if not ok and self.loop:
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, img = self._cap.read()
        return img if ok else None

    def read(self) -> WebcamFrame | None:
        if self._cap is None and not self._files and self._images is None:
            self.open()
        if self.realtime:
            now = time.monotonic()
            if self._next > now:
                time.sleep(self._next - now)
            self._next = max(time.monotonic(), self._next) + 1.0 / max(self.fps, 0.1)
        img = self._next_image()
        if img is None:
            return None
        self._seq += 1
        return WebcamFrame(self._seq, time.monotonic(), img)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None


def make_source(config: Any, sim_url: str | None) -> Any:
    """The source the ``second_camera`` config asks for. ``auto``: the simulator's second
    camera when the phone is simulated (``sim_url`` given), else the Mac's camera."""
    kind = config.source
    if kind == "auto":
        kind = "sim" if sim_url else "opencv"
    if kind == "sim":
        if not sim_url:
            raise WebcamError("Second camera source 'sim' needs the simulated phone (start with --sim).")
        return SimWebcam(sim_url, config.width, config.height, config.fps)
    if kind == "file":
        return FileWebcam(config.file_path or None, fps=config.fps, loop=True)
    return OpenCVWebcam(config.camera_index, config.width, config.height, config.fps)


class SourceThread:
    """Reads a source on its own thread and hands each frame to ``on_frame``. Errors stop the
    thread and are kept in ``error`` (shown by the UI)."""

    def __init__(self, source: Any, on_frame: Any) -> None:
        self.source = source
        self.on_frame = on_frame
        self.error: str | None = None
        self.running = False
        self.frames = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self._stop.clear()
        self.running = True
        self._thread = threading.Thread(target=self._run, name="phonegaze-webcam", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                frame = self.source.read()
                if frame is None:
                    if getattr(self.source, "name", "") == "file":
                        self.error = "The webcam file source has no more frames."
                        break
                    continue
                self.frames += 1
                try:
                    self.on_frame(frame)
                except Exception:  # noqa: BLE001 - one bad frame must not stop the camera
                    log.exception("second camera: processing a webcam frame failed")
        except WebcamError as exc:
            self.error = str(exc)
            log.warning("second camera: %s", exc)
        except Exception as exc:  # noqa: BLE001
            self.error = f"Webcam failed: {exc}"
            log.exception("second camera: webcam thread failed")
        finally:
            self.running = False
            try:
                self.source.close()
            except Exception:  # noqa: BLE001
                pass

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None
