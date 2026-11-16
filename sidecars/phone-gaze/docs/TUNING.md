# Tuning Phone Gaze: a playbook

This is the short version of "what do I change when it does not work". Every switch named here is
on the **Experiments** page (search box at the top), with a description and a reset button, and
can be saved as a preset.

**Status:** none of this has been tuned on real eyes. The thresholds come from the simulator and
from reading. The iPhone app has run in the iOS Simulator (synthetic test-pattern camera) against
the engine in CI. It has never run on a phone. Expect to move things.

## The first real day, in order

1. **Doctor first.** With the phone app open on the same Wi-Fi:

   ```sh
   cd sidecars/phone-gaze/engine
   .venv/bin/python -m phonegaze doctor --phone http://<phone-ip>:8080
   ```

   It checks Python and packages, the face model, Accessibility and Input Monitoring, the screen
   size, whether the phone can be reached (and the Local Network permission), the app version and
   protocol, the clock, frame rate, dropped frames and latency. Then it watches a few seconds of
   frames and reports each stage: face, eyes, iris fit, reflection, distance. Each item comes
   with ok/warn/fail and a fix. Fix the **fail** lines before anything else. When the engine is
   already running, the **Diagnostics** page (link on the Dashboard) does the same with
   **Run the checks** and shows the live health strip.

   The first frames can take 30 s while MediaPipe loads on a fresh Mac. The engine no longer
   restarts the camera during that wait.

2. **The lab, on recordings you already have.** It replays a recorded session through the
   estimators and models with no phone involved, so you can compare settings on the same data:

   ```sh
   .venv/bin/python -m phonegaze lab ~/path/to/eye-capture-session
   ```

   It writes `report.html` in `~/.phonegaze/lab/`, with held-out error per camera, estimator
   combination and model, a failure count, and an error-by-position chart. The **Lab** page
   (`lab.html`, linked from the Dashboard and Diagnostics) runs the same and has **Apply now**
   and **Add to Experiments** buttons for what it finds. Doing this first tells you which camera
   and model to start live with, before any calibration.

3. **Front camera before rear.** Start with `lens.camera_prefer = arkit` (preset
   "front camera, safe"): ARKit finds the face and eyes for you, so fewer things can go wrong.
   Calibrate, **Validate**, and note the number. Then try the rear camera
   (presets "rear 2x, reflection" / "rear 2x, geometric") and compare the two with the same
   validation.

4. **Calibrate from more than one head position.** **Head positions: 2 or 3** in the calibration
   panel is the best-tested improvement (README accuracy table). Then try one change at a time
   (next section). The first one worth trying: **Head sweep: 1 dot** (`calibration.head_sweep`)
   with `models.eyeball_centre = per_eye` or `auto`. **Show poor dots again once**
   (`calibration.quality_gate`) is off by default and worth turning on.

5. **When something looks wrong, write a bundle.** `python -m phonegaze bundle` (or **Write
   bundle** on the Diagnostics page) puts a summary, settings, log and the last seconds of
   numbers in `~/.phonegaze/diagnostics/<time>/`. Images only if you tick them. The log is
   always at `~/.phonegaze/logs/phonegaze.log`.

## Symptom to lever

"Watch" says which number shows whether the change helped. **Validate** runs fresh dots and
gives accuracy in degrees. The **Tuning** tab (between Aim and Live) shows both eye crops large
with the iris fit, edge points, reflection, corners and lid mask drawn on, plus live numbers and
**Freeze frame**.

