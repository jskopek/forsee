"""Guided collection run (phonegaze/collect.py): conditions, the queue, the protocol, the manifest."""

from __future__ import annotations

import json
import math

import pytest

from phonegaze import collect as C
from phonegaze.config import Config, settings
from phonegaze.presets import in_presets

SCREEN = (1512.0, 982.0)


def test_sets_have_the_promised_conditions():
    sets = C.condition_sets(8.0)
    quick = [(c["camera"], c["zoom"]) for c in sets["quick"]["conditions"]]
    assert quick == [("front_arkit", 1.0), ("back_wide", 1.0), ("back_wide", 2.0)]
    rear = sets["rear"]["conditions"]
    assert len(rear) == 8
    assert {(c["zoom"], c["reflection"], c["max_exposure_ms"]) for c in rear} == {(z, r, s) for z in (1.0, 2.0) for r in ("off", "border") for s in (0.0, 8.0)}
    every = sets["everything"]["conditions"]
    assert {c["camera"] for c in every} == set(C.CAMERAS)
    labels = [c["label"] for c in every]
    assert len(set(labels)) == len(labels), "every condition of a set has its own label"


def test_condition_settings_are_config_paths_and_fix_the_zoom():
    paths = {s.path for s in settings()}
    c = C.make_condition("back_wide", 2.0, reflection="border", max_exposure_ms=8, focus="locked", notes="60 cm, glasses")
    s = C.condition_settings(c)
    assert set(s) <= paths
    assert s["lens.zoom"] == 2.0 and s["lens.auto_zoom"] is False and s["ui.glint_marker"] == "border"
    assert s["lens.max_exposure_ms"] == 8.0 and s["lens.focus_locked"] == "locked"
    assert C.make_condition("front_arkit", 3.0)["zoom"] == 1.0
    with pytest.raises(C.CollectError):
        C.make_condition("periscope")
    with pytest.raises(C.CollectError):
        C.condition_from_dict({"camera": "back_wide", "settings": {"lens.nonsense": 1}})
    assert C.condition_from_dict({"camera": "back_wide", "settings": {"estimators.use_reflection": False}})["settings"] == {"estimators.use_reflection": False}


def test_resolve_camera_from_phone_list():
    cams = [
        {"id": "w-lidar", "position": "back", "type": "wide", "depthSource": "lidar"},
        {"id": "w", "position": "back", "type": "wide"},
        {"id": "u", "position": "back", "type": "ultrawide"},
        {"id": "f", "position": "front", "type": "wide"},
        {"id": "arkit-face", "position": "front", "type": "arkit"},
    ]
    assert C.resolve_camera("back_wide", cams)["id"] == "w"
    assert C.resolve_camera("back_ultrawide", cams)["id"] == "u"
    assert C.resolve_camera("front", cams)["id"] == "f"
    assert C.resolve_camera("front_arkit", cams)["id"] == "arkit-face"
    assert C.resolve_camera("back_tele", cams) is None


@pytest.mark.parametrize("length", ["short", "medium", "long"])
def test_protocol_shape_and_validation_away_from_calibration(length):
    p = C.build_protocol(*SCREEN, length, pursuit=True)
    names = [ph["name"] for ph in p["phases"]]
    assert names == ["calibration", "poses", "validation", "pursuit"]
    cal, poses, val = (p["phases"][i]["dots"] for i in range(3))
    ids = [d["id"] for d in cal + poses + val]
    assert len(ids) == len(set(ids)), "dot ids are unique within a condition"
    w, h = SCREEN
    for d in cal + poses + val:
        assert 0 < d["x"] < w and 0 < d["y"] < h
    cal_xy = {(d["x"], d["y"]) for d in cal}
    for d in val:
        nearest = min(math.hypot(d["x"] - x, d["y"] - y) for x, y in cal_xy)
        assert nearest > 40, f"validation dot {d} sits on a calibration dot"
    groups = sorted({d["pose_group"] for d in poses})
    assert groups == list(range(1, len(groups) + 1)) and len(groups) >= 3
    per_group = [[(d["x"], d["y"]) for d in poses if d["pose_group"] == g] for g in groups]
    assert all(g == per_group[0] for g in per_group), "the same dots for every head position"
    assert all(d["pose_group"] == 0 for d in cal + val)
    assert set(p["phases"][1]["prompts"]) == {str(g) for g in groups}
    assert len(p["phases"][3]["path"]) > 8


