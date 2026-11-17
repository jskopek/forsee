"""Shared types: geometry of upright decoding, serialisation. Owner: Foundation."""

from __future__ import annotations

import numpy as np
import pytest

from phonegaze.pipeline import run_estimators
from phonegaze.types import (
    CalibSample,
    CameraInfo,
    DecodedFrame,
    EyeObs,
    FitReport,
    Frame,
    GazePoint,
    Intrinsics,
    LensState,
    Observation,
    Part,
    ScreenInfo,
    apply_affine,
    rotation_3d,
    upright_rotation,
)

SW, SH = 40, 20  # sensor size


def make_frame(spot: tuple[int, int], gravity=(0.0, -1.0, 0.0), position="back") -> Frame:
    """A sensor frame with one bright pixel at integer pixel index ``spot`` (column, row)."""
    sensor = np.zeros((SH, SW), np.uint8)
    sensor[spot[1], spot[0]] = 255
    wide = sensor[::2, ::2].copy()  # 20 x 10, scale 0.5 (keeps even pixels only)
    rx, ry, rw, rh = 24, 4, 8, 6
    roi = sensor[ry : ry + rh, rx : rx + rw].copy()
    cam = CameraInfo(
        id="t",
        position=position,
        type="wide",
        zoom=1.0,
        width=SW,
        height=SH,
        intrinsics=Intrinsics(30.0, 31.0, 19.0, 11.0, SW, SH),
    )
    return Frame(
        seq=1,
        t=0.0,
        mode="camera",
        camera=cam,
        lens=LensState(),
        gravity=gravity,
        rotation_rate=None,
        parts=[
            Part("wide", "wide", "gray8", 20, 10, (0, 0, SW, SH), wide.tobytes()),
            Part("left_eye", "roi", "gray8", rw, rh, (rx, ry, rw, rh), roi.tobytes()),
        ],
    )


def brightest(img: np.ndarray) -> tuple[float, float]:
    gray = img if img.ndim == 2 else img[..., 0]
    r, c = np.unravel_index(int(np.argmax(gray)), gray.shape)
    return (c + 0.5, r + 0.5)  # continuous convention: pixel centre


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_roi_and_wide_map_to_the_same_upright_point(rotation: int) -> None:
    spot = (26, 6)  # inside the ROI and on an even pixel (kept by the wide downscale)
    df = DecodedFrame.from_frame(make_frame(spot), rotation=rotation)  # type: ignore[arg-type]
    expected = apply_affine(df.sensor_to_upright, (spot[0] + 0.5, spot[1] + 0.5))
    roi = df.images["left_eye"]
    assert roi.point_to_full(brightest(roi.pixels)) == pytest.approx(expected)
    assert roi.scale == pytest.approx(1.0)
    # The wide image is 2x downscaled: its pixel (13, 3) covers sensor [26, 28) x [6, 8),
    # so its centre maps to the sensor point (27, 7).
    wide = df.images["wide"]
    centre = wide.point_to_full(brightest(wide.pixels))
    assert centre == pytest.approx(apply_affine(df.sensor_to_upright, (27.0, 7.0)))
    assert wide.scale == pytest.approx(0.5)
    # Upright sizes.
    if rotation in (90, 270):
        assert (df.width, df.height) == (SH, SW)
        assert roi.pixels.shape[:2] == (8, 6)
    else:
        assert (df.width, df.height) == (SW, SH)
    # rect_full contains the spot, and point_from_full inverts point_to_full.
    x, y, w, h = roi.rect_full
    assert x <= expected[0] <= x + w and y <= expected[1] <= y + h
    assert roi.point_from_full(roi.point_to_full((1.0, 2.0))) == pytest.approx((1.0, 2.0))


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_intrinsics_and_3d_rotation_agree(rotation: int) -> None:
    df = DecodedFrame.from_frame(make_frame((0, 0)), rotation=rotation)  # type: ignore[arg-type]
    sensor_intr = df.frame.camera.intrinsics
    assert sensor_intr is not None and df.intrinsics is not None
    for p in [(0.1, -0.05, 0.6), (-0.2, 0.1, 0.5), (0.0, 0.0, 1.0)]:
        sensor_px = sensor_intr.project(p)
        upright_px = df.intrinsics.project(tuple(df.sensor_to_upright_3d @ np.array(p)))
        assert upright_px == pytest.approx(apply_affine(df.sensor_to_upright, sensor_px))
    assert np.allclose(rotation_3d(rotation) @ rotation_3d(rotation).T, np.eye(3))  # type: ignore[arg-type]


def test_rect_to_sensor_normalized_round_trip() -> None:
    df = DecodedFrame.from_frame(make_frame((0, 0)), rotation=90)
    roi = df.images["left_eye"]
    x, y, w, h = df.rect_to_sensor_normalized(roi.rect_full)
    assert (x * SW, y * SH, w * SW, h * SH) == pytest.approx((24, 4, 8, 6))


def test_upright_rotation_from_gravity() -> None:
    # Back camera, phone landscape with its top to the left: the buffer is already upright.
    assert upright_rotation((-1.0, 0.0, 0.0), "back") == 0
    # Portrait, top up.
    assert upright_rotation((0.0, -1.0, 0.0), "back") == 90
    # Portrait, upside down.
    assert upright_rotation((0.0, 1.0, 0.0), "back") == 270
    assert upright_rotation((1.0, 0.0, 0.0), "back") == 180
    # Front camera, portrait.
    assert upright_rotation((0.0, -1.0, 0.0), "front") == 270
    assert upright_rotation(None, "back") == 0


