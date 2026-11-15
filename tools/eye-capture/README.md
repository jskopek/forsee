# Eye capture test bed

A small iPhone and iPad app for recording eye video with known gaze targets. It exists to answer
three questions with real data:

- Which phone camera gives the most usable picture of the eyes: front, back wide, back 2×, or back
  telephoto?
- How close can each lens focus, and how much iris detail does it resolve at a normal mounting
  distance?
- Can a gaze model trained on close-up eye video beat ordinary webcam tracking?

The phone is only the camera. The dots you look at are shown on your computer's screen, by a
controller page that the phone serves over Wi-Fi. That page is also the remote control, because
the phone's own screen faces away from you when the back cameras point at your face.

## Status

- **The iOS app has not been compiled or run yet.** It was written without access to Xcode, so
  expect a few compile errors on the first build. The Swift files pass a syntax check only.
- **The controller page and `pull_session.py` are tested** end to end against `dev/mock_phone.py`.

## Build and install

You need a Mac with Xcode 15 or later and an iPhone or iPad on iOS 16 or later.

1. Open `ios/EyeCapture.xcodeproj` in Xcode.
2. Select the EyeCapture target, open Signing & Capabilities, and choose your team. If Xcode says
   the bundle identifier is taken, change it to anything unique.
3. Plug in the phone, choose it as the run destination, and press Run.
4. Allow camera access when the app asks.

The app shows an address such as `http://192.168.1.23:8080`. Open it in a browser on the computer
whose screen you will look at. Both devices must be on the same Wi-Fi network.

## Record a session

1. Mount the phone in landscape, close to the screen (below it is best), pointing at your face.
   Keep it plugged in: recording 4K video heats the phone and drains the battery.
2. On the controller page, choose Back cameras or Front cameras. Front and back are separate runs,
   because the phone has to be turned round.
3. Press Preview on the widest camera. Turn the phone until both eyes sit inside the smallest
   dashed box; that box is what the most zoomed-in ticked camera will see.
4. Click an eye in the left picture. The phone focuses there, and the right picture shows that
   spot at full sensor resolution. Preview each camera in turn to see which ones are sharp.
5. Fill in "About this run". The screen diagonal and your distance from the screen are required,
   because they turn pixels into degrees.
6. Press Start run. For each ticked camera the page shows a grid of dots, then a slowly moving
   dot. Look at the centre of each dot and keep your head still. Esc stops early.

The "Closest focus" column is what iOS reports for each lens. Telephoto lenses often cannot focus
at arm's length, and the page warns when your eyes are closer than a lens can focus.

The "Front TrueDepth camera with ARKit face tracking" entry records Apple's own head and eye
estimates alongside the video. It is the baseline any new model has to beat.

## Copy the data to your computer

```sh
python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080          # newest session
python3 tools/eye-capture/pull_session.py http://192.168.1.23:8080 --list
```

Files land in `tools/eye-capture/captures/<session>/`, which git ignores. The script prints a
one-line summary for each recording. The sessions are also visible in the Files app and in Finder
under the phone's Files tab.

A 4K recording is about 6 MB per second, so one camera with 25 dots and the moving dot is roughly
450 MB. Use 9 dots and no moving dot for a quick first look.

## What a session contains

| File                  | Contents                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `meta.json`           | The form, screen size, protocol, and phone model                            |
| `events.jsonl`        | One line per event from the page: dot shown, dot hidden, moving-dot samples |
| `<camera>.mov`        | HEVC video straight from one camera, with no stabilisation or mirroring     |
| `<camera>.frames.csv` | One row per video frame: capture time, focus position, ISO, shutter         |
| `<camera>.json`       | Resolution, zoom, field of view, lens intrinsics, closest focus, frame loss |
| `<camera>.motion.csv` | The phone's own gravity and rotation at 50 Hz, to detect a bumped mount     |

Notes for analysis:

- **One clock.** `t` in `frames.csv`, `t_phone` in `events.jsonl` and `t` in `motion.csv` are all
  seconds since the phone booted. The page measures its offset to that clock before and after each
  recording and stores both measurements in the events.
- **Matching frames to dots.** Row N of `frames.csv` is frame N of the video. A frame belongs to a
  dot when its `t` falls between that dot's `target_on` and `target_off`. Skip roughly the first
  0.7 s of each dot, while the eyes are still travelling.
- **Dot positions** are CSS pixels from the top-left of the page. `meta.json` has `pixelsPerCm`
  for converting to centimetres.
- **ARKit recordings** add columns for the face, left eye, right eye and camera transforms (16
  numbers each, column by column), the look-at point, and the eye blend shapes.

## Develop without a phone

```sh
python3 tools/eye-capture/dev/mock_phone.py     # then open http://localhost:8080
```

The mock serves the real controller page with made-up cameras and tiny fake recordings.

## Add or remove a Swift file

The Xcode project lists its files explicitly. After changing the file list, regenerate it:

```sh
gem install xcodeproj
ruby tools/eye-capture/ios/generate_project.rb
```
