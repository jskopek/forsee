"""Tuning view and presets API. Owner: Core.

Routes (registered by ``server.create_app`` through :func:`register`):

- ``GET /api/tuning/eye.jpg?side=left|right&layers=a,b&w=420``: the eye as the estimators saw
  it (its native-resolution crop, else the whole-frame image round the eye), enlarged, with
  switchable overlays: ``crop`` (the eye-crop rectangle), ``edge`` (limbus points the iris fit
  used), ``ellipse`` (fitted iris), ``iris`` (iris centre), ``reflection`` (screen reflection
  centre and corners), ``corners`` (eye corners), ``lids`` (the eyelid masks of
  ``estimators.iris_lid_mask_*``, shaded). Uses the frozen frame while frozen.
- ``GET /api/tuning/stats``: live (or frozen) numbers per eye: iris radius in pixels, ellipse
  axes, fit confidence, rms, inliers, seed, sharpness, edge width, reflection score, mode and
  vector; distance and its source; detection rates over the last frames (face, iris fit,
  reflection); the camera controls last sent; the fallback pointer.
- ``POST /api/tuning/freeze`` ``{"frozen": bool}``: hold the current frame (images, observation,
  iris edge points) for inspection; the engine keeps running.
- ``POST /api/tuning/focus`` ``{"side", "lock"?}``: focus (and meter) on that eye; optionally lock.
- ``GET /api/presets``; ``POST /api/presets/apply {"name"}``; ``POST /api/presets/save {"name",
  "description"?, "mode"?}`` (current non-default experiment settings); ``POST
  /api/presets/delete {"name"}``; ``GET /api/presets/export?name=`` (a JSON file);
  ``POST /api/presets/import {"preset": {...}}``. See ``presets.py``.
"""

from __future__ import annotations

import asyncio
import copy
import json
import math
from typing import Any

import numpy as np
from aiohttp import web

from . import presets as P
from .types import DecodedFrame, Observation

LAYERS = ("crop", "edge", "ellipse", "iris", "reflection", "corners", "lids")
COLOURS = {"left": (0, 200, 255), "right": (255, 160, 0)}
TUNING_KEY = web.AppKey("tuning", dict)


# --------------------------------------------------------------------------------------------
# Snapshot of what the estimators saw
# --------------------------------------------------------------------------------------------


def _iris_debug(engine: Any) -> dict[str, Any]:
    for est in getattr(engine, "estimators", []) or []:
        if getattr(est, "name", "") == "iris_edge":
            return copy.deepcopy(getattr(est, "debug", {}) or {})
    return {}


def snapshot(engine: Any) -> dict[str, Any] | None:
    decoded, obs = engine.last_decoded, engine.last_obs
    if decoded is None or obs is None:
        return None
    return {"decoded": decoded, "obs": obs, "iris": _iris_debug(engine), "recent": list(getattr(engine, "_recent_obs", []))}


def _current(state: dict[str, Any], engine: Any) -> dict[str, Any] | None:
    return state.get("frozen") or snapshot(engine)


def _image_for_eye(decoded: DecodedFrame, obs: Observation, side: str):
    from .vision.iris_edge import _image_for

    eye = obs.eye(side)
    im = _image_for(decoded, side, eye.iris_center)
    return im


def _view_rect(decoded: DecodedFrame, obs: Observation, side: str, im: Any, roi_width_mm: float) -> tuple[float, float, float, float]:
    """The region shown (in ``im`` pixels): the whole crop, or a window round the eye in the
    whole-frame image."""
    h, w = im.pixels.shape[:2]
    if im.kind == "roi":
        return (0.0, 0.0, float(w), float(h))
    eye = obs.eye(side)
    c = eye.iris_center
    if c is None and eye.inner_corner is not None and eye.outer_corner is not None:
        c = ((eye.inner_corner[0] + eye.outer_corner[0]) / 2, (eye.inner_corner[1] + eye.outer_corner[1]) / 2)
    if c is None:
        return (0.0, 0.0, float(w), float(h))
    cx, cy = im.point_from_full(c)
    span = None
    if eye.inner_corner is not None and eye.outer_corner is not None:
        span = math.dist(eye.inner_corner, eye.outer_corner) * im.scale
    half = max(12.0, 1.1 * span) if span else max(12.0, 4.0 * (eye.iris_radius or 6.0) * im.scale)
    return (cx - half, cy - 0.6 * half, 2 * half, 1.2 * half)


def render_eye(snap: dict[str, Any], side: str, layers: set[str], out_w: int = 420, roi_width_mm: float = 30.0, lid_mask: tuple[float, float] = (0.0, 0.0)) -> bytes | None:
    import cv2

    decoded, obs = snap["decoded"], snap["obs"]
    im = _image_for_eye(decoded, obs, side)
    if im is None or im.pixels.ndim != 3:
        return None
    vx, vy, vw, vh = _view_rect(decoded, obs, side, im, roi_width_mm)
    k = out_w / max(1.0, vw)
    out_h = max(16, int(round(vh * k)))
    m = np.array([[k, 0, -vx * k], [0, k, -vy * k]], dtype=np.float64)
    interp = cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA
    pixels = cv2.warpAffine(im.pixels, m, (out_w, out_h), flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=(40, 40, 40))

    def to_out(p: tuple[float, float]) -> tuple[float, float]:
        x, y = im.point_from_full(p)  # continuous image pixels
        return ((x - 0.5 - vx) * k, (y - 0.5 - vy) * k)  # same index mapping as warpAffine above

    def ip(p: tuple[float, float]) -> tuple[int, int]:
        x, y = to_out(p)
        return (int(round(x)), int(round(y)))

    eye = obs.eye(side)
    col = COLOURS[side]
    lw = 2
    s_full = im.scale * k  # output pixels per full-frame pixel
    if "lids" in layers and eye.iris_center is not None and eye.iris_radius and any(v > 0 for v in lid_mask):
        overlay = pixels.copy()
        c = ip(eye.iris_center)
        r = int(round(1.45 * eye.iris_radius * s_full))
        up, lo = lid_mask
        if up > 0:
            cv2.ellipse(overlay, c, (r, r), 0, 270 - up, 270 + up, (0, 0, 200), -1)
        if lo > 0:
            cv2.ellipse(overlay, c, (r, r), 0, 90 - lo, 90 + lo, (0, 0, 200), -1)
        pixels = cv2.addWeighted(overlay, 0.35, pixels, 0.65, 0)
    if "crop" in layers:
        if im.kind == "roi":
            cv2.rectangle(pixels, (1, 1), (out_w - 2, out_h - 2), (0, 255, 0), lw)
        else:
            # Where an eye crop of stream.roi_width_mm would go (no crop arrived for this eye).
            from .lens import estimate_distance

            d = estimate_distance(obs) or 0.6
            intr = decoded.intrinsics
            if intr is not None and eye.iris_center is not None:
                wpx = intr.fx * roi_width_mm / 1000.0 / d
                cx, cy = eye.iris_center
                a, b = ip((cx - wpx / 2, cy - 0.3 * wpx)), ip((cx + wpx / 2, cy + 0.3 * wpx))
                cv2.rectangle(pixels, a, b, (0, 255, 0), 1, cv2.LINE_AA)
    if "edge" in layers:
        dbg = snap.get("iris", {}).get(side)
        if dbg and dbg.get("seq") == decoded.frame.seq:
            for p in dbg.get("edge_points", []):
                cv2.circle(pixels, ip(p), 2, (60, 255, 60), -1, cv2.LINE_AA)
    if "ellipse" in layers:
        if eye.iris_ellipse is not None:
            cx, cy, a, b, ang = eye.iris_ellipse
            cv2.ellipse(pixels, ip((cx, cy)), (max(1, int(round(a * s_full))), max(1, int(round(b * s_full)))), float(ang), 0, 360, col, lw, cv2.LINE_AA)
        elif eye.iris_center is not None and eye.iris_radius:
            cv2.circle(pixels, ip(eye.iris_center), max(1, int(round(eye.iris_radius * s_full))), col, 1, cv2.LINE_AA)
    if "iris" in layers and eye.iris_center is not None:
        cv2.drawMarker(pixels, ip(eye.iris_center), col, cv2.MARKER_CROSS, 18, lw, cv2.LINE_AA)
    if "reflection" in layers:
        if eye.reflection_corners:
            pts = np.array([ip(p) for p in eye.reflection_corners], np.int32)
            cv2.polylines(pixels, [pts], True, (255, 0, 255), 1, cv2.LINE_AA)
        if eye.reflection_center is not None:
            cv2.drawMarker(pixels, ip(eye.reflection_center), (255, 0, 255), cv2.MARKER_DIAMOND, 16, lw, cv2.LINE_AA)
    if "corners" in layers:
        for p in (eye.inner_corner, eye.outer_corner):
            if p is not None:
                cv2.circle(pixels, ip(p), 5, (0, 255, 0), -1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return bytes(buf) if ok else None


def _num(v: Any, digits: int = 3) -> Any:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f, digits) if math.isfinite(f) else None


def _rates(recent: list[Observation]) -> dict[str, Any]:
    n = len(recent)
    out: dict[str, Any] = {"frames": n}
    if not n:
        return out
    out["face"] = _num(sum(1 for o in recent if o.face_rect is not None or o.left.found or o.right.found) / n)
    for side in ("left", "right"):
        eyes = [o.eye(side) for o in recent]
        found = [e for e in eyes if e.found and not e.blink]
        out[f"{side}_iris_fit"] = _num(sum(1 for o in recent if o.provenance.get(f"{side}.iris_center") == "iris_edge") / n)
        out[f"{side}_reflection"] = _num(sum(1 for e in found if e.reflection_center is not None) / len(found)) if found else None
    vals = [v for v in (out.get("left_reflection"), out.get("right_reflection")) if v is not None]
    out["reflection"] = _num(sum(vals) / len(vals)) if vals else None
    return out


def stats(snap: dict[str, Any] | None, engine: Any, frozen: bool) -> dict[str, Any]:
    from .vision import eyes as E

    out: dict[str, Any] = {"frozen": frozen, "eyes": {}, "lens_controls": getattr(engine, "lens_controls", {})}
    fb = getattr(engine, "fallback", None)
    out["fallback"] = {"mode": getattr(engine.config.outputs, "fallback_pointer", "off"), "source": getattr(fb, "source", "")}
    if snap is None:
        return out
    decoded, obs = snap["decoded"], snap["obs"]
    out["seq"] = decoded.frame.seq
    out["camera"] = {"type": decoded.frame.camera.type, "zoom": decoded.frame.camera.zoom, "mode": decoded.frame.mode}
    out["images"] = sorted(decoded.images)
    dist_info = obs.extra.get("distance") or {}
    out["distance"] = {"m": _num(obs.distance), "set_by": obs.provenance.get("distance"), "source": dist_info.get("source") or obs.provenance.get("distance"), "cues": dist_info.get("cues")}
    lm = obs.extra.get("landmarks") or {}
    out["head_angles_deg"] = lm.get("head_angles_deg")
    out["face_attempt"] = lm.get("attempt")
    out["rates"] = _rates(snap.get("recent") or [])
    out["estimators"] = list(obs.estimators or [])
    out["timings_ms"] = {k: round(v, 1) for k, v in (getattr(engine, "timings_ms", {}) or {}).items()}
    refl = obs.extra.get("reflection") or {}
    out["reflection"] = {"latency_s": refl.get("latency_s"), "flashing": refl.get("flashing"), "priors": refl.get("priors")}
    for side in ("left", "right"):
        eye = obs.eye(side)
        ie = eye.extra.get("iris_edge") or {}
        rf = eye.extra.get("reflection") or {}
        im = _image_for_eye(decoded, obs, side)
        sharp = None
        if im is not None and eye.iris_center is not None and eye.iris_radius:
            try:
                c = np.array(im.point_from_full(eye.iris_center)) - 0.5
                sharp = E.eye_sharpness(im.gray, c, 2 * eye.iris_radius * im.scale)
            except Exception:  # noqa: BLE001
                sharp = None
        ell = eye.iris_ellipse
        out["eyes"][side] = {
            "found": eye.found,
            "blink": eye.blink,
            "openness": _num(eye.openness),
            "image": im.name if im is not None else None,
            "image_scale": _num(im.scale) if im is not None else None,
            "iris_set_by": obs.provenance.get(f"{side}.iris_center"),
            "iris_radius_px": _num(eye.iris_radius, 2),
            "iris_radius_image_px": _num(eye.iris_radius * im.scale, 2) if (im is not None and eye.iris_radius) else None,
            "ellipse_axes_px": [_num(ell[2], 2), _num(ell[3], 2)] if ell else None,
            "ellipse_ratio": _num(ell[3] / ell[2]) if ell and ell[2] else None,
            "fit_confidence": _num(ie.get("fit_confidence")),
            "fit_rms_px": _num(ie.get("rms_px")),
            "fit_inliers": ie.get("inliers"),
            "fit_seed": ie.get("seed"),
            "edge_width_px": _num(eye.iris_edge_sharpness, 2),
            "edge_contrast": _num(ie.get("contrast"), 1),
            "sharpness": _num(sharp),
            "reflection_score": _num(eye.reflection_score),
            "reflection_mode": rf.get("mode"),
            "reflection_vector": rf.get("vector"),
            "reflection_snr": _num(rf.get("snr"), 1),
            "reflection_area_ratio": _num(rf["area_px"] / rf["predicted_area_px"]) if rf.get("area_px") and rf.get("predicted_area_px") else None,
            "reflection_candidates": rf.get("candidates"),
            "confidence": _num(eye.confidence),
        }
    return out


# --------------------------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------------------------


def _json(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda d: json.dumps(d, allow_nan=False, default=str))


async def _body(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def register(app: web.Application, engine: Any) -> None:
    state: dict[str, Any] = {"frozen": None}
    app[TUNING_KEY] = state
    store = P.PresetStore(P.store_path(getattr(engine, "config_path", None)))
    engine.presets = store
    r = app.router

    async def eye_jpg(request: web.Request) -> web.Response:
        side = request.query.get("side", "left")
        if side not in ("left", "right"):
            return _json({"error": "side is left or right"}, 400)
        layers = {x for x in request.query.get("layers", ",".join(LAYERS)).split(",") if x in LAYERS}
        try:
            w = max(80, min(1600, int(request.query.get("w", engine.config.ui.tuning_crop_px if hasattr(engine.config.ui, "tuning_crop_px") else 420))))
        except ValueError:
            w = 420
        snap = _current(state, engine)
        if snap is None:
            return _json({"error": "no frame yet"}, 503)
        est = engine.config.estimators
        lid = (float(getattr(est, "iris_lid_mask_upper_deg", 0.0)), float(getattr(est, "iris_lid_mask_lower_deg", 0.0)))
        data = await asyncio.to_thread(render_eye, snap, side, layers, w, float(engine.config.stream.roi_width_mm), lid)
        if data is None:
            return _json({"error": f"no image of the {side} eye"}, 503)
        return web.Response(body=data, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def get_stats(request: web.Request) -> web.Response:
        snap = _current(state, engine)
        return _json(await asyncio.to_thread(stats, snap, engine, state["frozen"] is not None))

    async def freeze(request: web.Request) -> web.Response:
        body = await _body(request)
        want = bool(body.get("frozen", state["frozen"] is None))
        if want:
            snap = snapshot(engine)
            if snap is None:
                return _json({"error": "no frame yet"}, 503)
            state["frozen"] = snap
        else:
            state["frozen"] = None
        return _json({"frozen": state["frozen"] is not None})

    async def focus(request: web.Request) -> web.Response:
        body = await _body(request)
        side = body.get("side", "left")
        obs, decoded = engine.last_obs, engine.last_decoded
        if obs is None or decoded is None:
            return _json({"error": "no frame yet"}, 503)
        eye = obs.eye(side if side in ("left", "right") else "left")
        if eye.iris_center is None:
            return _json({"error": f"the {side} eye is not found"}, 409)
        try:
            await engine.focus(eye.iris_center[0] / decoded.width, eye.iris_center[1] / decoded.height, True if body.get("lock") else None)
        except Exception as exc:  # noqa: BLE001 - PhoneError and friends
            return _json({"error": str(exc)}, 502)
        return _json({"ok": True})

    def _listing() -> dict[str, Any]:
        out = []
        for p in store.all():
            out.append({**p, "diff": P.diff(p), "matches": P.matches(p, engine.config)})
        return {"presets": out, "folder": str(store.path), "current": P.current_changes(engine.config)}

    async def presets_get(request: web.Request) -> web.Response:
        return _json(_listing())

    async def presets_apply(request: web.Request) -> web.Response:
        body = await _body(request)
        try:
            preset = store.get(str(body.get("name") or ""))
        except P.PresetError as exc:
            return _json({"error": str(exc)}, 404)
        changes = P.changes_to_apply(preset, engine.config)
        errors = await engine.apply_config(changes) if changes else {}
        return _json({"applied": changes, "errors": errors, "values": engine.config.to_dict(), **_listing()})

    async def presets_save(request: web.Request) -> web.Response:
        body = await _body(request)
        try:
            p = store.save({"name": body.get("name"), "description": body.get("description") or "", "mode": body.get("mode") or "replace", "changes": P.current_changes(engine.config)})
        except P.PresetError as exc:
            return _json({"error": str(exc)}, 400)
        return _json({"saved": p, **_listing()})

    async def presets_delete(request: web.Request) -> web.Response:
        body = await _body(request)
        try:
            ok = store.delete(str(body.get("name") or ""))
        except P.PresetError as exc:
            return _json({"error": str(exc)}, 400)
        return _json({"deleted": ok, **_listing()})

    async def presets_export(request: web.Request) -> web.Response:
        try:
            p = store.get(request.query.get("name", ""))
        except P.PresetError as exc:
            return _json({"error": str(exc)}, 404)
        data = {"phonegaze_preset": 1, "name": p["name"], "description": p.get("description", ""), "mode": p.get("mode", "replace"), "changes": p["changes"]}
        safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in p["name"]).strip("-") or "preset"
        return web.Response(text=json.dumps(data, indent=2) + "\n", content_type="application/json", headers={"Content-Disposition": f'attachment; filename="phonegaze-preset-{safe}.json"'})

    async def presets_import(request: web.Request) -> web.Response:
        body = await _body(request)
        data = body.get("preset", body)
        if isinstance(data, dict) and body.get("name") and "preset" in body:
            data = {**data, "name": body["name"]}
        try:
            p = store.save(data, overwrite=bool(body.get("overwrite", False)))
        except P.PresetError as exc:
            return _json({"error": str(exc)}, 400)
        return _json({"saved": p, **_listing()})

    r.add_get("/api/tuning/eye.jpg", eye_jpg)
    r.add_get("/api/tuning/stats", get_stats)
    r.add_post("/api/tuning/freeze", freeze)
    r.add_post("/api/tuning/focus", focus)
    r.add_get("/api/presets", presets_get)
    r.add_post("/api/presets/apply", presets_apply)
    r.add_post("/api/presets/save", presets_save)
    r.add_post("/api/presets/delete", presets_delete)
    r.add_get("/api/presets/export", presets_export)
    r.add_post("/api/presets/import", presets_import)


__all__ = ["register", "render_eye", "stats", "snapshot", "LAYERS"]
