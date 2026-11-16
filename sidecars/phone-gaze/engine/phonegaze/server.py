"""REST and WebSocket API for the browser UI and for Forsee, plus static files. Owner: Core.

Routes and message shapes are specified in ``docs/INTERFACES.md`` ("Engine HTTP API"). The UI
in ``phonegaze/web/`` is served at ``/``.

Imported by: ``__main__.py``, end-to-end tests (``create_app`` with an aiohttp test client).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from .config import settings
from .phone import PhoneError
from .pipeline import Engine

log = logging.getLogger(__name__)

ENGINE_KEY = web.AppKey("engine", Engine)
WS_QUEUE = 200
"""UI WebSocket messages buffered per client before the oldest are dropped."""

_PLACEHOLDER = (
    "<!doctype html><html><head><meta charset='utf-8'><title>Phone Gaze</title></head>"
    "<body style='font-family:system-ui;margin:2rem'><h1>Phone Gaze engine</h1>"
    "<p>The engine is running, but the web UI files are not installed yet.</p>"
    "<p>API: <a href='/api/state'>/api/state</a></p></body></html>"
)


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda d: json.dumps(d, allow_nan=False, default=str))


def _error(text: str, status: int = 400) -> web.Response:
    return _json({"error": text}, status)


async def _body(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise web.HTTPBadRequest(text=json.dumps({"error": f"body is not JSON: {exc}"}), content_type="application/json") from exc
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": "body must be a JSON object"}), content_type="application/json")
    return data


Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


def _guard(fn: Handler) -> Handler:
    """Map errors to ``{"error"}`` answers: bad input 400, phone trouble 502, the rest 500."""

    async def wrapped(request: web.Request) -> web.StreamResponse:
        try:
            return await fn(request)
        except web.HTTPException:
            raise
        except (ValueError, KeyError, TypeError) as exc:
            return _error(str(exc) or type(exc).__name__, 400)
        except PhoneError as exc:
            return _error(str(exc), 502)
        except NotImplementedError as exc:
            return _error(f"not implemented yet: {exc}", 501)
        except Exception as exc:  # noqa: BLE001
            log.exception("%s %s failed", request.method, request.path)
            return _error(f"{type(exc).__name__}: {exc}", 500)

    return wrapped


def create_app(engine: Engine) -> web.Application:
    """Build the aiohttp application: static UI, ``/api/*``, ``/ws`` (UI) and ``/gaze`` (Forsee)."""
    app = web.Application(client_max_size=16 << 20)
    app[ENGINE_KEY] = engine
    r = app.router

    async def state(request: web.Request) -> web.Response:
        return _json(engine.state())

    async def get_config(request: web.Request) -> web.Response:
        return _json({"values": engine.config.to_dict(), "settings": [s.to_dict() for s in settings()]})

    async def post_config(request: web.Request) -> web.Response:
        body = await _body(request)
        changes = body.get("changes")
        if not isinstance(changes, dict):
            return _error("expected {\"changes\": {path: value}}")
        errors = await engine.apply_config(changes)
        return _json({"values": engine.config.to_dict(), "errors": errors})

    async def phone_connect(request: web.Request) -> web.Response:
        body = await _body(request)
        if body.get("sim"):
            await engine.connect(sim=True, sim_camera=body.get("camera"))
        elif body.get("replay"):
            await engine.connect_replay(Path(engine.config.recording.directory).expanduser() / str(body["replay"]))
        else:
            url = str(body.get("url") or "").strip()
            if not url:
                return _error("give {\"url\": \"http://phone:8080\"} or {\"sim\": true}")
            if url != engine.config.phone.url:
                await engine.apply_config({"phone.url": url})  # saves it and connects
            else:
                await engine.connect(url)
        return _json(engine.state())

    async def phone_disconnect(request: web.Request) -> web.Response:
        await engine.disconnect()
        return _json(engine.state())

    async def phone_status(request: web.Request) -> web.Response:
        if engine.phone is None:
            return _error("no phone connected", 503)
        return _json(await engine.phone.status())

    async def camera(request: web.Request) -> web.Response:
        body = await _body(request)
        await engine.set_camera(str(body["camera_id"]), body.get("zoom"), body.get("fps"), body.get("max_width"))
        return _json(engine.state())

    async def zoom(request: web.Request) -> web.Response:
        body = await _body(request)
        z = float(body["zoom"])
        await engine.apply_config({"lens.zoom": z})
        return _json(engine.state())

    async def focus(request: web.Request) -> web.Response:
        body = await _body(request)
        await engine.focus(body.get("x"), body.get("y"), body.get("locked"))
        return _json(engine.state())

    async def aim(request: web.Request) -> web.Response:
        body = await _body(request)
        await engine.start_aim(body.get("cameras"), body.get("zooms"))
        return _json({"started": True})

    async def preview(request: web.Request) -> web.Response:
        image = request.query.get("image", "wide")
        overlay = request.query.get("overlay", "0") in ("1", "true", "yes")
        data = await asyncio.to_thread(engine.preview_jpeg, image, overlay)
        if data is None:
            return _error(f"no {image!r} image yet", 503)
        return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def calib_start(request: web.Request) -> web.Response:
        body = await _body(request)
        rounds = body.get("pose_rounds")
        return _json(engine.start_calibration(str(body.get("kind", "grid")), pose_rounds=int(rounds) if rounds is not None else None))

    async def calib_finish(request: web.Request) -> web.Response:
        body = await _body(request)
        return _json(await engine.finish_calibration(str(body.get("run_id", "")), commit=body.get("commit", True) is not False))

    async def calib_cancel(request: web.Request) -> web.Response:
        body = await _body(request)
        engine.cancel_calibration(str(body.get("run_id", "")))
        return _json({"ok": True})

    async def model(request: web.Request) -> web.Response:
        body = await _body(request)
        engine.pin_model(str(body.get("pinned") or ""))
        return _json(engine.state())

    async def pause(request: web.Request) -> web.Response:
        body = await _body(request)
        engine.set_paused(bool(body.get("paused", not engine.paused)))
        return _json(engine.state())

    async def record_start(request: web.Request) -> web.Response:
        body = await _body(request)
        return _json(engine.start_recording(str(body.get("label") or "")))

    async def record_stop(request: web.Request) -> web.Response:
        summary = engine.stop_recording()
        return _json(summary or {"error": "not recording"}, 200 if summary else 409)

    async def recordings(request: web.Request) -> web.Response:
        return _json({"recordings": engine.recordings()})

    async def replay(request: web.Request) -> web.Response:
        from . import replay as replay_mod
        from .config import Config
        from .models import build_models
        from .vision import build_estimators

        body = await _body(request)
        rec_id = str(body["id"])
        root = Path(engine.config.recording.directory).expanduser()
        path = (root / rec_id).resolve()
        if root.resolve() not in path.parents or not path.is_dir():
            return _error(f"no recording {rec_id!r}", 404)
        cfg = Config.from_dict(engine.config.to_dict())
        if body.get("estimators"):
            cfg.estimators.order = list(body["estimators"])
        if body.get("models"):
            cfg.models.candidates = list(body["models"])
        estimators = build_estimators(cfg.estimators)
        models = build_models(cfg.models)
        return _json(await asyncio.to_thread(replay_mod.score, path, estimators, models))

    async def lookpoint(request: web.Request) -> web.Response:
        body = await _body(request)
        try:
            outcome = engine.lookpoint(float(body["x"]), float(body["y"]), body.get("t"), rect=body.get("rect"), kind=str(body.get("kind") or "dwell"), sel_id=body.get("id"))
        except (KeyError, TypeError, ValueError):
            return _error("x and y (screen points) are required")
        return _json({"ok": True, "outcome": outcome})

    async def lookpoint_undo(request: web.Request) -> web.Response:
        body = await _body(request)
        return _json({"ok": True, "changed": engine.lookpoint_undo(body.get("id"))})

    async def drift_get(request: web.Request) -> web.Response:
        return _json(engine.drift_state())

    async def drift_reset(request: web.Request) -> web.Response:
        body = await _body(request)
        if body.get("offset", True):
            engine.drift.reset("reset from the UI")
        if body.get("stats", False):
            engine.drift.clear_stats()
        return _json(engine.drift_state())

    async def ui_ws(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=WS_QUEUE)

        def push(message: dict[str, Any]) -> None:
            try:
                text = json.dumps(message, allow_nan=False, default=str)
            except ValueError:
                return
            if queue.full():
                try:
                    queue.get_nowait()  # drop the oldest; the UI only needs recent data
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(text)

        async def sender() -> None:
            while True:
                text = await queue.get()
                await ws.send_str(text)

        push({"type": "hello", "version": 1, "state": engine.state()})
        unsubscribe = engine.subscribe(push)
        task = asyncio.create_task(sender())
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if not isinstance(data, dict):
                    continue
                try:
                    reply = engine.handle_ui_message(data)
                except Exception:  # noqa: BLE001
                    log.exception("UI message %s failed", data.get("type"))
                    continue
                if reply is not None:
                    push(reply)
        finally:
            unsubscribe()
            task.cancel()
        return ws

    async def gaze_ws(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        await ws.send_str(json.dumps(engine.gaze_ws.hello(), allow_nan=False))
        engine.gaze_ws.add(ws)
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(data, dict) and data.get("type") in ("lookpoint", "lookpoint.undo"):
                    try:
                        engine.handle_gaze_client_message(data)
                    except (KeyError, TypeError, ValueError):
                        continue
        finally:
            engine.gaze_ws.remove(ws)
        return ws

    async def static(request: web.Request) -> web.StreamResponse:
        from .web import STATIC_DIR

        rel = request.match_info.get("path", "") or "index.html"
        root = Path(STATIC_DIR).resolve()
        target = (root / rel).resolve()
        if root != target and root not in target.parents:
            raise web.HTTPNotFound()
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file() or target.suffix == ".py":
            if rel == "index.html":
                return web.Response(text=_PLACEHOLDER, content_type="text/html")
            raise web.HTTPNotFound()
        return web.FileResponse(target, headers={"Cache-Control": "no-cache"})

    routes: list[tuple[str, str, Handler]] = [
        ("GET", "/api/state", state),
        ("GET", "/api/config", get_config),
        ("POST", "/api/config", post_config),
        ("POST", "/api/phone/connect", phone_connect),
        ("POST", "/api/phone/disconnect", phone_disconnect),
        ("GET", "/api/phone/status", phone_status),
        ("POST", "/api/camera", camera),
        ("POST", "/api/zoom", zoom),
        ("POST", "/api/focus", focus),
        ("POST", "/api/aim", aim),
        ("GET", "/api/preview.jpg", preview),
        ("POST", "/api/calibration/start", calib_start),
        ("POST", "/api/calibration/finish", calib_finish),
        ("POST", "/api/calibration/cancel", calib_cancel),
        ("POST", "/api/model", model),
        ("POST", "/api/pause", pause),
        ("POST", "/api/record/start", record_start),
        ("POST", "/api/record/stop", record_stop),
        ("GET", "/api/recordings", recordings),
        ("POST", "/api/replay", replay),
        ("POST", "/api/lookpoint", lookpoint),
        ("POST", "/api/lookpoint/undo", lookpoint_undo),
        ("GET", "/api/drift", drift_get),
        ("POST", "/api/drift/reset", drift_reset),
    ]
    for method, path, handler in routes:
        r.add_route(method, path, _guard(handler))
    r.add_get("/ws", ui_ws)
    r.add_get("/gaze", gaze_ws)

    async def api_404(request: web.Request) -> web.Response:
        return _error(f"no such API route: {request.method} {request.path}", 404)

    r.add_route("*", "/api/{tail:.*}", api_404)
    r.add_get("/", static)
    r.add_get("/{path:.*}", static)
    return app


async def serve(engine: Engine, host: str, port: int) -> web.AppRunner:
    """Start serving and return the runner (call ``await runner.cleanup()`` to stop)."""
    runner = web.AppRunner(create_app(engine), access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    return runner
