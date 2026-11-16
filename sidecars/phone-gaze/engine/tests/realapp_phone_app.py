"""The real iPhone app (``tools/eye-capture/ios``) against the engine's own phone client.

Not collected by a plain ``pytest`` run (the file name does not start with ``test_``). Run it
against a running app, using its synthetic camera, the test pattern (``TestPattern.swift``)::

    PHONEGAZE_APP_URL=http://127.0.0.1:8080 .venv/bin/python -m pytest -v tests/realapp_phone_app.py

CI runs it against the app in the iOS Simulator (``.github/workflows/phone-gaze.yml``, job
``ios-simulator``). It also works against a real phone on the same network
(``PHONEGAZE_APP_URL=http://<phone>:8080``): the test pattern is selectable by id there too, so
nothing needs a face. Leave the phone's camera alone while it runs; the last test leaves the
phone idle.

What the pattern draws, and where, is in ``TestPattern.swift``; every frame says exactly where it
drew the discs in its ``testPattern`` header block, so these tests check that the rectangles,
scales, zoom and coordinates mean what ``docs/PROTOCOL.md`` says by finding the discs in the
decoded JPEG parts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import socket
import time
from contextlib import suppress
from typing import Any
from urllib.parse import urlparse

import cv2
import numpy as np
import pytest

from phonegaze.phone import PhoneClient, PhoneError
from phonegaze.protocol import CONTENT_TYPE, Decoder, Message
from phonegaze.types import DecodedFrame, Frame

APP_URL = os.environ.get("PHONEGAZE_APP_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not APP_URL, reason="set PHONEGAZE_APP_URL to a running Eye Capture app")

TEST_CAMERA = "test-pattern"
TEST_ARKIT = "test-pattern-arkit"
BACKGROUND, DISC, SPOT = 180, 40, 250
BLEND_SHAPES = {
    "blink_left", "blink_right", "look_down_left", "look_down_right", "look_in_left", "look_in_right",
    "look_out_left", "look_out_right", "look_up_left", "look_up_right", "squint_left", "squint_right",
    "wide_left", "wide_right",
}  # fmt: skip


# ----------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------


async def client() -> PhoneClient:
    return PhoneClient(APP_URL, timeout_s=10.0)


async def collect(
    phone: PhoneClient,
    *,
    frames: int = 5,
    timeout_s: float = 10.0,
    want: Any = None,
    statuses: int = 0,
) -> list[Message]:
    """Open ``/stream`` and return every message until ``frames`` frames for which ``want(header)``
    holds (and ``statuses`` status messages) have arrived. Closes the stream."""
    out: list[Message] = []
    got_frames = got_status = 0
    agen = phone.messages()
    deadline = time.monotonic() + timeout_s

    async def run() -> None:
        nonlocal got_frames, got_status
        async for msg, _t in agen:
            out.append(msg)
            if msg.type == "frame" and (want is None or want(msg.header)):
                got_frames += 1
            if msg.type == "status":
                got_status += 1
            if got_frames >= frames and got_status >= statuses:
                return

    try:
        await asyncio.wait_for(run(), timeout=max(0.1, deadline - time.monotonic()))
    except asyncio.TimeoutError:
        kinds = [m.type for m in out]
        raise AssertionError(f"stream gave {got_frames}/{frames} wanted frames and {got_status}/{statuses} statuses in {timeout_s} s; got {kinds[:20]}") from None
    finally:
        with suppress(Exception):
            await agen.aclose()
    return out


def frames_of(msgs: list[Message]) -> list[Message]:
    return [m for m in msgs if m.type == "frame"]


async def start_test_pattern(phone: PhoneClient, camera: str = TEST_CAMERA, max_width: int = 1920, fps: float = 30, zoom: float = 1.0) -> dict[str, Any]:
    status = await phone.configure(camera, max_width, fps, zoom)
    st = status["state"]
    assert st["mode"] == ("arkit" if camera == TEST_ARKIT else "camera"), st
    assert st["cameraId"] == camera and st.get("testPattern") is True, st
    return status


async def reset_stream_config(phone: PhoneClient) -> dict[str, Any]:
    return await phone.set_stream_config(
        {
            "maxFps": 30,
            "wide": {"enabled": True, "width": 640, "quality": 0.6, "every": 1},
            "rois": [],
            "roiQuality": 0.9,
            "roiSource": "mac",
            "roiSize": {"w": 0.12, "h": 0.07},
            "arkit": True,
            "depth": False,
        }
    )


def decode_gray(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert img is not None, "part is not a decodable JPEG"
    return img


def find_discs(gray: np.ndarray, min_area: int = 20) -> list[dict[str, float]]:
    """Dark discs (with their bright spot) in a test-pattern image: centre, radius and spot centre,
    in this image's continuous pixel coordinates (pixel (i, j) centre at (i + .5, j + .5))."""
    shape = (np.abs(gray.astype(np.int16) - BACKGROUND) > 60).astype(np.uint8)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(shape, connectivity=8)
    out = []
    for k in range(1, n):
        x, y, w, h, area = stats[k]
        if area < min_area:
            continue
        # A disc cut by the image edge has a biased centroid; skip it.
        if x == 0 or y == 0 or x + w >= gray.shape[1] or y + h >= gray.shape[0]:
            continue
        sub = gray[y : y + h, x : x + w]
        inside = labels[y : y + h, x : x + w] == k
        bright = inside & (sub > (DISC + SPOT) / 2 + 40)
        spot = None
        if bright.sum() >= 1:
            ys, xs = np.nonzero(bright)
            spot = (x + xs.mean() + 0.5, y + ys.mean() + 0.5)
        out.append({"x": centroids[k][0] + 0.5, "y": centroids[k][1] + 0.5, "r": math.sqrt(area / math.pi), "spot": spot})
    return out


