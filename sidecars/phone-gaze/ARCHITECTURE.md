# Phone Gaze: architecture and working agreement

A working eye tracker made from an iPhone and a Mac. The phone is a remote-controlled camera; the
Mac does the thinking, shows calibration, and turns gaze into a pointer.

This file is the contract between the people and agents building it. If code and this file
disagree, fix one of them on purpose.

## Goal for the first version

Something the owner can run on their own Mac and iPhone and play with: a cursor that follows their
eyes, calibration from the Mac, and many switchable experiments with a built-in way to measure
which ones help. Accuracy matters more than polish. Prefer more options and measurements over a
narrow, tidy product.

## What we know from the device (2026-11-15)

- The existing iOS app (`tools/eye-capture/ios`) compiles and runs unmodified. Its capture path,
  HTTP server, previews and recording work on a real iPhone.
- On the owner's phone at about 60 cm: the 2× sensor crop of the wide camera gives the most eye
  detail. The telephoto's closest focus is 135 cm, so it is blurry at desk distance. The ultra
  wide reports an odd zoom preset (1.78×).
- `tools/eye-capture/analysis/eyes.py` already finds eyes and fits the iris edge on that real
  footage. Reuse it; it is the only vision code here that has seen real data.
- Nobody building this has a Mac or an iPhone to hand. Swift is checked by compiling in GitHub
  Actions on macOS runners. Python is tested on Linux and smoke-tested on a macOS runner. Real
  camera behaviour and real accuracy cannot be checked until the owner runs it.

## Components

```
iPhone app (Swift)                    Mac engine (Python)                     Consumers
tools/eye-capture/ios                 sidecars/phone-gaze/engine
┌──────────────────────┐  HTTP+stream ┌─────────────────────────────────┐
│ camera / ARKit       │─────────────▶│ phone client → estimators       │──▶ system cursor
│ crops where told     │◀─────────────│ → gaze models → filters         │──▶ ws://…/gaze (Forsee)
│ sensors, intrinsics  │  control     │ calibration, lens choice, record│──▶ browser UI (localhost)
└──────────────────────┘              └─────────────────────────────────┘
```

- **Phone app.** Stays simple and stays in `tools/eye-capture/ios` (the owner already has it
  installed and signed). It gains a live stream. All intelligence that can live on the Mac does.
- **Engine.** A Python package, `phonegaze`, started with `python -m phonegaze`. It serves a
  browser UI on localhost for aiming, calibration and experiments.
- **Simulator.** `phonegaze.sim` pretends to be the phone (same wire protocol), with a synthetic
  face and eyes whose true gaze is known. It makes end-to-end tests possible without hardware.
- **Forsee source.** A WebSocket gaze source in `packages/gaze-web`, so the keyboard can take raw
  gaze with confidence instead of a hijacked mouse.

## Phone protocol

The existing routes stay (`/api/status`, `/api/configure`, `/api/focus`, `/api/time`, recording).
New ones:

- `POST /api/zoom {zoom}`: change zoom on the running camera without restarting it.
- `POST /api/stream/config`: what the stream carries. `wide` (downscaled whole frame: width,
  quality, every Nth frame), `rois` (named rectangles in 0–1 frame coordinates, cut at native
  resolution), `roiQuality`, `roiSource` (`"mac"` = use the rectangles sent; `"arkit"` = centre
  them on ARKit's eyes; `"vision"` = optional on-phone face landmarks).
- `GET /stream`: a long-lived response of framed messages:
  `"PGZ1"`, 4-byte big-endian header length, UTF-8 JSON header, then the binary parts listed in
  `header.parts` in order. Message types: `hello` (device and capabilities), `frame`, `status`.
- A `frame` header carries: `seq`, `t` (phone clock, seconds), `mode`, `camera` (id, position,
  type, zoom, width, height, intrinsics `fx fy cx cy` for the full frame, field of view), `lens`
  (position, adjusting, ISO, shutter), `gravity`, `rotationRate`, `parts` (name, byte count,
  pixel size, and for crops the source rectangle in frame pixels), and in ARKit mode `arkit`
  (tracked flag, face / left eye / right eye / camera transforms, look-at point, blend shapes,
  eye positions in pixels). Optional `depth` when a depth sensor is running.
- If a client is slow the phone drops frames rather than queueing them.

`sidecars/phone-gaze/docs/PROTOCOL.md` is the exact wire specification, with a binary test
vector. The Swift server and the Python client must both match it.

## Engine layout and ownership

Everything is under `sidecars/phone-gaze/engine/phonegaze/`. One owner per area; owners do not
edit each other's files. Shared types live in `types.py` and change only by adding fields.

| Area       | Files                                                                          | Does                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation | `types.py`, `protocol.py`, `config.py`                                         | Shared dataclasses, wire framing, one typed config tree saved as JSON                                                                                                                  |
| Core       | `phone.py`, `pipeline.py`, `server.py`, `recorder.py`, `replay.py`, `outputs/` | Phone client and clock sync, the frame loop, REST and WebSocket API for the UI, session recording and replay, cursor / WebSocket / dwell outputs, global hotkeys, lens and zoom choice |
| Vision     | `vision/`                                                                      | Estimators that turn a frame into an `Observation`: ARKit, face landmarks, sub-pixel iris edge, corneal reflection of the screen, optional pretrained appearance model, image quality  |
| Models     | `models/`, `calibration.py`, `filters.py`                                      | Gaze models (`Observation` → screen point), fitting, automatic model choice, quick refinement, online drift correction, smoothing, fixation and blink handling, accuracy metrics       |
| Simulator  | `sim/`                                                                         | Synthetic eyes and face, simulated phone server                                                                                                                                        |
| UI         | `web/`                                                                         | Dashboard, aiming view, calibration, validation, experiment switches                                                                                                                   |

### Conventions every area relies on

- **Upright images.** Core rotates every decoded image upright (using gravity) before any
  estimator sees it, and rotates intrinsics and rectangles to match. Estimators never see a
  sideways face.
- **Camera coordinates:** x right, y down, z forward (away from the phone, towards the user), in
  metres. ARKit's convention is converted once, in the ARKit estimator.
- **Rays, not pixels.** Features meant to survive a zoom change are expressed as directions
  through the lens (`(u − cx) / fx`), never raw pixel positions.
- **Left and right** mean the person's own left and right eye.
- **Screen coordinates** are points on the main display, origin top-left. `ScreenInfo` also holds
  the physical size in millimetres, read from macOS so the user is never asked.
- **Distance** is estimated, never asked for: from ARKit or a depth sensor when present,
  otherwise from the iris's apparent size (a human iris is close to 11.7 mm across).
- **Time.** Frames carry the phone clock; the engine keeps an offset to its own monotonic clock.

### The two central interfaces

```python
class Estimator(Protocol):
    name: str
    def process(self, frame: DecodedFrame, previous: Observation | None) -> Observation | None: ...

class GazeModel(Protocol):
    name: str
    def fit(self, samples: list[CalibSample], screen: ScreenInfo) -> FitReport: ...
    def predict(self, obs: Observation) -> GazePoint | None: ...
    def to_dict(self) -> dict: ...          # so a calibration can be saved and reloaded
```

An `Observation` holds, per eye and all optional: iris centre and radius in pixels, the fitted
iris ellipse, the screen reflection (centre, and corners if resolved), eye corners, eyelid
opening, blink, an estimated eyeball position and gaze direction in camera coordinates; plus head
rotation and position, distance, image quality numbers, and which estimator produced it. Missing
values are `None`, never zero.

## How gaze is estimated

No single method is trusted. Several are implemented, and calibration data decides.

**Estimators (what the camera sees):**

1. **ARKit** (front TrueDepth camera): Apple's eye and head transforms. Expected to work first.
2. **Landmarks** (any camera): MediaPipe face landmarks on the downscaled frame give head pose,
   eye regions and a rough iris.
3. **Iris edge:** on the native-resolution eye crops, fit the iris boundary to sub-pixel
   precision. This is where the zoom pays off.
4. **Screen reflection:** find the screen's reflection on the cornea. The iris centre relative to
   that reflection changes little when the head moves. During calibration the UI can flash a
   known pattern so the reflection can be told apart from other highlights.
5. **Appearance model** (optional): a permissively licensed pretrained network, if research finds
   one worth including.

**Gaze models (how that becomes a screen point):**

1. **Geometric:** eyeball position and gaze direction per eye form a ray; calibration solves
   where the screen is relative to the phone, plus each eye's fixed angular offset. Handles head
   movement by construction. The camera-to-screen pose it finds also yields the viewing distance.
2. **Regression:** ridge or kernel regression from ray-space features and head pose to the screen.
3. **Reflection-based:** polynomial map from the iris-to-reflection vector.
4. **Blends** of the above, and a learned residual on top of the geometric model.

**Choosing:** after calibration every candidate model is scored by leave-one-dot-out error, and
the best is used unless the user pins one. The UI shows the scores.

**Calibration tiers:**

- **Full:** a grid of dots, optionally followed by a moving dot, optionally repeated with the head
  in a few different positions so head compensation is learned rather than assumed.
- **Quick refine:** one dot corrects an offset; three to five re-solve the screen position while
  keeping what was learned about the person. Meant for "I sat back down" or "the phone got bumped".
- **Validate:** fresh dots, never used for fitting. Reports accuracy and precision in degrees for
  every model, so experiments can be compared.
- **Drift correction:** optional slow adaptation from known look-points (dwell selections reported
  by Forsee, or mouse clicks).
- What is learned is stored in three layers: the person, the physical setup, and the session.

**Lens and zoom:** an aiming step tries the available cameras and zooms, measures iris size in
pixels and sharpness for each, and picks the best that is in focus. While running, the engine
switches between 1× and 2× on the same camera when the eyes near the edge of the frame. Because
features are rays, calibration survives the switch.

**Outputs:** system cursor (needs macOS Accessibility permission), optional dwell click, a
WebSocket stream of gaze samples (`x, y, t, confidence, valid`), and the browser UI. Global
shortcuts: recalibrate, quick refine, validate, pause.

## Testing

- **Simulator loop:** simulated phone → engine → calibration driven in a headless browser →
  measured accuracy against the simulator's true gaze. This must pass before anything is called
  working.
- **Unit tests** per area, each owner running only their own.
- **CI:** Linux tests; a macOS job that installs the engine and runs its tests; an iOS job that
  compiles the app with code signing off.
- **Replay:** recorded sessions, including `tools/eye-capture` recordings, can be run back through
  any estimator and model to score them offline.

## Ground rules

- Work on branch `claude/modest-keller-tzw1nz` (open as pull request #31). Do not open another
  pull request.
- Never commit images or video of a real person's face or eyes. Recordings, crops, profiles and
  downloaded models go in ignored folders.
- The repo's CI runs `prettier --check .` and `eslint .`. Markdown, HTML, CSS, JSON, YAML and
  JavaScript added here must pass both.
- Say plainly what was verified and how. "Compiles in CI" and "passes against the simulator" are
  different from "works on the phone", and nothing here has been run on the phone.
