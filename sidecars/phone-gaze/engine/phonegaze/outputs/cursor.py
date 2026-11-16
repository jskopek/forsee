"""System cursor output. Owner: Core. macOS only (Quartz ``CGWarpMouseCursorPosition`` /
``CGEventPost`` via ctypes); on other systems ``CursorSink.emit`` does nothing."""

from __future__ import annotations

from ..types import GazePoint, Observation


class CursorSink:
    name = "cursor"

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError
