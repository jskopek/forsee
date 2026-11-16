# Research 04: appearance-based gaze models, open-source trackers and pointer filtering

Researched 2026-11-16. Licence files were read directly from GitHub. arxiv.org, the MIT CSAIL
dataset pages, ait.ethz.ch and gery.casiez.net were blocked from this container, so paper numbers
marked _(via search)_ come from abstracts and search summaries, not the full PDFs. Facts I recall
but could not re-check here are marked _(unverified)_.

## 1. The licence problem in one line

Every pretrained gaze network I checked was trained on data whose licence forbids commercial use.
Often the code is MIT anyway.

| Dataset      | Licence                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPIIFaceGaze | CC BY-NC-SA 4.0, "non-commercial scientific purposes" ([page](https://perceptualui.org/research/datasets/MPIIFaceGaze))                                                                                                                       |
| ETH-XGaze    | Baseline code CC BY-NC-SA 4.0 ([README](https://github.com/xucong-zhang/ETH-XGaze)). The dataset's own terms are behind a blocked host and are believed NC _(unverified)_                                                                     |
| Gaze360      | "non-commercial research use only" ([repo](https://github.com/erkil1452/gaze360))                                                                                                                                                             |
| GazeCapture  | "research purposes only … will not be used nor included in commercial applications in any form (… **models trained on dataset**, other derivative works …)" ([LICENSE.md](https://github.com/CSAILVision/GazeCapture/blob/master/LICENSE.md)) |
| EYEDIAP      | Idiap research-only EULA _(unverified)_                                                                                                                                                                                                       |

Being MIT-licensed open source is not the same as being commercial. Still, an MIT project must not
ship, or present as MIT, weights that carry these terms, because MIT lets anyone use them
commercially. Verdict: **no candidate's weights can live in the repo.** At most we can offer an
opt-in download of upstream weights, labelled "non-commercial research weights", for the owner's
personal experiments.

## 2. Candidates

| Model                                                                   | Code licence                 | Weights / data                                                       | Verdict                                                                |
| ----------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [L2CS-Net](https://github.com/Ahmednull/L2CS-Net)                       | MIT                          | Google Drive; Gaze360 or MPIIFaceGaze                                | Code OK, weights NC                                                    |
| [MobileGaze](https://github.com/yakhyo/gaze-estimation)                 | MIT                          | GitHub releases, `.pt` and `.onnx`; all trained on Gaze360           | Code OK, weights NC; easiest to try (ONNX)                             |
| [UniGaze](https://github.com/ut-vision/UniGaze)                         | ModelGo MG-NC-RAI-2.0        | Hugging Face; joint datasets / ETH-XGaze                             | No (licence is NC)                                                     |
| [WebEyeTrack / BlazeGaze](https://github.com/RedForestAI/WebEyeTrack)   | MIT                          | TF.js weights in repo; trained on GazeCapture, MPIIFaceGaze, EYEDIAP | MIT claim conflicts with the GazeCapture terms. Weights NC in practice |
| [GazeFollower](https://github.com/GanchengZhu/GazeFollower)             | CC BY-NC-SA 4.0              | 7M-image model bundled; 32M one on request                           | No                                                                     |
| [OpenFace 3.0](https://github.com/CMU-MultiComp-Lab/OpenFace-3.0)       | Academic non-commercial only | HF / Google Drive                                                    | No                                                                     |
| [ETH-XGaze baseline](https://github.com/xucong-zhang/ETH-XGaze)         | CC BY-NC-SA 4.0              | Google Drive, ResNet-50                                              | No                                                                     |
| [pytorch_mpiigaze_demo](https://github.com/hysts/pytorch_mpiigaze_demo) | MIT                          | Trained on MPIIGaze / MPIIFaceGaze / ETH-XGaze                       | Code OK (useful normalisation reference), weights NC                   |

Technical details:

- **L2CS-Net**: ResNet-50 on a 448×448 face crop (ImageNet mean and std). It has two heads, yaw and
  pitch. Each head classifies into bins (Gaze360: 90 bins × 4° over ±180°; MPII: 28 × 3° over ±42°)
  and regresses the softmax expectation. The output is pitch and yaw in degrees in the camera frame,
  _without_ Zhang normalisation. Errors: 3.92° MPIIGaze, 10.41° Gaze360 (9.02° front-facing)
  _(via search)_.
- **MobileGaze**: the same head and pre-processing (`Resize(448)`, read from
  [inference.py](https://github.com/yakhyo/gaze-estimation)). Gaze360 MAE: ResNet-18 12.84° (43
  MB), ResNet-50 11.34° (91 MB), MobileNetV2 13.07° (9.6 MB), MobileOne-S0 12.58° (4.8 MB). The ONNX
  files run on onnxruntime (CPU or CoreML) without PyTorch.
- **BlazeGaze**: 670 KB, about 0.16 M parameters. Inference takes about 0.9 ms on an i7 CPU and
  about 2.4 ms on an iPhone 14. Input is a normalised eye patch plus head vector and face position.
  It outputs a normalised point on the screen (±0.5, origin at centre, y down), not angles. Error is
  2.32 cm on GazeCapture with k ≤ 9 calibration samples, using MAML adaptation _(via search)_.
- **ETH-XGaze baseline**: ResNet-50 on a 224×224 normalised face. Pitch and yaw are in the
  _normalised_ camera frame.

Expected error of an uncalibrated generic model on a new person: about 4–6° on frontal desk data
and above 10° in the wild. At 60 cm, 5° is about 5 cm on the screen. That is worse than the
geometric pipeline should achieve after calibration (research 01), so a pretrained network is an
**extra feature**, not the core of the tracker.

## 3. Data normalisation (Sugano 2014; Zhang, Sugano and Bulling, ETRA 2018)

A virtual camera is rotated to look at the face centre, with its x axis aligned to the head's x
axis. It is then scaled so that the face is at a fixed distance. The image is warped by
`W = K_norm · S · R · K_cam⁻¹`. Constants from the reference code
([normalization_example.py](https://github.com/xucong-zhang/ETH-XGaze/blob/master/normalization_example.py)):

- face: focal 960, distance 300 mm, 448×448;
- eye: focal 1800, distance 600 mm, 128×128;
- ETH-XGaze training: a 224×224 face.

The ETRA 2018 finding is that you should apply **only R, not S, to the gaze vector**. Dropping the
scaling improved results by 9.5–32.7% _(via search)_. To get gaze back into camera coordinates, use
`g_cam = R⁻¹ · g_norm`. Our phone sends intrinsics and, in ARKit mode, the head pose, so we can
normalise exactly. Without ARKit we can use solvePnP on the MediaPipe landmarks.

## 4. Few-shot personal calibration

- **FAZE** ([NVlabs/few_shot_gaze](https://github.com/NVlabs/few_shot_gaze), NVIDIA 1-way
  commercial licence: not usable): meta-learned adaptation reaches 3.18° on GazeCapture with 3
  samples _(via search)_. Error falls steeply up to k ≈ 9 and slowly after that.
- **The practical recipe used by most systems:** keep the network frozen. Fit a per-user correction
  on its output:
  - 2–3 points: bias only on pitch and yaw;
  - 5–9 points: affine;
  - 9–16+ points: ridge or 2nd-order polynomial from (pitch, yaw, head pose) to the screen.

  Use leave-one-out to choose the ridge λ. Subject bias (the kappa angle) is the main error source,
  so a bias-only fit already removes much of the error _(unverified figure: 30–50%)_.

- **Point placement:** 9 points (3×3), plus a 5–6-point validation set that is not used for
  fitting. Throw away the first 300–500 ms after each target appears (saccade latency plus
  settling). Average the rest over 0.5–1 s.

## 5. Landmark-based webcam trackers

- **WebGazer** (GPL-3.0, so we cannot reuse its code): it builds 120 grey-pixel features (two small
  eye patches). Ridge regression maps them to x and y and is refitted on every click. Reported
  accuracy is about 104 px, or 3.42 cm in a comparison study _(via search)_.
- **EyeTrax** ([ck-zhang/EyeTrax](https://github.com/ck-zhang/EyeTrax), MIT): uses MediaPipe
  landmarks for its features and a ridge-style regressor. It has a blink flag, 9/5-point, Lissajous
  and 5×5 grid calibration, and Kalman, Kalman+EMA (α 0.25) or KDE filters. It reports no accuracy
  figure. Users say it degrades with head movement.
- **Common lesson:** raw landmark or pixel regression does not hold up when the head moves. The
  better trackers add head pose to the features, or normalise first and then regress.

## 6. Filtering, fixations and dwell

- **One Euro filter** (Casiez et al., CHI 2012): defaults are `mincutoff` 1 Hz, `beta` 0 and
  `dcutoff` 1 Hz. To tune, set beta to 0 and lower mincutoff until jitter is acceptable while
  fixating. Then raise beta by factors of 10 (starting at 0.001–0.0001 for pixel units) until fast
  moves stop lagging ([1€ npm](https://www.npmjs.com/package/1eurofilter), Casiez's page via
  search). For gaze at 30–60 Hz, a starting point is `mincutoff` 0.3–1 Hz with beta tuned in screen
  pixels _(own recommendation)_.
- **I-VT**: Tobii's defaults are 30°/s, minimum fixation 60 ms, and merging fixations less than
  75 ms and 0.5° apart _(via search)_.
- **I-DT** (Salvucci and Goldberg 2000): dispersion 0.5–1°, minimum duration 100 ms
  _(unverified)_. With 2–4° of webcam noise, use dispersion of about 1.5–2× the measured precision.
- **Saccade-aware smoothing**: average heavily within a fixation. When velocity crosses the I-VT
  threshold, reset the filter and jump to the new location. Keep a one-sample outlier check (Kumar
  et al., ETRA 2008 _(unverified)_). This gives a stable pointer without lag on large moves.
- **Dwell click**: Majaranta et al. (CHI 2009) started users at 1000 ms. With adjustable dwell,
  their average fell from 876 ms to 282 ms over 10 sessions, and typing speed rose from 6.9 to
  19.9 wpm _(via search)_. Use a default of 800–1000 ms that the user can adjust. Show a progress
  ring and keep a 300–500 ms cooldown after each click. Make targets at least 2× the measured
  accuracy.

## What to build

1. **Signal layer first (high value, no licence risk):** One Euro filter with exposed parameters.
   An I-VT fixation detector (30°/s, 60 ms, merge 75 ms / 0.5°). Filter reset on saccades. Dwell
   click with adjustable time (default 900 ms), a progress ring and a cooldown. Blink gating.
2. **Calibration regressors as switchable experiments:** bias, affine, ridge, and ridge with
   head-pose features. Choose λ by leave-one-out. Use 9-point fitting plus 5-point validation. Drop
   the first 400 ms of each target. Report error in degrees and cm.
3. **Zhang normalisation as a utility in `vision/`** using the reference constants. It serves both
   an optional appearance model and an eye-patch ridge regressor of our own.
4. **Our own WebGazer-style experiment, written from scratch (MIT):** normalised eye patches,
   histogram-equalised and flattened, into ridge regression trained only on the owner's
   calibration data. No licence issue, and it complements the geometric model.
5. **Optional, off by default:** a MobileGaze ONNX plug-in (MobileOne-S0, 4.8 MB, 448 face crop)
   downloaded on first use from the upstream GitHub release. Label it non-commercial in the UI and
   docs, and do not commit the weights. Calibrate its pitch/yaw through item 2.
6. **Skip:** UniGaze, GazeFollower, OpenFace 3, ETH-XGaze weights and FAZE (licences). Skip BlazeGaze
   weights until their GazeCapture provenance is resolved. Skip MAML training (no permissive data).
