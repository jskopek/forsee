"""Replay recorded sessions through any estimators and models, offline. Owner: Core.

Two kinds of recording:

- **Phone Gaze recordings** (``recorder.py``): ``stream.pgz1`` plus ``events.jsonl``. They can
  be scored offline (:func:`score`) or fed live into the engine (:func:`play`,
  ``python -m phonegaze --replay DIR``).
- **tools/eye-capture sessions**: a video and per-frame CSV per camera, with dots in
  ``events.jsonl``. :func:`iter_eye_capture` turns them into ``Frame`` objects and
  :func:`score_eye_capture` reports leave-one-dot-out accuracy per camera and model.

Command line::

    python -m phonegaze.replay score RECORDING_DIR [--estimators a,b] [--models a,b] [--drift-rate 0.5]
    python -m phonegaze.replay eye-capture SESSION_DIR [--every 2] [--segment NAME]

Imported by: tests, the UI's experiment page (through ``server.py``), command line scripts.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import math
import shutil
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path
from typing import Any

import numpy as np

from .protocol import Message, read_messages
from .recorder import SESSION_FILE, STREAM_FILE
from .types import CalibSample, Estimator, Frame, GazeModel, Observation, ScreenInfo, _jsonable

log = logging.getLogger(__name__)

SETTLE_S = 0.7
"""eye-capture: skip this much of each dot while the eyes travel (as analysis/session.py)."""


# --------------------------------------------------------------------------------------------
# Phone Gaze recordings
# --------------------------------------------------------------------------------------------


def read_session(recording: Path) -> dict[str, Any]:
    path = Path(recording) / SESSION_FILE
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def iter_messages(recording: Path) -> Iterator[Message]:
    path = Path(recording) / STREAM_FILE
    if not path.exists():
        return
    with open(path, "rb") as f:
        yield from read_messages(f)


def iter_frames(recording: Path) -> Iterator[Frame]:
    """Frames of a Phone Gaze recording (``stream.pgz1``), with ``t_received`` from ``recv``."""
    for msg in iter_messages(recording):
        if msg.type != "frame":
            continue
        try:
            yield Frame.from_message(msg, msg.header.get("recv"))
        except (KeyError, TypeError, ValueError) as exc:
            log.warning("skipping malformed frame: %s", exc)


def read_events(recording: Path) -> list[dict[str, Any]]:
    path = Path(recording) / "events.jsonl"
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


async def play(
    recording: Path,
    on_message: Callable[[Message, float], Awaitable[None] | None],
    stop: asyncio.Event,
    *,
    speed: float = 1.0,
    loop: bool = True,
) -> None:
    """Feed a recording's messages to ``on_message`` at the recorded pace (``speed`` x), with
    fresh receive times, until ``stop`` is set (looping when ``loop``)."""
    while not stop.is_set():
        start_wall = time.monotonic()
        start_rec: float | None = None
        count = 0
        for msg in iter_messages(recording):
            if stop.is_set():
                return
            recv = msg.header.get("recv")
            if isinstance(recv, (int, float)):
                if start_rec is None:
                    start_rec = float(recv)
                due = start_wall + (float(recv) - start_rec) / max(speed, 1e-3)
                delay = due - time.monotonic()
                if delay > 0:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=delay)
                        return
                    except asyncio.TimeoutError:
                        pass
            header = {k: v for k, v in msg.header.items() if k != "recv"}
            res = on_message(Message(header, msg.parts), time.monotonic())
            if asyncio.iscoroutine(res):
                await res
            count += 1
            if count % 50 == 0:
                await asyncio.sleep(0)
        if not loop or count == 0:
            return


def _dot_windows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collect windows from recorded ``calib.dot`` events: ``{run_id, kind, dot_id, x, y,
    pose_group, t0, t1}`` in engine monotonic time."""
    kinds: dict[str, str] = {}
    windows: list[dict[str, Any]] = []
    open_: dict[tuple[str, int], dict[str, Any]] = {}
    cancelled: set[str] = set()
    for ev in events:
        t = ev.get("type")
        if t == "calib.start":
            kinds[ev.get("run_id", "")] = ev.get("kind", "grid")
        elif t == "calib.cancel":
            cancelled.add(ev.get("run_id", ""))
        elif t == "calib.dot":
            run_id = ev.get("run_id", "")
            key = (run_id, int(ev.get("dot_id", 0)))
            state = ev.get("state")
            if state == "collect":
                if run_id and ev.get("kind") == "pursuit":
                    # A new pursuit dot closes the previous one of the same run.
                    for k in [k for k in open_ if k[0] == run_id and k != key]:
                        w = open_.pop(k)
                        w["t1"] = ev["t_local"]
                        windows.append(w)
                if key not in open_:
                    open_[key] = {
                        "run_id": run_id,
                        "kind": ev.get("kind") or kinds.get(run_id, "grid"),
                        "dot_id": key[1],
                        "x": float(ev["x"]),
                        "y": float(ev["y"]),
                        "pose_group": int(ev.get("pose_group") or 0),
                        "t0": float(ev["t_local"]),
                    }
            elif state == "done" and key in open_:
                w = open_.pop(key)
                w["t1"] = float(ev["t_local"])
                windows.append(w)
    return [w for w in windows if w["run_id"] not in cancelled]


