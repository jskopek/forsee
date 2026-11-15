#!/usr/bin/env python3
"""A stand-in for the phone app, for working on the controller page and the
download script without a phone.

It serves the same routes as the iOS app, with made-up cameras and tiny fake
recordings, and stores sessions in a temporary folder.

    python3 tools/eye-capture/dev/mock_phone.py
    open http://localhost:8080
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import shutil
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PAGE = Path(__file__).resolve().parent.parent / "ios" / "EyeCapture" / "controller.html"

# A small test-pattern JPEG, so the preview images have something to show.
PREVIEW = base64.b64decode(
    "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"
)

CAMERAS = [
    {
        "id": "back-wide",
        "name": "Back Camera",
        "position": "back",
        "type": "wide",
        "minFocusDistanceMM": 150,
        "canFocus": True,
        "fieldOfView": 68.0,
        "zoomPresets": [2.0],
        "formats": [
            {"width": 3840, "height": 2160, "maxFps": 60.0},
            {"width": 1920, "height": 1080, "maxFps": 240.0},
        ],
    },
    {
        "id": "back-ultrawide",
        "name": "Back Ultra Wide Camera",
        "position": "back",
        "type": "ultrawide",
        "minFocusDistanceMM": 20,
        "canFocus": True,
        "fieldOfView": 108.0,
        "zoomPresets": [],
        "formats": [{"width": 3840, "height": 2160, "maxFps": 60.0}],
    },
    {
        "id": "back-tele",
        "name": "Back Telephoto Camera",
        "position": "back",
        "type": "tele",
        "minFocusDistanceMM": 1300,
        "canFocus": True,
        "fieldOfView": 16.0,
        "zoomPresets": [],
        "formats": [{"width": 3840, "height": 2160, "maxFps": 30.0}],
    },
    {
        "id": "front-wide",
        "name": "Front Camera",
        "position": "front",
        "type": "wide",
        "minFocusDistanceMM": -1,
        "canFocus": True,
        "fieldOfView": 73.0,
        "zoomPresets": [],
        "formats": [{"width": 3840, "height": 2160, "maxFps": 60.0}],
    },
    {
        "id": "arkit-face",
        "name": "Front TrueDepth camera with ARKit face tracking",
        "position": "front",
        "type": "arkit",
        "minFocusDistanceMM": -1,
        "canFocus": False,
        "zoomPresets": [],
        "formats": [{"width": 1920, "height": 1440, "maxFps": 60.0}],
    },
]

IDLE = {
    "mode": "idle",
    "cameraId": "",
    "cameraName": "",
    "position": "",
    "width": 0,
    "height": 0,
    "requestedFps": 0.0,
    "measuredFps": 0.0,
    "zoom": 1.0,
    "minFocusDistanceMM": -1,
    "binned": False,
    "focusLocked": False,
    "adjustingFocus": False,
    "faceTracked": False,
    "recording": False,
    "segment": "",
    "framesWritten": 0,
    "framesSkipped": 0,
    "framesDropped": 0,
    "lastError": "",
}


class Phone:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.state = dict(IDLE)
        self.recording: dict | None = None

    def now(self) -> float:
        return time.monotonic()

    def status(self) -> dict:
        return {
            "app": {"name": "EyeCapture (mock)", "version": "0.1"},
            "time": self.now(),
            "system": {
                "model": "MockPhone1,1",
                "system": "iOS 0.0",
                "battery": 0.83,
                "thermalState": "nominal",
                "freeBytes": 64_000_000_000,
            },
            "cameras": CAMERAS,
            "state": self.state,
        }

    def configure(self, body: dict) -> None:
        camera = next((c for c in CAMERAS if c["id"] == body.get("cameraId")), None)
        if camera is None:
            raise ValueError(f"Unknown camera {body.get('cameraId')}")
        cap = int(body.get("maxWidth", 3840))
        fps = float(body.get("fps", 30))
        fits = [f for f in camera["formats"] if f["width"] <= cap] or camera["formats"]
        chosen = fits[0]
        self.state = dict(IDLE)
        self.state.update(
            mode="arkit" if camera["type"] == "arkit" else "camera",
            cameraId=camera["id"],
            cameraName=camera["name"],
            position=camera["position"],
            width=chosen["width"],
            height=chosen["height"],
            requestedFps=min(fps, chosen["maxFps"]),
            measuredFps=min(fps, chosen["maxFps"]),
            zoom=float(body.get("zoom", 1)),
            minFocusDistanceMM=camera["minFocusDistanceMM"],
            faceTracked=camera["type"] == "arkit",
        )
        if camera["type"] != "arkit":
            self.state.update(
                fieldOfView=camera["fieldOfView"], lensPosition=0.62, iso=320.0, exposureSeconds=1 / 60
            )

    def session_dir(self, session_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", session_id or ""):
            raise ValueError("Unknown session")
        directory = self.root / session_id
        if not directory.is_dir():
            raise ValueError("Unknown session")
        return directory

    def start_session(self, body: dict) -> str:
        label = re.sub(r"[^A-Za-z0-9_-]+", "-", body.get("label", "")).strip("-")
        session_id = time.strftime("%Y%m%d-%H%M%S") + (f"-{label}" if label else "")
        directory = self.root / session_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "meta.json").write_text(json.dumps(body.get("meta", {}), indent=2))
        return session_id

    def append_events(self, body: dict) -> int:
        directory = self.session_dir(body.get("sessionId", ""))
        received = self.now()
        with (directory / "events.jsonl").open("a") as handle:
            for event in body.get("events", []):
                handle.write(json.dumps({**event, "t_recv": received}, sort_keys=True) + "\n")
        return len(body.get("events", []))

    def start_recording(self, body: dict) -> str:
        if self.state["mode"] == "idle":
            raise ValueError("No camera running")
        directory = self.session_dir(body.get("sessionId", ""))
        base = body.get("segment", "segment")
        name, counter = base, 2
        while (directory / f"{name}.mov").exists():
            name, counter = f"{base}-{counter}", counter + 1
        (directory / f"{name}.mov").write_bytes(b"mock video\n")
        self.recording = {"directory": directory, "name": name, "start": self.now()}
        self.state.update(recording=True, segment=name)
        return name

    def stop_recording(self) -> dict:
        if self.recording is None:
            return {"error": "No frames arrived, so nothing was recorded"}
        recording, self.recording = self.recording, None
        self.state.update(recording=False)
        duration = self.now() - recording["start"]
        fps = self.state["requestedFps"]
        frames = int(duration * fps)
        rows = ["frame,t,lens_position,iso,exposure_s,adjusting_focus,adjusting_exposure"]
        for index in range(frames):
            rows.append(f"{index},{recording['start'] + index / fps:.6f},0.62,320,0.0166667,0,0")
        directory, name = recording["directory"], recording["name"]
        (directory / f"{name}.frames.csv").write_text("\n".join(rows) + "\n")
        summary = {
            "segment": name,
            "mode": self.state["mode"],
            "cameraName": self.state["cameraName"],
            "width": self.state["width"],
            "height": self.state["height"],
            "requestedFps": fps,
            "zoom": self.state["zoom"],
            "minFocusDistanceMM": self.state["minFocusDistanceMM"],
            "framesWritten": frames,
            "framesSkipped": 0,
            "framesDropped": 0,
            "firstFrameTime": recording["start"],
            "lastFrameTime": recording["start"] + duration,
            "durationSeconds": duration,
            "meanFps": fps,
        }
        (directory / f"{name}.json").write_text(json.dumps(summary, indent=2))
        return summary

    def sessions(self) -> list[dict]:
        result = []
        for directory in sorted(self.root.iterdir(), reverse=True):
            if not directory.is_dir():
                continue
            files = [
                {"name": path.name, "bytes": path.stat().st_size}
                for path in sorted(directory.iterdir())
            ]
            result.append(
                {"id": directory.name, "files": files, "bytes": sum(f["bytes"] for f in files)}
            )
        return result


def make_handler(phone: Phone) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: object) -> None:  # Keep the terminal quiet.
            pass

        def send(self, status: int, content_type: str, data: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def send_json(self, payload: object, status: int = 200) -> None:
            self.send(status, "application/json", json.dumps(payload).encode())

        def do_GET(self) -> None:
            url = urlparse(self.path)
            if url.path in ("/", "/index.html"):
                self.send(200, "text/html; charset=utf-8", PAGE.read_bytes())
            elif url.path == "/api/time":
                self.send_json({"t": phone.now()})
            elif url.path == "/api/status":
                self.send_json(phone.status())
            elif url.path == "/preview.jpg":
                parse_qs(url.query)
                if phone.state["mode"] == "idle":
                    self.send_json({"error": "No preview yet"}, 503)
                else:
                    self.send(200, "image/jpeg", PREVIEW)
            elif url.path == "/api/sessions":
                self.send_json({"sessions": phone.sessions()})
            elif url.path.startswith("/files/"):
                parts = url.path.split("/")
                try:
                    path = phone.session_dir(parts[2]) / parts[3]
                    self.send(200, "application/octet-stream", path.read_bytes())
                except (ValueError, IndexError, OSError):
                    self.send_json({"error": "No such file"}, 404)
            else:
                self.send_json({"error": "No such route"}, 404)

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body = {}
            path = urlparse(self.path).path
            try:
                if path == "/api/configure":
                    phone.configure(body)
                    self.send_json(phone.status())
                elif path == "/api/stop":
                    phone.state = dict(IDLE)
                    self.send_json(phone.status())
                elif path == "/api/focus":
                    if "locked" in body:
                        phone.state["focusLocked"] = bool(body["locked"])
                    self.send_json(phone.status())
                elif path == "/api/session/start":
                    self.send_json({"sessionId": phone.start_session(body)})
                elif path == "/api/events":
                    self.send_json({"stored": phone.append_events(body)})
                elif path == "/api/record/start":
                    self.send_json({"segment": phone.start_recording(body)})
                elif path == "/api/record/stop":
                    self.send_json(phone.stop_recording())
                elif path == "/api/sessions/delete":
                    shutil.rmtree(phone.session_dir(body.get("sessionId", "")))
                    self.send_json({"sessions": phone.sessions()})
                else:
                    self.send_json({"error": "No such route"}, 404)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--root", type=Path, help="where to keep mock sessions")
    arguments = parser.parse_args()

    root = arguments.root or Path(tempfile.mkdtemp(prefix="eye-capture-mock-"))
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", arguments.port), make_handler(Phone(root)))
    print(f"Mock phone on http://localhost:{arguments.port}  (sessions in {root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
