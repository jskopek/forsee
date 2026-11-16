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
| iPhone app 0.2 (live stream, zoom, lens, ARKit)          | Compiles in CI (macOS runner, signing off). Never run on a phone.                                                              |
| Engine (Python): phone client, pipeline, models, UI, API | Unit tests on Linux and macOS CI; end to end against the simulated phone (below).                                              |
| Simulated phone                                          | Speaks the same protocol as the app; exact synthetic eyes, ARKit transforms and screen reflections.                            |
| Browser UI                                               | Driven in headless Chromium against the engine and simulator: connect, aim, calibrate, validate, refine, live, record.         |
| Mac outputs (cursor, hotkeys, screen size)               | CI on a macOS runner imports them, reads the screen size from macOS and runs the engine for a few seconds. Cursor never moved. |
| Forsee gaze source (`?gaze=phone`)                       | Unit tests against a fake server. Never connected to the real engine.                                                          |

Accuracy against the simulator, measured by
[`engine/tests/ui/accuracy_e2e.cjs`](engine/tests/ui/accuracy_e2e.cjs) (3×3 grid calibration
through the real UI, 5 fresh validation dots, about 60 cm from a 1512×982 pt screen; degrees,
lower is better):

| Mode (simulated)                      | Model chosen | Validation, chosen | Geometric | Reflection | Live error vs true gaze | Head moved 5 cm, 8°, no recalibration                  | Calibrated at 3 head positions, validated at a 4th |
| ------------------------------------- | ------------ | ------------------ | --------- | ---------- | ----------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| Front TrueDepth, ARKit                | geometric    | 0.48°              | 0.48°     | n/a        | 1.1° (mean of 8 points) | geometric 0.9°, blend 5.4°, ridge 10°                  | geometric 0.5°, ridge 1.0°                         |
| Rear wide camera at 2×, camera images | reflection   | 0.40°              | 0.95°     | 0.40°      | 0.27°                   | reflection 0.9°, blend 0.5°, geometric 7.6°, ridge 78° | reflection 0.6°, blend 1.1°, geometric 2.6°        |

Numbers from one run on 2026-11-16 (Linux, 4 cores, about 19-27 fps from the simulator); other
runs vary by a few tenths of a degree, and which model is chosen automatically varies. CI runs the
same test with loose bounds.

What these numbers mean, honestly:

- The simulator's person is perfect: no squint, no real eyelids, a textbook eyeball. Real eyes,
  real lighting and a real phone will be worse, possibly much worse. Treat these as "the plumbing
  is right", not as a promise.
- **ARKit mode** depends on Apple's eye transforms. The simulator adds noise and a small bias to
  them, but how good Apple's are at 60 cm is unknown here.
