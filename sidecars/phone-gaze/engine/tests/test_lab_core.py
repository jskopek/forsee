"""The offline lab and tuner on synthetic sessions (no real footage exists here). Owner: Lab.

Fast tests: sessions with uniform grey frames whose simulator ground truth is read by the
``sim_oracle`` estimator, so scoring, caching, decoding and error handling are tested without
vision. ``test_lab_render.py`` (slow) runs the real estimators on rendered video.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from lab_synth import make_recording, make_session  # noqa: E402

from phonegaze import lab as L  # noqa: E402
from phonegaze import tune as T  # noqa: E402
from phonegaze.config import Config  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is needed to write the synthetic .mov")


@pytest.fixture(scope="module")
def session(tmp_path_factory) -> Path:
    return make_session(tmp_path_factory.mktemp("lab") / "synthetic-session", render=False, grid="3x3")


@pytest.fixture(scope="module")
def labroot(tmp_path_factory) -> Path:
    """One lab output folder for the module, so tests share the frame and observation caches."""
    return tmp_path_factory.mktemp("labout")


@pytest.fixture()
def cfg(labroot: Path) -> Config:
    c = Config()
    c.lab.output_dir = str(labroot)
    c.lab.every = 1
    c.lab.combos = ["sim_oracle"]
    c.lab.rotation = "auto"  # rotation detection runs face landmarks 16 times; tested separately
    c.models.candidates = ["geometric", "ridge", "kernel"]
    return c


def copy_session(session: Path, tmp_path: Path) -> Path:
    dst = tmp_path / session.name
    shutil.copytree(session, dst)
    return dst


def test_open_eye_capture_session(session: Path) -> None:
    src = L.open_source(session)
    assert src.kind == "eye-capture"
    assert src.screen.width_mm and src.screen.width == pytest.approx(1512.0)
    (seg,) = src.segments
    assert seg.name == "back-wide-2x" and seg.camera_type == "wide"
    assert len(seg.dots) == 9 and seg.video is not None and seg.video.suffix == ".mov"
    assert seg.pursuit is not None and len(seg.pursuit) > 10
    assert seg.gravity is not None and seg.gravity.shape == (seg.n_rows, 3)
    assert seg.distance_hint_m == pytest.approx(0.6)
    # Pursuit samples are on the phone clock (page clock + offset) and inside the video.
    assert seg.times[0] <= seg.pursuit[0, 0] <= seg.times[-1]


def test_wanted_rows_settle_every_and_lag(session: Path, cfg: Config) -> None:
    seg = L.open_source(session).segments[0]
    want = L.wanted_rows(seg, cfg)
    grid_rows = [r for r, w in want.items() if w.kind == "grid"]
    for r in grid_rows:
        d = next(d for d in seg.dots if d.dot_id == want[r].dot_id)
        assert seg.times[r] >= d.t0 + cfg.lab.settle_s
    pursuit = [r for r, w in want.items() if w.kind == "pursuit"]
    assert pursuit and seg.times[pursuit[0]] >= seg.pursuit[0, 0] + cfg.lab.pursuit_skip_s
    cfg.lab.every = 2
    assert all(r % 2 == 0 for r in L.wanted_rows(seg, cfg))


@pytest.mark.slow
def test_lab_scores_oracle_and_writes_reports(session: Path, cfg: Config) -> None:
    src = L.open_source(session)
    cfg.lab.rotation = "detect"  # grey frames: no face at any rotation, so gravity decides
    res = L.run_lab(src, cfg)
    cam = res["cameras"]["back-wide-2x"]
    r = cam["combos"]["sim_oracle"]
    assert r["chosen"] in r["models"]
    best = r["models"][r["chosen"]]
    assert best["loo_deg"] < 0.5, best
    assert best["pursuit_deg"] < 1.0
    assert len(best["per_dot"]) == 9
    assert r["failures"]["frames"] > 30 and r["failures"]["face_not_found"] == 0
    rot = cam["frames"]["rotation"]
    assert rot["rotation"] == 180 and "fallback" in rot  # the simulator's sensor is upside down
    paths = L.write_reports(res, Path(res["output_dir"]))
    html = paths["html"].read_text()
    assert "<svg" in html and "Held-out dot error" in html
    assert "| geometric" in paths["md"].read_text()
    json.loads(paths["json"].read_text())
    # Second run: everything from the observation cache, same numbers.
    res2 = L.run_lab(src, cfg)
    r2 = res2["cameras"]["back-wide-2x"]["combos"]["sim_oracle"]
    assert r2["stats"]["cached"] is True
    assert r2["models"][r2["chosen"]]["loo_deg"] == pytest.approx(best["loo_deg"])


def test_frame_cache_survives_missing_video_and_new_estimator_settings(session: Path, cfg: Config, tmp_path: Path) -> None:
    s = copy_session(session, tmp_path)
    src = L.open_source(s)
    L.run_lab(src, cfg)
    cache = Path(L.session_dir(cfg, src)) / "cache"
    assert list(cache.glob("*.frames.pgz1")) and list(cache.glob("*.frames.done.json"))
    (s / "back-wide-2x.mov").unlink()
    src = L.open_source(s)
    assert any("no video" in n for n in src.segments[0].notes)
    cfg2 = L.apply_changes(cfg, {"stream.roi_width_mm": 25.0})  # new observations, same frames
    res = L.run_lab(src, cfg2)
    r = res["cameras"]["back-wide-2x"]["combos"]["sim_oracle"]
    assert r["stats"]["cached"] is False and r["models"][r["chosen"]]["loo_deg"] < 0.5
    # A frame-cache change with no video is a clear message, not a traceback.
    cfg3 = L.apply_changes(cfg, {"stream.wide_width": 480})
    res = L.run_lab(src, cfg3)
    assert any("video is missing" in n for n in res["cameras"]["back-wide-2x"]["notes"])


def test_recut_changes_crop_size() -> None:
    img = (np.random.default_rng(0).random((400, 400, 3)) * 255).astype(np.uint8)
    header = {"type": "frame", "seq": 0, "t": 1.0, "camera": {"id": "x", "position": "back", "type": "wide", "zoom": 1.0, "width": 2000, "height": 1000, "fx": 1500, "fy": 1500, "cx": 1000, "cy": 500, "intrinsicsIncludeZoom": True}, "lab": {"row": 0, "rotation": 0, "px_per_mm": 8.0}}
    frame = L._frame(header, [L._part("left_eye", "roi", img, (800, 300, 400, 400), 0.95)])
    c = Config()
    c.stream.roi_width_mm = 25.0
    c.stream.roi_aspect = 0.5
    out = L.recut(frame, c, 0).part("left_eye")
    assert out is not None and out.rect[2] == pytest.approx(200, abs=2) and out.rect[3] == pytest.approx(100, abs=2)
    assert out.rect[0] + out.rect[2] / 2 == pytest.approx(1000, abs=2)
    rot = L.recut(frame, c, 90).part("left_eye")  # upright width runs along sensor y
    assert rot.rect[2] == pytest.approx(100, abs=2) and rot.rect[3] == pytest.approx(200, abs=2)


def test_ffmpeg_fallback_and_short_video(session: Path, tmp_path: Path, monkeypatch) -> None:
    import cv2

    seg = L.open_source(session).segments[0]
    rows = [0, 5, 7, seg.n_rows - 1]
    notes: list[str] = []
    a = [(r, im.shape) for r, im in L._video_rows(seg.video, rows, notes)]

    class Closed:
        def __init__(self, *_a) -> None:
            pass

        def isOpened(self) -> bool:  # noqa: N802
            return False

        def release(self) -> None:
            pass

    monkeypatch.setattr(cv2, "VideoCapture", Closed)
    b = [(r, im.shape) for r, im in L._video_rows(seg.video, rows, notes)]
    assert a == b and [r for r, _ in a] == rows and not notes
    list(L._video_rows(seg.video, [seg.n_rows + 5], notes))
    assert notes and "ended" in notes[-1]


def test_bad_inputs_are_plain_messages(session: Path, tmp_path: Path, capsys) -> None:
    with pytest.raises(L.LabError, match="does not exist"):
        L.open_source(tmp_path / "nope")
    parent = tmp_path / "many"
    (parent / "a").mkdir(parents=True)
    (parent / "a" / "meta.json").write_text("{}")
    (parent / "b").mkdir()
    (parent / "b" / "meta.json").write_text("{}")
    with pytest.raises(L.LabError, match="several sessions"):
        L.open_source(parent)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(L.LabError, match="not a session"):
        L.open_source(empty)
    s = copy_session(session, tmp_path)
    (s / "meta.json").write_text("{not json")
    with pytest.raises(L.LabError, match="cannot read meta.json"):
        L.open_source(s)
    s2 = copy_session(session, tmp_path / "x")
    (s2 / "back-wide-2x.frames.csv").unlink()
    (s2 / "events.jsonl").write_text('{"type": "segment_start"}\nnot json\n')
    src = L.open_source(s2)
    assert not src.segments and any("frames.csv is missing" in n for n in src.notes)
    assert any("unreadable line" in n for n in src.notes)
    with pytest.raises(L.LabError, match="unknown setting"):
        L.apply_changes(Config(), {"lab.nope": 1})
    with pytest.raises(L.LabError, match="not a valid|below|above|not in"):
        L.apply_changes(Config(), {"lab.every": 0})
    assert L.main([str(tmp_path / "nope")]) == 2
    err = capsys.readouterr().err
    assert "does not exist" in err and "Traceback" not in err


def test_no_dots_and_too_few_dots(session: Path, cfg: Config, tmp_path: Path) -> None:
    s = copy_session(session, tmp_path)
    lines = [json.loads(x) for x in (s / "events.jsonl").read_text().splitlines()]
    keep = [e for e in lines if e["type"] not in ("target_on", "target_off") or e.get("order", 0) < 3]
    (s / "events.jsonl").write_text("\n".join(json.dumps(e) for e in keep) + "\n")
    res = L.run_lab(L.open_source(s), cfg)
    r = res["cameras"]["back-wide-2x"]["combos"]["sim_oracle"]
    assert "need at least 4" in r["message"]
    L.write_reports(res, tmp_path / "rep")  # still writes
    (s / "events.jsonl").write_text("")
    src = L.open_source(s)
    assert any("no dots" in n for n in src.segments[0].notes)


def test_eye_choice_blanks_the_other_eye(session: Path, cfg: Config) -> None:
    src = L.open_source(session)
    seg = src.segments[0]
    cols, _ = L.collect(src, seg, cfg, ["sim_oracle"])
    cfg.lab.eye = "left"
    prep = L.prepared_samples(cols[0], seg, cfg)
    assert prep["grid"] and all(not s.obs.right.found and s.obs.left.found for s in prep["grid"])


def test_recording_source(tmp_path: Path, cfg: Config) -> None:
    rec = make_recording(tmp_path / "rec1")
    src = L.open_source(rec)
    assert src.kind == "recording" and len(src.segments) == 1
    seg = src.segments[0]
    assert sum(d.kind == "grid" for d in seg.dots) == 9 and sum(d.kind == "validate" for d in seg.dots) == 3
    res = L.run_lab(src, cfg)
    r = next(iter(res["cameras"].values()))["combos"]["sim_oracle"]
    best = r["models"][r["chosen"]]
    assert best["loo_deg"] < 0.5 and best["validate_deg"] < 1.0


# --------------------------------------------------------------------------------------------
# Tune and A/B
# --------------------------------------------------------------------------------------------


def test_make_trials() -> None:
    trials = T.make_trials(["models.ridge_alpha=1,10", "filters.kind=none,kalman"], ["eye"], ["lab.pursuit_lag"], max_trials=100)
    names = [t.name for t in trials]
    assert names[0] == "base"
    assert sum(1 for t in trials if set(t.changes) == {"models.ridge_alpha", "filters.kind"}) == 4
    assert any(t.changes == {"lab.eye": "left"} for t in trials) and not any(t.changes == {"lab.eye": "both"} for t in trials)
    assert any(t.changes == {"lab.pursuit_lag_ms": 50.0} for t in trials)
    lists = T.make_trials(['estimators.order=["landmarks"],["landmarks","iris_edge"]'], [], [], 10)
    assert [t.changes.get("estimators.order") for t in lists[1:]] == [["landmarks"], ["landmarks", "iris_edge"]]
    assert len(T.make_trials(["models.ridge_alpha=1,2,3,4,5,6"], [], [], 3)) == 3
    with pytest.raises(L.LabError):
        T.make_trials(["nope.x=1"], [], [], 10)
    with pytest.raises(L.LabError):
        T.make_trials([], ["nope"], [], 10)


def test_paired_detects_real_differences_only() -> None:
    rng = np.random.default_rng(1)
    a = {str(i): float(v) for i, v in enumerate(rng.normal(1.0, 0.3, 25))}
    b = {k: v - 0.4 + rng.normal(0, 0.05) for k, v in a.items()}
    res = T.paired(a, b)
    assert res["ci"][1] < 0 and "B is better" in res["verdict"]
    c = {k: v + rng.normal(0, 0.2) for k, v in a.items()}
    assert "no difference" in T.paired(a, c)["verdict"]


def test_tune_finds_the_better_setting_and_saves_a_preset(session: Path, cfg: Config) -> None:
    src = L.open_source(session)
    cfg.models.candidates = ["ridge"]
    trials = T.make_trials(['models.candidates=["kernel"]'], [], [], 10)
    res = T.run_tune(src, cfg, trials, metric="loo", folds=3, segment=None, combo="sim_oracle")
    assert res["winner"]["trial"] == "base"
    worst = res["trials"][-1]
    assert worst["changes"] == {"models.candidates": ["kernel"]} and worst["vs_base"]["mean"] > 0
    assert res["nested"]["estimate"] is not None and res["nested"]["picks"]
    assert "Winner" in T.format_tune(res)
    path = L.save_preset(cfg, "unit test/best", {"models.candidates": ["geometric"]}, source="tune")
    assert path.name == "unit-test-best.json"
    data = L.load_preset("unit-test-best", cfg)
    assert data["changes"] == {"models.candidates": ["geometric"]}
    with pytest.raises(L.LabError, match="no preset"):
        L.load_preset("missing", cfg)


@pytest.mark.slow
def test_ab_command(session: Path, cfg: Config, tmp_path: Path, capsys) -> None:
    src = L.open_source(session)
    cfg.models.candidates = ["geometric"]
    res = T.run_ab(src, cfg, "base", 'models.candidates=["kernel"]', metric="loo", folds=3, segment=None, combo="sim_oracle")
    assert res["comparison"]["mean"] > 0 and "A is better" in res["comparison"]["verdict"]
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg.to_dict()))
    rc = T.ab_main([str(session), "--config", str(cfg_path), "--combo", "sim_oracle", "--a", "base", "--b", "base", "--folds", "3"])
    assert rc == 0 and "no difference" in capsys.readouterr().out


@pytest.mark.slow
def test_tune_cli_saves_winner(session: Path, cfg: Config, tmp_path: Path, capsys) -> None:
    cfg.models.candidates = ["ridge"]
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg.to_dict()))
    rc = T.tune_main([str(session), "--config", str(cfg_path), "--combo", "sim_oracle", "--sweep", "lab.eye=left", "--folds", "3", "--save", "cli-best"])
    out = capsys.readouterr().out
    assert rc == 0 and "Saved preset" in out
    preset = json.loads((Path(cfg.lab.output_dir) / "presets" / "cli-best.json").read_text())
    assert preset["source"] == "tune" and "changes" in preset
    assert T.tune_main([str(session), "--config", str(cfg_path)]) == 2  # nothing to try: a message


# --------------------------------------------------------------------------------------------
# /api/lab/* (the Lab page's API)
# --------------------------------------------------------------------------------------------


def test_lab_routes(session: Path, cfg: Config) -> None:
    import asyncio

    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    L.save_preset(cfg, "routes", {"filters.beta": 0.05}, source="tune", score=1.0, unit="deg")

    class FakeEngine:
        def __init__(self) -> None:
            self.config = cfg
            self.applied: list[dict] = []

        async def apply_config(self, changes: dict) -> dict:
            self.applied.append(changes)
            return {}

    engine = FakeEngine()
    cfg.lab.combos = ["sim_oracle"]

    async def go() -> None:
        app = web.Application()
        L.register(app, engine)
        async with TestClient(TestServer(app)) as client:
            presets = await (await client.get("/api/lab/presets")).json()
            assert any(p["name"] == "routes" for p in presets["presets"])
            r = await client.post("/api/lab/presets/apply", json={"name": "routes"})
            assert r.status == 200 and engine.applied == [{"filters.beta": 0.05}]
            assert (await client.post("/api/lab/presets/apply", json={"name": "missing"})).status == 404
            assert (await client.post("/api/lab/run", json={"session": "/nope"})).status == 400
            job = await (await client.post("/api/lab/run", json={"session": str(session)})).json()
            for _ in range(600):
                jobs = (await (await client.get("/api/lab/jobs")).json())["jobs"]
                if jobs[0]["state"] != "running":
                    break
                await asyncio.sleep(0.1)
            assert jobs[0]["state"] == "done", jobs[0]
            reports = (await (await client.get("/api/lab/reports")).json())["reports"]
            assert any(r["id"] == jobs[0]["report"] for r in reports)
            page = await client.get(f"/api/lab/report/{jobs[0]['report']}")
            assert page.status == 200 and "<svg" in await page.text()
            assert (await client.get("/api/lab/report/..")).status in (400, 404)
            assert job["state"] == "running"
            sessions = await (await client.get("/api/lab/sessions")).json()
            assert "sessions" in sessions

    asyncio.run(go())


def test_synthetic_video_is_hevc_mov(session: Path) -> None:
    import subprocess

    from lab_synth import hevc_available

    if not hevc_available():
        pytest.skip("this ffmpeg has no HEVC encoder")
    codec = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(session / "back-wide-2x.mov")], capture_output=True, text=True).stdout.strip()
    assert codec == "hevc"
