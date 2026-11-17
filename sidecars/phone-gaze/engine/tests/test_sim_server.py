"""Simulated phone: protocol conformance (docs/PROTOCOL.md), ARKit layout, control API, frame rate."""

from __future__ import annotations

import asyncio
import math
import time

import aiohttp
import numpy as np
import pytest

from phonegaze.config import SimConfig
from phonegaze.phone import PhoneClient, PhoneError
from phonegaze.protocol import CONTENT_TYPE
from phonegaze.sim.server import SimPhone, sensor_roi_rect
from phonegaze.types import DecodedFrame, Frame, upright_rotation


def _cfg(**kw) -> SimConfig:
    cfg = SimConfig()
    for k, v in kw.items():
        setattr(cfg, k, v)
    return cfg


async def _start(camera: str = "wide", autostart: bool = True, workers: int = 0, **kw) -> tuple[SimPhone, PhoneClient]:
    sim = SimPhone(_cfg(camera=camera, **kw), autostart=autostart, render_workers=workers)
    url = await sim.start(port=0)
    return sim, PhoneClient(url)


async def _messages(client: PhoneClient, n_frames: int, timeout: float = 20.0):
    out = []
    frames = 0

    async def run():
        nonlocal frames
        async for msg, t in client.messages():
            out.append((msg, t))
            if msg.type == "frame":
                frames += 1
                if frames >= n_frames:
                    break

    await asyncio.wait_for(run(), timeout)
    return out


async def test_status_and_time_shapes():
    sim, client = await _start(autostart=False)
    try:
        st = await client.status()
        assert set(st) >= {"app", "time", "system", "cameras", "state"}
        assert st["state"]["mode"] == "idle"
        cams = {c["type"] + "/" + c["position"]: c for c in st["cameras"]}
        assert set(cams) == {"wide/back", "ultrawide/back", "tele/back", "wide/front", "arkit/front"}
        assert cams["wide/back"]["zoomPresets"] == [2.0]
        assert cams["ultrawide/back"]["zoomPresets"] == [1.78]
        assert cams["tele/back"]["minFocusDistanceMM"] == 1350.0
        assert cams["arkit/front"]["id"] == "arkit-face"
        assert cams["arkit/front"]["depthSource"] == "truedepth"
        for c in st["cameras"]:
            assert set(c) >= {"id", "name", "position", "type", "minFocusDistanceMM", "canFocus", "formats", "zoomPresets"}
        t0 = await client.phone_time()
        await asyncio.sleep(0.05)
        assert 0.04 < await client.phone_time() - t0 < 1.0
        # Configure starts the camera; the status says so.
        st = await client.configure(cams["wide/back"]["id"], 3840, 30, 2.0)
        s = st["state"]
        assert s["mode"] == "camera" and s["width"] == 3840 and s["height"] == 2160 and s["zoom"] == 2.0
        assert s["nativeZoomFactors"] == [2.0] and s["cameraType"] == "wide"
        assert set(s["intrinsics"]) == {"fx", "fy", "cx", "cy", "width", "height"}
        assert set(s["stream"]) >= {"clients", "sent", "dropped", "skipped", "bytes", "fps", "mbps", "lastFrameBytes", "connections"}
        with pytest.raises(PhoneError) as err:
            await client.configure("no-such-camera")
        assert err.value.status == 400
    finally:
        await client.close()
        await sim.stop()