- **Camera mode** (rear camera, MediaPipe face landmarks plus a sub-pixel iris fit and the
  screen's reflection on the cornea): the reflection model holds up when the head moves. The
  geometric model does not after a one-position calibration: it takes the eyeball centre from
  MediaPipe's eye corners, and on the synthetic face those shift by about a millimetre relative to
  the eyeball when the head turns. One millimetre there is about 5 degrees of gaze. Calibrating
  from three head positions fixes most of it (see the table). Regression models (ridge, kernel)
  cannot extrapolate to a head position they never saw; calibrate from several positions if you
  move around.

## Morning quick start

You need: a Mac with Python 3.10 or newer (macOS ships 3.9; `brew install python@3.12` or
[uv](https://docs.astral.sh/uv/) both work), Xcode for the phone app, the iPhone, and both on the
same Wi-Fi network.

### 1. Try it without the phone (2 minutes)

```sh
cd forsee
sidecars/phone-gaze/run.sh --sim arkit
```

The first run creates `sidecars/phone-gaze/engine/.venv` (uv if installed, otherwise
`python3 -m venv`), installs the dependencies, downloads MediaPipe's face model (about 4 MB), then
opens `http://127.0.0.1:8765/` in your browser. You are looking at a simulated phone watching a
synthetic face. Press **Calibrate**, then Space, and watch the dots; then **Validate**. Use
`--sim camera` for the simulated rear camera at 2×. Ctrl-C stops it.

### 2. Rebuild the phone app (version 0.2)

The Xcode project was regenerated, so the signing team you set in Xcode is gone. Put it in a file
git ignores, once:

```sh
cp tools/eye-capture/ios/Local.xcconfig.example tools/eye-capture/ios/Local.xcconfig
open -e tools/eye-capture/ios/Local.xcconfig
```

Fill in `DEVELOPMENT_TEAM` (Xcode > Settings > Accounts > your team, 10 characters) and the
**same** `PRODUCT_BUNDLE_IDENTIFIER` you used before (otherwise the phone gets a second copy of the
app). Then open `tools/eye-capture/ios/EyeCapture.xcodeproj`, pick your iPhone and press Run.
Leave the team empty in Xcode's Signing tab from now on. Details:
[tools/eye-capture/README.md](../../tools/eye-capture/README.md#signing).

The app shows an address such as `http://192.168.1.23:8080`.

### 3. Start the engine with the phone

```sh
sidecars/phone-gaze/run.sh --phone http://192.168.1.23:8080
```

(or start `run.sh` with no arguments and type the address on the Dashboard; it is remembered.)

### 4. Permissions on the Mac

- **Accessibility** (to move the cursor and click): System Settings > Privacy & Security >
  Accessibility, turn on the app that runs the script (Terminal, iTerm, or your editor). Restart
  the engine afterwards. The cursor is off by default; turn on **System cursor** on the Dashboard.
  Moving the real mouse pauses gaze control for a moment.
- **Input Monitoring** (for the global shortcuts): same place, Input Monitoring. Without it the
  shortcuts only work while the browser page has focus.

### 5. Aim, pick a lens, calibrate

Try the **front ARKit mode first**; it is the most likely to work.

1. Stand the phone below the screen, front camera towards you, about an arm's length away.
2. **Aim** page: choose the camera _Front TrueDepth camera with ARKit face tracking_. The preview
   should show your face with both eyes marked.
3. Dashboard: **Calibrate**. Look at each dot until it moves on. Esc cancels. The report shows
   every model's cross-validated error and picks the best.
4. **Validate**: fresh dots, never used for fitting. This is the number to believe.
5. **Live** page: a marker follows your gaze. Turn on **System cursor** when it looks right.

Then the **rear camera at 2×** (more pixels per eye, and the screen's reflection becomes usable):

1. Turn the phone round so the rear cameras face you.
2. Aim page: **Find the best lens** tries each camera and zoom, measures iris size and sharpness,
   and keeps the best. Expect the wide camera at 2×; the telephoto cannot focus at desk distance.
   Click an eye in the preview to focus there, then **Lock focus**.
3. Calibrate with **2 or 3 head positions** (the calibration screen asks you to move between
   rounds), and tick **Flash the screen** to help the reflection model find the screen's reflection. Validate.

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
drive selection; dwell selections are sent back to the engine as known look-points (used for
drift correction if you turn it on under Experiments > calibration).

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

## Troubleshooting

- **`Phone Gaze needs Python 3.10 or newer`**: install Python 3.12 (`brew install python@3.12`)
  or uv, then run `run.sh` again. Delete `sidecars/phone-gaze/engine/.venv` if it was created with
  the wrong Python.
- **The phone does not connect**: same Wi-Fi on both; open the phone's address in Safari on the
  Mac; the app must be in the foreground with the screen on. Guest networks often block devices
  from seeing each other.
- **Frames drop, low fps**: lower `stream.wide_width` or `stream.roi_quality` on the Experiments
  page; the Dashboard shows drops on the phone and in the engine separately. The phone also warns
  about heat and low light.
- **Eyes not found**: more light on your face, the phone level with your eyes, less than a metre
  away. Faces smaller than about 90 px across in the downscaled picture are not found; zoom in.
- **Blurry eyes**: click an eye in the Aim preview to focus there, then lock focus.
- **Image sideways or upside down**: Experiments > `stream.rotation`: set a fixed rotation
  instead of `auto`.
- **The cursor does not move**: Accessibility permission (above), then restart the engine; check
  **System cursor** is on and that you did not start with `--no-cursor`.
- **Shortcuts do nothing**: Input Monitoring permission. There are reports of `pynput` crashing
  on macOS 26 with Python 3.14; use Python 3.12, or turn shortcuts off (`--no-hotkeys`).
- **Port 8765 already in use**: another engine is running; stop it or use `--port 8766`.
- **Start over**: delete `~/.phonegaze/config.json` (settings) and `~/.phonegaze/profiles/`
  (saved calibrations).

## Developers

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m pytest                       # all Python tests (about a minute)
node tests/ui/ui_e2e.cjs                         # browser UI against the simulator
node tests/ui/accuracy_e2e.cjs arkit camera      # accuracy against the simulator (about 6 min)
.venv/bin/python -m phonegaze.sim --mode camera  # the simulated phone on its own, port 8081
```

The end-to-end scripts need Node 22 and Playwright with Chromium. CI runs all of them on Linux,
the run script and a short simulator run on macOS, and compiles the iPhone app
(`.github/workflows/phone-gaze.yml`).