def to_sensor(desc: dict[str, Any], px: float, py: float) -> tuple[float, float]:
    """PROTOCOL.md: part pixel (px, py) is sensor (x + px * w / width, y + py * h / height)."""
    x, y, w, h = desc["rect"]
    return x + px * w / desc["width"], y + py * h / desc["height"]


def match_discs(found: list[dict[str, float]], truth: list[dict[str, Any]], desc: dict[str, Any], tol_px: float) -> dict[str, dict[str, Any]]:
    """Map each found disc to sensor pixels and pair it with the nearest true disc; check
    position, radius and the spot direction (up and to the right of the centre)."""
    sx = desc["rect"][2] / desc["width"]
    out = {}
    for f in found:
        fx, fy = to_sensor(desc, f["x"], f["y"])
        best = min(truth, key=lambda d: math.hypot(d["x"] - fx, d["y"] - fy))
        err = math.hypot(best["x"] - fx, best["y"] - fy)
        assert err <= tol_px, f"{desc['name']}: disc found at ({fx:.1f}, {fy:.1f}), drawn at ({best['x']:.1f}, {best['y']:.1f}): {err:.1f} px off"
        assert f["r"] * sx == pytest.approx(best["r"], rel=0.15, abs=2 * sx), (f, best)
        if f["spot"] is not None and best["spotR"] / sx >= 2:
            spx, spy = to_sensor(desc, *f["spot"])
            assert spx > fx and spy < fy, f"{desc['name']}: the bright spot is not up and to the right of the disc: image flipped? {f} {best}"
            assert math.hypot(spx - best["spotX"], spy - best["spotY"]) <= tol_px + best["spotR"] * 0.5
        out[best["name"]] = {"found": (fx, fy), "truth": best}
    return out


def even_rect(roi: dict[str, float], width: int, height: int) -> list[int] | None:
    """PROTOCOL.md: the phone clamps each ROI to the frame and rounds it outwards to even pixels."""

    def floor_even(v: float) -> int:
        return int(math.floor(v / 2)) * 2

    def ceil_even(v: float) -> int:
        return int(math.ceil(v / 2)) * 2

    ew, eh = width - width % 2, height - height % 2
    x0 = min(max(floor_even(roi["x"] * width), 0), ew)
    y0 = min(max(floor_even(roi["y"] * height), 0), eh)
    x1 = min(max(ceil_even((roi["x"] + roi["w"]) * width), 0), ew)
    y1 = min(max(ceil_even((roi["y"] + roi["h"]) * height), 0), eh)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return [x0, y0, x1 - x0, y1 - y0]


def check_frame_header(h: dict[str, Any], mode: str) -> None:
    for key in ("seq", "t", "tSent", "mode", "dropped", "camera", "lens", "roiSource"):
        assert key in h, f"frame header lacks {key}: {sorted(h)}"
    assert h["mode"] == mode
    assert isinstance(h["seq"], int) and isinstance(h["dropped"], int) and h["dropped"] >= 0
    assert h["tSent"] >= h["t"], (h["t"], h["tSent"])
    cam = h["camera"]
    for key in ("id", "position", "type", "zoom", "zoomStable", "width", "height", "fx", "fy", "cx", "cy", "intrinsicsSource", "intrinsicsIncludeZoom"):
        assert key in cam, f"camera block lacks {key}: {cam}"
    assert isinstance(cam["width"], int) and isinstance(cam["height"], int)
    assert len(h.get("gravity") or []) == 3 and len(h.get("rotationRate") or []) == 3
    assert "testPattern" in h and len(h["testPattern"]["discs"]) == 2


# ----------------------------------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------------------------------


async def test_status_time_and_hello() -> None:
    phone = await client()
    try:
        status = await phone.status()
        assert status["app"]["name"] == "EyeCapture", status["app"]
        for key in ("app", "time", "system", "cameras", "state"):
            assert key in status
        st = status["state"]
        for key in ("mode", "cameraId", "width", "height", "zoom", "recording", "lastError", "stream"):
            assert key in st, f"state lacks {key}"
        assert {"clients", "sent", "dropped", "skipped", "bytes", "fps", "mbps", "connections", "encodeMs"} <= set(st["stream"])
        ids = [c["id"] for c in status["cameras"]]
        for cam in status["cameras"]:
            assert {"id", "name", "position", "type", "formats", "zoomPresets"} <= set(cam), cam
            assert cam["position"] in ("front", "back") and cam["type"] in ("wide", "ultrawide", "tele", "arkit")
        if not any(not c.get("testPattern") for c in status["cameras"]):
            # No real camera (the Simulator): the test pattern is listed.
            assert TEST_CAMERA in ids and TEST_ARKIT in ids, ids

        # The phone's clock: /api/time and the status's time are the same clock.
        clock = await phone.sync_clock(10)
        assert clock.round_trip is not None and clock.round_trip < 0.5
        t_phone = await phone.phone_time()
        assert t_phone > status["time"]

        await start_test_pattern(phone)
        config = await reset_stream_config(phone)
        assert config == await phone.request("GET", "/api/stream/config")
        msgs = await collect(phone, frames=3)
        assert msgs[0].type == "hello", [m.type for m in msgs[:3]]
        hello = msgs[0].header
        assert hello["protocol"] == 1 and hello["app"]["name"] == "EyeCapture"
        caps = hello["capabilities"]
        for key in ("arkit", "depth", "roiSources", "formats", "maxRois", "fps60", "zoom", "lensControl"):
            assert key in caps, f"capabilities lack {key}"
        assert "mac" in caps["roiSources"] and caps["maxRois"] == 4 and "jpeg" in caps["formats"]
        assert hello["streamConfig"] == config
        assert hello["state"]["cameraId"] == TEST_CAMERA
        assert {"model", "system"} <= set(hello["device"])

        # Capture times are on the /api/time clock: the latency they imply is small and positive.
        for msg in frames_of(msgs):
            t_local = phone.clock.to_local(msg.header["t"])
            assert t_local is not None
        assert phone.stats.latency_ms is not None and -50 < phone.stats.latency_ms < 1000, phone.stats.to_dict()
    finally:
        await phone.close()


