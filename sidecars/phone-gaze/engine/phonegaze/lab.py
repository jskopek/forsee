"""The offline lab: score recorded sessions with the real estimators and every gaze model. Owner: Lab.

Real accuracy numbers before the live system works. Two kinds of input:

- **tools/eye-capture sessions** (``meta.json``, ``events.jsonl`` and per camera ``<name>.mov``,
  ``<name>.frames.csv``, ``<name>.json``, ``<name>.motion.csv``; format in
  ``tools/eye-capture/README.md``). Frame N of the video is row N of ``frames.csv``.
- **Phone Gaze recordings** (``stream.pgz1`` + ``events.jsonl`` from ``recorder.py``), which hold
  the live stream and the calibration dots shown while recording.

What it does, per camera recording ("segment") and per estimator combination (``lab.combos``):

1. Picks the frames inside each dot (after ``lab.settle_s``) and on the moving dot.
2. ``lab.frame_mode = "live"``: cuts each 4K video frame the way the phone stream would (a
   downscaled whole frame and native-resolution eye crops) so the scores describe the live
   engine. The cut frames are cached (``*.frames.pgz1``) with crops ``lab.cache_roi_mm`` wide, so
   later runs, other estimator settings and smaller crops never decode the video again.
3. Runs the estimators and caches every observation (``*.obs.jsonl.gz``, keyed by every setting
   that changes them), so refitting models costs no image work at all.
4. Fits every gaze model on the grid dots and scores it held out: leave-one-dot-out, and
   train-on-grid / test-on-the-moving-dot, in degrees, with failure counts.
5. Writes ``report.md``, ``report.html`` (tables and an error-by-screen-position chart) and
   ``result.json`` to ``lab.output_dir/<session>/``.

Command line (see :func:`main`)::

    python -m phonegaze lab SESSION [--segment NAME] [--combos default,landmarks] [--set path=value]
                                    [--preset NAME] [--images] [--no-cache] [--json]

Nothing here has seen real footage yet: it is tested on synthetic sessions written in the
eye-capture format by the simulator's renderer (``tests/lab_synth.py``).
"""

from __future__ import annotations

import argparse
import copy
import datetime as _dt
import gzip
import hashlib
import html
import json
import logging
import math
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .config import Config, ConfigError, EstimatorsConfig, load_config, settings, update
from .types import CalibSample, EyeObs, Frame, Observation, ScreenInfo, _jsonable

log = logging.getLogger(__name__)

LAB_VERSION = 1
"""Bump when cached frames or observations would change for the same settings."""

STREAM_FILE = "stream.pgz1"


class LabError(Exception):
    """A problem with the input, said in plain words (the command line prints it, no traceback)."""


# --------------------------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------------------------


@dataclass
class Dot:
    """One fixation target: where it was and when (in the segment's clock)."""

    dot_id: int
    x: float
    y: float
    t0: float
    t1: float
    kind: str = "grid"  # "grid" | "validate"


@dataclass
class Segment:
    """One camera recording of a session."""

    name: str
    source_kind: str  # "eye-capture" | "recording"
    folder: Path
    info: dict[str, Any]
    camera_type: str
    times: np.ndarray  # capture time of each row (phone clock; engine clock for recordings)
    columns: dict[str, np.ndarray] = field(default_factory=dict)
    gravity: np.ndarray | None = None  # (rows, 3)
    video: Path | None = None
    dots: list[Dot] = field(default_factory=list)
    pursuit: np.ndarray | None = None  # (n, 3): t, x, y
    distance_hint_m: float | None = None
    notes: list[str] = field(default_factory=list)
    settle_override_s: float | None = None
    truth: list[dict[str, Any]] | None = None  # synthetic sessions only (<name>.simtruth.jsonl)

    @property
    def n_rows(self) -> int:
        return len(self.times)


@dataclass
class Source:
    path: Path
    kind: str
    screen: ScreenInfo
    meta: dict[str, Any]
    segments: list[Segment]
    notes: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.path.name


