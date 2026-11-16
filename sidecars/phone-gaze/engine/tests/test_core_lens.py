"""Upright rotation (images, intrinsics, rectangles), eye crops, zoom switching and aiming
helpers. Owner: Core."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.lens import RoiPlacer, UprightTracker, ZoomController, aim_hints, aim_score, eye_margin, pick_cameras, zoom_options
from phonegaze.protocol import Message
from phonegaze.types import DecodedFrame, Frame, Observation, apply_affine

W, H = 1920, 1080
FX, FY, CX, CY = 1500.0, 1400.0, 900.0, 500.0


def make_frame(point_px: tuple[float, float], gravity, scale: int = 4) -> Frame:
    """A gray8 'wide' part (downscaled by ``scale``) with one bright pixel at a sensor position,
    plus a native-resolution ROI around it."""
    ww, wh = W // scale, H // scale
    img = np.zeros((wh, ww), np.uint8)
    img[int(point_px[1] / scale), int(point_px[0] / scale)] = 255
    rx, ry, rw, rh = int(point_px[0]) - 40, int(point_px[1]) - 30, 80, 60
    roi = np.zeros((rh, rw), np.uint8)
    roi[int(point_px[1]) - ry, int(point_px[0]) - rx] = 255
    header = {
        "type": "frame",
        "seq": 1,
        "t": 1.0,
        "mode": "camera",
        "camera": {"id": "c", "position": "back", "type": "wide", "zoom": 1.0, "width": W, "height": H, "fx": FX, "fy": FY, "cx": CX, "cy": CY, "intrinsicsIncludeZoom": True},
        "gravity": list(gravity),
        "parts": [
            {"name": "wide", "kind": "wide", "format": "gray8", "bytes": img.size, "width": ww, "height": wh, "rect": [0, 0, W, H]},
            {"name": "left_eye", "kind": "roi", "format": "gray8", "bytes": roi.size, "width": rw, "height": rh, "rect": [rx, ry, rw, rh]},
        ],
    }
    return Frame.from_message(Message(header, [img.tobytes(), roi.tobytes()]))


def brightest_full(decoded: DecodedFrame, name: str) -> tuple[float, float]:
    im = decoded.images[name]
    g = im.pixels[..., 0]
    y, x = np.unravel_index(int(np.argmax(g)), g.shape)
    return im.point_to_full((x + 0.5, y + 0.5))


@pytest.mark.parametrize(
    "gravity,rotation",
    [((-1.0, 0.0, 0.0), 0), ((0.0, -1.0, 0.0), 90), ((1.0, 0.0, 0.0), 180), ((0.0, 1.0, 0.0), 270)],
)
def test_upright_images_and_intrinsics_agree(gravity, rotation) -> None:
    point3d = np.array([0.12, 0.05, 0.6])  # sensor camera coordinates, metres
    u = FX * point3d[0] / point3d[2] + CX
    v = FY * point3d[1] / point3d[2] + CY
    frame = make_frame((u, v), gravity)
    tracker = UprightTracker("auto")
    rot = tracker.update(frame.gravity, frame.camera.position)
    assert rot == rotation
    decoded = DecodedFrame.from_frame(frame, rot)
    expected = decoded.intrinsics.project(tuple(decoded.sensor_to_upright_3d @ point3d))
    # The 3D route (rotate the point, project with upright intrinsics) and the image route
    # (find the pixel in the rotated images) must agree.
    roi_full = brightest_full(decoded, "left_eye")
    assert roi_full == pytest.approx(expected, abs=1.0)
    wide_full = brightest_full(decoded, "wide")
    assert wide_full == pytest.approx(expected, abs=4.0)
    # And the affine maps sensor pixels to the same place.
    assert apply_affine(decoded.sensor_to_upright, (u, v)) == pytest.approx(expected, abs=1e-6)
    if rotation in (90, 270):
        assert (decoded.width, decoded.height) == (H, W)
        assert decoded.intrinsics.fx == FY


def test_upright_hysteresis() -> None:
    t = UprightTracker("auto")
    assert t.update((-1.0, 0.0, 0.0), "back") == 0
    # 40 degrees towards the 90 rotation: not yet past the 35-degree acceptance window.
    a = np.radians(40)
    assert t.update((-np.cos(a), -np.sin(a), 0.0), "back") == 0
    a = np.radians(60)
    assert t.update((-np.cos(a), -np.sin(a), 0.0), "back") == 90
    # Lying flat: keep the last rotation.
    assert t.update((0.05, 0.02, -1.0), "back") == 90
    assert UprightTracker("270").update((-1.0, 0.0, 0.0), "back") == 270


def test_roi_placer_round_trip_and_resend_rule() -> None:
    frame = make_frame((960, 540), (0.0, -1.0, 0.0))
    decoded = DecodedFrame.from_frame(frame, 90)
    obs = Observation.empty(decoded)
    obs.left.iris_center = (600.0, 700.0)
    obs.right.iris_center = (450.0, 700.0)
    obs.distance = 0.5
    placer = RoiPlacer(width_mm=30, aspect=0.6)
    plan = placer.plan(decoded, obs)
    assert plan is not None and {r["name"] for r in plan.rois} == {"left_eye", "right_eye"}
    w_expected = decoded.intrinsics.fx * 0.030 / 0.5
    x, y, w, h = plan.upright["left_eye"]
    assert w == pytest.approx(w_expected) and h == pytest.approx(0.6 * w_expected)
    assert (x + w / 2, y + h / 2) == pytest.approx((600.0, 700.0))
    # The normalised sensor rectangle maps back onto the same upright rectangle.
    roi = next(r for r in plan.rois if r["name"] == "left_eye")
    corners = [(roi["x"] * W, roi["y"] * H), ((roi["x"] + roi["w"]) * W, (roi["y"] + roi["h"]) * H)]
    up = np.array([apply_affine(decoded.sensor_to_upright, c) for c in corners])
    assert up.min(axis=0) == pytest.approx((x, y), abs=0.05)
    assert up.max(axis=0) == pytest.approx((x + w, y + h), abs=0.05)
    assert placer.should_send(plan)
    placer.mark_sent(plan)
    obs.left.iris_center = (601.0, 700.5)
    assert not placer.should_send(placer.plan(decoded, obs))
    obs.left.iris_center = (700.0, 700.0)
    assert placer.should_send(placer.plan(decoded, obs))
    obs2 = Observation.empty(decoded)
    assert placer.plan(decoded, obs2) is None


def test_zoom_controller() -> None:
    zc = ZoomController(target=2.0, edge_margin=0.08, stable_s=1.0, cooldown_s=2.0)
    obs = Observation(seq=0, t=0)
    obs.left.iris_center = (1050.0, 540.0)
    obs.right.iris_center = (870.0, 540.0)
    # At 1x, eyes near the centre: zoom in only after being stable for 1 s.
    assert zc.decide(obs, W, H, 1.0, 10.0) is None
    assert zc.decide(obs, W, H, 1.0, 11.1) == 2.0
    zc.note_switch(11.1)
    # At 2x, an eye near the edge: zoom out, but not during the cooldown.
    obs.left.iris_center = (1900.0, 540.0)
    assert zc.decide(obs, W, H, 2.0, 12.0) is None
    assert zc.decide(obs, W, H, 2.0, 13.5) == 1.0
    assert eye_margin({"a": (960.0, 540.0)}, W, H, 2.0) == pytest.approx(0.5)


def test_aim_score_and_hints() -> None:
    good = {"iris_px": 100.0, "sharpness": 500.0, "eyes_in_frame": 2, "edge_margin": 0.3, "brightness": 120}
    small = dict(good, iris_px=40.0)
    one_eye = dict(good, eyes_in_frame=1)
    assert aim_score(good) > aim_score(small) > 0
    assert aim_score(good) > aim_score(one_eye)
    assert aim_score(good, adjusting_focus=True) < aim_score(good)
    assert aim_score({"iris_px": None, "eyes_in_frame": 0}) == 0
    obs = Observation(seq=0, t=0)
    assert aim_hints(None, {}, W, H)[0].startswith("No eyes")
    obs.left.iris_center = (1800.0, 540.0)
    obs.right.iris_center = (1700.0, 540.0)
    hints = aim_hints(obs, dict(good, iris_px=20.0, brightness=30), W, H)
    text = " ".join(hints)
    assert "towards your left" in text and "move closer" in text and "dark" in text
    obs.left.iris_center = (1000.0, 540.0)
    obs.right.iris_center = (900.0, 540.0)
    assert aim_hints(obs, good, W, H) == []


def test_camera_and_zoom_choices() -> None:
    cams = [{"id": "t", "type": "tele", "position": "back"}, {"id": "a", "type": "arkit", "position": "front"}, {"id": "w", "type": "wide", "position": "back", "zoomPresets": [2.0, 1.78, 5]}, {"id": "f", "type": "wide", "position": "front"}]
    assert [c["id"] for c in pick_cameras(cams)] == ["w", "f", "t", "a"]
    assert zoom_options(cams[2]) == [1.0, 1.78, 2.0]
    assert zoom_options(cams[1]) == [1.0]
    assert zoom_options(cams[2], [3, 1]) == [1.0, 3.0]