def observations_for(recording: Path, estimators: list[Estimator]) -> Iterator[tuple[Frame, Observation]]:
    """Run every frame of a recording through ``estimators`` (fresh state)."""
    from .lens import UprightTracker
    from .pipeline import run_estimators
    from .types import DecodedFrame

    for est in estimators:
        try:
            est.reset()
        except Exception:  # noqa: BLE001
            pass
    session = read_session(recording)
    mode = str(((session.get("config") or {}).get("stream") or {}).get("rotation", "auto"))
    upright = UprightTracker(mode)
    for frame in iter_frames(recording):
        rot = upright.update(frame.gravity, frame.camera.position)
        decoded = DecodedFrame.from_frame(frame, rot)
        obs = run_estimators(estimators, decoded)
        if frame.header.get("sim") is not None:
            obs.extra["sim"] = frame.header["sim"]
        yield frame, obs


def samples_from_windows(pairs: list[tuple[Frame, Observation]], windows: list[dict[str, Any]], settle_s: float = 0.0) -> list[CalibSample]:
    samples: list[CalibSample] = []
    for uid, w in enumerate(windows):
        for frame, obs in pairs:
            t = frame.t_received
            if t is None or not (w["t0"] + settle_s <= t < w["t1"]):
                continue
            kind = "validate" if w["kind"] == "validate" else w["kind"]
            samples.append(CalibSample(target=(w["x"], w["y"]), obs=obs, kind=kind, dot_id=uid, run_id=w["run_id"], pose_group=w["pose_group"], t_local=t))
    return samples


def score(
    recording: Path,
    estimators: list[Estimator],
    models: list[GazeModel],
    drift_rate: float = 0.5,
) -> dict[str, Any]:
    """Re-run a recording that contains calibration and validation events: refit every model on
    the calibration samples and report validation accuracy per model (``FitReport`` dicts plus
    ``{"validation": {model: {"accuracy_deg", "precision_deg"}}}``). When the recording has
    look-points, ``"drift"`` holds :func:`drift_replay` for the chosen model."""
    from . import calibration as calib

    recording = Path(recording).expanduser()
    session = read_session(recording)
    screen = _session_screen(session)
    pairs = list(observations_for(recording, estimators))
    windows = _dot_windows(read_events(recording))
    samples = samples_from_windows(pairs, windows)
    fit_samples = [s for s in samples if s.kind not in ("validate", "refine")]
    val_samples = [s for s in samples if s.kind == "validate"]
    out: dict[str, Any] = {
        "recording": str(recording),
        "frames": len(pairs),
        "estimators": [getattr(e, "name", "?") for e in estimators],
        "n_fit_samples": len(fit_samples),
        "n_validation_samples": len(val_samples),
        "reports": [],
        "chosen": None,
        "validation": {},
    }
    if not fit_samples:
        out["message"] = "the recording has no calibration samples"
        return out
    result = calib.fit_all(fit_samples, screen, models)
    out["reports"] = [r.to_dict() for r in result.reports]
    out["chosen"] = result.chosen
    if val_samples:
        for name, model in result.models.items():
            try:
                out["validation"][name] = calib.validation_metrics(model, val_samples, screen)
            except Exception as exc:  # noqa: BLE001
                out["validation"][name] = {"error": str(exc)}
    model = result.models.get(result.chosen) if result.chosen else None
    events = read_events(recording)
    if model is not None and any(e.get("type") == "lookpoint" for e in events):
        predictions = []
        for frame, obs in pairs:
            try:
                p = model.predict(obs)
            except Exception:  # noqa: BLE001
                p = None
            if p is not None and p.valid and frame.t_received is not None:
                predictions.append((float(frame.t_received), float(p.x), float(p.y), obs.distance))
        out["drift"] = drift_replay(predictions, events, screen, drift_rate=drift_rate)
    return _jsonable(out)