async def test_stream_hello_frames_status_decode():
    sim, client = await _start()
    try:
        await client.set_stream_config({"maxFps": 30, "roiSource": "vision", "roiSize": {"w": 0.06, "h": 0.05}})
        msgs = await _messages(client, 4)
        kinds = [m.type for m, _ in msgs]
        assert kinds[0] == "hello"
        hello = msgs[0][0].header
        assert hello["protocol"] == 1
        assert hello["sim"]["screen"]["source"] == "sim"
        assert set(hello["capabilities"]) >= {"arkit", "depth", "roiSources", "formats", "maxRois"}
        frames = [m for m, _ in msgs if m.type == "frame"]
        seqs = [f.header["seq"] for f in frames]
        assert seqs == sorted(seqs)
        for msg in frames:
            h = msg.header
            for key in ("seq", "t", "tSent", "mode", "dropped", "camera", "lens", "gravity", "rotationRate", "parts", "sim"):
                assert key in h, key
            assert h["tSent"] >= h["t"]
            assert h["camera"]["intrinsicsSource"] == "sim" and h["camera"]["intrinsicsIncludeZoom"] is True
            names = [p["name"] for p in h["parts"]]
            assert names[0] == "wide" and set(names[1:]) <= {"left_eye", "right_eye"}
            for p, data in zip(h["parts"], msg.parts):
                assert p["bytes"] == len(data) and data[:2] == b"\xff\xd8"  # JPEG
            frame = Frame.from_message(msg)
            dec = DecodedFrame.from_frame(frame)
            assert dec.rotation == 180  # the default orientation, recovered from gravity
            assert dec.images["wide"].pixels.shape == (360, 640, 3)
            for name in ("left_eye", "right_eye"):
                if name in dec.images:
                    side = name.split("_")[0]
                    # ROI placed by "vision" contains the iris centre.
                    x, y, w, hh = dec.images[name].rect_full
                    cx, cy = h["sim"]["eyes"][side]["irisCenter"]
                    assert x < cx < x + w and y < cy < y + hh
            sim_block = h["sim"]
            for key in ("gaze", "leftEyeCenter", "rightEyeCenter", "leftGazeDir", "rightGazeDir", "blink", "headRotation"):
                assert key in sim_block
    finally:
        await client.close()
        await sim.stop()


async def test_mac_rois_are_rounded_outwards_to_even_pixels():
    assert sensor_roi_rect(0.1, 0.2, 0.1, 0.1, 3840, 2160) == (384, 432, 384, 216)
    assert sensor_roi_rect(0.10001, 0.20001, 0.1, 0.1, 3840, 2160) == (384, 432, 386, 218)
    assert sensor_roi_rect(0.95, 0.95, 0.2, 0.2, 3840, 2160) == (3648, 2052, 192, 108)
    assert sensor_roi_rect(1.2, 0.5, 0.1, 0.1, 3840, 2160) is None
    sim, client = await _start()
    try:
        await client.set_stream_config({"rois": [{"name": "left_eye", "x": 0.45, "y": 0.4, "w": 0.0712, "h": 0.05}], "wide": {"enabled": False}})
        msgs = await _messages(client, 2)
        f = [m for m, _ in msgs if m.type == "frame"][-1]
        (p,) = f.header["parts"]
        x, y, w, h = p["rect"]
        assert all(int(v) % 2 == 0 for v in (x, y, w, h))
        assert (p["width"], p["height"]) == (w, h)  # native resolution
    finally:
        await client.close()
        await sim.stop()


async def test_stream_config_validation():
    sim, client = await _start(autostart=False)
    try:
        cfg = await client.request("GET", "/api/stream/config")
        assert cfg["maxFps"] == 30 and cfg["roiSource"] == "mac"
        bad = [
            {"nope": 1},
            {"wide": {"width": 3.5}},
            {"wide": {"quality": 2}},
            {"wide": {"every": 0}},
            {"rois": [{"name": "a b", "x": 0, "y": 0, "w": 0.1, "h": 0.1}]},
            {"rois": [{"name": "a", "x": 0, "y": 0, "w": 0.1, "h": 0.1}, {"name": "a", "x": 0, "y": 0, "w": 0.1, "h": 0.1}]},
            {"rois": [{"name": f"r{i}", "x": 0, "y": 0, "w": 0.1, "h": 0.1} for i in range(5)]},
            {"roiSource": "magic"},
            {"roiSize": {"w": 0.1, "z": 1}},
            {"arkit": "yes"},
        ]
        for body in bad:
            with pytest.raises(PhoneError) as err:
                await client.set_stream_config(body)
            assert err.value.status == 400, body
        assert await client.request("GET", "/api/stream/config") == cfg  # nothing changed
        new = await client.set_stream_config({"wide": {"width": 320}})
        assert new["wide"] == {"enabled": True, "width": 320, "quality": 0.6, "every": 1}
        # Zoom and lens need a running camera.
        for path, body in (("/api/zoom", {"zoom": 2}), ("/api/lens", {"focusLocked": True})):
            with pytest.raises(PhoneError) as err:
                await client.request("POST", path, body)
            assert err.value.status == 409
    finally:
        await client.close()
        await sim.stop()


async def test_zoom_changes_intrinsics_and_lens_controls():
    sim, client = await _start()
    try:
        st1 = (await client.status())["state"]
        st2 = (await client.set_zoom(2.0))["state"]
        assert st2["zoom"] == 2.0
        assert st2["intrinsics"]["fx"] == pytest.approx(2 * st1["intrinsics"]["fx"])
        assert (await client.set_zoom(99.0))["state"]["zoom"] == 10.0  # clamped
        await client.set_zoom(2.0)
        st = await client.request("POST", "/api/lens", {"focusLocked": True, "exposureBias": -1.0, "maxExposureS": 0.004})
        lens = st["state"]["lens"]
        assert lens["focusLocked"] is True and lens["exposureBias"] == -1.0 and lens["maxExposureS"] == 0.004
        with pytest.raises(PhoneError) as err:
            await client.request("POST", "/api/lens", {"focusLocked": "yes"})
        assert err.value.status == 400
        msgs = await _messages(client, 3)
        f = [m for m, _ in msgs if m.type == "frame"][-1].header
        assert f["camera"]["zoom"] == 2.0 and f["lens"]["focusLocked"] is True
    finally:
        await client.close()
        await sim.stop()


async def test_telephoto_is_blurry_at_desk_distance():
    sim, _ = await _start(camera="tele", autostart=False)
    try:
        sc = sim.scene
        sc.set_camera(sc._camera_by_kind("tele"), 3840, 2160)  # noqa: SLF001
        for _ in range(30):
            sc.step(1 / 30)
        tele = sc.blur_sigma_native(sc.capture())
        sc.set_camera(sc._camera_by_kind("wide"), 3840, 2160)  # noqa: SLF001
        for _ in range(30):
            sc.step(1 / 30)
        wide = sc.blur_sigma_native(sc.capture())
        assert tele > 15 and wide < 1
    finally:
        await sim.stop()


async def test_arkit_block_layout_and_axes():
    sim, client = await _start(camera="arkit")
    sim.scene.knobs.arkit_eye_noise_deg = 0
    sim.scene.knobs.arkit_eye_bias_deg = (0.0, 0.0)
    sim.scene.knobs.arkit_head_noise_mm = 0
    sim.scene.knobs.arkit_head_noise_deg = 0
    try:
        await client.set_stream_config({"roiSource": "arkit", "roiSize": {"w": 0.1, "h": 0.08}})
        msgs = await _messages(client, 3)
        msg = [m for m, _ in msgs if m.type == "frame"][-1]
        h = msg.header
        assert h["mode"] == "arkit" and h["camera"]["id"] == "arkit-face"
        assert h["camera"]["intrinsicsSource"] == "arkit"
        ar = h["arkit"]
        assert ar["tracked"] is True
        for key in ("face", "leftEye", "rightEye", "camera"):
            assert len(ar[key]) == 16 and ar[key][15] == 1.0 and ar[key][3] == 0.0  # column-major
        assert set(ar["blendShapes"]) == {f"{n}_{s}" for n in ("blink", "look_down", "look_in", "look_out", "look_up", "squint", "wide") for s in ("left", "right")}
        frame = Frame.from_message(msg)
        dec = DecodedFrame.from_frame(frame)
        a = frame.arkit
        assert a is not None
        # ARKit world is gravity-aligned: world y is up, against gravity.
        flip = np.diag([1.0, -1.0, -1.0])
        cam_inv = np.linalg.inv(a.camera)
        for side, eye_m in (("left", a.left_eye), ("right", a.right_eye)):
            m = cam_inv @ a.face @ eye_m
            p_up = dec.sensor_to_upright_3d @ (flip @ m[:3, 3])
            assert p_up == pytest.approx(h["sim"][f"{side}EyeCenter"], abs=1e-9)
            gaze_up = dec.sensor_to_upright_3d @ (flip @ m[:3, 2])
            assert gaze_up == pytest.approx(h["sim"][f"{side}GazeDir"], abs=1e-9)
            # eyePixels are the eye centres in sensor pixels.
            px = np.asarray(ar["eyePixels"][side])
            up = dec.sensor_to_upright @ np.array([*px, 1.0])
            assert up[:2] == pytest.approx(h["sim"]["eyes"][side]["eyeballCenter"], abs=1e-6)
        # Face axes: +x towards the person's left, which is the camera's +x side.
        face_cam = cam_inv @ a.face
        x_up = dec.sensor_to_upright_3d @ (flip @ face_cam[:3, 0])
        assert x_up[0] > 0.9
        world_up = a.camera[:3, :3] @ (flip @ (np.linalg.inv(dec.sensor_to_upright_3d) @ np.array([0, -1.0, 0])))
        assert world_up[1] > 0.9  # "up" in the image is roughly world +y
        # lookAt points along the gaze, in face space.
        assert np.linalg.norm(ar["lookAt"]) > 0.3
        names = [p["name"] for p in h["parts"]]
        assert "left_eye" in names and "right_eye" in names and h["roiSource"] == "arkit"
        # Zoom is refused in ARKit mode.
        with pytest.raises(PhoneError) as err:
            await client.set_zoom(2)
        assert err.value.status == 409
    finally:
        await client.close()
        await sim.stop()


async def test_arkit_noise_and_bias_are_applied():
    sim, client = await _start(camera="arkit")
    sim.scene.knobs.arkit_eye_noise_deg = 0
    sim.scene.knobs.arkit_eye_bias_deg = (3.0, 0.0)
    try:
        msgs = await _messages(client, 2)
        msg = [m for m, _ in msgs if m.type == "frame"][-1]
        frame = Frame.from_message(msg)
        a = frame.arkit
        g = (np.linalg.inv(a.camera) @ a.face @ a.left_eye)[:3, 2]
        dec = DecodedFrame.from_frame(frame)
        g_up = dec.sensor_to_upright_3d @ (np.diag([1.0, -1, -1]) @ g)
        true = np.asarray(msg.header["sim"]["leftGazeDir"])
        ang = math.degrees(math.acos(float(np.clip(g_up @ true, -1, 1))))
        assert 2.0 < ang < 4.0
    finally:
        await client.close()
        await sim.stop()


