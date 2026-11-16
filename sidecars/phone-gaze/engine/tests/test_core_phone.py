"""Phone client against an in-process fake phone. Owner: Core."""

from __future__ import annotations

import asyncio

import pytest
from core_fakes import FakePhone, wait_for

from phonegaze.phone import ClockSync, PhoneClient, PhoneError, run_with_reconnect


def test_clock_sync_keeps_smallest_round_trip() -> None:
    c = ClockSync()
    assert c.to_local(5.0) is None
    c.add_sample(100.0, 10.0, 100.2)  # rtt 0.2, offset 90.1
    c.add_sample(101.0, 11.0, 101.02)  # rtt 0.02, offset 90.01
    c.add_sample(102.0, 12.5, 102.5)  # rtt 0.5, ignored
    assert c.round_trip == pytest.approx(0.02)
    assert c.offset == pytest.approx(90.01)
    assert c.to_local(20.0) == pytest.approx(110.01)
    assert c.to_phone(110.01) == pytest.approx(20.0)


def test_clock_sync_forgets_old_samples() -> None:
    c = ClockSync(max_age_s=10)
    c.add_sample(0.0, 0.0, 0.001)  # very good, but old
    c.add_sample(50.0, 40.0, 50.1)
    assert c.offset == pytest.approx(10.05)


async def test_control_routes_and_stream() -> None:
    phone = FakePhone(fps=60)
    url = await phone.start()
    client = PhoneClient(url)
    try:
        status = await client.status()
        assert status["cameras"][0]["id"] == "back-wide"
        await client.sync_clock(3)
        assert client.clock.offset == pytest.approx(phone.offset, abs=0.05)
        st = await client.configure("back-wide", 1920, 30, 2.0)
        assert st["state"]["mode"] == "camera" and phone.zoom == 2.0
        await client.set_zoom(1.0)
        assert phone.zoom == 1.0
        await client.set_focus(locked=True, point=(1.5, -0.2))
        assert phone.requests[-1] == ("/api/focus", {"x": 1.0, "y": 0.0, "locked": True})
        cfg = await client.set_stream_config({"rois": [{"name": "left_eye", "x": 0.5, "y": 0.4, "w": 0.1, "h": 0.06}]})
        assert cfg["rois"][0]["name"] == "left_eye"

        frames = []
        async for frame in client.frames():
            frames.append(frame)
            if len(frames) == 5:
                break
        assert client.hello is not None and client.hello["protocol"] == 1
        assert [f.part("left_eye") is not None for f in frames] == [True] * 5
        assert all(f.t_received is not None for f in frames)
        assert frames[-1].seq > frames[0].seq
        assert client.stats.frames >= 5
        assert client.stats.latency_ms is not None and client.stats.latency_ms < 1000
    finally:
        await client.close()
        await phone.stop()


async def test_errors_become_phone_errors() -> None:
    phone = FakePhone()
    url = await phone.start()
    client = PhoneClient(url)
    try:
        with pytest.raises(PhoneError) as exc:
            await client.set_zoom(2.0)  # idle phone answers 409
        assert exc.value.status == 409
        with pytest.raises(PhoneError) as exc:
            await client.request("POST", "/api/configure", {})
        assert exc.value.status == 400 and "cameraId missing" in str(exc.value)
    finally:
        await client.close()
        await phone.stop()
    dead = PhoneClient("127.0.0.1:9", timeout_s=1.0)
    with pytest.raises(PhoneError):
        await dead.status()
    await dead.close()


async def test_reconnects_after_stream_ends() -> None:
    phone = FakePhone(fps=60, close_after=3)
    url = await phone.start()
    await PhoneClient(url).configure("back-wide")  # leave it running
    client = PhoneClient(url)
    stop = asyncio.Event()
    received = []
    states = []

    def on_message(msg, t):
        if msg.type == "frame":
            received.append(msg.header["seq"])

    task = asyncio.create_task(run_with_reconnect(client, on_message, stop, on_state=lambda s, d: states.append(s), base_delay_s=0.05))
    try:
        await wait_for(lambda: phone.streams_opened >= 3 and len(received) >= 7)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
        await client.close()
        await phone.stop()
    assert "connected" in states and "disconnected" in states


async def test_reconnect_survives_unreachable_phone() -> None:
    client = PhoneClient("http://127.0.0.1:9", timeout_s=0.5)
    stop = asyncio.Event()
    states = []
    task = asyncio.create_task(run_with_reconnect(client, lambda m, t: None, stop, on_state=lambda s, d: states.append((s, d)), base_delay_s=0.05))
    await wait_for(lambda: sum(1 for s, _ in states if s == "disconnected") >= 2)
    stop.set()
    await asyncio.wait_for(task, 5)
    await client.close()
