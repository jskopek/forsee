"""The unattended offline sweep: replay recorded sessions through thousands of setting
combinations and rank them on held-out validation dots. Owner: Sweep.

Input: one recording per physical setup ("condition": camera, zoom, exposure, reflection
helper...). A guided collection run writes each condition as a Phone Gaze recording with a
``collect.json`` manifest (format ``phonegaze-collect-1``: calibration, poses, validation and
pursuit phases with the dots' engine-clock times) and lists them in
``<recordings>/collect-runs/<run_id>.json``. Ordinary recordings that hold a calibration and a
validation are accepted too (the phases come from the recorded calibration events), and so are
tools/eye-capture sessions (as the lab reads them; they have no validation dots, so every third
calibration dot is held out instead).

Two stages, both cached on disk so an interrupted sweep resumes where it stopped:

1. **Observations.** For each condition and each combination of VISION settings (estimator
   chain, face detector options, crop size, iris fit and thresholds, reflection, distance source,
   head pose source) the stream is decoded once and every frame inside the dots is run through
   the estimators (``lab.collect``; cache keyed by a hash of those settings and the recording).
2. **Fitting.** For each cached observation set, combinations of MODEL and CALIBRATION settings
   (gaze model or blend, regularisation, eyeball centre, which eye, per-dot sample handling, with
   and without the head-position block, with and without the moving dot, error map, filter) are
   fitted on the calibration (and optionally the poses) phase only, then scored on the
   VALIDATION phase. Validation samples never reach a fit (kind ``"validate"``, dropped by
   ``fit_samples`` and asserted here) and never steer the search.

The search is steered only by a calibration-only score (leave-one-dot-out on the training dots,
and the error on other head positions when the run has them): a coarse pass (every model, with
and without poses, under every vision combination), one setting at a time around the best few,
then greedy and random local moves around the best, within ``--max-combos`` per condition and
``--minutes`` in all. Validation scores are only read for the report: setups are ranked on half
of the validation dots and confirmed on the other half, with bootstrap intervals over dots.

Output under ``<recordings>/sweeps/<name>/``: ``leaderboard.md``, ``leaderboard.html``,
``leaderboard.json``, ``summary.txt`` (plain text to paste into a chat), ``diagnosis.json`` and
``best_preset.json``; the winner is saved as the preset "best from sweep" (``presets.py``).
Caches go to ``<recordings>/sweeps/cache/``.

Command line::

    python -m phonegaze sweep <run id | run file | folder of recordings | recording>
        [--minutes 45] [--max-combos 400] [--workers N] [--vision auto|real|oracle]
        [--no-preset] [--config PATH] [--out DIR]

Nothing here has seen a real recording yet; it is tested on synthetic runs from the simulator
(``tests/sweep_synth.py``).
"""

from __future__ import annotations

import argparse
import copy
import datetime as _dt
import hashlib
import json
import logging
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .config import Config
from .lab import LabError
from .types import CalibSample, ScreenInfo, _jsonable

log = logging.getLogger(__name__)

SWEEP_VERSION = 1
"""Bump when stage-2 results for the same settings would change (old results are then refitted)."""

PRESET_NAME = "best from sweep"
COLLECT_FORMAT = "phonegaze-collect-1"
PHASES = ("calibration", "poses", "validation", "pursuit")
VALIDATION_BASE = 100000
POSE_BASE = 1000
MIN_COVERAGE = 0.75
"""A setup must predict at least this share of the validation dots to be ranked."""


class SweepError(LabError):
    """A problem with the input or the settings, said in plain words (no traceback)."""


# --------------------------------------------------------------------------------------------
# Conditions (inputs)
# --------------------------------------------------------------------------------------------


@dataclass
class PhaseDot:
    uid: int
    phase: str  # "calibration" | "poses" | "validation"
    x: float
    y: float
    t0: float
    t1: float
    pose_group: int = 0


@dataclass
class Condition:
    """One physical setup's recording, with its phases."""

    id: str
    label: str
    camera_id: str
    camera_label: str
    zoom: float | None
    settings: dict[str, Any]
    folder: Path
    kind: str  # "collect" | "recording" | "eye-capture"
    screen: ScreenInfo
    dots: list[PhaseDot]
    pursuit: np.ndarray | None  # (n, 3): t, x, y
    source: Any = None  # lab.Source
    segment: Any = None  # lab.Segment
    notes: list[str] = field(default_factory=list)
    run_id: str = ""
    started: str | None = None
    held_out_from_calibration: bool = False
    has_sim_truth: bool = False
    signature: str = ""  # changes when the recording or its manifest changes (old fits are then redone)
    settle_ms: int | None = None  # collection runs: how long each dot was shown before collecting

    @property
    def setup_key(self) -> str:
        """Conditions with the same camera, zoom and settings are repeats of one setup."""
        return json.dumps(_jsonable({"camera": self.camera_id, "zoom": self.zoom, "settings": self.settings}), sort_keys=True)

    def phase(self, name: str) -> list[PhaseDot]:
        return [d for d in self.dots if d.phase == name]

    @property
    def pose_groups(self) -> list[int]:
        return sorted({d.pose_group for d in self.dots if d.phase in ("calibration", "poses")})

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "camera_id": self.camera_id,
            "camera_label": self.camera_label,
            "zoom": self.zoom,
            "settings": self.settings,
            "folder": str(self.folder),
            "kind": self.kind,
            "dots": {p: len(self.phase(p)) for p in ("calibration", "poses", "validation")},
            "pose_groups": self.pose_groups,
            "pursuit": self.pursuit is not None,
            "notes": self.notes,
            "held_out_from_calibration": self.held_out_from_calibration,
            "has_sim_truth": self.has_sim_truth,
        }


@dataclass
class Inputs:
    root: Path  # the recordings folder (output goes under root/sweeps)
    name: str  # run id or folder name
    conditions: list[Condition]
    notes: list[str] = field(default_factory=list)