| Symptom                                    | Try, in this order                                                                                                                                                                                                                                                                                                                         | Watch                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Pointer is offset everywhere               | **Refine** (a few dots). Then `calibration.drift_correction` on, so dwell selections in Forsee pull it back. `calibration.error_map = affine` (learned from validation dots, kept only if held-out says it helps). Check that the screen size on Diagnostics matches the real screen.                                                      | Validation accuracy; the drift card's "with / without" numbers                              |
| Fine in the middle, wrong at the edges     | `calibration.layout = edges` (extra dots on the edges) or `grid = 4x4`. `calibration.margin` smaller so dots reach further out. After validating, **Touch up the worst N** (`calibration.touchup_dots`), and `calibration.error_map = quadratic` or `tps`.                                                                                 | Per-dot error map in the validation report (edge dots)                                      |
| Drifts when I move my head                 | Calibrate from **2–3 head positions**. **Head sweep** (`calibration.head_sweep = 1`) with `models.eyeball_centre = per_eye` (or `auto`). Prefer `geometric` or `reflection` over `ridge`/`kernel` (`models.pinned`): regressions cannot extrapolate to new head positions. `estimators.head_smoothing_s = 0.1–0.3` if head pose jitters.   | Validate, move your head 5 cm, validate again: the gap between the two                      |
| Jittery                                    | `filters.preset = steady`, then `filters.fixation_lock` on (holds the pointer still while you fixate). `estimators.iris_fit = circle` if the ellipse flickers. `lens.max_exposure_ms = 8–16` against motion blur; `lens.exposure_bias` up in dim light.                                                                                    | "Precision" in the calibration report; Tuning page "Fit rms (px)"                           |
| Laggy                                      | `filters.preset = responsive`. `filters.fixation_lock` off. `estimators.landmarks_every = 2` if frames are slow. A lower `lens.max_width` if encode or estimator times are high on Diagnostics.                                                                                                                                            | Health strip and per-stage timings on Diagnostics; fps on the Dashboard                     |
| Iris ellipse is on the eyelid              | `estimators.iris_lid_mask_upper_deg = 45` (and `_lower_deg = 30`). `estimators.iris_edge_keep` up (0.5). `estimators.iris_fit = circle`. More light, or `lens.exposure_bias` +0.3 to +1.                                                                                                                                                   | Tuning page: overlay on the limbus; "Fit confidence" up, "Minor / major" near 1 straight on |
| No reflection found                        | Screen brightness to full (in the simulator this took the reflection from 0 % to 94 % of frames). `ui.glint_marker = border` (or `corners`) and `ui.glint_blink` on. Calibration's "Flash the screen" box. Then `estimators.reflection_k_mad` down (4), `reflection_area_max` up for a big display. Rear camera at 2× gives larger irises. | Tuning page "Reflection L / R" rate and "Reflection score"; reflection model in reports     |
| Distance looks wrong                       | `estimators.distance_source`: try `iris`, `head`, `depth` (with `stream.depth` on) or `fixed` with `fixed_distance_m` measured with a tape. `estimators.iris_diameter_mm` (11.7 default; adults 11–12.5).                                                                                                                                  | Tuning page "Distance from" and the distance shown, against a tape measure                  |
| Eyes lost when I turn                      | `estimators.face_confidence` down (0.2), `face_attempts` up (5), `face_tiles` on. `lens.zoom` lower or the "rear 1x, wide head box" preset. `stream.roi_width_mm` up (larger eye crops). `lens.zoom_lost_s` shorter so auto zoom backs out sooner.                                                                                         | Health strip "Face" and "Eyes" percentages                                                  |
| Nothing calibrated yet, need to see motion | `outputs.fallback_pointer = uncalibrated` (rough pointer from eye direction, no calibration). `fallback_flip_x` / `fallback_flip_y` if it moves the wrong way.                                                                                                                                                                             | Whether the pointer follows your eyes at all                                                |

Other switches for experiments: one per estimator (`estimators.use_arkit`, `use_landmarks`,
`use_iris_edge`, `use_reflection`), `models.eye` (`left`, `right` or `auto` when one eye tracks
badly; reports show per-eye held-out scores either way), `models.candidates` (add `hybrid`, the
reflection/geometric blend), `calibration.sample_weighting`, `calibration.dot_order = random`,
`calibration.discard_ms`, `calibration.stability_deg`, `calibration.pursuit_merge = auto` (with
the moving dot on), and the camera locks `lens.focus_locked`, `exposure_locked`,
`white_balance_locked`, `face_driven_autofocus`, `focus_on_eye`.

## Comparing two setups fairly

Change one thing at a time, and compare on the same data where you can.

1. **Validate live.** Calibrate, then **Validate** (fresh dots the model never saw). The headline
   accuracy is the number to compare. Run each setup twice; differences under about 0.3° are
   usually noise. Save each setup as a preset (Experiments → Presets) so you can switch back.
2. **Lab A/B on a recording.** Record a session (Recordings page → Start, or the eye-capture app),
   then:

   ```sh
   .venv/bin/python -m phonegaze ab SESSION --a base --b "models.eyeball_centre=per_eye"
   .venv/bin/python -m phonegaze tune SESSION --group filters     # or regularisation, crop, eye, models
   .venv/bin/python -m phonegaze tune SESSION --auto estimators. --save my-best
   ```

   `ab` scores both on the same frames with held-out dots and prints a 95 % interval for the
   difference and a p-value: if the interval spans zero, there is no real difference. `tune`
   picks settings on some dots and scores them on others (nested hold-out), so its numbers are
   not flattered by the search. `--save` writes a preset you can load in the engine.

3. **Drift side-by-side.** With `calibration.drift_correction` off, the engine still learns the
   drift offset from your selections and scores it: the Experiments page's drift card shows the
   median error with and without the correction for this session and the last 50 selections.
   Turn it on only if "with" is clearly lower.

## Where things are

- Settings and presets: Experiments page; presets in `~/.phonegaze/presets.json`.
- Diagnostics page and `doctor` / `bundle`: `engine/phonegaze/doctor.py`, `diagnostics.py`.
- Lab, tune, A/B: `engine/phonegaze/lab.py`, `tune.py`, page `lab.html`.
- Tuning page: `engine/phonegaze/tuning.py`, `web/js/tuning.js`.
- Calibration options: `engine/phonegaze/calibration.py` (head sweep, quality gate, moving-dot
  merge, error map, touch-up); models in `engine/phonegaze/models/`.