DRIFT_RESET_EVENTS = {"camera": "camera changed", "calib.finish": "calibration"}


def drift_replay(
    predictions: list[tuple[float, float, float, float | None]],
    events: list[dict[str, Any]],
    screen: ScreenInfo,
    drift_rate: float = 0.5,
    clicks: bool = False,
) -> dict[str, Any]:
    """Replay the drift-correction experiment offline: ``predictions`` are the uncorrected
    ``(t, x, y, distance)`` of one model in engine time, ``events`` a recording's events
    (``lookpoint``, ``lookpoint.undo``, and the ones that reset the correction: a finished grid or
    refine run, a camera change; a zoom change re-anchors it). Runs it twice: as if the correction
    had been applied to the output (``on``: the outlier test looks at the corrected estimate) and
    not (``off``). Each run scores both estimates before every update, so each holds a
    ``with correction`` and a ``without`` number."""
    from .models.drift import DriftCorrector, DriftSettings, points_per_degree

    preds = sorted(predictions, key=lambda p: p[0])
    timeline: list[tuple[float, int, dict[str, Any]]] = []
    for i, ev in enumerate(events):
        t = ev.get("t") if ev.get("type") == "lookpoint" and isinstance(ev.get("t"), (int, float)) else ev.get("t_local")
        if isinstance(t, (int, float)):
            timeline.append((float(t), i, ev))
    timeline.sort(key=lambda e: (e[0], e[1]))
    out: dict[str, Any] = {"n_lookpoints": sum(1 for e in events if e.get("type") == "lookpoint"), "drift_rate": drift_rate}
    for label, applied in (("on", True), ("off", False)):
        dc = DriftCorrector(DriftSettings(rate_deg_per_min=drift_rate))
        k = 0
        dist: float | None = None
        for t, _, ev in timeline:
            while k < len(preds) and preds[k][0] <= t:
                dc.add_prediction(preds[k][0], preds[k][1], preds[k][2])
                dist = preds[k][3] or dist
                k += 1
            kind = ev.get("type")
            if kind == "lookpoint":
                lk = "click" if ev.get("kind") == "click" else "dwell"
                if lk == "click" and not clicks:
                    continue
                rect = ev.get("rect")
                box = tuple(float(v) for v in rect) if isinstance(rect, list) and len(rect) == 4 else None
                sid = ev.get("id")
                dc.selection(float(ev["x"]), float(ev["y"]), t, points_per_degree(screen, dist), rect=box, kind=lk, sel_id=None if sid is None else str(sid), applied=applied)
            elif kind == "lookpoint.undo" and ev.get("id") is not None:
                dc.undo(str(ev["id"]), t)
            elif kind == "zoom":
                dc.reanchor("zoom changed")
            elif kind == "camera" or (kind == "calib.finish" and ev.get("kind") in ("grid", "pursuit", "refine") and ev.get("committed", True)):
                dc.reset(DRIFT_RESET_EVENTS.get(kind, kind))
        st = dc.stats(points_per_degree(screen, dist))
        out[label] = {"session": st["session"], "recent": st["recent"], "rejected": st["rejected"], "undone": st["undone"]}
    return out


