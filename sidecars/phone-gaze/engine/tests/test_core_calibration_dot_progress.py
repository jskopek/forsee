"""The page keeps a dot up longer on a slow computer: CalibrationRun.dot_progress and
GET /api/calibration/dot report the usable samples of the dot on screen. Owner: Core."""

from __future__ import annotations

from phonegaze.calibration import CalibrationRun
from phonegaze.types import Observation, ScreenInfo


def _obs(t: float, usable: bool) -> Observation:
    o = Observation(seq=0, t=t, t_local=t)
    if usable:
        o.left.iris_center = (100.0, 100.0)
    return o


def test_dot_progress_counts_usable_samples_after_the_discard() -> None:
    run = CalibrationRun(run_id="r", kind="grid", targets=[], screen=ScreenInfo(width=800, height=600))
    assert run.dot_progress() == {"dot_id": None, "collected": 0, "needed": 4}
    run.begin_dot(3, 10.0, 20.0, t_local=100.0)
    run.add(_obs(100.05, True))  # inside the discard time: not counted
    for k in range(5):
        run.add(_obs(100.2 + 0.1 * k, k != 2))  # one frame without an eye
    p = run.dot_progress()
    assert p["dot_id"] == 3 and p["collected"] == 4 and p["needed"] == 4
    run.end_dot(3, 101.0)
    assert run.dot_progress()["dot_id"] is None
