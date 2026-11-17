"""Dwell click output. Owner: Core."""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from typing import Any

from ..types import GazePoint, Observation
from ._quartz import quartz

log = logging.getLogger(__name__)


class DwellClickSink:
    """Clicks when filtered gaze stays within ``radius_pt`` for ``dwell_ms``.

    After a click, gaze must leave the radius (or ``cooldown_ms`` pass and a new dwell complete)
    before the next one. Invalid samples shorter than ``gap_ms`` (blinks) do not reset the dwell.
    ``progress`` (0-1) is exposed for a UI ring; ``on_click(x, y)`` is called after each click.
    """

    name = "dwell"

    def __init__(
        self,
        dwell_ms: int,
        radius_pt: float,
        cooldown_ms: int = 600,
        gap_ms: int = 200,
        backend: Any = None,
        clock: Callable[[], float] = time.monotonic,
        on_click: Callable[[float, float], None] | None = None,
    ) -> None:
        self.dwell_ms = dwell_ms
        self.radius_pt = radius_pt
        self.cooldown_ms = cooldown_ms
        self.gap_ms = gap_ms
        self.clock = clock
        self.backend = backend if backend is not None else quartz()
        self.on_click = on_click
        self.available = self.backend is not None
        self.status = "ok" if self.available else "unavailable: clicks can only be posted on macOS"
        self.clicks = 0
        self.progress = 0.0
        self._anchor: tuple[float, float] | None = None
        self._start = 0.0
        self._last_valid = -math.inf
        self._armed = True
        self._last_click = -math.inf
        self._sum = [0.0, 0.0, 0]

    def _restart(self, x: float, y: float, now: float) -> None:
        self._anchor = (x, y)
        self._start = now
        self._sum = [x, y, 1]
        self.progress = 0.0

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        now = self.clock()
        if point is None or not point.valid:
            if now - self._last_valid > self.gap_ms / 1000.0:
                self._anchor = None
                self.progress = 0.0
            return
        self._last_valid = now
        x, y = float(point.x), float(point.y)
        if self._anchor is None or math.hypot(x - self._anchor[0], y - self._anchor[1]) > self.radius_pt:
            self._armed = True
            self._restart(x, y, now)
            return
        self._sum[0] += x
        self._sum[1] += y
        self._sum[2] += 1
        elapsed = now - self._start
        self.progress = min(1.0, elapsed / (self.dwell_ms / 1000.0))
        if not self._armed and now - self._last_click < self.cooldown_ms / 1000.0:
            return
        if elapsed >= self.dwell_ms / 1000.0:
            cx, cy = self._sum[0] / self._sum[2], self._sum[1] / self._sum[2]
            self._click(cx, cy)
            self._last_click = now
            self._armed = False
            self._restart(cx, cy, now)

    def _click(self, x: float, y: float) -> None:
        self.clicks += 1
        if self.backend is not None:
            try:
                self.backend.click(x, y)
            except Exception as exc:  # noqa: BLE001
                log.warning("dwell click failed: %s", exc)
        if self.on_click is not None:
            try:
                self.on_click(x, y)
            except Exception:  # noqa: BLE001
                log.exception("dwell on_click callback failed")

    def close(self) -> None:
        self._anchor = None