def format_drift(drift: dict[str, Any]) -> str:
    """One line per run: ``with correction X deg, without Y deg (median, n selections)``."""

    def num(v: Any) -> str:
        return "-" if v is None else f"{v:.2f} deg"

    lines = [f"drift correction from {drift.get('n_lookpoints', 0)} look-point(s), rate {drift.get('drift_rate')} deg/min:"]
    for label in ("on", "off"):
        run = drift.get(label) or {}
        s = run.get("session") or {}
        lines.append(
            f"  applied {label:>3}: with correction {num((s.get('corrected') or {}).get('median_deg'))} median, {num((s.get('corrected') or {}).get('mean_deg'))} mean; "
            f"without {num((s.get('uncorrected') or {}).get('median_deg'))} median, {num((s.get('uncorrected') or {}).get('mean_deg'))} mean; n={s.get('n', 0)}"
        )
    return "\n".join(lines)


def _session_screen(session: dict[str, Any]) -> ScreenInfo:
    data = session.get("screen")
    if isinstance(data, dict):
        try:
            return ScreenInfo.from_dict(data)
        except (KeyError, TypeError, ValueError):
            pass
    hello = session.get("hello") or {}
    sim_screen = (hello.get("sim") or {}).get("screen") if isinstance(hello, dict) else None
    if sim_screen:
        return ScreenInfo.from_dict(sim_screen)
    from .outputs.screen import FALLBACK

    return ScreenInfo(**FALLBACK.to_dict())


# --------------------------------------------------------------------------------------------
# tools/eye-capture sessions
# --------------------------------------------------------------------------------------------

ARKIT_MATRICES = ("face", "left_eye", "right_eye", "camera")
ARKIT_WIRE = {"face": "face", "left_eye": "leftEye", "right_eye": "rightEye", "camera": "camera"}


def _read_csv(path: Path) -> tuple[list[str], np.ndarray]:
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        return [], np.zeros((0, 0))
    header, body = rows[0], [r for r in rows[1:] if r]

    def num(v: str) -> float:
        try:
            return float(v)
        except ValueError:
            return math.nan

    data = np.array([[num(v) for v in r] for r in body], dtype=float) if body else np.zeros((0, len(header)))
    return header, data


def eye_capture_segments(session_dir: Path) -> list[dict[str, Any]]:
    """Each camera recording in a session: ``{"name", "info", "video", "csv"}``."""
    session_dir = Path(session_dir)
    out = []
    for info_path in sorted(session_dir.glob("*.json")):
        if info_path.name == "meta.json":
            continue
        name = info_path.stem
        csv_path = session_dir / f"{name}.frames.csv"
        if not csv_path.exists():
            continue
        try:
            info = json.loads(info_path.read_text())
        except ValueError:
            continue
        video = next((session_dir / f"{name}{ext}" for ext in (".mov", ".mp4", ".m4v") if (session_dir / f"{name}{ext}").exists()), None)
        out.append({"name": name, "info": info, "video": video, "csv": csv_path})
    return out


def _camera_type(info: dict[str, Any], name: str) -> str:
    if info.get("mode") == "arkit" or info.get("cameraId") == "arkit-face":
        return "arkit"
    label = f"{name} {info.get('cameraName', '')}".lower()
    if "ultra" in label:
        return "ultrawide"
    if "tele" in label:
        return "tele"
    return "wide"


def _iter_video(path: Path) -> Iterator[np.ndarray]:
    """BGR frames of a video: OpenCV first, ffmpeg as a fallback (HEVC .mov)."""
    import cv2

    cap = cv2.VideoCapture(str(path))
    got = False
    try:
        while cap.isOpened():
            ok, img = cap.read()
            if not ok:
                break
            got = True
            yield img
    finally:
        cap.release()
    if got:
        return
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError(f"OpenCV cannot read {path} and ffmpeg is not installed")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    assert proc.stdout is not None
    try:
        size = w * h * 3
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.kill()
        proc.wait()


def _nearest_rows(t_query: np.ndarray, t_table: np.ndarray) -> np.ndarray:
    idx = np.searchsorted(t_table, t_query)
    idx = np.clip(idx, 1, len(t_table) - 1)
    left = t_table[idx - 1]
    right = t_table[idx]
    return np.where(np.abs(t_query - left) <= np.abs(right - t_query), idx - 1, idx)


