"""Simulator rendering: the iris edge and the screen's corneal reflection are geometrically exact,
and parts survive the trip through the sensor orientation and DecodedFrame."""

from __future__ import annotations

import math

import numpy as np
import pytest

from phonegaze.sim.eyecrop import render_eye_crop
from phonegaze.sim.scene import SimScene, corneal_reflection_point
from phonegaze.types import DecodedFrame, Frame, Intrinsics, rotation_affine


def _moments(mask: np.ndarray) -> tuple[float, float, float, np.ndarray]:
    h, w = mask.shape
    ys, xs = np.mgrid[0:h, 0:w] + 0.5  # pixel centres, continuous convention
    area = float(mask.sum())
    cx, cy = float((mask * xs).sum() / area), float((mask * ys).sum() / area)
    dx, dy = xs - cx, ys - cy
    cov = np.array([[(mask * dx * dx).sum(), (mask * dx * dy).sum()], [(mask * dx * dy).sum(), (mask * dy * dy).sum()]]) / area
    return area, cx, cy, cov


CASES = [
    dict(side="left", zoom=2.0, gaze=(756.0, 491.0)),
    dict(side="right", zoom=2.0, gaze=(100.0, 100.0)),
    dict(side="left", zoom=1.0, gaze=(1400.0, 900.0), head_rotation_deg=(15.0, -8.0, 5.0), crop_size=(128, 96)),
    dict(side="right", zoom=2.0, gaze=(1200.0, 300.0), distance_m=0.45, head_offset_m=(0.05, 0.02, 0.0), crop_size=(320, 200)),
]


@pytest.mark.parametrize("case", CASES)
def test_iris_edge_is_the_exact_projected_limbus(case):
    img, truth = render_eye_crop(**case, lids_deg=(50.0, 50.0), lamp=False, screen_level=0.0, with_masks=True)
    mask = truth["masks"]["iris"]
    cx, cy, a, b, ang = truth["crop"]["irisEllipse"]
    area, mx, my, cov = _moments(mask)
    # Area and centroid of the (anti-aliased) iris coverage match the analytic ellipse.
    assert area == pytest.approx(math.pi * a * b, rel=2e-3)
    assert mx == pytest.approx(cx, abs=0.02)
    assert my == pytest.approx(cy, abs=0.02)
    # Second moments of a filled ellipse: semi-axes are 2 sqrt(eigenvalues).
    w, v = np.linalg.eigh(cov)
    assert 2 * math.sqrt(w[1]) == pytest.approx(a, abs=0.05)
    assert 2 * math.sqrt(w[0]) == pytest.approx(b, abs=0.05)
    if a - b > 0.5:
        major = v[:, 1]
        got = (math.degrees(math.atan2(major[1], major[0])) + 90) % 180 - 90
        assert abs((got - ang + 90) % 180 - 90) < 1.0
    # The projected 3D centre differs from the ellipse centre, but only slightly.
    icx, icy = truth["crop"]["irisCenter"]
    assert math.hypot(icx - cx, icy - cy) < 0.5
    # The colour image agrees: iris pixels are dark, the sclera ring around them is light.
    gray = img.astype(float).mean(axis=2)
    assert gray[mask > 0.99].mean() < 110
    assert img.shape == (*mask.shape, 3)


def _reflected_polygon(truth: dict, per_edge: int = 40) -> np.ndarray:
    sim = truth["sim"]
    side = truth["side"]
    cc = np.asarray(sim[f"{side}CorneaCenter"])
    corners = np.asarray(sim["screenCorners"])
    K = Intrinsics.from_dict(truth["intrinsics"])
    x0, y0 = truth["rect"][:2]
    pts = []
    for i in range(4):
        p, q = corners[i], corners[(i + 1) % 4]
        for s in np.linspace(0, 1, per_edge, endpoint=False):
            r = corneal_reflection_point(cc, np.zeros(3), p + (q - p) * s)
            u, v = K.project(tuple(r))
            pts.append((u - x0, v - y0))
    return np.asarray(pts)


def _polygon_centroid(pts: np.ndarray) -> tuple[float, float, float]:
    x, y = pts[:, 0], pts[:, 1]
    x1, y1 = np.roll(x, -1), np.roll(y, -1)
    cross = x * y1 - x1 * y
    area = cross.sum() / 2
    return abs(area), float(((x + x1) * cross).sum() / (6 * area)), float(((y + y1) * cross).sum() / (6 * area))


@pytest.mark.parametrize("case", CASES[:2] + CASES[3:])
def test_screen_reflection_is_exact(case):
    img, truth = render_eye_crop(**case, lids_deg=(50.0, 50.0), lamp=False, with_masks=True)
    g = truth["masks"]["screen_glint"]
    assert truth["crop"]["reflectionVisible"]
    area, gx, gy, _ = _moments(g)
    parea, px, py = _polygon_centroid(_reflected_polygon(truth))
    assert area == pytest.approx(parea, rel=0.01)
    assert gx == pytest.approx(px, abs=0.03)
    assert gy == pytest.approx(py, abs=0.03)
    # The reflection of the screen centre is inside the glint and close to its centroid.
    rx, ry = truth["crop"]["reflectionCenter"]
    assert math.hypot(rx - gx, ry - gy) < 1.0
    # Mirror image: the screen's top-left corner appears on the image's right.
    tl, tr = truth["crop"]["reflectionCorners"][:2]
    assert tl[0] > tr[0]


