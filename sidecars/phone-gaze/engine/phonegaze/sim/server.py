"""Simulated phone HTTP server. Owner: Simulator."""

from __future__ import annotations

from aiohttp import web

from ..config import SimConfig


class SimPhone:
    """Serves the phone routes from docs/PROTOCOL.md for a :class:`~.scene.SimScene`."""

    def __init__(self, config: SimConfig) -> None:
        self.config = config

    async def start(self, host: str = "127.0.0.1", port: int | None = None) -> str:
        """Start serving; returns the base URL (``port=0`` picks a free port)."""
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    def app(self) -> web.Application:
        raise NotImplementedError


async def run_sim(config: SimConfig) -> SimPhone:
    """Start a simulator on ``config.port``."""
    raise NotImplementedError
