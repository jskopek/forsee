# Phone Gaze roadmap: not done yet, or worth improving

Everything here is either unverified on real hardware or not built. Each item says what it is,
why it might help, what it needs, how to tell whether it worked, and its status:

- **idea**: nothing built.
- **partly built**: some pieces exist in the code; named in the item.
- **built, unverified on hardware**: the code exists and passes against the simulator and in CI,
  but has never run on a real iPhone or Mac with a person in front of it.

Nothing in Phone Gaze has run on a real iPhone or Mac yet. One CI job runs the real phone app in
the iOS Simulator with a test-pattern camera against the real engine; that proves the two speak
the same wire protocol, and nothing about real cameras or real eyes. How to try what exists:
[../README.md](../README.md#start-here) and [TUNING.md](TUNING.md).

## 1. Verification on real hardware

The first job. Every number so far comes from a textbook synthetic eye.

| Item                                     | What to do                                                                                                                                                   | Worked if                                                                                                                           | Status                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Phone app 0.2.2 on a phone               | Build with `Local.xcconfig`, run the doctor (`python -m phonegaze doctor --phone URL`).                                                                      | No `FAIL` lines; about 30 fps; few dropped frames.                                                                                  | built, unverified on hardware |
| Each estimator                           | ARKit, MediaPipe landmarks, iris edge fit, screen reflection, distance, quality: the health strip and Tuning page on a real face, front camera then rear 2×. | Health strip Face, Left/Right eye and Iris fit near 100 % looking at the screen; the drawn ellipse on the limbus; reflection found. | built, unverified on hardware |
| Each gaze model                          | Calibrate with 3 head positions, Validate, per model (Dashboard model table).                                                                                | A validated accuracy that stays similar after a 5 cm head move; the engine's own validation agrees with a second, independent one.  | built, unverified on hardware |
| Distance in rear-camera mode             | Compare the Aim page's Distance with a tape measure at 2×; report the `camera ...: the phone's intrinsics` log line.                                         | Within about 10 % of the tape.                                                                                                      | built, unverified on hardware |
| Lens picker                              | **Find the best lens** on the Aim page with the real lenses (wide, ultra wide, telephoto, front).                                                            | It picks the wide camera at 2× at desk distance (what the 0.1 recordings suggested) and the eyes are sharp.                         | built, unverified on hardware |
| System cursor and dwell click            | Accessibility permission, **System cursor** on, `outputs.dwell_click`.                                                                                       | The cursor follows gaze; moving the mouse pauses it; dwell clicks land where you look.                                              | built, unverified on hardware |
| Global shortcuts                         | Input Monitoring permission; Ctrl-Alt-C / R / V / P from another app.                                                                                        | Each starts its run or pauses, from any app.                                                                                        | built, unverified on hardware |
| Forsee link                              | Forsee with `?gaze=phone` against the running engine.                                                                                                        | Keys dwell under your gaze; selections reach the engine (drift card counts them).                                                   | built, unverified on hardware |
| Drift correction from selections         | Type in Forsee for 10 minutes with it off; read **With correction** / **Without** on the Experiments page.                                                   | "With" clearly lower than "without" over the last 50 selections.                                                                    | built, unverified on hardware |
| Second camera with a real MacBook camera | `second_camera.enabled`; compare the solved phone position with a ruler; check the distance ratio. See [SECOND_CAMERA.md](SECOND_CAMERA.md).                 | Position within 2 cm of the ruler; `track_phone` brings Validate back after moving the phone a few centimetres.                     | built, unverified on hardware |
| The lab on real recordings               | `python -m phonegaze lab` on the 0.1 sessions in `tools/eye-capture/captures/`, then on a Phone Gaze recording.                                              | It finds the face in every segment, gives errors in degrees, and its best model agrees with live Validate on the same setup.        | built, unverified on hardware |
| Doctor and diagnostics bundle            | Run both on the real setup; check the bundle's `summary.txt` is enough to diagnose a failure without images.                                                 | A failure can be understood from `summary.txt` alone.                                                                               | built, unverified on hardware |

## 2. Tracker software

### Front camera at full resolution with its depth map, without Apple's face tracking

- **What.** Read the front TrueDepth camera directly (AVFoundation) at its full resolution,
  together with its depth map, and run our own eye finding, instead of going through ARKit.
- **Why.** ARKit's video is lower resolution and its eye transforms are a model of the eye, not a
  measurement; the geometric model amplifies eye-centre error (about 5.6° per millimetre in the
  simulator). Full-resolution front images plus measured depth at the eyes could give both a
  sharp iris and a true distance.
- **Needs.** A TrueDepth `AVCaptureDevice` with `AVCaptureDepthDataOutput` in the app; streaming
  the depth map alongside the frame (the protocol already carries depth in ARKit mode and for
  LiDAR); the engine's `estimators.distance_source` `depth` path.
- **Worked if.** Validate in this mode beats ARKit mode on the same day, and the distance agrees
  with a tape measure to a centimetre.
- **Status: partly built.** Front camera images without ARKit exist (`lens.camera_prefer`
  `front`); depth streams from ARKit's TrueDepth and the rear LiDAR (`stream.depth`); the front
  camera with depth through AVFoundation does not.

### Fit the eyeball centre continuously in the head's frame

- **What.** Keep refining where each eyeball's rotation centre sits in the head's own frame while
  the user looks around, not only during calibration.
- **Why.** A wrong eyeball centre is what makes the geometric model fail after head moves.
- **Needs.** An online estimator (gaze rays from many head poses should meet the targets the
  user selects or fixates); a guard against learning from bad frames.
- **Worked if.** Validate after a 5 cm head move gets closer to Validate before it, over a session.
- **Status: partly built.** `models.eyeball_centre` `per_eye` / `head` learns a fixed per-eye
  centre from calibration (head sweep, several head positions); nothing updates it afterwards.

### Trade resolution for frame rate, and average

- **What.** Stream 4K at 60 or 120 fps, or 1080p at 240 fps, and average several frames per
  output sample.
- **Why.** Averaging N frames cuts random iris-fit noise by about √N at the same latency, and fast
  frames catch saccades sooner.
- **Needs.** The app to pick high-frame-rate formats and keep encoding up (crops only, not the
  whole frame); the engine to keep up (it ran at 17-19 fps against the simulator on 4 Linux
  cores); a filter that averages within a fixation.
- **Worked if.** Precision in Validate improves without worse accuracy or more lag.
- **Status: partly built.** `lens.fps` and `stream.max_fps` go to 120 and the app has
  experimental 60 fps formats (`/api/configure` with `"fps": 60`); 120 and 240 fps, and the
  averaging, are not done.

### Both eyes' agreement as a self-check and for calibration without targets

- **What.** The two eyes look at one point; where their estimates disagree on the screen, one is
  wrong. Use the disagreement live (lower the confidence, drop the worse eye) and as a training
  signal that needs no known targets.
- **Why.** A free accuracy check on every frame, and a way to keep calibrating while the user
  simply uses the computer.
- **Needs.** Per-eye gaze on the screen from every model (the geometric model has it); a model of
  normal vergence at desk distance.
- **Worked if.** Frames with high disagreement have higher error in Validate; a calibration
  refined this way validates better than without.
- **Status: partly built.** Reports already show per-eye held-out scores, and `models.eye` `auto`
  picks one eye when it is clearly better; nothing uses live disagreement.

### Pretrained appearance model

- **What.** A neural network that maps eye images straight to gaze, as an estimator next to the
  geometric ones.
- **Why.** It copes with eyelids, squint and lighting that break edge fitting.
- **Needs.** A licensed pretrained model, its runtime, and calibration on top.
- **Worked if.** It beats the iris-edge path in the lab on real recordings.
- **Status: idea.** `vision/appearance.py` is a deliberate stub.

### Moving-dot calibration

- **What.** Use a smoothly moving dot to collect many calibration points quickly.
- **Why.** More points in less time, and coverage between the grid dots.
- **Needs.** Better lag handling and saccade removal; tests on real eyes, which pursue smoothly in
  a way the simulator only imitates.
- **Worked if.** With `calibration.pursuit_merge` `auto`, the held-out error of the grid dots goes
  down.
- **Status: partly built.** `calibration.moving_dot` and `pursuit_merge` exist (off by default);
  on its own the moving dot is about 10° in the simulator.

### Rear-camera geometric model and head turns

- **What.** Make the rear-camera geometric model survive head turns after a one-position
  calibration.
- **Why.** After one position, a 5 cm, 8° head move costs 1 to 4° in the simulator.
- **Needs.** A better eyeball centre than MediaPipe's eye corners (the continuous fit above, or
  depth); better head pose.
- **Worked if.** The "head moved" column of the accuracy test gets close to the still column.
- **Status: partly built.** Calibrating from 3 head positions already holds up in the simulator
  (0.49°); one position does not.

## 3. Phone sensors

### Both sides of the phone at once: back cameras on the user, front camera on the screen

- **What.** Point the rear cameras at the user and let the front camera see markers on the Mac's
  screen, so the phone knows where the screen is directly, every frame.
- **Why.** The calibration currently has to solve where the screen is relative to the phone (six
  numbers); a bump invalidates it. Seeing the screen removes that unknown, instantly.
- **Needs.** iOS multi-camera capture (`AVCaptureMultiCamSession`, front and back together on
  supported phones); markers drawn by the engine's pages; a pose solve from them; the screen pose
  fed to the geometric model (the second camera's `screen_pose` `fixed` path is the template).
- **Worked if.** After moving the phone, Validate stays put without recalibrating; fewer dots are
  needed for a calibration.
- **Status: idea.** The second camera (Mac webcam) solves the same problem the other way round.

### A one-time depth measurement of iris size and eye spacing

- **What.** Measure the user's true iris diameter and eye spacing once with a depth sensor
  (TrueDepth), then use them for distance from one ordinary camera afterwards.
- **Why.** Distance from iris size assumes 11.7 mm; adults range 11-12.5 mm, which is about ±7 %
  of distance, and distance scales everything else.
- **Needs.** A short measurement step in ARKit mode; storing the values in the profile and
  setting `estimators.iris_diameter_mm` from them.
- **Worked if.** Rear-camera distance agrees with a tape measure within a few percent.
- **Status: idea.** `estimators.iris_diameter_mm` can be set by hand.

## 4. Cheap hardware

### A reading-glasses lens over the telephoto

- **What.** Put a +1.5 dioptre reading-glasses lens over the telephoto.
- **Why.** On the owner's phone the telephoto focuses no closer than 135 cm, so it is blurry at
  desk distance. A +1.5 lens moves its focus range to roughly 45-67 cm, giving the most pixels per
  eye of any camera.
- **Needs.** A cheap lens and a clip; the Aim page to check sharpness; possibly a fixed distance or
  corrected intrinsics, since the lens changes the focal length the phone reports.
- **Worked if.** The Aim page shows a sharp iris on the telephoto at 50-60 cm, and Validate beats
  the wide camera at 2×.
- **Status: idea.**

### A small infrared LED as an invisible reflection

- **What.** A small infrared LED near the screen, making a reflection on the cornea the user
  cannot see (the classic tracker glint).
- **Why.** A point reflection is easier to find than the screen's reflection, and it does not
  depend on what is on the screen or its brightness.
- **Needs.** First check whether each phone camera sees infrared: point a TV remote at it and
  press a button (a camera that sees infrared shows the remote's LED flashing). Then an LED,
  a resistor and USB power; the reflection estimator tuned for a small spot.
- **Worked if.** The Tuning page's reflection rate stays high with a dark screen.
- **Status: idea.**

### Polarising film

- **What.** Polarising film over the lens (and the screen's own polarisation) to strengthen or
  remove the screen's reflection on the eye.
- **Why.** Stronger when the reflection is used; removed when it hides the iris edge.
- **Needs.** A sheet of film; trying both orientations on the Tuning page.
- **Worked if.** Reflection score or iris fit confidence improves.
- **Status: idea.**

## 5. Calibration

### Colour-coded screen corners or edges

- **What.** Colour each corner or edge of the screen differently, so the reflection in the eye is
  a small, readable picture of the screen; map gaze with the cross-ratio of the four corners'
  reflections.
- **Why.** Cross-ratio mapping is largely independent of head position, and colour identifies
  each corner in a single frame.
- **Needs.** Coloured markers on the engine's pages; a reflection finder that finds four coloured
  spots; a cross-ratio model.
- **Worked if.** Validate after a head move matches Validate before it.
- **Status: partly built.** `ui.glint_marker` `corners` draws white corner squares to enlarge the
  reflection; no colour coding, no cross-ratio model.

### An imperceptible flickering border filmed at 120 fps

- **What.** Flicker a border too fast to notice and film at 120 fps, so the screen's reflection
  can be told apart from other highlights in every frame.
- **Why.** Continuous, certain identification of the reflection, without visible blinking.
- **Needs.** A display that refreshes fast enough (ProMotion Macs run at 120 Hz); 120 fps capture;
  a lock-in decoder in the reflection estimator.
- **Worked if.** Reflection found in nearly every frame with no false highlights, and no one can
  see the flicker.
- **Status: partly built.** Coded flashes exist (`ui.glint_blink`, calibration's **Flash the
  screen**, `estimators.reflection_coded_flash`), but they are visible and occasional.

## 6. Keyboard and Forsee integration

| Item                                     | Why                                                                                              | Needs                                                                                       | Worked if                                          | Status                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| "Look away first" after Resume           | After Resume, the key under your eyes starts dwelling at once and can type (docs/MVP_STATUS.md). | A short rule in the gaze engine: no dwell until gaze has left that spot once.               | No accidental keystroke after Resume.              | idea                                           |
| A gaze-only way to turn speech on        | Browsers allow speech only after a click, tap or key press; a dwell is not one.                  | A native host (Mac app) or a real click from the Phone Gaze cursor (`outputs.dwell_click`). | A user with eyes only can hear the first sentence. | idea                                           |
| Sentence-level prediction                | Fewer selections per message; docs/V1_PLAN.md keeps sentence-level replies for v2.               | An on-device language model behind the host bridge.                                         | Words per minute up in a timed test.               | idea (v2 in the plan)                          |
| The coarse layout for imprecise trackers | Large targets for a tracker that is several degrees off.                                         | Matching key size to Phone Gaze's measured accuracy.                                        | Fewer deletions with an imprecise tracker.         | partly built (large-key two-step groups exist) |
| Drift correction from selections         | Keeps accuracy over a session without recalibrating.                                             | Real use (section 1).                                                                       | "With" beats "without".                            | built, unverified on hardware                  |
| Dwell tuned from measured accuracy       | Dwell radius and time could follow the tracker's own precision and confidence.                   | Forsee reading the confidence Phone Gaze already sends.                                     | Fewer misfires at the same speed.                  | idea                                           |

## 7. Other platforms

### A native Mac app with a click-through overlay

- **What.** A small Mac app that shows calibration dots and the gaze marker in a transparent,
  click-through window above everything, and runs the engine.
- **Why.** Calibration today needs a full-screen browser window on the main display; an overlay
  works over any app and can also turn speech on without a browser click.
- **Needs.** A Swift app bundling or launching the engine. macOS has no system-wide input route
  for a dedicated gaze device, so the WebSocket feed (`ws://127.0.0.1:8765/gaze`) and the cursor
  remain the direct routes into apps.
- **Worked if.** Calibrate and use Forsee without a browser window in front.
- **Status: idea.**

### Vision Pro as a separate input route

- **What.** Use Vision Pro's own eye tracking for Forsee, not Phone Gaze.
- **Why.** The owner tested Forsee in Safari on Vision Pro: system dwell at 0.3 s works well and is
  accurate. But no hover reaches the page (the page only gets the tap), speech fails there, and a
  Mac app shown in the headset receives no gaze. So the headset is a selection device, not a gaze
  source.
- **Needs.** Forsee's tap-only mode with system dwell; large targets; a companion device (phone or
  Mac) to speak. See [reports/Vision Pro exploration.md](../../../reports/Vision%20Pro%20exploration.md).
- **Worked if.** A full message typed and spoken with eyes only.
- **Status: idea** (for Forsee; nothing to do in Phone Gaze).
