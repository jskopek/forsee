"""Guided collection run: record the same short protocol under several physical setups. Owner: Core.

The point is clean raw data for an offline sweep (``python -m phonegaze sweep``), not a working
pointer: no model is fitted and the cursor does not move while a run is open.

A **run** is a queue of **conditions**. A condition is one physical setup: which camera, zoom,
frame rate, shutter cap, focus lock, the on-screen reflection helper (``ui.glint_marker``) and
the user's notes. For each condition the Collect page (``web/js/collect.js``) asks the engine to
configure the phone (:meth:`Collector.prepare`), waits until :meth:`Collector.readiness` says the
camera is right, focus and exposure have settled and both eyes are found, then runs one fixed
protocol (:func:`build_protocol`) full screen while the engine records the raw phone stream.

Files (all under ``recording.directory``, never in the repository):

- ``<recording id>/``: one ordinary recording per condition attempt (``recorder.py``: raw stream
  with images, observations, events), plus ``collect.json``, the manifest::

      {"format": "phonegaze-collect-1", "run_id", "condition": {"id", "label", "camera_id",
       "camera_label", "zoom", "settings": {config path: value}, "notes"},
       "screen": {"width_pt", "height_pt", "width_mm", "height_mm"},
       "phases": [{"name": "calibration" | "poses" | "validation" | "pursuit",
                   "dots": [{"id", "x", "y", "t_on", "t_off", "pose_group"}],
                   "samples": [[t, x, y], ...]}],          # "samples" only in "pursuit"
       "started": ISO time, "completed": bool}

  Times (``t_on``, ``t_off``, sample ``t``) are engine ``time.monotonic()`` seconds stamped when
  the page reports the dot shown or hidden: the clock the recorder stamps every frame with
  (``recv`` in ``stream.pgz1``, ``t_local`` in ``observations.jsonl``). ``pose_group`` is 0 for
  the calibration and validation dots (head where it normally is) and 1, 2, ... for the head
  positions of the pose block (:data:`POSE_PROMPTS`). Dot ids are unique within a condition.
  Positions are screen points, origin top-left of the main display.
- ``collect-runs/<run_id>.json``: the run (format ``phonegaze-collect-run-1``): the queue with
  each condition's status and attempts, and ``recordings``, the completed condition recordings
  in queue order (``{"condition_id", "label", "recording_id", "path", "quality", "poor"}``).

HTTP routes (``register``; bodies JSON): ``GET /api/collect/options``, ``GET /api/collect/runs``,
``POST /api/collect/runs/new {"sets"?, "conditions"?, "length"?, "pursuit"?}``,
``GET /api/collect/run?run_id=``, ``POST /api/collect/open {"run_id"}``,
``POST /api/collect/queue {"op", "index"?, "to"?, "condition"?, "notes"?}``,
``POST /api/collect/prepare {"index"}``, ``GET /api/collect/ready``,
``POST /api/collect/start {"index"}``, ``POST /api/collect/dot {"phase", "dot_id", "x", "y",
"state": "on" | "off", "pose_group"?}``, ``POST /api/collect/pursuit {"x", "y"}``,
``POST /api/collect/phase {"name", "restart": true}``, ``GET /api/collect/status``,
``POST /api/collect/finish``, ``POST /api/collect/abort {"action": "redo" | "skip" | "stop"}``,
``POST /api/collect/close {"restore"?}``, ``GET /api/collect/best-preset``,
``POST /api/collect/best-preset/apply``.

Settings: section ``collect`` in ``config.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

FORMAT = "phonegaze-collect-1"
RUN_FORMAT = "phonegaze-collect-run-1"
MANIFEST = "collect.json"
RUNS_DIR = "collect-runs"
BEST_PRESET = "best from sweep"
"""Name (prefix) of the presets the sweep writes; "Apply best preset" takes the newest."""

CAMERAS: dict[str, dict[str, str]] = {
    "front_arkit": {"label": "Front TrueDepth camera with ARKit", "short": "front ARKit", "position": "front"},
    "front": {"label": "Front camera, plain images", "short": "front plain", "position": "front"},
    "back_wide": {"label": "Back wide camera", "short": "back wide", "position": "back"},
    "back_ultrawide": {"label": "Back ultra wide camera", "short": "back ultra wide", "position": "back"},
    "back_tele": {"label": "Back telephoto camera", "short": "back telephoto", "position": "back"},
}
REFLECTION = ("off", "border", "corners")
FOCUS = ("default", "locked", "continuous")

PHASES = ("calibration", "poses", "validation", "pursuit")
POSE_PROMPTS = {
    1: "Move your head about 10 cm to the LEFT (keep facing the screen) and keep it there.",
    2: "Now move your head about 10 cm to the RIGHT of where you normally sit and keep it there.",
    3: "Now lean about 10 cm NEARER to the screen and keep still.",
    4: "Now sit about 10 cm FURTHER BACK than usual and keep still.",
}
BACK_TO_NORMAL = "Sit as you normally do again, head still."
PURSUIT_STEP_MS = 250
PROMPT_S = 5.0
"""Seconds a prompt is assumed to take in the time estimates (the page waits for Space)."""

LENGTHS: dict[str, dict[str, Any]] = {
    # grid (columns, rows), pose dot count, pose groups, validation dots, pursuit seconds
    "short": {"label": "about 1 minute", "grid": (3, 3), "pose_dots": 3, "poses": 3, "validation": 6, "pursuit_s": 8.0},
    "medium": {"label": "about 2 minutes", "grid": (4, 4), "pose_dots": 5, "poses": 3, "validation": 9, "pursuit_s": 12.0},
    "long": {"label": "about 3 minutes", "grid": (6, 5), "pose_dots": 7, "poses": 4, "validation": 16, "pursuit_s": 20.0},
}
POSE_DOT_FRACTIONS = [(0.5, 0.5), (0.2, 0.2), (0.8, 0.8), (0.8, 0.2), (0.2, 0.8), (0.5, 0.2), (0.5, 0.8)]


class CollectError(ValueError):
    """Bad input or a request that does not fit the run's state (HTTP 400 / 409)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------------------------
# Conditions and ready-made sets
# --------------------------------------------------------------------------------------------