async def test_control_api():
    sim, client = await _start()
    try:
        sim.scene.knobs.jitter_deg = 0
        sim.scene.knobs.blink_rate_per_min = 0
        async with aiohttp.ClientSession() as s:
            base = client.base_url
            r = await s.post(base + "/sim/gaze", json={"x": 300, "y": 200, "instant": True})
            assert (await r.json()) == {"ok": True}
            await asyncio.sleep(0.15)
            truth = await (await s.get(base + "/sim/truth")).json()
            assert truth["gaze"] == pytest.approx([300, 200], abs=0.01)
            # Human mode: not there yet after 100 ms, there after 600 ms.
            await s.post(base + "/sim/gaze", json={"x": 1300, "y": 800})
            await asyncio.sleep(0.1)
            truth = await (await s.get(base + "/sim/truth")).json()
            assert abs(truth["gaze"][0] - 1300) > 100
            await asyncio.sleep(0.6)
            truth = await (await s.get(base + "/sim/truth")).json()
            assert truth["gaze"] == pytest.approx([1300, 800], abs=1.0)
            # Head pose and camera moves.
            r = await s.post(base + "/sim/head", json={"position": [0.03, -0.02, 0.5], "rotation": [10, 0, 0]})
            assert r.status == 200
            await asyncio.sleep(0.15)
            truth = await (await s.get(base + "/sim/truth")).json()
            assert truth["distance"] == pytest.approx(math.hypot(0.03, 0.02, 0.5), abs=1e-3)
            r = await s.post(base + "/sim/camera", json={"orientation": 90})
            assert r.status == 200
            st = await client.status()
            assert upright_rotation(tuple(st["state"]["gravity"]), "back") == 90
            # Knobs.
            r = await s.post(base + "/sim/noise", json={"pixelNoise": 5, "arkit_eye_bias_deg": [1, 2]})
            k = await r.json()
            assert k["pixel_noise"] == 5 and k["arkit_eye_bias_deg"] == [1, 2]
            r = await s.post(base + "/sim/noise", json={"bogus": 1})
            assert r.status == 400 and "error" in await r.json()
            # Scripts and flash.
            assert (await s.post(base + "/sim/script", json={"name": "drift"})).status == 200
            assert (await s.post(base + "/sim/script", json={"name": "dance"})).status == 400
            r = await s.post(base + "/sim/flash", json={"pattern": "10", "rateHz": 50})
            assert (await r.json())["flash"]["pattern"] == "10"
            assert (await s.post(base + "/sim/flash", json={"pattern": "1x"})).status == 400
            scene = await (await s.get(base + "/sim/scene")).json()
            assert len(scene["screenCornersWorld"]) == 4 and scene["person"]["irisRadiusM"] == pytest.approx(0.00585)
            # Errors are JSON.
            r = await s.get(base + "/no/such/route")
            assert r.status == 404 and "error" in await r.json()
    finally:
        await client.close()
        await sim.stop()


def test_flash_pattern_drives_the_screen_level():
    from phonegaze.sim.scene import SimScene

    sc = SimScene(1)
    sc.knobs.flash_latency_ms = 0
    sc.set_flash("1010", rate_hz=10, t0=0.0, repeat=False)
    levels = [sc.screen_level(t) for t in (0.05, 0.15, 0.25, 0.35, 0.5)]
    assert levels == [1.0, sc.knobs.flash_dark, 1.0, sc.knobs.flash_dark, 1.0]
    sc.knobs.flash_latency_ms = 100
    assert sc.screen_level(0.12) == 1.0 and sc.screen_level(0.22) == sc.knobs.flash_dark


async def test_stream_response_headers_and_single_client():
    sim, client = await _start()
    try:
        async with aiohttp.ClientSession() as s:
            r1 = await s.get(client.base_url + "/stream")
            assert r1.status == 200 and r1.headers["Content-Type"] == CONTENT_TYPE
            assert "Content-Length" not in r1.headers and r1.headers.get("Transfer-Encoding") is None
            await r1.content.read(8)
            r2 = await s.get(client.base_url + "/stream")  # closes the first
            await r2.content.read(8)
            data = await asyncio.wait_for(r1.read(), 5)
            assert isinstance(data, bytes)
            r2.close()
    finally:
        await client.close()
        await sim.stop()


@pytest.mark.slow
async def test_frame_rate_with_eye_crops():
    """About 30 frames per second with a wide part and two 2x eye crops, using render
    processes; slower machines degrade by dropping frames, never by queueing."""
    sim, client = await _start(workers=3)
    try:
        sim.scene.set_zoom(2.0)
        await client.set_stream_config({"roiSource": "vision", "roiSize": {"w": 0.07, "h": 0.07}})
        msgs = await _messages(client, 10, timeout=60)  # warm up
        t0 = time.monotonic()
        msgs = await _messages(client, 60, timeout=60)
        dt = time.monotonic() - t0
        frames = [m for m, _ in msgs if m.type == "frame"]
        fps = (len(frames) - 1) / dt
        print(f"simulated stream: {fps:.1f} fps, {sim.stats['dropped']} dropped")
        assert all(len(f.header["parts"]) == 3 for f in frames[-5:])
        assert fps > 12  # 29-30 on a 4-core Linux container; frames are dropped, not queued
        lat = [f.header["tSent"] - f.header["t"] for f in frames]
        assert max(lat) < 0.5
    finally:
        await client.close()
        await sim.stop()
