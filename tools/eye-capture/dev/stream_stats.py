#!/usr/bin/env python3
"""First smoke test for the phone's live stream. Standard library only.

Connects to the EyeCapture app, optionally starts a camera and sets the stream
up, then reads ``GET /stream`` and prints one line of statistics per second:
frames per second, bandwidth, dropped frames, latency on the phone, part sizes,
zoom, intrinsics and (in ARKit mode) whether a face is tracked.

    python3 tools/eye-capture/dev/stream_stats.py http://192.168.1.23:8080
    python3 tools/eye-capture/dev/stream_stats.py http://PHONE:8080 --camera back-wide --zoom 2
    python3 tools/eye-capture/dev/stream_stats.py http://PHONE:8080 --camera arkit --roi-source arkit
    python3 tools/eye-capture/dev/stream_stats.py --vector path/to/pgz1_vector.bin   # parser self-test

The wire format is in sidecars/phone-gaze/docs/PROTOCOL.md.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import urllib.error
import urllib.request
from http.client import HTTPConnection
from typing import BinaryIO, Iterator
from urllib.parse import urlparse

MAGIC = b"PGZ1"


def read_exact(stream: BinaryIO, n: int) -> bytes:
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            raise EOFError("stream closed")
        data += chunk
    return data


def read_messages(stream: BinaryIO) -> Iterator[tuple[dict, list[bytes]]]:
    """Yields (header, parts) until the stream ends."""
    while True:
        try:
            magic = read_exact(stream, 4)
        except EOFError:
            return
        if magic != MAGIC:
            raise ValueError(f"bad magic {magic!r}: the stream is broken")
        (length,) = struct.unpack(">I", read_exact(stream, 4))
        if length > 1 << 20:
            raise ValueError(f"header of {length} bytes is over the 1 MiB limit")
        header = json.loads(read_exact(stream, length).decode("utf-8"))
        parts = [read_exact(stream, int(p["bytes"])) for p in header.get("parts", [])]
        yield header, parts


def post(base: str, path: str, body: dict, timeout: float = 30) -> dict:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise SystemExit(f"POST {path} failed with {error.code}: {detail}") from None


def get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=10) as response:
        return json.loads(response.read())


def pick_camera(cameras: list[dict], wanted: str) -> str:
    """'arkit', 'back-wide', 'front-wide', 'back-ultrawide' or an exact id."""
    for camera in cameras:
        if camera["id"] == wanted:
            return camera["id"]
    if wanted == "arkit":
        wanted = "front-arkit"
    position, _, kind = wanted.partition("-")
    for camera in cameras:
        if camera.get("position") == position and camera.get("type") == kind and "depthSource" not in camera:
            return camera["id"]
    names = ", ".join(f"{c['id']} ({c['position']} {c['type']})" for c in cameras)
    raise SystemExit(f"No camera matches {wanted!r}. Cameras: {names}")


class Stats:
    def __init__(self) -> None:
        self.reset(time.monotonic())
        self.total_frames = 0
        self.total_dropped = 0
        self.last_seq: int | None = None
        self.seq_gaps = 0

    def reset(self, now: float) -> None:
        self.start = now
        self.frames = 0
        self.bytes = 0
        self.dropped = 0
        self.latency: list[float] = []
        self.parts: dict[str, list[int]] = {}
        self.tracked = 0
        self.header: dict = {}

    def add(self, header: dict, size: int) -> None:
        self.frames += 1
        self.total_frames += 1
        self.bytes += size
        self.dropped += int(header.get("dropped", 0))
        self.total_dropped += int(header.get("dropped", 0))
        seq = header.get("seq")
        if self.last_seq is not None and seq is not None and seq != self.last_seq + 1:
            self.seq_gaps += 1
        self.last_seq = seq
        if "tSent" in header and "t" in header:
            self.latency.append((header["tSent"] - header["t"]) * 1000)
        for part in header.get("parts", []):
            self.parts.setdefault(part["name"], [part["width"], part["height"], 0])[2] += part["bytes"]
        if header.get("arkit", {}).get("tracked"):
            self.tracked += 1
        self.header = header

    def line(self, now: float) -> str:
        span = max(now - self.start, 1e-6)
        h = self.header
        cam = h.get("camera", {})
        lens = h.get("lens", {})
        bits = [
            f"{self.frames / span:5.1f} fps",
            f"{self.bytes * 8 / span / 1e6:5.1f} Mbit/s",
            f"dropped {self.dropped}",
        ]
        if self.latency:
            bits.append(f"phone latency {sum(self.latency) / len(self.latency):4.0f} ms")
        if cam:
            bits.append(f"{cam.get('type')} {cam.get('width')}x{cam.get('height')} zoom {cam.get('zoom', 0):.2f}")
            if "fx" in cam:
                bits.append(f"fx {cam['fx']:.0f}")
        if "iso" in lens:
            bits.append(f"ISO {lens['iso']:.0f} {lens.get('exposureS', 0) * 1000:.1f} ms")
        if lens.get("lowLight"):
            bits.append("LOW LIGHT")
        if "arkit" in h:
            bits.append(f"face tracked {self.tracked}/{self.frames}")
        if "depth" in h:
            bits.append(f"depth {h['depth'].get('atRois')}")
        for name, (w, hh, size) in sorted(self.parts.items()):
            bits.append(f"{name} {w}x{hh} {size / max(self.frames, 1) / 1024:.0f} KiB")
        return " | ".join(bits)


def run_vector(path: str) -> None:
    with open(path, "rb") as stream:
        for header, parts in read_messages(stream):
            print(header["type"], {k: header[k] for k in ("seq", "t") if k in header}, [len(p) for p in parts])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="The address the phone shows, e.g. http://192.168.1.23:8080")
    parser.add_argument("--camera", help="Start a camera first: arkit, back-wide, front-wide, back-ultrawide or an id")
    parser.add_argument("--fps", type=float, default=30, help="Camera frame rate when starting a camera")
    parser.add_argument("--max-width", type=int, default=3840)
    parser.add_argument("--zoom", type=float, help="Set zoom on the running camera (POST /api/zoom)")
    parser.add_argument("--roi-source", choices=["mac", "arkit", "vision"], help="Where eye rectangles come from")
    parser.add_argument("--test-rois", action="store_true", help="With roi source mac: two fixed rectangles mid-frame")
    parser.add_argument("--wide-width", type=int, help="Width of the downscaled whole frame")
    parser.add_argument("--max-fps", type=float, help="Upper bound on frames sent per second")
    parser.add_argument("--depth", action="store_true", help="Ask for depth (experimental)")
    parser.add_argument("--seconds", type=float, default=0, help="Stop after this long (0 = until Ctrl+C)")
    parser.add_argument("--vector", help="Decode a PGZ1 file instead, to check this parser")
    args = parser.parse_args()

    if args.vector:
        run_vector(args.vector)
        return
    if not args.url:
        parser.error("give the phone's address")
    base = args.url.rstrip("/")
    if "://" not in base:
        base = "http://" + base

    status = get(base, "/api/status")
    print(f"Connected to {status['app']['name']} {status['app']['version']} on {status['system'].get('model')}")
    if args.camera:
        camera_id = pick_camera(status["cameras"], args.camera)
        print(f"Starting camera {camera_id} ...")
        post(base, "/api/configure", {"cameraId": camera_id, "fps": args.fps, "maxWidth": args.max_width}, 60)
    if args.zoom is not None:
        state = post(base, "/api/zoom", {"zoom": args.zoom})["state"]
        print(f"Zoom is now {state['zoom']:.2f} (range {state.get('zoomRange')})")

    config: dict = {}
    if args.roi_source:
        config["roiSource"] = args.roi_source
    if args.test_rois:
        config["rois"] = [
            {"name": "left_eye", "x": 0.52, "y": 0.45, "w": 0.08, "h": 0.06},
            {"name": "right_eye", "x": 0.40, "y": 0.45, "w": 0.08, "h": 0.06},
        ]
    if args.wide_width:
        config["wide"] = {"width": args.wide_width}
    if args.max_fps:
        config["maxFps"] = args.max_fps
    if args.depth:
        config["depth"] = True
    if config:
        print("Stream config:", json.dumps(post(base, "/api/stream/config", config)))

    target = urlparse(base)
    connection = HTTPConnection(target.hostname, target.port or 80, timeout=10)
    connection.request("GET", "/stream")
    response = connection.getresponse()
    if response.status != 200:
        raise SystemExit(f"GET /stream answered {response.status}: {response.read()[:200]!r}")

    stats = Stats()
    started = time.monotonic()
    try:
        for header, parts in read_messages(response):
            now = time.monotonic()
            kind = header.get("type")
            if kind == "hello":
                caps = header.get("capabilities", {})
                print(f"hello: protocol {header.get('protocol')}, capabilities {json.dumps(caps)}")
                print(f"       stream config {json.dumps(header.get('streamConfig'))}")
                mode = header.get("state", {}).get("mode")
                if mode == "idle":
                    print("       No camera is running: only status messages will come. Use --camera.")
            elif kind == "frame":
                stats.add(header, 8 + sum(len(p) for p in parts) + len(json.dumps(header)))
            elif kind == "status":
                stream = header.get("stream", {})
                state = header.get("state", {})
                print(
                    f"status: mode {state.get('mode')}, camera {state.get('measuredFps', 0):.1f} fps, "
                    f"phone says sent {stream.get('sent')} dropped {stream.get('dropped')}"
                )
            if now - stats.start >= 1 and stats.frames:
                print(stats.line(now))
                stats.reset(now)
            if args.seconds and now - started >= args.seconds:
                break
    except KeyboardInterrupt:
        pass
    finally:
        connection.close()
    print(
        f"Done: {stats.total_frames} frames, {stats.total_dropped} dropped by the phone, "
        f"{stats.seq_gaps} gaps in seq (skipped or dropped frames)."
    )


if __name__ == "__main__":
    try:
        main()
    except (ConnectionError, OSError) as error:
        sys.exit(f"Connection problem: {error}")
