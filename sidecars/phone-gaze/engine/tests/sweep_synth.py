"""Synthetic collection runs for the sweep and diagnosis tests. Owner: Sweep.

Writes, with the simulator and no rendering, what a guided collection run leaves behind: one
Phone Gaze recording per condition (``recorder.Recorder``: ``session.json``, ``stream.pgz1``,
``events.jsonl``) with a ``collect.json`` manifest in the ``phonegaze-collect-1`` format, and a
run file ``<root>/collect-runs/<run_id>.json``. Every frame carries the simulator's truth in
``header["sim"]`` (as the simulated phone sends it), which the lab's ``sim_oracle`` estimators
read; the images are a small uniform grey picture. Nothing here comes from a camera.

Each condition can carry one injected problem:

- ``noisy``: fixational jitter of 2.5 degrees (the measured iris centre scatters within a dot);
- ``offset``: during validation the person looks 2.5 degrees right of and 1.5 degrees below each
  dot (a constant offset the calibration never saw);
- ``halfeyes``: the truth is missing from about half of the frames (eyes not found);
- ``headmove``: the head wanders by several centimetres all the time.

Command line, to look at one by hand::

    python tests/sweep_synth.py OUT_DIR
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

PHONE_T0 = 5000.0

DEFAULT_CONDITIONS: list[dict[str, Any]] = [
    {"id": "clean", "label": "rear 2x, clean", "camera_id": "back-wide", "camera_label": "Back wide", "zoom": 2.0, "problem": None, "seed": 11},
    {"id": "noisy", "label": "rear 2x, noisy iris", "camera_id": "back-wide", "camera_label": "Back wide", "zoom": 2.0, "problem": "noisy", "seed": 12},
    {"id": "offset", "label": "front, offset", "camera_id": "front", "camera_label": "Front TrueDepth", "zoom": 1.0, "problem": "offset", "seed": 13},
    {"id": "halfeyes", "label": "rear 1x, eyes lost", "camera_id": "back-wide", "camera_label": "Back wide", "zoom": 1.0, "problem": "halfeyes", "seed": 14},
    {"id": "headmove", "label": "front, head moving", "camera_id": "front", "camera_label": "Front TrueDepth", "zoom": 1.0, "problem": "headmove", "seed": 15},
]


def _grid(w: float, h: float, cols: int, rows: int, margin: float = 0.1) -> list[tuple[float, float]]:
    return [(w * (margin + (1 - 2 * margin) * c / max(1, cols - 1)), h * (margin + (1 - 2 * margin) * r / max(1, rows - 1))) for r in range(rows) for c in range(cols)]


def make_condition(
    root: Path,
    run_id: str,
    cond: dict[str, Any],
    *,
    fps: float = 15.0,
    dwell_s: float = 1.0,
    gap_s: float = 0.25,
    validate_n: int = 10,
    pose_groups: int = 2,
    pursuit_s: float = 6.0,
    width: int = 640,
    height: int = 360,
) -> Path:
    """One condition's recording folder (with ``collect.json``); returns its path."""
    import cv2

    from phonegaze.protocol import Message
    from phonegaze.recorder import Recorder
    from phonegaze.sim.scene import SimScene

    problem = cond.get("problem")
    seed = int(cond.get("seed", 1))
    rng = np.random.default_rng(seed)
    scene = SimScene(seed=seed, camera="wide")
    scene.knobs.blink_rate_per_min = 0.0
    scene.knobs.jitter_deg = 2.5 if problem == "noisy" else 0.08
    scene.set_camera(scene.camera_id, width, height, 2.0)
    screen = scene.screen
    base_head = np.array(scene.person.head_position, float)
    rec_id = f"{run_id}-{cond['id']}"
    folder = Path(root) / rec_id
    rec = Recorder(folder, {"label": f"collect {cond['label']}", "screen": screen.to_dict(), "config": {"stream": {"rotation": "auto"}}})
    ok, jpg = cv2.imencode(".jpg", np.full((height // 4, width // 4, 3), 96, np.uint8))
    data = bytes(jpg)
    t_engine = 100.0
    seq = 0
    mm_per_pt = (screen.width_mm or 302.0) / screen.width
    dist_mm = float(np.linalg.norm(base_head - scene.camera_pose()[1])) * 1000.0
    pt_per_deg = dist_mm * math.tan(math.radians(1.0)) / mm_per_pt
    head_offset = np.zeros(3)
    drop_until = -1.0

    def frame() -> None:
        nonlocal seq, t_engine, drop_until
        if problem == "headmove":
            tt = scene.t
            wander = np.array([0.05 * math.sin(2 * math.pi * tt / 9.0), 0.03 * math.sin(2 * math.pi * tt / 6.0 + 1.0), 0.06 * math.sin(2 * math.pi * tt / 11.0)])
            scene.set_head(position=(base_head + head_offset + wander).tolist())
        cap = scene.capture()
        header: dict[str, Any] = {
            "type": "frame",
            "seq": seq,
            "t": PHONE_T0 + scene.t,
            "mode": "camera",
            "camera": scene.camera_header(cap),
            "gravity": cap.gravity,
            "parts": [{"name": "wide", "kind": "wide", "format": "jpeg", "bytes": len(data), "width": width // 4, "height": height // 4, "rect": [0, 0, width, height]}],
        }
        drop = False
        if problem == "halfeyes":
            if t_engine >= drop_until and rng.random() < 0.5:
                drop_until = t_engine + float(rng.uniform(0.2, 0.6))
            drop = t_engine < drop_until
        if not drop:
            header["sim"] = cap.truth
        rec.write_message(Message(header, [data]), t_engine)
        seq += 1
        t_engine += 1.0 / fps
        scene.step(1.0 / fps)

    def idle(seconds: float) -> None:
        for _ in range(int(round(seconds * fps))):
            frame()

    def show(points: list[tuple[float, float]], pose_group: int | None, look_offset: tuple[float, float] = (0.0, 0.0), first_id: int = 0) -> list[dict[str, Any]]:
        dots = []
        for i, (x, y) in enumerate(points):
            scene.look_at(x + look_offset[0], y + look_offset[1], human=False)
            t_on = t_engine
            idle(dwell_s)
            dots.append({"id": first_id + i, "x": round(x, 2), "y": round(y, 2), "t_on": t_on, "t_off": t_engine, "pose_group": pose_group})
            idle(gap_s)
        return dots

    phases: list[dict[str, Any]] = []
    idle(0.5)
    phases.append({"name": "calibration", "dots": show(_grid(screen.width, screen.height, 3, 3), None)})
    pose_dots: list[dict[str, Any]] = []
    shifts = [np.array([0.045, 0.0, 0.0]), np.array([-0.04, 0.02, 0.05]), np.array([0.0, -0.025, -0.05])]
    for g in range(pose_groups):
        head_offset = shifts[g % len(shifts)]
        if problem != "headmove":
            scene.set_head(position=(base_head + head_offset).tolist())
        idle(0.5)
        pose_dots += show(_grid(screen.width, screen.height, 3, 2, margin=0.15), g + 1, first_id=100 * (g + 1))
    head_offset = np.zeros(3)
    if problem != "headmove":
        scene.set_head(position=base_head.tolist())
    phases.append({"name": "poses", "dots": pose_dots})
    idle(0.5)
    vrng = np.random.default_rng(seed + 1000)
    vpts = []
    for i in range(validate_n):  # a jittered 5x2 layout, never on the calibration grid
        c, r = i % 5, i // 5
        vpts.append((screen.width * (0.14 + 0.18 * c + vrng.uniform(-0.03, 0.03)), screen.height * (0.3 + 0.4 * (r % 2) + vrng.uniform(-0.05, 0.05))))
    off = (2.5 * pt_per_deg, 1.5 * pt_per_deg) if problem == "offset" else (0.0, 0.0)
    phases.append({"name": "validation", "dots": show(vpts, None, look_offset=off)})
    if pursuit_s > 0:
        samples = []
        t0 = t_engine
        for _ in range(int(round(pursuit_s * fps))):
            el = t_engine - t0
            x = (0.5 + 0.4 * math.sin(2 * math.pi * el / 6.0)) * screen.width
            y = (0.5 + 0.38 * math.sin(2 * math.pi * el / 4.0)) * screen.height
            scene.look_at(x, y, human=False)
            samples.append([round(t_engine, 4), round(x, 2), round(y, 2)])
            frame()
        phases.append({"name": "pursuit", "dots": [], "samples": samples})
    rec.close()
    manifest = {
        "format": "phonegaze-collect-1",
        "run_id": run_id,
        "condition": {"id": cond["id"], "label": cond["label"], "camera_id": cond["camera_id"], "camera_label": cond["camera_label"], "zoom": cond["zoom"], "settings": dict(cond.get("settings") or {}), "notes": f"synthetic; injected problem: {problem or 'none'}"},
        "screen": {"width_pt": screen.width, "height_pt": screen.height, "width_mm": screen.width_mm, "height_mm": screen.height_mm},
        "phases": phases,
        "started": "2026-11-17T09:00:00+00:00",
        "completed": True,
    }
    (folder / "collect.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return folder


def make_run(root: Path, run_id: str = "synth", conditions: list[dict[str, Any]] | None = None, **kwargs: Any) -> Path:
    """Every condition plus the run file; returns the run file's path."""
    root = Path(root)
    conds = conditions if conditions is not None else DEFAULT_CONDITIONS
    folders = [make_condition(root, run_id, c, **kwargs) for c in conds]
    runs = root / "collect-runs"
    runs.mkdir(parents=True, exist_ok=True)
    path = runs / f"{run_id}.json"
    recs = [{"condition_id": c["id"], "label": c["label"], "recording_id": f.name, "path": str(f), "quality": None, "poor": False} for c, f in zip(conds, folders)]
    path.write_text(json.dumps({"format": "phonegaze-collect-run-1", "run_id": run_id, "recordings": recs}, indent=2) + "\n")
    return path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    a = ap.parse_args()
    print(make_run(Path(a.out)))