async def test_frames_rectangles_and_pattern_geometry() -> None:
    phone = await client()
    try:
        status = await start_test_pattern(phone, max_width=1920, fps=30, zoom=1.0)
        W, H = status["state"]["width"], status["state"]["height"]
        assert (W, H) == (1920, 1440)
        rois = [
            {"name": "left_eye", "x": 0.50, "y": 0.415, "w": 0.20, "h": 0.25},
            {"name": "right_eye", "x": 0.30, "y": 0.335, "w": 0.20, "h": 0.25},
            {"name": "edge", "x": 0.95, "y": 0.95, "w": 0.10, "h": 0.10},
            {"name": "odd", "x": 0.1003, "y": 0.2003, "w": 0.05, "h": 0.05},
        ]
        await reset_stream_config(phone)
        config = await phone.set_stream_config({"rois": rois, "wide": {"width": 640}})
        assert [r["name"] for r in config["rois"]] == [r["name"] for r in rois]
        assert config["roiSource"] == "mac" and config["wide"]["width"] == 640

        msgs = await collect(phone, frames=8, want=lambda h: len(h.get("parts", [])) == 5)
        good = [m for m in frames_of(msgs) if len(m.header.get("parts", [])) == 5]
        seqs = [m.header["seq"] for m in frames_of(msgs)]
        assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs), seqs
        ts = [m.header["t"] for m in frames_of(msgs)]
        assert ts == sorted(ts), ts
        for msg in good:
            h = msg.header
            check_frame_header(h, "camera")
            cam = h["camera"]
            assert (cam["width"], cam["height"]) == (W, H)
            assert cam["id"] == TEST_CAMERA and cam["position"] == "back" and cam["type"] == "wide"
            assert cam["zoom"] == 1 and cam["intrinsicsSource"] == "test" and cam["intrinsicsIncludeZoom"] is False
            assert cam["fx"] == pytest.approx((W / 2) / math.tan(math.radians(30)), rel=1e-4)
            assert (cam["cx"], cam["cy"]) == pytest.approx((W / 2, H / 2))
            assert cam["fieldOfView"] == pytest.approx(60)
            assert h["roiSource"] == "mac"
            for key in ("position", "iso", "exposureS", "exposureLocked", "focusLocked", "lowLight"):
                assert key in h["lens"], f"lens block lacks {key}"
            truth = h["testPattern"]["discs"]
            descs = {d["name"]: d for d in h["parts"]}
            assert len(descs) == 5, "part names must be unique"
            assert sum(d["bytes"] for d in h["parts"]) == sum(len(p) for p in msg.parts)

            wide = descs["wide"]
            assert wide["kind"] == "wide" and wide["format"] == "jpeg" and wide["rect"] == [0, 0, W, H]
            assert wide["width"] == 640 and wide["height"] == round(H * 640 / W)
            img = decode_gray(msg.part("wide"))
            assert img.shape == (wide["height"], wide["width"])
            found = find_discs(img)
            assert len(found) == 2, f"expected 2 discs in the wide image, found {found}"
            matched = match_discs(found, truth, wide, tol_px=2.5 * W / 640)
            assert set(matched) == {"left_eye", "right_eye"}
            # The disc on the image's right is the person's left eye.
            assert matched["left_eye"]["truth"]["x"] > matched["right_eye"]["truth"]["x"]

            for roi in rois:
                d = descs[roi["name"]]
                assert d["kind"] == "roi" and d["format"] == "jpeg"
                assert d["rect"] == even_rect(roi, W, H), (roi, d["rect"])
                assert (d["width"], d["height"]) == (d["rect"][2], d["rect"][3]), "ROIs are cut at full resolution"
                img = decode_gray(msg.part(roi["name"]))
                assert img.shape == (d["height"], d["width"])
                if roi["name"] in ("left_eye", "right_eye"):
                    found = find_discs(img)
                    assert len(found) == 1, f"{roi['name']}: expected one disc, found {found}"
                    matched = match_discs(found, truth, d, tol_px=1.0)
                    assert roi["name"] in matched, f"the {roi['name']} ROI shows the other disc"
                else:
                    # Nothing drawn there: plain background.
                    assert abs(float(np.median(img)) - BACKGROUND) < 6

            # The engine's own decoding agrees: rectangles and the scale of each part.
            frame = Frame.from_message(msg, time.monotonic())
            decoded = DecodedFrame.from_frame(frame, 0)
            assert (decoded.width, decoded.height) == (W, H)
            assert decoded.images["left_eye"].rect_full == pytest.approx(tuple(descs["left_eye"]["rect"]))
            assert decoded.images["wide"].rect_full == pytest.approx((0, 0, W, H))
            left = next(d for d in truth if d["name"] == "left_eye")
            gray = decoded.images["left_eye"].gray
            (f,) = find_discs(gray)
            full = decoded.images["left_eye"].to_full @ np.array([f["x"], f["y"], 1.0])
            assert math.hypot(full[0] - left["x"], full[1] - left["y"]) < 1.0
            # Gravity from the Simulator (or a phone held landscape, top left) keeps it upright.
            if frame.gravity == (-1.0, 0.0, 0.0):
                assert DecodedFrame.from_frame(frame).rotation == 0
    finally:
        with suppress(PhoneError):
            await reset_stream_config(phone)
        await phone.close()


