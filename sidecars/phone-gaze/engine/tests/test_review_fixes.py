"""Regression tests for the fixes made after the adversarial review (camera intrinsics, profile
per camera and screen, holding output when ARKit loses the face or the zoom is changing,
moving-dot runs that do not replace the calibration, model choice across head positions, the
blend's outlier rule, dot stability under head sway, the unreachable-phone hint)."""

from __future__ import annotations

import errno
import json
from pathlib import Path

import pytest
from core_fakes import FakeEstimator, FakeModel, FakePhone, patch_calibration, wait_for
from models_sim import HOME, Sim, grid

from phonegaze.calibration import CalibrationRun, choose
from phonegaze.config import Config
from phonegaze.models.blend import BlendModel
from phonegaze.phone import _unreachable_hint
from phonegaze.pipeline import Engine, _PassFilter
from phonegaze.types import CameraInfo, FitReport, GazePoint, Intrinsics, ScreenInfo

SCREEN = ScreenInfo(width=1512, height=982, width_mm=302.0, height_mm=196.0, scale=2.0, source="sim")

# --- intrinsics sent without the zoom ------------------------------------------------------------


def _header(fx: float, zoom: float = 2.0, fov: float | None = 68.0) -> dict:
    h = {"id": "cam", "position": "back", "type": "wide", "width": 3840, "height": 2160, "zoom": zoom, "fx": fx, "fy": fx, "cx": 1920.0, "cy": 1080.0}
    h.update({"intrinsicsSource": "attachment", "intrinsicsIncludeZoom": False})
    if fov is not None:
        h["fieldOfView"] = fov
    return h


def test_attachment_intrinsics_are_read_either_way() -> None:
    f1 = Intrinsics.from_fov(3840, 2160, 68.0, 1.0).fx
    want = 2 * f1
    unzoomed = CameraInfo.from_header(_header(f1 * 1.02))  # describes the unzoomed sensor
    zoomed = CameraInfo.from_header(_header(2 * f1 * 1.02))  # already includes the zoom
    assert unzoomed.intrinsics.fx == pytest.approx(want * 1.02) and unzoomed.intrinsics_source == "attachment"
    assert zoomed.intrinsics.fx == pytest.approx(want * 1.02) and zoomed.intrinsics_source == "attachment"
    nonsense = CameraInfo.from_header(_header(5 * f1))
    assert nonsense.intrinsics.fx == pytest.approx(want) and nonsense.intrinsics_source == "fov"
    no_fov = CameraInfo.from_header(_header(f1, fov=None))  # nothing to compare: the protocol's reading
    assert no_fov.intrinsics.fx == pytest.approx(2 * f1)


# --- engine: profile per camera and screen, holding output, moving-dot runs ---------------------


def make_engine(tmp_path: Path, profile: bool = True) -> Engine:
    cfg = Config()
    cfg.recording.directory = str(tmp_path / "recordings")
    cfg.lens.auto_zoom = False
    cfg.lens.aim_on_start = False
    return Engine(
        cfg,
        config_path=tmp_path / "config.json",
        estimators=[FakeEstimator()],
        filter=_PassFilter(),
        sinks=[],
        model_factory=lambda: [FakeModel("good"), FakeModel("worse", offset=(5.0, 0.0))],
        screen=SCREEN,
        hotkeys=False,
        profile_dir=tmp_path / "profiles" / "default" if profile else None,
    )


async def _calibrate(engine: Engine, kind: str = "grid", commit: bool = True) -> dict:
    plan = engine.start_calibration(kind)
    for t in plan["targets"]:
        msg = {"run_id": plan["run_id"], "dot_id": t["dot_id"], "x": t["x"], "y": t["y"]}
        engine.calib_dot({**msg, "state": "collect"})
        n = engine.processed
        await wait_for(lambda: engine.processed >= n + 3)
        engine.calib_dot({**msg, "state": "done"})
    return await engine.finish_calibration(plan["run_id"], commit=commit)


@pytest.fixture
async def phone():
    p = FakePhone(fps=60)
    await p.start()
    yield p
    await p.stop()


async def test_calibration_belongs_to_its_camera(tmp_path, phone, monkeypatch) -> None:
    patch_calibration(monkeypatch)
    engine = make_engine(tmp_path)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        await _calibrate(engine)
        assert engine.chosen == "good" and engine.models_setup["camera"]["id"] == "back-wide"
        setup = json.loads((tmp_path / "profiles" / "default" / "back-wide" / "setup.json").read_text())
        assert setup["camera"]["id"] == "back-wide" and setup["screen"]["width"] == 1512

        # Another camera: the calibration is put away and nothing predicts.
        await engine.set_camera("back-ultra")
        await wait_for(lambda: engine.last_frame is not None and engine.last_frame.camera.id == "back-ultra")
        await wait_for(lambda: not engine.models)
        assert engine.chosen is None and engine.active_model() is None
    finally:
        await engine.stop()


