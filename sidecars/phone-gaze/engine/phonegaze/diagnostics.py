"""Diagnostics: the log file, the live health strip, state-change logging and the diagnostics
bundle. Owner: Diagnostics (with ``doctor.py``).

Nothing here changes what the engine computes. It watches the :class:`~phonegaze.pipeline.Engine`
from outside (its recent observations, counters and state) so the owner can see which stage of a
first real run fails, and send the developers numbers instead of guesses.

- :func:`setup_file_logging`: a rotating log file under ``~/.phonegaze/logs`` (setting
  ``diagnostics.log_file``), with a header line saying what is running.
- :class:`HealthMonitor`: per-frame success of every stage (face, each eye, sub-pixel iris fit,
  screen reflection, distance, usable frame, eyes open) as rolling percentages over the last
  ``diagnostics.health_window_s`` seconds, plus medians (iris size, distance, sharpness,
  brightness), blink rate and geometry plausibility. :meth:`HealthMonitor.strip` is the health
  strip the UI shows; it is served at ``GET /api/diagnostics/health`` and broadcast as the UI
  WebSocket message ``{"type": "health", ...}`` once a second.
- :class:`StateLogger`: one log line for every state change (phone, camera, face found or lost,
  calibration, model, cursor, shortcuts, pause, recording, screen).
- :func:`write_bundle`: one folder under ``~/.phonegaze/diagnostics`` with logs, config,
  calibration scores, doctor results, stream statistics, timings, recent observations and a
  short ``summary.txt`` to paste into a chat. Images only when asked for.
- :func:`register`: the HTTP routes and the background task, added by ``server.create_app``.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import logging
import logging.handlers
import math
import platform
import shutil
import subprocess
import sys
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)
events = logging.getLogger("phonegaze.events")
"""State-change lines (``StateLogger``) go here so they are easy to find in the log file."""

LOG_NAME = "phonegaze.log"

# Plausible ranges for an adult face at a desk. Wide on purpose: they catch a wrong detection
# (an eyebrow taken for an eye, a 2x error in the camera matrix), not an unusual face.
IOD_MM = (50.0, 78.0)
"""Distance between the two eyeball centres."""
SPACING_RATIO = (4.0, 7.5)
"""Distance between the two iris centres divided by the iris diameter (both in pixels). About
63 mm / 11.7 mm = 5.4 for an adult looking at the camera; it needs no camera matrix or distance."""
IRIS_MM = (9.5, 14.0)
"""Iris diameter from its pixel size, the distance and the focal length."""
DISTANCE_M = (0.25, 1.2)
BLINKS_PER_MIN = (3.0, 40.0)


# --------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------


def data_dir(config_path: str | Path | None = None) -> Path:
    """``~/.phonegaze`` (or the folder that holds ``--config``)."""
    from .config import DEFAULT_PATH

    return Path(config_path).expanduser().parent if config_path else DEFAULT_PATH.parent


def log_dir(config_path: str | Path | None = None) -> Path:
    return data_dir(config_path) / "logs"


def _median(values: list[float]) -> float | None:
    vals = sorted(v for v in values if v is not None and isinstance(v, (int, float)) and math.isfinite(v))
    if not vals:
        return None
    n = len(vals)
    return float(vals[n // 2]) if n % 2 else float(0.5 * (vals[n // 2 - 1] + vals[n // 2]))


def _round(v: Any, nd: int = 2) -> Any:
    if isinstance(v, float):
        return round(v, nd) if math.isfinite(v) else None
    return v


def non_default_settings(config: Any) -> dict[str, dict[str, Any]]:
    """``{path: {"value", "default"}}`` for every setting that differs from its default."""
    from .config import get_value, settings

    out: dict[str, dict[str, Any]] = {}
    for s in settings():
        try:
            value = get_value(config, s.path)
        except AttributeError:
            continue
        if value != s.default:
            out[s.path] = {"value": value, "default": s.default}
    return out


def _jsonable(obj: Any) -> Any:
    try:
        from .types import _jsonable as conv

        return conv(obj)
    except Exception:  # noqa: BLE001
        return json.loads(json.dumps(obj, default=str))


def _dumps(obj: Any) -> str:
    return json.dumps(_jsonable(obj), indent=2, default=str, allow_nan=False) + "\n"


# --------------------------------------------------------------------------------------------
# Log file
# --------------------------------------------------------------------------------------------


def setup_file_logging(config: Any, directory: str | Path | None = None, *, argv: list[str] | None = None) -> Path | None:
    """Add a rotating file handler (``diagnostics.log_file``) to the root logger and write a
    header line. Returns the log file's path, or ``None`` when switched off or not writable.
    Calling it again replaces the earlier handler."""
    d = config.diagnostics
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_phonegaze_file", False):
            root.removeHandler(h)
            h.close()
    if not d.log_file:
        return None
    folder = Path(directory).expanduser() if directory else log_dir()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / LOG_NAME
        handler = logging.handlers.RotatingFileHandler(path, maxBytes=int(d.log_max_mb * 1024 * 1024), backupCount=int(d.log_backups), encoding="utf-8")
    except OSError as exc:
        log.warning("cannot write the log file in %s: %s", folder, exc)
        return None
    handler._phonegaze_file = True  # type: ignore[attr-defined]
    level = getattr(logging, str(d.log_level).upper(), logging.INFO)
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter("%(asctime)s.%(msecs)03d %(levelname)-7s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    if root.level > level or root.level == logging.NOTSET:
        # Let DEBUG reach the file without making the terminal chattier than it was.
        for h in root.handlers:
            if h.level == logging.NOTSET:
                h.setLevel(root.level or logging.WARNING)
        root.setLevel(level)
    root.addHandler(handler)
    from . import __version__

    changed = non_default_settings(config)
    log.info(
        "=== Phone Gaze %s starting: Python %s on %s; argv %s; changed settings: %s",
        __version__,
        platform.python_version(),
        _platform_text(),
        " ".join(argv if argv is not None else sys.argv[1:]) or "-",
        ", ".join(f"{k}={v['value']!r}" for k, v in changed.items()) or "none",
    )
    return path


def _platform_text() -> str:
    if sys.platform == "darwin":
        mac = platform.mac_ver()[0]
        return f"macOS {mac or '?'} {platform.machine()}"
    return f"{platform.system()} {platform.release()} {platform.machine()}"


def current_log_file() -> Path | None:
    for h in logging.getLogger().handlers:
        if getattr(h, "_phonegaze_file", False):
            return Path(h.baseFilename)  # type: ignore[attr-defined]
    return None


def tail_log(path: Path | None, lines: int = 200) -> list[str]:
    if path is None or not path.exists():
        return []
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 256 * 1024))
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    return data.splitlines()[-lines:]


# --------------------------------------------------------------------------------------------
# Health: per-frame records and rolling summaries
# --------------------------------------------------------------------------------------------


def frame_record(obs: Any) -> dict[str, Any]:
    """What one observation says about each stage. Values are ``None`` when not measured."""
    q = obs.quality or {}
    prov = obs.provenance or {}
    eyes = {"left": obs.left, "right": obs.right}
    found = {s: bool(e.found or e.iris_center is not None) for s, e in eyes.items()}
    face = bool(obs.face_rect is not None or obs.head_position is not None or any(found.values()))
    rec: dict[str, Any] = {
        "seq": obs.seq,
        "face": face,
        "left": found["left"],
        "right": found["right"],
        "both": found["left"] and found["right"],
    }
    fits = []
    for s, e in eyes.items():
        fitted = e.iris_ellipse is not None or prov.get(f"{s}.iris_center") == "iris_edge"
        rec[f"iris_fit_{s}"] = bool(fitted)
        fits.append(fitted)
        rec[f"reflection_{s}"] = e.reflection_center is not None
    rec["iris_fit"] = all(fits)
    # ARKit mode: did ARKit track the face in this frame? (The engine holds gaze when it did not.)
    rec["arkit"] = ("arkit" in (obs.extra or {})) if str(obs.camera_id or "").startswith("arkit") else None
    rec["reflection"] = rec["reflection_left"] or rec["reflection_right"]
    confs = [e.confidence for e in eyes.values() if e.confidence is not None]
    rec["iris_conf"] = float(sum(confs) / len(confs)) if confs else None
    radii = [e.iris_radius for e in eyes.values() if e.iris_radius]
    rec["iris_px"] = float(2 * sum(radii) / len(radii)) if radii else None
    rec["distance_m"] = float(obs.distance) if obs.distance else None
    rec["distance_source"] = prov.get("distance")
    rec["sharpness"] = q.get("sharpness")
    rec["brightness"] = q.get("brightness")
    rec["usable"] = None if "usable" not in q else bool(q["usable"])
    reasons = ((obs.extra or {}).get("quality") or {}).get("reasons") if isinstance((obs.extra or {}).get("quality"), dict) else None
    rec["reasons"] = list(reasons or [])
    blinks = [e.blink for s, e in eyes.items() if found[s] and e.blink is not None]
    rec["closed"] = bool(blinks) and all(blinks)
    rec["blink_known"] = bool(blinks)
    # Geometry plausibility.
    rec["iod_mm"] = None
    if obs.left.eyeball_center is not None and obs.right.eyeball_center is not None:
        a, b = obs.left.eyeball_center, obs.right.eyeball_center
        rec["iod_mm"] = 1000.0 * math.dist(a, b)
    rec["spacing_ratio"] = None
    rec["swapped"] = None
    if obs.left.iris_center is not None and obs.right.iris_center is not None:
        rec["swapped"] = bool(obs.left.iris_center[0] < obs.right.iris_center[0])
        if rec["iris_px"]:
            rec["spacing_ratio"] = math.dist(obs.left.iris_center, obs.right.iris_center) / rec["iris_px"]
    rec["iris_mm"] = None
    intr = obs.intrinsics
    if rec["iris_px"] and rec["distance_m"] and intr is not None and getattr(intr, "fx", None) and rec["distance_source"] not in (None, "iris_edge"):
        # Skipped when the distance came from the iris size itself (it would always agree).
        rec["iris_mm"] = 1000.0 * rec["iris_px"] * rec["distance_m"] / float(intr.fx)
    return rec


STAGES: list[tuple[str, str, str]] = [
    ("face", "Face", "face"),
    ("arkit", "ARKit tracked", "arkit"),
    ("left_eye", "Left eye", "left"),
    ("right_eye", "Right eye", "right"),
    ("iris_fit", "Iris fit", "iris_fit"),
    ("reflection", "Reflection", "reflection"),
    ("distance", "Distance", "distance_m"),
    ("usable", "Usable", "usable"),
    ("open", "Eyes open", "open"),
]
"""``(id, label, record key)`` for the health strip, in the order a frame passes through them."""


def _stage_status(stage: str, pct: float | None) -> str:
    if pct is None:
        return "na"
    good, warn = (70.0, 30.0) if stage == "reflection" else (90.0, 60.0)
    return "good" if pct >= good else "warn" if pct >= warn else "bad"


class HealthMonitor:
    """Rolling per-stage statistics over the engine's recent observations.

    Call :meth:`poll` a few times a second (it picks up observations the engine processed since
    the last call; the engine keeps the last 90) or :meth:`ingest` with observations directly
    (tests, the standalone doctor)."""

    def __init__(self, engine: Any = None, *, window_s: float = 5.0, keep_s: float = 10.0, blink_history_s: float = 120.0) -> None:
        self.engine = engine
        self.window_s = float(window_s)
        self.keep_s = float(keep_s)
        self.blink_history_s = float(blink_history_s)
        self.records: deque[tuple[float, dict[str, Any]]] = deque()
        self.observations: deque[tuple[float, Any]] = deque()
        self.blink_onsets: deque[float] = deque()
        self._blink_watch_since: float | None = None
        self._was_closed = False
        self._last_key: float | None = None
        self._last_id: int | None = None
        self.total = 0

    def configure(self, config: Any) -> None:
        d = config.diagnostics
        self.window_s = float(d.health_window_s)
        self.keep_s = max(float(d.bundle_seconds), self.window_s)

    def reset(self) -> None:
        self.records.clear()
        self.observations.clear()
        self.blink_onsets.clear()
        self._blink_watch_since = None
        self._was_closed = False

    # -- input ---------------------------------------------------------------------------------

    def poll(self) -> int:
        """Ingest the engine's observations newer than the last poll. Returns how many."""
        eng = self.engine
        if eng is None:
            return 0
        recent = list(getattr(eng, "_recent_obs", None) or [])
        if not recent and getattr(eng, "last_obs", None) is not None:
            recent = [eng.last_obs]
        n = 0
        for obs in recent:
            key = obs.t_local
            if key is None:
                if self._last_id == id(obs):
                    continue
                self._last_id = id(obs)
            elif self._last_key is not None and key <= self._last_key:
                continue
            else:
                self._last_key = key
            self.ingest(obs, key)
            n += 1
        return n

    def ingest(self, obs: Any, t: float | None = None) -> dict[str, Any]:
        t = time.monotonic() if t is None else float(t)
        rec = frame_record(obs)
        rec["open"] = None if not rec["blink_known"] else not rec["closed"]
        self.records.append((t, rec))
        self.observations.append((t, obs))
        self.total += 1
        if self._blink_watch_since is None:
            self._blink_watch_since = t
        if rec["closed"] and not self._was_closed:
            self.blink_onsets.append(t)
        self._was_closed = rec["closed"]
        self._trim(t)
        return rec

    def _trim(self, now: float) -> None:
        keep = max(self.keep_s, self.window_s)
        while self.records and self.records[0][0] < now - keep:
            self.records.popleft()
        while self.observations and self.observations[0][0] < now - keep:
            self.observations.popleft()
        while self.blink_onsets and self.blink_onsets[0] < now - self.blink_history_s:
            self.blink_onsets.popleft()

    # -- output --------------------------------------------------------------------------------

    def _now(self) -> float:
        return self.records[-1][0] if self.records else time.monotonic()

    def window(self, seconds: float | None = None) -> list[dict[str, Any]]:
        if not self.records:
            return []
        now = self._now()
        span = self.window_s if seconds is None else seconds
        return [r for t, r in self.records if t >= now - span]

    def recent_observations(self, seconds: float | None = None) -> list[Any]:
        if not self.observations:
            return []
        now = self.observations[-1][0]
        span = self.keep_s if seconds is None else seconds
        return [o for t, o in self.observations if t >= now - span]

    def blink_rate(self) -> float | None:
        """Blinks per minute over the history, or ``None`` with less than 20 s of watching."""
        if self._blink_watch_since is None or not self.records:
            return None
        start = max(self._blink_watch_since, self._now() - self.blink_history_s)
        span = self._now() - start
        if span < 20.0:
            return None
        return 60.0 * len([t for t in self.blink_onsets if t >= start]) / span

    def summary(self, seconds: float | None = None) -> dict[str, Any]:
        """Percentages, medians and plausibility over the window (JSON-ready)."""
        recs = self.window(seconds)
        n = len(recs)
        span = self.window_s if seconds is None else seconds
        out: dict[str, Any] = {"frames": n, "window_s": span, "total_frames": self.total}
        if n >= 2:
            ts = [t for t, _ in self.records][-n:]
            out["fps"] = _round((n - 1) / (ts[-1] - ts[0]), 1) if ts[-1] > ts[0] else None
        pct: dict[str, float | None] = {}
        for sid, _label, key in STAGES:
            vals = [r.get(key) for r in recs]
            if key == "distance_m":
                vals = [v is not None for v in vals]
            known = [v for v in vals if v is not None]
            pct[sid] = _round(100.0 * sum(bool(v) for v in known) / n, 1) if n and known else (0.0 if n and sid in ("face", "left_eye", "right_eye") else None)
        for side in ("left", "right"):
            pct[f"iris_fit_{side}"] = _round(100.0 * sum(r[f"iris_fit_{side}"] for r in recs) / n, 1) if n else None
            pct[f"reflection_{side}"] = _round(100.0 * sum(r[f"reflection_{side}"] for r in recs) / n, 1) if n else None
        out["pct"] = pct
        med = {
            k: _round(_median([r.get(k) for r in recs]), 3)
            for k in ("iris_px", "iris_conf", "distance_m", "sharpness", "brightness", "iod_mm", "spacing_ratio", "iris_mm")
        }
        out["median"] = med
        sources = Counter(r["distance_source"] for r in recs if r.get("distance_source"))
        out["distance_source"] = sources.most_common(1)[0][0] if sources else None
        out["distance_sources"] = dict(sources)
        reasons = Counter(x for r in recs for x in r.get("reasons") or [])
        out["unusable_reasons"] = {k: _round(100.0 * v / n, 1) for k, v in reasons.most_common()} if n else {}
        closed = [r for r in recs if r.get("blink_known")]
        out["closed_pct"] = _round(100.0 * sum(r["closed"] for r in closed) / len(closed), 1) if closed else None
        out["blinks_in_window"] = len([t for t in self.blink_onsets if self.records and t >= self._now() - span])
        out["blink_rate_per_min"] = _round(self.blink_rate(), 1)
        swapped = [r["swapped"] for r in recs if r.get("swapped") is not None]
        out["swapped_pct"] = _round(100.0 * sum(swapped) / len(swapped), 1) if swapped else None
        out["geometry"] = geometry_checks(med, out["swapped_pct"])
        return out

    def strip(self, engine: Any = None) -> dict[str, Any]:
        """The health strip: one entry per stage with a percentage and a good / warn / bad / na
        status, plus the frame rate and a few headline numbers."""
        eng = engine if engine is not None else self.engine
        s = self.summary()
        names = _estimator_names(eng)
        items = []
        for sid, label, _key in STAGES:
            p = s["pct"].get(sid)
            status = _stage_status(sid, p)
            if sid == "iris_fit" and names is not None and "iris_edge" not in names:
                status, p = "na", None
            if sid == "reflection" and names is not None and "reflection" not in names:
                status, p = "na", None
            if sid == "usable" and names is not None and "quality" not in names:
                status, p = "na", None
            if sid in ("iris_fit", "reflection") and getattr(getattr(eng, "last_frame", None), "mode", None) == "arkit":
                status = "na"  # ARKit mode gazes from Apple's eye transforms; shown for interest only
            if s["frames"] == 0:
                status = "na"
            items.append({"id": sid, "label": label, "pct": p, "status": status})
        stats: dict[str, Any] = {}
        if eng is not None:
            phone = getattr(eng, "phone", None)
            ps = phone.stats.to_dict() if phone is not None else {}
            stats = {
                "stream_fps": _round(ps.get("fps"), 1),
                "processed_fps": _round(getattr(eng, "fps", None), 1),
                "latency_ms": _round(ps.get("latency_ms"), 1),
                "processing_ms": _round((getattr(eng, "timings_ms", {}) or {}).get("total"), 1),
                "dropped_engine": getattr(eng, "dropped", None),
                "dropped_phone": ps.get("dropped_phone"),
                "seq_gaps": ps.get("seq_gaps"),
                "phone_state": getattr(eng, "phone_state", None),
                "mode": getattr(getattr(eng, "last_frame", None), "mode", None),
            }
        med = s["median"]
        return {
            "type": "health",
            "items": items,
            "frames": s["frames"],
            "window_s": s["window_s"],
            "fps": s.get("fps"),
            "iris_px": med.get("iris_px"),
            "distance_cm": _round(100.0 * med["distance_m"], 1) if med.get("distance_m") else None,
            "distance_source": s.get("distance_source"),
            "sharpness": med.get("sharpness"),
            "brightness": med.get("brightness"),
            "blink_rate_per_min": s.get("blink_rate_per_min"),
            "geometry": s["geometry"],
            "unusable_reasons": s["unusable_reasons"],
            **stats,
        }