async def test_zoom_is_reported_and_drawn() -> None:
    phone = await client()
    try:
        await start_test_pattern(phone, max_width=1280, fps=30, zoom=1.0)
        await reset_stream_config(phone)
        status = await phone.set_zoom(2.0)
        assert status["state"]["zoom"] == pytest.approx(2.0)
        assert status["state"]["zoomRange"] == [1, 3]
        msgs = await collect(phone, frames=20, timeout_s=10)
        frames = frames_of(msgs)
        stable = [m.header["camera"]["zoomStable"] for m in frames]
        # Unstable only for frames captured within 0.25 s of the change, then stable for good.
        assert stable[-1] is True and (False not in stable[stable.index(True) :]), stable
        for msg in frames[-5:]:
            h = msg.header
            cam = h["camera"]
            assert cam["zoom"] == pytest.approx(2.0) and h["testPattern"]["zoom"] == pytest.approx(2.0)
            W, H = cam["width"], cam["height"]
            for disc in h["testPattern"]["discs"]:
                assert disc["r"] == pytest.approx(0.025 * W * 2.0)
            wide = next(d for d in h["parts"] if d["name"] == "wide")
            found = find_discs(decode_gray(msg.part("wide")))
            match_discs(found, h["testPattern"]["discs"], wide, tol_px=2.5 * W / wide["width"])
            # The wire intrinsics are unzoomed (like the camera's attachment); the engine scales
            # them by the zoom because they agree with the 60-degree field of view at zoom 1.
            info = Frame.from_message(msg).camera
            assert info.intrinsics is not None
            assert info.intrinsics.fx == pytest.approx(cam["fx"] * 2.0, rel=1e-3)
            assert (info.intrinsics.cx, info.intrinsics.cy) == pytest.approx((W / 2, H / 2))

        clamped = await phone.set_zoom(10.0)
        assert clamped["state"]["zoom"] == pytest.approx(3.0)
        with pytest.raises(PhoneError) as err:
            await phone.request("POST", "/api/zoom", {"zoom": True})
        assert err.value.status == 400
        back = await phone.set_zoom(1.0)
        assert back["state"]["zoom"] == pytest.approx(1.0)
    finally:
        await phone.close()


async def test_lens_settings_round_trip() -> None:
    phone = await client()
    try:
        await start_test_pattern(phone, max_width=640)
        await phone.request("POST", "/api/lens", {"exposureLocked": False, "exposureBias": 0.5, "maxExposureS": 0.004, "whiteBalanceLocked": True})
        await phone.set_focus(locked=True)
        msgs = await collect(phone, frames=3)
        lens = frames_of(msgs)[-1].header["lens"]
        assert lens["exposureBias"] == pytest.approx(0.5) and lens["maxExposureS"] == pytest.approx(0.004)
        assert lens["exposureS"] <= 0.004 + 1e-9 and lens["whiteBalanceLocked"] is True and lens["focusLocked"] is True
        await phone.request("POST", "/api/lens", {"maxExposureS": None, "whiteBalanceLocked": False})
        await phone.set_focus(locked=False)
        msgs = await collect(phone, frames=3)
        lens = frames_of(msgs)[-1].header["lens"]
        assert "maxExposureS" not in lens and lens["focusLocked"] is False

        for body in ({"nonsense": 1}, {"exposureLocked": "yes"}, {"exposureBias": True}):
            with pytest.raises(PhoneError) as err:
                await phone.request("POST", "/api/lens", body)
            assert err.value.status == 400, body
    finally:
        await phone.close()


