"""The ``/gaze`` WebSocket stream for Forsee and other consumers. Owner: Core.
Message shapes: docs/INTERFACES.md, "Gaze WebSocket"."""

from __future__ import annotations

from ..types import GazePoint, Observation


class GazeWebSocketSink:
    """Fans gaze samples out to every connected ``/gaze`` client, rate-limited."""

    name = "websocket"

    def __init__(self, rate_hz: float) -> None:
        self.rate_hz = rate_hz

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError
