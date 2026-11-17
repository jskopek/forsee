# Phone Gaze

An eye tracker made from an iPhone and a Mac. The phone is a remote-controlled camera; the Mac
finds your eyes, learns where you look during a short calibration, and turns gaze into a cursor,
a dwell click, and a WebSocket stream the Forsee keyboard can use.

**It has never run on a real iPhone or a real Mac with a person in front of it.** Everything
below has been checked against a simulated phone and in CI only (see [Status](#status)).

## Start here

The first morning with the real phone and Mac, in order. Each step says what you should see.
All commands run from the repository root unless a step says otherwise. Once it runs and the
accuracy is not good enough, do not tune switches by hand: [collect data, then let the machine
search](#collect-data-then-let-the-machine-search).

**Collect, sweep, send back** (once steps 1-5 below work):

1. `sidecars/phone-gaze/run.sh --phone http://<phone-ip>:8080`, then **Collect data** on the Dashboard (`http://127.0.0.1:8765/#collect`). Tick **Quick comparison** (3 setups), press **Record the next condition** and follow the prompts: about 2½ minutes per setup with the 2-minute protocol.
2. The last page shows the run id. In a second terminal: `sidecars/phone-gaze/run.sh sweep RUN_ID` (45 minutes by default, nobody needed; `--minutes 20` for less), or **Run sweep** on the Sweep page (`http://127.0.0.1:8765/sweep.html`).
3. Send back the text the sweep prints at the end (also **Copy** on the Sweep page) and the output of `sidecars/phone-gaze/run.sh diagnose RUN_ID`. Neither holds images.
4. Then **Apply best preset**, **Calibrate** and **Validate** on the camera it names.

How the sweep works and how to read it: [docs/SWEEP.md](docs/SWEEP.md). What the iOS Simulator wire test found: [docs/WIRE_TEST_FINDINGS.md](docs/WIRE_TEST_FINDINGS.md).

### 1. Pull the branch

```sh
git checkout -- tools/eye-capture/ios/EyeCapture.xcodeproj   # only if git says it is modified
git fetch origin
git checkout claude/modest-keller-tzw1nz
git pull
```

If you chose a signing team in Xcode before, Xcode wrote it into
`EyeCapture.xcodeproj/project.pbxproj` and the pull will conflict there. Discard that local change
(the first line): signing now lives in `tools/eye-capture/ios/Local.xcconfig`, which git ignores.
Note your team ID and bundle identifier first if you do not know them
(`grep -E "DEVELOPMENT_TEAM|PRODUCT_BUNDLE_IDENTIFIER" tools/eye-capture/ios/EyeCapture.xcodeproj/project.pbxproj`).

### 2. Run the simulator once (about 2 minutes)

```sh
sidecars/phone-gaze/run.sh --sim arkit
```

You need Python 3.10 or newer (macOS ships 3.9; install [uv](https://docs.astral.sh/uv/), or
`brew install python@3.12`). The first run creates `sidecars/phone-gaze/engine/.venv`, installs
the dependencies, downloads MediaPipe's face model (about 4 MB) and opens
`http://127.0.0.1:8765/`. Expect: the Dashboard with a simulated phone connected and a synthetic
face. Press **Calibrate**, then Space, and look anywhere (the simulated person looks at the dots
for you); then **Validate**. Expect a validation result of about 1° and a table of models. This proves the install works; it says nothing about your eyes. Ctrl-C stops it. The
simulator keeps its calibrations apart from the real ones (`~/.phonegaze/profiles/sim/`).

### 3. Rebuild the phone app (version 0.2.2)

```sh
cp tools/eye-capture/ios/Local.xcconfig.example tools/eye-capture/ios/Local.xcconfig
open -e tools/eye-capture/ios/Local.xcconfig
```

Fill in `DEVELOPMENT_TEAM` (10 characters; Xcode > Settings > Accounts) and the **same**
`PRODUCT_BUNDLE_IDENTIFIER` you used before (a different one installs a second copy of the app).
Open `tools/eye-capture/ios/EyeCapture.xcodeproj`, pick your iPhone, press Run. Leave the team
empty in Xcode's Signing & Capabilities tab (choosing it there writes it back into the project
file). Details: [tools/eye-capture/README.md](../../tools/eye-capture/README.md#signing).

Expect: the app opens and shows an address such as `http://192.168.1.23:8080`. If it asks for
**Local Network** access, tap **Allow**. Keep the app in the foreground with the screen on and the
phone plugged in.

### 4. Run the doctor against the phone

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze doctor --phone http://192.168.1.23:8080
```

It prints a checklist, each line `OK`, `WARN`, `FAIL`, `info` or `skip`, and a fix under every
`WARN` and `FAIL`: Python and packages, the face model, Accessibility and Input Monitoring, the
screen size, whether the phone answers (and Local Network), the app version and protocol, the
clock, frame rate, dropped frames and latency; then it watches a few seconds of frames and judges
each stage (face, eyes, iris fit, reflection, distance). Fix every `FAIL` before going on. A
`WARN` on Accessibility only means the cursor will not move yet. The first frames can take 30 s
while MediaPipe loads.

### 5. Front camera first: start, calibrate, validate

```sh
sidecars/phone-gaze/run.sh --phone http://192.168.1.23:8080
```

1. Stand the phone below the screen, front camera towards you, about an arm's length away.
2. **Aim** page: choose _Front TrueDepth camera with ARKit face tracking_. Expect your face in the
   preview with both eyes marked, and a **Distance** close to your real distance (about 60 cm).
   (Or apply the preset **front camera, safe** on the **Experiments** page.)
3. Put the browser window on the **main display** (the one with the menu bar) and make it full
   screen. Calibration refuses to run anywhere else, because the engine measures the main display.
4. Dashboard: **Calibrate**, set **Head positions** to 3, Space. Look at each dot until it moves
   on; between rounds, move your head as asked. Esc cancels (the previous calibration stays).
5. **Validate**: fresh dots never used for fitting. **This is the number to believe.** Write it
   down with the camera used.
6. **Live** page: a marker follows your gaze. Turn on **System cursor** on the Dashboard when it
   looks right (needs Accessibility, below).

### 6. Then the rear camera at 2×

1. Turn the phone round so the rear cameras face you.
2. **Aim** page: **Find the best lens** tries each camera and zoom and keeps the best (expect the
   wide camera at 2×). Click an eye in the preview to focus there, then **Lock focus**. Or apply
   the preset **rear 2x, reflection**.
3. Check the **Distance** on the Aim page against a tape measure (see "If it goes wrong").
4. Calibrate with **Head positions** 3 and tick **Flash the screen for 3 s first**. **Validate**.
   Compare with the front camera's number.

Each camera keeps its own calibration (`~/.phonegaze/profiles/default/<camera>/`), loaded when you
switch back to it. With a camera or screen it was not made for, there is no gaze output until you
calibrate.

### 7. Run the offline lab on the recordings you already have

The eye-capture sessions recorded with app 0.1 are in `tools/eye-capture/captures/` on your Mac
(git ignores that folder). The lab replays one through the estimators and models, no phone
needed:

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze lab ../../../tools/eye-capture/captures/<session>
```

It writes `report.html` under `~/.phonegaze/lab/` with held-out error per camera, estimator
combination and model. Or use the **Lab** page (link on the Dashboard). This is the first time
the lab sees real footage: it has only been run on synthetic sessions.

### 8. When something fails, send this back

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze bundle
```

(or **Write bundle** on the **Diagnostics** page). It writes a folder in
`~/.phonegaze/diagnostics/` and prints the path. Paste the contents of its **`summary.txt`**. The
bundle holds no images unless you tick **Include images from the camera** (or pass `--images`).
Also useful: the Validate numbers, which camera and zoom, and the distance on the Aim page.

### If it goes wrong

- **The engine cannot reach the phone** (`No route to host`, or the doctor shows `FAIL` on
  "Phone reachable"): Local Network permission is needed on **both** devices. On the Mac: System
  Settings > Privacy & Security > Local Network, for the app that runs `run.sh` (Terminal, iTerm
  or your editor). On the iPhone: Settings > Privacy & Security > Local Network > Eye Capture.
  Same Wi-Fi on both (guest networks often block devices from seeing each other). If Safari opens
  the phone's address but Phone Gaze cannot, it is the Mac's Local Network permission. Still
  stuck: force-quit Eye Capture and open it again.
- **The cursor does not move**: System Settings > Privacy & Security > **Accessibility** for the
  app that runs `run.sh`, then restart the engine, and turn on **System cursor** on the Dashboard.
  Global shortcuts need **Input Monitoring** in the same place.
- **The distance is wrong in rear-camera mode** (the Aim page says 120 cm when you sit at 60, or
  30): whether the phone's per-frame camera matrix already includes the zoom has never been
  checked on a device. The terminal and log say which reading the engine chose (a line starting
  `camera ...: the phone's intrinsics`). Report that line. To carry on, set
  `estimators.distance_source` to `fixed` and `estimators.fixed_distance_m` to your measured
  distance on the Experiments page, or use the front ARKit mode.
- **Gaze drifts when you move your head**: calibrate from 3 head positions (not 1). In rear-camera
  mode prefer the reflection or geometric model (pin it in the Dashboard's model table); the
  regression models cannot extrapolate to a head position they never saw. **Quick refine** (one to
  five dots) after you sit back or bump the phone. More in
  [docs/TUNING.md](docs/TUNING.md#symptom-to-setting).

**When it does not work well enough, or to make it better: [docs/TUNING.md](docs/TUNING.md)**,
the playbook. Ideas not done yet: [docs/ROADMAP.md](docs/ROADMAP.md).

## Collect data, then let the machine search

**Only run against the simulator so far; never on a real phone or with a real person.**

Instead of trying switches one at a time, record a few short, identical sessions, one per physical
setup, and let the computer replay them through thousands of setting combinations offline.

1. Start the engine with the phone connected and press **Collect data** on the Dashboard (or open
   the **Collect** tab).
2. Tick a ready-made set and a protocol length (about 1, 2 or 3 minutes of dots per condition;
   the page shows the estimate for the whole run):

   | Set                  | Conditions                                                                                          | With the 2-minute protocol |
   | -------------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
   | Quick comparison     | front ARKit; back wide 1×; back wide 2×                                                             | about 7 min                |
   | Rear camera in depth | back wide 1× and 2×, each with and without the reflection helper, each at a normal and 8 ms shutter | about 18 min               |
   | Everything           | the above plus front plain, ultra wide and telephoto (12 conditions)                                | about 28 min               |

   (1-minute protocol: about 5½, 15 and 22 min; 3-minute: about 10, 27 and 40 min. Each
   estimate includes about 30 s per condition to switch camera and settle.) Add, remove,
   reorder or repeat conditions, and type notes for each (distance, lighting, glasses).

3. **Record the next condition.** The engine switches the phone to that camera, zoom, frame rate,
   shutter and focus, and the page says what to do ("Turn the phone round so its back cameras face
   you") beside a live preview. It starts only when focus and exposure have settled and both eyes
   are found; with no face it refuses and says why.
4. **Start recording this condition.** Full screen, the same for every condition: a calibration
   grid; the same few dots with your head moved left, right and nearer (plain prompts; press
   Space when in place); check dots at other places; a short moving dot. **Esc** pauses:
   continue, redo the condition, skip it, or stop for now (resume the run later from the Collect
   tab). No model is fitted and the cursor does not move while you collect.
5. After each condition the page shows face found %, both eyes found % and frames received, and
   flags **poor data** (both eyes in fewer than 80 % of frames, `collect.poor_eyes_pct`) with a
   **Redo** button.
6. At the end: a table of the conditions, where the data is, and the command to analyse it:

   ```sh
   sidecars/phone-gaze/run.sh sweep <run id>      # about 45 min, nobody needed
   sidecars/phone-gaze/run.sh diagnose <run id>   # why each setup's error is what it is
   ```

   (or **Run sweep** on the Dashboard). Send back the text both print at the end.

   Then press **Apply best preset** on the Dashboard: it applies the newest preset named
   **best from sweep** and says which camera and zoom it was found for.

Each condition is an ordinary recording in `~/.phonegaze/recordings/` (raw stream with images:
**pictures of your face**) plus `collect.json` (which camera and settings, and when each dot was
on screen); the run is listed in `~/.phonegaze/recordings/collect-runs/<run id>.json`. Settings
are in the `collect` section of the Experiments page. The Dashboard now shows only the main
actions; everything else is under **Advanced** (`ui.simple_mode` off brings back the old
layout).

## Status

Nothing here has run on a real iPhone or a real Mac with a person in front of it. What has been
checked, and how:

| Part                                                           | Checked how                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone app 0.2.2 (live stream, zoom, lens, ARKit)              | Compiles in CI. Runs in the iOS Simulator in CI with a synthetic test-pattern camera, streaming to the real engine. This proves the app and engine speak the same wire protocol; it says nothing about real cameras, ARKit or real eyes. Never run on a phone. |
| Engine (Python): phone client, pipeline, models, UI, API       | Unit tests on Linux and macOS CI; end to end against the simulated phone (below).                                                                                                                                                                              |
| Simulated phone                                                | Speaks the same protocol as the app; exact synthetic eyes, ARKit transforms and screen reflections.                                                                                                                                                            |
| Browser UI                                                     | Driven in headless Chromium against the engine and simulator: connect, aim, calibrate, validate, refine, live, record.                                                                                                                                         |
| Mac outputs (cursor, hotkeys, screen size)                     | CI on a macOS runner imports them, reads the screen size from macOS and runs the engine for a few seconds. Cursor never moved; shortcuts never pressed.                                                                                                        |
| Forsee gaze source (`?gaze=phone`)                             | Unit tests against a fake server. Never connected to the real engine with a real phone.                                                                                                                                                                        |
| Drift correction from selections (experiment, off)             | Unit tests, a simulated drifting phone (Models simulator), API tests with fake clients. Never with a real phone or person.                                                                                                                                     |
| Doctor, diagnostics, lab, tuning switches, calibration options | Unit tests; the doctor, Tuning page and calibration options against the simulated phone; the lab on synthetic sessions only. Never with a real phone or person.                                                                                                |
| Collection run (Collect page) and the simple Dashboard         | Unit tests and `engine/tests/ui/collect_e2e.cjs` against the simulator: two conditions recorded through the page, pause, redo and skip, the files checked. Never with a real phone or person.                                                                  |
| Second camera (Mac webcam as anchor; experiment, off)          | Against the simulators only (see [docs/SECOND_CAMERA.md](docs/SECOND_CAMERA.md)). Never with a real MacBook camera.                                                                                                                                            |

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
vary, most of all after a head move (camera mode after a one-position calibration: 1 to 4°), and
which model is chosen automatically varies. CI runs the same test with loose bounds and also
fails if the engine's own validation number is much better than what the truth shows.

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

## Tools for when it does not work

- `python -m phonegaze doctor --phone http://<phone-ip>:8080`: the checklist (step 4). The
  **Diagnostics** page (Dashboard link) runs the same with **Run the checks** and shows a live
  health strip.
- `python -m phonegaze bundle [--images]`: a diagnostics folder (`summary.txt`, settings, log,
  recent numbers; no images unless asked) in `~/.phonegaze/diagnostics/`. The log is always in
  `~/.phonegaze/logs/phonegaze.log`.
- `python -m phonegaze lab SESSION`, `tune SESSION` and `ab SESSION --a X --b Y`: score recorded
  sessions offline, sweep settings with a held-out score, and compare two setups on the same data.
  Also the **Lab** page.
- The **Tuning** tab (eye crops with the iris fit and reflection drawn on, **Freeze frame**), every
  setting on the **Experiments** page with a search box, and presets (**front camera, safe**,
  **rear 2x, reflection**, **rear 2x, geometric**, **rear 1x, wide head box** and your own). New
  switches default to the behaviour from before.

All of these are run with `.venv/bin/python -m phonegaze ...` from `sidecars/phone-gaze/engine`.

## Pages and settings

The browser UI has the tabs **Dashboard**, **Collect** and **Live**, then under **Advanced**
**Aim**, **Tuning**, **Experiments**, **Recordings** and **Second camera**, plus the
**Diagnostics** and **Lab** pages linked from the Dashboard's Advanced section.

### Permissions on the Mac

System Settings > Privacy & Security, for the app that runs `run.sh` (Terminal, iTerm or your
editor):

- **Local Network** (macOS 15 and later; to reach the phone).
- **Accessibility** (to move the cursor and click). Restart the engine afterwards. Without it the
  cursor is left alone. The cursor is off by default; turn on **System cursor** on the Dashboard.
  Moving the real mouse pauses gaze control for a moment.
- **Input Monitoring** (for the global shortcuts). Without it they only work while the browser
  page has focus.
- **Camera**, only for the second camera (below).

### Calibration options

The calibration panel (Dashboard, **Calibrate**) has **Head positions** (1 to 5; 3 recommended),
**Head sweep** (look at a dot while turning your head), **Show poor dots again once (quality
gate)**, **Follow a moving dot as well**, and **Flash the screen for 3 s first** (helps find the
screen's reflection). The grid and dot layout are on the Experiments page (`calibration.*`).
After a validation, **Touch up the worst N** shows the worst dots again. **Quick refine** (one to
five dots) corrects a small shift without a full calibration.

### Compare experiments

The **Experiments** page lists every setting (estimators, models, filters, stream quality, zoom
behaviour, calibration options). Changes apply at once and are saved to
`~/.phonegaze/config.json`. Save a preset (**Save current settings as preset**), run
**Validate**, change one thing, validate again; the page keeps each preset's results side by side.
The Dashboard's model table lets you pin a model instead of the automatic choice. How to compare
fairly: [docs/TUNING.md](docs/TUNING.md#comparing-two-setups-fairly).

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
drive selection; every selection is sent back to the engine as a known look-point (next section).

### Drift correction from selections (experiment, off by default)

**Unit-tested and tested against simulators only; never run on a real phone.**

When you type in Forsee by dwell, each key you select is a place you were looking. The engine
uses these to learn a small offset that undoes slow drift (you settling in your chair, the phone
creeping on the desk) without a new calibration.

- **What it does.** For each selection it takes the gaze estimate from the fixation just before
  the key fired (Forsee sends the selection's time on the engine's clock), compares it with the
  key, and nudges the offset a little. A key only proves you looked somewhere on it, so big keys
  count less than small ones, and one selection can move the offset by at most 0.5°. A selection
  whose estimate was more than 2° outside the key is ignored. If you delete what you just selected
  (backspace or undo straight away), that selection is taken back. The offset is forgotten after
  a calibration, a quick refine, a camera or model change, or when a saved calibration is loaded;
  a zoom change keeps it but lets the next selections move it more.
- **Switch it on.** Experiments page, card **Drift correction from selections**, or the setting
  `calibration.drift_correction`. `calibration.drift_rate` (degrees per minute, default 0.5) is
  how fast it adapts. `calibration.drift_clicks` (off) also learns from mouse clicks, as weaker
  evidence. With Forsee not connected and no selection for 2 minutes, the offset is not applied.
- **Read the numbers.** The same card shows, over this session and the last 50 selections, the
  median and mean distance from the gaze estimate to the centre of the selected key, **With
  correction** and **Without**, each measured before that selection updated anything. Both are
  measured whether or not the correction is switched on, so you can type with it off and see
  whether it would have helped. Compare the two columns, not the absolute numbers (they include
  where on the key you looked). Also `GET /api/drift`.
- **Offline.** Recordings include the selections, so
  `.venv/bin/python -m phonegaze.replay score <recording>` prints both numbers for the replayed
  session (`--drift-rate` to try another speed).
- **Limits.** Slow drift only: a shift of the whole picture, not a wrong scale, and not a sudden
  bump (use Quick refine). Wrong selections that you do not delete pull it the wrong way. Drift
  bigger than about half a key shows up as wrong keys, which you delete, so it is not learned from.

In the Models simulator (`tests/test_models_drift.py`: a ridge calibration, the phone sliding
3 mm and tilting 0.3° a minute for 4 minutes, a selection every 1.5 s on 120 × 100 pt keys) the
true error grows to about 2.8° without correction and stays at about 0.3° with it.

### Second camera: the Mac's webcam as an anchor (experiment, off by default)

**Tested only against the simulators; never run with a real MacBook camera.** Design, geometry,
what to compare and the simulator tables: [docs/SECOND_CAMERA.md](docs/SECOND_CAMERA.md).

The MacBook's camera is fixed to the screen, so where it is relative to the screen is known.
When it and the phone see the same head, the engine works out where the phone is relative to the
screen, notices when the phone is moved, and can feed that to the gaze models. Turn it on on the
**Second camera** page (setting `second_camera.enabled`) and wait for **Anchored** before
calibrating. macOS asks for **Camera** permission for the app that runs the engine the first
time. In the simulator, tracking the phone after a 2 cm move brought the error from 2.79° back to
1.47°; the webcam alone was 7.4°.

### Record a session and send it back

On the **Recordings** page press **Start recording**, do a calibration and a validation, look
around for a minute, press **Stop**. Recordings go to `~/.phonegaze/recordings/<id>/`, never into
the repository. **They contain images of your face**, so share them only if you want to. Numbers
without images:

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze.replay score ~/.phonegaze/recordings/<id>
.venv/bin/python -m phonegaze lab ~/.phonegaze/recordings/<id>
```

## Known limits

1. **Camera-mode distance wrong by 2×** (see "If it goes wrong"). The engine compares both
   readings of the intrinsics with the lens's field of view and logs which one it uses.
2. **The phone stops answering.** iOS takes the app's network listener away while the phone is
   locked or the app is in the background. The app rebuilds it when it returns to the foreground,
   and the engine restarts the camera after 3 s without frames. Keep the app in the foreground
   with the screen on.
3. **Calibration that does not survive moving your head.** Calibrate from 3 head positions; in
   camera mode prefer the reflection model. After a one-position calibration, nothing has
   measured how a model copes with head movement, and the report says so.

Also known:

- ARKit mode: when ARKit loses your face the output holds (no gaze) instead of switching to a
  different estimator; it resumes when the face is found again.
- Frames during a zoom change are not used.
- The appearance estimator is a stub. The moving dot is only reported unless
  `calibration.pursuit_merge` is `auto` or `on` (off by default); on its own it is about 10° in
  the simulator.

## Troubleshooting

- **`Phone Gaze needs Python 3.10 or newer`**: install uv (or `brew install python@3.12`), delete
  `sidecars/phone-gaze/engine/.venv`, run `run.sh` again.
- **No gaze after switching camera**: expected; calibrate for this camera.
- **Model download fails with a certificate error** (python.org Python): run.sh retries with
  certifi and then curl; if it still fails, run "Install Certificates.command" from the Python
  folder in Applications.
- **Frames drop, low fps**: lower `stream.wide_width` or `stream.roi_quality` on the Experiments
  page. The phone also warns about heat and low light.
- **Eyes not found**: more light on your face, the phone level with your eyes, less than a metre
  away; zoom in if the face is small.
- **Blurry eyes**: click an eye in the Aim preview to focus there, then **Lock focus**. The
  telephoto cannot focus closer than about 135 cm; use the wide camera at 2×.
- **Image sideways or upside down**: Experiments > `stream.rotation`: set a fixed rotation.
- **Shortcuts do nothing**: Input Monitoring permission. With Python 3.14 run.sh turns shortcuts
  off (`pynput` can crash it on macOS 26); install uv and delete `.venv` to get Python 3.12.
- **Port 8765 already in use**: another engine is running; stop it or use `--port 8766`.
- **Start over**: delete `~/.phonegaze/config.json` (settings) and `~/.phonegaze/profiles/`
  (saved calibrations).

## Developers

How it is built: [ARCHITECTURE.md](ARCHITECTURE.md). Wire format:
[docs/PROTOCOL.md](docs/PROTOCOL.md). Engine API: [docs/INTERFACES.md](docs/INTERFACES.md).

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m pytest                       # all Python tests (about a minute)
node tests/ui/ui_e2e.cjs                         # browser UI against the simulator
node tests/ui/accuracy_e2e.cjs arkit camera      # accuracy against the simulator (about 6 min)
node tests/ui/second_camera_e2e.cjs              # the second camera against the simulator (about 4 min)
node tests/ui/collect_e2e.cjs                    # a short collection run against the simulator (about 3 min)
.venv/bin/python -m phonegaze.sim --mode camera  # the simulated phone on its own, port 8081
```

The end-to-end scripts need Node 22 and Playwright with Chromium. CI runs them on Linux, the run
script and a short simulator run on macOS, compiles the iPhone app, and runs it in the iOS
Simulator against the engine (`.github/workflows/phone-gaze.yml`).