def _read_json(path: Path, what: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise LabError(f"{what} is missing: {path}") from exc
    except (OSError, ValueError) as exc:
        raise LabError(f"cannot read {what} ({path}): {exc}") from exc


def _read_jsonl(path: Path) -> tuple[list[dict[str, Any]], int]:
    if not path.exists():
        return [], 0
    out, bad = [], 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            v = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if isinstance(v, dict):
            out.append(v)
        else:
            bad += 1
    return out, bad


def open_source(path: str | Path) -> Source:
    """Load a session folder (eye-capture) or a Phone Gaze recording. Raises :class:`LabError`
    with a plain explanation when it is neither."""
    p = Path(path).expanduser()
    if not p.exists():
        raise LabError(f"{p} does not exist. Give the session folder (for eye-capture: tools/eye-capture/captures/<session>).")
    if p.is_file():
        if p.suffix == ".pgz1" or p.name in ("meta.json", "events.jsonl", "session.json"):
            p = p.parent
        else:
            raise LabError(f"{p} is a file. Give the folder that holds it (the session folder).")
    if (p / "meta.json").exists():
        return _load_eye_capture(p)
    if (p / STREAM_FILE).exists():
        return _load_recording(p)
    subs = sorted(c.name for c in p.iterdir() if c.is_dir() and ((c / "meta.json").exists() or (c / STREAM_FILE).exists()))
    if subs:
        raise LabError(f"{p} holds several sessions; give one of them: " + ", ".join(subs[:20]) + (" ..." if len(subs) > 20 else ""))
    raise LabError(f"{p} is not a session: expected meta.json (tools/eye-capture) or {STREAM_FILE} (a Phone Gaze recording).")


def _camera_type(info: dict[str, Any], name: str) -> str:
    from .replay import _camera_type as ct

    return ct(info, name)


def _load_eye_capture(folder: Path) -> Source:
    from .replay import _nearest_rows, _read_csv, eye_capture_screen

    meta = _read_json(folder / "meta.json", "meta.json")
    if not isinstance(meta, dict):
        raise LabError(f"{folder / 'meta.json'} is not a JSON object")
    events, bad = _read_jsonl(folder / "events.jsonl")
    notes: list[str] = []
    if not (folder / "events.jsonl").exists():
        notes.append("events.jsonl is missing: no dots, so nothing can be scored")
    if bad:
        notes.append(f"events.jsonl: {bad} unreadable line(s) skipped")
    screen = eye_capture_screen(meta)
    if screen.width_mm is None:
        notes.append("meta.json has no screen.pixelsPerCm (screen diagonal not entered): errors are in points only, not degrees")
    dist_cm = meta.get("eyesToPhoneCm")
    hint = float(dist_cm) / 100.0 if isinstance(dist_cm, (int, float)) and dist_cm > 0 else None
    segments: list[Segment] = []
    for info_path in sorted(folder.glob("*.json")):
        if info_path.name == "meta.json":
            continue
        name = info_path.stem
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            notes.append(f"{info_path.name}: unreadable ({exc}); camera skipped")
            continue
        if not isinstance(info, dict):
            continue
        csv_path = folder / f"{name}.frames.csv"
        if not csv_path.exists():
            notes.append(f"{name}: {csv_path.name} is missing; camera skipped")
            continue
        try:
            cols, data = _read_csv(csv_path)
        except (OSError, ValueError) as exc:
            notes.append(f"{name}: cannot read {csv_path.name} ({exc}); camera skipped")
            continue
        if "t" not in cols or data.size == 0:
            notes.append(f"{name}: {csv_path.name} has no rows or no 't' column; camera skipped")
            continue
        columns = {c: data[:, i] for i, c in enumerate(cols)}
        seg_notes: list[str] = []
        video = next((folder / f"{name}{ext}" for ext in (".mov", ".MOV", ".mp4", ".m4v") if (folder / f"{name}{ext}").exists()), None)
        if video is None:
            seg_notes.append("no video file: only cached observations can be used")
        t = columns["t"]
        if np.any(np.diff(t) <= 0):
            seg_notes.append("frames.csv times do not always increase")
        gravity = None
        motion = folder / f"{name}.motion.csv"
        if motion.exists():
            try:
                mcols, mdata = _read_csv(motion)
                if mdata.size and {"t", "gravity_x", "gravity_y", "gravity_z"} <= set(mcols):
                    mc = {c: i for i, c in enumerate(mcols)}
                    mdata = mdata[np.argsort(mdata[:, mc["t"]])]
                    near = _nearest_rows(t, mdata[:, mc["t"]]) if len(mdata) > 1 else np.zeros(len(t), dtype=int)
                    gravity = mdata[near][:, [mc["gravity_x"], mc["gravity_y"], mc["gravity_z"]]]
            except (OSError, ValueError) as exc:
                seg_notes.append(f"motion.csv unreadable ({exc}); gravity from the start of the recording only")
        if gravity is None and isinstance(info.get("gravityAtStart"), list) and len(info["gravityAtStart"]) == 3:
            gravity = np.tile(np.array(info["gravityAtStart"], float), (len(t), 1))
        seg_name = str(info.get("segment", name))
        seg_events = [e for e in events if e.get("seg") == seg_name]
        dots = _eye_capture_dots(seg_events)
        pursuit = _eye_capture_pursuit(seg_events)
        if not dots:
            seg_notes.append("no dots for this camera in events.jsonl")
        elif len(t) and (dots[0].t0 > t[-1] or dots[-1].t1 < t[0]):
            seg_notes.append("the dots' times do not overlap the video's frame times (clock mismatch?)")
        truth = None
        truth_path = folder / f"{name}.simtruth.jsonl"
        if truth_path.exists():
            truth, _ = _read_jsonl(truth_path)
            seg_notes.append("synthetic session (simulator ground truth present)")
        segments.append(
            Segment(
                truth=truth,
                name=name,
                source_kind="eye-capture",
                folder=folder,
                info=info,
                camera_type=_camera_type(info, name),
                times=t,
                columns=columns,
                gravity=gravity,
                video=video,
                dots=dots,
                pursuit=pursuit,
                distance_hint_m=hint,
                notes=seg_notes,
            )
        )
    if not segments:
        notes.append("no camera recordings found (expected <camera>.json and <camera>.frames.csv)")
    return Source(path=folder, kind="eye-capture", screen=screen, meta=meta, segments=segments, notes=notes)


def _eye_capture_dots(events: list[dict[str, Any]]) -> list[Dot]:
    dots: list[Dot] = []
    pending: dict[Any, dict[str, Any]] = {}
    seen: dict[int, int] = {}
    for e in events:
        if e.get("type") == "target_on":
            pending[e.get("order")] = e
        elif e.get("type") == "target_off" and e.get("order") in pending:
            on = pending.pop(e.get("order"))
            try:
                idx = int(on.get("index", on.get("order", 0)))
                x, y, t0, t1 = float(on["x"]), float(on["y"]), float(on["t_phone"]), float(e["t_phone"])
            except (KeyError, TypeError, ValueError):
                continue
            rep = seen.get(idx, 0)
            seen[idx] = rep + 1
            dots.append(Dot(dot_id=idx + 1000 * rep, x=x, y=y, t0=t0, t1=t1))
    return sorted(dots, key=lambda d: d.t0)


def _eye_capture_pursuit(events: list[dict[str, Any]]) -> np.ndarray | None:
    """Moving-dot samples on the phone clock. Samples carry page time (ms); the offset to the
    phone clock is the median over this segment's events that carry both."""
    offs = [float(e["t_phone"]) - float(e["t_page"]) / 1000.0 for e in events if isinstance(e.get("t_phone"), (int, float)) and isinstance(e.get("t_page"), (int, float))]
    rows = []
    for e in events:
        if e.get("type") != "pursuit" or not isinstance(e.get("samples"), list):
            continue
        cols = e.get("columns") or ["t_page", "x", "y"]
        try:
            it, ix, iy = cols.index("t_page"), cols.index("x"), cols.index("y")
        except ValueError:
            continue
        for s in e["samples"]:
            try:
                rows.append((float(s[it]) / 1000.0, float(s[ix]), float(s[iy])))
            except (IndexError, TypeError, ValueError):
                continue
    if not rows or not offs:
        return None
    arr = np.array(sorted(rows), float)
    arr[:, 0] += float(np.median(offs))
    return arr


def _load_recording(folder: Path) -> Source:
    from .replay import _dot_windows, _session_screen, iter_messages, read_events, read_session

    session = read_session(folder)
    screen = _session_screen(session)
    events = read_events(folder)
    notes: list[str] = []
    if not session:
        notes.append("session.json is missing or unreadable: the screen size is a guess")
    by_cam: dict[str, list[tuple[int, float]]] = {}
    infos: dict[str, dict[str, Any]] = {}
    no_recv = 0
    try:
        for i, msg in enumerate(m for m in iter_messages(folder) if m.type == "frame"):
            h = msg.header
            cam = h.get("camera") or {}
            key = str(cam.get("id") or "camera")
            t = h.get("recv")
            if not isinstance(t, (int, float)):
                no_recv += 1
                t = h.get("t")
            if not isinstance(t, (int, float)):
                continue
            by_cam.setdefault(key, []).append((i, float(t)))
            infos.setdefault(key, {"camera": cam, "mode": h.get("mode")})
    except Exception as exc:  # noqa: BLE001 - a damaged stream file
        notes.append(f"{STREAM_FILE} is damaged after some frames ({exc}); using what could be read")
    if no_recv:
        notes.append(f"{no_recv} frame(s) have no receive time; their phone time was used, so dot matching may be off")
    windows = _dot_windows(events)
    segments: list[Segment] = []
    for key, rows in by_cam.items():
        idx = np.array([r[0] for r in rows], int)
        t = np.array([r[1] for r in rows], float)
        cam = infos[key]["camera"]
        name = f"{cam.get('position', 'cam')}-{cam.get('type', 'camera')}"
        if any(s.name == name for s in segments):
            name = f"{name}-{len(segments)}"
        dots, pursuit = [], []
        for uid, w in enumerate(windows):
            if not (t[0] - 1.0 <= w["t0"] <= t[-1] + 1.0):
                continue
            if w["kind"] == "pursuit":
                pursuit.append((w["t0"], w["x"], w["y"]))
            elif w["kind"] in ("grid", "validate"):
                dots.append(Dot(dot_id=int(w["dot_id"]) + 1000 * int(w.get("pose_group") or 0) + 100000 * (w["kind"] == "validate"), x=w["x"], y=w["y"], t0=w["t0"], t1=w["t1"], kind=w["kind"]))
        seg = Segment(
            name=name,
            source_kind="recording",
            folder=folder,
            info={"camera": cam, "mode": infos[key]["mode"], "stream_index": idx.tolist()},
            camera_type=str(cam.get("type", "wide")),
            times=t,
            dots=sorted(dots, key=lambda d: d.t0),
            pursuit=np.array(sorted(pursuit), float) if pursuit else None,
            settle_override_s=0.15,
        )
        if not dots:
            seg.notes.append("no calibration dots were recorded while this camera was running")
        segments.append(seg)
    if not segments:
        notes.append(f"{STREAM_FILE} holds no frames")
    return Source(path=folder, kind="recording", screen=screen, meta={"session": session}, segments=segments, notes=notes)


# --------------------------------------------------------------------------------------------
# Which frames, and what each one is for
# --------------------------------------------------------------------------------------------


@dataclass
class Want:
    kind: str  # "grid" | "validate" | "pursuit"
    dot_id: int
    x: float
    y: float


def wanted_rows(seg: Segment, cfg: Config) -> dict[int, Want]:
    """Row -> what it is for: frames inside the settled part of a dot, and frames on the moving
    dot (target taken ``lab.pursuit_lag_ms`` earlier). Every ``lab.every``-th row."""
    lab = cfg.lab
    settle = seg.settle_override_s if seg.settle_override_s is not None else lab.settle_s
    every = max(1, int(lab.every))
    t = seg.times
    out: dict[int, Want] = {}
    for d in seg.dots:
        rows = np.flatnonzero((t >= d.t0 + settle) & (t < d.t1))
        for r in rows:
            if r % every == 0:
                out[int(r)] = Want(d.kind, d.dot_id, d.x, d.y)
    if seg.pursuit is not None and len(seg.pursuit) >= 2:
        p = seg.pursuit
        start, end = p[0, 0] + lab.pursuit_skip_s, p[-1, 0]
        lag = lab.pursuit_lag_ms / 1000.0
        rows = np.flatnonzero((t >= start) & (t <= end))
        for r in rows:
            if r % every or int(r) in out:
                continue
            tq = t[r] - lag
            x = float(np.interp(tq, p[:, 0], p[:, 1]))
            y = float(np.interp(tq, p[:, 0], p[:, 2]))
            # Time bins of 0.5 s are the moving dot's "dots" (for precision and per-bin errors).
            out[int(r)] = Want("pursuit", 200000 + int((t[r] - start) / 0.5), x, y)
    return out


# --------------------------------------------------------------------------------------------
# Video decoding
# --------------------------------------------------------------------------------------------


_PASSTHROUGH: list[str] | None = None


def ffmpeg_passthrough() -> list[str]:
    """ffmpeg arguments that keep every frame of a variable-frame-rate video exactly once
    (``-fps_mode passthrough`` since ffmpeg 5.1, ``-vsync 0`` before)."""
    global _PASSTHROUGH
    if _PASSTHROUGH is None:
        try:
            help_text = subprocess.run(["ffmpeg", "-hide_banner", "-h", "long"], capture_output=True, text=True, timeout=30).stdout
        except (OSError, subprocess.SubprocessError):
            help_text = ""
        _PASSTHROUGH = ["-fps_mode", "passthrough"] if "-fps_mode" in help_text else ["-vsync", "0"]
    return list(_PASSTHROUGH)


def _video_rows(path: Path, rows: list[int], notes: list[str]) -> Iterator[tuple[int, np.ndarray]]:
    """BGR sensor-orientation images for the given rows (ascending). Frame N of the file is row
    N. OpenCV first (no auto-rotation), ffmpeg as a fallback (HEVC .mov, every frame kept)."""
    if not rows:
        return
    wanted = set(rows)
    last = max(rows)
    import cv2

    cap = cv2.VideoCapture(str(path))
    got_any = False
    i = 0
    try:
        if cap.isOpened():
            if hasattr(cv2, "CAP_PROP_ORIENTATION_AUTO"):
                cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0)
            while i <= last:
                if i in wanted:
                    ok, img = cap.read()
                    if not ok or img is None:
                        break
                    got_any = True
                    yield i, img
                else:
                    if not cap.grab():
                        break
                    got_any = True
                i += 1
    finally:
        cap.release()
    if got_any:
        if i <= last:
            notes.append(f"the video ended at frame {i} but frames.csv asks for frame {last}: the file is shorter than its CSV")
        return
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise LabError(f"cannot decode {path.name}: OpenCV cannot read it and ffmpeg is not installed (brew install ffmpeg)")
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout.strip().split(",")
        w, h = int(probe[0]), int(probe[1])
    except (subprocess.SubprocessError, ValueError, IndexError) as exc:
        raise LabError(f"cannot decode {path.name}: ffprobe could not read it ({exc}). Is the file complete?") from exc
    cmd = ["ffmpeg", "-v", "error", "-noautorotate", "-i", str(path), "-map", "0:v:0", *ffmpeg_passthrough(), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None
    size = w * h * 3
    i = 0
    try:
        while i <= last:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            if i in wanted:
                yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
            i += 1
    finally:
        proc.kill()
        proc.wait()
    if i == 0:
        raise LabError(f"cannot decode {path.name}: neither OpenCV nor ffmpeg read any frame from it")
    if i <= last:
        notes.append(f"the video ended at frame {i} but frames.csv asks for frame {last}")


def _eye_capture_header(seg: Segment, row: int, w: int, h: int) -> dict[str, Any]:
    """A PROTOCOL.md frame header for one eye-capture row (camera, lens, gravity, ARKit)."""
    from .replay import ARKIT_MATRICES, ARKIT_WIRE

    info = seg.info
    is_arkit = seg.camera_type == "arkit"
    intr = info.get("intrinsics") or {}
    cam: dict[str, Any] = {
        "id": info.get("cameraId", seg.name),
        "position": info.get("position", "front" if is_arkit else "back"),
        "type": seg.camera_type,
        "zoom": 1.0 if is_arkit else float(info.get("zoom") or 1.0),
        "width": w,
        "height": h,
        "intrinsicsSource": "arkit" if is_arkit else "attachment",
        "intrinsicsIncludeZoom": is_arkit,
    }
    if intr and all(isinstance(intr.get(k), (int, float)) for k in ("fx", "fy", "cx", "cy")):
        sx = w / float(intr.get("width") or w)
        sy = h / float(intr.get("height") or h)
        cam.update(fx=intr["fx"] * sx, fy=intr["fy"] * sy, cx=intr["cx"] * sx, cy=intr["cy"] * sy)
    if info.get("fieldOfView"):
        cam["fieldOfView"] = info["fieldOfView"]
    cols = seg.columns

    def val(name: str) -> float | None:
        c = cols.get(name)
        if c is None or row >= len(c):
            return None
        v = float(c[row])
        return v if math.isfinite(v) else None

    header: dict[str, Any] = {
        "type": "frame",
        "seq": row,
        "t": float(seg.times[row]),
        "mode": "arkit" if is_arkit else "camera",
        "camera": cam,
        "lens": {k: v for k, v in {"position": val("lens_position"), "iso": val("iso"), "exposureS": val("exposure_s")}.items() if v is not None},
    }
    if seg.truth is not None and row < len(seg.truth):
        header["sim"] = seg.truth[row]
    if seg.gravity is not None and row < len(seg.gravity) and np.all(np.isfinite(seg.gravity[row])):
        header["gravity"] = [float(v) for v in seg.gravity[row]]
    if is_arkit:
        ar: dict[str, Any] = {"tracked": bool(val("face_tracked") or 0)}
        for m in ARKIT_MATRICES:
            names = [f"{m}_c{c}r{r}" for c in range(4) for r in range(4)]
            if all(n in cols for n in names):
                values = [val(n) for n in names]
                ar[ARKIT_WIRE[m]] = None if any(v is None for v in values) else values
        look = [val(f"look_at_{a}") for a in "xyz"]
        ar["lookAt"] = None if any(v is None for v in look) else look
        ar["blendShapes"] = {c: val(c) for c in cols if (c.startswith("blink_") or (c.startswith("look_") and not c.startswith("look_at"))) and val(c) is not None}
        header["arkit"] = ar
    return header


def _jpeg(img: np.ndarray, quality: float) -> bytes:
    import cv2

    q = int(round(quality * 100)) if quality <= 1.0 else int(quality)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, max(10, min(100, q))])
    if not ok:
        raise LabError("JPEG encoding failed")
    return bytes(buf)


