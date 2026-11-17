"""estimators.distance_smoothing_s: the noisy per-frame distance is smoothed over time and the
eyeball centres and head position move with it. Owner: Vision."""

from __future__ import annotations

import numpy as np

from phonegaze.config import Config
from phonegaze.types import Intrinsics, Observation
from phonegaze.vision.distance import DistanceSmoother


def _obs(t: float, d: float) -> Observation:
    o = Observation(seq=0, t=t, intrinsics=Intrinsics(fx=1000.0, fy=1000.0, cx=320.0, cy=180.0, width=640, height=360))
    o.set("distance", d, "landmarks")
    o.set("left.eyeball_center", (0.03, 0.0, d), "landmarks")
    o.set("right.eyeball_center", (-0.03, 0.0, d), "landmarks")
    o.set("head_position", (0.0, 0.0, d), "landmarks")
    o.set("left.iris_center", (330.0, 180.0), "landmarks")
    return o


def test_off_by_default_and_smooths_when_on() -> None:
    cfg = Config().estimators
    sm = DistanceSmoother()
    o = _obs(0.0, 0.6)
    sm.apply(o, 0.0, cfg)
    assert o.distance == 0.6 and o.provenance["distance"] == "landmarks"  # off: untouched

    cfg.distance_smoothing_s = 5.0
    rng = np.random.default_rng(0)
    raw, out, heads = [], [], []
    for i in range(300):  # 10 s at 30 fps, 6 cm of frame-to-frame noise around 60 cm
        t = i / 30.0
        d = 0.6 + float(rng.normal(0, 0.06))
        o = _obs(t, d)
        sm.apply(o, t, cfg)
        raw.append(d)
        out.append(o.distance)
        heads.append(o.head_position[2])
        # the points are scaled about the camera with the distance
        assert np.isclose(o.left.eyeball_center[2], o.distance) and np.isclose(o.left.eyeball_center[0], 0.03 * o.distance / d)
        if o.distance != d:
            assert o.left.gaze_dir is not None  # recomputed from the moved eyeball centre
    assert np.std(out[60:]) < 0.25 * np.std(raw[60:])
    assert abs(np.mean(out[60:]) - 0.6) < 0.02 and np.allclose(heads, out)


def test_a_gap_and_arkit_start_afresh_or_are_left_alone() -> None:
    cfg = Config().estimators
    cfg.distance_smoothing_s = 5.0
    sm = DistanceSmoother()
    sm.apply(_obs(0.0, 0.6), 0.0, cfg)
    o = _obs(5.0, 0.9)  # 5 s later: a gap, not smoothed towards 0.6
    sm.apply(o, 5.0, cfg)
    assert o.distance == 0.9
    a = _obs(5.1, 0.5)
    a.set("distance", 0.5, "arkit")
    sm.apply(a, 5.1, cfg)
    assert a.distance == 0.5