async def test_bad_requests_are_json_errors() -> None:
    phone = await client()
    try:
        await start_test_pattern(phone, max_width=640)
        before = await phone.request("GET", "/api/stream/config")
        bad = [
            {"nonsense": 1},
            {"roiSource": "nowhere"},
            {"maxFps": 0},
            {"wide": {"width": 10.5}},
            {"wide": {"bogus": 1}},
            {"rois": [{"name": "a", "x": 0, "y": 0, "w": 0.1, "h": 0.1}] * 2},
            {"rois": [{"name": f"r{i}", "x": 0, "y": 0, "w": 0.1, "h": 0.1} for i in range(5)]},
            {"rois": [{"name": "bad name", "x": 0, "y": 0, "w": 0.1, "h": 0.1}]},
            {"rois": [{"name": "zero", "x": 0, "y": 0, "w": 0, "h": 0.1}]},
            {"maxFps": 20, "roiSource": "nowhere"},
        ]
        for body in bad:
            with pytest.raises(PhoneError) as err:
                await phone.set_stream_config(body)
            assert err.value.status == 400, body
        assert await phone.request("GET", "/api/stream/config") == before, "a refused config must change nothing"
        with pytest.raises(PhoneError) as err:
            await phone.request("GET", "/api/no/such/route")
        assert err.value.status == 404 and "HTTP 404" in str(err.value)
        with pytest.raises(PhoneError) as err:
            await phone.configure("no-such-camera")
        assert err.value.status == 400
    finally:
        await phone.close()


async def test_status_messages_and_reconnect() -> None:
    first, second = await client(), await client()
    try:
        await start_test_pattern(first, max_width=640)
        await reset_stream_config(first)
        before = (await first.status())["state"]["stream"]["connections"]
        msgs = await collect(first, frames=1, statuses=1, timeout_s=8)
        status = next(m for m in msgs if m.type == "status").header
        assert status["state"]["cameraId"] == TEST_CAMERA
        assert {"clients", "sent", "dropped"} <= set(status["stream"]) and status["stream"]["clients"] == 1

        # A second client replaces the first: the first stream ends, the second gets hello first.
        agen = first.messages()
        got: list[str] = []

        async def read_first() -> None:
            async for msg, _t in agen:
                got.append(msg.type)

        task = asyncio.create_task(read_first())
        await asyncio.sleep(1.0)
        assert "hello" in got and "frame" in got, got
        msgs = await collect(second, frames=3)
        assert msgs[0].type == "hello"
        try:
            await asyncio.wait_for(task, timeout=5)
        except PhoneError:
            pass  # a broken stream is also an ending
        assert task.done(), "the first stream did not end when a second client connected"

        # Reconnecting works and counts.
        msgs = await collect(first, frames=2)
        assert msgs[0].type == "hello"
        after = (await first.status())["state"]["stream"]["connections"]
        assert after >= before + 3, (before, after)
    finally:
        await first.close()
        await second.close()


