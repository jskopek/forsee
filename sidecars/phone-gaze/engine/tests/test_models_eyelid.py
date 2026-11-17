"""models.eyelid_feature: the lid opening as an extra feature for ridge (and kernel, reflection).
Owner: Models."""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from phonegaze.config import Config
from phonegaze.models import build_models
from phonegaze.models import features as F
from phonegaze.types import Intrinsics, Observation


def _obs(iris_y: float, openness: float | None) -> Observation:
    o = Observation(seq=0, t=0.0, intrinsics=Intrinsics(fx=1000.0, fy=1000.0, cx=320.0, cy=180.0, width=640, height=360), distance=0.6)
    for side, x in (("left", 300.0), ("right", 340.0)):
        e = o.eye(side)
        e.inner_corner, e.outer_corner = (x - 10, 180.0), (x + 10, 180.0)
        e.iris_center = (x, iris_y)
        e.openness = openness
    return o


def test_off_by_default_and_passed_to_the_feature_models() -> None:
    cfg = Config().models
    assert cfg.eyelid_feature is False
    on = replace(cfg, eyelid_feature=True, candidates=["ridge", "kernel", "reflection", "geometric"])
    opts = {m.name: m.options for m in build_models(on)}
    assert opts["ridge"].get("lid") and opts["kernel"].get("lid") and opts["reflection"].get("lid")
    assert "lid" not in opts["geometric"]


def test_lid_group_is_extra_not_an_eye() -> None:
    assert F.eye_group(_obs(180.0, 0.3), "left", "lid") == (0.3, 0.0)
    t = F.FeatureTable(["iris", "lid"], head=False)
    z = t.fit([_obs(180.0 + k, 0.3 + 0.01 * k) for k in range(5)])
    assert z.shape == (5, 8) and np.all(np.isfinite(z))
    # a frame with the lid but no iris is no eye data
    o = _obs(180.0, 0.3)
    o.left.iris_center = o.right.iris_center = None
    assert t.raw(o) is None


def test_ridge_uses_the_lid_when_switched_on() -> None:
    from phonegaze.types import CalibSample

    rng = np.random.default_rng(0)
    samples = []
    for dot, (x, y) in enumerate([(100, 100), (700, 100), (100, 500), (700, 500), (400, 300), (400, 100), (400, 500), (100, 300), (700, 300)]):
        for _ in range(6):
            # the iris barely moves up and down (lid covers it); the lid opening follows y
            o = _obs(180.0 + 0.002 * y + rng.normal(0, 0.3), 0.2 + 0.0004 * y + rng.normal(0, 0.002))
            for side in ("left", "right"):
                c = o.eye(side).iris_center
                o.eye(side).iris_center = (c[0] + 0.02 * x, c[1])
            samples.append(CalibSample(target=(float(x), float(y)), obs=o, kind="grid", dot_id=dot))
    from phonegaze.types import ScreenInfo

    screen = ScreenInfo(width=800, height=600, width_mm=300.0, height_mm=225.0)
    cfg = Config().models
    errs = {}
    for lid in (False, True):
        from phonegaze.calibration import fit_all

        res = fit_all(samples, screen, build_models(replace(cfg, candidates=["ridge"], eyelid_feature=lid)))
        assert ("lid" in res.models["ridge"].table.groups) == lid
        errs[lid] = res.reports[0].loo_error_deg
    assert errs[True] < errs[False]
