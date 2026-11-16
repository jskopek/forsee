"""Command line entry point: ``python -m phonegaze``. Owner: Core.

Arguments::

    --config PATH         config file (default: phonegaze.config.DEFAULT_PATH)
    --sim [arkit|camera]  start the simulated phone in-process and connect to it
                          (camera: the simulated back wide camera; arkit: simulated ARKit)
    --phone URL           phone base URL (overrides phone.url)
    --replay DIR          play a recorded session (folder) through the engine instead of a phone
    --port N              engine port (overrides server.port)
    --host HOST           engine address (overrides server.host)
    --no-browser          do not open the UI
    --no-cursor           do not move the system cursor, even if the config says so
    --no-hotkeys          do not listen for global shortcuts
    --log-level LEVEL

Starts the aiohttp server from ``phonegaze.server`` and runs until Ctrl-C.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
import webbrowser
from pathlib import Path

if sys.version_info < (3, 10):  # pragma: no cover
    sys.exit("Phone Gaze needs Python 3.10 or newer (macOS ships 3.9; install a newer Python, e.g. from python.org or Homebrew).")

log = logging.getLogger("phonegaze")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m phonegaze", description="Phone Gaze: an eye tracker made from an iPhone and a Mac.")
    p.add_argument("--config", help="config file (default ~/.phonegaze/config.json)")
    p.add_argument("--sim", nargs="?", const="camera", choices=["camera", "arkit", "wide", "ultrawide", "front"], help="use the simulated phone")
    p.add_argument("--phone", metavar="URL", help="phone address, e.g. http://192.168.1.20:8080")
    p.add_argument("--replay", metavar="DIR", help="play a recorded session instead of a phone")
    p.add_argument("--port", type=int, help="engine port (default from config, 8765)")
    p.add_argument("--host", help="engine address (default 127.0.0.1)")
    p.add_argument("--no-browser", action="store_true", help="do not open the UI in a browser")
    p.add_argument("--no-cursor", action="store_true", help="never move the system cursor")
    p.add_argument("--no-hotkeys", action="store_true", help="do not listen for global shortcuts")
    p.add_argument("--profile", default="default", help="calibration profile name (default 'default')")
    p.add_argument("--log-level", default="INFO", help="DEBUG, INFO, WARNING or ERROR")
    args = p.parse_args(argv)
    if sum(1 for v in (args.sim, args.phone, args.replay) if v) > 1:
        p.error("choose one of --sim, --phone and --replay")
    return args


async def run(args: argparse.Namespace) -> int:
    from .config import DEFAULT_PATH, ConfigError, load_config
    from .pipeline import Engine
    from .server import serve

    config_path = Path(args.config).expanduser() if args.config else DEFAULT_PATH
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        log.error("cannot read the config: %s", exc)
        return 2
    if args.port:
        config.server.port = args.port
    if args.host:
        config.server.host = args.host
    phone_url = args.phone or config.phone.url

    profile_dir = config_path.parent / "profiles" / args.profile
    engine = Engine(config, config_path=config_path, profile_dir=profile_dir, hotkeys=not args.no_hotkeys, no_cursor=args.no_cursor)
    # --sim and --replay do not connect to the saved phone; --phone connects without saving.
    await engine.start(autoconnect=not (args.sim or args.replay or args.phone))
    try:
        if args.sim:
            cam = {"camera": "wide"}.get(args.sim, args.sim)
            await engine.connect(sim=True, sim_camera=cam)
        elif args.replay:
            await engine.connect_replay(Path(args.replay))
        elif args.phone:
            await engine.connect(args.phone)
    except Exception as exc:  # noqa: BLE001
        log.error("could not start the phone source: %s", exc)

    host, port = config.server.host, config.server.port
    try:
        runner = await serve(engine, host, port)
    except OSError as exc:
        log.error("cannot listen on %s:%s (%s). Is Phone Gaze already running? Try --port.", host, port, exc)
        await engine.stop()
        return 1
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}/"
    print(f"Phone Gaze is running at {url}  (Ctrl-C to stop)", flush=True)
    print(f"  Forsee gaze stream: ws://{url[7:]}gaze", flush=True)
    if not (phone_url or args.sim or args.replay):
        print("  No phone yet: enter its address in the UI, or restart with --phone URL or --sim.", flush=True)
    if config.server.open_browser and not args.no_browser:
        with contextlib.suppress(Exception):
            webbrowser.open(url)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        print("Stopping...", flush=True)
        await runner.cleanup()
        await engine.stop()
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, build the Engine, serve until interrupted. Returns the exit code."""
    args = parse_args(argv)
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