def iter_eye_capture(session_dir: Path, segment: str | None = None, every: int = 1, jpeg_quality: int = 92) -> Iterator[Frame]:
    """Frames from a ``tools/eye-capture`` session (mp4 + per-frame CSV + segment JSON), each
    turned into a ``Frame`` whose single ``wide`` part is the full-resolution frame as JPEG and
    whose ``arkit`` block is rebuilt from the CSV columns when the segment was ARKit.

    ``segment`` limits to one camera recording (file stem); ``every`` keeps every Nth frame.
    ``frame.header["eye_capture"]`` = ``{"segment", "frame"}``. Gravity comes from
    ``<name>.motion.csv`` (nearest sample) or the segment's ``gravityAtStart``.
    """
    import cv2

    for seg in eye_capture_segments(Path(session_dir)):
        if segment is not None and seg["name"] != segment:
            continue
        if seg["video"] is None:
            log.warning("%s has no video; skipped", seg["name"])
            continue
        info = seg["info"]
        cols, data = _read_csv(seg["csv"])
        if data.size == 0:
            continue
        col = {c: i for i, c in enumerate(cols)}
        t_col = data[:, col["t"]]
        gravity_rows: np.ndarray | None = None
        motion_path = Path(session_dir) / f"{seg['name']}.motion.csv"
        if motion_path.exists():
            mcols, mdata = _read_csv(motion_path)
            if mdata.size and {"t", "gravity_x", "gravity_y", "gravity_z"} <= set(mcols):
                mc = {c: i for i, c in enumerate(mcols)}
                order = np.argsort(mdata[:, mc["t"]])
                mdata = mdata[order]
                near = _nearest_rows(t_col, mdata[:, mc["t"]]) if len(mdata) > 1 else np.zeros(len(t_col), dtype=int)
                gravity_rows = mdata[near][:, [mc["gravity_x"], mc["gravity_y"], mc["gravity_z"]]]
        start_g = info.get("gravityAtStart")
        ctype = _camera_type(info, seg["name"])
        is_arkit = ctype == "arkit"
        intr = info.get("intrinsics") or {}
        for i, img in enumerate(_iter_video(seg["video"])):
            if i >= len(data):
                break
            if i % max(1, every):
                continue
            row = data[i]
            h, w = img.shape[:2]
            cam: dict[str, Any] = {
                "id": info.get("cameraId", seg["name"]),
                "position": info.get("position", "front" if is_arkit else "back"),
                "type": ctype,
                "zoom": 1.0 if is_arkit else float(info.get("zoom") or 1.0),
                "width": w,
                "height": h,
                "intrinsicsSource": "arkit" if is_arkit else "attachment",
                "intrinsicsIncludeZoom": is_arkit,
            }
            if intr:
                sx = w / float(intr.get("width") or w)
                sy = h / float(intr.get("height") or h)
                cam.update(fx=intr["fx"] * sx, fy=intr["fy"] * sy, cx=intr["cx"] * sx, cy=intr["cy"] * sy)
            if info.get("fieldOfView"):
                cam["fieldOfView"] = info["fieldOfView"]

            def val(name: str) -> float | None:
                j = col.get(name)
                if j is None:
                    return None
                v = float(row[j])
                return v if math.isfinite(v) else None

            header: dict[str, Any] = {
                "type": "frame",
                "seq": int(val("frame") if val("frame") is not None else i),
                "t": float(t_col[i]),
                "mode": "arkit" if is_arkit else "camera",
                "dropped": 0,
                "camera": cam,
                "lens": {
                    k: v
                    for k, v in {
                        "position": val("lens_position"),
                        "iso": val("iso"),
                        "exposureS": val("exposure_s"),
                        "adjustingFocus": None if val("adjusting_focus") is None else bool(val("adjusting_focus")),
                        "adjustingExposure": None if val("adjusting_exposure") is None else bool(val("adjusting_exposure")),
                    }.items()
                    if v is not None
                },
                "eye_capture": {"segment": seg["name"], "frame": i},
            }
            g = gravity_rows[i].tolist() if gravity_rows is not None else start_g
            if g is not None and all(math.isfinite(float(v)) for v in g):
                header["gravity"] = [float(v) for v in g]
            if is_arkit:
                ar: dict[str, Any] = {"tracked": bool(val("face_tracked") or 0)}
                for m in ARKIT_MATRICES:
                    names = [f"{m}_c{c}r{r}" for c in range(4) for r in range(4)]
                    if all(n in col for n in names):
                        values = [val(n) for n in names]
                        ar[ARKIT_WIRE[m]] = None if any(v is None for v in values) else values
                look = [val(f"look_at_{a}") for a in "xyz"]
                ar["lookAt"] = None if any(v is None for v in look) else look
                ar["blendShapes"] = {c: val(c) for c in cols if (c.startswith("blink_") or c.startswith("look_")) and not c.startswith("look_at") and val(c) is not None}
                header["arkit"] = ar
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(jpeg_quality)])
            if not ok:
                continue
            payload = bytes(buf)
            header["parts"] = [{"name": "wide", "kind": "wide", "format": "jpeg", "bytes": len(payload), "width": w, "height": h, "rect": [0, 0, w, h]}]
            yield Frame.from_message(Message(header, [payload]), None)


