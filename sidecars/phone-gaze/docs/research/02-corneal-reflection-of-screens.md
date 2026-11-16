# Research 02: the screen's reflection on the cornea

Question: can the reflection of the Mac's own screen on the cornea serve as the "glint" of a
pupil-centre/corneal-reflection (PCCR) tracker, at the resolution the phone gives us (iris about
50 px wide at 1x, 100 px at 2x, at 50 to 70 cm)?

Short answer: yes as a **coarse, head-movement-tolerant feature**. It is not a substitute for an
infrared glint. Expect the iris-minus-reflection vector to move only about 0.3 px per degree of gaze
at 1x and 0.6 px at 2x. Use 2x, sub-pixel centroids, temporal averaging, and a flash during
calibration to identify the reflection.

Source access: the network here blocks most publisher and university hosts (arxiv.org,
kyoto-u.ac.jp, kobe-u.ac.jp, springerprofessional.de, cmbes.ca), so this note relies on search-engine
abstracts and snippets plus first-principles optics. Numbers marked _(derived)_ are my own
calculation. Numbers marked _(unverified)_ come from memory or from an abstract and were not checked
against the full paper.

## 1. Why PCCR tolerates head movement

A light source reflected by the convex front of the cornea forms a virtual image (the glint). It
sits about half a corneal radius behind the corneal surface, so it moves almost rigidly with the
centre of corneal curvature. When the head translates, the pupil and the glint move together. When
the eye rotates, the pupil swings around the eye's rotation centre and the glint barely moves. So
the pupil-minus-glint vector encodes rotation and mostly cancels translation. It does not cancel
everything. Large depth changes alter the scale, and the visual axis differs from the optical axis by
about 5° per person _(unverified, textbook value)_, which calibration absorbs.

## 2. Cross-ratio method and its biases

With four light sources at the screen corners, the four glints form a small image of the screen
on the cornea. The pupil centre, taken inside that quadrilateral through a projective (cross-ratio)
mapping, gives the point of gaze without a calibrated camera.

