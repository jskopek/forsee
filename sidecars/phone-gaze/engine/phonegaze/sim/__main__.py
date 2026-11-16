"""Run the simulated phone on its own: ``python -m phonegaze.sim --mode camera --port 8081``.

Then point the engine (or anything speaking docs/PROTOCOL.md) at ``http://127.0.0.1:8081``.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal

from ..config import SimConfig
from .server import SCRIPTS, SimPhone


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m phonegaze.sim", description="A simulated phone with a synthetic face whose gaze is known.")
    p.add_argument("--mode", choices=["camera", "arkit", "wide", "ultrawide", "tele", "front"], default="camera", help="camera: back wide camera; arkit: front TrueDepth with ARKit")
    p.add_argument("--port", type=int, default=8081)
    p.add_argument("--host", default="127.0.0.1", help="address to listen on (0.0.0.0 to reach it from another machine)")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--orientation", type=int, choices=[0, 90, 180, 270], default=180)
    p.add_argument("--script", choices=list(SCRIPTS), default="still")
    p.add_argument("--workers", type=int, default=-1, help="render processes (-1 automatic, 0 in a thread)")
    p.add_argument("--idle", action="store_true", help="start with no camera running (like the app); the client must POST /api/configure")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args(argv)


async def amain(args: argparse.Namespace) -> None:
    camera = {"camera": "wide"}.get(args.mode, args.mode)
    cfg = SimConfig()
    cfg.port, cfg.seed, cfg.fps = args.port, args.seed, args.fps
    cfg.camera = camera
    cfg.orientation, cfg.script, cfg.render_workers = args.orientation, args.script, args.workers
    phone = SimPhone(cfg, autostart=not args.idle)
    url = await phone.start(host=args.host, port=args.port)
    print(f"Simulated phone ({camera}) at {url}  (Ctrl-C to stop)", flush=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await phone.stop()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(level=getattr(logging, str(args.log_level).upper(), logging.INFO), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(amain(args))


if __name__ == "__main__":
    main()
