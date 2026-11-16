# Interface changes

Additions to `INTERFACES.md` and `phonegaze/types.py`, one line each, newest last. Nothing here
removes or renames anything.

- Core (2026-11-16): no change to `types.py`. Additions to the engine API, all optional for
  clients:
  - `/gaze` samples also carry `nx`, `ny` (0–1 of the screen), `latency_ms` (capture to send,
    once the phone clock is synced) and `fixation` (when the filter reports one).
  - The UI `predictions` message carries the per-model dicts both at the top level (as
    documented) and under a `predictions` key.
  - The state object adds `phone.state` (`connecting`, `connected`, `disconnected`),
    `phone.detail`, `phone.replay`, `phone.clock_offset`, `phone.clock_round_trip_ms`,
    `camera.width`, `camera.height`, `camera.mode`, `pipeline.stream_fps`,
    `pipeline.dropped_engine`, `pipeline.dropped_phone`, `pipeline.processed`,
    `pipeline.timings_ms` (per stage and per estimator), `calibration.active` (the model in
    use), `calibration.models`, `outputs.cursor_status`, `outputs.dwell_status`,
    `outputs.hotkeys`, `hints` (plain-language aiming advice), `quality` (latest
    `measure_quality` result) and `aim` (last aiming search).
  - `POST /api/phone/connect` also accepts `{"sim": true, "camera": "arkit"}` and
    `{"replay": "<recording id>"}`.
  - The finish answer of `/api/calibration/finish` adds `n_samples`.
  - Errors: 400 bad input, 404 unknown route, 409 not recording, 501 a part not implemented
    yet, 502 the phone refused or did not answer, 503 nothing to show yet.
  - Estimators may define `set_pattern(pattern, on, t_local)`; the Engine calls it for every
    `ui.pattern` message.
- Models (2026-11-16): no change to `types.py`. Optional additions, all with defaults:
  - `calibration.CalibrationRun.begin_dot(..., pose_group=None)`: Core may pass the UI's
    `pose_group`; without it a grid dot shown again starts the next pose round. The run also
    exposes `dots` and `rejected` (per-dot sample counts and rejection reasons).
  - `calibration.config_targets(..., seed=0)` (vary the seed for fresh validation dots);
    `angular_error_deg(..., distance_m=None)`; `Profile.save(..., camera=None)`;
    `Profile(None)` uses `~/.phonegaze/profiles/default`.
  - `filters.build_filter(config, screen=None)` and `SmoothingFilter.set_screen(screen)`:
    without a screen, degrees use `filters.points_per_degree`.
  - `FitReport.train_error_*` and `loo_error_*` are the error of each dot's mean prediction;
    `params["loo_sample_error_deg"]` is the per-sample mean, `params["loo_coverage"]` the
    fraction predicted (below 0.7 a model is never chosen automatically).
  - Settings: `models.auto_alpha`, `models.kappa_prior_sd_deg`, `models.smooth_centre_s`,
    `filters.saccade_deg`, `filters.fixation_tau_ms`, `filters.points_per_degree`.
- Simulator (2026-11-16): no change to `types.py`. Additions, all optional for clients:
  - The frame `sim` block also carries `t`, `target`, `blinkAmount`, `headPosition`,
    `distance`, `rotation` (the orientation the sim rendered with), `imageZoom`, `screenLevel`,
    `screenCorners` (camera coordinates), `left/rightOpticalDir`, `left/rightCorneaCenter`, and
    `eyes.left|right` with exact pixel truth (upright full-frame pixels): `irisCenter`,
    `irisEllipse`, `irisRadius`, `pupilCenter`, `pupilEllipse`, `eyeballCenter`,
    `corneaCenter`, `reflectionCenter`, `reflectionCorners`, `reflectionVisible`,
    `innerCorner`, `outerCorner`, `upperLid`, `lowerLid`, `openness`.
  - `POST /sim/gaze` accepts `"instant": true`. New simulator routes: `POST /sim/head`,
    `POST /sim/camera`, `GET|POST /sim/noise`, `POST /sim/flash`, `GET /sim/scene`;
    `/sim/script` names are `still`, `drift`, `sway`, `move`, `look_around`, `blink`.
  - `sim` config section gains `orientation`, `script`, `human_look`, `render_workers`, `noise`.
- Integration (2026-11-16): no change to `types.py`.
  - The Engine passes the screen to `filters.build_filter(config, screen=)` and calls
    `filter.set_screen` whenever the screen changes; it passes the UI's `pose_group` to
    `CalibrationRun.begin_dot`; frames whose `camera.zoomStable` is false are not added to a
    calibration run.
  - With the simulator, the Engine forwards `ui.pattern` to `POST /sim/flash` and, for each new
    `pose_group` of a grid calibration, moves the simulated head with `POST /sim/head` (back to
    where it was when the run ends).
  - `lens.pick_cameras` skips cameras with `depthSource: "lidar"` (the wide camera again).
  - `iris_edge` rescales the landmarks estimator's eyeball centres and head position to its own,
    more precise distance.
  - `BlendModel` leaves out, per frame, members further than 8 % of the screen diagonal from the
    members' weighted median (three or more members).
