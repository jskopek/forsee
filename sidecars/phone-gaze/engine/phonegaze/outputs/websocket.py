"""The ``/gaze`` WebSocket stream for Forsee and other consumers. Owner: Core.
Message shapes: docs/INTERFACES.md, "Gaze WebSocket".

Each sample is ``{"type": "gaze", "x", "y", "t", "confidence", "valid"}`` in screen points with
``t`` on the engine's monotonic clock, plus (additions, ignorable) ``nx``/``ny`` (0-1 of the
screen), ``latency_ms`` (capture to send, when the phone clock is synced) and ``fixation``.
When ``valid`` is false, ``x``/``y`` repeat the last valid point.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections.abc import Callable
from typing import Any

from ..types import GazePoint, Observation, ScreenInfo

log = logging.getLogger(__name__)


class GazeWebSocketSink:
    """Fans gaze samples out to every connected ``/gaze`` client, rate-limited.

    Clients are anything with an async ``send_str`` (aiohttp ``WebSocketResponse``). ``emit`` never
    blocks: each send is a task, and a client whose previous send is still pending skips the
    sample (slow clients drop, they never queue).
    """

    name = "websocket"

    def __init__(self, rate_hz: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.rate_hz = rate_hz
        self.clock = clock
        self.clients: set[Any] = set()
        self.screen: ScreenInfo | None = None
        self.to_local: Callable[[float], float | None] = lambda t: None
        """Phone time -> engine monotonic time; the Engine replaces this with its clock sync."""
        self._last_sent = -math.inf
        self._last_valid: tuple[float, float] | None = None
        self._pending: dict[Any, asyncio.Future] = {}
        self.sent = 0

    def hello(self) -> dict[str, Any]:
        return {"type": "hello", "version": 1, "screen": self.screen.to_dict() if self.screen else None}

    def add(self, ws: Any) -> None:
        self.clients.add(ws)

    def remove(self, ws: Any) -> None:
        self.clients.discard(ws)
        self._pending.pop(ws, None)

    def message(self, point: GazePoint | None, obs: Observation | None) -> dict[str, Any]:
        now = self.clock()
        valid = bool(point is not None and point.valid)
        if valid:
            assert point is not None
            self._last_valid = (float(point.x), float(point.y))
        x, y = self._last_valid if self._last_valid else (0.0, 0.0)
        t_local = None
        if point is not None:
            t_local = self.to_local(point.t)
            if t_local is None:
                t_local = point.t_local
        msg: dict[str, Any] = {
            "type": "gaze",
            "x": x,
            "y": y,
            "t": float(t_local) if t_local is not None else now,
            "confidence": float(point.confidence) if valid and point is not None else 0.0,
            "valid": valid,
        }
        if self.screen is not None and self.screen.width and self.screen.height:
            msg["nx"] = x / self.screen.width
            msg["ny"] = y / self.screen.height
        if t_local is not None:
            msg["latency_ms"] = max(0.0, (now - t_local) * 1000.0)
        if point is not None and point.fixation is not None:
            msg["fixation"] = bool(point.fixation)
        return msg

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        if not self.clients:
            return
        now = self.clock()
        if now - self._last_sent < 1.0 / self.rate_hz:
            return
        self._last_sent = now
        text = json.dumps(self.message(point, obs), allow_nan=False)
        self.broadcast_text(text)

    def broadcast_text(self, text: str) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        for ws in list(self.clients):
            pending = self._pending.get(ws)
            if pending is not None and not pending.done():
                continue
            if getattr(ws, "closed", False):
                self.remove(ws)
                continue
            fut = loop.create_task(self._send(ws, text))
            self._pending[ws] = fut
        self.sent += 1

    async def _send(self, ws: Any, text: str) -> None:
        try:
            await ws.send_str(text)
        except Exception as exc:  # noqa: BLE001 - a broken client is dropped
            log.debug("gaze client send failed: %s", exc)
            self.remove(ws)

    def close(self) -> None:
        for fut in self._pending.values():
            fut.cancel()
        self._pending.clear()