def _part(name: str, kind: str, img: np.ndarray, rect: tuple[float, float, float, float], quality: float) -> tuple[dict[str, Any], bytes]:
    data = _jpeg(img, quality)
    h, w = img.shape[:2]
    return {"name": name, "kind": kind, "format": "jpeg", "bytes": len(data), "width": w, "height": h, "rect": [float(v) for v in rect]}, data


def _frame(header: dict[str, Any], parts: list[tuple[dict[str, Any], bytes]]) -> Frame:
    from .protocol import Message

    h = dict(header)
    h["parts"] = [p[0] for p in parts]
    return Frame.from_message(Message(h, [p[1] for p in parts]), None)


# --------------------------------------------------------------------------------------------
# Live-like cutting: downscaled whole frame + eye crops, as the phone stream would send
# --------------------------------------------------------------------------------------------


class _Locator:
    """Finds the eyes on the downscaled whole frame (as the live engine places its crops from
    the previous observation). ARKit first when the segment has it, then face landmarks."""

    def __init__(self, cfg: Config, arkit: bool) -> None:
        from .vision import REGISTRY

        names = (["arkit"] if arkit else []) + ["landmarks"]
        self.estimators = [REGISTRY[n](cfg.estimators) for n in names if n in REGISTRY]
        self.last: dict[str, tuple[int, tuple[float, float]]] = {}
        self.last_distance: float | None = None

    def locate(self, frame: Frame, rotation: int, row: int) -> tuple[dict[str, tuple[float, float]], float | None, Observation]:
        from .pipeline import run_estimators
        from .types import DecodedFrame, apply_affine

        decoded = DecodedFrame.from_frame(frame, rotation)  # type: ignore[arg-type]
        obs = run_estimators(self.estimators, decoded)
        out: dict[str, tuple[float, float]] = {}
        inv = decoded.upright_to_sensor
        for side in ("left", "right"):
            c = obs.eye(side).iris_center
            if c is not None:
                s = apply_affine(inv, c)
                out[side] = (float(s[0]), float(s[1]))
                self.last[side] = (row, out[side])
            elif side in self.last and row - self.last[side][0] <= 10:
                out[side] = self.last[side][1]
        if obs.distance:
            self.last_distance = float(obs.distance)
        return out, obs.distance or self.last_distance, obs


def _cut_square(img: np.ndarray, centre: tuple[float, float], side: float) -> tuple[np.ndarray, tuple[float, float, float, float]] | None:
    h, w = img.shape[:2]
    s = int(round(min(side, w, h)))
    if s < 8:
        return None
    x0 = int(round(centre[0] - s / 2))
    y0 = int(round(centre[1] - s / 2))
    x0 = max(0, min(w - s, x0))
    y0 = max(0, min(h - s, y0))
    return img[y0 : y0 + s, x0 : x0 + s], (float(x0), float(y0), float(s), float(s))


def recut(frame: Frame, cfg: Config, rotation: int) -> Frame:
    """A cached live-like frame with its generous eye crops cut down to ``stream.roi_width_mm``
    x ``stream.roi_aspect`` (upright) around the same centre and re-encoded at
    ``stream.roi_quality``: the crop-size experiment without decoding the video again."""
    from .types import _decode_part

    lab = frame.header.get("lab") or {}
    px_per_mm = lab.get("px_per_mm")
    parts: list[tuple[dict[str, Any], bytes]] = []
    for p in frame.parts:
        if p.kind != "roi" or not px_per_mm:
            parts.append((p.descriptor(), p.data))
            continue
        img = _decode_part(p)
        if img is None:
            continue
        sx = p.width / p.rect[2]
        sy = p.height / p.rect[3]
        w_up = cfg.stream.roi_width_mm * px_per_mm
        h_up = w_up * cfg.stream.roi_aspect
        w_s, h_s = (h_up, w_up) if rotation in (90, 270) else (w_up, h_up)
        cx, cy = p.rect[0] + p.rect[2] / 2, p.rect[1] + p.rect[3] / 2
        x0 = max(p.rect[0], cx - w_s / 2)
        y0 = max(p.rect[1], cy - h_s / 2)
        x1 = min(p.rect[0] + p.rect[2], cx + w_s / 2)
        y1 = min(p.rect[1] + p.rect[3], cy + h_s / 2)
        ix0, iy0 = int(round((x0 - p.rect[0]) * sx)), int(round((y0 - p.rect[1]) * sy))
        ix1, iy1 = int(round((x1 - p.rect[0]) * sx)), int(round((y1 - p.rect[1]) * sy))
        if ix1 - ix0 < 8 or iy1 - iy0 < 8:
            continue
        sub = np.ascontiguousarray(img[iy0:iy1, ix0:ix1])
        rect = (p.rect[0] + ix0 / sx, p.rect[1] + iy0 / sy, (ix1 - ix0) / sx, (iy1 - iy0) / sy)
        parts.append(_part(p.name, "roi", sub, rect, cfg.stream.roi_quality))
    h = {k: v for k, v in frame.header.items() if k != "parts"}
    return _frame(h, parts)


# --------------------------------------------------------------------------------------------
# Rotation
# --------------------------------------------------------------------------------------------


def _gravity_rotation(seg: Segment, row: int, position: str) -> int:
    from .types import upright_rotation

    g = None
    if seg.gravity is not None and row < len(seg.gravity):
        g = tuple(float(v) for v in seg.gravity[row])
    return int(upright_rotation(g, position)) if g is not None else 0  # type: ignore[arg-type]


def detect_rotation(images: list[tuple[int, np.ndarray]], seg: Segment, cfg: Config) -> tuple[int | None, dict[str, Any]]:
    """Try all four rotations on a few frames; the one where face landmarks find a face most
    often wins (ties: the gravity rotation). ``None`` when no rotation finds a face."""
    from .pipeline import run_estimators
    from .types import DecodedFrame
    from .vision import REGISTRY

    if "landmarks" not in REGISTRY:
        return None, {"error": "no landmarks estimator"}
    scores: dict[int, int] = {}
    for rot in (0, 90, 180, 270):
        est = REGISTRY["landmarks"](cfg.estimators)
        n = 0
        for row, img in images:
            h, w = img.shape[:2]
            header = _header_for(seg, row, w, h)
            small = _downscale(img, cfg.stream.wide_width)
            frame = _frame(header, [_part("wide", "wide", small, (0, 0, w, h), 0.9)])
            try:
                est.reset()
            except Exception:  # noqa: BLE001
                pass
            obs = run_estimators([est], DecodedFrame.from_frame(frame, rot))  # type: ignore[arg-type]
            n += int(obs.face_rect is not None)
        close_estimators([est])
        scores[rot] = n
    best = max(scores.values()) if scores else 0
    if best == 0:
        return None, {"scores": scores}
    pos = str(seg.info.get("position") or (seg.info.get("camera") or {}).get("position") or "back")
    grav = _gravity_rotation(seg, images[0][0], pos)
    winners = [r for r, s in scores.items() if s == best]
    rot = grav if grav in winners else winners[0]
    return rot, {"scores": scores, "gravity_rotation": grav, "agrees_with_gravity": rot == grav}


def _downscale(img: np.ndarray, width: int) -> np.ndarray:
    import cv2

    h, w = img.shape[:2]
    if w <= width:
        return img
    return cv2.resize(img, (int(width), max(1, int(round(h * width / w)))), interpolation=cv2.INTER_AREA)


def _header_for(seg: Segment, row: int, w: int, h: int) -> dict[str, Any]:
    return _eye_capture_header(seg, row, w, h)


# --------------------------------------------------------------------------------------------
# Caches
# --------------------------------------------------------------------------------------------


def _hash(data: Any) -> str:
    return hashlib.sha1(json.dumps(_jsonable(data), sort_keys=True, default=str).encode()).hexdigest()[:12]


def _file_sig(p: Path | None) -> Any:
    if p is None or not p.exists():
        return None
    st = p.stat()
    return [p.name, st.st_size, int(st.st_mtime)]


def output_root(cfg: Config) -> Path:
    return Path(cfg.lab.output_dir).expanduser()


def session_dir(cfg: Config, source: Source) -> Path:
    tag = _hash(str(source.path.resolve()))[:6]
    return output_root(cfg) / f"{source.name}-{tag}"