def _eye_capture_meta(session_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    meta = json.loads((Path(session_dir) / "meta.json").read_text())
    events_path = Path(session_dir) / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()] if events_path.exists() else []
    return meta, events


def eye_capture_screen(meta: dict[str, Any]) -> ScreenInfo:
    """The page viewport as the screen: dots are CSS pixels of the viewport (= points)."""
    s = meta.get("screen") or {}
    w = float(s.get("viewportWidth") or s.get("width") or 1440)
    h = float(s.get("viewportHeight") or s.get("height") or 900)
    ppcm = s.get("pixelsPerCm")
    return ScreenInfo(
        width=w,
        height=h,
        width_mm=w / float(ppcm) * 10 if ppcm else None,
        height_mm=h / float(ppcm) * 10 if ppcm else None,
        scale=float(s.get("devicePixelRatio") or 1.0),
        name="eye-capture viewport",
        source="browser",
    )


def eye_capture_dots(events: list[dict[str, Any]], segment: str) -> list[dict[str, Any]]:
    """Dots of one segment: ``{"dot_id", "x", "y", "t_on", "t_off"}`` (phone clock)."""
    dots, pending = [], {}
    for e in events:
        if e.get("seg") != segment:
            continue
        if e.get("type") == "target_on":
            pending[e.get("order")] = e
        elif e.get("type") == "target_off" and e.get("order") in pending:
            on = pending.pop(e.get("order"))
            dots.append({"dot_id": int(on.get("index", on.get("order", 0))), "x": float(on["x"]), "y": float(on["y"]), "t_on": float(on["t_phone"]), "t_off": float(e["t_phone"])})
    return dots


def score_eye_capture(session_dir: Path, estimators: list[Estimator], models_factory: Callable[[], list[GazeModel]], every: int = 2, segment: str | None = None, settle_s: float = SETTLE_S) -> dict[str, Any]:
    """Per camera recording: run the estimators on the frames inside dots, fit every model, and
    report leave-one-dot-out accuracy (from ``calibration.fit_all``)."""
    from . import calibration as calib
    from .lens import UprightTracker
    from .pipeline import run_estimators
    from .types import DecodedFrame

    session_dir = Path(session_dir)
    meta, events = _eye_capture_meta(session_dir)
    screen = eye_capture_screen(meta)
    distance_cm = meta.get("eyesToPhoneCm")
    results: dict[str, Any] = {"session": str(session_dir), "screen": screen.to_dict(), "cameras": {}}
    for seg in eye_capture_segments(session_dir):
        name = seg["name"]
        if segment is not None and name != segment:
            continue
        info = seg["info"]
        dots = eye_capture_dots(events, info.get("segment", name))
        entry: dict[str, Any] = {"dots": len(dots), "frames": 0, "samples": 0, "eyes_found": 0, "reports": [], "chosen": None}
        results["cameras"][name] = entry
        if not dots:
            entry["message"] = "no dots in this recording"
            continue
        for est in estimators:
            try:
                est.reset()
            except Exception:  # noqa: BLE001
                pass
        upright = UprightTracker("auto")
        samples: list[CalibSample] = []
        for frame in iter_eye_capture(session_dir, name, every=every):
            dot = next((d for d in dots if d["t_on"] + settle_s <= frame.t < d["t_off"]), None)
            if dot is None:
                continue
            entry["frames"] += 1
            rot = upright.update(frame.gravity, frame.camera.position)
            decoded = DecodedFrame.from_frame(frame, rot)
            obs = run_estimators(estimators, decoded)
            if obs.distance is None and distance_cm:
                obs.extra["eye_capture_distance_m"] = float(distance_cm) / 100.0
            if obs.left.found or obs.right.found:
                entry["eyes_found"] += 1
            samples.append(CalibSample(target=(dot["x"], dot["y"]), obs=obs, kind="grid", dot_id=dot["dot_id"], run_id=name, t_local=frame.t))
        entry["samples"] = len(samples)
        if len({s.dot_id for s in samples}) < 3:
            entry["message"] = "fewer than 3 dots with frames; nothing to fit"
            continue
        try:
            result = calib.fit_all(samples, screen, models_factory())
            entry["reports"] = [r.to_dict() for r in result.reports]
            entry["chosen"] = result.chosen
        except Exception as exc:  # noqa: BLE001
            entry["message"] = f"fitting failed: {exc}"
    return _jsonable(results)