def _estimator_names(engine: Any) -> list[str] | None:
    if engine is None:
        return None
    return [getattr(e, "name", type(e).__name__) for e in getattr(engine, "estimators", []) or []]


def geometry_checks(median: dict[str, Any], swapped_pct: float | None) -> list[dict[str, Any]]:
    """Plausibility of the medians: ``[{"name", "value", "expected", "ok", "text"}]``; ``ok`` is
    ``None`` when the value was not measured."""
    out = []

    def add(name: str, value: Any, rng: tuple[float, float], unit: str, text: str) -> None:
        ok = None if value is None else bool(rng[0] <= value <= rng[1])
        out.append({"name": name, "value": value, "expected": list(rng), "unit": unit, "ok": ok, "text": text})

    add("eye_spacing_ratio", median.get("spacing_ratio"), SPACING_RATIO, "", "distance between the iris centres / iris diameter (a real face: about 5.4)")
    add("eye_distance_mm", median.get("iod_mm"), IOD_MM, "mm", "distance between the two eyeball centres (adults: 54-74 mm)")
    add("iris_mm", median.get("iris_mm"), IRIS_MM, "mm", "iris diameter from its pixel size, the distance and the camera matrix (people: about 11.7 mm)")
    add("distance_m", median.get("distance_m"), DISTANCE_M, "m", "distance from the phone to the eyes")
    if swapped_pct is not None:
        out.append({"name": "left_right", "value": swapped_pct, "expected": [0, 10], "unit": "%", "ok": swapped_pct <= 10, "text": "frames where the left eye is left of the right eye in the image (should be none: the camera faces you)"})
    return out


