"""System cursor output. Owner: Core. macOS only (Quartz ``CGEventPost`` mouse-moved events via
ctypes, ``CGWarpMouseCursorPosition`` as a fallback); on other systems ``CursorSink.emit`` does
nothing and :attr:`CursorSink.status` says why.

Behaviour (docs/research/05): at most ``max_rate_hz`` moves per second, moves under
``min_move_pt`` skipped, and output pauses for ``mouse_pause_s`` whenever the real mouse moved
(so the person can take over with the trackpad). Screen points are Quartz global points
(origin at the top-left of the main display), so Retina needs no scaling.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from typing import Any

from ..types import GazePoint, Observation
from ._quartz import quartz

log = logging.getLogger(__name__)

PERMISSION_HELP = (
    "macOS has not given this program permission to move the pointer. Open System Settings > "
    "Privacy & Security > Accessibility and turn on the app that started Python (Terminal, "
    "iTerm or your editor), then restart Phone Gaze."
)


class CursorSink:
    name = "cursor"

    def __init__(
        self,
        max_rate_hz: float = 60.0,
        min_move_pt: float = 2.0,
        mouse_pause_s: float = 1.0,
        backend: Any = None,
        clock: Callable[[], float] = time.monotonic,
        screen_bounds: tuple[float, float, float, float] | None = None,
    ) -> None:
        """``backend`` is a Quartz-like object (``move``, ``warp``, ``mouse_location``,
        ``can_post_events``); tests pass a fake. ``screen_bounds`` ``(x, y, w, h)`` of the main
        display in global points, used to clamp (read from macOS when ``None``)."""
        self.max_rate_hz = max_rate_hz
        self.min_move_pt = min_move_pt
        self.mouse_pause_s = mouse_pause_s
        self.clock = clock
        self.backend = backend if backend is not None else quartz()
        self.available = False
        self.status = ""
        self.moves = 0
        self._last_sent: tuple[float, float] | None = None
        self._last_time = -math.inf
        self._paused_until = -math.inf
        self._use_warp = False
        self.bounds = screen_bounds
        if self.backend is None:
            self.status = "unavailable: the system cursor can only be moved on macOS"
            return
        try:
            allowed = self.backend.can_post_events()
        except Exception as exc:  # noqa: BLE001
            allowed = None
            log.debug("permission check failed: %s", exc)
        if allowed is False:
            self.status = "no permission: " + PERMISSION_HELP
            log.warning(PERMISSION_HELP)
            # Warping needs no permission, but apps see no hover; better than nothing.
            self._use_warp = True
        if self.bounds is None:
            try:
                self.bounds = tuple(self.backend.display_bounds())  # type: ignore[assignment]
            except Exception:  # noqa: BLE001
                self.bounds = None
        self.available = True
        if not self.status:
            self.status = "ok"

    def emit(self, point: GazePoint | None, obs: Observation | None) -> None:
        if not self.available or point is None or not point.valid:
            return
        now = self.clock()
        if now < self._paused_until:
            return
        if now - self._last_time < 1.0 / self.max_rate_hz:
            return
        x, y = float(point.x), float(point.y)
        if self.bounds is not None:
            bx, by, bw, bh = self.bounds
            x = min(max(x, bx), bx + bw - 1)
            y = min(max(y, by), by + bh - 1)
        # Pause while the person uses the real mouse.
        if self._last_sent is not None:
            try:
                mx, my = self.backend.mouse_location()
                if math.hypot(mx - self._last_sent[0], my - self._last_sent[1]) > 3.0:
                    self._paused_until = now + self.mouse_pause_s
                    self._last_sent = None
                    return
            except Exception:  # noqa: BLE001
                pass
        if self._last_sent is not None and math.hypot(x - self._last_sent[0], y - self._last_sent[1]) < self.min_move_pt:
            return
        try:
            if self._use_warp:
                self.backend.warp(x, y)
            else:
                self.backend.move(x, y)
        except Exception as exc:  # noqa: BLE001
            self.available = False
            self.status = f"failed: {exc}"
            log.warning("moving the cursor failed, cursor output stopped: %s", exc)
            return
        self._last_sent = (x, y)
        self._last_time = now
        self.moves += 1

    def close(self) -> None:
        self.available = False