- **Known bias.** The method assumes that the pupil and the glints are coplanar and that the
  cornea is a flat mirror. Neither holds, so the estimate is systematically offset and scaled for
  each subject
  ([Kang et al. 2008; Guestrin et al. ETRA 2008, cited in US9684827](https://patents.google.com/patent/US9684827)).
- **Corrections.** Yoo and Chung added a scale factor; Coutinho and Morimoto refined it. Kang et
  al. fit a 3×3 correction homography, which gives per-subject RMS error within 15% of the noise
  floor. The adaptive homography of Huang et al. and the bias homography of Zhang and Cai
  ([ETRA 2014](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ETRA2014-267-zhang.pdf);
  [Huang et al. ETRA 2014](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ETRA2014-075-huang.pdf))
  model what remains, chiefly the angle between the visual and optical axes.
- **Head movement.** The method is mostly sensitive to **depth** movement. Coutinho and Morimoto
  report error reductions of up to 40% with head-movement-tolerant variants
  ([IJCV 2013](https://latin.ime.usp.br/media/papers/pdf/ImprovingHeadMovementToleranceOfCross-RatioBasedEyeTrackersIJCV13.pdf)).
- **Relevance to us.** A screen reflection is literally the four-corner quadrilateral. If its corners
  can be resolved, a cross-ratio estimate with a homography correction is the textbook model.

## 3. Corneal imaging and screen-reflection work

- **Nishino and Nayar** model the cornea plus the camera as an uncalibrated catadioptric system.
  The cornea is an ellipsoid of fixed size and eccentricity, and its 3D pose comes from the limbus
  ellipse ([IJCV 2006](https://doi.org/10.1007/s11263-006-6274-9);
  [CVPR 2004](https://cave.cs.columbia.edu/old/publications/pdfs/Nishino_CVPR04.pdf)). They
  assume a corneal radius of about 7.8 mm and a limbus radius of about 5.5 mm _(unverified, quoted
  from memory)_.
- **Nakazawa and Nitschke** derive an analytic "gaze reflection point": the point on the cornea
  that reflects the scene point being looked at. They identify it with coded active (IR)
  illumination ([ECCV 2012](https://link.springer.com/doi/10.1007/978-3-642-33709-3_12)).
- **Schnieders et al.** reconstruct the eyes and the display from corneal reflections in order to
  calibrate a display against a camera
  ([CVPR 2010](https://i.cs.hku.hk/~kykwong/publications/dschnieders_cvpr2010.pdf)).
- **Iqbal and Lee (2008)** introduced the "screen-glint": the monitor lights the eye, a polynomial
  maps the vector from iris centre to screen-glint onto the screen, and a camera running faster
  than twice the refresh rate catches the flicker
  ([Springer](https://doi.org/10.1007/978-3-540-88906-9_14)). Their accuracy was not available.
- **ScreenGlint** (Huang, Li, Ngai and Leong,
  [CHI 2017](https://doi.org/10.1145/3025453.3025794)) is the closest prior art. A smartphone's
  front camera sees its own screen's reflection, and gaze comes from the vector between iris and
  glint. The authors claim results comparable to the state of the art, but the number was not
  retrievable here.
- **Sasaki, Nagamatsu and Takemura** use a polarisation camera (LCD light is linearly polarised)
  to segment the screen reflection and then run cross-ratio without IR LEDs
  ([CiNii](https://cir.nii.ac.jp/crid/1390017113108528896?lang=en);
  [KAKEN project](https://kaken.nii.ac.jp/en/grant/KAKENHI-PROJECT-18H03279)). An
  [ISS 2024 poster](https://iss2024.acm.org/details/iss-2024-posters/1/Extracting-Corneal-Reflection-of-Screen-by-High-Speed-Control-of-Polarization)
  notes that the degree of polarisation depends on what the display shows. That poster modulates
  polarisation at high speed to compensate.

## 4. Temporal coding to identify the reflection

A patent on corneal image mapping isolates the screen reflection by subtracting consecutive frames
while the display changes, and suggests an unobtrusive interlaced test pattern
([US6659611](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6659611)). The same
principle works for us at camera rates. Show a known on/off sequence (white and dark, or a
bright border) and correlate each pixel's intensity over time with that code. Pixels that follow
it belong to the screen's reflection, while ambient highlights (windows, lamps) do not. The
display-to-camera latency is unknown, so search over lags of 0 to about 150 ms during the first
flash. Afterwards, track the blob without flashing.

## 5. Expected size and signal _(derived)_

The cornea acts as a convex mirror with r ≈ 7.8 mm, so f = r/2 ≈ 3.9 mm. The image of an object of
width W at distance d is about W·f/(d+f). The iris is 11.7 mm across, which gives 4.3 px/mm at 1x
and 8.5 px/mm at 2x.

| Screen (14-inch, 302 × 196 mm) | 50 cm        | 60 cm        | 70 cm        |
| ------------------------------ | ------------ | ------------ | ------------ |
| Reflection size on the cornea  | 2.3 × 1.5 mm | 1.9 × 1.3 mm | 1.7 × 1.1 mm |
| At 1x (px)                     | 10 × 6.5     | 8.4 × 5.5    | 7.2 × 4.7    |
| At 2x (px)                     | 20 × 13      | 17 × 11      | 14 × 9.4     |

- **Gaze sensitivity.** The pupil-minus-glint vector grows by about the distance from the pupil to
  the centre of corneal curvature (about 4.2 mm) times sin θ. That is about 0.073 mm per degree, or
  **0.31 px/° at 1x and 0.63 px/° at 2x**. This is roughly a third of the raw iris motion (0.9 or
  1.8 px/°). One degree of accuracy therefore needs a centroid error of about 0.3 px at 1x. That
  is only plausible at 2x with averaging over several frames.
- **Brightness.** Corneal Fresnel reflectance is about 2.5% (n = 1.376). A 400-nit white screen
  therefore reflects at about 10 cd/m². An iris with 10% albedo in a 300 lux room is also about
  10 cd/m². So the reflection stands out clearly against the pupil and a dark iris. It can be
  barely visible on a blue or grey iris in a bright room, and it fades with dark-mode content.
- **Corners.** At 1x the reflection is a blob, and only its centroid and rough extent are usable.
  At 2x (about 17 × 11 px) the corners can be fitted roughly. That is enough for an approximate
  cross-ratio, not for a precise one.

## 6. Failure cases

- **Glasses.** Each lens surface reflects the screen too: about 4% uncoated and about 0.5% with an
  anti-reflection coating, often tinted green or purple. Lens surfaces are much flatter (radius 80
  to 130 mm), so their reflections are 10 to 30 mm wide, cover much of the eye, and move with the
  head rather than the eye. Reject them because they are too big, lie outside the iris ellipse, or
  stay still while the eye rotates.
- **Eyelids and lashes.** The reflection sits about where the camera-screen bisector meets the
  cornea, often in the upper iris when the phone is below the screen. A drooping lid crops it.
  Gate on eyelid opening.
- **Reflection on the iris-sclera edge.** At large gaze angles the reflection crosses the limbus
  and is distorted by the change in curvature. Drop it when its distance from the iris centre is
  more than about 0.6 of the iris radius.
- **Ambient light.** Windows and ceiling lights make competing glints. Temporal coding separates
  them. Saturated highlights cause blooming, so the phone exposure must not clip.
- **Content and flicker.** Dark UI shrinks the reflection or breaks it up. PWM or refresh banding
  shows up with short exposures.
- **Motion blur and focus.** A 0.3 px signal is lost to 1 px of blur. Use short exposure and locked
  focus.

## What to build

1. **Estimator `screen_reflection`, used at 2x only.** In the eye crop, take a top-hat of the
   intensity (the image minus its morphological opening, with a disk radius of about 0.25 of the
   iris radius). Threshold it adaptively, at the median plus k·MAD of the pixels inside the iris.
   Keep blobs inside the iris ellipse with an area of 0.5 to 3 times the predicted size from
   section 5 (scaled by the estimated distance). Report an intensity-weighted sub-pixel centroid,
   the blob area and a confidence. On dark irises it can be the brightest blob. On light irises,
   rely on the top-hat plus the size prior.
2. **Identify the reflection with a flash during calibration.** Have the UI flash a known
   pseudo-random white/dark sequence (about 8 steps at 4 to 8 Hz) before the first dot. Correlate
   it per pixel over lags of 0 to 150 ms. The best lag gives the display-to-camera latency, and the
   matching blob gives the reflection's position relative to the iris and its size. Store both as a
   per-setup prior and track from them, flashing again only on long loss.
3. **Feature.** The vector from the iris centre to the reflection centroid, divided by the iris
   radius, which makes it scale-free across zoom and distance. Average both eyes. Smooth over 3 to 5
   frames.
4. **Gaze model.** A second-order polynomial (or ridge regression) from that feature to the
   screen. Blend it with the geometric model rather than replacing it. Its value is head-translation
   robustness and drift correction, not precision.
5. **Later, at 2x when corners resolve:** fit a quadrilateral to the reflection and run cross-ratio
   with a Kang/Hansen-style correction homography. Treat this as experimental.
6. **Rejection rules:** eyelid opening, the limbus-distance cut, blob size (to exclude glasses),
   saturation, and blur. Report `None` rather than a weak guess.
7. **Simulator:** render a bright quadrilateral glint of the section 5 size whose position follows
   the cornea-centre model, with optional distractor highlights. That lets the estimator be
   unit-tested.
