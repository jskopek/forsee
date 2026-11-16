"""The doctor: a checklist with a plain-language verdict and a fix for each item. Owner:
Diagnostics (with ``diagnostics.py``).

    python -m phonegaze doctor [--phone URL | --sim [arkit|camera]] [--seconds 5] [--json]
    python -m phonegaze bundle [--images] [--phone URL | --sim] [--out DIR]

If an engine is already running (``http://127.0.0.1:<server.port>``) both commands ask it, so the
checks see the live phone and calibration. Otherwise they start an engine in this process
(no cursor, no shortcuts, settings not saved), connect it to ``--phone`` (or the saved phone
address, or ``--sim``), watch a few seconds of frames and stop. ``--standalone`` never asks a
running engine.

What is checked, in order: Python and packages, the face model file, the data folder, settings
changed from their defaults, macOS permissions (Accessibility, Input Monitoring), screen size
and scale from macOS and from the browser, the phone (reachable, app and protocol versions,
clock offset and network round trip), the stream (frame rate, dropped frames, latency), the
camera, then every stage over live frames (face, each eye, iris fit and size, reflection,
distance and its source, sharpness, brightness, blinks, geometry plausibility), and the
calibration. The browser's Diagnostics page (``/diagnostics.html``) shows the same report.

Statuses: ``ok``, ``warn`` (works but probably hurts accuracy), ``fail`` (this will not work
until fixed), ``info`` (a number worth knowing), ``skip`` (not applicable here).
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import json
import logging
import os
import platform
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_APP_VERSION = "0.2.1"
"""The app version this engine was written against, if the repository's iOS project cannot be read."""

SETTINGS_URLS = {
    "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "input_monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
}

STATUSES = ("fail", "warn", "ok", "info", "skip")


@dataclass
class Check:
    """One item of the checklist."""

    id: str
    title: str
    status: str
    verdict: str
    fix: str = ""
    group: str = ""
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DoctorReport:
    checks: list[Check]
    started: str = ""
    duration_s: float = 0.0
    context: dict[str, Any] = field(default_factory=dict)

    @property
    def worst(self) -> str:
        for s in ("fail", "warn"):
            if any(c.status == s for c in self.checks):
                return s
        return "ok"

    def get(self, check_id: str) -> Check | None:
        return next((c for c in self.checks if c.id == check_id), None)

    def to_dict(self) -> dict[str, Any]:
        from .diagnostics import _jsonable

        return _jsonable(
            {
                "checks": [c.to_dict() for c in self.checks],
                "started": self.started,
                "duration_s": round(self.duration_s, 2),
                "context": self.context,
                "worst": self.worst,
                "counts": {s: sum(c.status == s for c in self.checks) for s in STATUSES},
            }
        )

    def to_text(self) -> str:
        return format_report(self.to_dict())


def format_report(d: dict[str, Any], *, verbose: bool = False) -> str:
    """Plain text for a terminal or a chat. Works on :meth:`DoctorReport.to_dict` output."""
    labels = {"ok": "OK  ", "warn": "WARN", "fail": "FAIL", "info": "info", "skip": "skip"}
    lines = [f"Phone Gaze doctor ({d.get('started', '')}, {d.get('duration_s', 0)} s)"]
    group = None
    for c in d.get("checks", []):
        if c.get("group") != group:
            group = c.get("group")
            lines.append("")
            lines.append(f"{group or 'Other'}")
        lines.append(f"  {labels.get(c['status'], c['status'])}  {c['title']}: {c['verdict']}")
        if c.get("fix") and c["status"] in ("fail", "warn"):
            for i, part in enumerate(_wrap(c["fix"], 92)):
                lines.append(f"        {'Fix: ' if i == 0 else '     '}{part}")
        if verbose and c.get("details"):
            lines.append(f"        {json.dumps(c['details'], default=str)[:300]}")
    counts = d.get("counts", {})
    lines.append("")
    lines.append(f"{counts.get('ok', 0)} ok, {counts.get('warn', 0)} warnings, {counts.get('fail', 0)} failures")
    return "\n".join(lines) + "\n"


def _wrap(text: str, width: int) -> list[str]:
    words, out, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            out.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        out.append(cur)
    return out or [""]


def _launcher_app() -> str:
    """The app that started this Python, as macOS lists it in Privacy & Security."""
    term = os.environ.get("TERM_PROGRAM", "")
    return {"Apple_Terminal": "Terminal", "iTerm.app": "iTerm", "vscode": "Visual Studio Code (or Cursor)", "WarpTerminal": "Warp", "ghostty": "Ghostty"}.get(term, "the app that runs run.sh (Terminal, iTerm or your editor)")


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _version_tuple(v: Any) -> tuple[int, ...] | None:
    nums = re.findall(r"\d+", str(v or ""))
    return tuple(int(n) for n in nums[:3]) if nums else None


# --------------------------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------------------------

PACKAGES = [
    ("numpy", "numpy", True),
    ("scipy", "scipy", True),
    ("opencv-contrib-python", "cv2", True),
    ("mediapipe", "mediapipe", True),
    ("aiohttp", "aiohttp", True),
    ("pillow", "PIL", False),
    ("onnxruntime", "onnxruntime", False),
    ("pynput", "pynput", False),
]


def package_versions() -> dict[str, str | None]:
    from importlib import metadata

    out: dict[str, str | None] = {}
    for dist, _mod, _req in PACKAGES:
        try:
            out[dist] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[dist] = None
    if out.get("opencv-contrib-python") is None:
        for alt in ("opencv-python", "opencv-python-headless", "opencv-contrib-python-headless"):
            try:
                out[alt] = metadata.version(alt)
            except metadata.PackageNotFoundError:
                pass
    return out


