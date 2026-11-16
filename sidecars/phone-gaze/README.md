# Phone Gaze

An eye tracker made from an iPhone and a Mac. The phone is a remote-controlled camera; the Mac
finds your eyes, learns where you look during a short calibration, and turns gaze into a cursor,
a dwell click, and a WebSocket stream the Forsee keyboard can use.

How it is built: [ARCHITECTURE.md](ARCHITECTURE.md). Wire format: [docs/PROTOCOL.md](docs/PROTOCOL.md).
Engine API: [docs/INTERFACES.md](docs/INTERFACES.md).

## Status: read this first

Nothing here has run on a real iPhone or a real Mac with a person in front of it. What has been
checked, and how:

| Part                                                     | Checked how                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| iPhone app 0.2.1 (live stream, zoom, lens, ARKit)        | Compiles in CI (macOS runner, signing off). Never run on a phone.                                                              |
| Engine (Python): phone client, pipeline, models, UI, API | Unit tests on Linux and macOS CI; end to end against the simulated phone (below).                                              |
| Simulated phone                                          | Speaks the same protocol as the app; exact synthetic eyes, ARKit transforms and screen reflections.                            |
| Browser UI                                               | Driven in headless Chromium against the engine and simulator: connect, aim, calibrate, validate, refine, live, record.         |
| Mac outputs (cursor, hotkeys, screen size)               | CI on a macOS runner imports them, reads the screen size from macOS and runs the engine for a few seconds. Cursor never moved. |
| Forsee gaze source (`?gaze=phone`)                       | Unit tests against a fake server. Never connected to the real engine.                                                          |
| Drift correction from selections (experiment, off)       | Unit tests, a simulated drifting phone (Models simulator), API tests with fake clients. Never with a real phone or person.     |

Accuracy against the simulator, measured by
[`engine/tests/ui/accuracy_e2e.cjs`](engine/tests/ui/accuracy_e2e.cjs): a 3×3 grid calibration
through the real UI, then live gaze from `/gaze` compared with the simulator's **true** gaze
target at 20 random points (12 for the other columns), about 60 cm from a 1512×982 pt screen.
Degrees, lower is better:

| Mode (simulated)                      | Chosen (1 position) | Live, chosen | Live, geometric | Engine's own validation, chosen | Head moved 5 cm, 8°, live               | 3 head positions, live at a 4th |
| ------------------------------------- | ------------------- | ------------ | --------------- | ------------------------------- | --------------------------------------- | ------------------------------- |
| Front TrueDepth, ARKit                | geometric           | 0.46°        | 0.38°           | 1.08°                           | 1.4° (geometric)                        | 0.31° (geometric)               |
| Rear wide camera at 2×, camera images | blend               | 0.30°        | 1.1°            | 0.32°                           | 3.4° (blend; reflection validated 3.7°) | 0.49° (reflection)              |

Numbers from one run on 2026-11-16 (Linux, 4 cores, 17-19 fps from the simulator). Other runs
vary, most of all after a head move (camera mode after a one-position calibration: 1 to 4°), and which model is chosen automatically varies. CI runs the
same test with loose bounds and also fails if the engine's own validation number is much better
than what the truth shows.

What these numbers mean, honestly:

- The simulator's person is a textbook eyeball with no real eyelids, squint or lighting. Real
  eyes and a real phone will be worse, possibly much worse. Treat these as "the plumbing is
  right", not as a promise.
- **ARKit mode** depends on Apple's eye transforms. The simulator gives ARKit's face pose about
  1 mm and 0.3° of jitter per frame plus a small bias, and that error reaches the eye centres as it
  would on a device. The geometric model amplifies eye-centre error (about 5.6° per millimetre),
  so in ARKit mode the regression models and the blend usually win. How good Apple's transforms
  are at 60 cm is unknown here.