def _num(v: Any, default: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if not math.isfinite(x) else min(hi, max(lo, x))


def condition_label(c: dict[str, Any]) -> str:
    cam = CAMERAS.get(c.get("camera", ""), {}).get("short", str(c.get("camera")))
    parts = [cam if c.get("camera") == "front_arkit" else f"{cam} {c.get('zoom', 1.0):g}x"]
    if c.get("fps") and float(c["fps"]) != 30.0:
        parts.append(f"{float(c['fps']):g} fps")
    if c.get("max_exposure_ms"):
        parts.append(f"shutter ≤ {float(c['max_exposure_ms']):g} ms")
    if c.get("exposure_bias"):
        parts.append(f"exposure {float(c['exposure_bias']):+g} EV")
    if c.get("focus", "default") != "default":
        parts.append(f"focus {c['focus']}")
    if c.get("reflection", "off") != "off":
        parts.append(f"helper {c['reflection']}")
    return ", ".join(parts)


def make_condition(camera: str, zoom: float = 1.0, **kw: Any) -> dict[str, Any]:
    """A normalised condition. Raises :class:`CollectError` for an unknown camera or choice."""
    if camera not in CAMERAS:
        raise CollectError(f"unknown camera {camera!r}; one of {', '.join(CAMERAS)}")
    reflection = str(kw.get("reflection") or "off")
    if reflection not in REFLECTION:
        raise CollectError(f"reflection helper must be one of {', '.join(REFLECTION)}")
    focus = str(kw.get("focus") or "default")
    if focus not in FOCUS:
        raise CollectError(f"focus must be one of {', '.join(FOCUS)}")
    extra = kw.get("settings") or {}
    if not isinstance(extra, dict):
        raise CollectError("settings must be {config path: value}")
    c: dict[str, Any] = {
        "camera": camera,
        "zoom": 1.0 if camera == "front_arkit" else _num(zoom, 1.0, 1.0, 10.0),
        "fps": _num(kw.get("fps"), 30.0, 1.0, 120.0),
        "max_exposure_ms": _num(kw.get("max_exposure_ms"), 0.0, 0.0, 100.0),
        "exposure_bias": _num(kw.get("exposure_bias"), 0.0, -3.0, 3.0),
        "focus": focus,
        "reflection": reflection,
        "settings": dict(extra),
        "notes": str(kw.get("notes") or "")[:2000],
    }
    c["label"] = str(kw.get("label") or "").strip()[:120] or condition_label(c)
    return c


def condition_from_dict(d: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(d, dict):
        raise CollectError("a condition is a JSON object")
    kw = {k: v for k, v in d.items() if k not in ("camera", "zoom")}
    c = make_condition(str(d.get("camera") or ""), d.get("zoom", 1.0), **kw)
    settings_check(c["settings"])
    return c


def settings_check(extra: dict[str, Any]) -> None:
    from .config import ConfigError, coerce, settings

    by_path = {s.path: s for s in settings()}
    for path, value in extra.items():
        s = by_path.get(path)
        if s is None:
            raise CollectError(f"{path}: no such setting")
        try:
            coerce(s, value)
        except ConfigError as exc:
            raise CollectError(str(exc)) from exc


def condition_settings(c: dict[str, Any]) -> dict[str, Any]:
    """The config changes that put the engine into this condition (``lens.camera_id`` apart,
    which is phone-specific and set by :meth:`Collector.prepare`). Auto zoom is always off so the
    zoom stays what the condition says for the whole recording."""
    out: dict[str, Any] = {
        "lens.zoom": float(c["zoom"]),
        "lens.fps": float(c["fps"]),
        "lens.auto_zoom": False,
        "lens.max_exposure_ms": float(c["max_exposure_ms"]),
        "lens.exposure_bias": float(c["exposure_bias"]),
        "lens.focus_locked": c["focus"],
        "ui.glint_marker": c["reflection"],
    }
    out.update(c.get("settings") or {})
    return out


def condition_sets(short_shutter_ms: float = 8.0) -> dict[str, dict[str, Any]]:
    """The ready-made sets the Collect page offers to tick."""
    rear = [
        make_condition("back_wide", z, reflection=r, max_exposure_ms=s)
        for z in (1.0, 2.0)
        for r in ("off", "border")
        for s in (0.0, short_shutter_ms)
    ]
    return {
        "quick": {
            "label": "Quick comparison",
            "description": "Front ARKit; back wide camera at 1x; back wide camera at 2x.",
            "conditions": [make_condition("front_arkit"), make_condition("back_wide", 1.0), make_condition("back_wide", 2.0)],
        },
        "rear": {
            "label": "Rear camera in depth",
            "description": f"Back wide camera at 1x and 2x, each with and without the reflection helper (white border), each at a normal and a short shutter ({short_shutter_ms:g} ms).",
            "conditions": rear,
        },
        "everything": {
            "label": "Everything",
            "description": "Every camera (front ARKit, front plain, back wide, ultra wide, telephoto) and the rear-camera variations.",
            "conditions": [make_condition("front_arkit"), make_condition("front"), *rear, make_condition("back_ultrawide", 1.0), make_condition("back_tele", 1.0)],
        },
    }


def resolve_camera(kind: str, cameras: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The phone camera (an entry of ``/api/status`` ``cameras``) for a condition's camera kind."""
    cams = [c for c in cameras if isinstance(c, dict) and not c.get("testPattern")] or [c for c in cameras if isinstance(c, dict)]
    if kind == "front_arkit":
        return next((c for c in cams if c.get("type") == "arkit"), None)
    if kind == "front":
        return next((c for c in cams if c.get("position") == "front" and c.get("type") != "arkit"), None)
    want = {"back_wide": "wide", "back_ultrawide": "ultrawide", "back_tele": "tele"}.get(kind)
    back = [c for c in cams if c.get("position") == "back" and c.get("type") == want]
    back.sort(key=lambda c: bool(c.get("depthSource")))  # the plain camera before its LiDAR variant
    return back[0] if back else None


# --------------------------------------------------------------------------------------------
# The protocol
# --------------------------------------------------------------------------------------------


def _halton(i: int, base: int) -> float:
    f, r = 1.0, 0.0
    while i > 0:
        f /= base
        r += f * (i % base)
        i //= base
    return r


def build_protocol(width: float, height: float, length: str = "medium", *, pursuit: bool = True, settle_ms: int = 600, collect_ms: int = 900, margin: float = 0.08) -> dict[str, Any]:
    """The fixed protocol for one condition, in screen points. Identical for every condition of
    a run (same screen), so results are comparable.

    Phases: a calibration grid; a head-pose block (the same few dots once per head position,
    :data:`POSE_PROMPTS`); validation dots on positions away from every calibration dot; and,
    with ``pursuit``, a moving dot (way-points every 250 ms)."""
    if length not in LENGTHS:
        raise CollectError(f"length must be one of {', '.join(LENGTHS)}")
    spec = LENGTHS[length]
    w, h = float(width), float(height)
    m = min(0.3, max(0.0, float(margin)))
    next_id = 0

    def dot(fx: float, fy: float, group: int) -> dict[str, Any]:
        nonlocal next_id
        d = {"id": next_id, "x": round(w * fx, 1), "y": round(h * fy, 1), "pose_group": group}
        next_id += 1
        return d

    cols, rows = spec["grid"]
    grid = [(m + (1 - 2 * m) * i / (cols - 1), m + (1 - 2 * m) * j / (rows - 1)) for j in range(rows) for i in range(cols)]
    # Snake order so consecutive dots are near each other (as a person scans a grid).
    ordered = []
    for j in range(rows):
        row = grid[j * cols : (j + 1) * cols]
        ordered.extend(row if j % 2 == 0 else row[::-1])
    calibration = [dot(fx, fy, 0) for fx, fy in ordered]

    poses = []
    pose_fracs = [(m + (1 - 2 * m) * fx, m + (1 - 2 * m) * fy) for fx, fy in POSE_DOT_FRACTIONS[: spec["pose_dots"]]]
    for g in range(1, spec["poses"] + 1):
        poses.extend(dot(fx, fy, g) for fx, fy in pose_fracs)

    # Validation: a Halton sequence inside the margins, kept only where it is at least half a grid
    # cell from every calibration dot and from the validation dots already chosen.
    cell = min((1 - 2 * m) / (cols - 1), (1 - 2 * m) / (rows - 1))
    min_sep = 0.5 * cell
    chosen: list[tuple[float, float]] = []
    i = 1
    while len(chosen) < spec["validation"] and i < 5000:
        fx = m + (1 - 2 * m) * _halton(i, 2)
        fy = m + (1 - 2 * m) * _halton(i, 3)
        i += 1
        if all(math.hypot(fx - gx, fy - gy) >= min_sep for gx, gy in grid) and all(math.hypot(fx - vx, fy - vy) >= min_sep for vx, vy in chosen):
            chosen.append((fx, fy))
    validation = [dot(fx, fy, 0) for fx, fy in chosen]

    phases: list[dict[str, Any]] = [
        {"name": "calibration", "intro": "Look at each dot until it moves on. Keep your head still.", "dots": calibration},
        {"name": "poses", "intro": "The same few dots again, with your head in different places.", "dots": poses, "prompts": {str(g): POSE_PROMPTS[g] for g in range(1, spec["poses"] + 1)}},
        {"name": "validation", "intro": BACK_TO_NORMAL + " Look at each dot until it moves on.", "dots": validation},
    ]
    if pursuit:
        n = max(2, int(round(spec["pursuit_s"] * 1000 / PURSUIT_STEP_MS)))
        path = []
        for k in range(n + 1):
            a = 2 * math.pi * k / n
            fx = 0.5 + (0.5 - m) * math.sin(a)
            fy = 0.5 + (0.5 - m) * math.sin(2 * a + math.pi / 2) * 0.9
            path.append([round(w * fx, 1), round(h * fy, 1)])
        phases.append({"name": "pursuit", "intro": "Follow the moving dot with your eyes.", "path": path, "step_ms": PURSUIT_STEP_MS})
    dots = len(calibration) + len(poses) + len(validation)
    prompts = len(phases) + spec["poses"]
    seconds = dots * (settle_ms + collect_ms) / 1000.0 + prompts * PROMPT_S + (spec["pursuit_s"] + settle_ms / 1000.0 if pursuit else 0.0)
    return {
        "length": length,
        "label": spec["label"],
        "settle_ms": int(settle_ms),
        "collect_ms": int(collect_ms),
        "screen": {"width": w, "height": h},
        "phases": phases,
        "dots": dots,
        "seconds": round(seconds, 1),
    }


# --------------------------------------------------------------------------------------------
# The manifest
# --------------------------------------------------------------------------------------------


class Manifest:
    """``collect.json`` for one condition attempt. Dots are added as the page reports them."""

    def __init__(self, run_id: str, condition: dict[str, Any], screen: dict[str, Any]) -> None:
        self.data: dict[str, Any] = {
            "format": FORMAT,
            "run_id": run_id,
            "condition": condition,
            "screen": screen,
            "phases": [],
            "started": datetime.now(timezone.utc).isoformat(),
            "completed": False,
        }
        self._open: dict[tuple[str, int], dict[str, Any]] = {}

    def phase(self, name: str) -> dict[str, Any]:
        if name not in PHASES:
            raise CollectError(f"phase must be one of {', '.join(PHASES)}")
        for p in self.data["phases"]:
            if p["name"] == name:
                return p
        p: dict[str, Any] = {"name": name, "dots": []}
        if name == "pursuit":
            p["samples"] = []
        self.data["phases"].append(p)
        return p

    def dot_on(self, phase: str, dot_id: int, x: float, y: float, t: float, pose_group: int | None) -> None:
        self.phase(phase)
        self._open[(phase, int(dot_id))] = {"id": int(dot_id), "x": float(x), "y": float(y), "t_on": float(t), "t_off": None, "pose_group": pose_group}

    def dot_off(self, phase: str, dot_id: int, t: float) -> bool:
        d = self._open.pop((phase, int(dot_id)), None)
        if d is None:
            return False
        d["t_off"] = float(t)
        p = self.phase(phase)
        p["dots"] = [x for x in p["dots"] if x["id"] != d["id"]] + [d]
        return True

    def sample(self, t: float, x: float, y: float) -> None:
        self.phase("pursuit")["samples"].append([round(float(t), 4), round(float(x), 1), round(float(y), 1)])

    def restart_phase(self, name: str) -> None:
        """Forget what a phase has so far (the page shows it again from the start after a pause)."""
        p = self.phase(name)
        p["dots"] = []
        if "samples" in p:
            p["samples"] = []
        self._open = {k: v for k, v in self._open.items() if k[0] != name}

    def drop_open(self) -> None:
        self._open.clear()

    def to_dict(self) -> dict[str, Any]:
        return json.loads(json.dumps(self.data))

    def write(self, directory: Path) -> Path:
        path = Path(directory) / MANIFEST
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=1, allow_nan=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path


def read_manifest(directory: str | Path) -> dict[str, Any]:
    data = json.loads((Path(directory) / MANIFEST).read_text(encoding="utf-8"))
    if data.get("format") != FORMAT:
        raise ValueError(f"{directory}: not a {FORMAT} manifest")
    return data


# --------------------------------------------------------------------------------------------
# The run (queue of conditions), saved as collect-runs/<run_id>.json
# --------------------------------------------------------------------------------------------

STATUSES = ("pending", "recording", "done", "poor", "skipped")


class Run:
    """The condition queue and its file. Every change is saved at once, so a run can be resumed
    after the engine (or the browser) stops."""

    def __init__(self, root: Path, run_id: str, *, length: str = "medium", pursuit: bool = True) -> None:
        self.root = Path(root)
        self.run_id = run_id
        self.data: dict[str, Any] = {
            "format": RUN_FORMAT,
            "run_id": run_id,
            "created": datetime.now(timezone.utc).isoformat(),
            "updated": None,
            "protocol": {"length": length, "pursuit": bool(pursuit)},
            "conditions": [],
            "recordings": [],
            "restore": None,
            "finished": False,
        }
        self._counter = 0

    # -- files ---------------------------------------------------------------------------------

    @staticmethod
    def runs_dir(root: Path) -> Path:
        return Path(root) / RUNS_DIR

    @property
    def path(self) -> Path:
        return self.runs_dir(self.root) / f"{self.run_id}.json"

    @classmethod
    def new_id(cls, root: Path) -> str:
        base = datetime.now().strftime("%Y%m%d-%H%M%S")
        rid, k = base, 1
        while (cls.runs_dir(root) / f"{rid}.json").exists():
            k += 1
            rid = f"{base}-{k}"
        return rid

    @classmethod
    def load(cls, root: Path, run_id: str) -> Run:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", run_id or ""):
            raise CollectError(f"bad run id {run_id!r}")
        path = cls.runs_dir(root) / f"{run_id}.json"
        if not path.exists():
            raise CollectError(f"no collection run {run_id!r}", 404)
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("format") != RUN_FORMAT:
            raise CollectError(f"{path} is not a collection run")
        run = cls(root, run_id)
        run.data = data
        for c in data["conditions"]:
            if c.get("status") == "recording":  # the engine stopped in the middle of it
                c["status"] = "pending"
                for a in c.get("attempts", []):
                    if a.get("outcome") == "recording":
                        a["outcome"] = "interrupted"
        run._counter = max([int(str(c["id"]).lstrip("c") or 0) for c in data["conditions"] if str(c.get("id", "")).lstrip("c").isdigit()] or [0])
        return run

    def save(self) -> None:
        self.data["updated"] = datetime.now(timezone.utc).isoformat()
        self.data["recordings"] = self.recordings()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=1, allow_nan=False) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    # -- queue ---------------------------------------------------------------------------------

    @property
    def conditions(self) -> list[dict[str, Any]]:
        return self.data["conditions"]

    def _index(self, index: Any) -> int:
        try:
            i = int(index)
        except (TypeError, ValueError) as exc:
            raise CollectError("index must be a number") from exc
        if not 0 <= i < len(self.conditions):
            raise CollectError(f"no condition {i} (the run has {len(self.conditions)})")
        return i

    def add(self, condition: dict[str, Any], at: int | None = None) -> dict[str, Any]:
        self._counter += 1
        entry = {**condition, "id": f"c{self._counter:02d}", "status": "pending", "attempts": []}
        if at is None or not 0 <= int(at) <= len(self.conditions):
            self.conditions.append(entry)
        else:
            self.conditions.insert(int(at), entry)
        return entry

    def remove(self, index: Any) -> None:
        i = self._index(index)
        if self.conditions[i]["status"] == "recording":
            raise CollectError("this condition is being recorded", 409)
        del self.conditions[i]

    def move(self, index: Any, to: Any) -> None:
        i = self._index(index)
        j = max(0, min(len(self.conditions) - 1, int(to)))
        c = self.conditions.pop(i)
        self.conditions.insert(j, c)

    def repeat(self, index: Any) -> dict[str, Any]:
        """Queue the same physical setup again, straight after this one."""
        i = self._index(index)
        src = self.conditions[i]
        keep = {k: v for k, v in src.items() if k not in ("id", "status", "attempts")}
        return self.add(keep, i + 1)

    def set_status(self, index: Any, status: str) -> None:
        if status not in STATUSES:
            raise CollectError(f"status must be one of {', '.join(STATUSES)}")
        self.conditions[self._index(index)]["status"] = status

    def set_notes(self, index: Any, notes: str) -> None:
        self.conditions[self._index(index)]["notes"] = str(notes or "")[:2000]

    def next_pending(self) -> int | None:
        return next((i for i, c in enumerate(self.conditions) if c["status"] == "pending"), None)

    def recordings(self) -> list[dict[str, Any]]:
        out = []
        for c in self.conditions:
            done = [a for a in c.get("attempts", []) if a.get("outcome") == "completed"]
            if c["status"] in ("done", "poor") and done:
                a = done[-1]
                out.append({"condition_id": c["id"], "label": c["label"], "recording_id": a["recording_id"], "path": a["path"], "quality": a.get("quality"), "poor": c["status"] == "poor"})
        return out

    def estimate_s(self, protocol_s: float, setup_s: float) -> float:
        left = sum(1 for c in self.conditions if c["status"] in ("pending", "recording"))
        return left * (protocol_s + setup_s)

    def to_dict(self) -> dict[str, Any]:
        return {**json.loads(json.dumps(self.data)), "path": str(self.path), "next": self.next_pending()}


def list_runs(root: Path) -> list[dict[str, Any]]:
    d = Run.runs_dir(root)
    out = []
    if not d.is_dir():
        return out
    for p in d.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("format") != RUN_FORMAT:
            continue
        cs = data.get("conditions") or []
        out.append(
            {
                "run_id": data.get("run_id"),
                "created": data.get("created"),
                "updated": data.get("updated"),
                "finished": bool(data.get("finished")),
                "conditions": len(cs),
                "done": sum(1 for c in cs if c.get("status") in ("done", "poor")),
                "pending": sum(1 for c in cs if c.get("status") in ("pending", "recording")),
                "path": str(p),
            }
        )
    out.sort(key=lambda r: r.get("created") or "", reverse=True)
    return out


# --------------------------------------------------------------------------------------------
# Quality
# --------------------------------------------------------------------------------------------


class Quality:
    """Per-frame face and eye counts over a condition's recording."""

    def __init__(self) -> None:
        self.frames = 0
        self.face = 0
        self.both = 0
        self._last_t: float | None = None

    def ingest(self, obs: Any) -> None:
        from .diagnostics import frame_record

        r = frame_record(obs)
        self.frames += 1
        self.face += bool(r["face"])
        self.both += bool(r["both"])

    def poll(self, engine: Any) -> None:
        for obs in list(getattr(engine, "_recent_obs", None) or []):
            t = getattr(obs, "t_local", None)
            if t is None or (self._last_t is not None and t <= self._last_t):
                continue
            self._last_t = t
            self.ingest(obs)

    def to_dict(self, frames_received: int | None = None) -> dict[str, Any]:
        def pct(n: int) -> float | None:
            return round(100.0 * n / self.frames, 1) if self.frames else None

        return {"frames_received": frames_received, "frames_processed": self.frames, "face_pct": pct(self.face), "both_eyes_pct": pct(self.both)}


def is_poor(quality: dict[str, Any], min_eyes_pct: float) -> bool:
    p = quality.get("both_eyes_pct")
    return p is None or p < float(min_eyes_pct)


def recent_found(engine: Any, seconds: float = 1.0) -> dict[str, Any]:
    """Face and both-eyes percentages over the engine's last ``seconds`` of observations."""
    from .diagnostics import frame_record

    obs = list(getattr(engine, "_recent_obs", None) or [])
    if not obs:
        return {"frames": 0, "face_pct": 0.0, "both_eyes_pct": 0.0}
    t_end = max((o.t_local or 0.0) for o in obs)
    if time.monotonic() - t_end > 1.5:
        return {"frames": 0, "face_pct": 0.0, "both_eyes_pct": 0.0}
    recs = [frame_record(o) for o in obs if o.t_local is not None and o.t_local >= t_end - seconds]
    n = len(recs)
    return {"frames": n, "face_pct": round(100.0 * sum(r["face"] for r in recs) / n, 1) if n else 0.0, "both_eyes_pct": round(100.0 * sum(r["both"] for r in recs) / n, 1) if n else 0.0}


# --------------------------------------------------------------------------------------------
# The live side: one Collector per engine
# --------------------------------------------------------------------------------------------


def sweep_command(run: Run) -> str:
    return f"cd sidecars/phone-gaze/engine && .venv/bin/python -m phonegaze sweep {run.run_id}"


class Collector:
    def __init__(self, engine: Any) -> None:
        self.engine = engine
        self.run: Run | None = None
        self.index: int | None = None
        """The condition being prepared or recorded."""
        self.camera: dict[str, Any] | None = None
        self.manifest: Manifest | None = None
        self.recording: dict[str, Any] | None = None
        self.quality = Quality()
        self._settled_since: float | None = None
        self._poll_task: asyncio.Task | None = None
        self._sim_busy = False
        self._last_pose: int | None = None

    # -- helpers -------------------------------------------------------------------------------

    @property
    def cfg(self) -> Any:
        return self.engine.config.collect

    @property
    def root(self) -> Path:
        return Path(self.engine.config.recording.directory).expanduser()

    def protocol(self) -> dict[str, Any]:
        scr = self.engine.screen
        if scr is None:
            raise CollectError("the screen size is not known yet", 409)
        c = self.engine.config.calibration
        p = self.run.data["protocol"] if self.run else {"length": self.cfg.protocol, "pursuit": self.cfg.pursuit}
        return build_protocol(scr.width, scr.height, p["length"], pursuit=p["pursuit"], settle_ms=c.settle_ms, collect_ms=c.collect_ms, margin=c.margin)

    def _need_run(self) -> Run:
        if self.run is None:
            raise CollectError("no collection run is open: start or resume one", 409)
        return self.run

    def _screen(self) -> dict[str, Any]:
        s = self.engine.screen
        return {"width_pt": s.width, "height_pt": s.height, "width_mm": s.width_mm, "height_mm": s.height_mm} if s else {}

    def run_view(self) -> dict[str, Any] | None:
        if self.run is None:
            return None
        try:
            proto = self.protocol()
        except CollectError:
            proto = None
        d = self.run.to_dict()
        d["protocol_seconds"] = proto["seconds"] if proto else None
        d["estimate_s"] = self.run.estimate_s(proto["seconds"], float(self.cfg.setup_estimate_s)) if proto else None
        d["active_index"] = self.index
        d["recording"] = self.recording
        d["command"] = sweep_command(self.run)
        return d

    # -- runs ----------------------------------------------------------------------------------

    def options(self) -> dict[str, Any]:
        sets = condition_sets(float(self.cfg.short_shutter_ms))
        cams = list(((getattr(self.engine, "phone_status", None) or {}).get("cameras")) or [])
        try:
            proto_s = {k: build_protocol(*(self._wh()), k, pursuit=self.cfg.pursuit, settle_ms=self.engine.config.calibration.settle_ms, collect_ms=self.engine.config.calibration.collect_ms)["seconds"] for k in LENGTHS}
        except CollectError:
            proto_s = {}
        return {
            "cameras": [{"kind": k, "label": v["label"], "position": v["position"], "available": resolve_camera(k, cams) is not None if cams else None} for k, v in CAMERAS.items()],
            "sets": {k: {**v, "count": len(v["conditions"])} for k, v in sets.items()},
            "lengths": {k: {"label": v["label"], "seconds": proto_s.get(k)} for k, v in LENGTHS.items()},
            "setup_estimate_s": float(self.cfg.setup_estimate_s),
            "defaults": {"length": self.cfg.protocol, "pursuit": self.cfg.pursuit, "short_shutter_ms": self.cfg.short_shutter_ms},
            "reflection": list(REFLECTION),
            "focus": list(FOCUS),
            "folder": str(self.root),
            "sweep_page": _sweep_page(),
        }

    def _wh(self) -> tuple[float, float]:
        s = self.engine.screen
        if s is None:
            raise CollectError("the screen size is not known yet", 409)
        return float(s.width), float(s.height)

    def new_run(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.recording is not None:
            raise CollectError("a condition is being recorded; finish or stop it first", 409)
        length = str(body.get("length") or self.cfg.protocol)
        if length not in LENGTHS:
            raise CollectError(f"length must be one of {', '.join(LENGTHS)}")
        sets = condition_sets(float(self.cfg.short_shutter_ms))
        conds: list[dict[str, Any]] = []
        for name in body.get("sets") or []:
            if name not in sets:
                raise CollectError(f"unknown set {name!r}; one of {', '.join(sets)}")
            for c in sets[name]["conditions"]:
                if not any(_same_setup(c, x) for x in conds):
                    conds.append(c)
        for c in body.get("conditions") or []:
            conds.append(condition_from_dict(c))
        run = Run(self.root, Run.new_id(self.root), length=length, pursuit=bool(body.get("pursuit", self.cfg.pursuit)))
        for c in conds:
            run.add(c)
        run.save()
        self.run, self.index = run, None
        return self.run_view() or {}

    def open_run(self, run_id: str) -> dict[str, Any]:
        if self.recording is not None:
            raise CollectError("a condition is being recorded; finish or stop it first", 409)
        self.run, self.index = Run.load(self.root, run_id), None
        self.run.data["finished"] = False
        self.run.save()
        return self.run_view() or {}

    def queue(self, body: dict[str, Any]) -> dict[str, Any]:
        run = self._need_run()
        op = str(body.get("op") or "")
        index = body.get("index")
        if op == "add":
            run.add(condition_from_dict(body.get("condition") or {}), body.get("at"))
        elif op == "remove":
            run.remove(index)
        elif op == "move":
            run.move(index, body.get("to"))
        elif op == "repeat":
            run.repeat(index)
        elif op in ("redo", "skip"):
            i = run._index(index)
            if i == self.index and self.recording is not None:
                raise CollectError("this condition is being recorded: press Esc on it first", 409)
            run.set_status(i, "pending" if op == "redo" else "skipped")
        elif op == "notes":
            run.set_notes(index, str(body.get("notes") or ""))
        else:
            raise CollectError("op must be add, remove, move, repeat, redo, skip or notes")
        run.save()
        return self.run_view() or {}

    # -- one condition -------------------------------------------------------------------------

    async def prepare(self, index: Any) -> dict[str, Any]:
        """Configure the phone for condition ``index``; say what the person has to do."""
        run = self._need_run()
        if self.recording is not None:
            raise CollectError("a condition is being recorded", 409)
        i = run._index(index)
        cond = run.conditions[i]
        eng = self.engine
        if eng.phone is None:
            raise CollectError("no phone connected: connect it on the Dashboard first", 409)
        cams = list((eng.phone_status or {}).get("cameras") or [])
        cam = resolve_camera(cond["camera"], cams)
        if cam is None:
            raise CollectError(f"this phone has no {CAMERAS[cond['camera']]['label'].lower()}; skip this condition", 409)
        changes = condition_settings(cond)
        if run.data.get("restore") is None:
            from .config import get_value

            paths = sorted({p for c in run.conditions for p in condition_settings(c)} | {"lens.camera_id"})
            run.data["restore"] = {"settings": {p: get_value(eng.config, p) for p in paths}, "paused": bool(eng.paused)}
            run.save()
        eng.set_paused(True)  # no cursor, no dwell clicks, no gaze to Forsee while collecting
        previous = eng.last_frame.camera.position if eng.last_frame is not None else None
        live = {k: v for k, v in changes.items() if k not in ("lens.zoom", "lens.fps")}
        errors = await eng.apply_config(live)
        if errors:
            raise CollectError("; ".join(f"{k}: {v}" for k, v in errors.items()))
        await eng.set_camera(cam["id"], 1.0 if cam.get("type") == "arkit" else float(cond["zoom"]), float(cond["fps"]))
        if cam.get("type") != "arkit":
            await eng.send_lens_controls()
        self.index, self.camera = i, cam
        self._settled_since = None
        prompts = []
        pos = CAMERAS[cond["camera"]]["position"]
        if previous and previous != pos:
            prompts.append("Turn the phone round so its back cameras face you." if pos == "back" else "Turn the phone round so its screen and front camera face you.")
        elif previous is None:
            prompts.append("Place the phone below the screen with its back cameras facing you." if pos == "back" else "Place the phone below the screen with its screen and front camera facing you.")
        mfd = cam.get("minFocusDistanceMM")
        if isinstance(mfd, (int, float)) and mfd > 600:
            prompts.append(f"This camera cannot focus closer than about {mfd / 10:.0f} cm: sit back so your eyes are at least that far from the phone, or skip this condition.")
        if float(cond["zoom"]) >= 2 and pos == "back":
            prompts.append(f"At {float(cond['zoom']):g}x the picture is narrow: keep your head centred in the preview.")
        if cond.get("notes"):
            prompts.append(f"Your notes for this setup: {cond['notes']}")
        return {"index": i, "condition": cond, "camera": {"id": cam["id"], "name": cam.get("name"), "type": cam.get("type"), "position": cam.get("position")}, "prompts": prompts, "run": self.run_view()}

    def readiness(self) -> dict[str, Any]:
        eng = self.engine
        now = time.monotonic()
        found = recent_found(eng)
        cam = self.camera
        frame = eng.last_frame
        camera_ok = False
        adjusting = None
        if frame is not None and cam is not None and self.run is not None and self.index is not None:
            want_zoom = 1.0 if cam.get("type") == "arkit" else float(self.run.conditions[self.index]["zoom"])
            camera_ok = frame.camera.id == cam["id"] and (frame.camera.type == "arkit" or abs(float(frame.camera.zoom) - want_zoom) < 0.05)
            adjusting = bool(frame.lens.adjusting_focus) or bool(frame.lens.adjusting_exposure)
        fresh = frame is not None and frame.t_received is not None and now - frame.t_received < 1.5
        if not (camera_ok and fresh) or adjusting:
            self._settled_since = None
        elif self._settled_since is None:
            self._settled_since = now
        settled = self._settled_since is not None and now - self._settled_since >= float(self.cfg.settle_s)
        face = found["face_pct"] >= 50.0
        eyes = found["both_eyes_pct"] >= 50.0
        if cam is None:
            msg = "Choose a condition to prepare."
        elif not fresh:
            msg = "No frames from the phone. Is the app open, in the foreground, with the screen on?"
        elif not camera_ok:
            msg = "Waiting for the phone to switch camera and zoom…"
        elif not settled:
            msg = "Waiting for focus and exposure to settle…"
        elif not face:
            msg = "No face found. Sit in front of the camera, facing it, with light on your face."
        elif not eyes:
            msg = "Face found, but not both eyes. Look at the screen, move nearer, or add light."
        else:
            msg = "Both eyes found. Ready."
        return {"camera_ok": camera_ok, "fresh": fresh, "adjusting": adjusting, "settled": settled, "face": face, "eyes": eyes, "ready": bool(settled and face and eyes), "message": msg, **found}

    async def start(self, index: Any) -> dict[str, Any]:
        run = self._need_run()
        i = run._index(index)
        eng = self.engine
        if self.index != i or self.camera is None:
            raise CollectError("prepare this condition first", 409)
        if self.recording is not None:
            raise CollectError("a condition is already being recorded", 409)
        if eng.recorder is not None:
            raise CollectError("a recording is already running (Recordings page); stop it first", 409)
        r = self.readiness()
        if not r["face"]:
            raise CollectError(f"Not starting: no face found in the last second ({r['message']})", 409)
        proto = self.protocol()
        cond = run.conditions[i]
        attempt_no = len(cond.get("attempts", [])) + 1
        rec = eng.start_recording(f"collect-{run.run_id}-{cond['id']}-a{attempt_no}")
        self.recording = {**rec, "index": i, "attempt": attempt_no}
        settings = condition_settings(cond)
        settings["lens.camera_id"] = self.camera["id"]
        mcond = {"id": cond["id"], "label": cond["label"], "camera_id": self.camera["id"], "camera_label": self.camera.get("name") or CAMERAS[cond["camera"]]["label"], "zoom": 1.0 if self.camera.get("type") == "arkit" else float(cond["zoom"]), "settings": settings, "notes": cond.get("notes", "")}
        self.manifest = Manifest(run.run_id, mcond, self._screen())
        self.manifest.write(Path(rec["path"]))
        cond["status"] = "recording"
        cond.setdefault("attempts", []).append({"recording_id": rec["id"], "path": rec["path"], "outcome": "recording", "started": self.manifest.data["started"]})
        run.save()
        if eng.recorder is not None:
            eng.recorder.write_event({"type": "collect.start", "run_id": run.run_id, "condition": mcond, "protocol": proto})
        self.quality = Quality()
        self.quality._last_t = time.monotonic()
        self._last_pose = None
        self._start_poll()
        return {"recording": self.recording, "protocol": proto, "condition": mcond}

    def _start_poll(self) -> None:
        async def poll() -> None:
            while True:
                await asyncio.sleep(0.25)
                self.quality.poll(self.engine)

        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.ensure_future(poll())

    def _stop_poll(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            self._poll_task = None
        self.quality.poll(self.engine)

    def _need_recording(self) -> Manifest:
        if self.manifest is None or self.recording is None:
            raise CollectError("no condition is being recorded", 409)
        return self.manifest

    async def dot(self, body: dict[str, Any]) -> dict[str, Any]:
        t = time.monotonic()
        m = self._need_recording()
        phase = str(body.get("phase") or "")
        state = body.get("state")
        try:
            dot_id = int(body["dot_id"])
            x, y = float(body["x"]), float(body["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise CollectError("dot_id, x and y are required") from exc
        pg = body.get("pose_group")
        pose_group = None if pg is None else int(pg)
        if state == "on":
            m.dot_on(phase, dot_id, x, y, t, pose_group)
        elif state == "off":
            m.dot_off(phase, dot_id, t)
        else:
            raise CollectError("state must be on or off")
        rec = self.engine.recorder
        if rec is not None:
            rec.write_event({"type": "collect.dot", "phase": phase, "dot_id": dot_id, "x": x, "y": y, "state": state, "pose_group": pose_group, "t_local": t})
        if state == "off" and phase != "pursuit":
            m.write(Path(self.recording["path"]))  # type: ignore[index]
        if state == "on" and self.engine.simulated:
            await self._sim(x, y, pose_group if phase == "poses" else 0)
        return {"ok": True, "t": t}

    async def _sim(self, x: float, y: float, pose_group: int | None) -> None:
        """Simulator only: the simulated person looks at the dot and moves the head as asked."""
        eng = self.engine
        if pose_group is not None and pose_group != self._last_pose:
            self._last_pose = pose_group
            eng._sim_pose(pose_group)
        if eng.phone is not None:
            try:
                await eng.phone.sim_gaze(x, y)
            except Exception as exc:  # noqa: BLE001
                log.warning("simulator /sim/gaze failed: %s", exc)

    async def pursuit(self, body: dict[str, Any]) -> dict[str, Any]:
        t = time.monotonic()
        m = self._need_recording()
        try:
            x, y = float(body["x"]), float(body["y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise CollectError("x and y are required") from exc
        m.sample(t, x, y)
        if self.engine.simulated and not self._sim_busy and self.engine.phone is not None:
            self._sim_busy = True

            async def go() -> None:
                try:
                    await self.engine.phone.sim_gaze(x, y)
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    self._sim_busy = False

            asyncio.ensure_future(go())
        return {"ok": True, "t": t}

    def phase(self, body: dict[str, Any]) -> dict[str, Any]:
        m = self._need_recording()
        name = str(body.get("name") or "")
        if body.get("restart"):
            m.restart_phase(name)
        else:
            m.phase(name)
        if self.engine.recorder is not None:
            self.engine.recorder.write_event({"type": "collect.phase", "name": name, "restart": bool(body.get("restart"))})
        m.write(Path(self.recording["path"]))  # type: ignore[index]
        return {"ok": True}

    def status(self) -> dict[str, Any]:
        rec = self.engine.recorder
        if self.recording is not None:
            self.quality.poll(self.engine)
        q = self.quality.to_dict(rec.frames if rec is not None and self.recording is not None else None)
        return {"recording": self.recording, "quality": q, "poor_below_pct": float(self.cfg.poor_eyes_pct), "run_id": self.run.run_id if self.run else None, "index": self.index}

    def _close_recording(self) -> dict[str, Any]:
        self._stop_poll()
        rec = self.engine.recorder
        frames = rec.frames if rec is not None else None
        summary = self.engine.stop_recording() or {}
        if self.engine.simulated:
            self.engine._sim_restore_pose()
        return {"summary": summary, "quality": self.quality.to_dict(frames)}

    def finish(self) -> dict[str, Any]:
        run = self._need_run()
        m = self._need_recording()
        assert self.recording is not None
        i = self.recording["index"]
        out = self._close_recording()
        q = out["quality"]
        poor = is_poor(q, float(self.cfg.poor_eyes_pct))
        m.drop_open()
        m.data["completed"] = True
        m.write(Path(self.recording["path"]))
        cond = run.conditions[i]
        cond["status"] = "poor" if poor else "done"
        a = cond["attempts"][-1]
        a.update({"outcome": "completed", "quality": q, "poor": poor, "seconds": out["summary"].get("seconds")})
        run.save()
        result = {"index": i, "condition": cond, "quality": q, "poor": poor, "path": self.recording["path"], "recording_id": self.recording["id"], "run": None}
        self.recording, self.manifest = None, None
        result["run"] = self.run_view()
        return result

    def abort(self, action: str) -> dict[str, Any]:
        """Esc on the page, then: ``redo`` (record this condition again), ``skip`` or ``stop``
        (leave it pending and stop for now; resume the run later). The attempt's recording stays
        on disk with ``"completed": false``."""
        run = self._need_run()
        if action not in ("redo", "skip", "stop"):
            raise CollectError("action must be redo, skip or stop")
        if self.recording is not None and self.manifest is not None:
            i = self.recording["index"]
            out = self._close_recording()
            self.manifest.drop_open()
            self.manifest.data["completed"] = False
            self.manifest.write(Path(self.recording["path"]))
            run.conditions[i]["attempts"][-1].update({"outcome": f"aborted ({action})", "quality": out["quality"]})
            self.recording, self.manifest = None, None
        else:
            i = self.index
        if i is not None:
            run.conditions[i]["status"] = "skipped" if action == "skip" else "pending"
        if action != "redo":
            self.index, self.camera = None, None
        run.save()
        return self.run_view() or {}

    async def close(self, restore: bool = True) -> dict[str, Any]:
        """End the run for now: restore the settings from before it and unpause."""
        run = self._need_run()
        if self.recording is not None:
            self.abort("stop")
        eng = self.engine
        saved = run.data.get("restore") or {}
        errors: dict[str, str] = {}
        if restore and saved.get("settings"):
            errors = await eng.apply_config(saved["settings"])
            run.data["restore"] = None
        if restore:
            eng.set_paused(bool(saved.get("paused", False)))
        run.data["finished"] = run.next_pending() is None
        run.save()
        summary = {
            "run_id": run.run_id,
            "run_file": str(run.path),
            "folder": str(self.root),
            "conditions": [{"id": c["id"], "label": c["label"], "status": c["status"], "quality": (c.get("attempts") or [{}])[-1].get("quality"), "path": (c.get("attempts") or [{}])[-1].get("path")} for c in run.conditions],
            "recordings": run.recordings(),
            "command": sweep_command(run),
            "sweep_page": _sweep_page(),
            "restore_errors": errors,
            "finished": run.data["finished"],
        }
        self.run, self.index, self.camera = None, None, None
        return summary

    # -- best preset from the sweep ------------------------------------------------------------

    def best_preset(self) -> dict[str, Any] | None:
        store = getattr(self.engine, "presets", None)
        if store is None:
            from . import presets as P

            store = P.PresetStore(P.store_path(getattr(self.engine, "config_path", None)))
        found = [p for p in store.all() if not p.get("builtin") and str(p["name"]).lower().startswith(BEST_PRESET)]
        if not found:
            return None
        best = max(found, key=lambda p: str(p.get("saved") or ""))
        ch = best.get("changes") or {}
        prefer = ch.get("lens.camera_prefer")
        camera = {"arkit": "front ARKit camera", "front": "front camera", "back": "back camera"}.get(prefer or "", "")
        zoom = ch.get("lens.zoom")
        return {"name": best["name"], "description": best.get("description", ""), "saved": best.get("saved"), "camera": camera or None, "zoom": zoom, "changes": ch}


def _same_setup(a: dict[str, Any], b: dict[str, Any]) -> bool:
    keys = ("camera", "zoom", "fps", "max_exposure_ms", "exposure_bias", "focus", "reflection", "settings")
    return all(a.get(k) == b.get(k) for k in keys)


def _sweep_page() -> str | None:
    from .web import STATIC_DIR

    return "sweep.html" if (Path(STATIC_DIR) / "sweep.html").exists() else None


# --------------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------------


def register(app: Any, engine: Any) -> Collector:
    """Add ``/api/collect/*`` (call before the ``/api`` 404 route)."""
    from aiohttp import web

    col = Collector(engine)
    engine.collector = col

    def _json(data: Any, status: int = 200) -> web.Response:
        return web.json_response(data, status=status, dumps=lambda d: json.dumps(d, allow_nan=False, default=str))

    async def _body(request: web.Request) -> dict[str, Any]:
        if not request.can_read_body:
            return {}
        try:
            data = await request.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def guard(fn: Any) -> Any:
        async def wrapped(request: web.Request) -> web.StreamResponse:
            try:
                return _json(await fn(request))
            except web.HTTPException:
                raise
            except CollectError as exc:
                return _json({"error": str(exc)}, exc.status)
            except Exception as exc:  # noqa: BLE001 - PhoneError and friends
                from .phone import PhoneError

                if isinstance(exc, PhoneError):
                    return _json({"error": f"The phone refused: {exc}"}, 502)
                log.exception("%s %s failed", request.method, request.path)
                return _json({"error": f"{type(exc).__name__}: {exc}"}, 500)

        return wrapped

    async def options(request: web.Request) -> Any:
        return {**col.options(), "run": col.run_view(), "runs": list_runs(col.root)}

    async def runs(request: web.Request) -> Any:
        return {"runs": list_runs(col.root), "open": col.run.run_id if col.run else None}

    async def new(request: web.Request) -> Any:
        return col.new_run(await _body(request))

    async def get_run(request: web.Request) -> Any:
        rid = request.query.get("run_id")
        if not rid or (col.run is not None and rid == col.run.run_id):
            view = col.run_view()
            if view is None:
                raise CollectError("no collection run is open", 404)
            return view
        return Run.load(col.root, rid).to_dict()

    async def open_run(request: web.Request) -> Any:
        return col.open_run(str((await _body(request)).get("run_id") or ""))

    async def queue(request: web.Request) -> Any:
        return col.queue(await _body(request))

    async def prepare(request: web.Request) -> Any:
        return await col.prepare((await _body(request)).get("index"))

    async def ready(request: web.Request) -> Any:
        return col.readiness()

    async def start(request: web.Request) -> Any:
        return await col.start((await _body(request)).get("index"))

    async def dot(request: web.Request) -> Any:
        return await col.dot(await _body(request))

    async def pursuit(request: web.Request) -> Any:
        return await col.pursuit(await _body(request))

    async def phase(request: web.Request) -> Any:
        return col.phase(await _body(request))

    async def status(request: web.Request) -> Any:
        return col.status()

    async def finish(request: web.Request) -> Any:
        return col.finish()

    async def abort(request: web.Request) -> Any:
        return col.abort(str((await _body(request)).get("action") or ""))

    async def close(request: web.Request) -> Any:
        return await col.close(bool((await _body(request)).get("restore", True)))

    async def best_get(request: web.Request) -> Any:
        return {"preset": col.best_preset()}

    async def best_apply(request: web.Request) -> Any:
        from . import presets as P

        best = col.best_preset()
        if best is None:
            raise CollectError(f"no preset named '{BEST_PRESET}' yet: run the sweep first", 404)
        store = getattr(engine, "presets", None) or P.PresetStore(P.store_path(getattr(engine, "config_path", None)))
        changes = P.changes_to_apply(store.get(best["name"]), engine.config)
        errors = await engine.apply_config(changes) if changes else {}
        return {"preset": best, "applied": changes, "errors": errors}

    r = app.router
    r.add_get("/api/collect/options", guard(options))
    r.add_get("/api/collect/runs", guard(runs))
    r.add_post("/api/collect/runs/new", guard(new))
    r.add_get("/api/collect/run", guard(get_run))
    r.add_post("/api/collect/open", guard(open_run))
    r.add_post("/api/collect/queue", guard(queue))
    r.add_post("/api/collect/prepare", guard(prepare))
    r.add_get("/api/collect/ready", guard(ready))
    r.add_post("/api/collect/start", guard(start))
    r.add_post("/api/collect/dot", guard(dot))
    r.add_post("/api/collect/pursuit", guard(pursuit))
    r.add_post("/api/collect/phase", guard(phase))
    r.add_get("/api/collect/status", guard(status))
    r.add_post("/api/collect/finish", guard(finish))
    r.add_post("/api/collect/abort", guard(abort))
    r.add_post("/api/collect/close", guard(close))
    r.add_get("/api/collect/best-preset", guard(best_get))
    r.add_post("/api/collect/best-preset/apply", guard(best_apply))
    return col
