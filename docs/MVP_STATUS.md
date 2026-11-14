# MVP status

The first working version of the new app (`apps/web`): a browser app that runs offline once loaded. This page says what a tester can do, what has only been checked with stand-ins, the rough edges found while assembling it, and the device tests still to run. How to run it: [DEVELOPMENT.md](DEVELOPMENT.md#running-the-app). Screenshots: `apps/web/docs/`.

## What a tester can do now

1. Open the app (`pnpm --filter @forsee/web dev`, or a build served with `preview`). It starts in well under a second on the QWERTY layout.
2. **Type by dwell**: rest the mouse (or anything that moves the pointer, such as an eye tracker's mouse emulation) on a key; the key fills left to right and types when full (0.8 s by default; likely next letters a little faster, unlikely ones a little slower). Moving away early types nothing. Looking at the text bar or the screen margin rests.
3. **Type by touch**: on a touch screen, taps select at once (no dwell).
4. **Predictions**: four word candidates above the keyboard; dwell on one to accept it. Words you speak are learned and offered later.
5. **Speak** with the keyboard's Speak key. **Stop** appears in the side bar while speech plays. Delete (letter, then word, then all while you keep looking), Undo and Clear are on the keyboard.
6. **Quick replies** (Yes, No, Thank you, Please wait, Not finished, Repeat that?, Help) in the top row: one dwell speaks at once and leaves the message alone.
7. **Faster / Slower** in the side bar change every dwell time by 0.1 s, show the letter time and say it.
8. **Pause**: covers the screen; nothing can be selected until you look at Resume for 2 s.
9. **Settings** (dwell, click, tap or keyboard): layout (QWERTY, alphabetical, German QWERTZ; large-key two-step groups for less precise pointing), voice (offline voices, Test voice), speaking rate, when to speak (on Speak, each sentence, each word), click sound, typing on a physical keyboard, reset dwell times, and a list of problems.
10. **Restart safely**: the half-written message, what was said, learned words and settings come back after a reload.
11. A physical keyboard types too (letters, space, Backspace, Enter to speak), unless turned off in Settings.

## Verified only with stand-ins

The end-to-end tests (`apps/web/e2e`) run the real app in headless Chromium with a real mouse and real timers. These parts were not checked for real:

- **Speech output.** Headless Chromium has no voices, so speech was checked with a recording fake `speechSynthesis` (what would be said, with which voice and rate, start and end events). No real voice has been heard. The no-voice path (notice, text kept) was checked with the real headless browser.
- **"Speech needs a first click"** was simulated by the fake refusing with `not-allowed` until a pointer or key press, as Chrome and Safari do.
- **Touch** was Playwright's touch emulation, not a touch screen.
- **Eye trackers** were never used; only the mouse. Trackers that move the pointer should behave like the mouse.
- **Storage**: OPFS (on `localhost`) and IndexedDB (plain HTTP on a LAN name) in Chromium only. Safari and Firefox storage were not exercised.
- **Browsers**: only Chromium. Nothing ran in Safari, WebKit or Firefox.
- **Click sound**: wired and switchable; nobody listened to it.
- **`prefers-reduced-motion`** and **safe-area insets** are in the CSS but were not checked on a device.

## Rough edges found

- **After Resume, the key under your eyes starts dwelling at once.** The wake target covers the middle of the keyboard; when it disappears, the key underneath engages immediately and types after a normal dwell if the user keeps looking there. A short "look away first" after waking (gaze engine) would fix it.
- **A gaze-only user cannot turn speech on alone.** Browsers allow speech only after a click, tap or key press; a dwell is not one. Until then a full-width "Speech is off until this page gets a click or tap" prompt replaces the quick replies, and the first click or tap anywhere (for example by a carer) releases what was waiting. In Chrome this happens on the first Speak after loading if nothing has been clicked, tapped or typed yet.
- While speech is held that way, the message has already been committed and cleared; it is spoken as soon as speech is allowed (and is in history, one Undo away), but it is not shown in the meantime.
- **Announcements are spoken**: each Faster/Slower step says "Dwell 0.7 seconds". On a device without voices each one leaves a "Could not speak" notice (they share one notice).
- **Portrait** works but the QWERTY keys are narrow and very tall (about 62 x 190 px on a 820 x 1180 iPad); landscape is better.
- **Typing on a physical keyboard** takes Enter and Space on the main screen, so a keyboard user who tabs to a key cannot press it with Enter or Space while that setting is on (Settings is unaffected).
- **Help** says "Help"; there is no alarm sound yet.
- The settings are minimal: individual dwell times, pitch, volume and gaze filter settings exist in the runtime but have no screen yet.
- The notice for unspoken text shows three lines; longer text is cut (Put text back shows it in full).
- The app is one 770 KB script (most of it the word model). The first load needs the network; there is no service worker, so reopening it offline depends on the browser cache.
- On GitHub Pages every project site of the same owner shares one origin, and so one browser storage area (the profile is in its own folder or database, `forsee-profile`).

## Device tests for the owner

For each: open the app, type a short sentence, accept a prediction, Speak, use a quick reply, Pause and Resume, open Settings and change the voice, reload and check the half-written text came back.

| Device and input                                       | How                                                     | What to look for                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, mouse                                         | `dev` or `preview` on `localhost`                       | Dwell fill smooth and timed; nothing fires when you move away early; Stop appears while speaking; the voice list shows your system's offline voices; click sound audible and not delayed.                                                                                                |
| Real eye tracker via its mouse emulation (Tobii, etc.) | Same, on the tracker's computer                         | Jitter does not reset dwell on large keys; the margin and text bar really rest; whether 0.8 s is a sensible default; whether the coarse layout is needed; the first Speak shows the "turn on speech" prompt until someone clicks.                                                        |
| Touch laptop                                           | `preview --host` or `localhost`                         | Taps type at once with no dwell; the mouse brings dwell back; no double letters from a tap.                                                                                                                                                                                              |
| iPad Safari, touch                                     | `preview --host`, open the Network address (plain HTTP) | Layout in landscape and portrait, safe areas (no keys under the home indicator); speech after the first tap; Settings → Voice lists Siri/system voices; reload keeps text (IndexedDB over HTTP); Add to Home Screen opens full-screen with the icon. Repeat over HTTPS (Pages) for OPFS. |
| iPad Safari with system Eye Tracking or Dwell Control  | Accessibility settings on, same address                 | The system's dwell produces taps: the app should treat them as direct selection (no double dwell). Check the pointer does not also trigger in-app dwell while the system pointer rests; check Pause/Resume and the settings sheet are reachable.                                         |
| Vision Pro Safari with Dwell Control                   | Same address                                            | Targets large enough for gaze; pinch and dwell both select once; the window size and portrait/landscape switch; whether speech is allowed after the first pinch.                                                                                                                         |

Report anything odd with the screen size, browser version and what the Problems list in Settings says.