- **Camera mode** (rear camera, MediaPipe face landmarks plus a sub-pixel iris fit and the
  screen's reflection on the cornea): the reflection model is the one to trust. The geometric
  model does not survive a head move after a one-position calibration (its eyeball centre comes
  from MediaPipe's eye corners). Regression models (ridge, kernel) cannot extrapolate to a head
  position they never saw. **Calibrate from 3 head positions**: the automatic choice then scores
  every model on a head position it did not see, and the result holds up (last column).

## Morning quick start

You need: a Mac with Python 3.10 or newer (macOS ships 3.9; `brew install python@3.12` or
[uv](https://docs.astral.sh/uv/) both work; uv is best), Xcode for the phone app, the iPhone, and
both on the same Wi-Fi network.

### 1. Try it without the phone (2 minutes)

```sh
cd forsee
sidecars/phone-gaze/run.sh --sim arkit
```

The first run creates `sidecars/phone-gaze/engine/.venv`, installs the dependencies, downloads
MediaPipe's face model (about 4 MB) and opens `http://127.0.0.1:8765/`. You are looking at a
simulated phone watching a synthetic face. Press **Calibrate**, then Space; then **Validate**.
`--sim camera` is the simulated rear camera at 2×. Ctrl-C stops it. The simulator keeps its
calibrations in its own profile (`~/.phonegaze/profiles/sim/`), apart from the real one.

### 2. Rebuild the phone app (version 0.2.1)

Once, put your signing team in a file git ignores:

```sh
cp tools/eye-capture/ios/Local.xcconfig.example tools/eye-capture/ios/Local.xcconfig
open -e tools/eye-capture/ios/Local.xcconfig
```

Fill in `DEVELOPMENT_TEAM` (Xcode > Settings > Accounts, 10 characters) and the **same**
`PRODUCT_BUNDLE_IDENTIFIER` you used before (otherwise the phone gets a second copy of the app).
Open `tools/eye-capture/ios/EyeCapture.xcodeproj`, pick your iPhone, press Run. Leave the team
empty in Xcode's Signing tab. Details:
[tools/eye-capture/README.md](../../tools/eye-capture/README.md#signing).

If the phone asks to allow **Local Network** access, tap **Allow**. The app shows an address such
as `http://192.168.1.23:8080`.

### 3. Start the engine with the phone

```sh
sidecars/phone-gaze/run.sh --phone http://192.168.1.23:8080
```

If it says `cannot reach ... No route to host`, see Local Network in step 4.

### 4. Permissions on the Mac

System Settings > Privacy & Security, for the app that runs `run.sh` (Terminal, iTerm or your
editor):

- **Local Network** (macOS 15 and later; to reach the phone). If Safari opens the phone's address
  but Phone Gaze cannot, this is why.
- **Accessibility** (to move the cursor and click). Restart the engine afterwards. Without it the
  cursor is left alone. The cursor is off by default; turn on **System cursor** on the Dashboard.
  Moving the real mouse pauses gaze control for a moment.
- **Input Monitoring** (for the global shortcuts). Without it they only work while the browser
  page has focus.

### 5. Aim, pick a lens, calibrate

Try the **front ARKit mode first**; it is the most likely to work.

1. Stand the phone below the screen, front camera towards you, about an arm's length away.
2. **Aim** page: choose _Front TrueDepth camera with ARKit face tracking_. The preview should
   show your face with both eyes marked.
3. Put the browser window on the **main display** (the one with the menu bar), full screen.
   Calibration refuses to run anywhere else, because the engine measures the main display.
4. Dashboard: **Calibrate**, choose **3 head positions**, Space. Look at each dot until it moves
   on; between rounds, move your head as asked. Esc cancels (the previous calibration stays).
5. **Validate**: fresh dots, never used for fitting. This is the number to believe.
6. **Live** page: a marker follows your gaze. Turn on **System cursor** when it looks right.

Then the **rear camera at 2×** (more pixels per eye, and the screen's reflection becomes usable):

1. Turn the phone round so the rear cameras face you.
2. Aim page: **Find the best lens** tries each camera and zoom and keeps the best (expect the wide
   camera at 2×). Click an eye in the preview to focus there, then **Lock focus**.
3. Calibrate with **3 head positions** and tick **Flash the screen**. Validate.

A calibration belongs to one camera and one screen: each camera has its own saved calibration
(`~/.phonegaze/profiles/default/<camera>/`), loaded when you switch back to it. With a camera or
screen it was not made for, there is no gaze output until you calibrate.

If you sit back or bump the phone: **Quick refine** (one to five dots) instead of a full
calibration.

### 6. Compare experiments

The **Experiments** page lists every setting (estimators, models, filters, stream quality, zoom
behaviour). Changes apply at once and are saved to `~/.phonegaze/config.json`. Save a preset, run
**Validate**, change one thing, validate again; the page keeps each preset's results side by side.
The Dashboard's model table lets you pin a model instead of the automatic choice.

### Shortcuts

| Keys (anywhere on the Mac) | In the browser page | Does                 |
| -------------------------- | ------------------- | -------------------- |
| Ctrl-Alt-C                 | C                   | Full calibration     |
| Ctrl-Alt-R                 | R                   | Quick refine         |
| Ctrl-Alt-V                 | V                   | Validate             |
| Ctrl-Alt-P                 | P                   | Pause / resume       |
|                            | Space / Esc         | Start / cancel a run |

### Use it with Forsee

Start the engine, calibrate, then open the Forsee web app with `?gaze=phone`, for example
`http://localhost:5173/?gaze=phone` (`&gazePort=N` if you started the engine with `--port N`).
Use full screen at 100 % browser zoom so positions line up. While this is on, the mouse does not
drive selection; every selection is sent back to the engine as a known look-point (see the next
section).

### Drift correction from selections (experiment, off by default)

**Unit-tested and tested against simulators only; never run on a real phone.**

When you type in Forsee by dwell, each key you select is a place you were looking. The engine
uses these to learn a small offset that undoes slow drift (you settling in your chair, the phone
creeping on the desk) without a new calibration.

- **What it does.** For each selection it takes the gaze estimate from the fixation just before
  the key fired (not the sample when the message arrives; Forsee sends the selection's time on the
  engine's clock), compares it with the key, and nudges the offset a little. A key only proves you
  looked somewhere on it, so big keys count less than small ones, and one selection can move the
  offset by at most 0.5°. A selection whose estimate was more than 2° outside the key is ignored
  (a mistake or a stale sample). If you delete what you just selected (backspace or undo straight
  away), that selection is taken back. The offset is forgotten after a calibration, a quick
  refine, a camera or model change, or when a saved calibration is loaded; a zoom change keeps it
  but lets the next selections move it more.
- **Switch it on.** Experiments page, card **Drift correction from selections**, or the setting
  `calibration.drift_correction`. `calibration.drift_rate` (degrees per minute, default 0.5) is
  how fast it adapts. `calibration.drift_clicks` (off) also learns from mouse clicks, as weaker
  evidence. With Forsee not connected and no selection for 2 minutes, the offset is not applied, so
  the plain cursor is unaffected.
- **Read the numbers.** The same card shows, over this session and the last 50 selections, the
  median and mean distance from the gaze estimate to the centre of the selected key, **with
  correction** and **without**, each measured before that selection updated anything. Both are
  measured whether or not the correction is switched on, so you can type normally with it off and
  see whether it would have helped. Distances include where on the key you looked, so they never
  reach zero; compare the two columns, not the absolute numbers. Also `GET /api/drift`.
- **Offline.** Recordings include the selections, so
  `.venv/bin/python -m phonegaze.replay score <recording>` prints both numbers for the replayed
  session, as if the correction had been on and as if it had been off (`--drift-rate` to try
  another speed).
- **Limits.** It corrects slow drift only: a shift of the whole picture, not a wrong scale, and not
  a sudden bump (use Quick refine). Wrong selections that you do not delete pull it the wrong way.
  Large keys give weak evidence, so it learns slowly from them. Drift bigger than about half a key
  shows up as wrong keys, which you delete, so it is not learned from. Forsee reports undo by
  watching the text (a backspace, delete-word or undo right after a selection), not by knowing
  which key you meant.

In the Models simulator (`tests/test_models_drift.py`: a ridge calibration, the phone sliding
3 mm and tilting 0.3° a minute for 4 minutes, a selection every 1.5 s on 120 × 100 pt keys) the
true error grows to about 2.8° without correction and stays at about 0.3° with it; with no drift
both are about 0.25°.

### Second camera: the Mac's webcam as an anchor (experiment, off by default)

**Tested only against the simulators; never run with a real MacBook camera.** Design, geometry
and the full simulator tables: [docs/SECOND_CAMERA.md](docs/SECOND_CAMERA.md).

The MacBook's camera is fixed to the screen, so where it is relative to the screen is known.
When it and the phone see the same head, the engine works out where the phone is relative to the
screen, notices when the phone is moved, and can feed that to the gaze models.

- **Turn it on.** The **Second camera** page (or the Experiments page, settings
  `second_camera.*`): tick `enabled`. The page shows the webcam with the detected face, where the
  phone is relative to the screen (with its uncertainty), whether the two cameras' distances
  agree, and "Phone moved, re-anchoring" after a bump. Wait for **Anchored** (a few seconds of
  both cameras seeing your face) before calibrating. With `--sim` the simulator's own webcam is
  used.
- **Camera permission.** macOS asks the app that runs the engine (Terminal, iTerm or your editor)
  the first time. If you said no, or the page says the camera opens but delivers no frames: System
  Settings > Privacy & Security > **Camera**, turn it on for that app, quit and reopen it.
  `camera_index` picks another camera.
- **Check the geometry first.** Measure where the phone is with a ruler and compare with the
  page. If the **Ratio** in "Do the cameras agree?" is not near 1 after a calibration, set
  `hfov_deg` to the suggested field of view. `offset_mm` is the lens's height above the top edge
  of the picture (about 8 mm on recent MacBooks; measure yours).
- **What to compare** (Validate after each; the extra models appear in its table):
  `screen_pose` `prior` or `fixed` (model `geometric_2cam` against `geometric`, also with a 2 × 2
  grid); `track_phone` (calibrate, move the phone a few centimetres, Validate with it off, then
  on, without recalibrating); `distance_source` `triangulated`; `head_pose_source`; `webcam_model`
  (the webcam alone, the baseline the phone must beat); `wide_head_box` (move your head out of
  the phone's view: the crops should follow and the gaze keep coming, marked low confidence).
- **Simulator numbers** (degrees, one head position, phone moved 2 cm and 4° after calibration):
  plain geometric 0.93 still, 2.79 after the phone moved, 1.47 with `track_phone`; webcam alone
  7.4; the prior and fixed screen pose did not beat the plain model. On rendered images with the
  real face landmarker the solved phone position was 3 to 10 cm off (MediaPipe's head pose on the
  synthetic face is biased), while a phone move was measured to about 1 cm.

### Record a session and send it back

On the **Recordings** page press Start, do a calibration and a validation, look around for a
minute, press Stop. Recordings go to `~/.phonegaze/recordings/<id>/`, never into the repository.
**They contain images of your face**, so share them only if you want to. To send numbers without
images, run

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze.replay score ~/.phonegaze/recordings/<id>
```

and paste the output, together with the Validate reports (each model's accuracy in degrees),
which camera and zoom you used, and the distance shown on the Aim page.

## Known limits and what to try first

From the review of this code, the things most likely to go wrong on real hardware:

1. **Camera mode distances wrong by 2×.** Whether the phone's per-frame camera matrix already
   includes the zoom has never been checked on a device. The engine now compares both readings
   with the lens's field of view and logs which one it uses (`camera ...: the phone's intrinsics
...` in the terminal). If the Aim page's distance is far from your real distance (about 60 cm),
   use ARKit mode and report the log line.
2. **The phone stops answering.** iOS takes the app's network listener away while the phone is
   locked or the app is in the background. App 0.2.1 rebuilds it when it returns to the
   foreground, and the engine restarts the camera after 3 s without frames. If the engine still
   says it cannot reach the phone, force-quit Eye Capture and open it again. Keep the app in the
   foreground with the screen on.
3. **Calibration that does not survive moving your head.** Calibrate from 3 head positions; in
   camera mode prefer the reflection model (pin it on the Dashboard if the automatic choice picks
   something else and Validate disagrees). After a one-position calibration, nothing has measured
   how a model copes with head movement, and the report says so.

Also known:

- ARKit mode: when ARKit loses your face the output holds (no gaze) instead of switching to a
  different estimator; it resumes when the face is found again.
- Frames during a zoom change are not used (the image can still be at the old zoom).
- The appearance estimator is a stub; the moving-dot calibration phase is reported but its
  samples are not used for the fit (it is about 10° in the simulator).
- Drift correction from Forsee selections has never run against a real phone or a real Forsee
  session; it is tested with unit tests, the Models simulator and fake clients.

## Troubleshooting

- **`Phone Gaze needs Python 3.10 or newer`**: install uv (or `brew install python@3.12`), delete
  `sidecars/phone-gaze/engine/.venv`, run `run.sh` again.
- **The phone does not connect**: same Wi-Fi on both (guest networks often block devices from
  seeing each other); Local Network permission on the Mac (step 4) and on the iPhone (Settings >
  Privacy & Security > Local Network > Eye Capture); the app in the foreground with the screen on;
  force-quit and reopen the app.
- **No gaze after switching camera**: expected; calibrate for this camera (see step 5).
- **Model download fails with a certificate error** (python.org Python): run.sh retries with
  certifi and then curl; if it still fails, run "Install Certificates.command" from the Python
  folder in Applications.
- **Frames drop, low fps**: lower `stream.wide_width` or `stream.roi_quality` on the Experiments
  page. The phone also warns about heat and low light.
- **Eyes not found**: more light on your face, the phone level with your eyes, less than a metre
  away; zoom in if the face is small.
- **Blurry eyes**: click an eye in the Aim preview to focus there, then lock focus.
- **Image sideways or upside down**: Experiments > `stream.rotation`: set a fixed rotation.
- **The cursor does not move**: Accessibility permission (step 4), then restart the engine; check
  **System cursor** is on and that you did not start with `--no-cursor`.
- **Shortcuts do nothing**: Input Monitoring permission. With Python 3.14 run.sh turns shortcuts
  off (`pynput` can crash it on macOS 26); install uv and delete `.venv` to get Python 3.12.
- **Port 8765 already in use**: another engine is running; stop it or use `--port 8766`.
- **Start over**: delete `~/.phonegaze/config.json` (settings) and `~/.phonegaze/profiles/`
  (saved calibrations).

## Developers

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m pytest                       # all Python tests (about a minute)
node tests/ui/ui_e2e.cjs                         # browser UI against the simulator
node tests/ui/accuracy_e2e.cjs arkit camera      # accuracy against the simulator (about 6 min)
node tests/ui/second_camera_e2e.cjs              # the second camera against the simulator (about 4 min)
.venv/bin/python -m phonegaze.sim --mode camera  # the simulated phone on its own, port 8081
```

The end-to-end scripts need Node 22 and Playwright with Chromium. CI runs all of them on Linux,
the run script and a short simulator run on macOS, and compiles the iPhone app
(`.github/workflows/phone-gaze.yml`).
