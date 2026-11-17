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
    _finish(c)
    return c


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
    "calibration.discard_ms": {"values": [150, 0, 300, 600], "models": None},
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
            if (k == "poses" and not cond_has.get("poses")) or (k == "calibration.pursuit_merge" and not cond_has.get("pursuit")):
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
    """Cleaned samples per phase, as live calibration cleans a dot (``calibration.clean_dot``)."""
    from .calibration import clean_dot

    cal = cfg.calibration
    disc = float(cal.discard_ms) / 1000.0
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
    row: dict[str, Any] = {"cond": cond.id, "vision": vision_id(vision), "fit": fit, "key": fit_key(fit), "v": SWEEP_VERSION}
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
