# 01: Geometric gaze estimation from RGB, and its calibration

Research note for the `models/` and `calibration.py` owners. Written 2026-11-16.

**How sure is this note?** Web search worked, but this session could not fetch most paper PDFs: the
CVF, unibw.de and personal-site hosts were blocked by the network allowlist. Figures marked
**[abstract]** come from paper abstracts or search snippets. **[textbook]** marks standard
eye-model constants I could not check against a primary source this session. **[computed]** marks
arithmetic done here. Anything not marked comes straight from a cited source.

## 1. The eye model

The eye is modelled as a sphere (the eyeball, which rotates about centre **E**) with a smaller
corneal sphere (centre **C**) in front of it. The **optical axis** runs from E (or C) through the
pupil or iris centre. People actually look along the **visual axis**, from the fovea through the
nodal point. The two axes differ by a fixed angle for each person (angle alpha, often loosely called
kappa).

| Constant                                      | Typical value                  | Spread / source                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eyeball radius                                | ~12 mm (axial length ~24 mm)   | [textbook]                                                                                                                                                                                                                                      |
| Rotation centre behind corneal apex           | ~13.5 mm                       | [textbook]                                                                                                                                                                                                                                      |
| Iris plane to rotation centre                 | ~10–10.5 mm                    | [computed] from 13.5 mm minus an anterior chamber of ~3–3.5 mm, or from √(12² − 5.9²) = 10.45 mm                                                                                                                                                |
| Corneal radius of curvature                   | 7.8 mm                         | ±~0.3 mm [textbook; this is the value used by Guestrin & Eizenman]                                                                                                                                                                              |
| Pupil centre to cornea centre                 | 4.2 mm                         | [textbook, Guestrin & Eizenman]                                                                                                                                                                                                                 |
| Effective refractive index (cornea + aqueous) | 1.3375                         | [textbook]                                                                                                                                                                                                                                      |
| Visible iris diameter (HVID)                  | ~11.7 mm (adults 11.8–12.0 mm) | Adults 11.81 ± 0.24 and 11.98 ± 0.33 mm; children aged 5 and over 11.22 ± 0.52 mm; normal range ~10–13 mm ([search summary of HVID studies](https://pmc.ncbi.nlm.nih.gov/articles/PMC5782436))                                                  |
| Angle kappa / alpha                           | ~5° nasal, ~1.5° up            | Measured kappa is 4.97 ± 1.38° in one cohort and 2.1–3.4° (SD 1.2–2.8°) in others ([PMC4341357](https://pmc.ncbi.nlm.nih.gov/articles/PMC4341357)). Per-person gaze offsets have an SD of 2–3° ([Liu et al.](https://arxiv.org/abs/1904.09459)) |

Guestrin & Eizenman's ([TBME 2006](https://doi.org/10.1109/TBME.2005.863952)) way of writing the
visual axis: give the optical axis as pan θ and tilt φ, then
`ω(θ, φ) = [cos φ sin θ, sin φ, −cos φ cos θ]`, and the visual axis is `ω(θ + α, φ + β)`.
Here α (about ±5°, mirrored between the two eyes) and β (about 1.5°) are fitted for each user. Their
paper names two main sources of error: real corneas are not spherical, and the feature centres are
noisy [abstract].

**Refraction.** The pupil and iris are seen through the cornea. They appear magnified and shifted
forward by roughly 0.5 mm [textbook], and the bias grows with viewing obliquity. A purely
geometric RGB model leaves this uncorrected, and a per-user calibration and residual absorb it.

## 2. Two ways to get the optical axis

**(a) From the iris or limbus ellipse.** Fit an ellipse to the limbus and back-project it to a 3D
circle of known diameter D:

- Distance to the eye: `Z ≈ f·D / a`, where a is the major axis in pixels.
- Tilt of the circle normal from the viewing ray: `acos(b/a)`.
- Back-projection gives two candidate normals. Keep the one that points away from the eyeball
  centre.

EyeTab ([Wood & Bulling, ETRA 2014](https://perceptualui.org/publications/wood14_etra/),
[code](https://github.com/errollw/EyeTab)) does exactly this on an unmodified tablet and reports
6.88° mean error, 8 participants, 12 fps [abstract]. This method is **poorly conditioned near
frontal views** [computed]. The derivative of θ = acos(b/a) blows up as θ → 0. A 1% error in b/a
costs:

| Viewing angle           | 5°   | 10°  | 20°  | 30°  |
| ----------------------- | ---- | ---- | ---- | ---- |
| Error from 1% b/a error | 6.6° | 3.3° | 1.6° | 1.0° |

With the iris about 100 px across, 1% of b/a is 1 px on the minor axis.

**(b) From the iris centre and the eyeball centre.** The model is:

- `E = R_head · e_user + t_head`, where e_user is a fixed eye-in-head offset fitted per user.
- Back-project the iris-centre pixel to a ray. Intersect it with the sphere of radius r ≈ 10.2 mm
  around E, taking the near root, to get the 3D iris centre P.
- The optical axis is `(P − E)/|P − E|`. Then apply α, β.

This is the structure of the webcam models of Wang & Ji ([ICCV 2017](https://www.ecse.rpi.edu/~cvrl/wangk/papers/wang2017_webcam.pdf)):
a 3D deformable eye-face model, personal eye parameters recovered in one unified calibration,
30 fps. They report it beats prior work under free head movement [abstract; exact degrees not
verified]. Its sensitivity, at Z = 600 mm [computed]:

| Quantity                      | Value                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Pixels per mm                 | f/Z: 4.8 at fx ≈ 2900 (1× wide); 9.7 at fx ≈ 5800 (2× crop, iris ≈ 113 px, matching `eyes.py`'s "~100 px") |
| Iris-centre error (1× wide)   | 1.16° per px                                                                                               |
| Iris-centre error (2× crop)   | 0.58° per px                                                                                               |
| Eyeball-centre error, lateral | 1 mm ≈ 5.6°                                                                                                |
| On screen at 600 mm           | 1° ≈ 10.5 mm                                                                                               |

Head-pose landmarks are nowhere near 0.2 mm repeatable, so eyeball-centre jitter, not iris
fitting, will dominate this error. Note that `tools/eye-capture/analysis/session.py` uses 12.0 mm
for the iris-to-rotation radius. About 10.2 mm is closer to anatomy, which raises the degrees-per-px
figures by about 15%.

## 3. Finding the camera-to-screen pose without a mirror

The classical approach (a mirror and a calibration pattern) is not available here. Published
alternatives:

- **Gudi et al., "Efficiency in Real-time Webcam Gaze Tracking"** ([ECCV-W 2020](https://arxiv.org/abs/2009.01270)).
  Assumes the camera's roll and yaw relative to the screen are 0, and fits pitch (plus the gaze
  mapping) by minimising on-screen error over calibration dots with differential evolution. It
  found that "single eye input and geometric regression calibration achieve the best trade-off"
  [abstract].
- **Screen pose as six learnable parameters** (rotation and translation), fitted from gaze-to-target
  pairs ([arXiv 2502.04074](https://arxiv.org/abs/2502.04074)) [abstract].

**Degeneracy** [computed / reasoning]. If the head does not move, a constant angular offset (α, β)
cannot be told apart from a screen translation: both shift every target by the same amount. The
screen pose plus α, β for each eye, plus an eye-in-head offset, comes to about 16 unknowns.
Separating them needs targets seen **from several head positions or distances**, or strong priors.
Priors available here:

- The phone's `gravity` fixes camera pitch and roll in world terms.
- The phone sits roughly at the bottom-centre of the screen, about 0–5 cm in front of its plane.
- Kappa population means.
- The two eyes' rays should converge on the screen plane. That gives depth even from one head
  position.

## 4. Per-user calibration: how few points?

| Method                                       | Reported result                                                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-based, IR glints (Guestrin & Eizenman) | 1 camera with multiple lights: free head movement after a multi-point calibration. Multiple cameras: a **1-point** calibration is enough [abstract]                                                                                                   |
| Head-mapping (Zhu & Ji, CVPR 2005 / TBME)    | Calibrate once per person, then under 1° with natural head movement ([project](https://www.ecse.rpi.edu/~cvrl/zhiwei/gazetracking/gazetrackingword.html)) (IR) [secondary]                                                                            |
| FAZE, few-shot appearance (Park et al. 2019) | **3.18° with 3 samples** on GazeCapture; 3.88° with 9 on MPIIGaze ([arXiv](https://arxiv.org/abs/1905.01941), [code](https://github.com/NVlabs/few_shot_gaze))                                                                                        |
| Differential network (Liu et al.)            | Beats linear and SVR adaptation from 1 reference image; less sensitive to which calibration points are chosen ([arXiv](https://arxiv.org/abs/1904.09459)) [abstract]                                                                                  |
| Smooth pursuit (Pfeuffer et al., UIST 2013)  | Correlates eye and target motion, so it samples only while the user is actually following; tolerates interruptions ([page](https://perceptualui.org/publications/pfeuffer13_uist/)). **Numbers unverified**                                           |
| CalibMe (Santini et al. 2017, head-mounted)  | **0.59° ± 0.23°** with an unsupervised moving-target method vs **0.82° ± 0.15°** with a 9-point grid ([pdf](https://www.hci.uni-tuebingen.de/assets/pdf/publications/TWE052017.pdf)) [snippet]                                                        |
| Drewes et al., ETRA 2019                     | Pursuit calibration in about 2 s over a small area, trading speed for accuracy [snippet]                                                                                                                                                              |
| WebGazer (Papoutsaki et al. 2016)            | Implicit calibration from clicks and cursor movement. About **3 clicks** give a usable model; error 100–200 px ([press release](https://www.sciencedaily.com/releases/2016/06/160601152015.htm), [paper](https://par.nsf.gov/servlets/purl/10024076)) |
| Wang & Ji 2018, implicit                     | Fits personal eye parameters with no explicit calibration, using natural constraints: screen region, anatomy, and agreement between methods ([pdf](https://sites.ecse.rpi.edu/~cvrl/Publication/pdf/Wang2018a.pdf)) [abstract]                        |

**Clicks as labels** [heuristic, unverified]. Gaze usually lands on a target before the click. Take
the samples from a window of roughly 100–400 ms before mouse-down, and drop clicks where the eye was
not fixating.

## 5. Head-movement compensation

- Valenti, Sebe & Gevers ([TIP 2012](https://staff.science.uva.nl/th.gevers/pub/GeversTIP12-1.pdf)),
  webcam, head pose plus eye location: mean error **2–5°**, and a working range extended by more
  than 15° of head rotation [abstract].
- Zhu & Ji, IR: **under 1°** with free head movement, using a dynamic head-compensation model.
- Regression (2D mapping) models are known to degrade when the head translates away from where it
  was during calibration. EyeTab-style systems "significantly worsen" until recalibrated
  [snippet; no numbers].

Geometric ray models compensate by construction. Regression models need head pose as an input,
plus calibration data taken at more than one head position.

## 6. Hybrid geometric models with a learned residual

- HybridGazeNet ([arXiv 2111.11691](https://arxiv.org/abs/2111.11691)) builds the eyeball model
  into a CNN and reports better cross-dataset generalisation [abstract; numbers unverified].
- Gudi 2020 (above) found that geometric regression beat both pure geometry and pure machine
  learning.
- WebEyeTrack pairs metric head pose with a small CNN and needs about 9 calibration points
  [snippet].

The common pattern: geometry carries the head and screen geometry, and a small, heavily regularised
model mops up the systematic person-specific bias (refraction, corneal asphericity, landmark bias).

## What to build

1. **Geometric model first, with the iris-centre-plus-eyeball-centre method (§2b), not ellipse
   normals.** The eye is seen at a near-frontal angle, where the ellipse normal is poorly
   conditioned. Use the ellipse only to choose between the two back-projection solutions, and its
   size to estimate distance (Z = f·11.7 mm / a).
2. **Parameters and priors.** Per-user parameters: α, β per eye, with priors (±5° mirrored, 1.5°)
   and an SD of about 2°; eye-in-head offset; iris-to-rotation radius, starting at 10.2 mm, bounded
   9–12 mm. Screen pose: 6 DoF, initialised from `gravity` and "phone at bottom centre". Solve with
   robust nonlinear least squares, using Huber loss and
   priors as extra residual terms.
3. **Full calibration.** A 9-point grid, a 10–15 s pursuit path (keep samples where the gaze-target
   correlation is above about 0.8), then repeat 5 points at a second head position (lean in or out
   about 10 cm). Without the second pose, freeze α and β at their priors and fit a shared offset;
   say so in the `FitReport`.
4. **Quick refine.** One dot updates only a 2D offset. Three to five dots re-solve the screen pose
   and keep the person's parameters.
5. **Learned residual.** Ridge regression on (gaze yaw, pitch, head yaw, pitch, x, y, z), fitted on
   what the geometric model gets wrong. Keep it only if leave-one-dot-out error improves.
6. **Implicit drift correction.** Use clicks: samples from 100–400 ms before mouse-down, during a
   fixation, to update the offset online.
7. **Error budget for the UI.** Show deg/px (0.58° at 2× and 60 cm) and 1° ≈ 10.5 mm. Smooth
   eyeball-centre and head-pose jitter hard (a 1-Euro filter or similar), since 1 mm of jitter
   costs about 5.6°.
8. **Fix the constant.** Change `EYE_ROTATION_RADIUS_MM`, in `session.py`, from 12.0 to about
   10.2 mm, or note why 12 mm is kept.