def test_camera_info_zoom_scaling() -> None:
    raw = {"width": 100, "height": 50, "zoom": 2.0, "fx": 80, "fy": 80, "cx": 52, "cy": 25}
    cam = CameraInfo.from_header(raw)
    assert cam.intrinsics is not None
    assert cam.intrinsics.fx == 160 and cam.intrinsics.cx == pytest.approx(54)
    cam2 = CameraInfo.from_header({**raw, "intrinsicsIncludeZoom": True})
    assert cam2.intrinsics is not None and cam2.intrinsics.fx == 80
    cam3 = CameraInfo.from_header({"width": 100, "height": 50, "fieldOfView": 90.0})
    assert cam3.intrinsics is not None and cam3.intrinsics.fx == pytest.approx(50)
    assert cam3.intrinsics_source == "fov"
    assert CameraInfo.from_dict(cam.to_dict()) == cam


def test_ray_pixel_inverse() -> None:
    k = Intrinsics(1000, 1010, 960, 540, 1920, 1080)
    assert k.pixel(*k.ray(100.0, 200.0)) == pytest.approx((100.0, 200.0))


def sample_observation() -> Observation:
    obs = Observation(seq=3, t=1.25, t_local=9.0, intrinsics=Intrinsics(1, 2, 3, 4, 5, 6))
    obs.set("left.iris_center", (10.5, 20.25), "landmarks")
    obs.set("left.found", True, "landmarks")
    obs.left.reflection_corners = [(1.0, 2.0), (3.0, 4.0), (5.0, 6.0), (7.0, 8.0)]
    obs.set("right.gaze_dir", (0.0, 0.0, -1.0), "arkit")
    obs.set("distance", 0.6, "arkit")
    obs.head_rotation = np.eye(3).tolist()
    obs.quality["sharpness"] = float("nan")  # NaN is written as null
    obs.extra["arkit"] = {"look_at": np.array([0.0, 0.1, 1.0])}
    return obs


def test_observation_round_trip() -> None:
    obs = sample_observation()
    d = obs.to_dict()
    assert d["quality"]["sharpness"] is None
    assert d["provenance"] == {
        "left.iris_center": "landmarks",
        "left.found": "landmarks",
        "right.gaze_dir": "arkit",
        "distance": "arkit",
    }
    back = Observation.from_dict(d)
    assert back.left.iris_center == (10.5, 20.25)
    assert back.left.reflection_corners == [(1.0, 2.0), (3.0, 4.0), (5.0, 6.0), (7.0, 8.0)]
    assert back.right.gaze_dir == (0.0, 0.0, -1.0)
    assert back.intrinsics == obs.intrinsics
    assert back.to_dict() == d
    # Unknown keys from a newer version are ignored.
    assert Observation.from_dict({**d, "future": 1}).seq == 3
    assert EyeObs.from_dict(None) == EyeObs()
    with pytest.raises(AttributeError):
        obs.set("left.nope", 1, "x")


def test_other_round_trips() -> None:
    g = GazePoint(1.0, 2.0, 3.0, confidence=0.5, valid=False, model="ridge", left=(1.0, 1.0))
    assert GazePoint.from_dict(g.to_dict()) == g
    s = ScreenInfo(1512, 982, 344.0, 223.0, 2.0, "Built-in")
    assert ScreenInfo.from_dict(s.to_dict()) == s
    assert s.to_mm(1512, 982) == pytest.approx((344.0, 223.0))
    f = FitReport("geometric", True, n_samples=10, loo_error_deg=1.5, per_dot=[{"dot_id": 1}])
    assert FitReport.from_dict(f.to_dict()) == f
    c = CalibSample((100.0, 200.0), sample_observation(), kind="validate", dot_id=4, run_id="r")
    c2 = CalibSample.from_dict(c.to_dict())
    assert c2.target == (100.0, 200.0) and c2.kind == "validate" and c2.obs.seq == 3


class _Adds:
    def __init__(self, name: str, path: str, value, ret_none: bool = False, boom: bool = False):
        self.name, self.path, self.value, self.ret_none, self.boom = name, path, value, ret_none, boom

    def process(self, frame, previous):
        if self.boom:
            raise RuntimeError("boom")
        if self.ret_none:
            return None
        previous.set(self.path, self.value, self.name)
        return previous

    def reset(self) -> None:
        pass


def test_estimator_chain_semantics() -> None:
    df = DecodedFrame.from_frame(make_frame((0, 0)), rotation=0)
    chain = [
        _Adds("a", "left.iris_center", (1.0, 1.0)),
        _Adds("b", "distance", 0.5, ret_none=True),
        _Adds("c", "distance", 0.7, boom=True),
        _Adds("d", "left.iris_center", (2.0, 2.0)),
    ]
    obs = run_estimators(chain, df)  # type: ignore[arg-type]
    assert obs.estimators == ["a", "d"]
    assert obs.left.iris_center == (2.0, 2.0)
    assert obs.provenance["left.iris_center"] == "d"
    assert obs.distance is None
    assert obs.seq == 1 and obs.intrinsics == df.intrinsics
