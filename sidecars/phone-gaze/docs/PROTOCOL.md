# Phone wire protocol

The exact contract between the iPhone app (`tools/eye-capture/ios`), the simulator
(`phonegaze.sim`) and the engine's phone client (`phonegaze/phone.py`). It extends what the app
already serves; nothing existing is removed or renamed.

Status: the existing routes are implemented in Swift and work on a real phone. The new routes
(`/api/zoom`, `/api/lens`, `/api/stream/config`, `/stream`) are implemented in the app (version
0.2) and compile in CI, but have not been run on a phone. Since app 0.2.2 CI also runs the app in
the iOS Simulator with its synthetic test-pattern camera and checks it with the engine's own
phone client (`engine/tests/realapp_phone_app.py`); that covers the wire format, rectangles,
zoom reporting, back-pressure and the ARKit block's layout, not the real camera or ARKit. Facts marked **(verify on device)** are derived from documentation, not observed.

## Transport

- Plain HTTP/1.1 on port 8080, no TLS, no authentication (local network only). JSON bodies are
  UTF-8 objects; request bodies are at most 16 MiB.
- Every error is a JSON body `{"error": "<human-readable text>"}` with status 400 (bad request),
  404 (no such route or file), 409 (conflict, for example recording in progress) or 503 (not
  ready).
- JSON keys on the wire are camelCase. Numbers are JSON numbers; NaN and infinity are never sent
  (the field is omitted or `null`).

## Conventions

| Thing                  | Convention                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Time                   | Seconds on the phone's host clock (`CACurrentMediaTime()`, seconds since boot). Capture timestamps, `/api/time`, ARKit `ARFrame.timestamp` and motion timestamps all use it.                           |
| Sensor image           | The buffer exactly as the camera delivers it: landscape, never rotated, never mirrored (front camera included).                                                                                        |
| Pixel coordinates      | Continuous: pixel `(i, j)` covers `[i, i+1) × [j, j+1)`; origin top-left, x right, y down. A full frame spans `[0, width] × [0, height]`.                                                              |
| Normalised coordinates | Fractions of the sensor image's width and height, origin top-left, 0 to 1. Used for requested ROIs and focus points.                                                                                   |
| Rectangles             | `[x, y, w, h]` (JSON array) or `{"x", "y", "w", "h"}` (JSON object, requests only): top-left corner and size.                                                                                          |
| Matrices               | 4×4 `simd_float4x4` as 16 numbers, **column-major**: `[c0r0, c0r1, c0r2, c0r3, c1r0, …, c3r3]`. The translation is elements 12, 13, 14. Same layout as the app's CSV columns `<name>_c<column>r<row>`. |
| Gravity                | `[x, y, z]` in g, Core Motion device frame: x to the right of the screen held in portrait, y towards the top of the phone, z out of the screen. Lying flat face up gives about `[0, 0, -1]`.           |
| Rotation rate          | `[x, y, z]` rad/s, same frame as gravity.                                                                                                                                                              |
| Units                  | Metres for ARKit positions, degrees for fields of view, seconds for exposure.                                                                                                                          |

### Sensor axes and turning images upright (verify on device)

The engine turns every image upright from gravity. It assumes these sensor axes, expressed in the
gravity frame above (`phonegaze/types.py`, `SENSOR_AXES_IN_DEVICE`):

| Camera | Image +u (right) is device | Image +v (down) is device | Upright when the phone is held…         |
| ------ | -------------------------- | ------------------------- | --------------------------------------- |
| back   | −y                         | −x                        | landscape, top of the phone to the left |
| front  | +y                         | −x                        | landscape, top of the phone to the left |

If faces come out upside down on the owner's phone, fix that table in one place, or set
`stream.rotation` in the engine config.

### ARKit spaces (as the app writes them)

- **World**: ARKit world space, right-handed, y up (gravity alignment), metres.
- **Camera** (`camera` matrix, camera → world): +x along the sensor image's +u (landscape), +y up
  the image (−v), +z out of the screen towards the user; the camera looks down −z. To get engine
  camera coordinates (x right, y down, z forward, in sensor orientation) multiply by
  `diag(1, −1, −1)`.
