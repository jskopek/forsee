# Eye capture test bed: handoff

Instructions for an agent picking this work up on a Mac with Xcode and an iPhone attached. Read
`tools/eye-capture/README.md` first; it explains what the tool does, how to run it, and the data
format. This file covers what is left to do.

## Where things stand

- **Branch:** `claude/modest-keller-tzw1nz` in `jskopek/forsee`, open as pull request #31. Push
  further work to the same branch.
- **Code:** everything is under `tools/eye-capture/`.
- **Not verified:** the iOS app (`ios/EyeCapture/*.swift`) has never been compiled or run. It was
  written without Xcode and has passed a syntax check only.
- **Verified:** `controller.html` and `pull_session.py`, end to end against `dev/mock_phone.py`
  (multi-camera run, moving dot, ARKit row, stopping with Esc, download and summary).
- **Not written:** any analysis code. That was deliberate, pending one real recording.

## Why this exists

The project needs gaze tracking from cheap, off-the-shelf hardware. Ordinary webcam tracking
reaches about 1.5–2° at best, against 0.5–1° for infrared trackers. The limit is pixels on the
eye: a 1080p webcam at 60 cm sees 1° of eye rotation as about half a pixel of iris movement.

The idea under test is to use a phone as a dedicated eye camera, with its zoom lenses. Estimated
eye detail for 4K video at 60 cm (calculated, not measured):

| Camera       | Pixels per 1° of eye rotation | Iris width | Width of view at the face |
| ------------ | ----------------------------- | ---------- | ------------------------- |
| 1080p webcam | ~0.5                          | ~27 px     | ~84 cm                    |
| Phone 1×     | ~0.9                          | ~50 px     | ~90 cm                    |
| Phone 2×     | ~1.8                          | ~100 px    | ~45 cm                    |
| Phone 3×     | ~2.9                          | ~160 px    | ~28 cm                    |
| Phone 5×     | ~4.5                          | ~250 px    | ~18 cm                    |

Open questions the test bed should answer, in order:

1. How close can each lens focus? Telephoto lenses may not focus at arm's length.
2. How much iris detail does each camera really resolve at a practical mounting distance?
3. Is the front camera (with Apple's face tracking) or a back camera the better source?
4. Can a model on close-up eye video beat the webcam figures above?

## Task 1: make the app build

1. Open `tools/eye-capture/ios/EyeCapture.xcodeproj`. Set the signing team on the EyeCapture
   target. Change the bundle identifier if Xcode says `org.forsee.EyeCapture` is taken.
2. Build for a real device and fix compile errors. Keep the fixes minimal; do not restructure.
3. The project lists files explicitly. If you add or remove a Swift file, regenerate it with
   `ruby tools/eye-capture/ios/generate_project.rb` (needs `gem install xcodeproj`).

Places most likely to need a fix, since they were written from memory of the APIs:

- `CaptureCoordinator.swift`: the camera intrinsics attachment (`CMGetAttachment` cast to `Data`,
  then `loadUnaligned`), `secondaryNativeResolutionZoomFactors`, `synchronizationClock`, the
  `CIImageRepresentationOption` JPEG quality key, and the ARKit delegate methods sharing a class
  with the AVFoundation delegate.
- `HTTPServer.swift`: Network.framework listener and the keep-alive request loop.
- `generate_project.rb` build settings: `INFOPLIST_KEY_NSLocalNetworkUsageDescription` may not be
  a key Xcode honours. If the Info.plist lacks it, add it another way.

The project uses Swift 5 language mode on purpose, to avoid strict-concurrency errors. Leave it.

## Task 2: check it works on the phone

Run the app, open the address it shows from a browser on the Mac, and check each of these. Fix
what fails.

- **Connection:** the page loads and lists the phone's cameras. If the browser cannot connect,
  look at the local network permission first.
- **Each camera previews:** press Preview on every row, both sides. The live line should show the
  resolution and frame rate that were asked for. A mismatch means the session replaced the chosen
  format (see `startCamera`, which sets `.inputPriority` and holds the device lock).
- **Closest focus:** note the "Closest focus" value for every lens. This answers open question 1.
- **Click to focus:** clicking the left preview should move the detail crop and refocus there.
  The preview is the raw sensor image, so check the click lands where expected in landscape and
  that nothing is mirrored or rotated unexpectedly.
- **2× row:** confirm the 2× sensor-crop row gives real extra detail in the detail crop and is not
  an upscale of the 1× image.
- **Short run:** 9 dots, no moving dot, one camera. Then confirm:
  - the `.mov` plays and `ffprobe` reports the same frame count as rows in `frames.csv`;
  - `clockCheck` in `<camera>.json` shows the three clocks agreeing, and the first `t` in
    `frames.csv` is within a fraction of a second of them. If not, frame times and dot times are
    on different clocks and nothing downstream can be trusted;
  - `framesSkipped` and `framesDropped` are zero or close to it at 4K 30 fps. If frames are lost,
    the previews made on the frame queue are the first suspect;
  - `intrinsics` is present in `<camera>.json`.
- **ARKit row:** runs, reports "face found", and `frames.csv` has populated transform columns.
  Then switch back to an ordinary camera and confirm it still starts.
- **Download:** `python3 tools/eye-capture/pull_session.py <address>` copies a real session,
  including a video of several hundred megabytes, and the sizes match.
- **Heat:** run all back cameras with 25 dots and the moving dot. Note the thermal state in each
  `<camera>.json` and whether frame loss rises towards the end.

Update the Status section of `README.md` once the app builds and runs.

## Task 3: record a first data set

With the owner's help (they are the participant):

1. Mount the phone in landscape, below the screen, at the distance it would have on a wheelchair
   or desk mount. Measure and enter the distances the form asks for.
2. Record one run of all back cameras, then turn the phone round and record one run of the front
   cameras including the ARKit row. Use 25 dots and the 20 s moving dot.
3. If a lens cannot focus at that distance, record a second back run at the nearest distance
   where it can, and note the distance.
4. Pull both sessions. Recordings go in `tools/eye-capture/captures/`, which git ignores. Do not
   commit video.

## Task 4: first analysis

Put analysis scripts in `tools/eye-capture/analysis/` (Python). Work in this order, and report
numbers at each step before moving on.

1. **Sanity:** per recording, check frame counts, frame-time gaps, and that the clock offset
   measured before and after the recording differs by only a few milliseconds.
2. **Eye detail per camera:** on frames from the settled part of each dot (skip the first 0.7 s),
   measure iris diameter in pixels and a sharpness score on the eye region. Compare against the
   table above. This answers open question 2 and is worth reporting to the owner on its own.
3. **Finding the eyes in zoomed frames:** this is the first real unknown. At 3× and 5× the frame
   shows only part of the face, so ordinary face detectors may fail. Try MediaPipe Face Landmarker
   first; if it fails, locate the eyes directly.
4. **Apple baseline:** from the ARKit recording, fit a simple regression from the eye and head
   columns to the dot position, and report leave-one-dot-out error in degrees (use `pixelsPerCm`
   and the eye-to-screen distance from `meta.json`).
5. **First close-up model:** fit the iris edge as an ellipse in visible light, combine it with eye
   corners or head position, and regress to the dot position per camera. Report the same error in
   degrees so cameras, and the Apple baseline, can be compared directly. This answers open
   questions 3 and 4.
6. **Screen reflection:** check whether the computer screen's reflection is visible on the cornea
   in the most zoomed recordings (expected to be tens of pixels wide at 5×). If it is, note it;
   it could make tracking far less sensitive to head movement.

Use the fixation dots for fitting and evaluation. Treat the moving-dot data as extra training
data, since the eye lags the dot slightly.

## Ground rules

- Commit to `claude/modest-keller-tzw1nz` and push there; pull request #31 picks the commits up.
- CI runs `prettier --check .`, so format Markdown and HTML with the repo's prettier before
  committing. Keep JavaScript inline in `controller.html`; a separate `.js` file would be linted
  by the repo's ESLint config, which does not allow browser globals there.
- After changing `controller.html`, re-test it against `dev/mock_phone.py`.
- Report plainly what was verified on a device and what was not.
