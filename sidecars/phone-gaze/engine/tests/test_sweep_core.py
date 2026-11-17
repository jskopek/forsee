"""Sweep building blocks: inputs and their error messages, the search space, the intervals and
the split of validation dots. Owner: Sweep. Fast (no fitting)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))

from sweep_synth import DEFAULT_CONDITIONS, make_condition  # noqa: E402

from phonegaze import sweep as S  # noqa: E402
from phonegaze.config import Config  # noqa: E402


@pytest.fixture(scope="module")
def one(tmp_path_factory) -> Path:
    """One small synthetic condition (clean) in a recordings folder."""
    root = tmp_path_factory.mktemp("recs")
    make_condition(root, "unit", {**DEFAULT_CONDITIONS[0]}, fps=8.0, dwell_s=1.5, validate_n=6, pose_groups=1, pursuit_s=0)
    return root


def cfg_for(root: Path) -> Config:
    c = Config()
    c.recording.directory = str(root)
    return c


def test_bootstrap_interval_contains_the_mean_and_narrows() -> None:
    rng = np.random.default_rng(1)
    small = rng.normal(2.0, 1.0, 8)
    big = rng.normal(2.0, 1.0, 200)
    lo, hi = S.bootstrap_ci(small)
    assert lo < small.mean() < hi
    lo2, hi2 = S.bootstrap_ci(big)
    assert lo2 < big.mean() < hi2 and (hi2 - lo2) < (hi - lo)
    assert S.bootstrap_ci([1.0]) is None
    assert S.bootstrap_ci([1.0, float("nan"), 3.0]) is not None  # NaNs are skipped


def test_fit_keys_drop_defaults_and_axes_that_do_not_apply() -> None:
    has = {"poses": True, "pursuit": False}
    a = S.normalise_fit({"model": "ridge", "models.eye": "left", "calibration.outlier_mad": 3.0, "calibration.pursuit_merge": "on", "regularisation": 10.0}, has)
    # eye only matters to geometric-like models, 3.0 is the default, no moving dot in this run
    assert a == {"model": "ridge", "regularisation": 10.0}
    assert S.fit_key(a) == S.fit_key(dict(reversed(list(a.items()))))
    ch = S.fit_changes(a)
    assert ch["models.auto_alpha"] is False and ch["models.ridge_alpha"] == 10.0 and ch["models.pinned"] == "ridge"
    assert S.normalise_fit({"model": "geometric", "poses": False}, {"poses": False}) == {"model": "geometric"}
    assert S.full_space_size(has, 2) > S.full_space_size(has, 1) > 1000


def test_share_of_the_space_reads_well() -> None:
    assert S._share(0.5) == "50 %"
    assert S._share(0.000019) == "0.0019 %"


def test_resolve_a_single_collect_recording(one: Path) -> None:
    inp = S.resolve(str(one / "unit-clean"), cfg_for(one))
    assert inp.root == one and len(inp.conditions) == 1
    c = inp.conditions[0]
    assert c.kind == "collect" and c.camera_id == "back-wide" and c.zoom == 2.0
    assert len(c.phase("calibration")) == 9 and len(c.phase("validation")) == 6 and c.pose_groups == [0, 1]
    assert all(d.uid >= S.VALIDATION_BASE for d in c.phase("validation"))
    assert all(d.uid < S.VALIDATION_BASE for d in c.phase("calibration") + c.phase("poses"))
    assert c.has_sim_truth and S.vision_space(c, "auto")[0]["chain"] == "sim_oracle_2d"
    # a folder of recordings, and a run id by manifest when there is no run file
    assert len(S.resolve(str(one), cfg_for(one)).conditions) == 1
    assert S.resolve("unit", cfg_for(one)).conditions[0].id == "clean"


def test_split_dots_alternate_in_time(one: Path) -> None:
    c = S.resolve(str(one / "unit-clean"), cfg_for(one)).conditions[0]
    a, b = S.split_dots(c)
    assert a and b and not (a & b) and a | b == {d.uid for d in c.phase("validation")}
    order = [d.uid for d in sorted(c.phase("validation"), key=lambda d: d.t0)]
    assert order[0] in a and order[1] in b


def test_clear_messages_for_bad_input(tmp_path: Path, one: Path) -> None:
    cfg = cfg_for(tmp_path)
    with pytest.raises(S.SweepError, match="not a folder, a file or a run id"):
        S.resolve("no-such-run", cfg)
    (tmp_path / "empty").mkdir()
    with pytest.raises(S.SweepError, match="holds no recordings"):
        S.resolve(str(tmp_path / "empty"), cfg)
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "collect.json").write_text(json.dumps({"format": "something-else"}))
    with pytest.raises(S.SweepError, match="format"):
        S.resolve(str(bad), cfg)
    # dots whose times do not match the recorded frames
    import shutil

    moved = tmp_path / "moved"
    shutil.copytree(one / "unit-clean", moved)
    m = json.loads((moved / "collect.json").read_text())
    for ph in m["phases"]:
        for d in ph["dots"]:
            d["t_on"] += 5000
            d["t_off"] += 5000
    (moved / "collect.json").write_text(json.dumps(m))
    with pytest.raises(S.SweepError, match="do not match the recorded frames"):
        S.resolve(str(moved), cfg)
    # a run file that names nothing that exists
    runs = tmp_path / "collect-runs"
    runs.mkdir()
    (runs / "r.json").write_text(json.dumps({"run_id": "r", "recordings": [{"path": "/nowhere"}]}))
    with pytest.raises(S.SweepError, match="names no recording"):
        S.resolve(str(runs / "r.json"), cfg)


def test_command_line_errors_are_messages_not_tracebacks(tmp_path: Path, capsys) -> None:
    from phonegaze import signal_report as R

    assert S.main([str(tmp_path / "missing"), "--config", str(tmp_path / "c.json")]) == 2
    err = capsys.readouterr().err
    assert err.startswith("sweep: ") and "Traceback" not in err
    assert R.main([str(tmp_path / "missing"), "--config", str(tmp_path / "c.json")]) == 2
    err = capsys.readouterr().err
    assert err.startswith("diagnose: ") and "Traceback" not in err


def test_missing_validation_holds_out_calibration_dots(tmp_path: Path, one: Path) -> None:
    import shutil

    d = tmp_path / "noval"
    shutil.copytree(one / "unit-clean", d)
    m = json.loads((d / "collect.json").read_text())
    m["phases"] = [p for p in m["phases"] if p["name"] != "validation"]
    (d / "collect.json").write_text(json.dumps(m))
    c = S.resolve(str(d), cfg_for(tmp_path)).conditions[0]
    assert c.held_out_from_calibration and len(c.phase("validation")) == 3
    assert any("held out" in n for n in c.notes)


def test_search_finds_a_known_optimum_within_the_cap(one: Path, tmp_path: Path, monkeypatch) -> None:
    """With a made-up score (ridge best; three settings each help a little), coarse pass, one
    setting at a time and the greedy combination reach the optimum, and the cap holds."""
    inp = S.resolve(str(one / "unit-clean"), cfg_for(one))
    cond = inp.conditions[0]
    calls: list[dict] = []

    def score(fit: dict) -> float:
        s = 0.5 if fit.get("model") == "ridge" else 1.0
        s += 0.0 if fit.get("calibration.outlier_mad") == 5.0 else 0.3
        s += 0.0 if fit.get("calibration.discard_ms") == 300 else 0.2
        s += 0.0 if fit.get("calibration.error_map") == "affine" else 0.2
        return s

    def fake_fit(cid, vision, fit):
        calls.append(fit)
        v = score(fit)
        per = [[d.uid, v, 0.0, 0.0, d.x, d.y, d.t0] for d in cond.phase("validation")]
        return {"cond": cid, "vision": S.vision_id(vision), "fit": fit, "key": S.fit_key(fit), "v": S.SWEEP_VERSION, "rec": cond.signature, "search_deg": v, "acc_deg": v, "coverage": 1.0, "per_dot": per, "seconds": 0.0}

    monkeypatch.setattr(S, "_job_fit", fake_fit)
    monkeypatch.setattr(S, "_job_observe", lambda cid, v: {"cond": cid, "vision": S.vision_id(v), "ok": True, "frames": 10, "cached": True})
    sw = S.Sweep(inp, Config(), tmp_path / "out", minutes=2, max_combos=120, workers=1, vision_mode="oracle")
    board = sw.run(diagnose=False)
    best = sw.best(cond.id)[0]
    assert best["search_deg"] == pytest.approx(0.5)
    assert best["fit"]["model"] == "ridge"
    assert len(calls) <= 120 and sw.n_evaluated(cond.id) <= 120
    assert board["conditions"][0]["winner"]["acc_deg"] == pytest.approx(0.5)
    # a tiny cap stops it early and says so
    calls.clear()
    sw2 = S.Sweep(inp, Config(), tmp_path / "out2", minutes=2, max_combos=5, workers=1, vision_mode="oracle")
    b2 = sw2.run(diagnose=False)
    assert len(calls) == 5 and b2["stopped_by"] == "cap"


def test_within_noise_marks_and_optimism(one: Path, tmp_path: Path, monkeypatch) -> None:
    """Two setups whose per-dot errors differ by less than their scatter are 'within noise'."""
    inp = S.resolve(str(one / "unit-clean"), cfg_for(one))
    cond = inp.conditions[0]
    rng = np.random.default_rng(0)
    base = {d.uid: float(abs(rng.normal(2.0, 1.0))) for d in cond.phase("validation")}

    def fake_fit(cid, vision, fit):
        shift = {"ridge": 0.0, "kernel": 0.02, "reflection": 1.5}.get(fit.get("model"), 3.0)
        wobble = (lambda i: 0.4 if i % 2 else -0.38) if fit.get("model") == "kernel" else (lambda i: 0.0)
        per = [[u, e + shift + wobble(i), 0.0, 0.0, 0.0, 0.0, 0.0] for i, (u, e) in enumerate(base.items())]
        acc = float(np.mean([p[1] for p in per]))
        return {"cond": cid, "vision": S.vision_id(vision), "fit": fit, "key": S.fit_key(fit), "v": S.SWEEP_VERSION, "rec": cond.signature, "search_deg": acc, "acc_deg": acc, "coverage": 1.0, "per_dot": per, "seconds": 0.0}

    monkeypatch.setattr(S, "_job_fit", fake_fit)
    monkeypatch.setattr(S, "_job_observe", lambda cid, v: {"cond": cid, "vision": S.vision_id(v), "ok": True, "frames": 10, "cached": True})
    sw = S.Sweep(inp, Config(), tmp_path / "o", minutes=1, max_combos=12, workers=1, vision_mode="oracle", models=["ridge", "kernel", "reflection"])
    board = sw.run(diagnose=False)
    top = board["conditions"][0]["top"]
    by_model = {}
    for t in top:
        by_model.setdefault(t["fit"]["model"], t)
    # ridge and kernel differ by noise only: whichever ranks first on its half of the dots, the
    # other is marked within noise of it; reflection is really worse
    first = top[0]["fit"]["model"]
    assert first in ("ridge", "kernel")
    other = by_model["kernel" if first == "ridge" else "ridge"]
    assert other["within_noise"] is True
    assert by_model["reflection"]["within_noise"] is False
    assert board["conditions"][0]["optimism_deg"] is not None


# --------------------------------------------------------------------------------------------
# Bad inputs a first real recording might bring: each ends in a plain message, and the rest of
# the run is still swept.
# --------------------------------------------------------------------------------------------


def _copy(one: Path, dest: Path) -> Path:
    import shutil

    shutil.copytree(one / "unit-clean", dest)
    return dest


def test_empty_validation_phase_holds_out_calibration_dots(tmp_path: Path, one: Path) -> None:
    d = _copy(one, tmp_path / "emptyval")
    m = json.loads((d / "collect.json").read_text())
    for ph in m["phases"]:
        if ph["name"] == "validation":
            ph["dots"] = []
    (d / "collect.json").write_text(json.dumps(m))
    c = S.resolve(str(d), cfg_for(tmp_path)).conditions[0]
    assert c.held_out_from_calibration and c.phase("validation")
    assert any("held out" in n for n in c.notes)


def test_truncated_stream_uses_the_dots_before_the_cut(tmp_path: Path, one: Path) -> None:
    d = _copy(one, tmp_path / "trunc")
    sp = d / "stream.pgz1"
    data = sp.read_bytes()
    sp.write_bytes(data[: int(len(data) * 0.7) + 7])  # cut in the middle of a message
    c = S.resolve(str(d), cfg_for(tmp_path)).conditions[0]
    assert any("cut short" in n for n in c.notes), c.notes
    t = c.segment.times
    assert all(d.t0 <= t[-1] + 1 for d in c.dots)
    assert c.phase("validation")  # what is left of validation, or held-out calibration dots
    # cut so early that most dots are gone: a plain refusal, not a traceback
    sp.write_bytes(data[: int(len(data) * 0.15)])
    with pytest.raises(S.SweepError, match="do not match the recorded frames|calibration dots"):
        S.resolve(str(d), cfg_for(tmp_path))


def test_abandoned_condition_is_named_and_left_out(tmp_path: Path, one: Path) -> None:
    good = _copy(one, tmp_path / "unit-clean")
    half = _copy(one, tmp_path / "unit-half")
    m = json.loads((half / "collect.json").read_text())
    m["phases"] = [p for p in m["phases"] if p["name"] == "calibration"]
    m["completed"] = False
    (half / "collect.json").write_text(json.dumps(m))
    runs = tmp_path / "collect-runs"
    runs.mkdir()
    conds = [
        {"id": "clean", "label": "rear 2x", "status": "done", "attempts": [{"outcome": "completed", "path": str(good)}]},
        {"id": "half", "label": "front", "status": "pending", "attempts": [{"outcome": "aborted (stop)", "path": str(half)}]},
    ]
    run = {"run_id": "unit", "conditions": conds, "recordings": [{"condition_id": "clean", "path": str(good)}]}
    (runs / "unit.json").write_text(json.dumps(run))
    inp = S.resolve("unit", cfg_for(tmp_path))
    assert [c.folder for c in inp.conditions] == [good]
    assert any(n.startswith("front: not finished") and "not swept" in n for n in inp.notes), inp.notes


def test_ordinary_recording_without_validate(tmp_path: Path) -> None:
    from lab_synth import make_recording

    rec = make_recording(tmp_path / "plain", validate=0)
    c = S.resolve(str(rec), cfg_for(tmp_path)).conditions[0]
    assert c.kind == "recording" and c.held_out_from_calibration
    assert len(c.phase("validation")) == 3 and len(c.phase("calibration")) == 6


def test_no_face_anywhere_is_reported_and_the_rest_is_swept(tmp_path: Path) -> None:
    from sweep_synth import make_run

    conds = [{**DEFAULT_CONDITIONS[0]}, {**DEFAULT_CONDITIONS[0], "id": "noface", "label": "no face", "problem": "noface"}]
    run = make_run(tmp_path, "nf", conds, fps=8.0, dwell_s=1.5, validate_n=6, pose_groups=1, pursuit_s=0)
    inp = S.resolve(str(run), cfg_for(tmp_path))
    sw = S.Sweep(inp, Config(), tmp_path / "out", minutes=3, max_combos=3, workers=1, vision_mode="oracle", models=["ridge"])
    board = sw.run(diagnose=True)
    by = {c["id"]: c for c in board["conditions"]}
    assert by["clean"].get("winner") is not None and board["overall"]["condition"] == "clean"
    assert by["noface"].get("winner") is None and "eyes found" in by["noface"]["message"]
    diag = {d["id"]: d for d in board["diagnosis"]["conditions"]}
    assert "0%" in diag["noface"]["verdict"]
    text = S.format_summary(board)
    assert "no face" in text and "Traceback" not in text
