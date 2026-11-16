"""Phone client: HTTP control, the PGZ1 stream, and clock sync. Owner: Core.

Talks to the iPhone app or the simulator through exactly the routes in
``docs/PROTOCOL.md``. Nothing else in the engine opens connections to the phone.

Imported by: ``pipeline.py`` (Engine), ``server.py`` (UI actions), tests (with ``sim``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .types import Frame


@dataclass
class ClockSync:
    """Maps the phone clock to the engine's ``time.monotonic()``.

    ``offset`` is ``local - phone`` in seconds, estimated from ``GET /api/time`` round trips
    (keep the sample with the smallest round trip; ``offset = (t0 + t1) / 2 - phone_t``).
    """

    offset: float | None = None
    round_trip: float | None = None

    def to_local(self, t_phone: float) -> float | None:
        """Phone time -> engine monotonic time, or ``None`` before the first sync."""
        raise NotImplementedError

    def add_sample(self, t0_local: float, t_phone: float, t1_local: float) -> None:
        """Record one ``/api/time`` exchange (local send time, phone answer, local receive time)."""
        raise NotImplementedError


class PhoneError(RuntimeError):
    """The phone answered with an error (HTTP status and the JSON ``error`` text) or not at all."""


class PhoneClient:
    """Async client for one phone (or simulator) at ``base_url`` (e.g. ``http://10.0.0.5:8080``).

    All methods are coroutines and raise :class:`PhoneError`. JSON results are returned as the
    phone sent them (camelCase).
    """

    def __init__(self, base_url: str, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.clock = ClockSync()
        self.hello: dict[str, Any] | None = None
        """The last ``hello`` header from the stream (device, cameras, capabilities, sim)."""

    async def close(self) -> None:
        raise NotImplementedError

    async def status(self) -> dict[str, Any]:
        """``GET /api/status``."""
        raise NotImplementedError

    async def sync_clock(self, rounds: int = 5) -> ClockSync:
        """Run ``rounds`` ``GET /api/time`` exchanges and update :attr:`clock`."""
        raise NotImplementedError

    async def configure(self, camera_id: str, max_width: int = 3840, fps: float = 30, zoom: float = 1) -> dict[str, Any]:
        """``POST /api/configure``; returns the status."""
        raise NotImplementedError

    async def set_zoom(self, zoom: float) -> dict[str, Any]:
        """``POST /api/zoom``; returns the status."""
        raise NotImplementedError

    async def set_focus(self, *, locked: bool | None = None, point: tuple[float, float] | None = None) -> dict[str, Any]:
        """``POST /api/focus``. ``point`` is normalised SENSOR coordinates (0-1, top-left)."""
        raise NotImplementedError

    async def set_stream_config(self, changes: dict[str, Any]) -> dict[str, Any]:
        """``POST /api/stream/config`` with a partial config (camelCase keys); returns the
        effective config."""
        raise NotImplementedError

    async def frames(self) -> AsyncIterator[Frame]:
        """``GET /stream``: yield frames as they arrive, with ``t_received`` set.

        Stores ``hello`` headers in :attr:`hello` and ``status`` headers in ``last_status``;
        never yields them. Ends when the stream closes; reconnecting is the caller's job.
        """
        raise NotImplementedError
        yield  # pragma: no cover
