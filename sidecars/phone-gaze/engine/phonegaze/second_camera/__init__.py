"""Second camera (experimental): the Mac's built-in camera as a position anchor for the phone.

The webcam is rigidly attached to the screen, so its pose relative to the screen is known from
the display geometry. The phone sees the eyes in far more detail, but where it is relative to the
screen is unknown. Seeing the same head from both gives the phone's pose relative to the webcam,
hence to the screen. See ``docs/SECOND_CAMERA.md``.

Modules: ``geometry`` (poses, robust averaging, triangulation), ``webcam`` (frame sources),
``tracker`` (face landmarks on webcam frames), ``solver`` (phone-pose solve, move detection),
``fusion`` (what the solve does to phone observations), ``models`` (``geometric_2cam``,
``webcam``), ``manager`` (the engine hooks), and :func:`routes` for the HTTP API.

Everything is behind ``second_camera.enabled`` (default off). Engine hooks are marked
``# second camera`` in ``pipeline.py`` and ``server.py``.
"""

from __future__ import annotations

from typing import Any

from .manager import SecondCamera
from .models import Geometric2CamModel, WebcamGeometricModel


def routes(engine: Any) -> list[tuple[str, str, Any]]:
    """``(method, path, handler)`` for ``server.create_app``:

    - ``GET /api/second_camera``: the state shown on the Second camera page.
    - ``GET /api/second_camera/preview.jpg``: the latest webcam image with the detected face.
    - ``POST /api/second_camera/reanchor``: forget the solved phone pose and solve again.
    """
    import json

    from aiohttp import web

    def sc() -> SecondCamera:
        return engine.second_camera

    async def state(request: web.Request) -> web.Response:
        return web.json_response(_jsonable(sc().state()), dumps=lambda d: json.dumps(d, allow_nan=False, default=str))

    async def preview(request: web.Request) -> web.Response:
        data = sc().preview_jpeg()
        if data is None:
            return web.json_response({"error": "no webcam frame yet"}, status=503)
        return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def reanchor(request: web.Request) -> web.Response:
        sc().reset()
        engine.log("info", "Second camera: re-anchoring the phone's position from scratch.")
        return web.json_response(_jsonable(sc().state()))

    return [
        ("GET", "/api/second_camera", state),
        ("GET", "/api/second_camera/preview.jpg", preview),
        ("POST", "/api/second_camera/reanchor", reanchor),
    ]


def _jsonable(v: Any) -> Any:
    from ..types import _jsonable as j

    return j(v)


__all__ = ["SecondCamera", "Geometric2CamModel", "WebcamGeometricModel", "routes"]
