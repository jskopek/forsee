"""REST and WebSocket API for the browser UI and for Forsee, plus static files. Owner: Core.

Routes and message shapes are specified in ``docs/INTERFACES.md`` ("Engine HTTP API"). The UI
in ``phonegaze/web/`` is served at ``/``.

Imported by: ``__main__.py``, end-to-end tests (``create_app`` with an aiohttp test client).
"""

from __future__ import annotations

from aiohttp import web

from .pipeline import Engine


def create_app(engine: Engine) -> web.Application:
    """Build the aiohttp application: static UI, ``/api/*``, ``/ws`` (UI) and ``/gaze`` (Forsee)."""
    raise NotImplementedError


async def serve(engine: Engine, host: str, port: int) -> web.AppRunner:
    """Start serving and return the runner (call ``await runner.cleanup()`` to stop)."""
    raise NotImplementedError