def _num(v: Any, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise SweepError(f"{what} should be a number, got {v!r}")
    return float(v)


def _is_recording(d: Path) -> bool:
    return d.is_dir() and ((d / "collect.json").exists() or (d / "stream.pgz1").exists() or (d / "meta.json").exists())


def resolve(target: str, cfg: Config) -> Inputs:
    """Find the conditions for a run id, run file, folder of recordings or single recording."""
    if not str(target or "").strip():
        raise SweepError("say what to sweep: a run id, a run file (collect-runs/<id>.json), a folder of recordings or one recording")
    p = Path(str(target)).expanduser()
    rec_root = Path(cfg.recording.directory).expanduser()
    notes: list[str] = []
    if p.is_file():
        if p.suffix != ".json":
            raise SweepError(f"{p} is a file but not a run file (.json)")
        root = p.parent.parent if p.parent.name == "collect-runs" else p.parent
        folders = _run_file_recordings(p, root)
        name = p.stem
    elif p.is_dir() and _is_recording(p):
        root, folders, name = p.parent, [p], p.name
    elif p.is_dir():
        folders = sorted(d for d in p.iterdir() if _is_recording(d))
        if not folders:
            raise SweepError(f"{p} holds no recordings (folders with collect.json, stream.pgz1 or meta.json)")
        root, name = p, p.name
    else:
        run_file = rec_root / "collect-runs" / f"{target}.json"
        if run_file.exists():
            return resolve(str(run_file), cfg)
        folders = [d for d in sorted(rec_root.iterdir()) if (d / "collect.json").exists() and _manifest_run_id(d) == str(target)] if rec_root.is_dir() else []
        if not folders:
            runs = sorted(x.stem for x in (rec_root / "collect-runs").glob("*.json")) if (rec_root / "collect-runs").is_dir() else []
            raise SweepError(f"{target!r} is not a folder, a file or a run id in {rec_root}." + (f" Runs there: {', '.join(runs)}" if runs else " No collection runs found there."))
        root, name = rec_root, str(target)
    conditions: list[Condition] = []
    for f in folders:
        try:
            conditions.extend(load_condition(f))
        except SweepError as exc:
            notes.append(f"{f.name}: skipped: {exc}")
    if not conditions:
        raise SweepError("nothing usable to sweep:\n  " + "\n  ".join(notes or ["no recordings"]))
    seen: dict[str, int] = {}
    for c in conditions:  # unique ids
        if c.id in seen:
            seen[c.id] += 1
            c.id = f"{c.id}-{seen[c.id]}"
        else:
            seen[c.id] = 1
    return Inputs(root=root, name=name, conditions=conditions, notes=notes)


def _manifest_run_id(folder: Path) -> str | None:
    try:
        return str(json.loads((folder / "collect.json").read_text(encoding="utf-8")).get("run_id"))
    except (OSError, ValueError, AttributeError):
        return None


def _run_file_recordings(path: Path, root: Path) -> list[Path]:
    """Recording folders a run file names (any string in it that is a recording folder, as a
    path or as a folder name under ``root``), else every recording whose manifest has the run's id."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SweepError(f"cannot read the run file {path}: {exc}") from exc
    found: list[Path] = []

    def walk(v: Any) -> None:
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str) and v and len(v) < 4096:
            for cand in (Path(v).expanduser(), root / v):
                try:
                    if _is_recording(cand) and cand.resolve() not in [f.resolve() for f in found]:
                        found.append(cand)
                        break
                except OSError:
                    continue

    # A collection run lists its completed recordings under "recordings" (collect.py); the
    # queue also names abandoned attempts, which must not be swept.
    if isinstance(data, dict) and isinstance(data.get("recordings"), list) and data["recordings"]:
        walk(data["recordings"])
    else:
        walk(data)
    if not found:
        rid = str(data.get("run_id") or path.stem) if isinstance(data, dict) else path.stem
        found = [d for d in sorted(root.iterdir()) if (d / "collect.json").exists() and _manifest_run_id(d) == rid] if root.is_dir() else []
    if not found:
        raise SweepError(f"the run file {path} names no recording folder that exists under {root}")
    return found


def load_condition(folder: Path) -> list[Condition]:
    """A collect recording (one condition), an ordinary recording (one condition per camera) or
    an eye-capture session (one per camera)."""
    from .lab import open_source

    folder = Path(folder)
    manifest = folder / "collect.json"
    if manifest.exists():
        return [_load_collect(folder)]
    try:
        source = open_source(folder)
    except LabError as exc:
        raise SweepError(str(exc)) from exc
    out = []
    for seg in source.segments:
        out.append(_from_segment(source, seg))
    if not out:
        raise SweepError("no camera recording with frames")
    return out


def _load_collect(folder: Path) -> Condition:
    from .lab import open_source

    try:
        m = json.loads((folder / "collect.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SweepError(f"collect.json cannot be read: {exc}") from exc
    if not isinstance(m, dict):
        raise SweepError("collect.json is not a JSON object")
    if m.get("format") != COLLECT_FORMAT:
        raise SweepError(f"collect.json has format {m.get('format')!r}; this sweep reads {COLLECT_FORMAT!r}")
    if not (folder / "stream.pgz1").exists():
        raise SweepError("collect.json is there but stream.pgz1 (the recorded phone stream) is missing")
    cond = m.get("condition") if isinstance(m.get("condition"), dict) else {}
    scr = m.get("screen") if isinstance(m.get("screen"), dict) else {}
    try:
        source = open_source(folder)
    except LabError as exc:
        raise SweepError(str(exc)) from exc
    if not source.segments:
        raise SweepError("the recorded stream holds no frames")
    seg = max(source.segments, key=lambda s: s.n_rows)
    notes = list(source.notes)
    if len(source.segments) > 1:
        notes.append(f"the camera changed during the recording; using {seg.name} ({seg.n_rows} of {sum(s.n_rows for s in source.segments)} frames)")
    try:
        screen = ScreenInfo(width=_num(scr["width_pt"], "screen.width_pt"), height=_num(scr["height_pt"], "screen.height_pt"), width_mm=_num(scr["width_mm"], "screen.width_mm") if scr.get("width_mm") else None, height_mm=_num(scr["height_mm"], "screen.height_mm") if scr.get("height_mm") else None)
    except KeyError:
        screen = source.screen
        notes.append("collect.json has no screen size; using the recording's")
    if screen.width_mm is None:
        notes.append("the screen's size in millimetres is unknown: errors in degrees are not available")
    dots: list[PhaseDot] = []
    pursuit: list[list[float]] = []
    phases = m.get("phases")
    if not isinstance(phases, list) or not phases:
        raise SweepError("collect.json has no phases")
    for pi, ph in enumerate(phases):
        if not isinstance(ph, dict):
            raise SweepError(f"phase {pi} in collect.json is not an object")
        name = str(ph.get("name"))
        if name not in PHASES:
            notes.append(f"unknown phase {name!r} ignored")
            continue
        if name == "pursuit":
            for k, s in enumerate(ph.get("samples") or []):
                if not (isinstance(s, (list, tuple)) and len(s) >= 3):
                    raise SweepError(f"pursuit sample {k} should be [t, x, y]")
                pursuit.append([_num(s[0], "pursuit t"), _num(s[1], "pursuit x"), _num(s[2], "pursuit y")])
            continue
        for k, d in enumerate(ph.get("dots") or []):
            if not isinstance(d, dict):
                raise SweepError(f"{name} dot {k} is not an object")
            what = f"{name} dot {d.get('id', k)}"
            t0, t1 = _num(d.get("t_on"), f"{what} t_on"), _num(d.get("t_off"), f"{what} t_off")
            if t1 <= t0:
                notes.append(f"{what}: t_off is not after t_on; skipped")
                continue
            pg = d.get("pose_group")
            pg = int(pg) if isinstance(pg, (int, float)) and not isinstance(pg, bool) else 0
            if name == "poses" and pg == 0:
                pg = 1
            did = int(d.get("id", k)) if isinstance(d.get("id", k), (int, float)) else k
            uid = VALIDATION_BASE + did if name == "validation" else POSE_BASE * pg + did % POSE_BASE
            dots.append(PhaseDot(uid=uid, phase=name, x=_num(d.get("x"), f"{what} x"), y=_num(d.get("y"), f"{what} y"), t0=t0, t1=t1, pose_group=pg if name != "validation" else 0))
    uids = [d.uid for d in dots]
    if len(set(uids)) != len(uids):  # ids repeated within a phase: renumber
        for i, d in enumerate(dots):
            d.uid = (VALIDATION_BASE if d.phase == "validation" else POSE_BASE * d.pose_group) + i
    if m.get("completed") is False:
        notes.append("the collection was not completed; using what was recorded")
    zoom = cond.get("zoom")
    c = Condition(
        id=str(cond.get("id") or folder.name),
        label=str(cond.get("label") or cond.get("id") or folder.name),
        camera_id=str(cond.get("camera_id") or seg.info.get("camera", {}).get("id") or seg.name),
        camera_label=str(cond.get("camera_label") or cond.get("camera_id") or seg.name),
        zoom=float(zoom) if isinstance(zoom, (int, float)) and not isinstance(zoom, bool) else _seg_zoom(seg),
        settings=dict(cond.get("settings") or {}) if isinstance(cond.get("settings"), dict) else {},
        folder=folder,
        kind="collect",
        screen=screen,
        dots=dots,
        pursuit=np.array(sorted(pursuit), float) if len(pursuit) >= 2 else None,
        source=source,
        segment=seg,
        notes=notes,
        run_id=str(m.get("run_id") or ""),
        started=m.get("started"),
    )
    if str(cond.get("notes") or "").strip():
        c.notes.append("notes: " + str(cond.get("notes")).strip())
    c.settle_ms = _protocol_settle(folder, m)
    _finish(c)
    return c


def _protocol_settle(folder: Path, manifest: dict[str, Any]) -> int | None:
    """How long the Collect page showed each dot before collecting (its protocol, recorded in the
    ``collect.start`` event)."""
    proto = manifest.get("protocol") if isinstance(manifest.get("protocol"), dict) else None
    if proto is None:
        try:
            with open(folder / "events.jsonl", encoding="utf-8") as f:
                for line in f:
                    if '"collect.start"' in line:
                        ev = json.loads(line)
                        proto = ev.get("protocol") if isinstance(ev.get("protocol"), dict) else proto
        except (OSError, ValueError):
            proto = None
    v = (proto or {}).get("settle_ms")
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 5000 else None


def _seg_zoom(seg: Any) -> float | None:
    z = (seg.info.get("camera") or {}).get("zoom") if isinstance(seg.info, dict) else None
    if z is None:
        z = seg.info.get("zoom") if isinstance(seg.info, dict) else None
    return float(z) if isinstance(z, (int, float)) else None


def _from_segment(source: Any, seg: Any) -> Condition:
    """An ordinary recording or an eye-capture session: phases from the recorded dots."""
    dots: list[PhaseDot] = []
    for d in seg.dots:
        if d.kind == "validate":
            dots.append(PhaseDot(uid=VALIDATION_BASE + len(dots), phase="validation", x=d.x, y=d.y, t0=d.t0, t1=d.t1))
        else:
            pg = (int(d.dot_id) // 1000) % 100
            dots.append(PhaseDot(uid=POSE_BASE * pg + len(dots) % POSE_BASE, phase="poses" if pg else "calibration", x=d.x, y=d.y, t0=d.t0, t1=d.t1, pose_group=pg))
    session = (source.meta or {}).get("session") or {}
    cfgd = session.get("config") if isinstance(session.get("config"), dict) else {}
    settings: dict[str, Any] = {}
    for sec in ("estimators", "models", "calibration", "filters", "stream"):
        for k, v in (cfgd.get(sec) or {}).items() if isinstance(cfgd.get(sec), dict) else []:
            settings[f"{sec}.{k}"] = v
    cam = seg.info.get("camera") if isinstance(seg.info.get("camera"), dict) else {}
    c = Condition(
        id=f"{source.path.name}" + (f"-{seg.name}" if len(source.segments) > 1 else ""),
        label=f"{source.path.name} ({seg.name})",
        camera_id=str(cam.get("id") or seg.name),
        camera_label=seg.name,
        zoom=_seg_zoom(seg),
        settings=settings,
        folder=source.path,
        kind=source.kind,
        screen=source.screen,
        dots=dots,
        pursuit=seg.pursuit,
        source=source,
        segment=seg,
        notes=list(source.notes) + list(seg.notes),
        started=str(session.get("started_at") or "") or None,
    )
    _finish(c)
    return c


def _finish(c: Condition) -> None:
    """Checks every condition gets: enough dots, a validation phase (or a held-out stand-in)."""
    cal = c.phase("calibration") + c.phase("poses")
    if not c.phase("validation"):
        if len(cal) < 9:
            raise SweepError(f"only {len(cal)} calibration dots and no validation dots: nothing can be held out")
        base = sorted(c.phase("calibration") or cal, key=lambda d: d.t0)
        for i, d in enumerate(base):
            if i % 3 == 1:
                d.phase, d.uid, d.pose_group = "validation", VALIDATION_BASE + d.uid, 0
        c.held_out_from_calibration = True
        c.notes.append("no validation dots were recorded: every third calibration dot is held out as validation instead (fewer dots to fit with)")
    if len(c.phase("calibration")) + len(c.phase("poses")) < 4:
        raise SweepError(f"only {len(c.phase('calibration'))} calibration dots: at least 4 are needed to fit anything")
    if not c.phase("calibration") and c.phase("poses"):
        g0 = min(d.pose_group for d in c.phase("poses"))
        for d in c.phase("poses"):
            if d.pose_group == g0:
                d.phase = "calibration"
    seg = c.segment
    if seg is not None and seg.n_rows:
        t = seg.times
        inside = sum(1 for d in c.dots if t[0] - 1 <= d.t0 <= t[-1] + 1)
        if inside < len(c.dots) * 0.5:
            raise SweepError(f"the dots' times ({min(d.t0 for d in c.dots):.1f}-{max(d.t1 for d in c.dots):.1f} s) do not match the recorded frames ({t[0]:.1f}-{t[-1]:.1f} s, engine clock)")
        if inside < len(c.dots):
            c.notes.append(f"{len(c.dots) - inside} dot(s) lie outside the recorded frames")
    if c.kind != "eye-capture" and c.folder.joinpath("stream.pgz1").exists():
        c.has_sim_truth = _stream_has_sim(c.folder)
    from .lab import _file_sig

    c.signature = _hash([_file_sig(c.folder / n) for n in ("stream.pgz1", "collect.json", "events.jsonl", "meta.json")] + [c.segment.name if c.segment is not None else None, len(c.dots)])


def _stream_has_sim(folder: Path) -> bool:
    from .replay import iter_messages

    try:
        for i, msg in enumerate(iter_messages(folder)):
            if msg.type == "frame" and isinstance(msg.header.get("sim"), dict):
                return True
            if i > 200:
                break
    except Exception:  # noqa: BLE001
        return False
    return False


# --------------------------------------------------------------------------------------------
# The search space
# --------------------------------------------------------------------------------------------

DEFAULT_CANDIDATES = ["geometric", "ridge", "kernel", "reflection", "blend"]
MODEL_SETUPS: dict[str, dict[str, Any]] = {
    "auto": {"models.candidates": DEFAULT_CANDIDATES, "models.pinned": ""},
    "geometric": {"models.candidates": ["geometric"], "models.pinned": "geometric"},
    "ridge": {"models.candidates": ["ridge"], "models.pinned": "ridge"},
    "kernel": {"models.candidates": ["kernel"], "models.pinned": "kernel"},
    "reflection": {"models.candidates": ["reflection"], "models.pinned": "reflection"},
    "hybrid": {"models.candidates": ["geometric", "reflection", "hybrid"], "models.pinned": "hybrid"},
    "blend": {"models.candidates": DEFAULT_CANDIDATES, "models.pinned": "blend"},
    "residual": {"models.candidates": ["residual"], "models.pinned": "residual"},
}
"""``auto`` is the live default: every candidate fitted, the calibration's own choice used."""

GEOMETRIC_LIKE = {"auto", "geometric", "hybrid", "blend", "residual"}
RIDGE_LIKE = {"auto", "ridge", "blend"}

FIT_AXES: dict[str, dict[str, Any]] = {
    # name: {"values": [default first, ...], "models": applicable model setups or None}
    "regularisation": {"values": ["auto", 0.1, 1.0, 10.0, 100.0], "models": RIDGE_LIKE},
    "models.kappa_prior_sd_deg": {"values": [2.5, 1.0, 5.0], "models": GEOMETRIC_LIKE},
    "models.eyeball_centre": {"values": ["estimator", "per_eye", "head", "auto"], "models": GEOMETRIC_LIKE},
    "models.eye": {"values": ["both", "left", "right", "auto"], "models": GEOMETRIC_LIKE},
    "calibration.sample_weighting": {"values": ["per_dot", "precision", "per_sample"], "models": None},
    "calibration.outlier_mad": {"values": [3.0, 2.0, 5.0], "models": None},
    "calibration.settle_ms": {"values": ["protocol", 300, 450], "models": None},
    "calibration.discard_ms": {"values": [150, 300, 500, 800], "models": None},
    "poses": {"values": [True, False], "models": None},
    "calibration.pursuit_merge": {"values": ["off", "auto", "on"], "models": None},
    "calibration.error_map": {"values": ["off", "affine", "quadratic"], "models": None},
    "filters.preset": {"values": ["custom", "responsive", "balanced", "steady"], "models": None},
}
"""Stage-2 axes. ``poses`` = fit on the head-position block too; ``regularisation`` = ridge alpha
chosen by grouped cross-validation (``auto``) or fixed."""

VISION_AXES: dict[str, list[Any]] = {
    "estimators.iris_fit": ["ellipse", "circle"],
    "estimators.iris_lid_mask_upper_deg": [0.0, 45.0],
    "estimators.iris_edge_keep": [0.35, 0.5, 0.2],
    "estimators.iris_min_confidence": [0.05, 0.2],
    "estimators.distance_source": ["auto", "iris", "head", "fixed"],
    "estimators.head_smoothing_s": [0.0, 0.2],
    "estimators.face_confidence": [0.3, 0.15],
    "estimators.face_tiles": [True, False],
    "estimators.reflection_k_mad": [5.0, 3.5],
}
"""Stage-1 axes besides the estimator chain (one at a time around the condition's settings)."""

REAL_CHAINS = ["default", "landmarks+iris_edge+quality", "landmarks+iris_edge+reflection+quality", "landmarks+quality"]
ORACLE_CHAINS = ["sim_oracle_2d", "sim_oracle"]


def fit_key(fit: dict[str, Any]) -> str:
    return _hash({k: v for k, v in sorted(fit.items())})


def _hash(data: Any) -> str:
    return hashlib.sha1(json.dumps(_jsonable(data), sort_keys=True, default=str).encode()).hexdigest()[:12]


def vision_id(v: dict[str, Any]) -> str:
    return _hash({"chain": v.get("chain", "default"), "changes": dict(sorted((v.get("changes") or {}).items()))})


def vision_name(v: dict[str, Any]) -> str:
    parts = [f"chain {v.get('chain', 'default')}"] + [f"{k.split('.', 1)[-1]}={json.dumps(_jsonable(x))}" for k, x in sorted((v.get("changes") or {}).items())]
    return ", ".join(parts)


def fit_name(fit: dict[str, Any]) -> str:
    out = [str(fit.get("model", "auto"))]
    for k, v in sorted(fit.items()):
        if k == "model":
            continue
        if k == "poses":
            out.append("with poses" if v else "no poses")
        else:
            out.append(f"{k.split('.', 1)[-1]}={json.dumps(_jsonable(v))}")
    return ", ".join(out)


def normalise_fit(fit: dict[str, Any], cond_has: dict[str, bool]) -> dict[str, Any]:
    """Drop axes that do not apply (to the model or to this run) and default values, so the
    same fit always has the same key."""
    model = fit.get("model", "auto")
    out: dict[str, Any] = {"model": model}
    for k, v in fit.items():
        if k == "model" or k not in FIT_AXES:
            continue
        ax = FIT_AXES[k]
        if ax["models"] is not None and model not in ax["models"]:
            continue
        if k == "poses" and not cond_has.get("poses"):
            continue
        if k == "calibration.pursuit_merge" and not cond_has.get("pursuit"):
            continue
        if k == "calibration.settle_ms" and not cond_has.get("settle"):
            continue
        if v == ax["values"][0]:
            continue
        out[k] = v
    return out


def fit_changes(fit: dict[str, Any]) -> dict[str, Any]:
    """The config changes a fit stands for (``poses`` and the model are mapped to settings)."""
    ch: dict[str, Any] = dict(MODEL_SETUPS[fit.get("model", "auto")])
    for k, v in fit.items():
        if k in ("model", "poses"):
            continue
        if k == "calibration.settle_ms" and v == "protocol":
            continue
        if k == "regularisation":
            if v == "auto":
                ch["models.auto_alpha"] = True
            else:
                ch["models.auto_alpha"] = False
                ch["models.ridge_alpha"] = float(v)
            continue
        ch[k] = v
    return ch


def full_space_size(cond_has: dict[str, bool], n_vision: int) -> int:
    """How many distinct (vision, fit) combinations exist for this condition."""
    total = 0
    for model in MODEL_SETUPS:
        n = 1
        for k, ax in FIT_AXES.items():
            if ax["models"] is not None and model not in ax["models"]:
                continue
            if (k == "poses" and not cond_has.get("poses")) or (k == "calibration.pursuit_merge" and not cond_has.get("pursuit")) or (k == "calibration.settle_ms" and not cond_has.get("settle")):
                continue
            n *= len(ax["values"])
        total += n
    return total * max(1, n_vision)


def vision_space(cond: Condition, mode: str) -> list[dict[str, Any]]:
    """Coarse vision combinations for one condition: the chains, then one setting at a time."""
    if mode == "oracle" or (mode == "auto" and cond.has_sim_truth and cond.kind == "collect" and _synthetic_images(cond)):
        return [{"chain": c, "changes": {}} for c in ORACLE_CHAINS]
    out = [{"chain": c, "changes": {}} for c in REAL_CHAINS]
    for k, vals in VISION_AXES.items():
        for v in vals[1:]:
            out.append({"chain": "default", "changes": {k: v}})
    if cond.kind == "eye-capture":
        for v in (20.0, 40.0):
            out.append({"chain": "default", "changes": {"stream.roi_width_mm": v}})
    if mode == "auto" and cond.has_sim_truth:
        out += [{"chain": c, "changes": {}} for c in ORACLE_CHAINS]
    return out


def _synthetic_images(cond: Condition) -> bool:
    """The synthetic test runs carry the truth and only a tiny grey picture (no eyes to find)."""
    from .replay import iter_messages

    try:
        for msg in iter_messages(cond.folder):
            if msg.type == "frame":
                parts = msg.header.get("parts") or []
                return all(int(p.get("width") or 0) <= 200 for p in parts)
    except Exception:  # noqa: BLE001
        return False
    return False


# --------------------------------------------------------------------------------------------
# Stage 1: observations
# --------------------------------------------------------------------------------------------


def condition_config(base: Config, cond: Condition, vision: dict[str, Any] | None = None, fit: dict[str, Any] | None = None, cache_dir: Path | None = None, every: int | None = None) -> Config:
    """The base config with the condition's recorded settings, a vision combination and a fit."""
    from .lab import _known_paths, apply_changes

    known = _known_paths()
    ch = {k: v for k, v in cond.settings.items() if k in known and k.split(".")[0] in ("estimators", "models", "calibration", "filters", "stream")}
    if vision:
        ch.update(vision.get("changes") or {})
    if fit:
        ch.update(fit_changes(fit))
    try:
        cfg = apply_changes(base, ch)
    except LabError:
        cfg = copy.deepcopy(base)  # a recorded setting this build no longer accepts: use defaults for it
        for k, v in ch.items():
            try:
                cfg = apply_changes(cfg, {k: v})
            except LabError:
                continue
    if cond.kind == "collect" and cond.settle_ms is not None and not (fit and isinstance(fit.get("calibration.settle_ms"), (int, float))):
        cfg.calibration.settle_ms = int(cond.settle_ms)  # the wait the Collect page used
    if cache_dir is not None:
        cfg.lab.output_dir = str(cache_dir)
    if every is not None:
        cfg.lab.every = int(every)
    cfg.lab.pursuit_skip_s = 0.5
    return cfg


def _lab_segment(cond: Condition) -> Any:
    """The condition as a lab segment: every frame inside a dot (no settling: stage 2 trims)."""
    from .lab import Dot

    seg = copy.copy(cond.segment)
    seg.dots = [Dot(dot_id=d.uid, x=d.x, y=d.y, t0=d.t0, t1=d.t1, kind="validate" if d.phase == "validation" else "grid") for d in sorted(cond.dots, key=lambda d: d.t0)]
    seg.pursuit = cond.pursuit
    seg.settle_override_s = 0.0
    seg.name = cond.segment.name
    return seg


@dataclass
class ObsSet:
    """Observations of one condition under one vision combination, in time order."""

    t: np.ndarray
    obs: list[Any]
    stats: dict[str, Any]


def observe(cond: Condition, vision: dict[str, Any], base: Config, cache_dir: Path, every: int) -> ObsSet:
    """Stage 1 for one (condition, vision): from the cache, or decoded and cached now."""
    from .lab import collect

    cfg = condition_config(base, cond, vision, cache_dir=cache_dir, every=every)
    seg = _lab_segment(cond)
    t0 = time.perf_counter()
    try:
        cols, _info = collect(cond.source, seg, cfg, [vision.get("chain", "default")], use_cache=True)
    except LabError as exc:
        raise SweepError(f"{cond.id}: {exc}") from exc
    col = cols[0]
    recs = sorted(col.records, key=lambda r: r.t)
    for r in recs:
        r.obs.t_local = r.t
    return ObsSet(t=np.array([r.t for r in recs], float), obs=[r.obs for r in recs], stats={"cached": bool(col.stats.get("cached")), "seconds": time.perf_counter() - t0, "frames": len(recs)})


# --------------------------------------------------------------------------------------------
# Stage 2: fit on calibration (and poses), score on validation
# --------------------------------------------------------------------------------------------


def _window(os_: ObsSet, t0: float, t1: float) -> list[Any]:
    i0 = int(np.searchsorted(os_.t, t0, side="left"))
    i1 = int(np.searchsorted(os_.t, t1, side="left"))
    return os_.obs[i0:i1]


def build_samples(cond: Condition, os_: ObsSet, cfg: Config) -> dict[str, Any]:
    """Cleaned samples per phase, as live calibration cleans a dot (``calibration.clean_dot``).

    Live, a dot is shown for ``settle_ms`` before collecting starts, then the first
    ``discard_ms`` of the collection are dropped. A collection run's dot times are when the dot
    appeared and disappeared, so both apply; a recorded calibration's windows already start
    after the settle."""
    from .calibration import clean_dot

    cal = cfg.calibration
    disc = float(cal.discard_ms) / 1000.0 + (float(cal.settle_ms) / 1000.0 if cond.kind == "collect" else 0.0)
    out: dict[str, Any] = {"calibration": [], "poses": [], "validation": [], "pursuit": [], "rejected": {}}
    for d in cond.dots:
        obs = _window(os_, d.t0 + disc, d.t1)
        kept, reason = clean_dot(obs, float(cal.outlier_mad), int(cal.min_samples), float(cal.stability_deg))
        if reason:
            out["rejected"][d.uid] = reason
            continue
        kind = "validate" if d.phase == "validation" else "grid"
        for o in kept:
            out[d.phase].append(CalibSample(target=(d.x, d.y), obs=o, kind=kind, dot_id=d.uid, run_id=cond.id, pose_group=d.pose_group, t_local=o.t_local))
    if cond.pursuit is not None and len(cond.pursuit) >= 2:
        p = cond.pursuit
        start, end = p[0, 0] + 0.5, p[-1, 0]
        obs = _window(os_, start, end)
        first: dict[int, tuple[float, float]] = {}
        for o in obs:
            b = int((o.t_local - start) / 0.25)
            if b not in first:
                first[b] = (float(np.interp(o.t_local, p[:, 0], p[:, 1])), float(np.interp(o.t_local, p[:, 0], p[:, 2])))
            out["pursuit"].append(CalibSample(target=first[b], obs=o, kind="pursuit", dot_id=b, run_id=cond.id + "-pursuit", t_local=o.t_local))
    return out


def _ppd(samples: list[CalibSample], screen: ScreenInfo) -> float:
    from .calibration import _points_per_degree

    return _points_per_degree(samples, screen)


def evaluate(cond: Condition, os_: ObsSet, base: Config, vision: dict[str, Any], fit: dict[str, Any]) -> dict[str, Any]:
    """Fit one setup on the training phases and score it on validation. Returns a result row."""
    from . import calibration as calib
    from .lab import apply_filter
    from .models import build_models
    from .models.base import BaseModel, error_stats, fit_samples

    t_start = time.perf_counter()
    cfg = condition_config(base, cond, vision, fit)
    row: dict[str, Any] = {"cond": cond.id, "vision": vision_id(vision), "fit": fit, "key": fit_key(fit), "v": SWEEP_VERSION, "rec": cond.signature}
    ss = build_samples(cond, os_, cfg)
    use_poses = bool(fit.get("poses", True)) and bool(ss["poses"])
    train = ss["calibration"] + (ss["poses"] if use_poses else [])
    val = ss["validation"]
    n_val_dots = len(cond.phase("validation"))
    row["train_dots"] = len({s.dot_id for s in train})
    row["rejected"] = len(ss["rejected"])
    # The rule this whole module rests on: nothing from validation reaches a fit.
    assert not any(s.kind == "validate" or s.dot_id >= VALIDATION_BASE for s in train)
    if row["train_dots"] < 4:
        row["error"] = f"only {row['train_dots']} usable training dots"
        row["seconds"] = time.perf_counter() - t_start
        return row
    merge = str(cfg.calibration.pursuit_merge)
    try:
        result = calib.fit_with_options(train, cond.screen, lambda: build_models(cfg.models), cfg.calibration, pursuit=ss["pursuit"] if merge != "off" else None)
    except Exception as exc:  # noqa: BLE001 - one bad fit must not stop the sweep
        row["error"] = f"fitting failed: {type(exc).__name__}: {exc}"
        row["seconds"] = time.perf_counter() - t_start
        return row
    name = cfg.models.pinned or result.chosen
    rep = next((r for r in result.reports if r.model == name), None)
    model = result.models.get(name) if name else None
    if rep is None or not rep.ok or model is None:
        row["error"] = f"{name or 'no model'} could not be fitted" + (f": {rep.message}" if rep is not None and rep.message else "")
        row["seconds"] = time.perf_counter() - t_start
        return row
    row["model_used"] = name
    if (result.info or {}).get("pursuit"):
        row["pursuit_merged"] = bool(result.info["pursuit"].get("merged"))
    params = rep.params or {}
    loo = rep.loo_error_deg
    # Calibration-only scores (they steer the search; validation never does).
    row["loo_deg"] = loo
    row["lopo_deg"] = params.get("lopo_error_deg") if use_poses else None
    cross = None
    if use_poses:
        cross = params.get("lopo_error_deg") if (params.get("lopo_coverage") or 0) >= calib.MIN_LOO_COVERAGE else None
    elif ss["poses"]:
        try:
            st = error_stats(ss["poses"], model.predict_samples(ss["poses"]), cond.screen, None)
            if st["n_valid"] >= 0.5 * max(st["n"], 1):
                cross = st["error_of_mean_deg"]
        except Exception:  # noqa: BLE001
            cross = None
    row["cross_pose_deg"] = cross
    sel = [v for v in (loo, cross) if v is not None]
    row["search_deg"] = max(sel) if sel else None
    # Error map, learned from the training dots' leave-one-dot-out errors (live learns it from
    # validation dots; here those are for scoring only).
    if str(cfg.calibration.error_map) != "off" and isinstance(model, BaseModel):
        row["error_map"] = _error_map_from_training(result, name, model, train, cond.screen, cfg)
    if not val:
        row["error"] = "no validation dot survived cleaning"
        row["seconds"] = time.perf_counter() - t_start
        return row
    try:
        pred = model.predict_samples(val)
    except Exception as exc:  # noqa: BLE001
        row["error"] = f"prediction failed: {exc}"
        row["seconds"] = time.perf_counter() - t_start
        return row
    st = error_stats(val, pred, cond.screen, None)
    filt = apply_filter(pred, val, cfg, cond.screen)
    fs = error_stats(val, filt, cond.screen, None)
    mx, my = cond.screen.mm_per_point or (float("nan"), float("nan"))
    per = []
    t_of = {d.uid: d.t0 for d in cond.dots}
    for d in st["per_dot"]:
        if d.get("mean") is None or d.get("error_deg") is None:
            continue
        idx = [i for i, s in enumerate(val) if s.dot_id == d["dot_id"]]
        dist = [val[i].obs.distance for i in idx if val[i].obs.distance]
        dm = float(np.median(dist)) * 1000.0 if dist else float("nan")
        dx = math.degrees(math.atan2((d["mean"][0] - d["target"][0]) * mx, dm))
        dy = math.degrees(math.atan2((d["mean"][1] - d["target"][1]) * my, dm))
        per.append([int(d["dot_id"]), round(float(d["error_deg"]), 4), round(dx, 4), round(dy, 4), round(d["target"][0], 1), round(d["target"][1], 1), round(t_of.get(int(d["dot_id"]), 0.0), 3)])
    row["per_dot"] = per
    row["coverage"] = len(per) / max(n_val_dots, 1)
    row["acc_deg"] = float(np.mean([p[1] for p in per])) if per else None
    row["prec_deg"] = fs["precision_deg"]
    row["sample_deg"] = fs["error_deg"]
    row["seconds"] = time.perf_counter() - t_start
    _ = fit_samples  # (validation samples are kind "validate": fit_samples would drop them too)
    return row


def _error_map_from_training(result: Any, name: str, model: Any, train: list[CalibSample], screen: ScreenInfo, cfg: Config) -> dict[str, Any]:
    from .lab import loo_by_model
    from .models.errormap import fit_error_map

    try:
        loo = loo_by_model(result, train, screen).get(name)
    except Exception as exc:  # noqa: BLE001
        return {"kept": False, "reason": f"failed: {exc}"}
    if loo is None:
        return {"kept": False, "reason": "no leave-one-dot-out predictions"}
    by: dict[int, list[int]] = {}
    for i, s in enumerate(train):
        if np.all(np.isfinite(loo[i])):
            by.setdefault(int(s.dot_id), []).append(i)
    if len(by) < 5:
        return {"kept": False, "reason": "too few dots"}
    pred = np.array([loo[idx].mean(axis=0) for idx in by.values()])
    target = np.array([train[idx[0]].target for idx in by.values()], float)
    size = model.screen_size or (float(screen.width), float(screen.height))
    emap, info = fit_error_map(pred, target, size, str(cfg.calibration.error_map), float(cfg.calibration.error_map_smoothing), float(cfg.calibration.error_map_min_gain))
    model.error_map = emap
    return {"kept": emap is not None, **{k: v for k, v in info.items() if isinstance(v, (int, float, str, bool)) or v is None}}


def _fps(cond: Condition) -> float | None:
    seg = cond.segment
    if seg is None or seg.n_rows < 3:
        return None
    dt = np.diff(np.asarray(seg.times, float))
    dt = dt[np.isfinite(dt) & (dt > 0)]
    return float(1.0 / np.median(dt)) if len(dt) else None


# --------------------------------------------------------------------------------------------
# Workers (separate processes: all CPU cores)
# --------------------------------------------------------------------------------------------

_W: dict[str, Any] = {}


def _worker_init(conditions: list[Condition], base: Config, cache_dir: str, every: int) -> None:
    from .lab import quiet_native_logs

    quiet_native_logs()
    logging.basicConfig(level=logging.WARNING)
    _W.clear()
    _W.update(conds={c.id: c for c in conditions}, base=base, cache=Path(cache_dir), every=every, obs={})


def _obsset(cond_id: str, vision: dict[str, Any]) -> ObsSet:
    key = (cond_id, vision_id(vision))
    memo: dict[Any, ObsSet] = _W["obs"]
    if key not in memo:
        if len(memo) >= 8:
            memo.pop(next(iter(memo)))
        memo[key] = observe(_W["conds"][cond_id], vision, _W["base"], _W["cache"], _W["every"])
    return memo[key]


def _job_observe(cond_id: str, vision: dict[str, Any]) -> dict[str, Any]:
    try:
        os_ = _obsset(cond_id, vision)
        return {"cond": cond_id, "vision": vision_id(vision), "ok": True, **os_.stats}
    except Exception as exc:  # noqa: BLE001 - reported, the sweep goes on
        return {"cond": cond_id, "vision": vision_id(vision), "ok": False, "error": f"{type(exc).__name__}: {exc}" if not isinstance(exc, LabError) else str(exc)}


def _job_diagnose(cond_id: str, vision: dict[str, Any], row: dict[str, Any] | None, fit: dict[str, Any] | None) -> dict[str, Any]:
    from .signal_report import diagnose_condition

    cond = _W["conds"][cond_id]
    try:
        os_ = _obsset(cond_id, vision)
        if row is None and fit is not None:
            row = evaluate(cond, os_, _W["base"], vision, fit)
        return diagnose_condition(cond, os_, _W["base"], vision, row, fit if row is not None and not row.get("error") else None)
    except Exception as exc:  # noqa: BLE001 - reported in the diagnosis
        log.exception("diagnosis of %s failed", cond_id)
        return {"id": cond_id, "label": cond.label, "camera_id": cond.camera_id, "zoom": cond.zoom, "verdict": f"the diagnosis failed: {type(exc).__name__}: {exc}", "next_step": "report this with the recording's session.json", "findings": []}


def _job_fit(cond_id: str, vision: dict[str, Any], fit: dict[str, Any]) -> dict[str, Any]:
    try:
        return evaluate(_W["conds"][cond_id], _obsset(cond_id, vision), _W["base"], vision, fit)
    except Exception as exc:  # noqa: BLE001
        return {"cond": cond_id, "vision": vision_id(vision), "fit": fit, "key": fit_key(fit), "v": SWEEP_VERSION, "rec": _W["conds"][cond_id].signature, "error": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------------------------
# The search
# --------------------------------------------------------------------------------------------


def _score(row: dict[str, Any] | None) -> float:
    v = None if row is None or row.get("error") else row.get("search_deg")
    return float(v) if v is not None and math.isfinite(v) else float("inf")


class Sweep:
    """One sweep: inputs, budgets, the result store (``results.jsonl``) and the progress file
    (``state.json``). :meth:`run` does everything and returns the leaderboard."""

    def __init__(self, inputs: Inputs, base: Config, out_dir: Path, *, minutes: float = 45.0, max_combos: int = 400, workers: int | None = None, vision_mode: str = "auto", every: int | None = None, max_vision: int = 16, progress: Any = None, seed: int = 0, models: list[str] | None = None) -> None:
        self.inputs = inputs
        self.base = base
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.cache_dir = self.out.parent / "cache"
        self.minutes = float(minutes)
        self.max_combos = int(max_combos)
        self.workers = max(1, int(workers or os.cpu_count() or 1))
        self.vision_mode = vision_mode
        if every is None:
            # every other frame at 30 fps; every frame when a recording is slower (dots would be
            # left with too few samples to keep)
            fps = [_fps(c) for c in inputs.conditions]
            slow = any(f is not None and f < 20 for f in fps)
            every = 1 if slow else int(base.lab.every)
        self.every = int(every)
        self.max_vision = int(max_vision)
        bad = [m for m in models or [] if m not in MODEL_SETUPS]
        if bad:
            raise SweepError(f"unknown model setup(s) {', '.join(bad)}; known: {', '.join(MODEL_SETUPS)}")
        self.models = list(models or MODEL_SETUPS)
        self.progress = progress or (lambda s: None)
        self.rng = random.Random(seed)
        self.conds = {c.id: c for c in inputs.conditions}
        self.has = {c.id: {"poses": bool(c.phase("poses")), "pursuit": c.pursuit is not None, "settle": c.kind == "collect"} for c in inputs.conditions}
        self.visions: dict[str, dict[str, dict[str, Any]]] = {c.id: {} for c in inputs.conditions}
        self.obs_stats: dict[tuple[str, str], dict[str, Any]] = {}
        self.results: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.t_start = time.time()
        self.deadline = self.t_start + self.minutes * 60.0
        self.stopped_by: str | None = None
        self.done = 0
        self.fit_seconds: list[float] = []
        self.resumed = 0
        self.no_state = False  # the diagnose command borrows the pool without touching a sweep's state
        self._pool: Any = None
        self._load()

    # -- persistence ----------------------------------------------------------------------

    @property
    def results_path(self) -> Path:
        return self.out / "results.jsonl"

    def _load(self) -> None:
        if not self.results_path.exists():
            return
        with open(self.results_path, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue  # a line cut short by an interruption
                if r.get("v") != SWEEP_VERSION or r.get("cond") not in self.conds or r.get("rec") != self.conds[r["cond"]].signature:
                    continue  # another version, or the recording changed since
                self.results[(r["cond"], r["vision"], r["key"])] = r
        self.resumed = len(self.results)

    def _append(self, row: dict[str, Any]) -> None:
        with open(self.results_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(_jsonable(row)) + "\n")

    def state(self, **kw: Any) -> None:
        if self.no_state:
            return
        path = self.out / "state.json"
        try:
            cur = json.loads(path.read_text()) if path.exists() else {}
        except (OSError, ValueError):
            cur = {}
        cur.update(kw)
        cur.update(updated=_dt.datetime.now().isoformat(timespec="seconds"), pid=os.getpid(), name=self.inputs.name, elapsed_s=round(time.time() - self.t_start, 1))
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(_jsonable(cur), indent=2))
        tmp.replace(path)

    # -- budgets --------------------------------------------------------------------------

    def n_evaluated(self, cond_id: str) -> int:
        return sum(1 for k in self.results if k[0] == cond_id)

    def out_of_time(self) -> bool:
        return time.time() >= self.deadline

    def _eta(self, remaining: int) -> float | None:
        if not self.fit_seconds:
            return None
        per = float(np.mean(self.fit_seconds[-200:])) / self.workers
        return min(max(0.0, self.deadline - time.time()), per * remaining)

    # -- execution ------------------------------------------------------------------------

    def _executor(self) -> Any:
        import concurrent.futures as cf
        import multiprocessing as mp

        if self.workers == 1:
            return None
        # One thread per process: numpy's BLAS threads in every worker oversubscribe the cores
        # (a fit took 40 times longer that way).
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
            os.environ[var] = "1"
        return cf.ProcessPoolExecutor(max_workers=self.workers, mp_context=mp.get_context("spawn"), initializer=_worker_init, initargs=(self.inputs.conditions, self.base, str(self.cache_dir), self.every))

    def _map(self, fn: Any, calls: list[tuple[Any, ...]], on_result: Any) -> None:
        """Run ``fn(*call)`` for every call (in the pool, or here with one worker) and hand each
        result to ``on_result`` as it arrives. Stops submitting once out of time."""
        if not calls:
            return
        if self._pool is None:
            if _W.get("owner") != id(self):
                _worker_init(self.inputs.conditions, self.base, str(self.cache_dir), self.every)
                _W["owner"] = id(self)
            for c in calls:
                if self.out_of_time():
                    self.stopped_by = "time"
                    break
                on_result(fn(*c))
            return
        import concurrent.futures as cf

        pending = set()
        it = iter(calls)
        for c in it:
            pending.add(self._pool.submit(fn, *c))
            if len(pending) >= self.workers * 3:
                break
        while pending:
            done, pending = cf.wait(pending, timeout=5.0, return_when=cf.FIRST_COMPLETED)
            for f in done:
                on_result(f.result())
            if self.out_of_time():
                self.stopped_by = "time"
                for f in pending:
                    f.cancel()
                for f in pending:
                    if not f.cancelled():
                        try:
                            on_result(f.result())
                        except Exception:  # noqa: BLE001
                            pass
                return
            for c in it:
                pending.add(self._pool.submit(fn, *c))
                if len(pending) >= self.workers * 3:
                    break

    def observe_all(self, wanted: list[tuple[str, dict[str, Any]]]) -> None:
        todo = []
        for cid, v in wanted:
            vid = vision_id(v)
            self.visions[cid].setdefault(vid, v)
            if (cid, vid) not in self.obs_stats:
                todo.append((cid, v))
        total = len(todo)
        count = [0]

        def got(r: dict[str, Any]) -> None:
            count[0] += 1
            self.obs_stats[(r["cond"], r["vision"])] = r
            if not r.get("ok"):
                self.progress(f"  {r['cond']}: {vision_name(self.visions[r['cond']][r['vision']])}: {r.get('error')}")
            self.state(stage="observations", done=count[0], total=total, message=f"observations: {count[0]} of {total} (condition, vision) sets")

        self.progress(f"Stage 1: {total} observation set(s) (condition x vision settings)")
        self._map(_job_observe, todo, got)
        new = [self.obs_stats[(c, vision_id(v))] for c, v in todo if (c, vision_id(v)) in self.obs_stats]
        if new:
            self.progress(f"  {sum(1 for r in new if r.get('cached'))} read from the cache, {sum(1 for r in new if r.get('ok') and not r.get('cached'))} decoded now, {sum(1 for r in new if not r.get('ok'))} failed")

    def usable_visions(self, cid: str) -> list[dict[str, Any]]:
        return [self.visions[cid][vid] for (c, vid), s in self.obs_stats.items() if c == cid and s.get("ok") and s.get("frames")]

    def fit_batch(self, tasks: list[tuple[str, dict[str, Any], dict[str, Any]]], label: str) -> list[dict[str, Any]]:
        """Evaluate (condition, vision, fit) tasks not done yet, within each condition's cap."""
        seen: set[tuple[str, str, str]] = set()
        todo: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
        count = {cid: self.n_evaluated(cid) for cid in self.conds}
        out: list[dict[str, Any]] = []
        for cid, v, fit in tasks:
            fit = normalise_fit(fit, self.has[cid])
            k = (cid, vision_id(v), fit_key(fit))
            if k in seen:
                continue
            seen.add(k)
            if k in self.results:
                out.append(self.results[k])
                continue
            if count[cid] >= self.max_combos:
                self.stopped_by = self.stopped_by or "cap"
                continue
            count[cid] += 1
            todo.append((cid, v, fit))
        if not todo or self.out_of_time():
            if todo:
                self.stopped_by = "time"
            return out
        total = len(todo)
        n = [0]

        def got(r: dict[str, Any]) -> None:
            n[0] += 1
            self.done += 1
            r["vision_def"] = self.visions[r["cond"]].get(r["vision"])
            self.results[(r["cond"], r["vision"], r["key"])] = r
            self._append(r)
            out.append(r)
            if r.get("seconds"):
                self.fit_seconds.append(float(r["seconds"]))
            eta = self._eta(total - n[0])
            self.state(stage="fitting", phase=label, done=n[0], total=total, evaluated=len(self.results), eta_s=None if eta is None else round(eta), message=f"{label}: {n[0]} of {total}")

        self.progress(f"  {label}: {total} setup(s) to fit")
        self._map(_job_fit, todo, got)
        return out

    def best(self, cid: str, k: int = 1, vid: str | None = None) -> list[dict[str, Any]]:
        rows = [r for (c, v, _), r in self.results.items() if c == cid and (vid is None or v == vid) and _score(r) < float("inf")]
        rows.sort(key=lambda r: (_score(r), r["key"]))
        return rows[:k]

    # -- the plan -------------------------------------------------------------------------

    def run(self, diagnose: bool = True) -> dict[str, Any]:
        self._pool = self._executor()
        self.state(stage="starting", started=_dt.datetime.now().isoformat(timespec="seconds"), finished=None, error=None, minutes=self.minutes, max_combos=self.max_combos, workers=self.workers, conditions=[c.describe() for c in self.inputs.conditions], resumed=self.resumed)
        try:
            self._search()
            self.state(stage="reports", message="writing the leaderboard")
            board = build_leaderboard(self)
            if diagnose:
                tasks = {}
                for cid, cond in self.conds.items():
                    top = top_by_validation(self, cid, 1)
                    row = top[0] if top else None
                    vision = (row or {}).get("vision_def") or vision_space(cond, self.vision_mode)[0]
                    tasks[cid] = (cid, vision, row, (row or {}).get("fit"))
                board["diagnosis"] = {"conditions": self.diagnose_all(list(tasks.values()))}
        finally:
            if self._pool is not None:
                self._pool.shutdown(wait=True, cancel_futures=True)
                self._pool = None
        return board

    def diagnose_all(self, tasks: list[tuple[str, dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]]) -> list[dict[str, Any]]:
        """The diagnosis of each (condition, vision, row, fit), in the pool; with no row, the fit
        is evaluated first. In the order of ``tasks``."""
        got: dict[str, dict[str, Any]] = {}
        n = [0]

        def done(d: dict[str, Any]) -> None:
            n[0] += 1
            got[d["id"]] = d
            self.state(stage="reports", message=f"diagnosing: {n[0]} of {len(tasks)} conditions")

        deadline, self.deadline = self.deadline, float("inf")  # the diagnosis always runs
        try:
            self._map(_job_diagnose, tasks, done)
        finally:
            self.deadline = deadline
        return [got[t[0]] for t in tasks if t[0] in got]

    def _search(self) -> None:
        conds = list(self.conds.values())
        # Stage 1, coarse: every chain and one vision setting at a time.
        wanted = []
        for c in conds:
            for v in vision_space(c, self.vision_mode)[: self.max_vision]:
                wanted.append((c.id, v))
        # Stage 1 may use at most 40 % of the time: the chains come first in the list, so a
        # cut keeps them and drops single vision settings.
        full, self.deadline = self.deadline, min(self.deadline, self.t_start + 0.4 * self.minutes * 60.0)
        try:
            self.observe_all(wanted)
        finally:
            self.deadline = full
        missing = sum(1 for cid, v in wanted if (cid, vision_id(v)) not in self.obs_stats)
        if missing:
            self.stopped_by = None
            self.inputs.notes.append(f"stage 1 used its share of the time (40 %): {missing} of {len(wanted)} vision combinations were not tried; give the sweep more --minutes, or fewer --max-vision")
            self.progress(f"  {missing} vision combination(s) skipped for time")
        # Stage 2, A: every model, with and without poses, under every vision combination.
        models = list(self.models)
        tasks = []
        for c in conds:
            for v in self.usable_visions(c.id):
                for m in models:
                    for poses in ([True, False] if self.has[c.id]["poses"] else [True]):
                        tasks.append((c.id, v, {"model": m, "poses": poses}))
        self.progress("Stage 2: fitting on calibration, scoring on validation")
        self.fit_batch(tasks, "coarse: models x poses x vision")
        # Vision refinement: combine the single vision changes that helped.
        self._refine_vision(conds)
        # B: one setting at a time around the best three.
        tasks = []
        self.anchors: dict[str, list[dict[str, Any]]] = {}
        for c in conds:
            self.anchors[c.id] = self.best(c.id, 3)
            for anchor in self.anchors[c.id]:
                v = anchor["vision_def"] or self.visions[c.id][anchor["vision"]]
                for axis, ax in FIT_AXES.items():
                    if axis == "poses":
                        continue
                    for val in ax["values"][1:]:
                        tasks.append((c.id, v, {**anchor["fit"], axis: val}))
        self.fit_batch(tasks, "one setting at a time")
        # C: greedy combination, then random local moves, until the cap, the time or no gain.
        stale = {c.id: 0 for c in conds}
        for rnd in range(200):
            if self.out_of_time():
                self.stopped_by = "time"
                break
            tasks = []
            for c in conds:
                if stale[c.id] >= 3 or self.n_evaluated(c.id) >= self.max_combos:
                    continue
                tasks += self._neighbours(c.id, greedy=(rnd == 0))
            if not tasks:
                break
            before = {c.id: _score((self.best(c.id) or [None])[0]) for c in conds}
            self.fit_batch(tasks, f"refine round {rnd + 1}")
            for c in conds:
                after = _score((self.best(c.id) or [None])[0])
                stale[c.id] = 0 if after < before[c.id] - 1e-6 else stale[c.id] + 1
        # Confirmation across repeats: each condition's top setups on its repeats.
        groups: dict[str, list[str]] = {}
        for c in conds:
            groups.setdefault(c.setup_key, []).append(c.id)
        tasks = []
        for ids in groups.values():
            if len(ids) < 2:
                continue
            for cid in ids:
                for r in top_by_validation(self, cid, 3):
                    for other in ids:
                        if other != cid and (other, r["vision"], r["key"]) not in self.results:
                            v = r["vision_def"] or self.visions[cid][r["vision"]]
                            self.visions[other].setdefault(r["vision"], v)
                            if (other, r["vision"]) not in self.obs_stats:
                                self.observe_all([(other, v)])
                            tasks.append((other, v, r["fit"]))
        if tasks:
            saved, self.max_combos = self.max_combos, self.max_combos + len(tasks)
            self.fit_batch(tasks, "confirm on repeats")
            self.max_combos = saved

    def _refine_vision(self, conds: list[Condition]) -> None:
        for c in conds:
            per_v: dict[str, float] = {}
            for vid in self.visions[c.id]:
                b = self.best(c.id, 1, vid)
                if b:
                    per_v[vid] = _score(b[0])
            base_vid = next((vid for vid, v in self.visions[c.id].items() if not v.get("changes")), None)
            if base_vid is None or base_vid not in per_v:
                continue
            base_chain = self.visions[c.id][base_vid].get("chain", "default")
            better = sorted((s, vid) for vid, s in per_v.items() if self.visions[c.id][vid].get("changes") and self.visions[c.id][vid].get("chain", "default") == base_chain and s < per_v[base_vid] * 0.98)
            if len(better) < 2:
                continue
            merged: dict[str, Any] = {}
            for _, vid in better[:3]:
                for k, v in self.visions[c.id][vid]["changes"].items():
                    merged.setdefault(k, v)
            nv = {"chain": base_chain, "changes": merged}
            self.observe_all([(c.id, nv)])
            if (c.id, vision_id(nv)) in self.obs_stats and self.obs_stats[(c.id, vision_id(nv))].get("ok"):
                tasks = [(c.id, nv, r["fit"]) for r in self.best(c.id, 4)]
                self.fit_batch(tasks, "combined vision settings")

    def _neighbours(self, cid: str, greedy: bool) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
        best = self.best(cid, 1)
        if not best:
            return []
        b = best[0]
        v = b["vision_def"] or self.visions[cid][b["vision"]]
        base_fit = dict(b["fit"])
        model = base_fit.get("model", "auto")
        out = []
        if greedy:
            # around each anchor of the one-at-a-time pass: every single change that helped it,
            # all together
            for anchor in getattr(self, "anchors", {}).get(cid, []):
                afit = anchor["fit"]
                helped: dict[str, Any] = {}
                for (c, vid, _), r in self.results.items():
                    if c != cid or vid != anchor["vision"] or _score(r) >= _score(anchor):
                        continue
                    diff = {k: x for k, x in r["fit"].items() if afit.get(k) != x}
                    gone = [k for k in afit if k not in r["fit"]]
                    if len(diff) + len(gone) == 1 and diff:
                        helped.update(diff)
                if len(helped) > 1:
                    av = anchor["vision_def"] or self.visions[cid][anchor["vision"]]
                    out.append((cid, av, {**afit, **helped}))
        axes = [a for a, ax in FIT_AXES.items() if ax["models"] is None or model in ax["models"]]
        if not self.has[cid]["poses"]:
            axes = [a for a in axes if a != "poses"]
        if not self.has[cid]["pursuit"]:
            axes = [a for a in axes if a != "calibration.pursuit_merge"]
        if not self.has[cid]["settle"]:
            axes = [a for a in axes if a != "calibration.settle_ms"]
        tries = 0
        while len(out) < self.workers * 2 and tries < 60:
            tries += 1
            fit = dict(base_fit)
            for a in self.rng.sample(axes, k=min(len(axes), self.rng.choice([1, 2, 2, 3]))):
                fit[a] = self.rng.choice(FIT_AXES[a]["values"])
            if self.rng.random() < 0.15:
                fit["model"] = self.rng.choice(self.models)
            nf = normalise_fit(fit, self.has[cid])
            if (cid, vision_id(v), fit_key(nf)) not in self.results and nf != normalise_fit(base_fit, self.has[cid]):
                out.append((cid, v, nf))
        return out


# --------------------------------------------------------------------------------------------
# Honest scoring: split validation dots, bootstrap intervals, "within noise"
# --------------------------------------------------------------------------------------------


def bootstrap_ci(values: list[float] | np.ndarray, n_boot: int = 2000, seed: int = 0, level: float = 0.95) -> tuple[float, float] | None:
    """Percentile bootstrap interval of the mean (resampling dots)."""
    v = np.asarray([x for x in values if x is not None and math.isfinite(x)], float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    means = v[rng.integers(0, len(v), size=(n_boot, len(v)))].mean(axis=1)
    a = (1 - level) / 2 * 100
    lo, hi = np.percentile(means, [a, 100 - a])
    return float(lo), float(hi)


def split_dots(cond: Condition) -> tuple[set[int], set[int]]:
    """Validation dots in time order, alternately to the ranking half (A) and the confirmation
    half (B), so both halves span the session and the screen."""
    v = sorted(cond.phase("validation"), key=lambda d: d.t0)
    return {d.uid for i, d in enumerate(v) if i % 2 == 0}, {d.uid for i, d in enumerate(v) if i % 2 == 1}


def _mean_over(row: dict[str, Any], uids: set[int]) -> float | None:
    vals = [p[1] for p in row.get("per_dot") or [] if p[0] in uids]
    return float(np.mean(vals)) if vals else None


def eligible(row: dict[str, Any]) -> bool:
    return not row.get("error") and row.get("acc_deg") is not None and (row.get("coverage") or 0) >= MIN_COVERAGE


def top_by_validation(sw: Sweep, cid: str, k: int = 10) -> list[dict[str, Any]]:
    a, _ = split_dots(sw.conds[cid])
    rows = [r for (c, _, _), r in sw.results.items() if c == cid and eligible(r)]
    rows.sort(key=lambda r: (_mean_over(r, a) if _mean_over(r, a) is not None else float("inf"), r["acc_deg"], r["key"]))
    return rows[:k]


REGIONS = [["top left", "top", "top right"], ["left", "middle", "right"], ["bottom left", "bottom", "bottom right"]]


def breakdown(row: dict[str, Any], screen: ScreenInfo) -> dict[str, Any]:
    """Horizontal versus vertical, and error by screen region, from the per-dot results."""
    per = row.get("per_dot") or []
    out: dict[str, Any] = {"horizontal_deg": None, "vertical_deg": None, "offset_deg": None, "regions": {}}
    if not per:
        return out
    dx = np.array([p[2] for p in per], float)
    dy = np.array([p[3] for p in per], float)
    out["horizontal_deg"] = float(np.nanmean(np.abs(dx)))
    out["vertical_deg"] = float(np.nanmean(np.abs(dy)))
    out["offset_deg"] = [float(np.nanmean(dx)), float(np.nanmean(dy))]
    reg: dict[str, list[float]] = {}
    for p in per:
        c = min(2, max(0, int(p[4] / max(screen.width, 1) * 3)))
        r = min(2, max(0, int(p[5] / max(screen.height, 1) * 3)))
        reg.setdefault(REGIONS[r][c], []).append(p[1])
    out["regions"] = {k: round(float(np.mean(v)), 3) for k, v in reg.items()}
    return out


def _paired(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    from .tune import paired

    ea = {str(p[0]): float(p[1]) for p in a.get("per_dot") or []}
    eb = {str(p[0]): float(p[1]) for p in b.get("per_dot") or []}
    return paired(ea, eb, n_boot=2000)


def _row_summary(sw: Sweep, row: dict[str, Any], a: set[int], b: set[int]) -> dict[str, Any]:
    cond = sw.conds[row["cond"]]
    vals = [p[1] for p in row.get("per_dot") or []]
    ci = bootstrap_ci(vals)
    v = row.get("vision_def") or sw.visions[row["cond"]].get(row["vision"]) or {}
    return {
        "cond": row["cond"],
        "vision": v,
        "vision_name": vision_name(v),
        "fit": row["fit"],
        "fit_name": fit_name(row["fit"]),
        "model_used": row.get("model_used"),
        "acc_deg": row.get("acc_deg"),
        "ci": list(ci) if ci else None,
        "rank_deg": _mean_over(row, a),
        "confirm_deg": _mean_over(row, b),
        "prec_deg": row.get("prec_deg"),
        "sample_deg": row.get("sample_deg"),
        "search_deg": row.get("search_deg"),
        "loo_deg": row.get("loo_deg"),
        "cross_pose_deg": row.get("cross_pose_deg"),
        "coverage": row.get("coverage"),
        "n_dots": len(vals),
        **breakdown(row, cond.screen),
    }


def build_leaderboard(sw: Sweep) -> dict[str, Any]:
    board: dict[str, Any] = {
        "format": "phonegaze-sweep-1",
        "name": sw.inputs.name,
        "root": str(sw.inputs.root),
        "output_dir": str(sw.out),
        "created": _dt.datetime.now().isoformat(timespec="seconds"),
        "minutes_budget": sw.minutes,
        "max_combos": sw.max_combos,
        "elapsed_s": round(time.time() - sw.t_start, 1),
        "stopped_by": sw.stopped_by,
        "workers": sw.workers,
        "evaluated": len(sw.results),
        "resumed": sw.resumed,
        "notes": list(sw.inputs.notes),
        "conditions": [],
        "cameras": [],
        "overall": None,
        "repeats": [],
    }
    winners: list[dict[str, Any]] = []
    for cid, cond in sw.conds.items():
        a, b = split_dots(cond)
        rows = [r for (c, _, _), r in sw.results.items() if c == cid]
        n_vis = len([1 for (c, _), s in sw.obs_stats.items() if c == cid and s.get("ok")]) or len({r["vision"] for r in rows})
        space = full_space_size(sw.has[cid], n_vis)
        tried: dict[str, set[str]] = {}
        for r in rows:
            for k, x in r["fit"].items():
                tried.setdefault(k, set()).add(json.dumps(_jsonable(x)))
        entry: dict[str, Any] = {
            **cond.describe(),
            "evaluated": len(rows),
            "failed": sum(1 for r in rows if r.get("error")),
            "not_ranked": sum(1 for r in rows if not r.get("error") and not eligible(r)),
            "space": space,
            "space_share": len(rows) / space if space else None,
            "visions_tried": n_vis,
            "values_tried": {k: sorted(v) for k, v in tried.items()},
            "errors": sorted({str(r.get("error"))[:160] for r in rows if r.get("error")})[:8],
            "split": {"rank_dots": len(a), "confirm_dots": len(b)},
            "top": [],
        }
        board["conditions"].append(entry)
        top = top_by_validation(sw, cid, 10)
        if not top:
            entry["message"] = "no setup could be scored on this condition's validation dots" + (
                f" ({entry['not_ranked']} predicted fewer than {MIN_COVERAGE:.0%} of them: too few usable frames per dot?)" if entry["not_ranked"] else (f" ({entry['errors'][0]})" if entry["errors"] else "")
            )
            continue
        win = top[0]
        for i, r in enumerate(top):
            s = _row_summary(sw, r, a, b)
            s["rank"] = i + 1
            if i:
                d = _paired(win, r)
                s["vs_best"] = {"mean": d.get("mean"), "ci": d.get("ci"), "p": d.get("p")}
                s["within_noise"] = d.get("ci") is None or d["ci"][0] <= 0.0
            entry["top"].append(s)
        w = entry["top"][0]
        entry["winner"] = w
        entry["optimism_deg"] = (w["confirm_deg"] - w["rank_deg"]) if w["confirm_deg"] is not None and w["rank_deg"] is not None else None
        entry["n_within_noise"] = sum(1 for s in entry["top"][1:] if s.get("within_noise"))
        # what the defaults give, and what the calibration-only search alone would have picked
        defaults = [r for r in rows if eligible(r) and r["fit"] == {"model": "auto"} and not (r.get("vision_def") or {}).get("changes") and (r.get("vision_def") or {}).get("chain") in ("default", ORACLE_CHAINS[0])]
        if defaults:
            entry["defaults"] = _row_summary(sw, defaults[0], a, b)
        by_search = sorted([r for r in rows if eligible(r) and r.get("search_deg") is not None], key=lambda r: (r["search_deg"], r["key"]))
        if by_search:
            entry["search_pick"] = _row_summary(sw, by_search[0], a, b)
        winners.append({**w, "condition": cid, "label": cond.label, "camera_id": cond.camera_id, "camera_label": cond.camera_label, "zoom": cond.zoom, "_row": win})
    # per camera and overall: the condition whose winner holds up best on all its dots
    cams: dict[str, list[dict[str, Any]]] = {}
    for w in winners:
        cams.setdefault(w["camera_id"], []).append(w)
    for cam, ws in cams.items():
        ws.sort(key=lambda w: (w["acc_deg"], w["condition"]))
        best = ws[0]
        e = {k: v for k, v in best.items() if k != "_row"}
        if len(ws) > 1:
            e["runner_up"] = {"condition": ws[1]["condition"], "acc_deg": ws[1]["acc_deg"], "ci": ws[1]["ci"]}
            e["within_noise_of_runner_up"] = _overlap(best["ci"], ws[1]["ci"])
        board["cameras"].append(e)
    if winners:
        ws = sorted(winners, key=lambda w: (w["acc_deg"], w["condition"]))
        o = {k: v for k, v in ws[0].items() if k != "_row"}
        if len(ws) > 1:
            o["runner_up"] = {"condition": ws[1]["condition"], "label": ws[1]["label"], "acc_deg": ws[1]["acc_deg"], "ci": ws[1]["ci"]}
            o["within_noise_of_runner_up"] = _overlap(ws[0]["ci"], ws[1]["ci"])
        board["overall"] = o
        board["_overall_row"] = ws[0]["_row"]
    # repeats: a winner ranked on one recording, scored on the others of the same setup
    groups: dict[str, list[str]] = {}
    for c in sw.conds.values():
        groups.setdefault(c.setup_key, []).append(c.id)
    for ids in groups.values():
        if len(ids) < 2:
            continue
        for cid in ids:
            t = top_by_validation(sw, cid, 1)
            if not t:
                continue
            others = []
            for o in ids:
                if o == cid:
                    continue
                r = sw.results.get((o, t[0]["vision"], t[0]["key"]))
                best_o = top_by_validation(sw, o, 1)
                others.append({"condition": o, "acc_deg": r.get("acc_deg") if r else None, "best_there_deg": best_o[0]["acc_deg"] if best_o else None})
            board["repeats"].append({"ranked_on": cid, "setup": fit_name(t[0]["fit"]) + " / " + vision_name(t[0].get("vision_def") or {}), "acc_deg": t[0]["acc_deg"], "on_repeats": others})
    return board


def _overlap(a: list[float] | None, b: list[float] | None) -> bool:
    if not a or not b:
        return True
    return a[0] <= b[1] and b[0] <= a[1]


# --------------------------------------------------------------------------------------------
# The preset
# --------------------------------------------------------------------------------------------


def _camera_prefer(cond: Condition) -> str | None:
    mode = str((cond.segment.info or {}).get("mode") or "") if cond.segment is not None else ""
    text = f"{cond.camera_id} {cond.camera_label}".lower()
    if mode == "arkit" or "arkit" in text or "truedepth" in text:
        return "arkit"
    if "front" in text:
        return "front"
    if any(w in text for w in ("back", "rear", "wide", "tele")):
        return "back"
    return None


def make_preset(board: dict[str, Any], sw: Sweep) -> dict[str, Any] | None:
    """The overall winner as a ``replace`` preset (physical settings of its condition, the camera
    and zoom, the vision settings and the fit), plus where it applies."""
    from .presets import PresetError, preset_settings, validate

    row = board.get("_overall_row")
    if not row:
        return None
    cond = sw.conds[row["cond"]]
    allowed = {s.path: s for s in preset_settings()}
    notes: list[str] = []
    ch: dict[str, Any] = {k: v for k, v in cond.settings.items() if k in allowed}
    v = row.get("vision_def") or {}
    ch.update(v.get("changes") or {})
    chain = str(v.get("chain") or "default")
    if chain.startswith("sim_oracle"):
        notes.append("the winning estimator chain reads the simulator's truth and is not a live setting; the estimators stay at their defaults")
    elif chain != "default":
        ch["estimators.order"] = [n for n in chain.split("+") if n]
    ch.update(fit_changes(row["fit"]))
    if cond.phase("poses"):
        ch["calibration.pose_rounds"] = max(1, min(5, len(cond.pose_groups))) if row["fit"].get("poses", True) else 1
    if row["fit"].get("calibration.pursuit_merge", "off") != "off":
        ch["calibration.moving_dot"] = True
    if cond.zoom:
        ch["lens.zoom"] = float(cond.zoom)
        ch["lens.auto_zoom"] = False
    prefer = _camera_prefer(cond)
    if prefer:
        ch["lens.camera_prefer"] = prefer
    dropped = sorted(k for k in ch if k not in allowed)
    ch = {k: x for k, x in ch.items() if k in allowed and x != allowed[k].default}
    if dropped:
        notes.append("not preset settings, left out: " + ", ".join(dropped))
    o = board.get("overall") or {}
    ci = o.get("ci")
    desc = (
        f"From the sweep '{sw.inputs.name}' ({board['created'][:10]}): {cond.camera_label} at {cond.zoom or '?'}x, setup '{cond.label}'. "
        f"Validation {o.get('acc_deg', 0):.2f} deg" + (f" (95% {ci[0]:.2f}-{ci[1]:.2f})" if ci else "") + (f", {o['confirm_deg']:.2f} deg on held-back dots" if o.get("confirm_deg") is not None else "") + ". "
        f"Applies to camera {cond.camera_id} at zoom {cond.zoom or '?'}x; on another camera, sweep that one."
    )
    try:
        preset = validate({"name": PRESET_NAME, "description": desc, "mode": "replace", "changes": ch})
    except PresetError as exc:
        notes.append(f"some settings were refused: {exc}")
        clean = {}
        for k, x in ch.items():
            try:
                validate({"name": PRESET_NAME, "changes": {k: x}})
                clean[k] = x
            except PresetError:
                continue
        preset = validate({"name": PRESET_NAME, "description": desc, "mode": "replace", "changes": clean})
    return {**preset, "camera_id": cond.camera_id, "camera_label": cond.camera_label, "zoom": cond.zoom, "condition": cond.id, "condition_label": cond.label, "sweep": sw.inputs.name, "acc_deg": o.get("acc_deg"), "ci": ci, "confirm_deg": o.get("confirm_deg"), "notes": notes}


def save_preset(preset: dict[str, Any], config_path: str | os.PathLike[str] | None) -> dict[str, Any]:
    """Save through the presets store (``presets.json`` next to the config), replacing an older
    "best from sweep"."""
    from .presets import PresetStore, store_path

    store = PresetStore(store_path(config_path))
    return store.save({k: preset[k] for k in ("name", "description", "mode", "changes")})


# --------------------------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------------------------


def _f(v: Any, nd: int = 2) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "-"
    if isinstance(v, (int, float)):
        return f"{v:.{nd}f}"
    return str(v)


def _ci(ci: Any) -> str:
    return f"{ci[0]:.2f}-{ci[1]:.2f}" if ci else "-"


def _stopped(board: dict[str, Any]) -> str:
    return {"time": "stopped by the time budget", "cap": "stopped at the cap on combinations", None: "finished the plan"}.get(board.get("stopped_by"), str(board.get("stopped_by")))


def _share(x: float) -> str:
    """A share of the search space, readable when tiny (0.0019 %)."""
    pct = 100.0 * x
    if pct == 0:
        return "0 %"
    return f"{pct:.{max(0, min(6, 1 - int(math.floor(math.log10(pct)))))}f} %"


def _coverage_line(board: dict[str, Any]) -> str:
    ev = sum(c.get("evaluated", 0) for c in board["conditions"])
    sp = sum(c.get("space", 0) or 0 for c in board["conditions"])
    share = _share(ev / sp) if sp else "-"
    return f"{ev} setups fitted ({share} of {sp:,} possible combinations) in {board['elapsed_s'] / 60:.1f} min on {board['workers']} core(s); {_stopped(board)}"


def format_summary(board: dict[str, Any]) -> str:
    """Compact plain text for a chat: no images, a few lines per condition."""
    L = [f"Phone Gaze sweep '{board['name']}' ({board['created'][:16].replace('T', ' ')})", _coverage_line(board)]
    L.append("Errors are degrees of gaze on VALIDATION dots no fit ever saw; 95% intervals over dots. 'Confirmed' = the same setup on the half of the validation dots it was not ranked on.")
    o = board.get("overall")
    if o:
        L.append("")
        L.append(f"BEST OVERALL: {o['label']} [{o['camera_label']} {o.get('zoom') or '?'}x]: {_f(o['acc_deg'])} deg (95% {_ci(o['ci'])}), confirmed {_f(o['confirm_deg'])}, precision {_f(o['prec_deg'])}")
        L.append(f"  setup: {o['fit_name']} | {o['vision_name']}")
        if o.get("runner_up"):
            ru = o["runner_up"]
            L.append(f"  next: {ru['label']} {_f(ru['acc_deg'])} deg (95% {_ci(ru['ci'])})" + ("  -> within noise: record both again before choosing" if o.get("within_noise_of_runner_up") else "  -> a real difference"))
    if len(board.get("cameras") or []) > 1:
        L.append("")
        L.append("Per camera:")
        for c in board["cameras"]:
            L.append(f"  {c['camera_label']} ({c['camera_id']}): {c['label']} {_f(c['acc_deg'])} deg (95% {_ci(c['ci'])})")
    L.append("")
    L.append("Per condition (best setup | live defaults | horizontal/vertical | worst region):")
    diag = {d["id"]: d for d in (board.get("diagnosis") or {}).get("conditions", [])}
    for c in board["conditions"]:
        w = c.get("winner")
        if not w:
            L.append(f"- {c['label']}: {c.get('message', 'nothing scored')}")
        else:
            d = c.get("defaults") or {}
            worst = max(w["regions"].items(), key=lambda kv: kv[1]) if w.get("regions") else None
            L.append(
                f"- {c['label']} [{c['camera_label']} {c.get('zoom') or '?'}x]: {_f(w['acc_deg'])} (95% {_ci(w['ci'])}, confirmed {_f(w['confirm_deg'])}) | defaults {_f(d.get('acc_deg'))} | H {_f(w['horizontal_deg'])} V {_f(w['vertical_deg'])} | "
                + (f"{worst[0]} {_f(worst[1])}" if worst else "-")
                + (f" | cross-pose {_f(w['cross_pose_deg'])}" if w.get("cross_pose_deg") is not None else "")
            )
            L.append(f"    {w['fit_name']} | {w['vision_name']}; {c.get('n_within_noise', 0)} of the next 9 within noise of it")
        dg = diag.get(c["id"])
        if dg:
            L.append(f"    why: {dg['verdict']}")
            L.append(f"    next: {dg['next_step']}")
        for n in c.get("notes") or []:
            if not n.startswith("notes:"):
                L.append(f"    note: {n}")
    p = board.get("preset")
    if p:
        L.append("")
        L.append(f"Preset '{p['name']}' written: camera {p['camera_id']} at {p.get('zoom') or '?'}x, {len(p['changes'])} setting(s).")
    L.append("")
    L.append("Untested on real recordings so far; numbers from a few validation dots are noisy (see 95% intervals).")
    return "\n".join(L)


def write_markdown(board: dict[str, Any]) -> str:
    L = [f"# Sweep: {board['name']}", "", f"{_coverage_line(board)}. Created {board['created']}.", ""]
    L.append("Errors are degrees of gaze on validation dots no fit saw. **Ranked** on half the validation dots, **confirmed** on the other half; 95 % intervals are bootstrap over dots. Rows marked *noise* are not distinguishable from the best.")
    L.append("")
    o = board.get("overall")
    if o:
        L += ["## Best overall", "", f"**{o['label']}** ({o['camera_label']}, {o.get('zoom') or '?'}x): {_f(o['acc_deg'])} deg (95 % {_ci(o['ci'])}), confirmed {_f(o['confirm_deg'])} deg, precision {_f(o['prec_deg'])} deg.", "", f"Setup: `{o['fit_name']}` with `{o['vision_name']}`.", ""]
    if board.get("cameras"):
        L += ["## Best per camera", "", "| Camera | Condition | Accuracy | 95 % | Confirmed | Precision | Setup |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for c in board["cameras"]:
            L.append(f"| {c['camera_label']} | {c['label']} | {_f(c['acc_deg'])} | {_ci(c['ci'])} | {_f(c['confirm_deg'])} | {_f(c['prec_deg'])} | {c['fit_name']}; {c['vision_name']} |")
        L.append("")
    diag = {d["id"]: d for d in (board.get("diagnosis") or {}).get("conditions", [])}
    for c in board["conditions"]:
        dots = ", ".join(f"{n} {k}" for k, n in c["dots"].items())
        L += [f"## {c['label']}", "", f"Camera {c['camera_label']} ({c['camera_id']}), zoom {c.get('zoom') or '?'}; dots: {dots}; {c['evaluated']} setups fitted ({_share(c.get('space_share') or 0)} of {c['space']:,}), {c['failed']} failed, {c['not_ranked']} predicted too few validation dots.", ""]
        dg = diag.get(c["id"])
        if dg:
            L += [f"**Why:** {dg['verdict']}", "", f"**Next:** {dg['next_step']}", ""]
        if not c.get("top"):
            L += [c.get("message", "Nothing could be scored."), ""]
            continue
        L += ["| # | Accuracy | 95 % | Ranked | Confirmed | Precision | Horiz. | Vert. | Cross-pose | Calib. score | Model | Setup |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for s in c["top"]:
            mark = " (noise)" if s.get("within_noise") else ""
            L.append(f"| {s['rank']}{mark} | {_f(s['acc_deg'])} | {_ci(s['ci'])} | {_f(s['rank_deg'])} | {_f(s['confirm_deg'])} | {_f(s['prec_deg'])} | {_f(s['horizontal_deg'])} | {_f(s['vertical_deg'])} | {_f(s['cross_pose_deg'])} | {_f(s['search_deg'])} | {s.get('model_used') or '-'} | {s['fit_name']}; {s['vision_name']} |")
        L.append("")
        w = c["winner"]
        if w.get("regions"):
            L.append("Error by screen region (best setup): " + ", ".join(f"{k} {_f(v)}" for k, v in sorted(w["regions"].items(), key=lambda kv: -kv[1])) + ".")
        if c.get("defaults"):
            L.append(f"Live defaults on the same data: {_f(c['defaults']['acc_deg'])} deg (95 % {_ci(c['defaults']['ci'])}).")
        if c.get("search_pick"):
            sp = c["search_pick"]
            L.append(f"Picked by calibration data alone (no validation): {_f(sp['acc_deg'])} deg ({sp['fit_name']}).")
        if c.get("optimism_deg") is not None:
            L.append(f"Optimism of picking the best of {c['evaluated']}: confirmed minus ranked = {c['optimism_deg']:+.2f} deg.")
        for n in c.get("notes") or []:
            L.append(f"- Note: {n}")
        if c.get("errors"):
            L.append("- Failures seen: " + "; ".join(c["errors"][:3]))
        L.append("")
    if board.get("repeats"):
        L += ["## Repeats", ""]
        for r in board["repeats"]:
            L.append(f"- Ranked on {r['ranked_on']} ({_f(r['acc_deg'])} deg): " + ", ".join(f"{x['condition']} {_f(x['acc_deg'])} (best there {_f(x['best_there_deg'])})" for x in r["on_repeats"]))
        L.append("")
    p = board.get("preset")
    if p:
        L += ["## Preset", "", f"Saved as **{p['name']}** (Experiments page, Presets): camera {p['camera_id']} at {p.get('zoom') or '?'}x.", ""]
        L += [f"- `{k}` = `{json.dumps(_jsonable(v))}`" for k, v in sorted(p["changes"].items())]
        L += [f"- Note: {n}" for n in p.get("notes") or []]
    for n in board.get("notes") or []:
        L.append(f"- Input note: {n}")
    return "\n".join(L) + "\n"


def write_html(board: dict[str, Any]) -> str:
    import html as H

    from .lab import HTML_STYLE

    def esc(x: Any) -> str:
        return H.escape(str(x))

    parts = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Sweep {esc(board['name'])}</title><style>{HTML_STYLE} td.noise{{opacity:.75}} .verdict{{font-weight:600}}</style></head><body>"]
    parts.append(f"<h1>Sweep: {esc(board['name'])}</h1><p>{esc(_coverage_line(board))}.</p>")
    parts.append("<p>Degrees of gaze on validation dots no fit saw. Ranked on half of them, confirmed on the other half; 95 % intervals are bootstrap over dots. Rows marked <em>noise</em> are not distinguishable from the best.</p>")
    o = board.get("overall")
    if o:
        parts.append(f"<h2>Best overall</h2><p><b>{esc(o['label'])}</b> ({esc(o['camera_label'])}, {esc(o.get('zoom') or '?')}x): {_f(o['acc_deg'])}&deg; (95&nbsp;% {_ci(o['ci'])}), confirmed {_f(o['confirm_deg'])}&deg;, precision {_f(o['prec_deg'])}&deg;.<br>Setup: <code>{esc(o['fit_name'])}</code> with <code>{esc(o['vision_name'])}</code></p>")
    if board.get("cameras"):
        parts.append("<h2>Best per camera</h2><table><tr><th>Camera</th><th>Condition</th><th>Accuracy</th><th>95 %</th><th>Confirmed</th><th>Precision</th><th>Setup</th></tr>")
        for c in board["cameras"]:
            parts.append(f"<tr><td>{esc(c['camera_label'])}</td><td>{esc(c['label'])}</td><td>{_f(c['acc_deg'])}</td><td>{_ci(c['ci'])}</td><td>{_f(c['confirm_deg'])}</td><td>{_f(c['prec_deg'])}</td><td>{esc(c['fit_name'])}; {esc(c['vision_name'])}</td></tr>")
        parts.append("</table>")
    diag = {d["id"]: d for d in (board.get("diagnosis") or {}).get("conditions", [])}
    for c in board["conditions"]:
        parts.append(f"<h2>{esc(c['label'])}</h2><p>Camera {esc(c['camera_label'])}, zoom {esc(c.get('zoom') or '?')}; {c['evaluated']} setups fitted ({_share(c.get('space_share') or 0)} of {c['space']:,}), {c['failed']} failed.</p>")
        dg = diag.get(c["id"])
        if dg:
            parts.append(f"<p class='verdict'>Why: {esc(dg['verdict'])}</p><p>Next: {esc(dg['next_step'])}</p>")
        if not c.get("top"):
            parts.append(f"<p>{esc(c.get('message', 'Nothing could be scored.'))}</p>")
            continue
        parts.append("<table><tr><th>#</th><th>Accuracy</th><th>95 %</th><th>Ranked</th><th>Confirmed</th><th>Precision</th><th>Horiz.</th><th>Vert.</th><th>Cross-pose</th><th>Calib. score</th><th>Model</th><th>Setup</th></tr>")
        for s in c["top"]:
            cls = " class='noise'" if s.get("within_noise") else ""
            parts.append(f"<tr{cls}><td>{s['rank']}{' noise' if s.get('within_noise') else ''}</td><td>{_f(s['acc_deg'])}</td><td>{_ci(s['ci'])}</td><td>{_f(s['rank_deg'])}</td><td>{_f(s['confirm_deg'])}</td><td>{_f(s['prec_deg'])}</td><td>{_f(s['horizontal_deg'])}</td><td>{_f(s['vertical_deg'])}</td><td>{_f(s['cross_pose_deg'])}</td><td>{_f(s['search_deg'])}</td><td>{esc(s.get('model_used') or '-')}</td><td>{esc(s['fit_name'])}; {esc(s['vision_name'])}</td></tr>")
        parts.append("</table>")
        w = c["winner"]
        extra = []
        if w.get("regions"):
            extra.append("Error by region: " + ", ".join(f"{esc(k)} {_f(v)}" for k, v in sorted(w["regions"].items(), key=lambda kv: -kv[1])))
        if c.get("defaults"):
            extra.append(f"Live defaults: {_f(c['defaults']['acc_deg'])}&deg;")
        if c.get("search_pick"):
            extra.append(f"Picked by calibration data alone: {_f(c['search_pick']['acc_deg'])}&deg;")
        if c.get("optimism_deg") is not None:
            extra.append(f"Confirmed minus ranked: {c['optimism_deg']:+.2f}&deg;")
        extra += [f"Note: {esc(n)}" for n in c.get("notes") or []]
        parts.append("<ul>" + "".join(f"<li>{x}</li>" for x in extra) + "</ul>")
    p = board.get("preset")
    if p:
        parts.append(f"<h2>Preset</h2><p>Saved as <b>{esc(p['name'])}</b>: camera {esc(p['camera_id'])} at {esc(p.get('zoom') or '?')}x.</p><ul>" + "".join(f"<li><code>{esc(k)}</code> = <code>{esc(json.dumps(_jsonable(v)))}</code></li>" for k, v in sorted(p["changes"].items())) + "</ul>")
    parts.append("</body></html>")
    return "".join(parts)


def write_outputs(board: dict[str, Any], out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    clean = {k: v for k, v in board.items() if not k.startswith("_")}
    paths = {"json": out / "leaderboard.json", "md": out / "leaderboard.md", "html": out / "leaderboard.html", "summary": out / "summary.txt"}
    for key, text in (("json", json.dumps(_jsonable(clean), indent=2)), ("md", write_markdown(clean)), ("html", write_html(clean)), ("summary", format_summary(clean) + "\n")):
        tmp = paths[key].with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(paths[key])
    return paths


# --------------------------------------------------------------------------------------------
# Sweep page (web/sweep.html): /api/sweep/*
# --------------------------------------------------------------------------------------------


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def list_targets(cfg: Config) -> dict[str, Any]:
    """What the page offers to sweep: collection runs, then recordings with a manifest or a
    validation."""
    root = Path(cfg.recording.directory).expanduser()
    runs = []
    rd = root / "collect-runs"
    if rd.is_dir():
        for f in sorted(rd.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            recs = data.get("recordings") if isinstance(data, dict) else None
            runs.append({"run_id": f.stem, "path": str(f), "recordings": len(recs) if isinstance(recs, list) else None, "created": (data.get("created") or data.get("started")) if isinstance(data, dict) else None})
    recs = []
    if root.is_dir():
        for d in sorted((x for x in root.iterdir() if x.is_dir() and x.name not in ("sweeps", "collect-runs")), key=lambda x: x.stat().st_mtime, reverse=True)[:100]:
            if (d / "collect.json").exists():
                recs.append({"name": d.name, "path": str(d), "kind": "collect"})
            elif (d / "stream.pgz1").exists() and (d / "events.jsonl").exists():
                try:
                    has_val = '"validate"' in (d / "events.jsonl").read_text(encoding="utf-8", errors="replace")
                except OSError:
                    has_val = False
                recs.append({"name": d.name, "path": str(d), "kind": "recording" + (" with validation" if has_val else "")})
    return {"root": str(root), "runs": runs, "recordings": recs}


def sweep_status(out: Path, procs: dict[str, Any] | None = None) -> dict[str, Any]:
    st: dict[str, Any] = {"name": out.name, "path": str(out)}
    try:
        st.update(json.loads((out / "state.json").read_text()))
    except (OSError, ValueError):
        st["stage"] = "unknown"
    st.pop("conditions", None)
    proc = (procs or {}).get(str(out))
    running = proc.poll() is None if proc is not None else (st.get("stage") not in ("done", "failed", "interrupted", "unknown") and _pid_alive(st.get("pid")))
    st["running"] = bool(running)
    if not running and st.get("stage") not in ("done", "failed", "interrupted", "unknown"):
        st["stage"] = "stopped"
        st["message"] = "stopped before it finished; start it again to resume where it stopped"
    st["has_report"] = (out / "leaderboard.html").exists()
    try:
        lines = (out / "sweep.log").read_text(encoding="utf-8", errors="replace").splitlines()
        st["log"] = lines[-12:]
    except OSError:
        st["log"] = []
    return st


def register(app: Any, engine: Any) -> None:
    """Add ``/api/sweep/*`` (called from ``lab.register``):

    - ``GET /api/sweep/targets``: collection runs and recordings on this computer;
    - ``GET /api/sweep/list``: sweeps under ``<recordings>/sweeps`` and their state;
    - ``POST /api/sweep/start`` ``{"target", "minutes"?, "max_combos"?}``: start (or resume) a
      sweep in a separate process (``python -m phonegaze sweep``), so it survives a page reload;
    - ``GET /api/sweep/status?name=``: progress, estimated time left, the log's last lines, and
      when done the summary and the leaderboard JSON;
    - ``GET /api/sweep/report/{name}``: ``leaderboard.html``;
    - ``POST /api/sweep/stop`` ``{"name"}``: stop it (start again to resume);
    - ``POST /api/sweep/apply`` ``{"name"}``: save that sweep's winner as "best from sweep" and
      apply it to the running engine."""
    import asyncio
    import signal as _signal
    import subprocess

    from aiohttp import web

    procs: dict[str, Any] = {}
    outs: dict[str, Path] = {}

    def _json(data: Any, status: int = 200) -> web.Response:
        return web.json_response(_jsonable(data), status=status, dumps=lambda d: json.dumps(d, default=str))

    def root() -> Path:
        return sweeps_dir(Path(engine.config.recording.directory).expanduser())

    def find(name: str) -> Path | None:
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        if name in outs:
            return outs[name]
        p = root() / name
        return p if p.is_dir() else None

    async def body(request: web.Request) -> dict[str, Any]:
        try:
            b = await request.json()
        except ValueError:
            return {}
        return b if isinstance(b, dict) else {}

    async def targets(request: web.Request) -> web.Response:
        return _json(await asyncio.get_running_loop().run_in_executor(None, list_targets, engine.config))

    async def listing(request: web.Request) -> web.Response:
        found: dict[str, Path] = dict(outs)
        r = root()
        if r.is_dir():
            for d in r.iterdir():
                if d.is_dir() and (d / "state.json").exists():
                    found.setdefault(d.name, d)
        items = [sweep_status(p, procs) for p in found.values()]
        items.sort(key=lambda s: str(s.get("updated") or ""), reverse=True)
        return _json({"sweeps": items, "folder": str(r)})

    async def start(request: web.Request) -> web.Response:
        b = await body(request)
        target = str(b.get("target") or "").strip()
        try:
            inputs = await asyncio.get_running_loop().run_in_executor(None, resolve, target, engine.config)
        except LabError as exc:
            return _json({"error": str(exc)}, 400)
        out = sweeps_dir(inputs.root) / safe_name(inputs.name)
        name = out.name
        proc = procs.get(str(out))
        if proc is not None and proc.poll() is None:
            return _json({"error": "this sweep is already running", "name": name}, 409)
        try:
            minutes = float(b.get("minutes") or 45)
            combos = int(b.get("max_combos") or 400)
        except (TypeError, ValueError):
            return _json({"error": "minutes and max_combos must be numbers"}, 400)
        out.mkdir(parents=True, exist_ok=True)
        cmd = [sys.executable, "-m", "phonegaze", "sweep", target, "--minutes", str(minutes), "--max-combos", str(combos)]
        if getattr(engine, "config_path", None):
            cmd += ["--config", str(engine.config_path)]
        if b.get("vision") in ("auto", "real", "oracle"):
            cmd += ["--vision", str(b["vision"])]
        logf = open(out / "sweep.log", "a", encoding="utf-8")  # noqa: SIM115 - the child owns it
        logf.write(f"\n--- {_dt.datetime.now().isoformat(timespec='seconds')}: {' '.join(cmd)}\n")
        logf.flush()
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        procs[str(out)] = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, cwd=str(Path(__file__).resolve().parent.parent), env=env)
        logf.close()
        outs[name] = out
        return _json({"started": True, "name": name, "path": str(out), "conditions": len(inputs.conditions), "notes": inputs.notes})

    async def status(request: web.Request) -> web.Response:
        out = find(request.query.get("name", ""))
        if out is None:
            return _json({"error": "no such sweep"}, 404)
        st = sweep_status(out, procs)
        if (out / "summary.txt").exists():
            st["summary"] = (out / "summary.txt").read_text(encoding="utf-8")
        if (out / "leaderboard.json").exists():
            try:
                board = json.loads((out / "leaderboard.json").read_text(encoding="utf-8"))
                st["board"] = {k: board.get(k) for k in ("overall", "cameras", "preset", "evaluated", "elapsed_s", "stopped_by")}
                st["board"]["conditions"] = [{k: c.get(k) for k in ("id", "label", "camera_label", "zoom", "winner", "defaults", "evaluated", "space", "space_share", "n_within_noise", "message")} for c in board.get("conditions", [])]
                st["diagnosis"] = [{k: d.get(k) for k in ("id", "label", "verdict", "next_step", "findings")} for d in (board.get("diagnosis") or {}).get("conditions", [])]
            except (OSError, ValueError):
                pass
        st["has_preset"] = (out / "best_preset.json").exists()
        return _json(st)

    async def report(request: web.Request) -> web.StreamResponse:
        out = find(request.match_info["name"])
        if out is None or not (out / "leaderboard.html").exists():
            return _json({"error": "no report yet"}, 404)
        return web.FileResponse(out / "leaderboard.html", headers={"Cache-Control": "no-cache"})

    async def stop(request: web.Request) -> web.Response:
        b = await body(request)
        out = find(str(b.get("name") or ""))
        if out is None:
            return _json({"error": "no such sweep"}, 404)
        proc = procs.get(str(out))
        pid = proc.pid if proc is not None and proc.poll() is None else None
        if pid is None:
            st = sweep_status(out, procs)
            pid = st.get("pid") if st.get("running") else None
        if pid is None:
            return _json({"stopped": False, "message": "it is not running"})
        try:
            os.kill(int(pid), _signal.SIGINT)
        except OSError as exc:
            return _json({"error": str(exc)}, 500)
        return _json({"stopped": True})

    async def apply(request: web.Request) -> web.Response:
        from .presets import PresetError, changes_to_apply

        b = await body(request)
        out = find(str(b.get("name") or ""))
        if out is None or not (out / "best_preset.json").exists():
            return _json({"error": "this sweep has no preset yet (it is written when the sweep finishes)"}, 404)
        try:
            preset = json.loads((out / "best_preset.json").read_text(encoding="utf-8"))
            saved = save_preset(preset, getattr(engine, "config_path", None))
        except (OSError, ValueError, PresetError) as exc:
            return _json({"error": f"cannot save the preset: {exc}"}, 400)
        changes = changes_to_apply(saved, engine.config)
        errors = await engine.apply_config(changes)
        return _json({"applied": changes, "errors": errors, "preset": saved["name"], "camera_id": preset.get("camera_id"), "zoom": preset.get("zoom")})

    r = app.router
    r.add_get("/api/sweep/targets", targets)
    r.add_get("/api/sweep/list", listing)
    r.add_post("/api/sweep/start", start)
    r.add_get("/api/sweep/status", status)
    r.add_get("/api/sweep/report/{name}", report)
    r.add_post("/api/sweep/stop", stop)
    r.add_post("/api/sweep/apply", apply)


# --------------------------------------------------------------------------------------------
# Running it
# --------------------------------------------------------------------------------------------


def safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "-" for c in str(name)).strip("-.") or "sweep"


def sweeps_dir(root: Path) -> Path:
    return Path(root) / "sweeps"


def run_sweep(target: str, base: Config, *, config_path: str | None = None, out: str | None = None, minutes: float = 45.0, max_combos: int = 400, workers: int | None = None, vision: str = "auto", every: int | None = None, write_preset: bool = True, fresh: bool = False, progress: Any = None, diagnose: bool = True, models: list[str] | None = None, max_vision: int = 16) -> dict[str, Any]:
    """Resolve the inputs, sweep, diagnose, write the reports and the preset. Returns the
    leaderboard (with ``paths``)."""
    inputs = resolve(target, base)
    out_dir = Path(out).expanduser() if out else sweeps_dir(inputs.root) / safe_name(inputs.name)
    if fresh and (out_dir / "results.jsonl").exists():
        (out_dir / "results.jsonl").unlink()
    progress = progress or (lambda s: None)
    progress(f"Sweeping {len(inputs.conditions)} condition(s) from {inputs.root} into {out_dir}")
    for n in inputs.notes:
        progress(f"  note: {n}")
    sw = Sweep(inputs, base, out_dir, minutes=minutes, max_combos=max_combos, workers=workers, vision_mode=vision, every=every, progress=progress, models=models, max_vision=max_vision)
    if sw.resumed:
        progress(f"Resuming: {sw.resumed} setup(s) already fitted")
    try:
        board = sw.run(diagnose=diagnose)
        if write_preset:
            preset = make_preset(board, sw)
            if preset is not None:
                (out_dir / "best_preset.json").write_text(json.dumps(_jsonable(preset), indent=2) + "\n")
                try:
                    save_preset(preset, config_path)
                    board["preset"] = preset
                except Exception as exc:  # noqa: BLE001
                    board["preset_error"] = str(exc)
                    board["preset"] = preset
        paths = write_outputs(board, out_dir)
        if board.get("diagnosis"):
            (out_dir / "diagnosis.json").write_text(json.dumps(_jsonable(board["diagnosis"]), indent=2) + "\n")
        sw.state(stage="done", finished=_dt.datetime.now().isoformat(timespec="seconds"), message=_coverage_line(board), eta_s=0, best=(board.get("overall") or {}).get("acc_deg"))
    except KeyboardInterrupt:
        sw.state(stage="interrupted", message="interrupted; start it again to resume")
        raise
    except Exception as exc:
        sw.state(stage="failed", error=f"{type(exc).__name__}: {exc}", message=str(exc))
        raise
    board["paths"] = {k: str(v) for k, v in paths.items()}
    return board


def main(argv: list[str] | None = None) -> int:
    """``python -m phonegaze sweep TARGET ...``"""
    from .lab import build_config, quiet_native_logs

    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "sweep":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="python -m phonegaze sweep", description="Replay recorded sessions through thousands of setting combinations and rank them on held-out validation dots (see docs/SWEEP.md).")
    p.add_argument("target", help="a collection run id, a run file (collect-runs/<id>.json), a folder of recordings, or one recording")
    p.add_argument("--minutes", type=float, default=45.0, help="time budget for the whole sweep (default 45)")
    p.add_argument("--max-combos", type=int, default=400, help="at most this many setups fitted per condition (default 400)")
    p.add_argument("--workers", type=int, help="processes (default: every CPU core)")
    p.add_argument("--vision", choices=["auto", "real", "oracle"], default="auto", help="estimator chains: real vision, the simulator's truth (synthetic runs) or auto")
    p.add_argument("--every", type=int, help="use every Nth frame (default lab.every)")
    p.add_argument("--models", help="only these model setups, comma-separated (default all: " + ", ".join(MODEL_SETUPS) + ")")
    p.add_argument("--max-vision", type=int, default=16, help="at most this many vision combinations per condition in stage 1 (default 16)")
    p.add_argument("--config", help="config file (default ~/.phonegaze/config.json); the preset is saved next to it")
    p.add_argument("--out", help="output folder (default <recordings>/sweeps/<name>)")
    p.add_argument("--no-preset", action="store_true", help="do not save the winner as the preset 'best from sweep'")
    p.add_argument("--fresh", action="store_true", help="forget earlier fits of this sweep (observation caches are kept)")
    p.add_argument("--json", action="store_true", help="print the leaderboard as JSON")
    p.add_argument("--log-level", default="WARNING")
    args = p.parse_args(argv)
    quiet_native_logs()
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.WARNING), format="%(levelname)s %(name)s: %(message)s")
    try:
        cfg, _ = build_config(args.config, None, None)
        from .config import DEFAULT_PATH

        board = run_sweep(args.target, cfg, config_path=args.config or str(DEFAULT_PATH), out=args.out, minutes=args.minutes, max_combos=args.max_combos, workers=args.workers, vision=args.vision, every=args.every, write_preset=not args.no_preset, fresh=args.fresh, models=[m.strip() for m in args.models.split(",") if m.strip()] if args.models else None, max_vision=args.max_vision, progress=None if args.json else (lambda s: print(s, file=sys.stderr, flush=True)))
    except LabError as exc:
        print(f"sweep: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("sweep: interrupted; run the same command again to resume", file=sys.stderr)
        return 130
    except OSError as exc:
        print(f"sweep: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(_jsonable({k: v for k, v in board.items() if not k.startswith("_")}), indent=2))
    else:
        print(format_summary(board))
        print(f"\nLeaderboard: {board['paths']['html']}\n             {board['paths']['md']}\nSummary:     {board['paths']['summary']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
