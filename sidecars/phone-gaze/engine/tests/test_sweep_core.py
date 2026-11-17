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
    make_condition(root, "unit", {**DEFAULT_CONDITIONS[0]}, fps=8.0, dwell_s=0.8, validate_n=6, pose_groups=1, pursuit_s=0)
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
