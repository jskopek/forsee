"""Recorder and replay: round trip of the raw stream, live playback, and tools/eye-capture
sessions turned into frames. All data synthetic. Owner: Core."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from core_fakes import FakePhone

from phonegaze.protocol import Message
from phonegaze.recorder import Recorder, list_recordings
from phonegaze.replay import eye_capture_dots, eye_capture_screen, iter_eye_capture, iter_frames, play, read_events
from phonegaze.types import GazePoint, Observation


def test_recorder_round_trip(tmp_path) -> None:
    phone = FakePhone()
    phone.mode = "camera"
    phone.camera_id = "back-wide"
    rec = Recorder(tmp_path / "rec1", {"label": "x", "screen": {"width": 100, "height": 50}})
    headers = []
    rec.write_message(Message({"type": "hello", "protocol": 1}), 1.0)
    for i in range(4):
        header, parts = phone.frame()
        from phonegaze.protocol import encode, decode_all

        msg = decode_all(encode(header, parts))[0]
        headers.append(msg.header)
        rec.write_message(msg, 10.0 + i)
    rec.write_observation(Observation(seq=1, t=2.0))
    rec.write_gaze(GazePoint(x=1, y=2, t=3))
    rec.write_event({"type": "lookpoint", "x": 1, "y": 2, "t_local": 11.0})
    rec.write_calibration({"run_id": "r1", "samples": []})
    summary = rec.close()
    assert summary["frames"] == 4 and rec.close() == summary
    rec.write_event({"type": "ignored after close"})

    frames = list(iter_frames(tmp_path / "rec1"))
    assert [f.seq for f in frames] == [h["seq"] for h in headers]
    assert [f.t_received for f in frames] == [10.0, 11.0, 12.0, 13.0]
    assert frames[0].part("wide").data[:2] == b"\xff\xd8"
    assert read_events(tmp_path / "rec1") == [{"type": "lookpoint", "x": 1, "y": 2, "t_local": 11.0}]
    lines = (tmp_path / "rec1" / "observations.jsonl").read_text().splitlines()
    assert Observation.from_dict(json.loads(lines[0])).seq == 1
    listed = list_recordings(tmp_path)
    assert listed[0]["id"] == "rec1" and listed[0]["frames"] == 4 and listed[0]["has_calibration"]


async def test_play_paces_and_stops(tmp_path) -> None:
    rec = Recorder(tmp_path / "r", {})
    for i in range(5):
        rec.write_message(Message({"type": "status", "i": i}), 100.0 + 0.02 * i)
    rec.close()
    got = []
    stop = asyncio.Event()
    t0 = asyncio.get_running_loop().time()
    await play(tmp_path / "r", lambda m, t: got.append(m.header["i"]), stop, speed=1.0, loop=False)
    assert got == [0, 1, 2, 3, 4]
    assert asyncio.get_running_loop().time() - t0 >= 0.07
    assert all("recv" not in m for m in [])
    # Looping playback ends when stop is set.
    got.clear()

    def on(m, t):
        got.append(m.header["i"])
        if len(got) >= 12:
            stop.set()

    await asyncio.wait_for(play(tmp_path / "r", on, stop, speed=20.0, loop=True), 5)
    assert len(got) == 12


def make_eye_capture_session(root: Path, arkit: bool) -> Path:
    """A tiny synthetic session in the tools/eye-capture format (no faces)."""
    root.mkdir(parents=True, exist_ok=True)
    name = "arkit-face" if arkit else "back-wide-2x"
    w, h, n = 160, 120, 12
    writer = cv2.VideoWriter(str(root / f"{name}.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 30, (w, h))
    assert writer.isOpened()
    for i in range(n):
        img = np.full((h, w, 3), 40 + 10 * i, np.uint8)
        writer.write(img)
    writer.release()
    if arkit:
        mats = [f"{m}_c{c}r{r}" for m in ("face", "left_eye", "right_eye") for c in range(4) for r in range(4)]
        cam = [f"camera_c{c}r{r}" for c in range(4) for r in range(4)]
        cols = ["frame", "t", "face_tracked", *mats, "look_at_x", "look_at_y", "look_at_z", *cam, "blink_left", "look_up_right"]
        eye = list(np.eye(4).T.flatten())
        rows = [[i, 100 + i / 30, 1, *(eye * 3), 0.0, 0.0, 1.0, *eye, 0.1, 0.2] for i in range(n)]
    else:
        cols = ["frame", "t", "lens_position", "iso", "exposure_s", "adjusting_focus", "adjusting_exposure"]
        rows = [[i, 100 + i / 30, 0.6, 200, 0.008, 0, 0] for i in range(n)]
    (root / f"{name}.frames.csv").write_text("\n".join([",".join(cols)] + [",".join(str(v) for v in r) for r in rows]) + "\n")
    info = {"segment": name, "mode": "arkit" if arkit else "camera", "cameraId": "arkit-face" if arkit else "wide-id", "cameraName": "Back Camera", "position": "front" if arkit else "back", "width": w, "height": h, "zoom": 1 if arkit else 2.0, "intrinsics": {"fx": 1000.0, "fy": 1000.0, "cx": 80.0, "cy": 60.0, "width": w, "height": h}, "fieldOfView": 70.0, "gravityAtStart": [-1.0, 0.0, 0.0]}
    (root / f"{name}.json").write_text(json.dumps(info))
    (root / f"{name}.motion.csv").write_text("t,gravity_x,gravity_y,gravity_z,rotation_x,rotation_y,rotation_z,accel_x,accel_y,accel_z\n" + "\n".join(f"{100 + i / 50},-1,0.01,0,0,0,0,0,0,0" for i in range(30)) + "\n")
    meta = {"eyesToPhoneCm": 60, "screen": {"width": 1512, "height": 982, "viewportWidth": 1512, "viewportHeight": 982, "devicePixelRatio": 2, "pixelsPerCm": 50.0}}
    (root / "meta.json").write_text(json.dumps(meta))
    events = [
        {"type": "target_on", "seg": name, "order": 0, "index": 4, "x": 756, "y": 491, "t_phone": 100.0},
        {"type": "target_off", "seg": name, "order": 0, "t_phone": 100.3},
    ]
    (root / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    return root


@pytest.mark.parametrize("arkit", [False, True])
def test_iter_eye_capture(tmp_path, arkit) -> None:
    session = make_eye_capture_session(tmp_path / "s", arkit)
    frames = list(iter_eye_capture(session, every=2))
    assert len(frames) == 6
    f = frames[1]
    assert f.seq == 2 and f.t == pytest.approx(100 + 2 / 30)
    assert f.part("wide").width == 160 and f.gravity == pytest.approx((-1.0, 0.01, 0.0))
    if arkit:
        assert f.mode == "arkit" and f.arkit is not None and f.arkit.tracked
        assert np.allclose(f.arkit.face, np.eye(4)) and f.arkit.look_at == (0.0, 0.0, 1.0)
        assert f.arkit.blend_shapes == {"blink_left": 0.1, "look_up_right": 0.2}
        assert f.camera.intrinsics.fx == 1000.0  # ARKit intrinsics already describe the image
    else:
        assert f.mode == "camera" and f.camera.zoom == 2.0 and f.camera.type == "wide"
        assert f.camera.intrinsics.fx == 2000.0  # attachment intrinsics are scaled by zoom (PROTOCOL.md)
        assert f.lens.iso == 200 and f.lens.adjusting_focus is False
    screen = eye_capture_screen(json.loads((session / "meta.json").read_text()))
    assert screen.width == 1512 and screen.width_mm == pytest.approx(302.4)
    name = "arkit-face" if arkit else "back-wide-2x"
    dots = eye_capture_dots([json.loads(x) for x in (session / "events.jsonl").read_text().splitlines()], name)
    assert dots == [{"dot_id": 4, "x": 756.0, "y": 491.0, "t_on": 100.0, "t_off": 100.3}]


def test_score_eye_capture_per_camera(tmp_path, monkeypatch) -> None:
    from core_fakes import FakeEstimator, FakeModel, patch_calibration

    from phonegaze.replay import format_eye_capture, score_eye_capture

    patch_calibration(monkeypatch)
    session = make_eye_capture_session(tmp_path / "s", False)
    name = "back-wide-2x"
    events = []
    for k in range(3):
        t0 = 100.0 + 0.12 * k
        events.append({"type": "target_on", "seg": name, "order": k, "index": k, "x": 100 + 100 * k, "y": 200, "t_phone": t0})
        events.append({"type": "target_off", "seg": name, "order": k, "t_phone": t0 + 0.12})
    (session / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    result = score_eye_capture(session, [FakeEstimator()], lambda: [FakeModel("good"), FakeModel("worse", offset=(5.0, 0.0))], every=1, settle_s=0.0)
    entry = result["cameras"][name]
    assert entry["dots"] == 3 and entry["samples"] == entry["frames"] >= 9 and entry["eyes_found"] == entry["frames"]
    assert entry["chosen"] == "good"
    text = format_eye_capture(result)
    assert name in text and "good" in text and "(chosen)" in text
