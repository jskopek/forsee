# Research 03: iPhone camera, ARKit and transport for a live eye tracker

Question: what can an iPhone give the Mac engine, and how should the phone app capture and ship it?

Source labels: **[doc]** official Apple documentation or WWDC transcript, read for this note;
**[paper]** paper abstract or summary (full texts on frontiersin.org were blocked by the network
here); **[forum]** Apple Developer Forums or other developer reports, anecdotal; **[vendor]** the company's own material; **[derived]** my own arithmetic; **[memory]** from
prior knowledge, not re-checked today. Nothing here was measured on a device.

## 1. ARKit face tracking gaze

**What the API gives.** `ARFaceAnchor` has `leftEyeTransform`, `rightEyeTransform` (4×4, in face
anchor space) and `lookAtPoint`, "a position in face coordinate space estimating the direction of
the face's gaze", derived from the two eye transforms; looking left gives positive x, and its
length grows with focus distance [doc][lookat]. Face space: origin behind the nose, +x towards the
viewer's right (the person's left), +y up, +z out of the face towards the camera; each eye
transform's +z axis points along that eye's gaze [memory]. ARKit world and camera space are
right-handed, y up, with the camera looking down −z, in the sensor's landscape orientation
[memory]. This is why ARCHITECTURE.md converts once, in the ARKit estimator: flip y and z to get
x right, y down, z forward.

**Mapping to an external screen.** Published demos intersect the eye ray (eye origin in world
space, eye +z direction) with the phone's own screen plane [memory]. For a Mac screen the plane is
unknown, so the screen pose must come from calibration, exactly as the geometric model plans. Treat
`lookAtPoint`'s length as unreliable (vergence at 60 cm is a fraction of a degree); use only its
direction, or better the per-eye transforms.

**Accuracy reported.**

- Greinacher and Voigt-Antons 2020, "Accuracy assessment of ARKit 2 based gaze estimation":
  **3.18°, about 1.44 cm on the phone's screen**, two studies (N = 9 and N = 8) [paper][grein].
- Parker et al. 2022 (iPhone 12 Pro, 60 Hz, no calibration): eye recordings 23% error versus 15%
  for head; **precision 1.3° for eyes, 0.8° for head**; horizontal better than vertical; they
  recommend adding a calibration [paper][parker].
- University of Glasgow (iPhone X): accuracy got worse as the phone moved from 49 cm to 25 cm
  [paper][gla].
- RGBDGaze (own network on TrueDepth RGB + depth, not ARKit gaze): 1.89 cm on-screen error,
  leave-one-participant-out, 50 people [paper][rgbd].
- Developer reports: offset, drift, compressed range (eyes must over-rotate to reach corners), and
  jitter at centre; head movement dominates eye movement [forum][forum-cal].

Expect roughly **3–5° uncalibrated, 1–2° after a per-user linear correction**, at phone-screen
distances [derived from the above; unverified at 60 cm to a Mac screen]. The eye rotation ARKit
reports appears to be smoothed and range-compressed, so a regression from ARKit eye angles plus
head pose to the screen should beat the raw geometry.

**Quirks** [memory unless marked]: ARKit face tracking runs at 60 Hz; the TrueDepth depth map
(`capturedDepthData`) arrives at a lower rate (about 15 Hz) and is 640×480 [forum][res]. Tracking
loses the face beyond roughly 1 m and at large yaw. Glasses mostly work but strong reflections
from the IR dot projector or anti-reflective coatings increase jitter. Blinks drive the eye
transforms briefly; gate with `eyeBlinkLeft/Right` blend shapes. Expect one or two frames of
latency from internal filtering.

**Eyeware Beam** uses TrueDepth but runs its own computer vision rather than ARKit's gaze, on the
phone, and sends only head pose and gaze to a Windows app over Wi-Fi or USB. Its own spec says
accuracy degrades by "multiple degrees" at larger screens, distances and head movement; no
independent benchmark found [vendor][beam].

**Image resolution.** `ARFaceTrackingConfiguration.supportedVideoFormats` is the only knob; pick a
format at runtime [doc][formats]. Apple's analytics glossary lists ARKit frame resolutions of
640×480, 1280×720, 1440×1080, 1920×1440 and 3840×2160 [doc][analytics]; a developer reports
1440×1080 from the front camera on iPhone 14 Pro [forum][res]. Whether a 4K face-tracking format
exists on the owner's phone is unverified. At 1440×1080 with the front camera's ~65° horizontal
field, an iris at 60 cm is roughly 20 px wide [derived], so `capturedImage` eye crops are usable
for a coarse iris but much worse than the rear wide at 2×.