def format_eye_capture(result: dict[str, Any]) -> str:
    lines = [f"Session {result['session']}"]
    for name, entry in result["cameras"].items():
        lines.append(f"\n{name}: {entry['dots']} dots, {entry['frames']} frames, eyes found in {entry['eyes_found']}, {entry['samples']} samples")
        if entry.get("message"):
            lines.append(f"  {entry['message']}")
        for r in entry.get("reports", []):
            deg = r.get("loo_error_deg")
            pt = r.get("loo_error_pt")
            mark = " (chosen)" if r.get("model") == entry.get("chosen") else ""
            if r.get("ok"):
                lines.append(f"  {r['model']:<12} leave-one-dot-out {deg if deg is None else round(deg, 2)} deg, {pt if pt is None else round(pt, 1)} pt{mark}")
            else:
                lines.append(f"  {r['model']:<12} failed: {r.get('message', '')}")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------


def _build(estimator_names: str | None, model_names: str | None) -> tuple[list[Estimator], Callable[[], list[GazeModel]]]:
    from .config import Config
    from .models import build_models
    from .vision import build_estimators

    cfg = Config()
    if estimator_names:
        cfg.estimators.order = [n.strip() for n in estimator_names.split(",") if n.strip()]
    if model_names:
        cfg.models.candidates = [n.strip() for n in model_names.split(",") if n.strip()]
    return list(build_estimators(cfg.estimators)), lambda: list(build_models(cfg.models))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m phonegaze.replay", description="Score recorded sessions offline.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_score = sub.add_parser("score", help="refit and validate a Phone Gaze recording")
    p_score.add_argument("recording")
    p_score.add_argument("--drift-rate", type=float, default=0.5, help="drift correction speed for the look-point replay, deg/min (default 0.5)")
    p_eye = sub.add_parser("eye-capture", help="accuracy per camera for a tools/eye-capture session")
    p_eye.add_argument("session")
    p_eye.add_argument("--every", type=int, default=2, help="use every Nth video frame (default 2)")
    p_eye.add_argument("--segment", help="only this camera recording (file stem)")
    p_eye.add_argument("--json", action="store_true", help="print JSON instead of a table")
    for p in (p_score, p_eye):
        p.add_argument("--estimators", help="comma-separated estimator names (default: config order)")
        p.add_argument("--models", help="comma-separated model names (default: config candidates)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    estimators, models_factory = _build(args.estimators, args.models)
    if args.cmd == "score":
        result = score(Path(args.recording), estimators, models_factory(), drift_rate=args.drift_rate)
        print(json.dumps(result, indent=2))
        if result.get("drift"):
            print(format_drift(result["drift"]), file=sys.stderr)
        return 0
    result = score_eye_capture(Path(args.session), estimators, models_factory, every=args.every, segment=args.segment)
    print(json.dumps(result, indent=2) if args.json else format_eye_capture(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