def frames_key(seg: Segment, cfg: Config, rows: list[int]) -> dict[str, Any]:
    return {
        "v": LAB_VERSION,
        "segment": seg.name,
        "csv_rows": seg.n_rows,
        "mode": cfg.lab.frame_mode,
        "rotation": cfg.lab.rotation,
        "wide_width": cfg.stream.wide_width,
        "wide_quality": cfg.stream.wide_quality,
        "cache_roi_mm": cfg.lab.cache_roi_mm,
        "rows": _hash(rows),
        "landmarks": [cfg.estimators.landmarks_model],
    }


OBS_PATHS_PREFIX = ("estimators.", "stream.")
"""Settings that change observations (everything else only changes fitting and scoring)."""


def obs_key(seg: Segment, cfg: Config, combo: list[str], fkey: dict[str, Any]) -> dict[str, Any]:
    d = cfg.to_dict()
    return {"frames": fkey, "combo": combo, "estimators": d["estimators"], "stream": d["stream"], "stream_file": _file_sig(seg.folder / STREAM_FILE) if seg.source_kind == "recording" else None}


LAB_ESTIMATORS = ("sim_oracle",)
"""Estimators only the lab offers: ``sim_oracle`` reads the simulator's ground truth that
synthetic sessions carry (for testing the scoring without vision)."""


def make_estimators(names: list[str], cfg: Config) -> list[Any]:
    from .vision import REGISTRY, build_estimators

    out: list[Any] = []
    unknown = [n for n in names if n not in REGISTRY and n not in LAB_ESTIMATORS]
    if unknown:
        raise LabError(f"unknown estimator(s) {', '.join(unknown)}; known: {', '.join(list(REGISTRY) + list(LAB_ESTIMATORS))}")
    for n in names:
        if n == "sim_oracle":
            from .sim.oracle import OracleEstimator

            out.append(OracleEstimator())
        else:
            ecfg = EstimatorsConfig(**{**cfg.to_dict()["estimators"], "order": [n]})
            out.extend(build_estimators(ecfg))
    return out


def close_estimators(ests: list[Any]) -> None:
    """Release MediaPipe graphs now (their finalizers print errors at interpreter exit)."""
    for e in ests:
        lm = getattr(e, "_landmarker", None)
        if lm is not None:
            try:
                lm.close()
            except Exception:  # noqa: BLE001
                pass
            e._landmarker = None


def combo_estimators(name: str, cfg: Config) -> list[str]:
    if name in ("default", ""):
        return list(cfg.estimators.order)
    return [n.strip() for n in name.replace(",", "+").split("+") if n.strip()]


# --------------------------------------------------------------------------------------------
# Frames and observations
# --------------------------------------------------------------------------------------------


@dataclass
class Record:
    row: int
    t: float
    obs: Observation


@dataclass
class Collected:
    """Observations of one segment and estimator combination."""

    segment: str
    combo: str
    estimators: list[str]
    records: list[Record]
    want: dict[int, Want]
    stats: dict[str, Any] = field(default_factory=dict)


class FrameStore:
    """Live-like (or full) frames of one segment for the wanted rows, from the frame cache when
    it is complete, else from the video (writing the cache as it goes)."""

    def __init__(self, source: Source, seg: Segment, cfg: Config, rows: list[int], cache: bool = True) -> None:
        self.source, self.seg, self.cfg, self.rows = source, seg, cfg, rows
        self.cache = cache and cfg.lab.frame_mode == "live" and seg.source_kind == "eye-capture"
        self.key = frames_key(seg, cfg, rows)
        self.dir = session_dir(cfg, source) / "cache"
        self.path = self.dir / f"{seg.name}.{_hash(self.key)}.frames.pgz1"
        self.done = self.path.with_suffix(".done.json")
        self.info: dict[str, Any] = {}

    def cached(self) -> bool:
        """A complete cache for these settings, made from this video (when the video is still
        here: a replaced video invalidates it; a deleted one does not)."""
        if not (self.cache and self.path.exists() and self.done.exists()):
            return False
        if self.seg.video is not None:
            try:
                made_from = json.loads(self.done.read_text()).get("video")
            except (OSError, ValueError):
                return False
            if made_from is not None and made_from != _file_sig(self.seg.video):
                return False
        return True

    def frames(self) -> Iterator[tuple[int, Frame, int]]:
        """``(row, frame, rotation)``."""
        if self.seg.source_kind == "recording":
            yield from self._recording_frames()
            return
        if self.cached():
            self.info = json.loads(self.done.read_text())
            yield from self._read_cache()
            return
        if self.seg.video is None:
            raise LabError(f"{self.seg.name}: the video is missing and there is no frame cache for these settings")
        yield from self._decode()

    def _recording_frames(self) -> Iterator[tuple[int, Frame, int]]:
        from .lens import UprightTracker
        from .replay import iter_messages, read_session

        session = read_session(self.seg.folder)
        mode = str(((session.get("config") or {}).get("stream") or {}).get("rotation", "auto"))
        if self.cfg.lab.rotation in ("0", "90", "180", "270"):
            mode = self.cfg.lab.rotation
        upright = UprightTracker(mode)
        index = self.seg.info.get("stream_index") or []
        want = {int(index[r]): r for r in self.rows if r < len(index)}
        i = -1
        for msg in iter_messages(self.seg.folder):
            if msg.type != "frame":
                continue
            i += 1
            r = want.get(i)
            if r is None:
                continue
            try:
                frame = Frame.from_message(msg, msg.header.get("recv"))
            except (KeyError, TypeError, ValueError):
                continue
            rot = upright.update(frame.gravity, frame.camera.position)
            yield r, frame, int(rot)

    def _read_cache(self) -> Iterator[tuple[int, Frame, int]]:
        from .protocol import read_messages

        with open(self.path, "rb") as f:
            for msg in read_messages(f):
                lab = msg.header.get("lab") or {}
                try:
                    frame = Frame.from_message(msg, None)
                except (KeyError, TypeError, ValueError):
                    continue
                yield int(lab.get("row", frame.seq)), frame, int(lab.get("rotation", 0))

    def _decode(self) -> Iterator[tuple[int, Frame, int]]:
        from .lens import UprightTracker
        from .protocol import encode

        seg, cfg = self.seg, self.cfg
        notes: list[str] = []
        live = cfg.lab.frame_mode == "live"
        pos = str(seg.info.get("position") or ("front" if seg.camera_type == "arkit" else "back"))
        fixed: int | None = int(cfg.lab.rotation) if cfg.lab.rotation in ("0", "90", "180", "270") else None
        rot_info: dict[str, Any] = {"mode": cfg.lab.rotation}
        upright = UprightTracker("auto")
        locator = _Locator(cfg, seg.camera_type == "arkit") if live else None
        out = None
        if self.cache:
            self.dir.mkdir(parents=True, exist_ok=True)
            out = open(self.path.with_suffix(".tmp"), "wb")  # noqa: SIM115 - closed below
        n = 0
        located = 0
        completed = False
        pending: list[tuple[int, np.ndarray]] = []
        t0 = time.perf_counter()

        def emit(row: int, img: np.ndarray, rot: int) -> tuple[int, Frame, int]:
            nonlocal located
            h, w = img.shape[:2]
            header = _eye_capture_header(seg, row, w, h)
            if not live:
                frame = _frame(header, [_part("wide", "wide", img, (0, 0, w, h), 0.95)])
                return row, frame, rot
            small = _downscale(img, cfg.stream.wide_width)
            wide = _part("wide", "wide", small, (0, 0, w, h), cfg.stream.wide_quality)
            assert locator is not None
            centres, dist, _ = locator.locate(_frame(header, [wide]), rot, row)
            parts = [wide]
            px_per_mm = None
            fr = _frame(header, [wide])
            fx = fr.camera.intrinsics.fx if fr.camera.intrinsics else None
            d = dist or seg.distance_hint_m or 0.6
            if fx:
                px_per_mm = fx / (d * 1000.0)
            if centres and px_per_mm:
                located += 1
                side_px = cfg.lab.cache_roi_mm * px_per_mm
                for s, c in centres.items():
                    cut = _cut_square(img, c, side_px)
                    if cut is not None:
                        parts.append(_part(f"{s}_eye", "roi", cut[0], cut[1], 0.95))
            header = dict(header)
            header["lab"] = {"row": row, "rotation": rot, "px_per_mm": px_per_mm}
            frame = _frame(header, parts)
            if out is not None:
                out.write(encode(frame.header, [p.data for p in frame.parts]))
            return row, frame, rot

        try:
            for row, img in _video_rows(seg.video, self.rows, notes):  # type: ignore[arg-type]
                n += 1
                if fixed is None and cfg.lab.rotation == "detect":
                    pending.append((row, img))
                    if len(pending) < 4 and n < len(self.rows):
                        continue
                    rot, info = detect_rotation(pending, seg, cfg)
                    rot_info.update(info)
                    if rot is None:
                        rot = _gravity_rotation(seg, pending[0][0], pos)
                        rot_info["fallback"] = "no face found at any rotation in the first frames; using gravity"
                    fixed = rot
                    rot_info["rotation"] = rot
                    for r2, im2 in pending:
                        yield emit(r2, im2, rot)
                    pending = []
                    continue
                if fixed is not None:
                    rot = fixed
                else:
                    g = tuple(float(v) for v in seg.gravity[row]) if seg.gravity is not None and row < len(seg.gravity) else None
                    rot = int(upright.update(g, pos))  # type: ignore[arg-type]
                    rot_info["rotation"] = rot
                yield emit(row, img, rot)
            if pending and fixed is None:  # fewer frames than the detection wanted
                rot, info = detect_rotation(pending, seg, cfg)
                rot_info.update(info)
                fixed = rot if rot is not None else _gravity_rotation(seg, pending[0][0], pos)
                rot_info["rotation"] = fixed
            for r2, im2 in pending:
                yield emit(r2, im2, fixed or 0)
            pending = []
            completed = True
        finally:
            if out is not None:
                out.close()
            if locator is not None:
                close_estimators(locator.estimators)
        self.info = {"video": _file_sig(seg.video), "frames": n, "located": located, "rotation": rot_info, "notes": notes, "decode_s": time.perf_counter() - t0, "key": self.key}
        if out is not None and completed:
            self.path.with_suffix(".tmp").replace(self.path)
            self.done.write_text(json.dumps(_jsonable(self.info), indent=2))
        elif out is not None:
            self.path.with_suffix(".tmp").unlink(missing_ok=True)


