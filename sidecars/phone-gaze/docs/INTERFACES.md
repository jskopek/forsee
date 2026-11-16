# Interfaces between areas

How the areas in `ARCHITECTURE.md` fit together, so each can be built without talking to the
others. `phonegaze/types.py` and `phonegaze/config.py` are the source of truth for data shapes;
this file says who calls what. The phone wire format is in `PROTOCOL.md`.

## Ground rules for building

- Work only in the files your area owns (table below). Shared types change only by adding fields
  with defaults, through Foundation. To add a setting, append a field with `setting(...)` at the
  end of your own section class in `config.py` (sections and owners are listed in its docstring).
- Every stub raises `NotImplementedError`. Keep each public name and signature; add parameters
  only with defaults. Add whatever private helpers and extra modules you need inside your area.
- Tests go in `sidecars/phone-gaze/engine/tests/`, named `test_<area>_*.py` (`test_core_…`,
  `test_vision_…`, `test_models_…`, `test_sim_…`, `test_ui_…`). Test data you generate goes in
  `tests/data/<area>/` and must be synthetic: never a real face or eye.
- Run tests with `cd sidecars/phone-gaze/engine && .venv/bin/python -m pytest tests/test_<area>_*`.
  Tests that take more than a few seconds get `@pytest.mark.slow`; macOS-only ones
  `@pytest.mark.macos` plus a skip on other platforms.
- Python 3.10 compatible syntax (`from __future__ import annotations` at the top of each module).
  No new dependencies without a strong reason; the virtualenv is shared.
- All data in memory uses the conventions in the `types.py` docstring: upright full-frame pixels
  (continuous convention, pixel centre at `+0.5`), upright camera coordinates in metres (x right,
  y down, z forward), screen points, person's own left and right, `None` for missing.

## Ownership

| Area       | Files                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation | `types.py`, `protocol.py`, `config.py`, `download.py`, `tests/test_types.py`, `test_protocol.py`, `test_config.py`, `test_imports.py`, `test_environment.py`, docs |
| Core       | `__main__.py`, `phone.py`, `pipeline.py` (keep `run_estimators` semantics), `server.py`, `recorder.py`, `replay.py`, `outputs/`                                    |
| Vision     | `vision/`                                                                                                                                                          |
| Models     | `models/`, `calibration.py`, `filters.py`                                                                                                                          |
| Simulator  | `sim/`                                                                                                                                                             |
| UI         | `web/` (static files; `web/__init__.py` exposes `STATIC_DIR`)                                                                                                      |
| iOS        | `tools/eye-capture/ios` (implements PROTOCOL.md)                                                                                                                   |
| Forsee     | `packages/gaze-web` (consumes the gaze WebSocket below)                                                                                                            |

## Python entry points across areas

| Provided by | Name                                                                                                 | Used by                    |
| ----------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| Foundation  | `types.Frame.from_message(msg, t_received)`                                                          | Core, Simulator tests      |
| Foundation  | `types.DecodedFrame.from_frame(frame, rotation)`                                                     | Core, Vision tests, replay |
| Foundation  | `types.upright_rotation(gravity, position)`                                                          | Core                       |
| Foundation  | `types.Observation.empty(decoded)`, `Observation.set(path, value, estimator)`                        | Vision, Core               |
| Foundation  | `protocol.encode`, `protocol.Decoder`, `protocol.read_messages`, `protocol.write_messages`           | Core, Simulator            |
| Foundation  | `config.Config`, `load_config`, `save_config`, `settings`, `update`                                  | everyone                   |
| Foundation  | `download.ensure_model(name)`, `download.model_path(name)`                                           | Vision                     |
| Core        | `pipeline.run_estimators(estimators, decoded) -> Observation` (implemented)                          | replay, tests              |
| Core        | `pipeline.Engine(config)`: `start`, `stop`, `state`, `subscribe`                                     | server, `__main__`, tests  |
| Core        | `phone.PhoneClient(base_url)`                                                                        | Engine, tests              |
| Core        | `server.create_app(engine)`, `server.serve(engine, host, port)`                                      | `__main__`, e2e tests      |
| Core        | `outputs.screen.get_screen_info() -> ScreenInfo`                                                     | Engine                     |
| Core        | `replay.iter_frames`, `replay.iter_eye_capture`, `replay.score`                                      | tests, UI (via server)     |
| Vision      | `vision.build_estimators(config.estimators) -> list[Estimator]`, `vision.REGISTRY`                   | Engine, replay             |
| Vision      | `vision.quality.measure_quality(decoded, obs) -> dict`                                               | Core (aiming)              |
| Models      | `models.build_models(config.models)`, `models.load_model(dict)`, `models.REGISTRY`                   | Engine, calibration        |
| Models      | `calibration.config_targets`, `CalibrationRun`, `fit_all`, `refine`, `validation_metrics`, `Profile` | Engine, replay             |
| Models      | `filters.build_filter(config.filters) -> GazeFilter`                                                 | Engine                     |
| Simulator   | `sim.server.SimPhone(config.sim)`: `await start(port=0) -> base_url`, `stop`                         | `__main__ --sim`, tests    |
| Simulator   | `sim.scene.SimScene`                                                                                 | SimPhone, Vision tests     |

### Estimator chain

Specified on `types.Estimator` and implemented once in `pipeline.run_estimators`: one
`Observation` per frame, built by `Observation.empty`, passed through `config.estimators.order`;
each estimator enriches it (overwriting where it is more precise) and returns it, or returns
`None` to add nothing; exceptions are logged and skipped; `provenance` records who set each
field. Estimators that depend on others (iris edge needs a rough eye position) read the fields
earlier estimators filled and do nothing when they are missing. When no earlier estimator found
the eyes, an estimator may locate them itself.

Estimator names (`config.estimators.order`): `arkit`, `landmarks`, `iris_edge`, `reflection`,
`appearance`, `quality`. Model names (`config.models.candidates`): `geometric`, `ridge`,
`kernel`, `reflection`, `blend`, `residual`.

### Where ROIs come from

With `stream.roi_source = "mac"`, Core places two ROIs each frame from the last observation's
iris centres (`roi_width_mm` at the estimated distance, `roi_aspect`), converts them with
`DecodedFrame.rect_to_sensor_normalized`, and sends them with `POST /api/stream/config`
`{"rois": [...]}` when they move by more than 10 % of their size. ROI names are always
`left_eye` and `right_eye` (the person's eyes), whoever places them.

### Simulator in the loop

`python -m phonegaze --sim` starts `SimPhone` on `sim.port` and connects to it. The engine takes
`ScreenInfo` from the simulator's `hello.sim.screen`. During calibration, the Engine forwards
every dot it is told about (`calib.dot` with `state: "collect"`) to the simulator with
`POST /sim/gaze` so the synthetic person looks at it; ground truth arrives in every frame's
`sim` header and the Engine copies it to `Observation.extra["sim"]` so tests can score accuracy.

## Engine HTTP API (server.py ↔ web UI)

Base: `http://127.0.0.1:8765` (`server.host`, `server.port`). JSON bodies, snake_case keys, errors
as `{"error": "text"}` with 4xx/5xx. All coordinates in screen points.

### Static

| Route         | Answer                                                   |
| ------------- | -------------------------------------------------------- |
| `GET /`       | `web/index.html`                                         |
| `GET /<path>` | Any other file in `web/` (only if no API route matches). |

### REST

| Route                          | Body                                                                                                                                  | Answer                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/state`               |                                                                                                                                       | State object (below).                                                                                                                                                                                                                                                                 |
| `GET /api/config`              |                                                                                                                                       | `{"values": Config.to_dict(), "settings": [Setting.to_dict()]}`                                                                                                                                                                                                                       |
| `POST /api/config`             | `{"changes": {"lens.zoom": 2.0, ...}}`                                                                                                | `{"values", "errors": {path: text}}`. Valid changes apply at once and are saved; `restart` settings apply on the next restart.                                                                                                                                                        |
| `POST /api/phone/connect`      | `{"url": "http://…:8080"}` or `{"sim": true}`                                                                                         | State.                                                                                                                                                                                                                                                                                |
| `POST /api/phone/disconnect`   |                                                                                                                                       | State.                                                                                                                                                                                                                                                                                |
| `GET /api/phone/status`        |                                                                                                                                       | The phone's `/api/status`, verbatim.                                                                                                                                                                                                                                                  |
| `POST /api/camera`             | `{"camera_id", "zoom"?, "fps"?, "max_width"?}`                                                                                        | State. Calls `/api/configure`.                                                                                                                                                                                                                                                        |
| `POST /api/zoom`               | `{"zoom"}`                                                                                                                            | State.                                                                                                                                                                                                                                                                                |
| `POST /api/focus`              | `{"x"?, "y"?, "locked"?}` (x, y: 0–1 of the UPRIGHT wide image)                                                                       | State. Core converts to sensor coordinates.                                                                                                                                                                                                                                           |
| `POST /api/aim`                | `{"cameras"?: [id], "zooms"?: [number]}`                                                                                              | `{"started": true}`. Progress arrives as `aim` WebSocket messages; the result is applied when done.                                                                                                                                                                                   |
| `GET /api/preview.jpg`         | query `image=wide` or an ROI name, `overlay=1`                                                                                        | Latest upright image as JPEG, with estimator overlays drawn when `overlay=1`. 503 before the first frame.                                                                                                                                                                             |
| `POST /api/calibration/start`  | `{"kind", "pose_rounds"?}`; kind is `grid`, `pursuit`, `refine` or `validate`; `pose_rounds` (grid) overrides the config for this run | Plan (below).                                                                                                                                                                                                                                                                         |
| `POST /api/calibration/finish` | `{"run_id", "commit"?}`                                                                                                               | `{"run_id", "kind", "reports": [FitReport], "chosen", "validation"?: {model: metrics}, "committed"?}`. With `"commit": false` (grid, pursuit) the run is fitted and reported but the models in use and the saved profile stay as they were (the full calibration's moving-dot phase). |
| `POST /api/calibration/cancel` | `{"run_id"}`                                                                                                                          | `{"ok": true}`                                                                                                                                                                                                                                                                        |
| `POST /api/model`              | `{"pinned": name or ""}`                                                                                                              | State. Pins a model or returns to automatic choice.                                                                                                                                                                                                                                   |
| `POST /api/pause`              | `{"paused": bool}`                                                                                                                    | State.                                                                                                                                                                                                                                                                                |
| `POST /api/record/start`       | `{"label"}`                                                                                                                           | `{"id", "path"}`                                                                                                                                                                                                                                                                      |
| `POST /api/record/stop`        |                                                                                                                                       | Recording summary.                                                                                                                                                                                                                                                                    |
| `GET /api/recordings`          |                                                                                                                                       | `{"recordings": [summary]}`                                                                                                                                                                                                                                                           |
| `POST /api/replay`             | `{"id", "estimators"?: [name], "models"?: [name]}`                                                                                    | `replay.score` result.                                                                                                                                                                                                                                                                |
| `POST /api/lookpoint`          | `{"x", "y", "t"?}`                                                                                                                    | `{"ok": true}`. A known look-point (drift correction).                                                                                                                                                                                                                                |

Calibration plan:

```json
{
  "run_id": "r3",
  "kind": "grid",
  "targets": [{ "dot_id": 0, "x": 121.0, "y": 79.0 }],
  "settle_ms": 600,
  "collect_ms": 900,
  "pose_rounds": 1,
  "screen": { "width": 1512, "height": 982 }
}
```

### State object

```json
{
  "phone": {
    "connected": true,
    "url": "http://10.0.0.5:8080",
    "simulated": false,
    "hello": {},
    "status": {}
  },
  "camera": { "id": "…", "type": "wide", "position": "back", "zoom": 2.0, "rotation": 90 },
  "pipeline": { "running": true, "fps": 29.8, "latency_ms": 41.0, "dropped": 3 },
  "estimators": ["arkit", "landmarks"],
  "calibration": {
    "active_run": null,
    "chosen": "geometric",
    "pinned": "",
    "reports": [],
    "validation": {}
  },
  "screen": {},
  "outputs": { "cursor": false, "dwell_click": false, "websocket_clients": 1 },
  "recording": null,
  "paused": false
}
```

`screen` is `ScreenInfo.to_dict()`; `reports` are `FitReport.to_dict()`; `recording` is `null` or
`{"id", "path", "seconds"}`.

### UI WebSocket: `ws://127.0.0.1:8765/ws`

JSON text messages, each with `"type"`.

Server → UI:

| Type           | Fields                                                                                                                  | When                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `hello`        | `version` (1), `state`                                                                                                  | On connect.                                             |
| `state`        | `state`                                                                                                                 | When anything in it changes (≤ 5 Hz).                   |
| `gaze`         | `GazePoint.to_dict()` plus `raw`: unfiltered `GazePoint` dict or null                                                   | Every frame with a prediction (≤ 60 Hz).                |
| `obs`          | `Observation.to_dict()`                                                                                                 | ≤ 10 Hz.                                                |
| `predictions`  | `{model: GazePoint dict or null}` for every fitted model                                                                | ≤ 10 Hz, after a calibration.                           |
| `frame`        | `seq`, `t`, `fps`, `images`: names available at `/api/preview.jpg`                                                      | ≤ 10 Hz.                                                |
| `calib.report` | the `/api/calibration/finish` answer                                                                                    | After a run is fitted.                                  |
| `aim`          | `phase` ("trying", "done", "failed"), `camera_id`, `zoom`, `quality` (from `measure_quality`), `results`: list of those | During aiming.                                          |
| `hotkey`       | `action`: "recalibrate", "quick_refine", "validate", "pause"                                                            | A global shortcut was pressed; the UI starts that flow. |
| `log`          | `level`, `message`                                                                                                      | Warnings and errors worth showing.                      |

UI → server:

| Type         | Fields                                                                                    | Meaning                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calib.dot`  | `run_id`, `dot_id`, `x`, `y`, `state`: "show", "collect", "done"                          | The UI shows a dot ("show"), the settle time is over and samples should be taken ("collect"), or the dot is finished ("done"). For pursuit, send "collect" with the dot's current position at display rate; `dot_id` changes every 250 ms. |
| `ui.pattern` | `pattern` (string), `on` (bool)                                                           | A screen flash pattern for the reflection estimator started or stopped.                                                                                                                                                                    |
| `ui.screen`  | `screen_x`, `screen_y`, `inner_width`, `inner_height`, `device_pixel_ratio`, `fullscreen` | The browser window's placement, so the engine can check the dots' screen points.                                                                                                                                                           |
| `ping`       | `t`                                                                                       | Answered with `{"type": "pong", "t"}`.                                                                                                                                                                                                     |

**Screen points from the browser.** Calibration and validation pages go fullscreen (Fullscreen
API) on the main display. A dot at CSS position `(cx, cy)` is at screen point
`(window.screenX + cx, window.screenY + cy)`; on macOS CSS pixels equal points at 100 % browser
zoom. The UI uses the engine's `targets` as screen points and converts back to CSS with the same
formula, so the engine stays the source of truth.

## Gaze WebSocket for Forsee: `ws://127.0.0.1:8765/gaze`

On connect the server sends
`{"type": "hello", "version": 1, "screen": ScreenInfo.to_dict()}`, then one message per filtered
sample (at most `outputs.websocket_rate_hz`):

```json
{ "type": "gaze", "x": 812.4, "y": 433.0, "t": 1234.567, "confidence": 0.82, "valid": true }
```

`x`, `y` are screen points; `t` is seconds on the engine's monotonic clock; when `valid` is false
`x`/`y` repeat the last valid point and must be ignored. Clients may send
`{"type": "lookpoint", "x", "y", "t"?}` when the user selects something by dwell (a known
look-point for drift correction). Unknown message types are ignored on both sides.
