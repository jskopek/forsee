"""Dwell click output. Owner: Core."""

from __future__ import annotations

from ..types import GazePoint, Observation


class DwellClickSink:
    """Clicks when filtered gaze stays within ``radius_pt`` for ``dwell_ms``."""

    name = "dwell"

    def __init__(self, dwell_ms: int, radius_pt: float) -> None:
        self.dwell_ms = dwell_ms
        self.radius_pt = radius_pt

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError
