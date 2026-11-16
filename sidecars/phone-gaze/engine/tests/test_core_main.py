"""``python -m phonegaze`` end to end: replay a synthetic recording, query the API, stop with
Ctrl-C. Owner: Core."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from core_fakes import FakePhone

from phonegaze.__main__ import parse_args
from phonegaze.protocol import Message
from phonegaze.recorder import Recorder


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_parse_args() -> None:
    a = parse_args(["--sim"])
    assert a.sim == "camera" and not a.no_browser
    assert parse_args(["--sim", "arkit", "--no-browser", "--port", "9000"]).port == 9000
    with pytest.raises(SystemExit):
        parse_args(["--sim", "--phone", "http://x"])


@pytest.mark.slow
def test_main_replays_and_serves(tmp_path: Path) -> None:
    phone = FakePhone()
    phone.mode, phone.camera_id = "camera", "back-wide"
    rec = Recorder(tmp_path / "rec", {"screen": {"width": 800, "height": 500, "source": "sim"}})
    rec.write_message(Message({"type": "hello", "protocol": 1}), 0.0)
    for i in range(20):
        header, parts = phone.frame()
        header["parts"] = [dict(d, bytes=len(p)) for d, p in zip(header["parts"], parts)]
        rec.write_message(Message(header, parts), 0.05 * i)
    rec.close()
    port = free_port()
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(
        [sys.executable, "-m", "phonegaze", "--replay", str(tmp_path / "rec"), "--no-browser", "--no-hotkeys", "--port", str(port), "--config", str(tmp_path / "cfg" / "config.json")],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    try:
        state = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1) as r:
                    state = json.loads(r.read())
                if state["pipeline"]["processed"] >= 5:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        assert state is not None, "server never answered"
        assert state["pipeline"]["processed"] >= 5 and state["screen"]["width"] == 800
        assert state["phone"]["replay"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/preview.jpg", timeout=2) as r:
            assert r.read(2) == b"\xff\xd8"
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate()
    text = out.decode(errors="replace")
    assert proc.returncode == 0, text
    assert "Phone Gaze is running" in text
