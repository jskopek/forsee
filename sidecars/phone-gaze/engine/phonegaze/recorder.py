"""Session recording. Owner: Core.

A recording is a folder (under ``recording.directory``, never in the repository)::

    <id>/session.json         metadata: started_at, config, screen, phone hello, app version
    <id>/stream.pgz1          the phone stream as received, PGZ1 messages back to back; each
                              header gains "recv": engine monotonic seconds (PROTOCOL.md)
    <id>/observations.jsonl   one Observation.to_dict() per line
    <id>/gaze.jsonl           one GazePoint.to_dict() per line (after filtering)
    <id>/events.jsonl         {"t_local", "type", ...}: calibration dots, UI actions, look-points
    <id>/calibration.json     CalibSample.to_dict() list and FitReport list of runs recorded

Events written by the Engine (``type``): ``calib.start`` (``run_id``, ``kind``, ``targets``),
``calib.dot`` (``run_id``, ``dot_id``, ``x``, ``y``, ``state``), ``calib.finish`` (``run_id``,
the finish answer), ``calib.cancel``, ``lookpoint`` (``x``, ``y``, ``t`` engine time of the
selection, ``rect``, ``kind``, ``id``, ``outcome`` from the drift corrector), ``lookpoint.undo``
(``id``), ``config`` (changes),
``zoom`` / ``camera`` changes, ``pause``. ``t_local`` is ``time.monotonic()``, the same clock as
``recv``, so replay can line events up with frames.

Imported by: ``pipeline.py``, ``replay.py``.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .protocol import Message, encode
from .types import GazePoint, Observation, _jsonable

log = logging.getLogger(__name__)

SESSION_FILE = "session.json"
STREAM_FILE = "stream.pgz1"


def new_recording_id(label: str = "") -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    clean = "".join(c if c.isalnum() or c in "-_" else "-" for c in label.strip())[:40].strip("-")
    return f"{stamp}-{clean}" if clean else stamp


class Recorder:
    """Writes one recording folder. Methods are cheap and non-blocking (buffered writes)."""

    def __init__(self, directory: Path, meta: dict[str, Any], *, record_stream: bool = True, record_observations: bool = True) -> None:
        self.directory = Path(directory)
        self.meta = meta
        self.directory.mkdir(parents=True, exist_ok=True)
        self.id = self.directory.name
        self.record_stream = record_stream
        self.record_observations = record_observations
        self.started_monotonic = time.monotonic()
        self.frames = 0
        self.observations = 0
        self.closed = False
        self.calibration: dict[str, Any] = {"runs": []}
        self._stream = open(self.directory / STREAM_FILE, "ab", buffering=1 << 20) if record_stream else None
        self._obs = open(self.directory / "observations.jsonl", "a", encoding="utf-8", buffering=1 << 16) if record_observations else None
        self._gaze = open(self.directory / "gaze.jsonl", "a", encoding="utf-8", buffering=1 << 16) if record_observations else None
        self._events = open(self.directory / "events.jsonl", "a", encoding="utf-8", buffering=1)
        session = {
            "id": self.id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "started_monotonic": self.started_monotonic,
            **meta,
        }
        (self.directory / SESSION_FILE).write_text(json.dumps(_jsonable(session), indent=2) + "\n", encoding="utf-8")

    @property
    def seconds(self) -> float:
        return time.monotonic() - self.started_monotonic

    def write_message(self, message: Message, t_local: float) -> None:
        """Append a raw stream message (hello, frame or status)."""
        if self.closed or self._stream is None:
            return
        header = dict(message.header)
        header["recv"] = t_local
        self._stream.write(encode(header, message.parts))
        if message.type == "frame":
            self.frames += 1

    def write_observation(self, obs: Observation) -> None:
        if self.closed or self._obs is None:
            return
        self._obs.write(json.dumps(obs.to_dict(), allow_nan=False) + "\n")
        self.observations += 1

    def write_gaze(self, point: GazePoint) -> None:
        if self.closed or self._gaze is None:
            return
        self._gaze.write(json.dumps(point.to_dict(), allow_nan=False) + "\n")

    def write_event(self, event: dict[str, Any]) -> None:
        if self.closed:
            return
        ev = dict(event)
        ev.setdefault("t_local", time.monotonic())
        self._events.write(json.dumps(_jsonable(ev), allow_nan=False) + "\n")

    def write_calibration(self, run: dict[str, Any]) -> None:
        """Add one finished run (``{"run_id", "kind", "samples": [...], "reports": [...]}``) to
        ``calibration.json`` (rewritten each time)."""
        if self.closed:
            return
        self.calibration["runs"].append(_jsonable(run))
        (self.directory / "calibration.json").write_text(json.dumps(self.calibration) + "\n", encoding="utf-8")

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "path": str(self.directory), "seconds": round(self.seconds, 3), "frames": self.frames, "observations": self.observations}

    def close(self) -> dict[str, Any]:
        """Finish and return a summary (id, path, frames, seconds)."""
        if not self.closed:
            summary = self.summary()
            for f in (self._stream, self._obs, self._gaze, self._events):
                if f is not None:
                    f.close()
            self.closed = True
            try:
                path = self.directory / SESSION_FILE
                data = json.loads(path.read_text(encoding="utf-8"))
                data["summary"] = summary
                path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            except (OSError, ValueError) as exc:
                log.warning("cannot update %s: %s", SESSION_FILE, exc)
            self._summary = summary
        return self._summary


def list_recordings(root: Path) -> list[dict[str, Any]]:
    """Summaries of every recording under ``root``, newest first."""
    root = Path(root).expanduser()
    if not root.is_dir():
        return []
    out = []
    for d in root.iterdir():
        meta_path = d / SESSION_FILE
        if not d.is_dir() or not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        summary = meta.get("summary") or {}
        stream = d / STREAM_FILE
        out.append(
            {
                "id": d.name,
                "path": str(d),
                "label": meta.get("label", ""),
                "started_at": meta.get("started_at"),
                "seconds": summary.get("seconds"),
                "frames": summary.get("frames"),
                "bytes": stream.stat().st_size if stream.exists() else 0,
                "has_calibration": (d / "calibration.json").exists(),
                "complete": bool(meta.get("summary")),
            }
        )
    out.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    return out