def test_protocol_lengths_roughly_one_two_three_minutes():
    secs = {k: C.build_protocol(*SCREEN, k)["seconds"] for k in C.LENGTHS}
    assert 50 <= secs["short"] <= 90
    assert 90 <= secs["medium"] <= 140
    assert 140 <= secs["long"] <= 200
    assert secs["short"] < secs["medium"] < secs["long"]
    assert C.build_protocol(*SCREEN, "short", pursuit=False)["seconds"] < secs["short"]
    with pytest.raises(C.CollectError):
        C.build_protocol(*SCREEN, "forever")


def test_protocol_is_identical_for_every_condition():
    assert C.build_protocol(*SCREEN, "medium") == C.build_protocol(*SCREEN, "medium")


def test_queue_add_remove_move_repeat_and_resume(tmp_path):
    run = C.Run(tmp_path, C.Run.new_id(tmp_path), length="short")
    for c in C.condition_sets()["quick"]["conditions"]:
        run.add(c)
    run.save()
    assert [c["id"] for c in run.conditions] == ["c01", "c02", "c03"]
    run.move(2, 0)
    assert [c["id"] for c in run.conditions] == ["c03", "c01", "c02"]
    rep = run.repeat(0)
    assert rep["id"] == "c04" and run.conditions[1] is rep and rep["label"] == run.conditions[0]["label"] and rep["attempts"] == []
    run.remove(2)
    assert [c["id"] for c in run.conditions] == ["c03", "c04", "c02"]
    run.set_status(0, "done")
    run.set_status(1, "skipped")
    assert run.next_pending() == 2
    run.set_notes(2, "lamp on the left")
    with pytest.raises(C.CollectError):
        run.remove(7)
    with pytest.raises(C.CollectError):
        run.set_status(0, "great")
    # A condition interrupted by an engine restart comes back as pending.
    run.conditions[2]["status"] = "recording"
    run.conditions[2]["attempts"].append({"recording_id": "x", "path": "/x", "outcome": "recording"})
    run.save()
    again = C.Run.load(tmp_path, run.run_id)
    assert [c["status"] for c in again.conditions] == ["done", "skipped", "pending"]
    assert again.conditions[2]["attempts"][0]["outcome"] == "interrupted"
    assert again.conditions[2]["notes"] == "lamp on the left"
    assert again.add(C.make_condition("front"))["id"] == "c05", "ids keep counting after a resume"
    listed = C.list_runs(tmp_path)
    assert listed[0]["run_id"] == run.run_id and listed[0]["conditions"] == 3
    assert run.estimate_s(100.0, 30.0) == 130.0
    with pytest.raises(C.CollectError):
        C.Run.load(tmp_path, "../etc")


def test_run_file_lists_completed_recordings_in_queue_order(tmp_path):
    run = C.Run(tmp_path, "r1")
    a = run.add(C.make_condition("back_wide", 1.0))
    b = run.add(C.make_condition("back_wide", 2.0))
    b["attempts"].append({"recording_id": "rb", "path": "/rb", "outcome": "completed", "quality": {"both_eyes_pct": 90.0}})
    b["status"] = "done"
    a["attempts"].append({"recording_id": "ra1", "path": "/ra1", "outcome": "aborted (redo)"})
    a["attempts"].append({"recording_id": "ra2", "path": "/ra2", "outcome": "completed", "quality": {"both_eyes_pct": 40.0}})
    a["status"] = "poor"
    run.save()
    data = json.loads((tmp_path / "collect-runs" / "r1.json").read_text())
    assert data["format"] == "phonegaze-collect-run-1"
    assert [r["recording_id"] for r in data["recordings"]] == ["ra2", "rb"]
    assert data["recordings"][0]["poor"] is True and data["recordings"][1]["poor"] is False


