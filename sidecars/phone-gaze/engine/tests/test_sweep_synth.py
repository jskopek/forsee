"""The sweep and the diagnosis on a synthetic collection run with known problems. Owner: Sweep.

``sweep_synth.make_run`` writes five conditions in the exact ``phonegaze-collect-1`` format, from
the simulator, with one injected problem each (none, noisy iris, an offset on validation, eyes
lost half the time, a moving head). The frames carry the simulator's truth, read by the lab's
``sim_oracle`` estimators, so these tests check the sweep's logic, not vision.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from sweep_synth import DEFAULT_CONDITIONS, make_run  # noqa: E402

from phonegaze import sweep as S  # noqa: E402
from phonegaze.config import Config  # noqa: E402

SMALL = {"fps": 10.0, "dwell_s": 1.5, "validate_n": 8, "pose_groups": 2, "pursuit_s": 4.0}


@pytest.fixture(scope="module")
def run(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("recordings")
    return make_run(root, "synth", **SMALL)


@pytest.fixture(scope="module")
def swept(run: Path, tmp_path_factory) -> dict:
    """One sweep of the whole run (two processes, a few model setups, both truth chains)."""
    conf = tmp_path_factory.mktemp("conf") / "config.json"
    cfg = Config()
    board = S.run_sweep(str(run), cfg, config_path=str(conf), minutes=4, max_combos=14, workers=2, vision="oracle", models=["auto", "ridge", "reflection"])
    return {"board": board, "conf": conf, "out": Path(board["output_dir"])}


def test_the_run_file_and_manifests_resolve(run: Path) -> None:
    inp = S.resolve(str(run), Config())
    assert inp.root == run.parent.parent and inp.name == "synth"
    assert [c.id for c in inp.conditions] == [c["id"] for c in DEFAULT_CONDITIONS]
    for c in inp.conditions:
        assert c.kind == "collect" and c.pursuit is not None and len(c.phase("validation")) == 8


def test_sweep_ranks_sensibly(swept: dict) -> None:
    b = swept["board"]
    by = {c["id"]: c for c in b["conditions"]}
    win = {k: (c.get("winner") or {}).get("acc_deg") for k, c in by.items()}
    assert win["clean"] is not None and win["clean"] < 0.5
    # the injected problems cost accuracy, and the leaderboard sees it
    assert win["noisy"] > win["clean"] + 0.5
    assert win["offset"] > 2.0  # 2.9 degrees were injected; no calibration can see it
    assert b["overall"]["condition"] in ("clean", "headmove")
    assert {c["camera_id"] for c in b["cameras"]} == {"back-wide", "front"}
    # "clean" and "noisy" share camera, zoom and settings: repeats of one setup, so each one's
    # winner is also scored on the other
    rep = {r["ranked_on"]: r for r in b["repeats"]}
    assert set(rep) >= {"clean", "noisy"}
    assert rep["clean"]["on_repeats"][0]["condition"] == "noisy" and rep["clean"]["on_repeats"][0]["acc_deg"] is not None
    for c in b["conditions"]:
        assert c["evaluated"] <= 14 + 3  # the cap, plus confirming the other repeat's top three
        assert 0 < c["space_share"] < 0.01  # it says how little of the space was covered
        if c.get("top"):
            w = c["top"][0]
            assert w["ci"][0] <= w["acc_deg"] <= w["ci"][1]
            assert w["rank_deg"] is not None and w["confirm_deg"] is not None


def test_outputs_summary_and_preset(swept: dict) -> None:
    out = swept["out"]
    for f in ("leaderboard.md", "leaderboard.html", "leaderboard.json", "summary.txt", "best_preset.json", "results.jsonl", "state.json", "diagnosis.json"):
        assert (out / f).exists(), f
    text = (out / "summary.txt").read_text()
    assert "BEST OVERALL" in text and "why:" in text and len(text) < 8000
    assert json.loads((out / "state.json").read_text())["stage"] == "done"
    # the preset, through the presets store next to the config
    from phonegaze.presets import PresetStore, store_path, validate

    best = json.loads((out / "best_preset.json").read_text())
    stored = PresetStore(store_path(swept["conf"])).get(S.PRESET_NAME)
    assert stored["mode"] == "replace" and stored["changes"] == best["changes"]
    validate(stored)
    overall = swept["board"]["overall"]
    assert best["camera_id"] == overall["camera_id"] and best["zoom"] == overall["zoom"]
    assert best["changes"].get("lens.camera_prefer") in ("back", "front", "arkit")
    if overall["zoom"] != 2.0:  # 2.0 is the default zoom and is left out
        assert best["changes"]["lens.zoom"] == overall["zoom"]
    assert "Applies to camera" in stored["description"]


def test_diagnosis_names_each_injected_problem(swept: dict) -> None:
    diag = {d["id"]: d for d in swept["board"]["diagnosis"]["conditions"]}
    top = {k: (d["findings"][0]["kind"] if d["findings"] else None) for k, d in diag.items()}
    assert top["noisy"] == "noise", diag["noisy"]["verdict"]
    assert top["offset"] == "offset", diag["offset"]["verdict"]
    assert top["halfeyes"] == "availability", diag["halfeyes"]["verdict"]
    assert top["headmove"] == "head", diag["headmove"]["verdict"]
    assert top["clean"] is None and diag["clean"]["verdict"].startswith("no single dominant limit")
    assert "noisy" in diag["noisy"]["verdict"] and "jitter" in diag["noisy"]["verdict"]
    av = diag["halfeyes"]["availability"]["usable"]
    assert 0.3 < av < 0.7
    assert diag["offset"]["bias"]["offset_size_deg"] > 2.0
    # the numbers behind the verdicts
    assert diag["noisy"]["precision_floor"]["main_deg"] > 1.5 > diag["clean"]["precision_floor"]["main_deg"]
    ss = diag["clean"]["signal_strength"]["signals"]["iris_minus_corners"]
    assert ss["horizontal"]["explained"] > 0.9 and ss["vertical"]["explained"] > 0.9
    assert diag["offset"]["ceiling"]["ceiling_deg"] < diag["offset"]["achieved_deg"]


def test_validation_never_reaches_a_fit(run: Path, tmp_path: Path, monkeypatch) -> None:
    """Every fit made during a (small, in-process) sweep sees no validation sample."""
    from phonegaze import calibration as calib

    seen: list[tuple[str, int]] = []
    real = calib.fit_all

    def spy(samples, screen, models):
        seen.extend((s.kind, int(s.dot_id)) for s in samples)
        return real(samples, screen, models)

    monkeypatch.setattr(calib, "fit_all", spy)
    inp = S.resolve(str(run.parent.parent / "synth-offset"), Config())
    sw = S.Sweep(inp, Config(), tmp_path / "out", minutes=3, max_combos=10, workers=1, vision_mode="oracle", models=["ridge", "reflection"])
    sw.run(diagnose=False)
    assert seen and len(sw.results) >= 4
    assert not [x for x in seen if x[0] == "validate" or x[1] >= S.VALIDATION_BASE]
    # ... and the search was steered without validation: the calibration-only score exists for
    # every scored row, and the leaderboard reports what it alone would have picked
    board = S.build_leaderboard(sw)
    assert board["conditions"][0].get("search_pick") is not None


def test_an_interrupted_sweep_resumes(run: Path, tmp_path: Path, monkeypatch) -> None:
    inp = S.resolve(str(run.parent.parent / "synth-clean"), Config())
    out = tmp_path / "out"
    sw = S.Sweep(inp, Config(), out, minutes=3, max_combos=8, workers=1, vision_mode="oracle", models=["ridge", "reflection"])
    sw.run(diagnose=False)
    lines = (out / "results.jsonl").read_text().splitlines()
    assert len(lines) == 8
    # interrupted while writing the last result: half a line
    (out / "results.jsonl").write_text("\n".join(lines[:-1]) + "\n" + lines[-1][: len(lines[-1]) // 2])
    calls = []
    real = S.evaluate
    monkeypatch.setattr(S, "evaluate", lambda *a, **k: calls.append(a[-1]) or real(*a, **k))
    sw2 = S.Sweep(inp, Config(), out, minutes=3, max_combos=8, workers=1, vision_mode="oracle", models=["ridge", "reflection"])
    assert sw2.resumed == 7
    sw2.run(diagnose=False)
    assert len(calls) == 1  # only the result that was cut short is fitted again
    # stage 1 came from the observation cache
    assert all(st.get("cached") for st in sw2.obs_stats.values())


def test_sweep_page_routes(swept: dict, tmp_path: Path) -> None:
    """The page's API: list, status with the leaderboard, report, apply the preset."""
    import asyncio

    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    out = swept["out"]
    cfg = Config()
    cfg.recording.directory = str(out.parent.parent)

    class Eng:
        config = cfg
        config_path = tmp_path / "config.json"
        applied: dict = {}

        async def apply_config(self, changes):
            self.applied.update(changes)
            return {}

    eng = Eng()

    async def go() -> None:
        app = web.Application()
        S.register(app, eng)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            r = await client.get("/api/sweep/list")
            names = [s["name"] for s in (await r.json())["sweeps"]]
            assert out.name in names
            r = await client.get("/api/sweep/status", params={"name": out.name})
            st = await r.json()
            assert st["stage"] == "done" and not st["running"] and st["board"]["overall"] and st["summary"] and st["diagnosis"]
            r = await client.get(f"/api/sweep/report/{out.name}")
            assert r.status == 200 and "<table" in await r.text()
            r = await client.post("/api/sweep/apply", json={"name": out.name})
            body = await r.json()
            assert r.status == 200 and body["preset"] == S.PRESET_NAME and body["errors"] == {}
            assert eng.applied and (tmp_path / "presets.json").exists()
            r = await client.get("/api/sweep/targets")
            t = await r.json()
            assert [x["run_id"] for x in t["runs"]] == ["synth"]
            r = await client.post("/api/sweep/start", json={"target": "/nowhere/at/all"})
            assert r.status == 400 and "not a folder" in (await r.json())["error"]
            r = await client.get("/api/sweep/status", params={"name": "../etc"})
            assert r.status == 404
        finally:
            await client.close()

    asyncio.run(go())


def test_diagnose_after_a_sweep_covers_the_best_setup_and_the_defaults(swept: dict, run: Path, capsys) -> None:
    from phonegaze import signal_report as R

    assert R.main([str(run), "--config", str(swept["conf"]), "--vision", "oracle", "--workers", "2", "--json"]) == 0
    diag = json.loads(capsys.readouterr().out)
    which = [(d["id"], d["which"].split(" (")[0]) for d in diag["conditions"]]
    ids = [c["id"] for c in DEFAULT_CONDITIONS]
    scored = [c["id"] for c in swept["board"]["conditions"] if c.get("winner")]
    for cid in ids:
        mine = [w for i, w in which if i == cid]
        assert mine[-1] == "with today's defaults"
        if cid in scored:
            assert mine == ["with the sweep's best setup", "with today's defaults"]
