"""Phone client: HTTP control, the PGZ1 stream, and clock sync. Owner: Core.

Talks to the iPhone app or the simulator through exactly the routes in
``docs/PROTOCOL.md``. Nothing else in the engine opens connections to the phone.

Imported by: ``pipeline.py`` (Engine), ``server.py`` (UI actions), tests (with ``sim``).
"""

from __future__ import annotations

import asyncio
import errno
import logging
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import aiohttp

from .protocol import Decoder, Message, ProtocolError
from .types import Frame

log = logging.getLogger(__name__)

SUPPORTED_PROTOCOL = 1


@dataclass
class ClockSync:
    """Maps the phone clock to the engine's ``time.monotonic()``.

    ``offset`` is ``local - phone`` in seconds, estimated from ``GET /api/time`` round trips
    (keep the sample with the smallest round trip; ``offset = (t0 + t1) / 2 - phone_t``).

    Samples older than ``max_age_s`` are forgotten so a slowly drifting phone clock is followed.
    """

    offset: float | None = None
    round_trip: float | None = None
    max_age_s: float = 120.0
    _samples: deque = field(default_factory=lambda: deque(maxlen=64), repr=False)

    def to_local(self, t_phone: float) -> float | None:
        """Phone time -> engine monotonic time, or ``None`` before the first sync."""
        if self.offset is None:
            return None
        return t_phone + self.offset

    def to_phone(self, t_local: float) -> float | None:
        if self.offset is None:
            return None
        return t_local - self.offset

    def add_sample(self, t0_local: float, t_phone: float, t1_local: float) -> None:
        """Record one ``/api/time`` exchange (local send time, phone answer, local receive time)."""
        rtt = t1_local - t0_local
        if rtt < 0:
            return
        self._samples.append((t1_local, rtt, (t0_local + t1_local) / 2 - t_phone))
        newest = self._samples[-1][0]
        live = [s for s in self._samples if newest - s[0] <= self.max_age_s] or [self._samples[-1]]
        best = min(live, key=lambda s: s[1])
        self.round_trip, self.offset = best[1], best[2]