def collect(source: Source, seg: Segment, cfg: Config, combos: list[str], use_cache: bool = True, images_dir: Path | None = None) -> tuple[list[Collected], dict[str, Any]]:
    """Observations for every combination, decoding frames at most once."""
    from .pipeline import run_estimators
    from .types import DecodedFrame

    want = wanted_rows(seg, cfg)
    rows = sorted(want)
    store = FrameStore(source, seg, cfg, rows, cache=use_cache)
    out: list[Collected] = []
    todo: list[tuple[str, list[str], Path, list[Any]]] = []
    for combo in combos:
        names = combo_estimators(combo, cfg)
        key = obs_key(seg, cfg, names, store.key)
        path = session_dir(cfg, source) / "cache" / f"{seg.name}.{_hash(key)}.obs.jsonl.gz"
        recs = _read_obs_cache(path) if use_cache else None
        if recs is not None:
            out.append(Collected(seg.name, combo, names, recs, want, {"cached": True}))
        else:
            ests = make_estimators(names, cfg)
            for e in ests:
                try:
                    e.reset()
                except Exception:  # noqa: BLE001
                    pass
            todo.append((combo, names, path, ests))
    if not rows:
        return [Collected(seg.name, c, combo_estimators(c, cfg), [], want, {"cached": False}) for c in combos], {"frames": 0}
    if todo:
        results: dict[str, list[Record]] = {c[0]: [] for c in todo}
        timing: dict[str, float] = {c[0]: 0.0 for c in todo}
        first_of_dot: set[int] = set()
        for row, frame, rot in store.frames():
            t = float(seg.times[row]) if row < len(seg.times) else float(frame.t)
            frame.t_received = t
            for combo, _names, _path, ests in todo:
                fr = recut(frame, cfg, rot) if (cfg.lab.frame_mode == "live" and seg.source_kind == "eye-capture") else frame
                decoded = DecodedFrame.from_frame(fr, rot)  # type: ignore[arg-type]
                t0 = time.perf_counter()
                obs = run_estimators(ests, decoded)
                timing[combo] += time.perf_counter() - t0
                obs.t_local = t
                results[combo].append(Record(row, t, obs))
                w = want.get(row)
                if images_dir is not None and w is not None and w.kind != "pursuit" and (w.dot_id, combo) not in first_of_dot:
                    first_of_dot.add((w.dot_id, combo))  # type: ignore[arg-type]
                    _save_eye_image(images_dir / seg.name / combo, w.dot_id, decoded, obs)
        for combo, names, path, ests in todo:
            close_estimators(ests)
            recs = results[combo]
            if use_cache:
                _write_obs_cache(path, recs)
            out.append(Collected(seg.name, combo, names, recs, want, {"cached": False, "estimator_s": timing[combo]}))
    order = {c: i for i, c in enumerate(combos)}
    out.sort(key=lambda c: order.get(c.combo, 0))
    return out, store.info


def _read_obs_cache(path: Path) -> list[Record] | None:
    if not path.exists():
        return None
    try:
        recs = []
        done = False
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                d = json.loads(line)
                if d.get("done"):
                    done = True
                    break
                recs.append(Record(int(d["row"]), float(d["t"]), Observation.from_dict(d["obs"])))
        return recs if done else None
    except (OSError, ValueError, KeyError, EOFError):
        return None


def _write_obs_cache(path: Path, recs: list[Record]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps({"row": r.row, "t": r.t, "obs": r.obs.to_dict()}) + "\n")
        f.write(json.dumps({"done": True, "n": len(recs)}) + "\n")
    tmp.replace(path)


def _save_eye_image(folder: Path, dot_id: int, decoded: Any, obs: Observation) -> None:
    """One annotated eye crop per dot (only with ``--images``): the crop each eye was fitted on,
    with the fitted iris ellipse in green and the iris centre."""
    import cv2

    folder.mkdir(parents=True, exist_ok=True)
    for side in ("left", "right"):
        im = decoded.images.get(f"{side}_eye") or decoded.wide
        if im is None:
            continue
        img = im.pixels.copy()
        eye = obs.eye(side)
        inv = np.linalg.inv(im.to_full)
        if eye.iris_ellipse is not None:
            cx, cy, a, b, ang = eye.iris_ellipse
            p = inv @ np.array([cx, cy, 1.0])
            s = math.hypot(inv[0, 0], inv[0, 1])
            cv2.ellipse(img, ((float(p[0]) - 0.5, float(p[1]) - 0.5), (2 * a * s, 2 * b * s), ang), (0, 255, 0), 1)
        if eye.iris_center is not None:
            p = inv @ np.array([eye.iris_center[0], eye.iris_center[1], 1.0])
            cv2.drawMarker(img, (int(p[0]), int(p[1])), (0, 0, 255), cv2.MARKER_CROSS, 8, 1)
        cv2.imwrite(str(folder / f"dot{dot_id:05d}-{side}.png"), img)


# --------------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------------


def _blank_eye(obs: Observation, keep: str) -> Observation:
    o = copy.copy(obs)
    if keep == "left":
        o.right = EyeObs()
    elif keep == "right":
        o.left = EyeObs()
    return o


