"""Where gaze goes: system cursor, dwell click, Forsee WebSocket; plus hotkeys and screen
info. Owner: Core.

Modules:

- ``screen.py``: :func:`get_screen_info` (macOS main display size in points and millimetres).
- ``cursor.py``: ``CursorSink`` (moves the system pointer; macOS Quartz events).
- ``dwell.py``: ``DwellClickSink``.
- ``websocket.py``: ``GazeWebSocketSink`` (the ``/gaze`` stream, see docs/INTERFACES.md).
- ``hotkeys.py``: ``HotkeyListener`` (pynput, macOS only; a no-op elsewhere).

Imported by: ``pipeline.py`` (``build_sinks``), ``calibration.py`` / UI (``get_screen_info``).
"""

from __future__ import annotations

from ..config import Config
from ..types import OutputSink


def build_sinks(config: Config) -> list[OutputSink]:
    """The sinks enabled in ``config.outputs`` (the WebSocket sink is attached by the server)."""
    raise NotImplementedError