class PhoneError(RuntimeError):
    """The phone answered with an error (HTTP status and the JSON ``error`` text) or not at all."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class StreamStats:
    """Rolling statistics over the last few seconds of the stream."""

    window_s: float = 3.0
    frames: int = 0
    dropped_phone: int = 0
    """Frames the phone dropped for back-pressure (sum of ``dropped`` headers)."""
    seq_gaps: int = 0
    """Frames missing from the ``seq`` sequence (skipped or dropped by the phone)."""
    bytes: int = 0
    last_seq: int | None = None
    _times: deque = field(default_factory=lambda: deque(maxlen=600), repr=False)
    _latency: deque = field(default_factory=lambda: deque(maxlen=120), repr=False)

    def add(self, header: dict[str, Any], t_received: float, latency_s: float | None, nbytes: int) -> None:
        self.frames += 1
        self.bytes += nbytes
        self.dropped_phone += int(header.get("dropped") or 0)
        seq = header.get("seq")
        if isinstance(seq, int):
            if self.last_seq is not None and seq > self.last_seq + 1:
                self.seq_gaps += seq - self.last_seq - 1
            self.last_seq = seq
        self._times.append(t_received)
        if latency_s is not None:
            self._latency.append(latency_s)

    @property
    def fps(self) -> float | None:
        if len(self._times) < 2:
            return None
        newest = self._times[-1]
        recent = [t for t in self._times if newest - t <= self.window_s]
        if len(recent) < 2 or recent[-1] == recent[0]:
            return None
        return (len(recent) - 1) / (recent[-1] - recent[0])

    @property
    def latency_ms(self) -> float | None:
        """Median capture-to-receive latency (needs a clock sync)."""
        if not self._latency:
            return None
        values = sorted(self._latency)
        return 1000.0 * values[len(values) // 2]

    def to_dict(self) -> dict[str, Any]:
        return {
            "frames": self.frames,
            "fps": self.fps,
            "latency_ms": self.latency_ms,
            "dropped_phone": self.dropped_phone,
            "seq_gaps": self.seq_gaps,
            "bytes": self.bytes,
        }


class PhoneClient:
    """Async client for one phone (or simulator) at ``base_url`` (e.g. ``http://10.0.0.5:8080``).

    All methods are coroutines and raise :class:`PhoneError`. JSON results are returned as the
    phone sent them (camelCase).
    """

    def __init__(self, base_url: str, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        if not self.base_url.startswith(("http://", "https://")):
            self.base_url = "http://" + self.base_url
        self.timeout_s = timeout_s
        self.clock = ClockSync()
        self.hello: dict[str, Any] | None = None
        """The last ``hello`` header from the stream (device, cameras, capabilities, sim)."""
        self.last_status: dict[str, Any] | None = None
        """The last ``status`` header from the stream."""
        self.stats = StreamStats()
        self.stream_connected = False
        self._session: aiohttp.ClientSession | None = None
        self._stream_response: aiohttp.ClientResponse | None = None

    # -- HTTP --------------------------------------------------------------------------------

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # No total timeout on the session: the stream is long-lived. Requests set their own.
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None))
        return self._session

    async def close(self) -> None:
        if self._stream_response is not None:
            self._stream_response.close()
            self._stream_response = None
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None
        self.stream_connected = False

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None, timeout_s: float | None = None) -> Any:
        """One JSON request; returns the decoded JSON answer or raises :class:`PhoneError`."""
        url = self.base_url + path
        timeout_s = timeout_s or self.timeout_s
        timeout = aiohttp.ClientTimeout(total=timeout_s)
        try:
            async with self._http().request(method, url, json=body, timeout=timeout) as resp:
                text = await resp.text()
                try:
                    data = await resp.json(content_type=None) if text else None
                except ValueError:
                    data = None
                if resp.status >= 400:
                    msg = data.get("error") if isinstance(data, dict) else None
                    raise PhoneError(f"{method} {path}: HTTP {resp.status}: {msg or text[:200]}", resp.status)
                return data
        except PhoneError:
            raise
        except asyncio.TimeoutError as exc:
            raise PhoneError(f"{method} {path}: no answer from {self.base_url} in {timeout_s:.0f} s") from exc
        except aiohttp.ClientError as exc:
            raise PhoneError(f"{method} {path}: cannot reach {self.base_url}: {exc}{_unreachable_hint(exc)}") from exc

    async def status(self) -> dict[str, Any]:
        """``GET /api/status``."""
        return await self.request("GET", "/api/status")

    async def phone_time(self) -> float:
        data = await self.request("GET", "/api/time")
        return float(data["t"])

    async def sync_clock(self, rounds: int = 5) -> ClockSync:
        """Run ``rounds`` ``GET /api/time`` exchanges and update :attr:`clock`."""
        for _ in range(max(1, rounds)):
            t0 = time.monotonic()
            t_phone = await self.phone_time()
            t1 = time.monotonic()
            self.clock.add_sample(t0, t_phone, t1)
        return self.clock

    async def configure(self, camera_id: str, max_width: int = 3840, fps: float = 30, zoom: float = 1) -> dict[str, Any]:
        """``POST /api/configure``; returns the status."""
        body = {"cameraId": camera_id, "maxWidth": int(max_width), "fps": fps, "zoom": zoom}
        # Restarting the camera can take a few seconds on a real phone.
        return await self.request("POST", "/api/configure", body, timeout_s=max(self.timeout_s, 15.0))

    async def set_zoom(self, zoom: float) -> dict[str, Any]:
        """``POST /api/zoom``; returns the status."""
        return await self.request("POST", "/api/zoom", {"zoom": float(zoom)})

    async def set_focus(self, *, locked: bool | None = None, point: tuple[float, float] | None = None) -> dict[str, Any]:
        """``POST /api/focus``. ``point`` is normalised SENSOR coordinates (0-1, top-left)."""
        body: dict[str, Any] = {}
        if point is not None:
            body["x"] = min(1.0, max(0.0, float(point[0])))
            body["y"] = min(1.0, max(0.0, float(point[1])))
        if locked is not None:
            body["locked"] = bool(locked)
        return await self.request("POST", "/api/focus", body)

    async def set_stream_config(self, changes: dict[str, Any]) -> dict[str, Any]:
        """``POST /api/stream/config`` with a partial config (camelCase keys); returns the
        effective config."""
        return await self.request("POST", "/api/stream/config", changes)

    async def sim_gaze(self, x: float, y: float) -> dict[str, Any]:
        """Simulator only: ``POST /sim/gaze``."""
        return await self.request("POST", "/sim/gaze", {"x": float(x), "y": float(y)})

    # -- Stream ------------------------------------------------------------------------------

    async def messages(self) -> AsyncIterator[tuple[Message, float]]:
        """``GET /stream``: yield every message (hello, frame, status, unknown) with the engine's
        monotonic receive time. Updates :attr:`hello`, :attr:`last_status` and :attr:`stats`.
        Ends when the stream closes; raises :class:`PhoneError` if it cannot be opened or breaks."""
        url = self.base_url + "/stream"
        timeout = aiohttp.ClientTimeout(total=None, connect=self.timeout_s, sock_read=max(10.0, self.timeout_s * 2))
        decoder = Decoder()
        try:
            resp = await self._http().get(url, timeout=timeout)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise PhoneError(f"cannot open {url}: {exc}") from exc
        self._stream_response = resp
        try:
            if resp.status != 200:
                raise PhoneError(f"GET /stream: HTTP {resp.status}", resp.status)
            self.stream_connected = True
            async for chunk in resp.content.iter_any():
                try:
                    msgs = decoder.feed(chunk)
                except ProtocolError as exc:
                    raise PhoneError(f"broken stream: {exc}") from exc
                if not msgs:
                    continue
                t_received = time.monotonic()
                for msg in msgs:
                    kind = msg.type
                    if kind == "hello":
                        proto = int(msg.header.get("protocol", 1) or 1)
                        if proto > SUPPORTED_PROTOCOL:
                            raise PhoneError(f"phone speaks protocol {proto}; this engine supports {SUPPORTED_PROTOCOL}")
                        self.hello = msg.header
                    elif kind == "status":
                        self.last_status = msg.header
                    elif kind == "frame":
                        t_cap = self.clock.to_local(float(msg.header.get("t", 0.0)))
                        latency = None if t_cap is None else t_received - t_cap
                        self.stats.add(msg.header, t_received, latency, sum(len(p) for p in msg.parts))
                    yield msg, t_received
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise PhoneError(f"stream interrupted: {exc}") from exc
        finally:
            self.stream_connected = False
            resp.close()
            if self._stream_response is resp:
                self._stream_response = None

    async def frames(self) -> AsyncIterator[Frame]:
        """``GET /stream``: yield frames as they arrive, with ``t_received`` set.

        Stores ``hello`` headers in :attr:`hello` and ``status`` headers in ``last_status``;
        never yields them. Ends when the stream closes; reconnecting is the caller's job.
        """
        async for msg, t_received in self.messages():
            if msg.type != "frame":
                continue
            try:
                yield Frame.from_message(msg, t_received)
            except (KeyError, TypeError, ValueError) as exc:
                log.warning("skipping malformed frame: %s", exc)


LOCAL_NETWORK_HINT = (
    " If Safari on this Mac can open the phone's address but Phone Gaze cannot, macOS is blocking the"
    " terminal: System Settings > Privacy & Security > Local Network, turn on the app that runs"
    " run.sh (Terminal, iTerm or your editor). On the iPhone: Settings > Privacy & Security > Local"
    " Network > Eye Capture must be on."
)


def _unreachable_hint(exc: BaseException) -> str:
    """The Local Network permission hint when ``exc`` is "no route to host" (EHOSTUNREACH), which
    is what macOS 15+ reports when the launching app lacks Local Network permission."""
    seen: BaseException | None = exc
    for _ in range(5):
        if seen is None:
            break
        if (isinstance(seen, OSError) and seen.errno == errno.EHOSTUNREACH) or "no route to host" in str(seen).lower():
            return "." + LOCAL_NETWORK_HINT
        seen = getattr(seen, "os_error", None) or seen.__cause__ or seen.__context__
    return ""


async def run_with_reconnect(
    client: PhoneClient,
    on_message: Callable[[Message, float], Awaitable[None] | None],
    stop: asyncio.Event,
    *,
    on_connect: Callable[[], Awaitable[None]] | None = None,
    on_state: Callable[[str, str], None] | None = None,
    base_delay_s: float = 1.0,
    max_delay_s: float = 30.0,
    clock_sync_interval_s: float = 10.0,
) -> None:
    """Keep the stream open until ``stop`` is set, reconnecting with exponential backoff.

    ``on_connect`` runs after each successful clock sync, before the stream opens (send stream
    config there). ``on_state(state, detail)`` reports ``"connecting"``, ``"connected"``,
    ``"disconnected"``. A failing ``on_message`` is logged, never fatal.
    """
    delay = base_delay_s
    while not stop.is_set():
        try:
            if on_state:
                on_state("connecting", client.base_url)
            # A fresh clock each time: the phone's clock stops while it sleeps, so samples from
            # before a disconnect would give an offset wrong by the sleep time.
            client.clock = ClockSync()
            await client.sync_clock(5)
            if on_connect is not None:
                await on_connect()
            sync_task = asyncio.create_task(_keep_clock(client, clock_sync_interval_s, stop))
            try:
                first = True
                async for msg, t_received in client.messages():
                    if first:
                        first = False
                        delay = base_delay_s
                        if on_state:
                            on_state("connected", client.base_url)
                    try:
                        res = on_message(msg, t_received)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception:  # noqa: BLE001 - one bad message must not stop the stream
                        log.exception("handling %s message failed", msg.type)
                    if stop.is_set():
                        break
            finally:
                sync_task.cancel()
            if stop.is_set():
                break
            detail = "stream closed by the phone"
        except asyncio.CancelledError:
            raise
        except PhoneError as exc:
            detail = str(exc)
        except Exception as exc:  # noqa: BLE001
            log.exception("phone connection failed")
            detail = f"{type(exc).__name__}: {exc}"
        if on_state:
            on_state("disconnected", detail)
        log.info("phone disconnected (%s); retrying in %.1f s", detail, delay)
        try:
            await asyncio.wait_for(stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass
        delay = min(max_delay_s, delay * 2)


async def _keep_clock(client: PhoneClient, interval_s: float, stop: asyncio.Event) -> None:
    while not stop.is_set():
        await asyncio.sleep(interval_s)
        try:
            await client.sync_clock(3)
        except PhoneError as exc:
            log.debug("clock sync failed: %s", exc)
