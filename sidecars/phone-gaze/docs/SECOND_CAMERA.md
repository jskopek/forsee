# Second camera: the Mac's webcam as a position anchor

**Experimental, off by default. Tested only against the simulators (an observation-level
two-camera simulator and the rendering simulator with the real face landmarker). It has never
seen a real MacBook camera or a real face.**

## The idea

The iPhone sees the eyes in far more detail than a laptop webcam, but nobody knows where the
phone is relative to the screen, and it moves when bumped. A MacBook's built-in camera is the
opposite: few pixels per eye, but it is fixed to the screen, so its pose relative to the screen
is known in advance (lens centre a few millimetres above the middle of the top edge, in the
display's plane, looking straight out; the display's size comes from macOS). Both cameras see
the same head, so together they tell where the phone is relative to the webcam, and so relative
to the screen. Code: `engine/phonegaze/second_camera/`; simulator webcam:
`engine/phonegaze/sim/webcam.py`; page: `engine/phonegaze/web/js/second-camera.js`.

## Geometry

Frames are metres; cameras x right, y down, z forward; the screen frame has its origin at the
top-left corner of the visible area, x right, y down, z into the screen. `a_from_b` maps points
in `b` to `a`.

- **Webcam on the screen** (`geometry.screen_from_webcam`): position `(width/2, -offset, 0)`,
  axes `diag(-1, 1, -1)` (it faces the user, so the user's right is its left) times a tilt about
  its x axis. Settings `offset_mm` (8) and `tilt_deg` (0).
- **Per paired frame** (`solver.py`): `webcam_from_phone = webcam_from_head · phone_from_head⁻¹`.
  The webcam frame is interpolated to the phone frame's capture time on the engine clock (linear
  in position, slerp in rotation; refused when the nearest webcam frames are more than
  `max_skew_ms` away or the head moved more than 3 cm between them). Frames where either camera's
  face is poor (eye missing, blink, head turned more than 40°, implausible distance) are not
  paired.
- **Averaging** over `window_s` (20 s). `poses`: Huber mean of the per-frame rotations, then,
  with that rotation fixed, the Huber mean of `t_webcam − R·t_phone` (so a frame's rotation noise
  does not reach the translation through the 60 cm lever arm). `points`: robust Kabsch alignment
  of both eyes and the head point over the window; needs the head to move in three dimensions.
  `hybrid`: points once they spread 1.2 cm in every direction. The uncertainty shown is the
  per-frame spread over √(seconds / 0.5 s) (frames are correlated); **it does not include biases**.
- **The screen in the phone**: `phone_from_screen = webcam_from_phone⁻¹ · screen_from_webcam⁻¹`,
  which is exactly the six pose parameters the geometric model otherwise has to solve for.
- **Phone moved**: the gyro (`rotationRate` in every frame header) above `move_rotation_dps`, the
  gravity direction changing by more than `move_gravity_deg` since the pose was anchored, or
  (`move_vision`) a second and a half of paired frames consistently 3 cm or 4° from the anchored
  pose. A move ends the current **segment** and starts an empty one: frames during the move are
  ignored and the pose is solved again from what follows (about one second with 20 frames). The
  page says "Phone moved, re-anchoring".

## The options (each its own setting under `second_camera.`)

| Idea                    | Setting                                     | What it changes                                                                                                                                                   |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 webcam capture        | `enabled`, `source`, `camera_index`, …      | Opens the camera (OpenCV, AVFoundation on macOS), runs the face landmarker on its own thread                                                                      |
| 2 webcam → screen       | `offset_mm`, `tilt_deg`, `hfov_deg`         | Known geometry, no calibration                                                                                                                                    |
| 3 phone-pose solve      | `solve_method`, `window_s`, `min_pairs`, …  | Shown on the page; feeds the rest                                                                                                                                 |
| 4a pose fixed           | `screen_pose = fixed`                       | Adds model `geometric_2cam` whose screen pose is the solve's; calibration fits only the person (kappa, eye radius), so two dots are enough                        |
| 4b pose as a prior      | `screen_pose = prior`                       | `geometric_2cam` starts from the solve and may move from it (prior SD 3° and 3 cm or three times the reported uncertainty)                                        |
| 4c survive a phone move | `track_phone`                               | Every observation is re-expressed in the phone frame of the calibration (3D values exactly, pixels through 3D at the eye's depth), for every model                |
| 5 two-camera 3D         | `distance_source = triangulated`            | Each eye's corner midpoint: the point on the phone's ray nearest the webcam's ray; eyeball centres, head position and distance follow                             |
| 6 head pose source      | `head_pose_source` = phone / webcam / fused | Only the head rotation and position fields                                                                                                                        |
| 7 wide head box         | `wide_head_box`                             | When the phone lost the eyes: eye crops and zoom steered to where the webcam says they are; gaze from the webcam model, confidence ≤ 0.25, `extra.low_confidence` |
| 8 webcam-only baseline  | `webcam_model`                              | Adds model `webcam`: the geometric model on the webcam's observation, screen pose from the geometry (prior SD 3°, 3 cm)                                           |
| (found while testing)   | `head_ray_correction` (on)                  | Turns MediaPipe's head rotation, which is relative to the line of sight to the face, into camera coordinates (see below)                                          |

The extra models are fitted with every calibration and appear in Validate's table next to the
others, which is how each idea is compared. They are not in `phonegaze.models.REGISTRY`, so a
saved calibration reloads without them (logged) until the next calibration.

## API and simulator

- `GET /api/second_camera` (also `state.second_camera`): status, webcam frames and faces, paired
  frames, the solve (`webcam_from_phone`, uncertainty, segment, moves, time to anchor), the phone
  in screen millimetres, the self-check, the `track_phone` transform in use.
  `GET /api/second_camera/preview.jpg`: the webcam with the detected face.
  `POST /api/second_camera/reanchor`: forget the pose and solve again.
- Every phone observation carries `extra.second_camera`: segment, status, the solved screen pose
  as the geometric model's parameters with its uncertainty, the webcam's geometry, and the nearest
  webcam observation. The extra models read only this, so recorded calibrations refit the same way.
- The simulated phone serves `GET /sim/webcam.jpg` (ground truth in the `X-Sim-Webcam` header,
  capture time in `X-Monotonic`), `/sim/webcam/config` (true field of view 69.5°, offset, tilt,
  noise; `layout: "laptop"` raises the simulated head to the webcam's level and aims the phone
  at it; the engine asks for it when it opens the simulator's webcam) and `POST /sim/phone/move`
  (a smooth move with the gyro reporting it).

## The weakest link

The webcam's head pose. MediaPipe's per-frame head rotation is off by a few degrees and its
distance by a few centimetres (it guesses the face's size), and a degree of rotation error moves
the solved phone by about a centimetre at 60 cm. Averaging removes the noise, which is why the
solve averages over 20 s, but not the biases: the webcam's field of view is guessed (`hfov_deg`),
the face model does not fit the person, and the two cameras see the face from different angles.
So the absolute pose is good to a few centimetres and degrees at best, while the **change** of
pose after a phone move is measured much better, because the same biases cancel. That is why
`track_phone` works and `screen_pose = fixed` does not.

Found on the rendering simulator: MediaPipe's face rotation is relative to the line of sight to
the face, not to the camera's axis, so a face 7° off axis reads as turned 7°. With
`head_ray_correction` on, the webcam's rotation error on full frames dropped from 7.2° to 0.5°,
and a 3.8°, 2.2 cm phone move was measured to 1.1° and 1.2 cm (off: 4.0° and 3.9 cm, as large as
the move). But the absolute pose got worse (10° and 10 cm instead of 3° and 4 cm), because
MediaPipe also has a pitch bias of about 7° on the synthetic face seen from below that the
uncorrected webcam happened to share. The same correction probably belongs in the `landmarks`
estimator (Vision area); it is not applied there.

**Self-check.** The page compares the webcam's eye distance with the one expected from the
phone's eyes and the phone's own calibrated screen pose (independent of the webcam). A ratio away
from 1 means `hfov_deg` (or `offset_mm`) is off; the suggested field of view makes it 1. Without
a calibration it uses the slope of webcam distance against phone distance when the head moves in
depth. In the rendering simulator the webcam reads 62 cm where the phone reads 57 cm.

## Results in the simulators

Two-camera observation simulator (`tests/test_second_camera_accuracy.py`, `-s` prints these):
the phone and person of the Models simulator plus a 1280 × 720 webcam whose true field of view
is 69.5° (the engine assumes 68°), with head-fixed and along-the-ray biases differing between the
cameras and webcam jitter of 2.5°, 1.5 mm and 1.5 cm per frame. True visual angle, degrees, mean
over 16 fresh dots; 3 × 3 calibration from one head position; the phone moved about 2 cm and 4°
after calibration.

| Option (model)                         | still | head moved | phone moved | phone moved + `track_phone` |
| -------------------------------------- | ----- | ---------- | ----------- | --------------------------- |
| none (`geometric`)                     | 0.93  | 3.59       | 2.79        | 1.47                        |
| 4a pose fixed (`geometric_2cam`)       | 1.23  | 4.98       | 1.64        | 1.00                        |
| 4b pose as prior (`geometric_2cam`)    | 1.01  | 3.57       | 3.11        | 1.23                        |
| 4b, 2 × 2 dots only (`geometric_2cam`) | 0.96  | 3.58       | 3.09        | 1.54                        |
| 5 triangulated distance (`geometric`)  | 0.37  | 0.98       | 1.55        | 0.66                        |
| 6 fused head pose (`geometric`)        | 0.93  | 3.45       | 2.71        | 1.60                        |
| 8 webcam only (`webcam`)               | 7.37  | 7.70       | 6.55        | 6.75                        |
| 4b with `hfov_deg` 60 (true 69.5)      | 0.98  | 3.47       | 3.26        | 1.20                        |
| 4a with the webcam 25 mm up (told 8)   | 1.24  | 5.14       | 2.03        | 1.03                        |

- Phone-pose solve: 1.0°/3.6 cm after 0.5 s, 1.6°/2.7 cm after 5 s, 1.5°/2.6 cm after 20 s
  (anchored after 20 paired frames, under a second): bias-limited, not noise-limited. With the
  head wandering 3 cm, `points` reaches 0.4°/2.6 cm. With `hfov_deg` 60 the solve is 13 cm off,
  yet the prior and `track_phone` still work (graceful).
- Wide head box with the phone blind: predicted eyes 46 px from the truth (15 % of an eye crop),
  gaze kept flowing on every frame, 6.4° with the calibrated webcam model (42° uncalibrated).
- Caveat on 5: in this simulator the phone's eyeball centres carry a head-fixed bias of a few
  millimetres that the corner pixels do not, so triangulating the corners removes it. Real
  estimators place the eyeball from the corners already, so expect much less.
- Caveat on the biases: with models_sim's original camera-axis biases (fixed to the camera, not
  the head) `track_phone` does not help at all, because nothing that only knows how the camera
  moved can undo a bias that moves with it. Which kind real estimators have is unknown.

Rendering simulator with the real face landmarker on both cameras
(`tests/test_second_camera_render.py`, `tests/ui/second_camera_e2e.cjs`): anchored in about
4 s; pose 10° and 10 cm off with the ray correction (3° and 4 cm without); the phone move measured
to 1.1° and 1.2 cm with it. Validation in the end-to-end test (rear camera at 2×, one head
position, `screen_pose = prior`, the engine's own Validate, degrees; one run):

| Model            | still | phone moved 2.2 cm, 3.8° | + `track_phone` |
| ---------------- | ----- | ------------------------ | --------------- |
| `geometric`      | 2.44  | 6.22                     | 5.58            |
| `geometric_2cam` | 1.77  | 6.10                     | 5.43            |
| `ridge`          | 0.67  | 74.48                    | 7.15            |
| `blend`          | 0.71  | 39.61                    | 5.39            |
| `reflection`     | 1.02  | 0.61                     | 0.77            |
| `webcam`         | 3.07  | 4.49                     | 3.40            |

Here `track_phone` rescues the pixel-feature models from a broken calibration but recovers the
geometric model only partly, the reflection model barely notices the phone moving at all, and the
webcam alone (3.1°) is closer to the phone than in the observation simulator.

## What would make it worth keeping

On a real MacBook and iPhone, run the same three Validates as the tables: still, after moving
the head, after moving the phone (with `track_phone` off and on, without recalibrating).

- **Keep `track_phone`** if, after a deliberate phone bump, Validate with it on is clearly closer
  to the pre-bump number than with it off (in the simulators: 2.8° → 1.5°). If it is no better
  than Quick refine with one dot, drop it: Quick refine already exists.
- **Keep `screen_pose = prior`** only if `geometric_2cam` beats `geometric` after a head move or
  with fewer dots on real data; in the simulators it is a wash. Drop `fixed` unless the self-check
  ratio is within 2 % and the solved phone position matches a ruler to 1 cm.
- **Keep `triangulated`** if it improves `geometric` on real data; the simulator's large gain is
  partly an artefact (above).
- **Webcam-only** is the baseline: if the phone does not beat it by a wide margin on the same
  person, the phone is not earning its place.
- **Drop the whole thing** if the page's solved phone position is more than a few centimetres
  from where a ruler says the phone is and the self-check cannot be brought near 1 by `hfov_deg`.

## Unverified

Camera index, resolution and frame rate on a real Mac; how OpenCV reports a denied camera
permission (handled as "opens but no frames" and "cannot open", both with the same advice); the
built-in camera's real field of view and offset; whether its frames are mirrored (assumed not);
the webcam's clock latency (frames are stamped when read); MediaPipe's real biases on real faces;
the real phone's gyro values in frame headers.