def environment_checks(config: Any, config_path: str | Path | None = None) -> list[Check]:
    from .diagnostics import current_log_file, data_dir, non_default_settings

    g = "This Mac"
    checks: list[Check] = []
    v = sys.version_info
    py = platform.python_version()
    if v < (3, 10):
        checks.append(Check("python", "Python", "fail", f"{py} is too old (3.10 or newer needed).", "Install uv or `brew install python@3.12`, delete sidecars/phone-gaze/engine/.venv and run run.sh again.", g))
    elif v >= (3, 14) and sys.platform == "darwin":
        checks.append(Check("python", "Python", "warn", f"{py}: global shortcuts are switched off with 3.14 (pynput can crash it on macOS 26).", "Install uv and delete .venv so run.sh makes one with Python 3.12.", g))
    else:
        checks.append(Check("python", "Python", "ok", f"{py} ({sys.executable})", group=g))

    vers = package_versions()
    missing = []
    import importlib

    for dist, mod, required in PACKAGES:
        if dist == "pynput" and sys.platform != "darwin":
            continue
        try:
            importlib.import_module(mod)
        except Exception as exc:  # noqa: BLE001 - ImportError or a broken native library
            if required:
                missing.append(f"{dist} ({type(exc).__name__}: {exc})")
            elif dist == "pynput":
                checks.append(Check("pynput", "pynput", "warn", f"cannot be loaded ({exc}); global shortcuts are off.", "Run run.sh again so it installs the dependencies.", g))
    shown = ", ".join(f"{k} {val}" for k, val in vers.items() if val)
    if missing:
        checks.append(Check("packages", "Packages", "fail", "missing or broken: " + "; ".join(missing), "Run sidecars/phone-gaze/run.sh again (it installs the dependencies), or `.venv/bin/pip install -r requirements.txt` in sidecars/phone-gaze/engine.", g, {"versions": vers}))
    else:
        checks.append(Check("packages", "Packages", "ok", shown, group=g, details={"versions": vers}))

    from .download import model_path

    name = config.estimators.landmarks_model
    mp = model_path(name)
    if "landmarks" not in config.estimators.order:
        checks.append(Check("face_model", "Face model", "skip", f"the landmarks estimator is switched off ({mp.name} not needed).", group=g))
    elif not mp.exists():
        checks.append(Check("face_model", "Face model", "fail", f"{mp} is missing, so camera mode cannot find faces.", "Run `.venv/bin/python -m phonegaze.download` in sidecars/phone-gaze/engine (needs internet), or run run.sh again.", g))
    elif mp.stat().st_size < 1_000_000:
        checks.append(Check("face_model", "Face model", "fail", f"{mp} is only {mp.stat().st_size} bytes; the download probably failed.", f"Delete {mp} and run `.venv/bin/python -m phonegaze.download`.", g))
    else:
        checks.append(Check("face_model", "Face model", "ok", f"{mp.name}, {mp.stat().st_size / 1e6:.1f} MB", group=g, details={"path": str(mp)}))

    dd = data_dir(config_path)
    try:
        dd.mkdir(parents=True, exist_ok=True)
        probe = dd / ".doctor-write-test"
        probe.write_text("ok")
        probe.unlink()
        lf = current_log_file()
        checks.append(Check("data_dir", "Data folder", "ok", f"{dd} is writable; log file: {lf if lf else 'off (diagnostics.log_file)'}", group=g))
    except OSError as exc:
        checks.append(Check("data_dir", "Data folder", "fail", f"cannot write to {dd}: {exc}", "Check the folder's permissions, or start with --config pointing somewhere writable.", g))

    changed = non_default_settings(config)
    if changed:
        text = ", ".join(f"{k}={val['value']!r}" for k, val in list(changed.items())[:12]) + (" ..." if len(changed) > 12 else "")
        checks.append(Check("settings", "Changed settings", "info", f"{len(changed)}: {text}", "Experiments page > 'Reset <section> to defaults' undoes them.", g, {"changed": changed}))
    else:
        checks.append(Check("settings", "Changed settings", "info", "none: every setting is at its default.", group=g))
    return checks


# --------------------------------------------------------------------------------------------
# macOS permissions and screen
# --------------------------------------------------------------------------------------------


def permission_checks() -> list[Check]:
    g = "macOS permissions"
    if sys.platform != "darwin":
        return [
            Check("accessibility", "Accessibility (cursor)", "skip", f"not macOS ({sys.platform}); the system cursor is never moved here.", group=g),
            Check("input_monitoring", "Input Monitoring (shortcuts)", "skip", "not macOS; global shortcuts are off.", group=g),
        ]
    from .outputs._quartz import quartz

    q = quartz()
    if q is None:
        return [Check("accessibility", "Accessibility (cursor)", "warn", "cannot load macOS's Quartz framework, so the cursor cannot be moved.", "Report this with a diagnostics bundle.", g)]
    app = _launcher_app()
    checks = []
    try:
        trusted = q.accessibility_trusted()
        post = q.can_post_events()
    except Exception as exc:  # noqa: BLE001
        trusted, post = None, None
        log.warning("accessibility check failed: %s", exc)
    ok = bool(trusted) or bool(post)
    fix = (
        f"System Settings > Privacy & Security > Accessibility: turn on {app} (add it with + if it is not listed), "
        f"then quit and restart the engine. Shortcut: open \"{SETTINGS_URLS['accessibility']}\" in Terminal."
    )
    if ok:
        checks.append(Check("accessibility", "Accessibility (cursor)", "ok", "granted: the cursor can be moved and clicked.", group=g, details={"ax_trusted": trusted, "post_events": post}))
    else:
        checks.append(Check("accessibility", "Accessibility (cursor)", "warn", "not granted: gaze works in the browser, but the system cursor will not move.", fix, g, {"ax_trusted": trusted, "post_events": post}))
    listen = None
    fn = getattr(q.cg, "CGPreflightListenEventAccess", None)
    if fn is not None:
        try:
            import ctypes

            fn.restype = ctypes.c_bool
            listen = bool(fn())
        except Exception:  # noqa: BLE001
            listen = None
    fix_im = (
        f"System Settings > Privacy & Security > Input Monitoring: turn on {app}, then restart the engine. "
        f"Shortcut: open \"{SETTINGS_URLS['input_monitoring']}\". Without it, shortcuts work only while the Phone Gaze page has focus."
    )
    if listen is None:
        checks.append(Check("input_monitoring", "Input Monitoring (shortcuts)", "info", "cannot be checked on this macOS version.", fix_im, g))
    elif listen:
        checks.append(Check("input_monitoring", "Input Monitoring (shortcuts)", "ok", "granted: global shortcuts can work.", group=g))
    else:
        checks.append(Check("input_monitoring", "Input Monitoring (shortcuts)", "warn", "not granted: Ctrl-Alt-C/R/V/P work only in the browser page.", fix_im, g))
    return checks