## 2. Rear cameras with AVFoundation

- **Zoom vs device switch.** Setting `videoZoomFactor` (or `ramp(toVideoZoomFactor:withRate:)`)
  on a running device takes effect within a frame or two with no session reconfiguration; swapping
  the input device needs `beginConfiguration`/`commitConfiguration` and typically drops frames for
  a few hundred milliseconds [memory]. The planned `/api/zoom` route is the right design.
- **The 2× sensor crop.** On 48 MP wide cameras, `AVCaptureDevice.Format`'s
  `secondaryNativeResolutionZoomFactors` lists zoom factors where the device switches to a
  native-resolution (unbinned, not upscaled) crop [doc][zoom]. Reports disagree on the value (one
  printed `[2.0]`, another `[4.0]` , probably on a virtual device whose 1× is the ultra wide, my reading)
  [forum][zoomforum]. Read it at runtime and divide by the device's base factor; do not hard-code
  2.0. Intrinsics must be rescaled by the zoom (fx × zoom) whether or not the crop is native.
- **4K at 60 fps.** Rear wide formats of 3840×2160 with `maxFrameRate` 60 exist on all recent
  iPhones [memory]. Pick by enumerating `formats`; prefer non-binned, and check that the format's
  secondary zoom list contains 2× if you want the crop.
- **Stable eye images.** Lock focus with `setFocusModeLocked(lensPosition:)`, exposure with
  `setExposureModeCustom(duration:iso:)` (1/120 s or shorter limits saccade blur), and white
  balance. Since iOS 15.4 face-driven autofocus and auto-exposure are on by default; turn off the
  automatic adjustment, then the feature [doc][wwdc22]. Keep video stabilisation off: it crops and
  moves the image, and it disables intrinsics delivery [forum][intr].
- **Minimum focus.** Query `minimumFocusDistance` per device [doc via forum][mfd]. The owner
  measured 135 cm on the telephoto. Automatic macro switching only happens on virtual devices that
  contain the ultra wide (`builtInDualWideCamera`, `builtInTripleCamera`) under
  `primaryConstituentDeviceSwitchingBehavior`; use a physical device (`builtInWideAngleCamera`) to
  prevent surprise lens changes [forum][mfd].
- **LiDAR.** `builtInLiDARDepthCamera` pairs the rear wide with LiDAR (iOS 15.4+, iPhone 12 Pro
  and later Pro). Video formats from 640×480 to 4032×3024; **streaming depth up to 320×240**
  (768×576 for photos only); ultra wide and telephoto can run alongside it in a multi-cam session
  [doc][wwdc22]. At 60 cm a 320×240 map gives a few centimetres of precision on the face, enough
  for distance, not for eye geometry [derived]. Depth frame rate is not documented; expect 30 fps
  at most [memory].
- **Multi-cam.** `AVCaptureMultiCamSession` has `hardwareCost` and `systemPressureCost`, both
  must stay under 1.0 [doc][hwcost]; multi-cam formats are smaller (typically up to 1920×1440 at
  30 fps) [memory]. Not worth it for v1.
- **Intrinsics.** Set `isCameraIntrinsicMatrixDeliveryEnabled` on the video data output's
  connection (after inputs are added), and read `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix`
  from each buffer [doc][intrdoc]. The matrix is in pixels of the delivered buffer [memory] and
  changes slightly with lens position (focus breathing) [forum][breath], so send it per frame, as
  the protocol already does.

## 3. Getting frames to the Mac

- **JPEG over a socket** is simplest and has no inter-frame delay. Hardware JPEG of a 1080p frame
  is a few milliseconds; at quality 0.7 a 1080p frame is roughly 150–300 KB, i.e. 70–140 Mbit/s at
  60 fps [memory]. Eye crops (two 256×256 at native resolution) plus a 640-wide overview are well
  under 20 Mbit/s and suit Wi-Fi. Disable Nagle (`TCP_NODELAY`) and drop frames when the socket
  backs up.
- **HEVC/H.264 with VideoToolbox.** Low-latency rate control
  (`kVTVideoEncoderSpecification_EnableLowLatencyRateControl`, iOS 14.5+) cuts up to 100 ms at
  720p30 versus the default [doc][vtll]; it is documented for H.264, and reports say creation fails
  with error 12902 in some configurations [forum][vt12902]. Compression smears the fine iris edge
  the engine needs; use it only for the overview stream.