def prepared_samples(col: Collected, seg: Segment, cfg: Config) -> dict[str, Any]:
    """Cleaned calibration samples (grid), validation samples and the moving-dot samples, plus
    failure counts. Dots are cleaned exactly as live calibration does (:func:`clean_dot`)."""
    from .calibration import clean_dot

    fails = {"frames": 0, "face_not_found": 0, "eyes_not_found": 0, "iris_not_found": 0, "iris_edge_failed": 0, "reflection_not_found": 0, "blink": 0, "distance_missing": 0, "distance_from_form": 0}
    by_dot: dict[int, list[Observation]] = {}
    dot_info: dict[int, Want] = {}
    pursuit: list[CalibSample] = []
    has_iris_edge = "iris_edge" in col.estimators
    has_refl = "reflection" in col.estimators
    for rec in col.records:
        w = col.want.get(rec.row)
        if w is None:
            continue
        obs = rec.obs
        fails["frames"] += 1
        if obs.face_rect is None and not (obs.left.found or obs.right.found):
            fails["face_not_found"] += 1
        if not (obs.left.found or obs.right.found):
            fails["eyes_not_found"] += 1
        elif all(obs.eye(s).iris_center is None for s in ("left", "right")):
            fails["iris_not_found"] += 1
        if has_iris_edge and (obs.left.found or obs.right.found) and not any(obs.provenance.get(f"{s}.iris_center") == "iris_edge" for s in ("left", "right")):
            fails["iris_edge_failed"] += 1
        if has_refl and (obs.left.found or obs.right.found) and all(obs.eye(s).reflection_center is None for s in ("left", "right")):
            fails["reflection_not_found"] += 1
        if obs.left.blink and obs.right.blink:
            fails["blink"] += 1
        if cfg.lab.eye != "both":
            obs = _blank_eye(obs, cfg.lab.eye)
        if not obs.distance:
            if cfg.lab.distance_fallback and seg.distance_hint_m:
                obs = copy.copy(obs)
                obs.distance = seg.distance_hint_m
                fails["distance_from_form"] += 1
            else:
                fails["distance_missing"] += 1
        if w.kind == "pursuit":
            pursuit.append(CalibSample(target=(w.x, w.y), obs=obs, kind="validate", dot_id=w.dot_id, run_id="pursuit", t_local=rec.t))
        else:
            by_dot.setdefault(w.dot_id, []).append(obs)
            dot_info[w.dot_id] = w
    grid: list[CalibSample] = []
    validate: list[CalibSample] = []
    rejected: list[dict[str, Any]] = []
    for dot_id, obs_list in by_dot.items():
        w = dot_info[dot_id]
        cal = cfg.calibration  # same rules as live calibration (min_samples, stability_deg when present)
        kept, reason = clean_dot(obs_list, cal.outlier_mad, int(getattr(cal, "min_samples", 4)), float(getattr(cal, "stability_deg", 3.0)))
        if reason:
            rejected.append({"dot_id": dot_id, "target": [w.x, w.y], "n": len(obs_list), "reason": reason})
            continue
        for o in kept:
            s = CalibSample(target=(w.x, w.y), obs=o, kind="validate" if w.kind == "validate" else "grid", dot_id=dot_id, run_id=seg.name, pose_group=(dot_id // 1000) % 100, t_local=o.t_local)
            (validate if w.kind == "validate" else grid).append(s)
    return {"grid": grid, "validate": validate, "pursuit": pursuit, "failures": fails, "rejected": rejected, "n_dots": len(by_dot)}


def loo_by_model(result: Any, grid: list[CalibSample], screen: ScreenInfo) -> dict[str, np.ndarray]:
    """Leave-one-dot-out predictions for every fitted model (``N x 2``, raw)."""
    from .models.base import BaseModel, fit_samples, loo_predictions
    from .models.blend import BlendModel

    train = fit_samples(grid)
    out: dict[str, np.ndarray] = {}
    ok = {r.model for r in result.reports if r.ok}
    for name, m in result.models.items():
        if name in ok and isinstance(m, BaseModel) and not isinstance(m, BlendModel):
            out[name] = loo_predictions(m, train, screen)
    for name, m in result.models.items():
        if name in ok and isinstance(m, BlendModel):
            out[name] = m.loo_from_members(out, train)
    return out


def apply_filter(pred: np.ndarray, samples: list[CalibSample], cfg: Config, screen: ScreenInfo, reset_per_dot: bool = True) -> np.ndarray:
    """Run ``filters.*`` over predictions in time order, as the live output would. With
    ``reset_per_dot`` the filter restarts at each fixation dot: the lab has no frames of the eyes
    travelling between dots, so this scores the filter's steady state, not its reaction."""
    from .filters import build_filter
    from .types import GazePoint

    f = build_filter(cfg.filters, screen)
    order = sorted(range(len(samples)), key=lambda i: samples[i].t_local or 0.0)
    out = np.full_like(pred, np.nan)
    last_dot = None
    for i in order:
        s = samples[i]
        if reset_per_dot and s.dot_id != last_dot:
            f.reset()
            last_dot = s.dot_id
        t = float(s.t_local or 0.0)
        p = None
        if np.all(np.isfinite(pred[i])):
            p = GazePoint(x=float(pred[i, 0]), y=float(pred[i, 1]), t=t, confidence=1.0, valid=True, t_local=t)
        try:
            q = f.update(p, s.obs)
        except Exception:  # noqa: BLE001 - a filter bug must not stop scoring
            q = p
        if q is not None and q.valid:
            out[i] = (q.x, q.y)
    return out


def score_samples(prep: dict[str, Any], screen: ScreenInfo, cfg: Config, want_loo: bool = True) -> dict[str, Any]:
    """Fit every model on the grid samples and score it held out. Returns per model:
    ``loo_deg`` (error of each dot's mean, averaged), ``loo_sample_deg`` (per frame, after the
    filter), ``precision_deg``, ``pursuit_deg`` (train on grid, filtered moving-dot error),
    ``validate_deg``, ``coverage``, and ``per_dot`` held-out details for charts and A/B tests."""
    from . import calibration as calib
    from .models import build_models
    from .models.base import error_stats

    grid = prep["grid"]
    out: dict[str, Any] = {"n_grid_dots": len({s.dot_id for s in grid}), "n_grid_samples": len(grid), "models": {}, "chosen": None}
    if out["n_grid_dots"] < 4:
        out["message"] = f"only {out['n_grid_dots']} usable dot(s): need at least 4 to fit and hold one out"
        return out
    models = build_models(cfg.models)
    try:
        result = calib.fit_all(grid, screen, models)
    except Exception as exc:  # noqa: BLE001
        out["message"] = f"fitting failed: {exc}"
        return out
    out["chosen"] = result.chosen
    loo = loo_by_model(result, grid, screen) if want_loo else {}
    for rep in result.reports:
        name = rep.model
        entry: dict[str, Any] = {"ok": rep.ok, "message": rep.message, "loo_deg": rep.loo_error_deg, "loo_pt": rep.loo_error_pt, "train_deg": rep.train_error_deg, "precision_deg": rep.precision_deg, "coverage": (rep.params or {}).get("loo_coverage")}
        out["models"][name] = entry
        if not rep.ok:
            continue
        model = result.models[name]
        if name in loo:
            st = error_stats(grid, loo[name], screen, None)
            entry["per_dot"] = [{"dot_id": d["dot_id"], "target": d["target"], "mean": d["mean"], "error_deg": d["error_deg"], "error_pt": d["error_pt"], "n": d["n"]} for d in st["per_dot"]]
            filt = apply_filter(loo[name], grid, cfg, screen)
            fs = error_stats(grid, filt, screen, None)
            entry["loo_sample_deg"] = fs["error_deg"]
            entry["loo_sample_pt"] = fs["error_pt"]
            entry["loo_sample_raw_deg"] = st["error_deg"]
            entry["filtered_precision_deg"] = fs["precision_deg"]
        for key, samples in (("pursuit", prep["pursuit"]), ("validate", prep["validate"])):
            if not samples:
                continue
            try:
                pred = model.predict_samples(samples) if hasattr(model, "predict_samples") else np.array([[np.nan, np.nan]] * len(samples))
            except Exception:  # noqa: BLE001
                continue
            raw = error_stats(samples, pred, screen, None)
            filt = apply_filter(pred, samples, cfg, screen, reset_per_dot=key != "pursuit")
            fs = error_stats(samples, filt, screen, None)
            entry[f"{key}_deg"] = fs["error_deg"]
            entry[f"{key}_pt"] = fs["error_pt"]
            entry[f"{key}_raw_deg"] = raw["error_deg"]
            entry[f"{key}_coverage"] = raw["n_valid"] / max(raw["n"], 1)
            if key == "pursuit":
                entry["pursuit_bins"] = [{"target": d["target"], "mean": d["mean"], "error_deg": d["error_deg"]} for d in fs["per_dot"]]
    return out


def evaluate(col: Collected, seg: Segment, screen: ScreenInfo, cfg: Config) -> dict[str, Any]:
    prep = prepared_samples(col, seg, cfg)
    res = score_samples(prep, screen, cfg)
    res["failures"] = prep["failures"]
    res["rejected_dots"] = prep["rejected"]
    res["n_dots_seen"] = prep["n_dots"]
    res["n_pursuit_samples"] = len(prep["pursuit"])
    res["combo"] = col.combo
    res["estimators"] = col.estimators
    res["stats"] = col.stats
    return res


def metric_value(entry: dict[str, Any], metric: str) -> float | None:
    key = {"loo": "loo_deg", "loo_sample": "loo_sample_deg", "pursuit": "pursuit_deg"}.get(metric, "loo_deg")
    v = entry.get(key)
    if v is None and metric in ("loo", "loo_sample", "pursuit"):
        v = entry.get(key.replace("_deg", "_pt"))
    return None if v is None else float(v)


# --------------------------------------------------------------------------------------------
# Config, presets
# --------------------------------------------------------------------------------------------


def parse_value(text: str) -> Any:
    """A command-line value: JSON when it parses (numbers, true/false, lists), else the text."""
    try:
        return json.loads(text)
    except ValueError:
        return text


def presets_dir(cfg: Config) -> Path:
    return output_root(cfg) / "presets"


def load_preset(name_or_path: str, cfg: Config) -> dict[str, Any]:
    p = Path(name_or_path).expanduser()
    if not p.suffix:
        p = presets_dir(cfg) / f"{name_or_path}.json"
    if not p.exists():
        have = sorted(x.stem for x in presets_dir(cfg).glob("*.json")) if presets_dir(cfg).exists() else []
        raise LabError(f"no preset {name_or_path!r} ({p})." + (f" Presets: {', '.join(have)}" if have else " Make one with: python -m phonegaze tune SESSION --save NAME"))
    data = _read_json(p, f"preset {name_or_path}")
    if not isinstance(data, dict) or not isinstance(data.get("changes", {}), dict):
        raise LabError(f"{p} is not a preset (expected {{\"changes\": {{path: value}}}})")
    data.setdefault("name", p.stem)
    data.setdefault("changes", {})
    return data


def save_preset(cfg: Config, name: str, changes: dict[str, Any], **extra: Any) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_." else "-" for c in name).strip("-.") or "preset"
    d = presets_dir(cfg)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{safe}.json"
    data = {"name": safe, "changes": changes, "created": _dt.datetime.now().isoformat(timespec="seconds"), **extra}
    p.write_text(json.dumps(_jsonable(data), indent=2) + "\n")
    return p


_KNOWN: set[str] | None = None


def _known_paths() -> set[str]:
    global _KNOWN
    if _KNOWN is None:
        _KNOWN = {s.path for s in settings()}
    return _KNOWN


def apply_changes(cfg: Config, changes: dict[str, Any]) -> Config:
    """A copy of ``cfg`` with ``changes``; unknown paths or bad values raise :class:`LabError`."""
    new = copy.deepcopy(cfg)  # (Config.from_dict re-validates every setting: slow)
    known = _known_paths()
    unknown = [p for p in changes if p not in known]
    if unknown:
        raise LabError("unknown setting(s): " + ", ".join(unknown) + ". See the Experiments page or phonegaze/config.py for names.")
    errors = update(new, changes)
    if errors:
        raise LabError("; ".join(errors.values()))
    return new


def build_config(config_path: str | None, preset: str | None, sets: list[str] | None) -> tuple[Config, dict[str, Any]]:
    from .config import DEFAULT_PATH

    try:
        cfg = load_config(Path(config_path).expanduser() if config_path else DEFAULT_PATH)
    except ConfigError as exc:
        raise LabError(f"cannot read the config: {exc}") from exc
    changes: dict[str, Any] = {}
    if preset:
        changes.update(load_preset(preset, cfg)["changes"])
    for s in sets or []:
        if "=" not in s:
            raise LabError(f"--set expects path=value, got {s!r}")
        k, v = s.split("=", 1)
        changes[k.strip()] = parse_value(v.strip())
    return (apply_changes(cfg, changes) if changes else cfg), changes


# --------------------------------------------------------------------------------------------
# The lab run
# --------------------------------------------------------------------------------------------


def run_lab(source: Source, cfg: Config, *, segment: str | None = None, combos: list[str] | None = None, use_cache: bool = True, images: bool = False, progress: Any = None) -> dict[str, Any]:
    combos = combos or list(cfg.lab.combos) or ["default"]
    out_dir = session_dir(cfg, source)
    result: dict[str, Any] = {
        "session": str(source.path),
        "kind": source.kind,
        "screen": source.screen.to_dict(),
        "created": _dt.datetime.now().isoformat(timespec="seconds"),
        "notes": list(source.notes),
        "settings": {k: v for k, v in cfg.to_dict().items() if k in ("lab", "estimators", "models", "calibration", "filters", "stream")},
        "cameras": {},
        "output_dir": str(out_dir),
    }
    segs = [s for s in source.segments if segment is None or s.name == segment]
    if segment is not None and not segs:
        raise LabError(f"no camera {segment!r} in this session; cameras: {', '.join(s.name for s in source.segments) or 'none'}")
    for seg in segs:
        entry: dict[str, Any] = {"camera_type": seg.camera_type, "rows": seg.n_rows, "dots": len(seg.dots), "pursuit": seg.pursuit is not None, "notes": list(seg.notes), "combos": {}}
        result["cameras"][seg.name] = entry
        if progress:
            progress(f"{seg.name}: {len(seg.dots)} dots, {seg.n_rows} frames")
        if not seg.dots:
            continue
        try:
            cols, finfo = collect(source, seg, cfg, combos, use_cache=use_cache, images_dir=(out_dir / "eye-images") if images else None)
        except LabError as exc:
            entry["notes"].append(str(exc))
            continue
        entry["frames"] = _jsonable(finfo)
        for n in finfo.get("notes", []) if isinstance(finfo, dict) else []:
            entry["notes"].append(n)
        for col in cols:
            entry["combos"][col.combo] = evaluate(col, seg, source.screen, cfg)
            if progress:
                ch = entry["combos"][col.combo].get("chosen")
                m = entry["combos"][col.combo]["models"].get(ch) or {}
                progress(f"  {col.combo}: chosen {ch} {_fmt(m.get('loo_deg'))} deg leave-one-dot-out")
    result["best"] = best_rows(result)
    return _jsonable(result)


def best_rows(result: dict[str, Any], metric: str = "loo") -> list[dict[str, Any]]:
    rows = []
    for cam, entry in result.get("cameras", {}).items():
        best = None
        for combo, r in entry.get("combos", {}).items():
            for model, m in r.get("models", {}).items():
                v = metric_value(m, metric) if m.get("ok") else None
                if v is not None and (best is None or v < best["value"]):
                    best = {"camera": cam, "combo": combo, "model": model, "value": v, "metric": metric}
        if best:
            rows.append(best)
    return rows


# --------------------------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------------------------


def _fmt(v: Any, nd: int = 2) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


TABLE_COLS = [
    ("model", "Model"),
    ("loo_deg", "Held-out dot error (deg)"),
    ("loo_sample_deg", "Held-out frame error (deg)"),
    ("precision_deg", "Precision (deg)"),
    ("pursuit_deg", "Moving dot (deg)"),
    ("validate_deg", "Validation (deg)"),
    ("coverage", "Coverage"),
]


def _model_rows(r: dict[str, Any]) -> list[list[str]]:
    rows = []
    for name, m in r.get("models", {}).items():
        if not m.get("ok"):
            rows.append([name + " (failed)", m.get("message") or "", "", "", "", "", ""])
            continue
        mark = " (chosen)" if name == r.get("chosen") else ""
        rows.append([name + mark] + [_fmt(m.get(k)) if k != "coverage" else (f"{m['coverage']:.0%}" if isinstance(m.get("coverage"), (int, float)) else "-") for k, _ in TABLE_COLS[1:]])
    return rows


def _fail_line(f: dict[str, Any]) -> str:
    n = max(1, f.get("frames", 0))
    parts = [f"{f.get('frames', 0)} frames"]
    for k, label in (("face_not_found", "face not found"), ("eyes_not_found", "eyes not found"), ("iris_not_found", "iris not found"), ("iris_edge_failed", "iris edge fit failed"), ("reflection_not_found", "reflection not found"), ("blink", "blinks"), ("distance_from_form", "distance from the form"), ("distance_missing", "no distance")):
        if f.get(k):
            parts.append(f"{label} {f[k]} ({f[k] / n:.0%})")
    return ", ".join(parts)


def write_markdown(result: dict[str, Any]) -> str:
    lines = [f"# Lab report: {Path(result['session']).name}", "", f"Session `{result['session']}` ({result['kind']}), made {result['created']}.", ""]
    lines += [
        "Held-out dot error: each dot predicted by models fitted without it (leave-one-dot-out), error of the dot's mean prediction, averaged over dots. "
        "Held-out frame error: the same per frame after the smoothing filter. Precision: frame-to-frame noise on the fitted dots. "
        "Moving dot: fitted on the grid, scored on the moving dot after the filter. Degrees use the measured eye distance.",
        "",
    ]
    for n in result.get("notes", []):
        lines.append(f"- Note: {n}")
    if result.get("best"):
        lines += ["", "## Best per camera", "", "| Camera | Estimators | Model | Held-out dot error (deg) |", "| --- | --- | --- | --- |"]
        for b in result["best"]:
            lines.append(f"| {b['camera']} | {b['combo']} | {b['model']} | {_fmt(b['value'])} |")
    for cam, entry in result.get("cameras", {}).items():
        lines += ["", f"## {cam}", "", f"{entry.get('camera_type')} camera, {entry.get('dots')} dots, {entry.get('rows')} video frames."]
        rot = ((entry.get("frames") or {}).get("rotation") or {}) if isinstance(entry.get("frames"), dict) else {}
        if rot.get("rotation") is not None:
            agree = rot.get("agrees_with_gravity")
            extra = "" if agree is None else (" (gravity agrees)" if agree else f" (gravity says {rot.get('gravity_rotation')}: the sensor-axis table in types.py may be wrong for this phone)")
            lines.append(f"Upright rotation {rot['rotation']} deg ({rot.get('mode')}){extra}.")
        for n in entry.get("notes", []):
            lines.append(f"- Note: {n}")
        for combo, r in entry.get("combos", {}).items():
            lines += ["", f"### Estimators: {combo} ({' + '.join(r.get('estimators', []))})", ""]
            lines.append(f"Failures: {_fail_line(r.get('failures', {}))}.")
            if r.get("rejected_dots"):
                lines.append(f"Dots rejected by cleaning: {len(r['rejected_dots'])} of {r.get('n_dots_seen')} (" + "; ".join(sorted({d['reason'] for d in r['rejected_dots']})) + ").")
            if r.get("message"):
                lines.append(f"Not scored: {r['message']}.")
                continue
            lines += ["", "| " + " | ".join(c[1] for c in TABLE_COLS) + " |", "| " + " | ".join("---" for _ in TABLE_COLS) + " |"]
            for row in _model_rows(r):
                lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    return "\n".join(lines)


def _svg_chart(r: dict[str, Any], screen: dict[str, Any], model: str) -> str:
    """Error by screen position: each dot's target, an arrow to its held-out mean prediction,
    coloured by error; the moving dot's bins as small marks."""
    m = (r.get("models") or {}).get(model) or {}
    per_dot = m.get("per_dot") or []
    W, H = float(screen.get("width") or 1440), float(screen.get("height") or 900)
    vw = 640.0
    k = vw / W
    vh = H * k
    errs = [d["error_deg"] if d.get("error_deg") is not None else d.get("error_pt") for d in per_dot]
    finite = [e for e in errs if e is not None]
    top = max(finite) if finite else 1.0
    out = [f'<svg viewBox="-10 -10 {vw + 20:.0f} {vh + 20:.0f}" role="img" aria-label="Error by screen position for {html.escape(model)}" class="chart">']
    out.append(f'<rect x="0" y="0" width="{vw:.1f}" height="{vh:.1f}" class="screen"/>')
    for b in m.get("pursuit_bins") or []:
        if b.get("mean") is None:
            continue
        tx, ty = b["target"][0] * k, b["target"][1] * k
        px, py = b["mean"][0] * k, b["mean"][1] * k
        out.append(f'<line x1="{tx:.1f}" y1="{ty:.1f}" x2="{px:.1f}" y2="{py:.1f}" class="pursuit"/>')
    for d, e in zip(per_dot, errs):
        tx, ty = d["target"][0] * k, d["target"][1] * k
        frac = 0.0 if e is None else min(1.0, e / max(top, 1e-9))
        cls = "bad" if frac > 0.66 else "mid" if frac > 0.33 else "good"
        if d.get("mean") is not None:
            px, py = d["mean"][0] * k, d["mean"][1] * k
            out.append(f'<line x1="{tx:.1f}" y1="{ty:.1f}" x2="{px:.1f}" y2="{py:.1f}" class="arrow {cls}"/>')
            out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3" class="pred {cls}"/>')
        out.append(f'<circle cx="{tx:.1f}" cy="{ty:.1f}" r="7" class="target {cls}"><title>dot {d["dot_id"]}: {_fmt(e)}</title></circle>')
        out.append(f'<text x="{tx + 9:.1f}" y="{ty - 9:.1f}" class="label">{_fmt(e, 1)}</text>')
    out.append("</svg>")
    return "".join(out)


HTML_STYLE = """
:root { --bg: #fbfbfa; --fg: #1d1d1f; --muted: #6b6b70; --line: #d8d8dc; --card: #ffffff;
  --good: #1f8a4c; --mid: #b7791f; --bad: #c53030; --pursuit: #7f7fbf; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #161618; --fg: #ececf0;
  --muted: #a0a0a8; --line: #3a3a40; --card: #1f1f23; --good: #48bb78; --mid: #ecc94b; --bad: #fc8181; --pursuit: #a3a3e0; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; }
main { max-width: 1000px; margin: 0 auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
.wrap { overflow-x: auto; }
.muted { color: var(--muted); }
.chart { width: 100%; max-width: 640px; background: var(--card); }
.chart .screen { fill: none; stroke: var(--line); }
.chart .target { fill: none; stroke-width: 2; }
.chart .good { stroke: var(--good); fill: var(--good); }
.chart .mid { stroke: var(--mid); fill: var(--mid); }
.chart .bad { stroke: var(--bad); fill: var(--bad); }
.chart circle.target { fill: none; }
.chart .arrow { stroke-width: 1.5; }
.chart .pursuit { stroke: var(--pursuit); stroke-width: 1; }
.chart .label { fill: var(--muted); font-size: 11px; }
"""


def write_html(result: dict[str, Any]) -> str:
    esc = html.escape
    title = f"Lab report: {Path(result['session']).name}"
    parts = [f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{esc(title)}</title><style>{HTML_STYLE}</style></head><body><main>"]
    parts.append(f"<h1>{esc(title)}</h1><p class=\"muted\">{esc(result['session'])} ({esc(result['kind'])}), made {esc(result['created'])}. Errors are held out: every dot is predicted by models fitted without it.</p>")
    for n in result.get("notes", []):
        parts.append(f"<p>Note: {esc(n)}</p>")
    if result.get("best"):
        parts.append("<h2>Best per camera</h2><div class=\"wrap\"><table><tr><th>Camera</th><th>Estimators</th><th>Model</th><th>Held-out dot error (deg)</th></tr>")
        for b in result["best"]:
            parts.append(f"<tr><td>{esc(b['camera'])}</td><td>{esc(b['combo'])}</td><td>{esc(b['model'])}</td><td>{_fmt(b['value'])}</td></tr>")
        parts.append("</table></div>")
    for cam, entry in result.get("cameras", {}).items():
        parts.append(f"<h2>{esc(cam)}</h2><p class=\"muted\">{esc(str(entry.get('camera_type')))} camera, {entry.get('dots')} dots, {entry.get('rows')} video frames.</p>")
        for n in entry.get("notes", []):
            parts.append(f"<p>Note: {esc(n)}</p>")
        for combo, r in entry.get("combos", {}).items():
            parts.append(f"<h3>Estimators: {esc(combo)} <span class=\"muted\">({esc(' + '.join(r.get('estimators', [])))})</span></h3>")
            parts.append(f"<p>Failures: {esc(_fail_line(r.get('failures', {})))}.</p>")
            if r.get("rejected_dots"):
                parts.append(f"<p>Dots rejected by cleaning: {len(r['rejected_dots'])} of {r.get('n_dots_seen')}.</p>")
            if r.get("message"):
                parts.append(f"<p>Not scored: {esc(r['message'])}.</p>")
                continue
            parts.append("<div class=\"wrap\"><table><tr>" + "".join(f"<th>{esc(c[1])}</th>" for c in TABLE_COLS) + "</tr>")
            for row in _model_rows(r):
                parts.append("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>")
            parts.append("</table></div>")
            chosen = r.get("chosen")
            if chosen:
                parts.append(f"<p class=\"muted\">Error by screen position, {esc(chosen)}: circles are dots (number: held-out error in degrees), lines go to the mean prediction; thin lines are the moving dot.</p>")
                parts.append(_svg_chart(r, result.get("screen", {}), chosen))
    parts.append("</main></body></html>")
    return "".join(parts)


def write_reports(result: dict[str, Any], folder: Path) -> dict[str, Path]:
    folder.mkdir(parents=True, exist_ok=True)
    paths = {"md": folder / "report.md", "html": folder / "report.html", "json": folder / "result.json"}
    paths["md"].write_text(write_markdown(result), encoding="utf-8")
    paths["html"].write_text(write_html(result), encoding="utf-8")
    paths["json"].write_text(json.dumps(result, indent=2), encoding="utf-8")
    return paths


def format_summary(result: dict[str, Any]) -> str:
    lines = [f"Session {result['session']}"]
    for n in result.get("notes", []):
        lines.append(f"  note: {n}")
    for cam, entry in result.get("cameras", {}).items():
        lines.append(f"\n{cam} ({entry.get('camera_type')}): {entry.get('dots')} dots")
        for n in entry.get("notes", []):
            lines.append(f"  note: {n}")
        for combo, r in entry.get("combos", {}).items():
            lines.append(f"  estimators {combo}: {_fail_line(r.get('failures', {}))}")
            if r.get("rejected_dots"):
                lines.append(f"    dots rejected: {len(r['rejected_dots'])} of {r.get('n_dots_seen')} (" + "; ".join(sorted({d['reason'] for d in r['rejected_dots']})) + ")")
            if r.get("message"):
                lines.append(f"    {r['message']}")
                continue
            for name, m in r.get("models", {}).items():
                if not m.get("ok"):
                    lines.append(f"    {name:<10} failed: {m.get('message') or ''}")
                    continue
                mark = "  (chosen)" if name == r.get("chosen") else ""
                lines.append(f"    {name:<10} held-out {_fmt(m.get('loo_deg'))} deg, per frame {_fmt(m.get('loo_sample_deg'))}, precision {_fmt(m.get('precision_deg'))}, moving dot {_fmt(m.get('pursuit_deg'))}{mark}")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Lab page (web/lab.html): /api/lab/*
# --------------------------------------------------------------------------------------------


def candidate_sessions(cfg: Config) -> list[dict[str, Any]]:
    """Sessions the Lab page offers: tools/eye-capture/captures/* (when this is a checkout) and
    Phone Gaze recordings in ``recording.directory``."""
    out: list[dict[str, Any]] = []
    roots: list[tuple[str, Path]] = []
    here = Path(__file__).resolve()
    for parent in here.parents:
        cap = parent / "tools" / "eye-capture" / "captures"
        if cap.is_dir():
            roots.append(("eye-capture", cap))
            break
    roots.append(("recording", Path(cfg.recording.directory).expanduser()))
    for kind, root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if d.is_dir() and ((d / "meta.json").exists() or (d / STREAM_FILE).exists()):
                out.append({"kind": kind, "name": d.name, "path": str(d)})
    return out[:200]


def list_reports(cfg: Config) -> list[dict[str, Any]]:
    root = output_root(cfg)
    out = []
    if not root.is_dir():
        return out
    for d in root.iterdir():
        res = d / "result.json"
        if not (d.is_dir() and res.exists()):
            continue
        try:
            data = json.loads(res.read_text())
        except (OSError, ValueError):
            continue
        out.append({"id": d.name, "session": data.get("session"), "created": data.get("created"), "best": data.get("best", []), "has_html": (d / "report.html").exists()})
    out.sort(key=lambda r: str(r.get("created") or ""), reverse=True)
    return out


def list_presets(cfg: Config) -> list[dict[str, Any]]:
    d = presets_dir(cfg)
    out = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("changes"), dict):
            data.setdefault("name", p.stem)
            out.append(data)
    return out


def register(app: Any, engine: Any) -> None:
    """Add ``/api/lab/*`` to the engine's aiohttp app (call before the ``/api`` 404 route):

    - ``GET /api/lab/sessions``: sessions found on this computer;
    - ``GET /api/lab/reports``, ``GET /api/lab/report/{id}``: past lab reports (HTML);
    - ``GET /api/lab/presets``: presets written by ``tune --save``;
    - ``POST /api/lab/presets/apply`` ``{"name"}``: apply a preset's changes to the running engine;
    - ``POST /api/lab/run`` ``{"session", "combos"?}``, ``GET /api/lab/jobs``: run the lab in the
      background (it can take minutes on 4K video)."""
    import asyncio

    from aiohttp import web

    jobs: dict[str, dict[str, Any]] = {}

    def _json(data: Any, status: int = 200) -> web.Response:
        return web.json_response(_jsonable(data), status=status, dumps=lambda d: json.dumps(d, default=str))

    async def sessions(request: web.Request) -> web.Response:
        return _json({"sessions": candidate_sessions(engine.config), "output_dir": str(output_root(engine.config))})

    async def reports(request: web.Request) -> web.Response:
        return _json({"reports": list_reports(engine.config)})

    async def report(request: web.Request) -> web.StreamResponse:
        rid = request.match_info["id"]
        if "/" in rid or "\\" in rid or rid.startswith("."):
            return _json({"error": "bad report id"}, 400)
        path = output_root(engine.config) / rid / "report.html"
        if not path.exists():
            return _json({"error": "no such report"}, 404)
        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})

    async def presets(request: web.Request) -> web.Response:
        return _json({"presets": list_presets(engine.config), "folder": str(presets_dir(engine.config))})

    async def preset_apply(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            body = {}
        try:
            data = load_preset(str((body or {}).get("name") or ""), engine.config)
        except LabError as exc:
            return _json({"error": str(exc)}, 404)
        errors = await engine.apply_config(dict(data["changes"]))
        return _json({"applied": data["changes"], "errors": errors})

    async def run(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            body = {}
        path = str((body or {}).get("session") or "")
        try:
            source = open_source(path)
        except LabError as exc:
            return _json({"error": str(exc)}, 400)
        combos = body.get("combos") if isinstance(body.get("combos"), list) else None
        cfg = copy.deepcopy(engine.config)
        jid = f"j{len(jobs) + 1}"
        job: dict[str, Any] = {"id": jid, "session": path, "state": "running", "log": [], "started": time.time()}
        jobs[jid] = job

        def work() -> dict[str, Any]:
            quiet_native_logs()
            res = run_lab(source, cfg, combos=combos, progress=lambda m: job["log"].append(m))
            write_reports(res, Path(res["output_dir"]))
            return res

        async def runner() -> None:
            try:
                res = await asyncio.get_running_loop().run_in_executor(None, work)
                job.update(state="done", report=Path(res["output_dir"]).name, best=res.get("best"))
            except LabError as exc:
                job.update(state="failed", error=str(exc))
            except Exception as exc:  # noqa: BLE001 - shown on the page
                log.exception("lab run failed")
                job.update(state="failed", error=f"{type(exc).__name__}: {exc}")

        job["task"] = asyncio.ensure_future(runner())
        return _json({k: v for k, v in job.items() if k != "task"})

    async def job_list(request: web.Request) -> web.Response:
        return _json({"jobs": [{k: v for k, v in j.items() if k != "task"} for j in jobs.values()]})

    r = app.router
    r.add_get("/api/lab/sessions", sessions)
    r.add_get("/api/lab/reports", reports)
    r.add_get("/api/lab/report/{id}", report)
    r.add_get("/api/lab/presets", presets)
    r.add_post("/api/lab/presets/apply", preset_apply)
    r.add_post("/api/lab/run", run)
    r.add_get("/api/lab/jobs", job_list)


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------


def quiet_native_logs() -> None:
    """MediaPipe and TensorFlow Lite print setup chatter on every graph; keep the terminal for
    results (set GLOG_minloglevel=0 to see it again)."""
    import os

    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")


def add_common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("session", help="session folder (tools/eye-capture) or a Phone Gaze recording folder")
    p.add_argument("--config", help="config file (default ~/.phonegaze/config.json)")
    p.add_argument("--preset", help="apply a preset (name in the lab presets folder, or a .json path)")
    p.add_argument("--set", action="append", default=[], metavar="PATH=VALUE", help="change one setting for this run, e.g. --set lab.every=3 (repeatable)")
    p.add_argument("--segment", help="only this camera recording (file stem, e.g. back-wide-2x)")
    p.add_argument("--no-cache", action="store_true", help="ignore and do not write the frame and observation caches")
    p.add_argument("--log-level", default="WARNING")


def main(argv: list[str] | None = None) -> int:
    """``python -m phonegaze lab SESSION ...``"""
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "lab":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="python -m phonegaze lab", description="Score a recorded session offline: every estimator combination and gaze model, held out.")
    add_common_args(p)
    p.add_argument("--combos", help="estimator combinations, comma-separated, each estimator names joined by '+' ('default' = estimators.order)")
    p.add_argument("--models", help="gaze models, comma-separated (default models.candidates)")
    p.add_argument("--images", action="store_true", help="also save one annotated eye crop per dot in the output folder (shows the eyes; stays on this computer)")
    p.add_argument("--out", help="output folder (default lab.output_dir/<session>)")
    p.add_argument("--json", action="store_true", help="print the result as JSON")
    args = p.parse_args(argv)
    quiet_native_logs()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.WARNING), format="%(levelname)s %(name)s: %(message)s")
    try:
        sets = list(args.set)
        if args.models:
            sets.append("models.candidates=" + json.dumps([m.strip() for m in args.models.split(",") if m.strip()]))
        cfg, _ = build_config(args.config, args.preset, sets)
        if args.out:
            cfg.lab.output_dir = str(Path(args.out).expanduser())
        source = open_source(args.session)
        combos = [c.strip() for c in args.combos.split(",") if c.strip()] if args.combos else None
        progress = None if args.json else (lambda s: print(s, file=sys.stderr, flush=True))
        result = run_lab(source, cfg, segment=args.segment, combos=combos, use_cache=not args.no_cache, images=args.images or cfg.lab.save_eye_images, progress=progress)
        paths = write_reports(result, Path(result["output_dir"]))
    except LabError as exc:
        print(f"lab: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(format_summary(result))
        print(f"\nReport: {paths['html']}\n        {paths['md']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