def screen_checks(engine: Any = None, browser: dict[str, Any] | None = None) -> list[Check]:
    g = "Screen"
    from .outputs.screen import get_screen_info

    checks: list[Check] = []
    mac = get_screen_info()
    used = getattr(engine, "screen", None) if engine is not None else None
    details: dict[str, Any] = {"macos": mac.to_dict(), "engine": used.to_dict() if used else None, "browser": browser}
    if mac.source == "fallback":
        status, verdict = ("skip" if sys.platform != "darwin" else "warn"), "macOS could not be asked; a 1440 x 900 pt placeholder is used."
        fix = "" if sys.platform != "darwin" else "Report this with a diagnostics bundle; calibration falls back to the browser's full-screen size."
    else:
        mm_per_pt = (mac.width_mm / mac.width) if mac.width_mm and mac.width else None
        verdict = f"{mac.width:g} x {mac.height:g} pt, scale {mac.scale:g}, {mac.width_mm or 0:.0f} x {mac.height_mm or 0:.0f} mm ({mac.name})"
        status, fix = "ok", ""
        if "estimated" in (mac.name or ""):
            status, fix = "warn", "macOS does not know this display's physical size; degrees will be off by the ratio of your real pixel density to a typical laptop's. Use the built-in display for calibration."
        elif mm_per_pt is not None and not 0.12 <= mm_per_pt <= 0.40:
            status, fix = "warn", f"{mm_per_pt:.3f} mm per point looks wrong (a Mac is about 0.2); degrees will be scaled wrongly."
    checks.append(Check("screen_macos", "Screen from macOS", status, verdict, fix, g, details))
    if used is not None and used.source != mac.source:
        checks.append(Check("screen_engine", "Screen the engine uses", "info", f"{used.width:g} x {used.height:g} pt from {used.source}" + (" (the simulator's screen)" if used.source == "sim" else ""), group=g))
    if browser:
        bw, bh = _num(browser.get("screen_width")), _num(browser.get("screen_height"))
        dpr = _num(browser.get("device_pixel_ratio"))
        ref = used if used is not None else mac
        problems = []
        if bw and bh and ref.source != "fallback" and (abs(bw - ref.width) > 1 or abs(bh - ref.height) > 1):
            problems.append(f"the browser's screen is {bw:g} x {bh:g}, the engine's {ref.width:g} x {ref.height:g} (window on another display, or browser zoom not 100 %)")
        if dpr and ref.source == "macos" and abs(dpr - ref.scale) > 0.05:
            problems.append(f"device pixel ratio {dpr:g} but macOS scale {ref.scale:g} (browser zoom is not 100 %: press Cmd-0)")
        sx, sy = _num(browser.get("screen_x")), _num(browser.get("screen_y"))
        if sx is not None and sy is not None and (sx < -1 or sy < -1 or (bw and sx >= ref.width)):
            problems.append("the window is not on the main display (calibration needs the display with the menu bar)")
        verdict = f"{bw or '?':g} x {bh or '?':g}, pixel ratio {dpr or '?'}" if bw and bh else "no screen size from the browser"
        if problems:
            checks.append(Check("screen_browser", "Screen from the browser", "warn", "; ".join(problems), "Move the browser to the main display, press Cmd-0 for 100 % zoom, and calibrate in full screen.", g, {"browser": browser}))
        else:
            checks.append(Check("screen_browser", "Screen from the browser", "ok", verdict + " (matches)", group=g, details={"browser": browser}))
    return checks


# --------------------------------------------------------------------------------------------
# Phone
# --------------------------------------------------------------------------------------------