def test_manifest_shape(tmp_path):
    cond = {"id": "c01", "label": "back wide 2x", "camera_id": "cam0", "camera_label": "Back Camera", "zoom": 2.0, "settings": {"lens.zoom": 2.0}, "notes": "60 cm"}
    m = C.Manifest("run1", cond, {"width_pt": 1512, "height_pt": 982, "width_mm": 345.0, "height_mm": 224.0})
    m.phase("calibration")
    m.dot_on("calibration", 0, 100, 200, 10.0, 0)
    assert m.dot_off("calibration", 0, 11.5)
    assert not m.dot_off("calibration", 0, 12.0), "a dot is closed once"
    m.phase("poses")
    m.dot_on("poses", 9, 50, 60, 12.0, 1)
    m.restart_phase("poses")  # Esc, then continue: the phase starts again
    m.dot_on("poses", 9, 50, 60, 13.0, 1)
    m.dot_off("poses", 9, 14.0)
    m.dot_on("validation", 20, 70, 80, 15.0, 0)  # left open: dropped when the condition ends
    m.sample(16.0, 1.0, 2.0)
    m.drop_open()
    m.data["completed"] = True
    m.write(tmp_path)
    d = C.read_manifest(tmp_path)
    assert set(d) == {"format", "run_id", "condition", "screen", "phases", "started", "completed"}
    assert d["format"] == "phonegaze-collect-1" and d["completed"] is True
    assert set(d["condition"]) == {"id", "label", "camera_id", "camera_label", "zoom", "settings", "notes"}
    assert set(d["screen"]) == {"width_pt", "height_pt", "width_mm", "height_mm"}
    assert [p["name"] for p in d["phases"]] == ["calibration", "poses", "validation", "pursuit"]
    cal, poses, val, pur = d["phases"]
    assert cal["dots"] == [{"id": 0, "x": 100.0, "y": 200.0, "t_on": 10.0, "t_off": 11.5, "pose_group": 0}]
    assert poses["dots"] == [{"id": 9, "x": 50.0, "y": 60.0, "t_on": 13.0, "t_off": 14.0, "pose_group": 1}]
    assert val["dots"] == [] and "samples" not in val
    assert pur["samples"] == [[16.0, 1.0, 2.0]]
    with pytest.raises(C.CollectError):
        m.phase("warmup")


def test_quality_and_poor_flag():
    assert C.is_poor({"both_eyes_pct": 50.0}, 80)
    assert not C.is_poor({"both_eyes_pct": 95.0}, 80)
    assert C.is_poor({"both_eyes_pct": None}, 80)


def test_settings_are_in_the_config_tree_and_not_in_presets():
    cfg = Config()
    assert cfg.collect.protocol == "medium" and cfg.ui.simple_mode is True
    for s in settings():
        if s.path.startswith("collect.") or s.path == "ui.simple_mode":
            assert not in_presets(s)


def test_best_preset_is_the_newest_from_the_sweep(tmp_path):
    from types import SimpleNamespace

    from phonegaze.presets import PresetStore

    path = tmp_path / "presets.json"
    store = PresetStore(path)
    engine = SimpleNamespace(presets=store, config_path=tmp_path / "config.json")
    col = C.Collector(engine)
    assert col.best_preset() is None

    def write(*presets):
        path.write_text(json.dumps({"version": 1, "presets": list(presets)}))

    new = {"name": "best from sweep", "description": "From the sweep: Back Camera at 2x", "mode": "replace", "changes": {"lens.camera_prefer": "back"}, "saved": "2026-11-17T10:00:00"}
    old = {"name": "best from sweep (old)", "description": "", "mode": "replace", "changes": {"lens.camera_prefer": "arkit", "lens.zoom": 1.0}, "saved": "2026-11-16T10:00:00"}
    other = {"name": "mine", "description": "", "mode": "replace", "changes": {}, "saved": "2026-11-18T10:00:00"}
    write(old, new, other)
    best = col.best_preset()
    assert best["name"] == "best from sweep" and best["camera"] == "back camera" and best["zoom"] == 2.0
    write(old, other)
    best = col.best_preset()
    assert best["camera"] == "front ARKit camera" and best["zoom"] == 1.0