- **USB.** macOS runs `usbmuxd`; `iproxy 9000:8080` (Homebrew `libusbmuxd`) forwards a Mac port to
  a port on the phone over the cable [man page][iproxy]. Lightning is USB 2 (480 Mbit/s); USB-C Pro
  models support USB 3 [memory]. No latency figures found; wired avoids Wi-Fi jitter and power-save
  stalls.

## 4. Thermal limits

`AVCaptureDevice.systemPressureState` reports a level (nominal → shutdown) and `factors`
(system temperature, peak power, depth module temperature); at shutdown capture stops. Apple's
advice is to lower the frame rate, which can be done live via `activeVideoMinFrameDuration`
[doc][press][tn2445]. A developer saw TrueDepth fall from 15 to 5 fps when serious [forum][thermal].
Continuous 4K60 plus JPEG encoding will heat the phone within tens of minutes [memory].

## 5. Vision landmarks on partial faces

`VNDetectFaceLandmarksRequest` first detects a face, then fits landmarks normalised to the face box;
`leftPupil`/`rightPupil` exist and the 76-point constellation adds per-point precision estimates
[doc][vision]. Nothing documents behaviour on a tight eye crop; it needs a whole face, so run it on
the downscaled overview, not on crops [unverified].

## What to build

1. **Rear wide, physical device, 2× native crop, locked lens.** `builtInWideAngleCamera`,
   enumerate formats for 4K60 (fall back to 1080p60) whose `secondaryNativeResolutionZoomFactors`
   includes 2×; lock focus, exposure (≤ 1/120 s) and white balance after aiming; disable face-driven
   AF/AE and stabilisation. Report every lens and format fact in `hello`.
2. **Send native-resolution eye crops as JPEG plus a small overview**, per-frame intrinsics, drop
   when slow. Skip HEVC for crops.
3. **ARKit mode as a separate, quick-to-start estimator**, using per-eye transforms and head pose
   as regression features, never `lookAtPoint`'s length. Expect 1–3° after calibration.
4. **Zoom via `videoZoomFactor` only**; never swap devices mid-session.
5. **Thermal guard:** observe `systemPressureState`; at `serious` drop to 30 fps, at `critical` to
   15 fps and stop the overview; include the level in `status` messages.
6. **USB later:** document `iproxy` as an option; Wi-Fi is the default.
7. **Defer** LiDAR depth (distance only) and multi-cam; ARKit or iris size already gives distance.

[lookat]: https://developer.apple.com/documentation/arkit/arfaceanchor/lookatpoint
[grein]: https://unpaywall.org/10.1007%2F978-3-030-49059-1_32
[parker]: https://omlab.berkeley.edu/eye-and-head-movement-recordings-using-smartphones-for-telemedicine-applications-measurements-of-ac.html
[gla]: https://www.gla.ac.uk/news/headline_1168103_en.html
[rgbd]: https://www.figlab.com/research/2022/rgbdgaze
[forum-cal]: https://developer.apple.com/forums/thread/803872
[res]: https://developer.apple.com/forums/thread/724790
[beam]: https://eyeware.tech/blog/eye-tracking-and-head-tracking-app-at-mwc2021/
[formats]: https://developer.apple.com/documentation/arkit/arconfiguration/supportedvideoformats
[analytics]: https://developer.apple.com/documentation/analytics-reports/arkit-video-formats
[zoom]: https://developer.apple.com/documentation/avfoundation/capture-device-zoom
[zoomforum]: https://developer.apple.com/forums/thread/719602
[wwdc22]: https://developer.apple.com/videos/play/wwdc2022/110429/
[intr]: https://developer.apple.com/forums/thread/82668
[mfd]: https://developer.apple.com/forums/thread/772553
[hwcost]: https://developer.apple.com/documentation/avfoundation/avcapturesession/hardwarecost
[intrdoc]: https://developer.apple.com/documentation/avfoundation/avcaptureconnection/iscameraintrinsicmatrixdeliverysupported
[breath]: https://developer.apple.com/forums/thread/654288
[vtll]: https://developer.apple.com/videos/play/wwdc2021/10158/
[vt12902]: https://developer.apple.com/forums/thread/685568
[iproxy]: https://linuxcommandlibrary.com/man/iproxy
[press]: https://developer.apple.com/documentation/avfoundation/avcapturedevice/systempressurestate-swift.property
[tn2445]: https://developer.apple.com/library/archive/technotes/tn2445/_index.html
[thermal]: https://developer.apple.com/forums/thread/696078
[vision]: https://developer.apple.com/documentation/vision/vnfacelandmarks2d