def expected_app_version() -> str:
    """The iPhone app version in this repository (``generate_project.rb``), else the default."""
    try:
        rb = Path(__file__).resolve().parents[4] / "tools" / "eye-capture" / "ios" / "generate_project.rb"
        m = re.search(r"MARKETING_VERSION'\s*=>\s*'([\d.]+)'", rb.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    except (OSError, IndexError):
        pass
    return DEFAULT_APP_VERSION


async def _read_hello(client: Any, timeout_s: float) -> dict[str, Any]:
    """Open ``/stream``, return the first message's header (normally ``hello``), close it."""
    import aiohttp

    from .protocol import Decoder, ProtocolError

    decoder = Decoder()

    async def go() -> dict[str, Any]:
        async with client._http().get(client.base_url + "/stream", timeout=aiohttp.ClientTimeout(total=None, sock_connect=timeout_s)) as resp:
            if resp.status != 200:
                return {"_error": f"GET /stream: HTTP {resp.status}"}
            async for chunk in resp.content.iter_any():
                try:
                    msgs = decoder.feed(chunk)
                except ProtocolError as exc:
                    return {"_error": f"the stream is not in the PGZ1 format: {exc}"}
                if msgs:
                    return dict(msgs[0].header)
            return {"_error": "the stream closed before the first message"}

    try:
        return await asyncio.wait_for(go(), timeout_s)
    except asyncio.TimeoutError:
        return {"_error": f"no first message on /stream within {timeout_s:.0f} s"}
    except aiohttp.ClientError as exc:
        return {"_error": f"cannot open /stream: {exc}"}


async def probe_phone(url: str, *, timeout_s: float = 5.0, read_hello: bool = True, rounds: int = 10) -> dict[str, Any]:
    """Talk to the phone directly (not through the engine): status, clock round trips, and the
    stream's first message. Never raises; problems are in ``error``."""
    from .phone import ClockSync, PhoneClient, PhoneError

    client = PhoneClient(url, timeout_s)
    out: dict[str, Any] = {"url": client.base_url, "reachable": False}
    try:
        t0 = time.monotonic()
        out["status"] = await client.status()
        out["status_ms"] = (time.monotonic() - t0) * 1000.0
        out["reachable"] = True
        clock = ClockSync()
        rtts = []
        for _ in range(max(1, rounds)):
            a = time.monotonic()
            tp = await client.phone_time()
            b = time.monotonic()
            clock.add_sample(a, tp, b)
            rtts.append((b - a) * 1000.0)
        rtts.sort()
        out["rtt_ms"] = {"min": rtts[0], "median": rtts[len(rtts) // 2], "max": rtts[-1], "n": len(rtts)}
        out["clock_offset_s"] = clock.offset
        if read_hello:
            out["hello"] = await _read_hello(client, timeout_s)
    except PhoneError as exc:
        out["error"] = str(exc)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
    return out


def phone_checks(probe: dict[str, Any], engine: Any = None) -> list[Check]:
    from .phone import LOCAL_NETWORK_HINT, SUPPORTED_PROTOCOL

    g = "Phone"
    checks: list[Check] = []
    url = probe.get("url", "?")
    if not probe.get("reachable"):
        err = probe.get("error") or "no answer"
        fix = (
            "Check: the Eye Capture app is open and in the foreground with the screen on; the Mac and the iPhone are on the "
            "same Wi-Fi (guest networks often block devices from seeing each other); the address matches what the app shows; "
            "opening the address in Safari on this Mac shows the app's page."
        )
        if "Local Network" not in err:
            fix += LOCAL_NETWORK_HINT
        checks.append(Check("phone_reachable", "Phone reachable", "fail", f"{url}: {err}", fix, g, {"probe": probe}))
        return checks
    status = probe.get("status") or {}
    checks.append(Check("phone_reachable", "Phone reachable", "ok", f"{url} answered in {probe.get('status_ms', 0):.0f} ms", group=g))

    hello = (engine.phone.hello if engine is not None and getattr(engine, "phone", None) is not None and engine.phone.hello else None) or probe.get("hello") or {}
    sim = isinstance(hello.get("sim"), dict) or bool(getattr(engine, "simulated", False))
    app = hello.get("app") or status.get("app") or {}
    have = str(app.get("version") or "?")
    want = expected_app_version()
    hv, wv = _version_tuple(have), _version_tuple(want)
    if sim:
        checks.append(Check("app_version", "App version", "info", f"simulator ({app.get('name', '?')} {have})", group=g))
    elif hv is None:
        checks.append(Check("app_version", "App version", "warn", "the app did not say its version.", f"Rebuild and install the app from tools/eye-capture/ios (version {want}).", g))
    elif hv < (wv or hv):
        checks.append(Check("app_version", "App version", "warn", f"{have} is older than {want}, which this engine expects (live stream, zoom and lens control may be missing).", f"Rebuild the app in Xcode from tools/eye-capture/ios (README step 2) and run it on the phone.", g))
    else:
        checks.append(Check("app_version", "App version", "ok", f"{app.get('name', 'EyeCapture')} {have} (expected {want} or newer)", group=g, details={"device": hello.get("device")}))

    if hello.get("_error") and not hello.get("type"):
        checks.append(Check("protocol", "Stream protocol", "fail", hello["_error"], "The app may be too old to stream (it needs version 0.2 or newer): rebuild it. If it is new, report this with a bundle.", g))
    else:
        proto = hello.get("protocol")
        if hello.get("type") not in (None, "hello"):
            checks.append(Check("protocol", "Stream protocol", "warn", f"the stream's first message was {hello.get('type')!r}, not 'hello'.", "Report this with a diagnostics bundle.", g))
        elif isinstance(proto, int) and proto > SUPPORTED_PROTOCOL:
            checks.append(Check("protocol", "Stream protocol", "fail", f"the phone speaks protocol {proto}; this engine understands {SUPPORTED_PROTOCOL}.", "Update the engine (git pull) so it matches the app, or install the app version from this repository.", g))
        elif proto is None:
            checks.append(Check("protocol", "Stream protocol", "warn", "the phone did not say which protocol it speaks.", "Rebuild the app from this repository.", g))
        else:
            checks.append(Check("protocol", "Stream protocol", "ok", f"{proto} (engine supports {SUPPORTED_PROTOCOL})", group=g))

    rtt = probe.get("rtt_ms") or {}
    med, mx = rtt.get("median"), rtt.get("max")
    if med is None:
        checks.append(Check("network", "Network round trip", "warn", "could not be measured.", group=g))
    else:
        st = "ok" if med < 30 else "warn" if med < 150 else "fail"
        fix = "" if st == "ok" else "Wi-Fi is slow or busy: move closer to the router, use 5 GHz, or connect the iPhone to the Mac with a cable and use its USB network address. Lower stream.wide_width and stream.roi_quality."
        checks.append(Check("network", "Network round trip", st, f"median {med:.0f} ms, max {mx:.0f} ms over {rtt.get('n')} requests", fix, g, {"rtt_ms": rtt}))
    off = probe.get("clock_offset_s")
    eng_off = engine.phone.clock.offset if engine is not None and getattr(engine, "phone", None) is not None else None
    detail = f"offset {off:+.3f} s (engine clock minus phone clock), measured to within ±{(rtt.get('min') or 0) / 2:.0f} ms" if off is not None else "not measured"
    clock_status = "info"
    fix = ""
    if off is not None and eng_off is not None and abs(off - eng_off) > 0.05:
        clock_status, fix = "warn", "The engine's clock sync disagrees with a fresh one by more than 50 ms; latencies and look-point times will be off. Reconnect the phone."
        detail += f"; the engine uses {eng_off:+.3f} s"
    checks.append(Check("clock", "Clock offset", clock_status, detail, fix, g))

    st = (status.get("state") or {}) if isinstance(status, dict) else {}
    eng_st = ((getattr(engine, "phone_status", None) or {}).get("state") or {}) if engine is not None else {}
    if eng_st:
        st = eng_st  # newer: the engine follows the phone's status messages
    status_state = st
    problems = []
    if st.get("lastError"):
        problems.append(f"last error: {st['lastError']}")
    if st.get("interrupted"):
        problems.append(f"camera interrupted: {st['interrupted']}")
    if st.get("lowLight"):
        problems.append("the phone says the light is too low")
    mode = st.get("mode", "?")
    cam_text = f"{mode} mode, {st.get('cameraName') or st.get('cameraId') or 'no camera'}, zoom {st.get('zoom', '?')}, {st.get('width', '?')}x{st.get('height', '?')}, {st.get('measuredFps') or '?'} fps measured on the phone"
    if problems:
        checks.append(Check("phone_camera", "Phone camera", "warn", f"{cam_text}; " + "; ".join(problems), "More light on your face; keep the app in the foreground; if the camera is interrupted, close other camera apps and reopen Eye Capture.", g, {"state": status_state}))
    else:
        checks.append(Check("phone_camera", "Phone camera", "ok" if mode != "idle" else "info", cam_text if mode != "idle" else "idle (the engine starts the camera when it connects)", group=g, details={"state": status_state}))
    return checks


# --------------------------------------------------------------------------------------------
# Stream, stages and calibration (need a running engine)
# --------------------------------------------------------------------------------------------


def stream_checks(engine: Any, seconds: float) -> list[Check]:
    g = "Stream"
    checks: list[Check] = []
    cfg = engine.config
    phone = engine.phone
    ps = phone.stats.to_dict() if phone is not None else {}
    want = min(float(cfg.lens.fps), float(cfg.stream.max_fps))
    fps = _num(ps.get("fps"))
    if engine.replaying is not None:
        checks.append(Check("stream_fps", "Frame rate", "info", f"replaying {engine.replaying}; {engine.fps or 0:.1f} fps processed", group=g))
    elif fps is None:
        checks.append(Check("stream_fps", "Frame rate", "fail", "no frames are arriving from the phone.", "Keep Eye Capture in the foreground with the screen on; on the Aim page pick a camera; if it stays at zero, force-quit the app and reopen it.", g))
    else:
        st = "ok" if fps >= 0.75 * want else "warn" if fps >= 10 else "fail"
        fix = "" if st == "ok" else "Lower stream.wide_width, stream.roi_quality or lens.max_width on the Experiments page; check the phone is not hot (it caps its frame rate) and Wi-Fi is fast."
        thermal = (engine.last_frame.header or {}).get("thermalCapFps") if engine.last_frame is not None else None
        if thermal:
            st, fix = "warn", f"The phone is limiting itself to {thermal} fps because it is warm: take it out of its case, out of the sun, or lower lens.fps."
        checks.append(Check("stream_fps", "Frame rate", st, f"{fps:.1f} fps arriving (asked for {want:g})", fix, g, {"stats": ps}))
    frames = int(ps.get("frames") or 0)
    gaps = int(ps.get("seq_gaps") or 0)
    if frames:
        lost = 100.0 * gaps / (frames + gaps)
        eng_drop = 100.0 * engine.dropped / max(1, engine.dropped + engine.processed)
        st = "ok" if lost < 10 and eng_drop < 25 else "warn"
        fix = "" if st == "ok" else ("The phone skips frames it cannot send in time: lower stream.wide_width / stream.roi_quality. " if lost >= 10 else "") + ("The Mac cannot process every frame (the newest is kept, older ones are dropped): turn off estimators you do not need or raise estimators.landmarks_every." if eng_drop >= 25 else "")
        checks.append(Check("dropped", "Dropped frames", st, f"{lost:.1f} % missing on the way from the phone, {eng_drop:.1f} % skipped by the engine to stay current", fix.strip(), g))
    lat = _num(ps.get("latency_ms"))
    proc = _num((engine.timings_ms or {}).get("total"))
    if lat is not None or proc is not None:
        total = (lat or 0) + (proc or 0)
        st = "ok" if total < 120 else "warn" if total < 300 else "fail"
        fix = "" if st == "ok" else "Most often Wi-Fi: see the network round trip. If processing is the larger part, see the slowest stage below."
        checks.append(Check("latency", "End-to-end latency", st, f"about {total:.0f} ms from capture to output: {lat if lat is not None else '?':.0f} ms capture to Mac (includes phone encoding and Wi-Fi), {proc if proc is not None else 0:.0f} ms processing" if lat is not None else f"processing {proc:.0f} ms (capture time unknown before the clock sync)", fix, g))
    t = engine.timings_ms or {}
    stages = sorted(((k, v) for k, v in t.items() if k not in ("total", "estimators", "outputs")), key=lambda kv: -kv[1])
    if stages:
        k, v = stages[0]
        pfps = engine.fps
        st = "ok"
        fix = ""
        if fps and pfps and pfps < 0.8 * fps:
            st, fix = "warn", f"The Mac processes {pfps:.0f} of {fps:.0f} fps. '{k}' is the slowest; switch it off or lower its rate on the Experiments page to test whether accuracy suffers."
        checks.append(Check("processing", "Processing time", st, ", ".join(f"{a} {b:.1f} ms" for a, b in stages[:6]), fix, g, {"timings_ms": t}))
    if engine.last_frame is not None:
        c = engine.last_frame.camera
        intr = c.intrinsics
        st = "ok" if c.intrinsics_source in ("attachment", "arkit", "sim") else "warn"
        fix = "" if st == "ok" else "The camera matrix is estimated from the field of view, so distances can be off by several per cent; compare the distance shown with a tape measure."
        checks.append(Check("camera_matrix", "Camera matrix", st, f"{c.position} {c.type} at zoom {c.zoom:g}, {c.width}x{c.height}, fx {intr.fx:.0f} px from '{c.intrinsics_source}'" if intr else f"none (source '{c.intrinsics_source}')", fix, g))
    return checks


def stage_checks(s: dict[str, Any], engine: Any) -> list[Check]:
    """Verdicts on a :meth:`HealthMonitor.summary` of live frames."""
    from .vision.quality import MIN_SHARPNESS

    g = "Each stage, live"
    checks: list[Check] = []
    n = s.get("frames", 0)
    names = [getattr(e, "name", "") for e in getattr(engine, "estimators", [])] if engine is not None else []
    mode = getattr(getattr(engine, "last_frame", None), "mode", None)
    pct = s.get("pct") or {}
    med = s.get("median") or {}
    if n == 0:
        checks.append(Check("frames", "Frames processed", "fail", "no frames were processed while watching.", "See the stream checks above. Is the phone connected and its camera running?", g))
        return checks
    checks.append(Check("frames", "Frames processed", "info", f"{n} frames in {s.get('window_s')} s", group=g))

    def pct_check(cid: str, title: str, p: float | None, fix: str, good: float = 90, warn: float = 60, extra: str = "") -> None:
        if p is None:
            checks.append(Check(cid, title, "skip", "not measured" + extra, group=g))
            return
        st = "ok" if p >= good else "warn" if p >= warn else "fail"
        checks.append(Check(cid, title, st, f"{p:.0f} % of frames{extra}", fix if st != "ok" else "", g))

    pct_check("face", "Face found", pct.get("face"), "Sit in front of the phone, face lit from the front, the phone level with your eyes and less than a metre away. On the Aim page, check the preview shows your face.")
    if pct.get("arkit") is not None:
        pct_check("arkit", "ARKit tracking the face", pct.get("arkit"), "ARKit loses faces that are too close, too far, turned away or badly lit; without it the engine outputs no gaze. Face the phone at 40-80 cm with light on your face.")
    pct_check("left_eye", "Left eye found", pct.get("left_eye"), "Hair, glasses frames or a reflection may hide this eye; turn your head slightly towards the phone.")
    pct_check("right_eye", "Right eye found", pct.get("right_eye"), "Hair, glasses frames or a reflection may hide this eye; turn your head slightly towards the phone.")
    if "iris_edge" in names and mode != "arkit":
        pct_check("iris_fit", "Iris edge fitted (both eyes)", pct.get("iris_fit"), "The sub-pixel fit needs sharp, large eyes: zoom in (lens.zoom 2), click an eye on the Aim page to focus there and lock focus, add light.", extra=f" (left {pct.get('iris_fit_left') or 0:.0f} %, right {pct.get('iris_fit_right') or 0:.0f} %)")
    elif "iris_edge" in names:
        checks.append(Check("iris_fit", "Iris edge fitted", "info", f"{pct.get('iris_fit') or 0:.0f} % of frames (ARKit mode uses Apple's eye transforms instead)", group=g))
    conf = med.get("iris_conf")
    if conf is not None:
        # No threshold: what a good confidence is on real eyes is not known yet (the simulator gives about 0.5).
        checks.append(Check("iris_conf", "Iris fit confidence", "info", f"median {conf:.2f} (0-1; compare between setups, higher is better)", group=g))
    ipx = med.get("iris_px")
    if ipx is None:
        checks.append(Check("iris_size", "Iris size", "skip" if mode == "arkit" else "warn", "not measured" if mode == "arkit" else "no iris measured.", "" if mode == "arkit" else "See the eye checks above.", g))
    elif mode == "arkit":
        checks.append(Check("iris_size", "Iris size", "info", f"{ipx:.0f} px across (ARKit mode does not depend on it)", group=g))
    else:
        st = "ok" if ipx >= 30 else "warn" if ipx >= 15 else "fail"
        checks.append(Check("iris_size", "Iris size", st, f"{ipx:.0f} px across (30 or more is good for the sub-pixel fit)", "" if st == "ok" else "Zoom in (Aim page: Find the best lens, or lens.zoom 2), move the phone closer, or raise lens.max_width.", g))
    if "reflection" in names:
        p = pct.get("reflection")
        if mode == "arkit":
            checks.append(Check("reflection", "Screen reflection", "info", f"{p or 0:.0f} % of frames (used by the reflection model in camera mode)", group=g))
        else:
            pct_check("reflection", "Screen reflection", p, "The reflection model needs the screen's reflection on your cornea: screen brightness up, room lights dimmer or behind you, and tick 'Flash the screen' when calibrating.", good=70, warn=30, extra=f" (left {pct.get('reflection_left') or 0:.0f} %, right {pct.get('reflection_right') or 0:.0f} %)")
    d = med.get("distance_m")
    src = s.get("distance_source")
    if d is None:
        checks.append(Check("distance", "Distance", "fail", "no distance estimate.", "Distance comes from ARKit, a depth sensor or the iris size; if eyes are found but no distance, report this with a bundle.", g))
    else:
        lo, hi = 0.25, 1.2
        st = "ok" if lo <= d <= hi else "warn"
        fix = "" if st == "ok" else "Measure the real distance. If it is far from this (for example 2x), the camera matrix or zoom handling is wrong: use ARKit mode and send a bundle."
        checks.append(Check("distance", "Distance", st, f"{100 * d:.0f} cm, from '{src or '?'}' ({pct.get('distance') or 0:.0f} % of frames); check it against a tape measure", fix, g, {"sources": s.get("distance_sources")}))
    sh = med.get("sharpness")
    if sh is not None:
        st = "ok" if sh >= MIN_SHARPNESS else "warn"
        checks.append(Check("sharpness", "Sharpness", st, f"median {sh:.3f} (below {MIN_SHARPNESS} counts as out of focus; synthetic threshold)", "" if st == "ok" else "Click an eye on the Aim page to focus there, then Lock focus; hold the phone still (a stand helps).", g))
    br = med.get("brightness")
    if br is not None:
        st = "ok" if 50 <= br <= 210 else "warn" if 25 <= br <= 235 else "fail"
        fix = "" if st == "ok" else ("More light on your face (a lamp behind the screen), or exposure bias up." if br < 50 else "Too bright around the eyes: less direct light, or exposure bias down.")
        checks.append(Check("brightness", "Brightness around the eyes", st, f"median {br:.0f} of 255", fix, g))
    closed = s.get("closed_pct")
    rate = s.get("blink_rate_per_min")
    if closed is not None:
        if closed > 50:
            checks.append(Check("blinks", "Eyes open", "fail", f"eyes look closed in {closed:.0f} % of frames.", "If your eyes were open, the eyelid measurement is wrong (glasses, lighting, or a threshold): report with a bundle. Gaze is not output while eyes look closed.", g))
        else:
            r = f", {rate:.0f} blinks per minute" if rate is not None else f", {s.get('blinks_in_window', 0)} blinks while watching"
            st = "warn" if (rate is not None and rate > 40) or closed > 20 else "ok"
            checks.append(Check("blinks", "Eyes open", st, f"closed in {closed:.0f} % of frames{r}", "" if st == "ok" else "Too many blinks detected: the eyelid opening may be misread (squinting, glasses, low camera angle). Raise the phone towards eye level.", g))
    for geo in s.get("geometry") or []:
        if geo.get("ok") is None:
            continue
        val = geo["value"]
        unit = geo.get("unit") or ""
        text = f"{val:.2f}{(' ' + unit) if unit else ''}: {geo['text']}"
        if geo["name"] == "distance_m":
            continue  # covered above
        if geo["ok"]:
            checks.append(Check(f"geometry_{geo['name']}", f"Plausible {geo['name'].replace('_', ' ')}", "ok", text, group=g))
        else:
            fixes = {
                "eye_spacing_ratio": "The eyes or irises found are probably wrong (an eyebrow, a glasses rim, or a reflection). Look at the Aim page with overlays.",
                "eye_distance_mm": "The 3-D eye positions are off; in camera mode this usually means the distance or the camera matrix is wrong.",
                "iris_mm": "The iris size, the distance and the camera matrix disagree: one of them is wrong (often the zoom in the camera matrix). Use ARKit mode and send a bundle.",
                "left_right": "Left and right are swapped: the image may be mirrored. Report with a bundle.",
            }
            checks.append(Check(f"geometry_{geo['name']}", f"Plausible {geo['name'].replace('_', ' ')}", "warn", text + f" (expected {geo['expected'][0]}-{geo['expected'][1]})", fixes.get(geo["name"], ""), g))
    if pct.get("usable") is not None:
        reasons = s.get("unusable_reasons") or {}
        st = "ok" if pct["usable"] >= 80 else "warn" if pct["usable"] >= 50 else "fail"
        why = ", ".join(f"{k} {v:.0f} %" for k, v in reasons.items())
        checks.append(Check("usable", "Usable frames", st, f"{pct['usable']:.0f} %" + (f"; unusable because: {why}" if why else ""), "" if st == "ok" else "Fix the most common reason listed.", g))
    return checks


def calibration_checks(engine: Any) -> list[Check]:
    g = "Calibration"
    if engine is None:
        return []
    if not engine.models:
        return [Check("calibration", "Calibration", "warn", "none for this camera and screen, so there is no gaze output yet.", "Dashboard > Calibrate, choose 3 head positions, then Validate.", g)]
    reports = sorted((r for r in engine.reports if r.ok and r.loo_error_deg is not None), key=lambda r: r.loo_error_deg)
    active = getattr(engine.active_model(), "name", None)
    text = f"using {active}" + (f" (pinned)" if engine.config.models.pinned else "") + ("; leave-one-out " + ", ".join(f"{r.model} {r.loo_error_deg:.2f}°" for r in reports[:5]) if reports else "")
    checks = [Check("calibration", "Calibration", "ok", text, group=g)]
    val = engine.validation or {}
    accs = {k: v.get("accuracy_deg") for k, v in val.items() if isinstance(v, dict) and isinstance(v.get("accuracy_deg"), (int, float))}
    if not accs:
        checks.append(Check("validation", "Validation", "info", "not run since calibrating.", "Press Validate (V): fresh dots give the number to believe.", g))
    else:
        best = min(accs.items(), key=lambda kv: kv[1])
        mine = accs.get(active) if active else None
        st = "ok" if (mine if mine is not None else best[1]) <= 2.0 else "warn"
        fix = "" if st == "ok" else "Recalibrate with 3 head positions; try pinning the model that validated best; check the stage verdicts above."
        if mine is not None and best[0] != active and best[1] < mine - 0.3:
            st, fix = "warn", f"{best[0]} validated better ({best[1]:.2f}°) than the model in use ({mine:.2f}°): pin it on the Dashboard."
        checks.append(Check("validation", "Validation", st, ", ".join(f"{k} {v:.2f}°" for k, v in sorted(accs.items(), key=lambda kv: kv[1])), fix, g))
    return checks


# --------------------------------------------------------------------------------------------
# Running the checks
# --------------------------------------------------------------------------------------------


async def stop_engine(engine: Any) -> None:
    """Stop an engine the doctor started and close MediaPipe's landmarker right away (left to the
    garbage collector at interpreter exit, its ``__del__`` can deadlock)."""
    executor = getattr(engine, "_executor", None)
    await engine.stop()
    if executor is not None:
        # The frame worker may still be inside the landmarker: closing it then crashes.
        await asyncio.to_thread(executor.shutdown, True)
    for est in list(getattr(engine, "estimators", []) or []):
        lm = getattr(est, "_landmarker", None)
        if lm is not None:
            try:
                lm.close()
            except Exception:  # noqa: BLE001
                pass
            est._landmarker = None


async def wait_for_frames(engine: Any, timeout_s: float = 15.0) -> bool:
    """Wait until the engine is connected and has processed a frame since now."""
    start = time.monotonic()
    first = engine.processed
    while time.monotonic() - start < timeout_s:
        if engine.phone_state == "connected" and engine.processed > first:
            return True
        await asyncio.sleep(0.1)
    return False


async def run_checks(
    engine: Any = None,
    *,
    config: Any,
    config_path: str | Path | None = None,
    phone_url: str | None = None,
    seconds: float = 5.0,
    browser: dict[str, Any] | None = None,
    monitor: Any = None,
    probe: dict[str, Any] | None = None,
) -> DoctorReport:
    """Run the whole checklist. With an ``engine`` the stream, live stages and calibration are
    checked over ``seconds`` of frames; without one, only this Mac and the phone's answers."""
    from .diagnostics import HealthMonitor

    t_start = time.monotonic()
    started = _dt.datetime.now().isoformat(sep=" ", timespec="seconds")
    checks: list[Check] = []
    checks += await asyncio.to_thread(environment_checks, config, config_path)
    checks += permission_checks()
    checks += screen_checks(engine, browser)
    context: dict[str, Any] = {"platform": sys.platform, "seconds": seconds}

    replaying = engine is not None and getattr(engine, "replaying", None) is not None
    url = None
    if engine is not None and getattr(engine, "phone", None) is not None and not replaying:
        url = engine.phone_url
    url = url or phone_url or (None if replaying else config.phone.url) or None
    context["phone_url"] = url
    if replaying:
        checks.append(Check("phone_reachable", "Phone", "info", f"replaying a recording ({engine.replaying}); phone checks skipped.", group="Phone"))
    elif url:
        connected = engine is not None and engine.phone is not None and engine.phone_state == "connected"
        if probe is None:
            probe = await probe_phone(url, timeout_s=float(config.phone.connect_timeout_s), read_hello=not connected)
        checks += phone_checks(probe, engine)
        context["probe"] = {k: v for k, v in probe.items() if k not in ("status",)}
    else:
        checks.append(Check("phone_reachable", "Phone reachable", "skip", "no phone address known yet.", "Give one: python -m phonegaze doctor --phone http://<address the app shows>, or connect on the Dashboard.", "Phone"))

    phone_bad = any(c.id in ("phone_reachable", "protocol") and c.status == "fail" for c in checks)
    if engine is not None and not phone_bad and (engine.phone is not None or replaying):
        if engine.phone_state != "connected" or engine.last_frame is None:
            await wait_for_frames(engine, timeout_s=10.0)
        mon = monitor if monitor is not None else HealthMonitor(engine, window_s=seconds, keep_s=max(seconds, 10.0))
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            mon.poll()
            await asyncio.sleep(0.2)
        mon.poll()
        summary = mon.summary(seconds)
        context["health"] = summary
        checks += stream_checks(engine, seconds)
        checks += stage_checks(summary, engine)
        if engine.phone_state != "connected" and not replaying:
            checks.append(Check("engine_phone", "Engine connection", "fail", f"the engine is {engine.phone_state}: {engine.phone_detail}", "See the phone checks above.", "Stream"))
    checks += calibration_checks(engine)
    report = DoctorReport(checks=checks, started=started, duration_s=time.monotonic() - t_start, context=context)
    log.info("doctor: %s (%s)", report.worst, ", ".join(f"{c.id}={c.status}" for c in checks if c.status in ("fail", "warn")) or "no problems")
    return report


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    cmd = argv[0] if argv else "doctor"
    p = argparse.ArgumentParser(prog=f"python -m phonegaze {cmd}", description="Check the setup and say what to fix." if cmd == "doctor" else "Write a diagnostics folder to send to the developers.")
    p.add_argument("--phone", metavar="URL", help="phone address (default: the saved one)")
    p.add_argument("--sim", nargs="?", const="camera", choices=["camera", "arkit"], help="check against the simulated phone")
    p.add_argument("--seconds", type=float, help="seconds of live frames to watch (default diagnostics.doctor_seconds)")
    p.add_argument("--config", help="config file (default ~/.phonegaze/config.json)")
    p.add_argument("--engine", metavar="URL", help="a running engine to ask (default http://127.0.0.1:<server.port>)")
    p.add_argument("--standalone", action="store_true", help="never ask a running engine; start one in this process")
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    p.add_argument("--verbose", action="store_true", help="print each check's details")
    if cmd == "bundle":
        p.add_argument("--images", action="store_true", help="include the latest camera images (they show your face; the folder stays on this Mac)")
        p.add_argument("--out", metavar="DIR", help="where to write the folder (default ~/.phonegaze/diagnostics)")
        p.add_argument("--label", default="", help="a word added to the folder name")
    args = p.parse_args(argv[1:])
    args.cmd = cmd
    return args


async def _engine_alive(url: str) -> dict[str, Any] | None:
    import aiohttp

    try:
        async with aiohttp.ClientSession() as s, s.get(url.rstrip("/") + "/api/state", timeout=aiohttp.ClientTimeout(total=1.5)) as r:
            if r.status == 200:
                return await r.json()
    except Exception:  # noqa: BLE001
        return None
    return None


async def _ask_engine(url: str, path: str, body: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    import aiohttp

    async with aiohttp.ClientSession() as s, s.post(url.rstrip("/") + path, json=body, timeout=aiohttp.ClientTimeout(total=timeout_s)) as r:
        data = await r.json(content_type=None)
        if r.status >= 400:
            raise RuntimeError(f"{path}: HTTP {r.status}: {data}")
        return data


async def _run(args: argparse.Namespace) -> int:
    from .config import DEFAULT_PATH, Config, ConfigError, load_config
    from .diagnostics import HealthMonitor, data_dir, write_bundle

    config_path = Path(args.config).expanduser() if args.config else DEFAULT_PATH
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        print(f"Cannot read the config ({exc}); using defaults.", file=sys.stderr)
        config = Config()
    seconds = float(args.seconds) if args.seconds else float(config.diagnostics.doctor_seconds)
    bundle = args.cmd == "bundle"

    if not args.standalone and not args.sim:
        engine_url = args.engine or f"http://127.0.0.1:{config.server.port}"
        state = await _engine_alive(engine_url)
        if state is not None:
            print(f"Asking the running engine at {engine_url} ...", file=sys.stderr)
            running_url = (state.get("phone") or {}).get("url")
            if args.phone and running_url and args.phone.rstrip("/") not in running_url:
                print(f"Note: the running engine is connected to {running_url}, not {args.phone}. Use --standalone to check {args.phone} separately (stop the engine first).", file=sys.stderr)
            if bundle:
                res = await _ask_engine(engine_url, "/api/diagnostics/bundle", {"include_images": bool(args.images), "seconds": seconds, "label": args.label, "out_root": args.out or ""}, seconds + 60)
                print(json.dumps(res, indent=2) if args.json else res.get("summary", ""))
                print(f"Written to {res.get('path')}", file=sys.stderr)
                return 0
            rep = await _ask_engine(engine_url, "/api/diagnostics/doctor", {"seconds": seconds}, seconds + 60)
            print(json.dumps(rep, indent=2) if args.json else format_report(rep, verbose=args.verbose))
            return 1 if rep.get("worst") == "fail" else 0

    from .pipeline import Engine

    phone_url = args.phone or (None if args.sim else config.phone.url) or None
    engine = None
    probe = None
    monitor = None
    try:
        if args.sim or phone_url:
            profile = "sim" if args.sim else "default"
            engine = Engine(config, config_path=None, sinks=[], hotkeys=False, no_cursor=True, profile_dir=data_dir(config_path) / "profiles" / profile)
            await engine.start(autoconnect=False)
            monitor = HealthMonitor(engine, window_s=seconds, keep_s=max(seconds, float(config.diagnostics.bundle_seconds)))
            if args.sim:
                print(f"Starting the simulated phone ({args.sim}) ...", file=sys.stderr)
                await engine.connect(sim=True, sim_camera={"camera": "wide"}.get(args.sim, args.sim))
            else:
                print(f"Checking {phone_url} ...", file=sys.stderr)
                probe = await probe_phone(phone_url, timeout_s=float(config.phone.connect_timeout_s))
                proto = (probe.get("hello") or {}).get("protocol")
                from .phone import SUPPORTED_PROTOCOL

                if probe.get("reachable") and not (isinstance(proto, int) and proto > SUPPORTED_PROTOCOL):
                    await engine.connect(phone_url)
                else:
                    await stop_engine(engine)
                    engine = None
            if engine is not None:
                print(f"Watching {seconds:g} s of frames ...", file=sys.stderr)
                if not await wait_for_frames(engine, 20.0):
                    print("No frames yet after 20 s; checking anyway.", file=sys.stderr)
        report = await run_checks(engine, config=config, config_path=config_path, phone_url=phone_url, seconds=seconds, monitor=monitor, probe=probe)
        if bundle:
            res = await asyncio.to_thread(write_bundle, engine=engine, config=config, config_path=config_path, doctor=report, health=monitor, include_images=bool(args.images), out_root=args.out, label=args.label)
            print(json.dumps(res, indent=2) if args.json else res["summary"])
            print(f"Written to {res['path']}", file=sys.stderr)
            return 0
        print(json.dumps(report.to_dict(), indent=2) if args.json else format_report(report.to_dict(), verbose=args.verbose))
        return 1 if report.worst == "fail" else 0
    finally:
        if engine is not None:
            await stop_engine(engine)


def main(argv: list[str]) -> int:
    """``argv`` starts with ``"doctor"`` or ``"bundle"``."""
    args = parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("aiohttp").setLevel(logging.ERROR)
    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