async def test_moving_dot_run_can_be_fitted_without_replacing_the_calibration(tmp_path, phone, monkeypatch) -> None:
    patch_calibration(monkeypatch)
    engine = make_engine(tmp_path, profile=False)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        await _calibrate(engine)
        models = dict(engine.models)
        answer = await _calibrate(engine, "grid", commit=False)
        assert answer["committed"] is False and answer["reports"]
        assert engine.models == models  # the very same objects: nothing replaced
    finally:
        await engine.stop()


def test_off_screen_gaze_is_not_valid(tmp_path) -> None:
    engine = make_engine(tmp_path, profile=False)
    inside = GazePoint(x=1600.0, y=-50.0, t=0.0, confidence=1.0)
    outside = GazePoint(x=1060.0, y=-600.0, t=0.0, confidence=1.0)
    assert engine._off_screen_invalid(inside).valid
    assert not engine._off_screen_invalid(outside).valid


async def test_no_output_while_arkit_has_no_face(tmp_path, monkeypatch) -> None:
    patch_calibration(monkeypatch)
    phone = FakePhone(fps=60)
    await phone.start()
    engine = make_engine(tmp_path, profile=False)
    await engine.start()
    try:
        await engine.connect(phone.url)
        await wait_for(lambda: engine.processed >= 3)
        await engine.set_camera("arkit-face")
        await wait_for(lambda: engine.last_frame.camera.type == "arkit")
        engine.models = {"good": FakeModel("good")}
        engine.chosen = "good"
        await wait_for(lambda: engine.last_raw is not None)
        phone.arkit_tracked = False
        await wait_for(lambda: engine.last_raw is None)
    finally:
        await engine.stop()
        await phone.stop()


# --- models: choosing, blend outliers, dot stability ----------------------------------------------


def _rep(name: str, loo: float, lopo: float | None = None) -> FitReport:
    params = {"loo_coverage": 1.0}
    if lopo is not None:
        params["selection_error_deg"] = max(loo, lopo)
    return FitReport(model=name, ok=True, loo_error_deg=loo, params=params)


def test_choose_prefers_what_generalises_to_a_new_head_position() -> None:
    # Several head positions: leave-one-pose-out decides.
    reps = [_rep("kernel", 0.25, 2.5), _rep("geometric", 0.6, 1.0), _rep("reflection", 0.5, 0.9)]
    assert choose(reps, multi_pose=True) == "reflection"
    # One head position: a regression model needs a clear margin over the physical models.
    assert choose([_rep("kernel", 0.3), _rep("reflection", 0.5)]) == "reflection"
    assert choose([_rep("kernel", 0.2), _rep("reflection", 0.5)]) == "kernel"
    blend = _rep("blend", 0.4)
    blend.params["regression_share"] = 0.6  # mostly ridge and kernel: same rule
    assert choose([blend, _rep("reflection", 0.5)]) == "reflection"


def test_blend_drops_correlated_regression_members_not_the_correct_ones() -> None:
    b = BlendModel()
    b.screen_size = (1512.0, 982.0)
    b.weights = {"ridge": 0.3, "kernel": 0.3, "geometric": 0.2, "reflection": 0.2}
    p = {
        "ridge": GazePoint(x=1200, y=200, t=0, confidence=1),
        "kernel": GazePoint(x=1210, y=210, t=0, confidence=1),
        "geometric": GazePoint(x=700, y=500, t=0, confidence=1),
        "reflection": GazePoint(x=720, y=480, t=0, confidence=1),
    }
    assert set(b._drop_outliers(p)) == {"geometric", "reflection"}


def test_head_sway_during_a_dot_does_not_reject_it() -> None:
    sim = Sim(seed=3)
    targets = grid(sim)
    run = CalibrationRun(run_id="x", kind="grid", targets=targets, screen=sim.screen)
    for t in targets:
        run.begin_dot(t.dot_id, t.x, t.y, sim.t)
        for i in range(27):
            obs, _ = sim.observe(t.x, t.y, HOME.moved(dx=0.006 * i / 26))  # 6 mm drift in 0.9 s
            run.add(obs)
        run.end_dot(t.dot_id, sim.t)
    assert not run.rejected, run.rejected


# --- phone errors ----------------------------------------------------------------------------------


def test_no_route_to_host_names_the_local_network_permission() -> None:
    exc = OSError(errno.EHOSTUNREACH, "No route to host")
    assert "Local Network" in _unreachable_hint(exc)
    assert _unreachable_hint(OSError(errno.ECONNREFUSED, "refused")) == ""
