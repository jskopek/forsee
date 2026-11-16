"""Where gaze goes: system cursor, dwell click, Forsee WebSocket; plus hotkeys and screen
info. Owner: Core.

Modules:

- ``screen.py``: :func:`get_screen_info` (macOS main display size in points and millimetres).
- ``cursor.py``: ``CursorSink`` (moves the system pointer; macOS Quartz events).
- ``dwell.py``: ``DwellClickSink``.
- ``websocket.py``: ``GazeWebSocketSink`` (the ``/gaze`` stream, see docs/INTERFACES.md).
- ``hotkeys.py``: ``HotkeyListener`` (pynput, macOS only; a no-op elsewhere).
- ``_quartz.py``: the ctypes binding to Quartz, loaded lazily (``None`` off macOS).

Imported by: ``pipeline.py`` (``build_sinks``), ``calibration.py`` / UI (``get_screen_info``).
"""

from __future__ import annotations

import logging

from ..config import Config
from ..types import OutputSink

log = logging.getLogger(__name__)


def build_sinks(config: Config) -> list[OutputSink]:
    """The sinks enabled in ``config.outputs`` (the WebSocket sink is attached by the server).

    Never raises: a sink that cannot work on this machine is still returned with
    ``available = False`` and a ``status`` text, so the UI can say why."""
    from .cursor import CursorSink
    from .dwell import DwellClickSink

    sinks: list[OutputSink] = []
    out = config.outputs
    if out.cursor:
        try:
            sinks.append(CursorSink())
        except Exception:  # noqa: BLE001
            log.exception("cursor output failed to start")
    if out.dwell_click:
        try:
            sinks.append(DwellClickSink(out.dwell_ms, out.dwell_radius_pt))
        except Exception:  # noqa: BLE001
            log.exception("dwell click output failed to start")
    return sinks
