# Tuning Phone Gaze: a playbook

What to change when it does not work, and how to tell whether the change helped. Every setting
named here (`section.name`) is on the **Experiments** page (search box at the top), with its
description, its default and a reset button, and can be saved in a preset. Changes apply at once
unless the page says a restart is needed.

**Status:** none of this has been tuned on real eyes. The thresholds come from the simulator and
from reading. The iPhone app has run in the iOS Simulator (synthetic test-pattern camera) against
the engine in CI, which proves the wire protocol and nothing about real cameras or eyes. It has
never run on a phone. Expect to move things.

**Before tuning by hand**, record a collection run (Collect tab: the same short protocol once per
camera setup) and let the sweep search the settings offline; see
[README: Collect data, then let the machine search](../README.md#collect-data-then-let-the-machine-search).
Only run against the simulator so far.

The pages: **Dashboard** (Calibrate, Quick refine, Validate, the model table), **Aim** (camera,
zoom, focus, distance), **Tuning** (both eye crops large with the iris fit, edge points,
reflection, corners and lid mask drawn on, live numbers, **Freeze frame**), **Live**,
**Experiments** (every setting, presets, the drift correction card), **Recordings**, **Second
camera**, and the **Diagnostics** and **Lab** pages linked from the Dashboard.

## The first real day, in order

1. **Doctor first.** With the phone app open on the same Wi-Fi:

   ```sh
   cd sidecars/phone-gaze/engine
   .venv/bin/python -m phonegaze doctor --phone http://<phone-ip>:8080
   ```

   Each line is `OK`, `WARN`, `FAIL`, `info` or `skip`, with a fix under every `WARN` and `FAIL`:
   Python and packages, the face model, Accessibility and Input Monitoring, the screen size,
   whether the phone answers (and Local Network), the app version and protocol, the clock, frame
   rate, dropped frames and latency; then each vision stage on a few seconds of live frames
   (face, eyes, iris fit, reflection, distance). Fix the `FAIL` lines before anything else. With
   the engine running, the **Diagnostics** page does the same with **Run the checks** and shows
   the live health strip (Face, ARKit tracked, Left eye, Right eye, Iris fit, Reflection,
   Distance, Usable, Eyes open, each as a percentage of recent frames). The first frames can take
   30 s while MediaPipe loads.

2. **Front camera, safe.** Apply the preset **front camera, safe** (Experiments page, Presets):
   ARKit finds the face and eyes, so fewer things can go wrong. Calibrate with **Head positions**
   3, then **Validate**, and write the number down.

3. **Rear camera at 2×.** Apply **rear 2x, reflection**, turn the phone round, **Find the best
   lens** and **Lock focus** on the Aim page, check the Aim page's **Distance** against a tape
   measure, calibrate with 3 head positions and **Flash the screen for 3 s first**, Validate.
   Then **rear 2x, geometric** for comparison. Same validation, same chair.

4. **The lab on recordings you already have.** It replays a recorded session (an eye-capture
   session from `tools/eye-capture/captures/`, or a Phone Gaze recording) through the estimators
   and models with no phone involved:

   ```sh
   .venv/bin/python -m phonegaze lab ../../../tools/eye-capture/captures/<session>
   ```

   It writes `report.html` in `~/.phonegaze/lab/<session>/`, with held-out error per camera,
   estimator combination and model, a failure count and an error-by-screen-position chart. The
   **Lab** page runs the same (**Run the lab**). Its findings say which camera and model to start
   live with. The lab has only seen synthetic sessions so far.

5. **One change at a time** (next section). The first ones worth trying, in this order:
   **Show poor dots again once (quality gate)** in the calibration panel; **Head sweep** 1 with
   `models.eyeball_centre` `per_eye` or `auto`; `filters.preset`; `calibration.error_map`
   `affine` with a validation afterwards.

6. **When something looks wrong, write a bundle.** `.venv/bin/python -m phonegaze bundle` (or
   **Write bundle** on the Diagnostics page) puts `summary.txt`, the settings, the log and the
   last seconds of numbers in `~/.phonegaze/diagnostics/<time>/`. Images only if you tick
   **Include images from the camera** (or pass `--images`). The log is always at
   `~/.phonegaze/logs/phonegaze.log`.

## Symptom to setting

**Validate** (Dashboard) shows fresh dots and gives accuracy in degrees and precision (scatter);
it is the number to compare. "Watch" says which other number shows whether the change helped.

| Symptom                                | Try, in this order                                                                                                                                                                                                                                                                                                                                                       | Watch                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Pointer is offset everywhere           | **Quick refine** (Dashboard; `calibration.refine_points` 1 = offset only, 3-5 re-solves the screen position). Check the screen size on the Diagnostics page matches the real screen. `calibration.drift_correction` on so dwell selections in Forsee pull it back. `calibration.error_map` `affine` (learned from validation dots, kept only if held-out says it helps). | Validate accuracy; the drift card's **With correction** / **Without** numbers                    |
| Fine in the middle, wrong at the edges | `calibration.layout` `edges` (extra dots along the edges) or `calibration.grid` `4x4`. `calibration.margin` smaller so dots reach further out. After a validation, **Touch up the worst N** (`calibration.touchup_dots`), then `calibration.error_map` `quadratic` or `tps`.                                                                                             | Error by dot and by screen region in the validation report (the edge dots)                       |
| Drifts when I move my head             | **Head positions** 2-3. **Head sweep** 1 with `models.eyeball_centre` `per_eye` (or `auto`). Pin `geometric` or `reflection` in the Dashboard's model table (`models.pinned`): ridge and kernel cannot extrapolate to a new head position. `estimators.head_smoothing_s` 0.1-0.3 if the head pose jitters.                                                               | Validate, move your head 5 cm, Validate again: the gap between the two                           |
| Jittery                                | `filters.preset` `steady`, then `filters.fixation_lock` on (holds the pointer still while you fixate). `estimators.iris_fit` `circle` if the ellipse flickers. `lens.max_exposure_ms` 8-16 against motion blur; `lens.exposure_bias` up in dim light.                                                                                                                    | Precision in the Validate report; Tuning page **Fit rms (px)**                                   |
| Laggy                                  | `filters.preset` `responsive`. `filters.fixation_lock` off. `estimators.landmarks_every` 2 if frames are slow. A lower `lens.max_width` or `stream.wide_width` if the stage times on Diagnostics are high.                                                                                                                                                               | **Time per stage** on Diagnostics; fps on the Dashboard                                          |
| Iris ellipse sits on the eyelid        | `estimators.iris_lid_mask_upper_deg` 45 (and `iris_lid_mask_lower_deg` 30). `estimators.iris_edge_keep` up (0.5). `estimators.iris_fit` `circle`. More light, or `lens.exposure_bias` +0.3 to +1.                                                                                                                                                                        | Tuning page: the drawn ellipse on the iris edge; **Fit confidence** up; **Minor / major** near 1 |
| No reflection found                    | Screen brightness to full (in the simulator this took the reflection from 0 % to 94 % of frames). `ui.glint_marker` `border` (or `corners`) and `ui.glint_blink` on. Tick **Flash the screen for 3 s first** when calibrating. Then `estimators.reflection_k_mad` down (4); `estimators.reflection_area_max` up for a big display. Rear camera at 2× for larger irises.  | Tuning page **Reflection L / R** and **Reflection score**; Reflection on the health strip        |
| Distance looks wrong                   | `estimators.distance_source`: `iris`, `head`, `depth` (with `stream.depth` on), or `fixed` with `estimators.fixed_distance_m` from a tape measure. `estimators.iris_diameter_mm` (11.7 default; adults 11-12.5). In rear-camera mode, report the log line `camera ...: the phone's intrinsics ...` (the zoom question).                                                  | Aim page **Distance** and Tuning page **Distance from**, against a tape measure                  |
| Eyes lost when I turn                  | `estimators.face_confidence` down (0.2), `estimators.face_attempts` up (5), `estimators.face_tiles` on. `lens.zoom` lower, or the preset **rear 1x, wide head box**. `stream.roi_width_mm` up (larger eye crops). `lens.zoom_lost_s` shorter so auto zoom backs out sooner. `second_camera.wide_head_box` (experiment).                                                  | Health strip Face, Left eye and Right eye percentages                                            |
| Phone got bumped                       | **Quick refine** with `calibration.refine_points` 3-5 (re-solves where the screen is). A full calibration if that does not bring Validate back. With the second camera on: `second_camera.track_phone`, and **Re-anchor now** on the Second camera page.                                                                                                                 | Validate before and after; Second camera page **Where the phone is**                             |
| Nothing calibrated yet, need motion    | `outputs.fallback_pointer` `uncalibrated` (rough pointer from eye direction, no calibration). `outputs.fallback_flip_x` / `fallback_flip_y` if it moves the wrong way.                                                                                                                                                                                                   | Whether the pointer follows your eyes at all                                                     |

Other switches for experiments: one per estimator (`estimators.use_arkit`, `use_landmarks`,
`use_iris_edge`, `use_reflection`, `use_quality`); `models.eye` (`left`, `right` or `auto` when
one eye tracks badly; reports show per-eye held-out scores either way); `models.candidates` (add
`hybrid`, the reflection/geometric blend, or `residual`); `calibration.sample_weighting`;
`calibration.dot_order` `random`; `calibration.discard_ms`; `calibration.stability_deg`;
`calibration.moving_dot` with `calibration.pursuit_merge` `auto`; `stream.roi_source` (`arkit`
or `vision` places the eye crops on the phone); and the camera locks `lens.focus_locked`,
`lens.exposure_locked`, `lens.white_balance_locked`, `lens.face_driven_autofocus`,
`lens.focus_on_eye`.

## Comparing two setups fairly

Change one thing at a time, and compare on the same data where you can.

1. **Validate live.** Calibrate, then **Validate** (fresh dots the model never saw). Run each
   setup twice; differences under about 0.3° are usually noise. Save each setup as a preset
   (**Save current settings as preset** on the Experiments page) so you can switch back; the
   page keeps each preset's validation results side by side.
2. **Lab A/B on a recording.** Record once (Recordings page, **Start recording**: a calibration,
   a validation, a minute of looking around; or an eye-capture session), then compare on exactly
   the same frames:

   ```sh
   .venv/bin/python -m phonegaze ab SESSION --a base --b "models.eyeball_centre=per_eye"
   .venv/bin/python -m phonegaze tune SESSION --group filters     # also regularisation, crop, estimators, cleaning, eye, models
   .venv/bin/python -m phonegaze tune SESSION --auto estimators. --save my-best
   ```

   `--a` and `--b` take `base` (the current settings), a preset name or `.json` file, or
   `path=value;path=value`. `ab` scores both with held-out dots and prints a 95 % interval for the
   difference and a p-value: if the interval spans zero, there is no real difference. `tune`
   picks settings on some dots and scores them on others (nested hold-out), so its numbers are not
   flattered by the search. `--save` writes the winner to `~/.phonegaze/lab/presets/`; on the
   **Lab** page, **Presets from tune** has **Apply now** and **Add to Experiments** for it.

3. **Drift side by side.** With `calibration.drift_correction` off, the engine still learns the
   drift offset from your Forsee selections and scores it: the **Drift correction from
   selections** card on the Experiments page shows the median and mean error **With correction**
   and **Without**, for this session and the last 50 selections. Turn it on only if "with" is
   clearly lower. Offline: `.venv/bin/python -m phonegaze.replay score <recording>`.

## Presets

Built in (Experiments page, Presets). These replace every experiment setting, so they start
from the defaults plus their own changes:

| Preset                     | What it sets                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **front camera, safe**     | Front TrueDepth with ARKit, no auto zoom, no reflection, geometric/ridge/kernel/blend models, `filters.preset` `balanced`, 3 head positions.    |
| **rear 2x, reflection**    | Rear wide camera, shutter capped at 16 ms, reflection and hybrid models added, 3 head positions, white border on the pages (`ui.glint_marker`). |
| **rear 2x, geometric**     | Rear wide camera without the reflection, upper eyelid masked (45°), `models.eyeball_centre` `per_eye`, 3 head positions.                        |
| **rear 1x, wide head box** | Rear wide camera at 1× without zooming, larger eye crops (40 mm) and whole frame (960 px), more face search attempts, no reflection.            |

Your own: **Save current settings as preset**, with **Export** and import of a preset file.
`filters.preset` (`responsive`, `balanced`, `steady`) is a separate, smaller preset for the
smoothing filter only. Presets never change the server, phone address, recording, shortcuts,
diagnostics, lab settings or the phone-specific camera id. User presets live in
`~/.phonegaze/presets.json`; presets from `tune` in `~/.phonegaze/lab/presets/`.

## Where things are

- Settings: `engine/phonegaze/config.py`. Presets: `presets.py`.
- Diagnostics page, `doctor` and `bundle`: `doctor.py`, `diagnostics.py`.
- Lab, tune, A/B: `lab.py`, `tune.py`, page `web/lab.html`.
- Unattended sweep of recorded setups and "why is the error what it is": [SWEEP.md](SWEEP.md).
- Tuning page: `tuning.py`, `web/js/tuning.js`.
- Calibration options (head sweep, quality gate, moving-dot merge, error map, touch-up):
  `calibration.py`; models in `models/`.
- Ideas not built yet: [ROADMAP.md](ROADMAP.md).