def test_reflection_size_matches_the_research_estimate():
    # docs/research/02: a 14-inch screen at 60 cm reflects to about 17 x 11 px at 2x.
    _, truth = render_eye_crop("left", zoom=2.0, lids_deg=(50.0, 50.0), lamp=False, with_masks=True)
    c = np.asarray(truth["crop"]["reflectionCorners"])
    w = np.linalg.norm(c[0] - c[1])
    h = np.linalg.norm(c[0] - c[3])
    assert 12 < w < 24 and 7 < h < 16


def test_dark_screen_has_no_reflection_and_lids_close_in_a_blink():
    _, truth = render_eye_crop("left", screen_level=0.0, lamp=False, with_masks=True)
    assert truth["masks"]["screen_glint"].sum() == 0
    _, shut = render_eye_crop("left", blink=1.0, with_masks=True)
    assert shut["masks"]["open"].sum() == 0
    assert shut["sim"]["blink"] is True


def _frame_for(sc: SimScene, cap, parts) -> Frame:
    from phonegaze.protocol import Message

    header = {
        "type": "frame",
        "seq": 1,
        "t": 1.0,
        "mode": "camera",
        "camera": sc.camera_header(cap),
        "gravity": cap.gravity,
        "parts": [p[0] for p in parts],
        "sim": cap.truth,
    }
    return Frame.from_message(Message(header, [p[1] for p in parts]))


@pytest.mark.parametrize("orientation", [0, 90, 180, 270])
def test_parts_decode_upright_where_the_truth_says(orientation):
    import cv2

    sc = SimScene(2, orientation=orientation)
    sc.knobs.blink_rate_per_min = 0
    sc.knobs.lamp = False
    sc.knobs.glint_gain = 0
    sc.knobs.pixel_noise = 0
    sc.person.params.iris_color = "dark"
    sc.person.params.upper_lid_deg = sc.person.params.lower_lid_deg = 50.0
    sc.set_zoom(2.0)
    sc.step(0.05)
    cap = sc.capture()
    eye = cap.truth["eyes"]["left"]
    # The ROI around the left eye, in SENSOR pixels.
    inv = np.linalg.inv(rotation_affine(orientation, cap.width, cap.height))
    sx, sy, _ = inv @ np.array([*eye["irisCenter"], 1.0])
    rect = (float(round(sx) - 150), float(round(sy) - 150), 300.0, 300.0)
    roi = sc.render_part(cap, rect, 300, 300, ss=3)
    wide = sc.render_part(cap, (0, 0, cap.width, cap.height), 640, 360)
    parts = []
    for name, kind, im, r in (("wide", "wide", wide, [0, 0, cap.width, cap.height]), ("left_eye", "roi", roi, list(rect))):
        ok, buf = cv2.imencode(".png", im)
        assert ok
        parts.append(({"name": name, "kind": kind, "format": "jpeg", "width": im.shape[1], "height": im.shape[0], "rect": r}, buf.tobytes()))
    decoded = DecodedFrame.from_frame(_frame_for(sc, cap, parts))
    assert decoded.rotation == orientation
    img = decoded.images["left_eye"]
    gray = img.gray.astype(float)
    dark = (gray < 90).astype(float)
    # Keep the blob around the image centre (the iris and pupil).
    n, lab = cv2.connectedComponents((dark > 0).astype(np.uint8))
    centre_label = lab[150, 150]
    assert centre_label != 0
    blob = (lab == centre_label).astype(float)
    _, bx, by, _ = _moments(blob)
    fx, fy = img.point_to_full((bx, by))
    ecx, ecy = eye["irisEllipse"][:2]
    assert math.hypot(fx - ecx, fy - ecy) < 0.6
    # Upright intrinsics put the 3D eye centre where the truth puts it in pixels.
    u, v = decoded.intrinsics.project(tuple(cap.truth["leftEyeCenter"]))
    assert (u, v) == pytest.approx(eye["eyeballCenter"], abs=1e-6)
    # The wide image shows a face upright: eyes above the mouth means the eyes row is in the
    # upper half of the decoded wide image.
    wy = decoded.images["wide"].point_from_full(tuple(eye["irisCenter"]))[1]
    assert wy < decoded.images["wide"].pixels.shape[0] * 0.75


@pytest.mark.slow
def test_mediapipe_finds_the_synthetic_face():
    mp = pytest.importorskip("mediapipe")
    import cv2
    from mediapipe.tasks.python import BaseOptions, vision

    from phonegaze.download import model_path

    path = model_path("face_landmarker.task")
    if not path.exists():
        pytest.skip("face landmark model not downloaded (python -m phonegaze.download)")
    sc = SimScene(1, orientation=0)
    sc.knobs.blink_rate_per_min = 0
    sc.step(0.05)
    img, _ = sc.render(width=640)
    truth = sc.capture().truth
    opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(path)), num_faces=1)
    lm = vision.FaceLandmarker.create_from_options(opts)
    try:
        res = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)))
    finally:
        lm.close()
    assert len(res.face_landmarks) == 1
    pts = res.face_landmarks[0]
    scale = 640 / sc.width
    for side, idx in (("left", 473), ("right", 468)):
        gx, gy = np.asarray(truth["eyes"][side]["irisCenter"]) * scale
        assert math.hypot(pts[idx].x * 640 - gx, pts[idx].y * img.shape[0] - gy) < 3.0