# --------------------------------------------------------------------------------------------
# State-change logging
# --------------------------------------------------------------------------------------------


class StateLogger:
    """Logs one line per changed item, comparing snapshots of the engine a few times a second."""

    def __init__(self) -> None:
        self.prev: dict[str, str] | None = None
        self._face: str | None = None

    def snapshot(self, engine: Any, health: HealthMonitor | None = None) -> dict[str, str]:
        e = engine
        snap: dict[str, str] = {}
        snap["phone"] = str(getattr(e, "phone_state", "?"))
        snap["phone address"] = str(getattr(e, "phone_url", "") or "none")
        frame = getattr(e, "last_frame", None)
        if frame is not None:
            cam = frame.camera
            snap["camera"] = f"{cam.position} {cam.type} ({cam.id}), {frame.mode} mode, zoom {cam.zoom:.2f}, {cam.width}x{cam.height}, intrinsics from {cam.intrinsics_source}"
            if frame.mode == "arkit":
                snap["ARKit face"] = "tracked" if (frame.arkit is not None and frame.arkit.tracked) else "not tracked"
            age = time.monotonic() - frame.t_received if frame.t_received else 0.0
            snap["frames"] = "stopped" if (age > 2.0 and getattr(e, "phone_state", "") == "connected") else "flowing"
        if health is not None and health.records:
            recs = health.window(1.0)
            if recs:
                frac = sum(r["face"] for r in recs) / len(recs)
                if frac >= 0.5:
                    self._face = "found"
                elif frac <= 0.1:
                    self._face = "lost"
                eyes = sum(r["both"] for r in recs) / len(recs)
                snap["eyes"] = "both found" if eyes >= 0.5 else "not both found" if eyes <= 0.1 else snap.get("eyes", self.prev.get("eyes", "?") if self.prev else "?")
            if self._face:
                snap["face"] = self._face
        run = getattr(e, "active_run", None)
        snap["calibration run"] = f"{run.kind} {run.run_id}" if run is not None else "none"
        active = None
        try:
            active = getattr(e.active_model(), "name", None)
        except Exception:  # noqa: BLE001
            pass
        snap["gaze model"] = active or "none (not calibrated)"
        snap["pinned model"] = str(getattr(getattr(e, "config", None), "models", None) and e.config.models.pinned or "none")
        snap["paused"] = "yes" if getattr(e, "paused", False) else "no"
        for sink in getattr(e, "sinks", []) or []:
            name = getattr(sink, "name", "")
            if name in ("cursor", "dwell"):
                snap[name] = str(getattr(sink, "status", "") or "off")
        hk = getattr(e, "hotkeys", None)
        snap["shortcuts"] = str(getattr(hk, "status", "off")) if hk is not None else "off"
        rec = getattr(e, "recorder", None)
        snap["recording"] = f"on ({rec.id})" if rec is not None else "off"
        scr = getattr(e, "screen", None)
        if scr is not None:
            snap["screen"] = f"{scr.width:g}x{scr.height:g} pt, {scr.source}"
        aim = getattr(e, "aim", None) or {}
        snap["aiming"] = str(aim.get("phase", "idle"))
        gws = getattr(e, "gaze_ws", None)
        if gws is not None:
            snap["gaze clients"] = str(len(getattr(gws, "clients", []) or []))
        return snap

    def update(self, engine: Any, health: HealthMonitor | None = None) -> list[str]:
        snap = self.snapshot(engine, health)
        lines: list[str] = []
        if self.prev is None:
            lines.append("state at start: " + "; ".join(f"{k}: {v}" for k, v in snap.items()))
        else:
            for k, v in snap.items():
                old = self.prev.get(k)
                if old != v:
                    detail = ""
                    if k == "phone" and getattr(engine, "phone_detail", ""):
                        detail = f" ({engine.phone_detail})"
                    lines.append(f"{k}: {old if old is not None else '-'} -> {v}{detail}")
        self.prev = snap
        for line in lines:
            events.info(line)
        return lines