- **Face** (`face` matrix, face → world): origin behind the nose, +x towards the viewer's right
  (the person's own left), +y up, +z out of the face towards the camera.
- **Eyes** (`leftEye`, `rightEye`, eye → face): each eye looks along its own +z. `leftEye` is the
  person's own left eye.
- **lookAt**: a point in face space, metres. Only its direction is meaningful.
- Face in camera space: `inverse(camera) · face`; an eye in camera space:
  `inverse(camera) · face · leftEye`.

## Existing routes (unchanged)

| Route                         | Body                                                | Answer                                                 |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `GET /`                       |                                                     | The controller page (HTML).                            |
| `GET /api/time`               |                                                     | `{"t": number}` phone clock now.                       |
| `GET /api/status`             |                                                     | Status object (below).                                 |
| `POST /api/configure`         | `{"cameraId", "maxWidth"=3840, "fps"=30, "zoom"=1}` | Status. Restarts the camera; blocks until it runs.     |
| `POST /api/stop`              |                                                     | Status. 409 while recording.                           |
| `POST /api/focus`             | `{"x"?, "y"?, "locked"?}` (x, y normalised)         | Status. Focus and expose on the point; lock or unlock. |
| `GET /preview.jpg`            | query `kind=full` or `kind=crop&cx&cy&w`            | JPEG.                                                  |
| `POST /api/session/start`     | `{"label", "meta"}`                                 | `{"sessionId"}`                                        |
| `POST /api/events`            | `{"sessionId", "events": [...]}`                    | `{"stored": n}`                                        |
| `POST /api/record/start`      | `{"sessionId", "segment"}`                          | `{"segment"}`                                          |
| `POST /api/record/stop`       |                                                     | Segment summary.                                       |
| `GET /api/sessions`           |                                                     | `{"sessions": [...]}`                                  |
| `POST /api/sessions/delete`   | `{"sessionId"}`                                     | `{"sessions": [...]}`                                  |
| `GET /files/<session>/<file>` |                                                     | The file.                                              |

`cameraId` `"arkit-face"` selects the front TrueDepth camera through ARKit face tracking.
`"test-pattern"` (camera mode) and `"test-pattern-arkit"` (ARKit mode with a synthetic face) select
the app's synthetic camera, see [Test pattern](#test-pattern).

The status object is `{"app": {"name", "version"}, "time", "system": {...}, "cameras": [...],
"state": {...}}`. Each camera is `{"id", "name", "position": "front"|"back", "type":
"wide"|"ultrawide"|"tele"|"arkit", "minFocusDistanceMM", "canFocus", "formats": [{"width",
"height", "maxFps"}], "zoomPresets": [number], "fieldOfView"?}`. `state` is `{"mode":
"idle"|"camera"|"arkit", "cameraId", "cameraName", "position", "width", "height",
"requestedFps", "measuredFps", "zoom", "minFocusDistanceMM", "binned", "focusLocked",
"adjustingFocus", "faceTracked", "interrupted" (app 0.2.1+: why the camera stopped, or ""), "recording", "segment", "framesWritten", "framesSkipped",
"framesDropped", "lastError", "fieldOfView"?, "lensPosition"?, "iso"?, "exposureSeconds"?,
"intrinsics"?: {"fx", "fy", "cx", "cy", "width", "height"}, "gravity"?: [x, y, z]}`.

Camera entries may add `"testPattern": true` (the synthetic camera; listed only where the device
has no camera, such as the iOS Simulator, but selectable by id everywhere), `"depthSource": "lidar"` (the back wide camera opened through the LiDAR
depth device; experimental, listed only on phones with LiDAR, `type` stays `"wide"`) or
`"truedepth"` (the ARKit entry).

New fields added to `state` by this protocol: `"zoomRange": [min, max]` (the running camera's
allowed zoom), `"nativeZoomFactors"` (the active format's `secondaryNativeResolutionZoomFactors`),
`"cameraType"`, `"depthSource"` (when a depth source runs), `"lens"` (the latest frame's `lens`
block), `"lowLight"` (bool), `"testPattern": true` (while the test pattern runs), and `"stream":
{"clients", "sent", "dropped", "skipped", "bytes", "fps", "mbps", "lastFrameBytes", "connections",
"encodeMs", "encodeMsMax", "lastError"?}`. `encodeMs` is a running average of the time to build one
frame message (crops, JPEG encoding, framing), `encodeMsMax` the largest in the last second;
`lastError` names the last stream problem (a client dropped for not reading, a frame that could
not be encoded).

## New routes

### `POST /api/zoom`

Body `{"zoom": number}`. Sets `videoZoomFactor` on the running camera without restarting it
(clamped to the device's range). Answer: status. 409 in ARKit mode or when idle. Takes effect
within a frame or two; frames carry the zoom they were captured with.

### `POST /api/lens`

Body: any subset of `{"focusLocked", "exposureLocked", "whiteBalanceLocked",
"faceDrivenAutoFocus"}` (bools), `"exposureBias"` (EV, clamped to the device's range) and
`"maxExposureS"` (seconds: caps the shutter time automatic exposure may choose, which reduces
motion blur at the cost of noise; `null` removes the cap; needs automatic exposure, else 400).
Answer: status. 409 in ARKit mode or when idle; unknown keys or wrong types are 400. Every
`frame` reports the result in `lens`.

### `GET /api/stream/config`

Answer: the full effective stream config.

### `POST /api/stream/config`

Body: any subset of the stream config; omitted fields keep their current values (so the engine
can send just `{"rois": [...]}` at frame rate). Answer: the full effective config. Defaults:

```json
{
  "maxFps": 30,
  "wide": { "enabled": true, "width": 640, "quality": 0.6, "every": 1 },
  "rois": [],
  "roiQuality": 0.9,
  "roiSource": "mac",
  "roiSize": { "w": 0.12, "h": 0.07 },
  "arkit": true,
  "depth": false
}
```

| Field          | Type                                    | Meaning                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFps`       | number                                  | Upper bound on frames sent per second. Frames beyond it are skipped (not counted as dropped).                                                                                                                                                  |
| `wide.enabled` | bool                                    | Send the downscaled whole frame.                                                                                                                                                                                                               |
| `wide.width`   | integer px                              | Width of the downscaled frame; height keeps the aspect ratio. Never upscaled.                                                                                                                                                                  |
| `wide.quality` | number 0–1                              | JPEG quality.                                                                                                                                                                                                                                  |
| `wide.every`   | integer ≥ 1                             | Send the wide part on every Nth frame accepted for sending (counted from the first after a client connects, not from `seq`); ROIs go on every frame.                                                                                           |
| `rois`         | array of `{"name", "x", "y", "w", "h"}` | Used when `roiSource` is `"mac"`. Normalised sensor rectangles, at most 4, names unique, `[A-Za-z0-9_]{1,32}`. Cut at the delivered buffer's full resolution.                                                                                  |
| `roiQuality`   | number 0–1                              | JPEG quality of ROI parts.                                                                                                                                                                                                                     |
| `roiSource`    | `"mac"`, `"arkit"`, `"vision"`          | `"arkit"`: two ROIs named `left_eye` and `right_eye` of size `roiSize` centred on ARKit's eye positions (ARKit mode only; no ROIs while the face is not tracked). `"vision"`: the same, centred by on-phone face landmarks (optional feature). |
| `roiSize`      | `{"w", "h"}` normalised                 | ROI size for `"arkit"` and `"vision"`.                                                                                                                                                                                                         |
| `arkit`        | bool                                    | Include the `arkit` block in ARKit mode.                                                                                                                                                                                                       |
| `depth`        | bool                                    | Include a depth part when a depth source runs (optional feature).                                                                                                                                                                              |

The phone clamps each ROI to the frame and rounds it outwards to even integer pixels; the `rect`
in each part says what was actually cut. Invalid bodies, including unknown keys, get 400 and
change nothing. `"vision"` runs Apple's face landmarks at most 5 times a second (once a second
while no face is found) and reuses the last answer for up to 1 s; it tries all four image
orientations, and names the eyes by their position in the upright picture.
`capabilities.roiSources` in `hello` lists what the phone supports; asking for anything else is a 400.

### `GET /stream`

A long-lived response: status 200, `Content-Type: application/x-pgz1`, `Cache-Control:
no-store`, `Connection: close`, **no** `Content-Length` and no chunked encoding. The body is a
sequence of PGZ1 messages until either side closes the connection. One stream client at a time: a
new `GET /stream` closes the previous one. Other routes keep working on other connections while
a stream is open.

The first message is always `hello`. Then `frame` messages as frames are captured and `status`
messages about once a second (and immediately after a configuration change).

**Back-pressure.** The phone keeps at most one message being written and drops any newer frame
while it is busy (it never queues frames). A frame is also dropped while the previous one is
still being JPEG-encoded. `dropped` in the next frame header counts frames dropped since the
previous sent frame (frames dropped while a frame is being encoded count in the frame after it),
so with no `maxFps` skipping, `seq − previous seq − 1 == dropped` for consecutive frames. `status` messages are never dropped; they wait in a short queue, and a
client that lets 16 of them pile up is disconnected.

**Heat.** When iOS reports the thermal state `serious`, `maxFps` is capped at 30; at `critical`,
at 15, and the wide part is not sent. Frames sent under a cap carry `"thermalCapFps"`.

When no camera is running the stream stays open and sends only `status`.

## PGZ1 framing

Each message:

| Offset | Size         | Content                                                 |
| ------ | ------------ | ------------------------------------------------------- |
| 0      | 4            | ASCII `PGZ1` (`50 47 5A 31`)                            |
| 4      | 4            | `N`, header length in bytes, unsigned 32-bit big-endian |
| 8      | N            | Header: UTF-8 JSON object, at most 1 MiB                |
| 8 + N  | sum of parts | Part payloads back to back, in `header.parts` order     |

Every header has `"type"`: `"hello"`, `"frame"` or `"status"`. Readers skip messages of any other
type (their parts are still consumed using `parts[].bytes`). `"parts"` is optional and only
present when there are payloads; each descriptor's `"bytes"` gives the payload length (at most 64
MiB). There is no padding, checksum or terminator; a bad magic means the stream is broken and the
reader must reconnect.

Test vector: `sidecars/phone-gaze/engine/tests/data/pgz1_vector.bin` (hello, frame with two
`gray8` parts, status) and the expected decode in `pgz1_vector.json`. `tests/make_vector.py`
regenerates both. Any implementation must decode the `.bin` to exactly those headers and parts.

### Part descriptor

```json
{
  "name": "left_eye",
  "kind": "roi",
  "format": "jpeg",
  "bytes": 48213,
  "width": 384,
  "height": 224,
  "rect": [2410, 1022, 384, 224]
}
```

| Field             | Type                       | Meaning                                                                                                                               |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | string                     | `"wide"`, an ROI name, or `"depth"`. Unique within the message.                                                                       |
| `kind`            | `"wide"`,`"roi"`,`"depth"` | What it is.                                                                                                                           |
| `format`          | string                     | `"jpeg"`; `"gray8"` (uint8, row-major, `width × height` bytes); `"depth16"` / `"depth32"` (little-endian float16 / float32 metres).   |
| `bytes`           | integer                    | Payload length.                                                                                                                       |
| `width`, `height` | integer px                 | Size of the encoded image (sensor orientation, not rotated).                                                                          |
| `rect`            | `[x, y, w, h]` sensor px   | The source region. Part pixel `(px, py)` corresponds to sensor `(x + px·w/width, y + py·h/height)`. The wide part has `[0, 0, W, H]`. |

### `hello` header

```json
{
  "type": "hello",
  "protocol": 1,
  "t": 1000.0,
  "app": { "name": "EyeCapture", "version": "0.2" },
  "device": { "model": "iPhone16,2", "system": "iOS 18.1" },
  "capabilities": {
    "arkit": true,
    "depth": false,
    "roiSources": ["mac", "arkit"],
    "formats": ["jpeg"],
    "maxRois": 4,
    "depthSources": [],
    "depthFormats": ["depth32"],
    "fps60": true,
    "zoom": true,
    "lensControl": true
  },
  "cameras": [],
  "streamConfig": {},
  "state": {}
}
```

`cameras` and `state` are as in `/api/status`; `streamConfig` is the effective stream config.
`capabilities.roiSources` is `["mac", "arkit", "vision"]` on phones with TrueDepth (no
`"arkit"` otherwise); `depthSources` lists `"truedepth"` and/or `"lidar"`; `fps60` says whether
any camera has a 60 fps format (ask for it with `/api/configure {"fps": 60}`; the app falls back
to 30 if the chosen size cannot do it).
`capabilities.testPattern` (app 0.2.2+) says the test pattern can be selected.
`protocol` is 1 for this document; the engine refuses a larger major version.

### `frame` header

| Field           | Type              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`           | integer           | Increments for every captured frame (skipped and dropped frames included), so gaps are visible.                                                                                                                                                                                                                                                                                                                   |
| `t`             | number s          | Capture timestamp, phone clock.                                                                                                                                                                                                                                                                                                                                                                                   |
| `tSent`         | number s          | Phone clock when the message was finished (after JPEG encoding), just before it is handed to the network.                                                                                                                                                                                                                                                                                                         |
| `mode`          | string            | `"camera"` or `"arkit"`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `dropped`       | integer           | Frames dropped for back-pressure since the previous sent frame.                                                                                                                                                                                                                                                                                                                                                   |
| `camera`        | object            | Below.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lens`          | object            | `position` (lensPosition 0–1), `adjustingFocus`, `adjustingExposure`, `iso`, `exposureS` (s), `focusLocked`, `exposureBias` (EV), `exposureOffset` (EV, metered minus target), `exposureLocked`, `whiteBalanceLocked`, `faceDrivenAutoFocus`, `maxExposureS` (when capped), `lowLight` (ISO within 5 % of the maximum and still more than 1 EV too dark). ARKit mode sends only `exposureS` and `exposureOffset`. |
| `gravity`       | `[x, y, z]` g     | Latest device-motion gravity.                                                                                                                                                                                                                                                                                                                                                                                     |
| `rotationRate`  | `[x, y, z]` rad/s | Latest device-motion rotation rate.                                                                                                                                                                                                                                                                                                                                                                               |
| `parts`         | array             | Part descriptors.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `arkit`         | object            | ARKit mode only (and `streamConfig.arkit`): below.                                                                                                                                                                                                                                                                                                                                                                |
| `depth`         | object            | Only when `streamConfig.depth` is true and a depth source runs: `{"source": "truedepth" or "lidar", "t", "width", "height", "atRois": {name: metres or null}, "part"?: "depth"}`. `atRois` is the median depth in a 5×5 window at each cut ROI's centre. The `depth` part (`depth32`) is sent only when the map is new (TrueDepth is about 15 Hz).                                                                |
| `roiSource`     | string            | The `roiSource` the ROIs in this frame came from.                                                                                                                                                                                                                                                                                                                                                                 |
| `thermalCapFps` | number            | Present when heat limits the frame rate (see Back-pressure).                                                                                                                                                                                                                                                                                                                                                      |
| `testPattern`   | object            | Test pattern only: what was drawn (below).                                                                                                                                                                                                                                                                                                                                                                        |
| `sim`           | object            | Simulator only: ground truth (below).                                                                                                                                                                                                                                                                                                                                                                             |

`camera`:

| Field                   | Type       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | string     | Camera id as in `/api/status` (`"arkit-face"` in ARKit mode).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `position`              | string     | `"front"` or `"back"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `type`                  | string     | `"wide"`, `"ultrawide"`, `"tele"`, `"arkit"`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `zoom`                  | number     | `videoZoomFactor` read when the frame was delivered (1 in ARKit mode). After `/api/zoom` the image can lag this by a frame or two.                                                                                                                                                                                                                                                                                                                                              |
| `zoomStable`            | bool       | False for frames captured within 0.25 s of a zoom change (capture time, not delivery time); the engine holds its output and skips calibration for them.                                                                                                                                                                                                                                                                                                                         |
| `width`, `height`       | integer    | Sensor buffer size in pixels.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fx`, `fy`, `cx`, `cy`  | number px  | Intrinsics for this frame in sensor pixels: the per-frame `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix` (camera mode) or `ARCamera.intrinsics` (ARKit). Omitted if unavailable.                                                                                                                                                                                                                                                                                          |
| `intrinsicsSource`      | string     | `"attachment"`, `"arkit"`, `"sim"` or `"test"`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `intrinsicsIncludeZoom` | bool       | `true` if `fx…cy` already describe the zoomed buffer. The app sends `false` for the attachment (the matrix is believed to describe the unzoomed sensor; **verify on device**) and `true` for ARKit. When `false` the engine compares both readings (as sent, and scaled about the image centre by `zoom`) with the intrinsics implied by `fieldOfView`, uses the one within 25 % and logs which; if neither matches it uses `fieldOfView`, and without `fieldOfView` it scales. |
| `fieldOfView`           | number deg | Horizontal field of view of the active format at zoom 1.                                                                                                                                                                                                                                                                                                                                                                                                                        |

`arkit`:

| Field         | Type                                | Meaning                                                                                                                                                       |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracked`     | bool                                | `ARFaceAnchor.isTracked`. Matrices may be stale when false.                                                                                                   |
| `face`        | 16 numbers or `null`                | Face → world, column-major.                                                                                                                                   |
| `leftEye`     | 16 numbers or `null`                | Person's left eye → face.                                                                                                                                     |
| `rightEye`    | 16 numbers or `null`                | Person's right eye → face.                                                                                                                                    |
| `camera`      | 16 numbers                          | `ARCamera.transform`, camera → world.                                                                                                                         |
| `lookAt`      | `[x, y, z]` m or `null`             | `lookAtPoint`, face space.                                                                                                                                    |
| `blendShapes` | object name → 0–1                   | The 14 eye blend shapes, names as the app's CSV (`blink_left`, …). Empty when no face anchor exists.                                                          |
| `eyePixels`   | `{"left": [u, v], "right": [u, v]}` | Eye centres projected into sensor pixels (`ARCamera.projectPoint` with `.landscapeRight` and the buffer size). Omitted when not tracked or behind the camera. |

### Test pattern

The app's synthetic camera (`tools/eye-capture/ios/EyeCapture/TestPattern.swift`) for the iOS
Simulator and wire tests. Its frames take the same path as camera frames (crop, JPEG, framing,
back-pressure, recording, previews). Sizes 1920×1440, 1280×960 or 640×480 (the largest within
`maxWidth`), up to 60 fps, zoom 1 to 3, field of view 60°, intrinsics `fx = fy = (W/2) / tan 30°`,
`cx = W/2`, `cy = H/2` sent unzoomed with `intrinsicsSource: "test"` and `intrinsicsIncludeZoom:
false` (like the camera's attachment). Without motion data (the Simulator) gravity is `[-1, 0, 0]`,
which makes the sensor image upright. Lens settings are validated as for a camera, remembered and
reported in `lens`.

The picture: light grey background (luma 180 with fixed noise of ±12), two flat dark discs (luma
40), each with a bright spot (luma 250) up and to the right of its centre. Every frame carries
`"testPattern": {"version": 1, "zoom", "discs": [{"name", "x", "y", "r", "spotX", "spotY",
"spotR"}]}` in sensor pixels, so a receiver can check rectangles and coordinates by finding the
discs. The disc on the image's right is `left_eye`. With `"test-pattern-arkit"` the frame also has
an `arkit` block in the real layout: a face 0.45 m from the camera (camera transform identity)
looking at it, eyes at the discs, `eyePixels` at the disc centres, blend shapes 0; `roiSource:
"arkit"` places ROIs there. Phones without a camera list `"arkit"` in `roiSources` for it.

### `status` header

`{"type": "status", "t": number, "state": {...}, "stream": {"clients", "sent", "dropped"}}`.
`state` is the same object as in `/api/status`.

## Simulator extensions

The simulator serves every route above, plus:

- `POST /sim/gaze {"x", "y"}`: make the simulated person look at that screen point (macOS points
  of the simulated screen). Answer: `{"ok": true}`.
- `POST /sim/script {"name"}`: run a named motion script (head moves, blinks); `{"name": "still"}`
  stops it.
- `GET /sim/truth`: the latest `sim` block.

`hello` from the simulator adds `"sim": {"screen": ScreenInfo.to_dict(), "seed"}`. The engine
uses that screen instead of the Mac's when connected to a simulator. Every `frame` adds `"sim":
{"gaze": [x, y] (screen points), "leftEyeCenter": [x, y, z], "rightEyeCenter": [x, y, z] (m,
upright engine camera coordinates), "leftGazeDir", "rightGazeDir" (unit vectors, same frame),
"blink": bool, "headRotation": 3×3 row-major nested list}`. Gravity is consistent with the
rendering, so the engine's upright logic is exercised.

## Recordings

The engine stores the stream as received (`stream.pgz1`), message for message, with one extra
header key `"recv"`: the engine's `time.monotonic()` when the message was read. Replay decodes the
same framing.
