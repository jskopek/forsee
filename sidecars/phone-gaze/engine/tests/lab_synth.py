"""Synthetic tools/eye-capture sessions for the lab tests. Owner: Lab.

Writes a session folder in the exact eye-capture format (``meta.json``, ``events.jsonl`` and per
camera ``<name>.mov`` (HEVC through ffmpeg), ``<name>.frames.csv``, ``<name>.json``,
``<name>.motion.csv``), filmed by the simulator's renderer. Nothing here comes from a real
camera.

``render=False`` writes uniform grey frames instead (fast) and relies on the extra
``<name>.simtruth.jsonl`` (one simulator ground-truth block per row; synthetic sessions only),
which the lab feeds to the simulator's oracle estimator (combo ``sim_oracle``).

Command line, to look at one by hand::

    python tests/lab_synth.py OUT_DIR [--no-render] [--grid 3x3]
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

PHONE_T0 = 5000.0  # phone clock at scene time 0 (seconds since boot)
PAGE_OFFSET_S = 4321.0  # phone clock minus page clock (performance.now() / 1000)


def _grid(screen_w: float, screen_h: float, cols: int, rows: int, margin: float = 0.08) -> list[tuple[float, float, float, float]]:
    pts = []
    for r in range(rows):
        for c in range(cols):
            nx = margin + (1 - 2 * margin) * (c / max(1, cols - 1))
            ny = margin + (1 - 2 * margin) * (r / max(1, rows - 1))
            pts.append((nx, ny, nx * screen_w, ny * screen_h))
    return pts


def make_session(
    folder: Path,
    *,
    render: bool = True,
    grid: str = "3x3",
    fps: float = 10.0,
    dwell_s: float = 1.2,
    pursuit_s: float = 2.5,
    width: int = 1280,
    height: int = 720,
    zoom: float = 2.0,
    seed: int = 1,
    name: str = "back-wide-2x",
    distinct_per_dot: int = 2,
    write_truth: bool = True,
    pixel_noise: float = 2.0,
) -> Path:
    """Write a synthetic session into ``folder`` and return it."""
    from phonegaze.sim.scene import SimScene

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is needed to write the synthetic .mov")
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    scene = SimScene(seed=seed, camera="wide")
    scene.knobs.blink_rate_per_min = 0.0
    scene.knobs.pixel_noise = pixel_noise
    scene.set_camera(scene.camera_id, width, height, zoom)
    screen = scene.screen
    cols, rows_n = (int(v) for v in grid.split("x"))
    dots = _grid(screen.width, screen.height, cols, rows_n)
    dt = 1.0 / fps

    events: list[dict] = []
    frame_rows: list[list[float]] = []
    motion_rows: list[list[float]] = []
    truths: list[dict] = []
    images: list[np.ndarray | None] = []
    cache: dict = {}

    def phone_t() -> float:
        return PHONE_T0 + scene.t

    def ev(kind: str, **data) -> None:
        t = phone_t()
        events.append({"type": kind, "seg": name, "t_page": round((t - PAGE_OFFSET_S) * 1000.0, 3), "t_phone": t, **data})

    def shoot(key) -> None:
        cap = scene.capture()
        truth = cap.truth
        if render:
            if key not in cache:
                img = scene.render_part(cap, (0, 0, cap.width, cap.height), cap.width, cap.height, ss=1)
                cache[key] = img
            images.append(cache[key])
        else:
            images.append(None)
        g = scene.gravity_device()
        frame_rows.append([len(frame_rows), phone_t(), 0.62, 200.0, 1 / 120, 0.0, 0.0])
        motion_rows.append([phone_t(), *g, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        truths.append(truth)
        scene.step(dt)

    ev("segment_start", config={"slug": name, "zoom": zoom}, viewport={"width": screen.width, "height": screen.height})
    for _ in range(3):  # a little before the first dot
        shoot(("idle",))
    n_frames = int(round(dwell_s * fps))
    for order, (nx, ny, x, y) in enumerate(dots):
        scene.look_at(x, y, human=False)
        ev("target_on", order=order, index=order, x=round(x, 1), y=round(y, 1), nx=nx, ny=ny)
        for k in range(n_frames):
            shoot(("dot", order, k % max(1, distinct_per_dot)))
        ev("target_off", order=order, index=order)
    if pursuit_s > 0:
        ev("pursuit_start", durationMs=pursuit_s * 1000)
        samples = []
        n = int(round(pursuit_s * fps))
        start = scene.t
        for k in range(n):
            el = scene.t - start
            x = (0.5 + 0.42 * math.sin(2 * math.pi * el / 12.0)) * screen.width
            y = (0.5 + 0.42 * math.sin(2 * math.pi * el / 7.5)) * screen.height
            scene.look_at(x, y, human=False)
            samples.append([round((phone_t() - PAGE_OFFSET_S) * 1000.0, 1), round(x, 1), round(y, 1)])
            shoot(("pursuit", k // 2))
        ev("pursuit", columns=["t_page", "x", "y"], samples=samples)
        ev("pursuit_end")
    ev("segment_end", aborted=False)

    cap = scene.capture()
    K = cap.K_sensor
    info = {
        "segment": name,
        "label": "synthetic",
        "mode": "camera",
        "cameraId": scene.camera.id,
        "cameraName": scene.camera.name,
        "position": "back",
        "width": width,
        "height": height,
        "requestedFps": fps,
        "zoom": zoom,
        "fieldOfView": scene.camera.hfov_deg,
        "intrinsics": {"fx": K.fx, "fy": K.fy, "cx": K.cx, "cy": K.cy, "width": float(width), "height": float(height)},
        "gravityAtStart": motion_rows[0][1:4],
        "columns": ["frame", "t", "lens_position", "iso", "exposure_s", "adjusting_focus", "adjusting_exposure"],
        "framesWritten": len(frame_rows),
        "synthetic": True,
    }
    (folder / f"{name}.json").write_text(json.dumps(info, indent=2))
    with open(folder / f"{name}.frames.csv", "w") as f:
        f.write(",".join(info["columns"]) + "\n")
        for r in frame_rows:
            f.write(f"{int(r[0])},{r[1]:.6f}," + ",".join(f"{v:.9g}" for v in r[2:]) + "\n")
    with open(folder / f"{name}.motion.csv", "w") as f:
        f.write("t,gravity_x,gravity_y,gravity_z,rotation_x,rotation_y,rotation_z,accel_x,accel_y,accel_z\n")
        for r in motion_rows:
            f.write(",".join(f"{v:.6f}" for v in r) + "\n")
    if write_truth:
        with open(folder / f"{name}.simtruth.jsonl", "w") as f:
            for t in truths:
                f.write(json.dumps(t) + "\n")
    ppcm = screen.width / ((screen.width_mm or 302.4) / 10.0)
    meta = {
        "participant": "synthetic",
        "screenDiagonalInches": 14.2,
        "eyesToPhoneCm": 60,
        "protocol": {"columns": cols, "rows": rows_n, "dwellMs": dwell_s * 1000, "pursuitSeconds": pursuit_s},
        "cameras": [name],
        "screen": {"width": screen.width, "height": screen.height, "devicePixelRatio": 2, "viewportWidth": screen.width, "viewportHeight": screen.height, "fullscreen": True, "pixelsPerCm": ppcm},
        "synthetic": True,
    }
    (folder / "meta.json").write_text(json.dumps(meta, indent=2))
    with open(folder / "events.jsonl", "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    _write_hevc(folder / f"{name}.mov", images, width, height, fps)
    return folder


def make_recording(folder: Path, *, grid: str = "3x3", fps: float = 10.0, collect_s: float = 0.9, width: int = 640, height: int = 360, seed: int = 2, validate: int = 3) -> Path:
    """A Phone Gaze recording (``recorder.Recorder``: stream.pgz1, session.json, events.jsonl)
    with a grid calibration and a validation run, frames carrying the simulator's truth in
    ``header["sim"]`` and a small uniform ``wide`` part (no rendering)."""
    import cv2

    from phonegaze.protocol import Message
    from phonegaze.recorder import Recorder
    from phonegaze.sim.scene import SimScene

    scene = SimScene(seed=seed, camera="wide")
    scene.knobs.blink_rate_per_min = 0.0
    scene.set_camera(scene.camera_id, width, height, 2.0)
    screen = scene.screen
    rec = Recorder(Path(folder), {"screen": screen.to_dict(), "config": {"stream": {"rotation": "auto"}}})
    t_engine = 100.0
    seq = 0
    ok, jpg = cv2.imencode(".jpg", np.full((height // 4, width // 4, 3), 96, np.uint8))
    data = bytes(jpg)
    cols, rows_n = (int(v) for v in grid.split("x"))
    runs = [("r1", "grid", [(x, y) for _, _, x, y in _grid(screen.width, screen.height, cols, rows_n)])]
    rng = np.random.default_rng(seed)
    runs.append(("r2", "validate", [(float(rng.uniform(0.15, 0.85) * screen.width), float(rng.uniform(0.15, 0.85) * screen.height)) for _ in range(validate)]))

    def frame() -> None:
        nonlocal seq, t_engine
        cap = scene.capture()
        header = {
            "type": "frame", "seq": seq, "t": PHONE_T0 + scene.t, "mode": "camera", "camera": scene.camera_header(cap), "gravity": cap.gravity,
            "sim": cap.truth, "parts": [{"name": "wide", "kind": "wide", "format": "jpeg", "bytes": len(data), "width": width // 4, "height": height // 4, "rect": [0, 0, width, height]}],
        }
        rec.write_message(Message(header, [data]), t_engine)
        seq += 1
        t_engine += 1.0 / fps
        scene.step(1.0 / fps)

    for run_id, kind, pts in runs:
        rec.write_event({"type": "calib.start", "run_id": run_id, "kind": kind, "t_local": t_engine})
        for dot_id, (x, y) in enumerate(pts):
            scene.look_at(x, y, human=False)
            frame()
            rec.write_event({"type": "calib.dot", "run_id": run_id, "kind": kind, "dot_id": dot_id, "x": x, "y": y, "state": "collect", "t_local": t_engine})
            for _ in range(int(round(collect_s * fps))):
                frame()
            rec.write_event({"type": "calib.dot", "run_id": run_id, "kind": kind, "dot_id": dot_id, "x": x, "y": y, "state": "done", "t_local": t_engine})
        rec.write_event({"type": "calib.finish", "run_id": run_id, "kind": kind, "t_local": t_engine})
    rec.close()
    return Path(folder)


def hevc_available() -> bool:
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "libx265" in out


def _write_hevc(path: Path, images: list, width: int, height: int, fps: float) -> None:
    """HEVC .mov through ffmpeg (libx265), one video frame per CSV row, no rotation tag."""
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "frames.raw"
        grey = np.full((height, width, 3), 96, np.uint8)
        with open(raw, "wb") as f:
            for img in images:
                f.write((grey if img is None else img).tobytes())
        if hevc_available():
            codec = ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:crf=12", "-tag:v", "hvc1"]
        else:  # an ffmpeg without libx265 (some CI machines): still a .mov, just not HEVC
            codec = ["-c:v", "mpeg4", "-q:v", "2"]
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps), "-i", str(raw), *codec, "-pix_fmt", "yuv420p", str(path)]
        subprocess.run(cmd, check=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--no-render", action="store_true")
    ap.add_argument("--grid", default="3x3")
    ap.add_argument("--pursuit", type=float, default=2.5)
    a = ap.parse_args()
    print(make_session(Path(a.out), render=not a.no_render, grid=a.grid, pursuit_s=a.pursuit))