# --------------------------------------------------------------------------------------------
# Bundle
# --------------------------------------------------------------------------------------------


def system_info() -> dict[str, Any]:
    from . import __version__

    info: dict[str, Any] = {
        "engine_version": __version__,
        "python": platform.python_version(),
        "python_executable": sys.executable,
        "platform": _platform_text(),
        "machine": platform.machine(),
        "processor": platform.processor(),
    }
    try:
        from .doctor import package_versions

        info["packages"] = package_versions()
    except Exception as exc:  # noqa: BLE001
        info["packages"] = f"unavailable: {exc}"
    return info


def _engine_calibration(engine: Any) -> dict[str, Any]:
    if engine is None:
        return {}
    return _jsonable(
        {
            "chosen": getattr(engine, "chosen", None),
            "active": getattr(getattr(engine, "active_model", lambda: None)(), "name", None),
            "pinned": engine.config.models.pinned,
            "models": sorted(getattr(engine, "models", {}) or {}),
            "setup": getattr(engine, "models_setup", None),
            "reports": [r.to_dict() for r in getattr(engine, "reports", []) or []],
            "validation": getattr(engine, "validation", {}),
            "drift": engine.drift_state() if hasattr(engine, "drift_state") else None,
        }
    )


def _saved_profiles(config_path: Path | None) -> list[dict[str, Any]]:
    """Names, sizes and dates of saved calibration profiles (the files are not copied)."""
    root = data_dir(config_path) / "profiles"
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    for p in sorted(root.rglob("*")):
        if p.is_file() and len(out) < 200:
            st = p.stat()
            out.append({"path": str(p.relative_to(root)), "bytes": st.st_size, "modified": _dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    return out


def _stream_stats(engine: Any) -> dict[str, Any]:
    if engine is None:
        return {}
    phone = getattr(engine, "phone", None)
    st = (getattr(engine, "phone_status", None) or {}).get("state") or {}
    return _jsonable(
        {
            "phone_state": engine.phone_state,
            "phone_detail": engine.phone_detail,
            "url": engine.phone_url,
            "simulated": engine.simulated,
            "stream": phone.stats.to_dict() if phone is not None else None,
            "clock_offset_s": phone.clock.offset if phone is not None else None,
            "clock_round_trip_ms": (phone.clock.round_trip * 1000.0) if phone is not None and phone.clock.round_trip is not None else None,
            "hello": phone.hello if phone is not None else None,
            "phone_status_state": st,
            "stream_config": engine.stream_config,
            "engine": {"processed": engine.processed, "dropped": engine.dropped, "fps": engine.fps},
        }
    )


def summary_text(*, engine: Any = None, config: Any = None, doctor: Any = None, health: dict[str, Any] | None = None, folder: Path | None = None, images: bool = False) -> str:
    """A short plain-text summary (about 30 lines) for pasting into a chat."""
    from . import __version__

    lines = [f"Phone Gaze diagnostics {_dt.datetime.now().isoformat(sep=' ', timespec='seconds')}"]
    lines.append(f"Engine {__version__}, Python {platform.python_version()}, {_platform_text()}")
    if engine is not None:
        phone = getattr(engine, "phone", None)
        hello = (phone.hello if phone is not None else None) or {}
        app = hello.get("app") or {}
        dev = hello.get("device") or {}
        kind = "simulator" if engine.simulated else "replay" if engine.replaying else "phone"
        lines.append(
            f"Phone ({kind}): {engine.phone_state} {engine.phone_url or ''}; app {app.get('name', '?')} {app.get('version', '?')}, "
            f"protocol {hello.get('protocol', '?')}, {dev.get('model', '?')} {dev.get('system', '')}".rstrip()
        )
        frame = engine.last_frame
        if frame is not None:
            c = frame.camera
            intr = c.intrinsics
            lines.append(
                f"Camera: {c.position} {c.type} ({c.id}), {frame.mode} mode, zoom {c.zoom:g}, {c.width}x{c.height}, "
                f"intrinsics {c.intrinsics_source}{f' fx {intr.fx:.0f}' if intr else ''}, FOV {c.fov_deg if c.fov_deg else '?'}"
            )
        ps = phone.stats.to_dict() if phone is not None else {}
        t = engine.timings_ms or {}
        rtt = phone.clock.round_trip * 1000 if phone is not None and phone.clock.round_trip is not None else None
        lines.append(
            f"Stream: {_fmt(ps.get('fps'), '.1f')} fps received, {_fmt(engine.fps, '.1f')} processed, phone dropped {ps.get('dropped_phone', '?')}, "
            f"engine dropped {engine.dropped}, capture->engine {_fmt(ps.get('latency_ms'), '.0f')} ms, processing {_fmt(t.get('total'), '.0f')} ms, clock RTT {_fmt(rtt, '.0f')} ms"
        )
        slow = sorted(((k, v) for k, v in t.items() if k not in ("total", "estimators", "outputs")), key=lambda kv: -kv[1])[:4]
        if slow:
            lines.append("Slowest stages: " + ", ".join(f"{k} {v:.0f} ms" for k, v in slow))
    if health:
        p = health.get("pct") or {}
        m = health.get("median") or {}
        lines.append(
            f"Health (last {health.get('window_s', '?')} s, {health.get('frames', 0)} frames): "
            + ", ".join(f"{label.lower()} {_fmt(p.get(sid), '.0f')}%" for sid, label, _ in STAGES)
        )
        lines.append(
            f"  iris {_fmt(m.get('iris_px'), '.0f')} px, fit conf {_fmt(m.get('iris_conf'), '.2f')}, distance {_fmt((m.get('distance_m') or 0) * 100 or None, '.0f')} cm "
            f"(from {health.get('distance_source') or '?'}), sharpness {_fmt(m.get('sharpness'), '.3f')}, brightness {_fmt(m.get('brightness'), '.0f')}, "
            f"blinks {_fmt(health.get('blink_rate_per_min'), '.0f')}/min, eyes closed {_fmt(health.get('closed_pct'), '.0f')}%"
        )
        bad = [g for g in health.get("geometry") or [] if g.get("ok") is False]
        if bad:
            lines.append("  Implausible: " + "; ".join(f"{g['name']} {_fmt(g['value'], '.2f')} (expected {g['expected'][0]}-{g['expected'][1]})" for g in bad))
        if health.get("unusable_reasons"):
            lines.append("  Unusable because: " + ", ".join(f"{k} {v}%" for k, v in health["unusable_reasons"].items()))
    if engine is not None:
        reps = sorted((r for r in engine.reports if r.ok and r.loo_error_deg is not None), key=lambda r: r.loo_error_deg)
        val = engine.validation or {}
        if reps or val:
            parts = [f"{r.model} {r.loo_error_deg:.2f}" for r in reps[:6]]
            lines.append(f"Calibration: using {getattr(engine.active_model(), 'name', None) or 'none'}; leave-one-out deg: {', '.join(parts) or '-'}")
            vparts = []
            for name, metrics in (val.items() if isinstance(val, dict) else []):
                acc = metrics.get("accuracy_deg") if isinstance(metrics, dict) else None
                if isinstance(acc, (int, float)):
                    vparts.append(f"{name} {acc:.2f}")
            if vparts:
                lines.append("Validation deg: " + ", ".join(vparts))
        else:
            lines.append("Calibration: none for this camera and screen")
    if doctor is not None:
        problems = [c for c in doctor.checks if c.status in ("fail", "warn")]
        lines.append(f"Doctor: {sum(c.status == 'ok' for c in doctor.checks)} ok, {sum(c.status == 'warn' for c in doctor.checks)} warnings, {sum(c.status == 'fail' for c in doctor.checks)} failures")
        for c in problems[:10]:
            lines.append(f"  {c.status.upper()} {c.title}: {c.verdict}")
    if config is not None:
        changed = non_default_settings(config)
        if changed:
            lines.append("Changed settings: " + ", ".join(f"{k}={v['value']!r}" for k, v in list(changed.items())[:20]))
    if folder is not None:
        lines.append(f"Folder: {folder} ({'WITH images of your face' if images else 'no images'})")
    return "\n".join(lines) + "\n"


def _fmt(v: Any, spec: str) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "?"
    try:
        return format(v, spec)
    except (TypeError, ValueError):
        return str(v)


README_TEXT = """Phone Gaze diagnostics bundle
=============================

summary.txt          short summary to paste into a chat
doctor.json          the doctor's checklist: every check, its verdict and the fix
health.json          per-stage success rates, medians and plausibility over the last seconds
observations.jsonl   recent observations, one JSON object per frame (numbers only)
stream.json          phone, stream, clock and frame-rate statistics
timings.json         milliseconds per stage (decode, each estimator, outputs, total)
calibration.json     calibration scores, the chosen model, validation results
config.json          all settings; config_changes.json only those changed from the default
state.json           the engine's state as the UI sees it
system.json          Python, packages, operating system
logs/                the engine's log files
"""

IMAGES_README = """These images show your face as the phone saw it (and, in *_overlay.jpg, what the engine
found). They stay on this Mac unless you send them to someone. Delete this folder when you no
longer need it.
"""


def write_bundle(
    *,
    engine: Any = None,
    config: Any = None,
    config_path: str | Path | None = None,
    doctor: Any = None,
    health: HealthMonitor | None = None,
    include_images: bool = False,
    out_root: str | Path | None = None,
    label: str = "",
) -> dict[str, Any]:
    """Write a diagnostics folder and return ``{"path", "files", "summary", "images"}``.

    ``out_root`` defaults to ``~/.phonegaze/diagnostics`` (outside the repository). Images (the
    latest wide frame and eye crops, raw and with overlays) only when ``include_images``."""
    if config is None and engine is not None:
        config = engine.config
    if config_path is None and engine is not None:
        config_path = getattr(engine, "config_path", None)
    root = Path(out_root).expanduser() if out_root else data_dir(config_path) / "diagnostics"
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in label)[:40]
    name = stamp + (f"-{safe}" if safe else "") + ("-with-images" if include_images else "")
    folder = root / name
    i = 1
    while folder.exists():
        i += 1
        folder = root / f"{name}-{i}"
    folder.mkdir(parents=True)
    files: list[str] = []

    def write(rel: str, text: str) -> None:
        p = folder / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        files.append(rel)

    hsum = health.summary() if health is not None else None
    write("README.txt", README_TEXT)
    if doctor is not None:
        write("doctor.json", _dumps(doctor.to_dict()))
    if hsum is not None:
        write("health.json", _dumps({"summary": hsum, "strip": health.strip(engine)}))
        obs = health.recent_observations(float(config.diagnostics.bundle_seconds) if config is not None else None)
        write("observations.jsonl", "".join(json.dumps(_jsonable(o.to_dict()), default=str) + "\n" for o in obs))
    if engine is not None:
        write("stream.json", _dumps(_stream_stats(engine)))
        write("timings.json", _dumps({"note": "exponential moving averages, milliseconds per frame", "timings_ms": engine.timings_ms, "estimators": _estimator_names(engine)}))
        write("calibration.json", _dumps({**_engine_calibration(engine), "saved_profiles": _saved_profiles(Path(config_path) if config_path else None)}))
        try:
            write("state.json", _dumps(engine.state()))
        except Exception as exc:  # noqa: BLE001
            write("state.json", _dumps({"error": f"{type(exc).__name__}: {exc}"}))
    elif config_path is not None:
        write("calibration.json", _dumps({"saved_profiles": _saved_profiles(Path(config_path))}))
    if config is not None:
        write("config.json", _dumps(config.to_dict()))
        write("config_changes.json", _dumps(non_default_settings(config)))
    write("system.json", _dumps(system_info()))
    # Logs: the current file (last 2 MB) and rotated ones.
    lf = current_log_file() or (log_dir(config_path) / LOG_NAME)
    for p in sorted(lf.parent.glob(LOG_NAME + "*")) if lf.parent.is_dir() else []:
        try:
            data = p.read_bytes()[-2 * 1024 * 1024 :]
        except OSError:
            continue
        (folder / "logs").mkdir(exist_ok=True)
        (folder / "logs" / p.name).write_bytes(data)
        files.append(f"logs/{p.name}")
    if include_images and engine is not None and engine.last_decoded is not None:
        (folder / "images").mkdir(exist_ok=True)
        (folder / "images" / "README.txt").write_text(IMAGES_README, encoding="utf-8")
        for img in sorted(engine.last_decoded.images):
            for overlay in (False, True):
                try:
                    data = engine.preview_jpeg(img, overlay)
                except Exception:  # noqa: BLE001
                    data = None
                if data:
                    rel = f"images/{img}{'_overlay' if overlay else ''}.jpg"
                    (folder / rel).write_bytes(data)
                    files.append(rel)
    summary = summary_text(engine=engine, config=config, doctor=doctor, health=hsum, folder=folder, images=include_images)
    write("summary.txt", summary)
    log.info("diagnostics bundle written to %s (%d files, %s)", folder, len(files), "with images" if include_images else "no images")
    return {"path": str(folder), "files": files, "summary": summary, "images": include_images}


def reveal(path: str | Path) -> bool:
    """Show ``path`` in Finder (macOS only). Returns whether it was attempted."""
    if sys.platform != "darwin" or not shutil.which("open"):
        return False
    try:
        subprocess.Popen(["open", "-R", str(path)])  # noqa: S603, S607
        return True
    except OSError:
        return False


# --------------------------------------------------------------------------------------------
# Server integration
# --------------------------------------------------------------------------------------------


class Diagnostics:
    """What ``register`` attaches to the app: the health monitor, the state logger and the
    background task that feeds them."""

    def __init__(self, engine: Any) -> None:
        self.engine = engine
        self.health = HealthMonitor(engine)
        self.health.configure(engine.config)
        self.states = StateLogger()
        self.task: asyncio.Task | None = None
        self.last_doctor: Any = None
        self.last_bundle: dict[str, Any] | None = None
        self._last_broadcast = 0.0

    def tick(self) -> None:
        self.health.configure(self.engine.config)
        self.health.poll()
        d = self.engine.config.diagnostics
        if d.log_state_changes:
            self.states.update(self.engine, self.health)
        now = time.monotonic()
        if d.health_broadcast and now - self._last_broadcast >= 1.0 and getattr(self.engine, "_subscribers", None):
            self._last_broadcast = now
            self.engine.broadcast(self.health.strip(self.engine))

    async def run(self) -> None:
        while True:
            await asyncio.sleep(0.25)
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                log.exception("diagnostics tick failed")


DIAG_KEY_NAME = "phonegaze_diagnostics"


def register(app: Any, engine: Any) -> Diagnostics:
    """Add ``/api/diagnostics/*`` routes and the monitor task to the aiohttp ``app``."""
    from aiohttp import web

    diag = Diagnostics(engine)
    key = web.AppKey(DIAG_KEY_NAME, Diagnostics)
    app[key] = diag

    def _json(data: Any, status: int = 200) -> web.Response:
        return web.json_response(_jsonable(data), status=status, dumps=lambda d: json.dumps(d, allow_nan=False, default=str))

    async def _body(request: web.Request) -> dict[str, Any]:
        if not request.can_read_body:
            return {}
        try:
            data = await request.json()
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    async def health(request: web.Request) -> web.Response:
        diag.health.poll()
        return _json({**diag.health.strip(engine), "summary": diag.health.summary()})

    async def doctor(request: web.Request) -> web.Response:
        from .doctor import run_checks

        body = await _body(request)
        seconds = body.get("seconds")
        report = await run_checks(
            engine,
            config=engine.config,
            config_path=engine.config_path,
            seconds=float(seconds) if isinstance(seconds, (int, float)) else float(engine.config.diagnostics.doctor_seconds),
            browser=body.get("browser") if isinstance(body.get("browser"), dict) else None,
            monitor=diag.health,
        )
        diag.last_doctor = report
        return _json(report.to_dict())

    async def bundle(request: web.Request) -> web.Response:
        body = await _body(request)
        include = bool(body.get("include_images", engine.config.diagnostics.bundle_images))
        report = diag.last_doctor
        if body.get("run_doctor", True):
            from .doctor import run_checks

            report = await run_checks(engine, config=engine.config, config_path=engine.config_path, seconds=float(body.get("seconds") or 2.0), browser=body.get("browser") if isinstance(body.get("browser"), dict) else None, monitor=diag.health)
            diag.last_doctor = report
        diag.health.poll()
        result = await asyncio.to_thread(
            write_bundle, engine=engine, config=engine.config, config_path=engine.config_path, doctor=report, health=diag.health, include_images=include, out_root=body.get("out_root") if isinstance(body.get("out_root"), str) and body.get("out_root") else None, label=str(body.get("label") or "")
        )
        diag.last_bundle = result
        return _json(result)

    async def reveal_route(request: web.Request) -> web.Response:
        path = (diag.last_bundle or {}).get("path")
        if not path:
            return _json({"error": "no bundle written yet"}, 404)
        return _json({"ok": reveal(path), "path": path})

    async def log_tail(request: web.Request) -> web.Response:
        try:
            n = max(1, min(2000, int(request.query.get("lines", "200"))))
        except ValueError:
            n = 200
        path = current_log_file()
        return _json({"path": str(path) if path else None, "lines": tail_log(path, n)})

    def guard(fn: Any) -> Any:
        async def wrapped(request: web.Request) -> web.StreamResponse:
            try:
                return await fn(request)
            except web.HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                log.exception("%s %s failed", request.method, request.path)
                return _json({"error": f"{type(exc).__name__}: {exc}"}, 500)

        return wrapped

    r = app.router
    r.add_get("/api/diagnostics/health", guard(health))
    r.add_post("/api/diagnostics/doctor", guard(doctor))
    r.add_post("/api/diagnostics/bundle", guard(bundle))
    r.add_post("/api/diagnostics/reveal", guard(reveal_route))
    r.add_get("/api/diagnostics/log", guard(log_tail))

    async def on_startup(_app: Any) -> None:
        diag.task = asyncio.create_task(diag.run(), name="phonegaze-diagnostics")

    async def on_cleanup(_app: Any) -> None:
        if diag.task is not None:
            diag.task.cancel()
            try:
                await diag.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return diag