def test_stream_http_headers_and_back_pressure() -> None:
    """A client that stops reading gets frames dropped, not queued, and ``dropped`` says so."""
    url = urlparse(APP_URL)
    host, port = url.hostname or "127.0.0.1", url.port or 80

    async def setup() -> None:
        phone = await client()
        try:
            await start_test_pattern(phone, max_width=1920, fps=30)
            await reset_stream_config(phone)
            # No frame-rate cap, so every gap in seq is a frame dropped for back-pressure.
            await phone.set_stream_config({"maxFps": 240, "wide": {"width": 1920, "quality": 0.95}})
        finally:
            await phone.close()

    async def teardown() -> None:
        phone = await client()
        try:
            await reset_stream_config(phone)
        finally:
            await phone.close()

    asyncio.run(setup())
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)
        sock.settimeout(10)
        sock.connect((host, port))
        sock.sendall(f"GET /stream HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())
        time.sleep(4.0)  # not reading: the phone must drop frames
        data = b""
        while b"\r\n\r\n" not in data:
            data += sock.recv(65536)
        head, rest = data.split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        assert lines[0].startswith("HTTP/1.1 200"), lines[0]
        fields = {k.strip().lower(): v.strip() for k, v in (line.split(":", 1) for line in lines[1:])}
        assert fields.get("content-type") == CONTENT_TYPE
        assert "content-length" not in fields and "transfer-encoding" not in fields
        assert fields.get("connection", "").lower() == "close"
        decoder = Decoder()
        msgs = decoder.feed(rest)
        end = time.monotonic() + 3
        while time.monotonic() < end:
            msgs += decoder.feed(sock.recv(1 << 20))
        sock.close()
        frames = [m.header for m in msgs if m.type == "frame"]
        assert msgs[0].type == "hello" and len(frames) >= 5
        assert any(h["dropped"] > 0 for h in frames), [h["dropped"] for h in frames]
        # seq counts every captured frame and nothing is skipped (maxFps 240), so each gap in seq
        # is exactly the next frame's dropped count: drops are neither lost nor counted twice.
        for prev, cur in zip(frames, frames[1:]):
            assert cur["seq"] - prev["seq"] - 1 == cur["dropped"], (prev["seq"], cur["seq"], cur["dropped"])
    finally:
        asyncio.run(teardown())


async def test_synthetic_arkit_block_and_arkit_rois() -> None:
    phone = await client()
    try:
        await start_test_pattern(phone, TEST_ARKIT, max_width=1280)
        await reset_stream_config(phone)
        hello_caps = None
        try:
            config = await phone.set_stream_config({"roiSource": "arkit", "roiSize": {"w": 0.12, "h": 0.15}})
        except PhoneError as exc:
            pytest.fail(f"roiSource arkit refused with the synthetic ARKit face: {exc}")
        assert config["roiSource"] == "arkit"
        msgs = await collect(phone, frames=5, want=lambda h: len(h.get("parts", [])) == 3)
        hello_caps = msgs[0].header["capabilities"]
        assert "arkit" in hello_caps["roiSources"]
        for msg in [m for m in frames_of(msgs) if len(m.header.get("parts", [])) == 3]:
            h = msg.header
            check_frame_header(h, "arkit")
            cam = h["camera"]
            assert cam["type"] == "arkit" and cam["position"] == "front" and cam["zoom"] == 1 and cam["zoomStable"] is True
            assert cam["intrinsicsIncludeZoom"] is True and h["roiSource"] == "arkit"
            assert set(h["lens"]) == {"exposureS", "exposureOffset"}
            a = h["arkit"]
            assert a["tracked"] is True
            for key in ("face", "leftEye", "rightEye", "camera"):
                assert len(a[key]) == 16, key
            assert len(a["lookAt"]) == 3 and set(a["blendShapes"]) == BLEND_SHAPES
            truth = {d["name"]: d for d in h["testPattern"]["discs"]}
            fx, fy, cx, cy = cam["fx"], cam["fy"], cam["cx"], cam["cy"]

            def m(v: list[float]) -> np.ndarray:
                return np.array(v, dtype=float).reshape(4, 4).T  # column-major on the wire

            face, camera = m(a["face"]), m(a["camera"])
            assert np.allclose(face[3], [0, 0, 0, 1]), "column-major: the translation is elements 12, 13, 14"
            for wire, eye in (("left", "leftEye"), ("right", "rightEye")):
                # PROTOCOL.md: eye in camera space = inverse(camera) . face . eye; engine camera
                # coordinates are diag(1, -1, -1) of that.
                p = (np.linalg.inv(camera) @ face @ m(a[eye]))[:3, 3] * np.array([1, -1, -1])
                assert p[2] > 0, "the eye must be in front of the camera"
                u, v = cx + fx * p[0] / p[2], cy + fy * p[1] / p[2]
                disc = truth[f"{wire}_eye"]
                assert (u, v) == pytest.approx((disc["x"], disc["y"]), abs=0.5)
                assert a["eyePixels"][wire] == pytest.approx([disc["x"], disc["y"]], abs=0.5)
                d = next(d for d in h["parts"] if d["name"] == f"{wire}_eye")
                x, y, w, hh = d["rect"]
                assert (x + w / 2, y + hh / 2) == pytest.approx((disc["x"], disc["y"]), abs=2.0)
                found = find_discs(decode_gray(msg.part(f"{wire}_eye")))
                assert len(found) == 1
                match_discs(found, list(truth.values()), d, tol_px=1.0)
            # The person's own left eye is on the image's right (larger u), the face looks at the
            # camera (lookAt points at the camera's origin in face space).
            assert truth["left_eye"]["x"] > truth["right_eye"]["x"]
            look = np.array(a["lookAt"])
            to_camera = (np.linalg.inv(face) @ camera)[:3, 3]
            assert np.dot(look, to_camera) / (np.linalg.norm(look) * np.linalg.norm(to_camera)) > 0.999
            frame = Frame.from_message(msg)
            assert frame.arkit is not None and frame.arkit.tracked
            assert frame.arkit.eye_pixels["left"] == pytest.approx((truth["left_eye"]["x"], truth["left_eye"]["y"]), abs=0.5)

        with pytest.raises(PhoneError) as err:
            await phone.set_zoom(2.0)
        assert err.value.status == 409, "zoom in ARKit mode is a conflict"
    finally:
        with suppress(PhoneError):
            await reset_stream_config(phone)
        await phone.close()


async def test_engine_runs_on_the_app_stream(tmp_path, caplog) -> None:
    """The real Engine (real estimators, filters and models) on the app's stream for a few
    seconds: frames decoded, stream settings accepted, nothing logged as an error."""
    from phonegaze.config import Config
    from phonegaze.pipeline import Engine
    from phonegaze.types import ScreenInfo

    phone = await client()
    try:
        await start_test_pattern(phone, max_width=1920, fps=30)
    finally:
        await phone.close()

    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.camera_id = TEST_CAMERA
    cfg.lens.aim_on_start = False
    screen = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="test")
    engine = Engine(cfg, config_path=tmp_path / "config.json", sinks=[], screen=screen, hotkeys=False, no_cursor=True)
    caplog.set_level(logging.WARNING)
    await engine.start(autoconnect=False)
    try:
        await engine.connect(APP_URL)
        deadline = time.monotonic() + 30
        while engine.processed < 60 and time.monotonic() < deadline:
            await asyncio.sleep(0.25)
        state = engine.state()
        assert engine.processed >= 60, json.dumps(state)[:2000]
        assert state["phone"]["connected"], state["phone"]
        assert state["camera"]["id"] == TEST_CAMERA, state["camera"]
        assert (state["pipeline"].get("fps") or 0) > 5, state["pipeline"]
        assert engine.stream_config is not None and engine.stream_config.get("roiSource") == cfg.stream.roi_source
        assert engine.last_decoded is not None and "wide" in engine.last_decoded.images
        assert engine.preview_jpeg("wide", overlay=True)[:2] == b"\xff\xd8"
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR and r.name.startswith("phonegaze")]
        assert not errors, [f"{r.name}: {r.getMessage()}" for r in errors]
        # Recording the real stream and replaying it is part of tuning; check it round-trips.
        info = engine.start_recording("realapp")
        await asyncio.sleep(2.0)
        summary = engine.stop_recording()
        assert summary is not None, info
    finally:
        await engine.stop()
        phone = await client()
        try:
            await phone.request("POST", "/api/stop")
            await reset_stream_config(phone)
        finally:
            await phone.close()
