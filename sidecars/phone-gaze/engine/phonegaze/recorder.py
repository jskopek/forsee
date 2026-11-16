"""Session recording. Owner: Core.

A recording is a folder (under ``recording.directory``, never in the repository)::

    <id>/session.json         metadata: started_at, config, screen, phone hello, app version
    <id>/stream.pgz1          the phone stream as received, PGZ1 messages back to back; each
                              header gains "recv": engine monotonic seconds (PROTOCOL.md)
    <id>/observations.jsonl   one Observation.to_dict() per line
    <id>/gaze.jsonl           one GazePoint.to_dict() per line (after filtering)
    <id>/events.jsonl         {"t_local", "type", ...}: calibration dots, UI actions, look-points
    <id>/calibration.json     CalibSample.to_dict() list and FitReport list of runs recorded

Imported by: ``pipeline.py``, ``replay.py``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .protocol import Message
from .types import GazePoint, Observation


class Recorder:
    """Writes one recording folder. Methods are cheap and non-blocking (buffered writes)."""

    def __init__(self, directory: Path, meta: dict[str, Any]) -> None:
        self.directory = directory
        self.meta = meta

    def write_message(self, message: Message, t_local: float) -> None:
        """Append a raw stream message (hello, frame or status)."""
        raise NotImplementedError

    def write_observation(self, obs: Observation) -> None:
        raise NotImplementedError

    def write_gaze(self, point: GazePoint) -> None:
        raise NotImplementedError

    def write_event(self, event: dict[str, Any]) -> None:
        raise NotImplementedError

    def close(self) -> dict[str, Any]:
        """Finish and return a summary (id, path, frames, seconds)."""
        raise NotImplementedError


def list_recordings(root: Path) -> list[dict[str, Any]]:
    """Summaries of every recording under ``root``, newest first."""
    raise NotImplementedError
