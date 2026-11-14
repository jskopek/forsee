# Vision Pro exploration: is it useful for Forsee despite the gaze limit?

Written 2026-11-13. Two research passes: visionOS input and accessibility, and games, real-world use and other headsets.

**How far to trust this.** `developer.apple.com` and GitHub were readable, so Apple's developer documentation, WWDC transcripts and developer-forum answers were read directly. Apple's support pages, press coverage, vendor blogs and papers were unreachable and come from search extracts. Nothing here was tested on a device. Claims are marked **[read]**, **[extract]** or **[untested]**.

## Short answer

- **A person with no hand movement can use a third-party app on Vision Pro.** Apple's Dwell Control selects what the user looks at with no pinch, and the app receives an ordinary tap. **[read]**
- **The app never learns where the user is looking.** This was confirmed by an Apple engineer in June 2026. So Forsee's own gaze engine (adaptive dwell, drift correction, swipe typing) cannot run on Vision Pro with eyes. **[read]**
- **Vision Pro is worth targeting only in a narrow form:** a phrase-and-prediction speech app in which the system does the selecting, the same mode the v1 plan already has for iPad.
- **If the goal is a headset running Forsee's own gaze engine, Android XR (Samsung Galaxy XR) is the better target.** It documents raw gaze and blink state for apps under a normal permission. **[read]**

## What an app receives

| Input route | Hands needed | What the app gets | Continuous? |
|---|---|---|---|
| Look and pinch (default) | Yes | A tap at the looked-at element; a drag follows the hand, not the eyes | At selection only |
| Dwell Control: long look to tap | No | A tap | At selection only |
| Dwell Control: glance up to confirm | No | A tap | At selection only |
| Switch Control: head nod or shake, sounds, Bluetooth switch, brain-computer interface | No | A tap or activation | At selection only |
| Face gestures (visionOS 27): smile, raised eyebrows | No | A tap or custom command | At selection only |
| Pointer Control driven by head | No (needs dwell or a switch to select) | Probably a tap only; whether hover events reach the app is unknown | **[untested]** |
| System hover effects, including custom and shader effects | No | Nothing; drawn by the system outside the app | Visual only |
| Look to Scroll (visionOS 26) | No | Scroll position changes | When looking at an edge |
| Head position (device pose) | No | Full head position and orientation, no permission prompt | Yes, in an immersive space only |
| Hand tracking | Yes | Hand skeleton | Yes, immersive space plus permission |
| Trackpad, mouse, keyboard, game controllers | Usually | Real pointer hover, clicks, keys | Yes |
| Foveated streaming provider (visionOS 27) | No | Approximate gaze direction | Yes, but Apple-approved streaming apps only |

Key evidence:

- Apple's privacy guidance: the system changes a view's appearance when someone looks at it "without your app ever knowing what the user is looking at". **[read]** https://developer.apple.com/documentation/visionos/adopting-best-practices-for-privacy
- A developer building Dasher for visionOS tested every hover API on hardware and received zero events. The Apple engineer's reply: "gaze is not exposed outside the system, but you could accomplish this with head tracking." **[read]** https://developer.apple.com/forums/thread/835881
- Dwell Control "supports gestures like tap, scroll, long press, and drag". **[read]** https://developer.apple.com/videos/play/wwdc2023/10034/
- In Safari the page gets a pointer event at the gaze target when the pinch begins, and "the pointer is coarse and doesn't support hovering". **[read]** https://developer.apple.com/videos/play/wwdc2023/10279/

## How games get real-time input

Games do not get gaze either. They use other channels:

- **Hand tracking** in an immersive space, updated at display rate with prediction. **[read]**
- **Controllers:** PlayStation and Xbox pads, and from visionOS 26 the tracked PlayStation VR2 Sense controllers and Logitech Muse. **[read]**
- **Head position**, read every frame. **[read]**
- **Look-then-pinch.** Every game found that is described as "eye-controlled" or "gaze-aimed" is actually look, then pinch to act. None reacts continuously to gaze. **[extract]**

One exception proves it is technically possible. The open-source ALVR streaming client extracts continuous gaze by drawing a system hover effect whose pixels encode the gaze position, then screen-recording its own view and decoding those pixels. **[read, from its source code]** It needs the user to start a screen broadcast each session, and Apple could break it at any time. It is not a foundation for a speech device people depend on.

## Workarounds that could make it useful

Listed from most to least promising.

1. **Let the system do the selecting.** Design for Dwell Control: the app gets taps, and its value is prediction, phrases, voice and layout. This needs no special access.
2. **Show dwell progress anyway.** Custom hover effects can animate a key "filling up" while it is looked at, with a delay and duration chosen by the app, even though the app is never told. **[read]** The user would match the animation length to their system dwell time by hand, because the app cannot read that setting. **[untested]**
3. **Use the canvas for large, central targets.** Measured Vision Pro gaze accuracy is about 1 degree centrally and worse at the edges. **[extract]** Large tiles near the centre, with more reachable by turning the head, fit that better than a wide scatter of small keys.
4. **Use the head as a second channel.** In an immersive space (passthrough stays visible) the app reads head position continuously. That allows a head-pointer mode with Forsee's own dwell timing and adaptive dwell, or nod and shake for cancel and backspace. This is what the Apple engineer suggested to the Dasher developer. It only helps users with reliable head movement.
5. **Faster confirmation in visionOS 27.** Glancing at a marker above the pointer confirms immediately instead of waiting out the timer, and facial expressions can act as a tap. **[extract]**
6. **Eyes-only paging.** Look to Scroll moves through long phrase lists without a selection. **[read]**

Not viable: the foveated streaming gaze data (restricted by Apple to streaming and confined to an extension process **[read]**), and the main camera (enterprise entitlement only **[read]**).

## Evidence from real users

- **Cognixion in-home study** (company-reported, not peer-reviewed): 4 participants, 3 with ALS, using a brain-signal headset with Vision Pro over 5 months. Median typing speed was 8.6 words per minute; the best sessions averaged 26. Eye tracking failed completely for 1 of the 4. **[extract]**
- **Typing speed with eyes on Vision Pro:** about 10 words per minute for look-and-pinch in a 2026 study, and 15–23 in informal tests. No figure was found for dwell-only typing; expect lower. **[extract]**
- **Eye conditions matter.** A user with a drooping eyelid found the device did not track them at all; a user with nystagmus got about half their selections. A one-eye-only setting exists. **[extract]**
- **Existing apps:** Vocable has a Vision Pro version, and several AAC apps list visionOS support. TD Snap and Proloquo4Text do not. **[extract]**

## Reasons for caution

- **Hidden eyes.** People who communicate partly with their eyes lose that channel. Reviewers describe the outward eye display as low-resolution and not real eye contact. **[extract]**
- **Weight and wear time.** 600–650 g on the face, about 2.5 hours of battery, and Apple advises a break every 20–30 minutes. **[extract]** No reports were found on use with ventilator masks or wheelchair headrests.
- **Speaker volume.** The speakers are designed to be heard by the wearer; no loudness figures were found. A conversation in a noisy room would probably need an external speaker. **[untested]**
- **Cost**, and eye tracking that fails for some people.

## Other headsets

| Headset | Raw gaze for apps | Price | Status |
|---|---|---|---|
| Samsung Galaxy XR (Android XR) | Yes: per-eye gaze and blink state under a runtime permission **[read]** | About $1,800 | On sale since October 2025 |
| Meta Quest Pro | Yes | — | Discontinued January 2025 |
| Meta Quest 3 / 3S | No eye tracking hardware | — | Current |
| Varjo XR-4 | Yes | $3,990 and up | Professional |
| HoloLens 2, Magic Leap 2 | Yes | — | End of life or winding down |

Android XR's gaze API: https://developer.android.com/develop/xr/openxr/extensions/XR_ANDROID_eye_tracking

## What this means for the plan

- **No change to v1.** Vision Pro stays out of v1 scope.
- **A Vision Pro version would be cheap to try later.** Forsee's tap-only mode and coarse layouts, built for iPad, are what Vision Pro needs. A compatible iPad build should run there, with taps arriving from Dwell Control. **[untested]**
- **A native visionOS version** would add hover-effect dwell feedback and an optional head-pointer mode. That is a separate project.
- **A headset with Forsee's full gaze engine** points to Android XR, since the Capacitor Android app and the gaze pipeline could carry over.

## Device tests that would settle the open questions

1. Does a head-driven system pointer (Pointer Control) produce hover events in a third-party app or web view? If yes, Forsee could run its own dwell in a normal window.
2. Does a Dwell Control tap reach a web view as a normal click?
3. Does speech from a third-party app play loudly enough for people in the room, and can it be routed to an external speaker?
4. Does Personal Voice work in a third-party app on Vision Pro?
5. Does an external head-mouse that presents as a standard pointer device produce hover events?
6. What is the shortest dwell time the system now allows? A regression in the minimum was reported in 2025 and acknowledged by Apple as a bug.
