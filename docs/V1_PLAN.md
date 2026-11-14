# V1 plan: the best open-source eye-tracking speech keyboard

Written 2026-11-13. This plan covers v1 only: a free, open-source, fully offline eye-tracking keyboard for spoken conversation that runs on macOS, Windows, iPadOS/iOS and Android, with a plugin system. Server-side AI, sync and the "conversation speed" research are v2 and arrive as plugins.

Revised the same day after a deep dive into on-device AI. The full findings, with evidence tags, are in [`reports/On device AI for speech keyboard.md`](../reports/On%20device%20AI%20for%20speech%20keyboard.md).

The app is called **Forsee** (package scope `@forsee/*`).

## Contents

1. [What v1 is](#1-what-v1-is)
2. [What the research found](#2-what-the-research-found)
3. [What "best" means: feature scope](#3-what-best-means-feature-scope)
4. [Architecture](#4-architecture)
5. [The input pipeline](#5-the-input-pipeline)
6. [The plugin system](#6-the-plugin-system)
7. [Speech, prediction and storage](#7-speech-prediction-and-storage)
8. [Platform notes](#8-platform-notes)
9. [From the current code to v1](#9-from-the-current-code-to-v1)
10. [Work packages](#10-work-packages)
11. [Risks](#11-risks)
12. [Open decisions](#12-open-decisions)
13. [Sources](#13-sources)

---

## 1. What v1 is

**Product stance (opinionated):**

1. The product is for spoken conversation. Writing documents and controlling the computer are out of core scope.
2. Every platform runs the same full-screen app.
3. It works entirely offline. No account, no server, no network request in the default install.
4. Anything beyond the speech core is a plugin, and the speech core is itself built from plugins on the public API.
5. It works with whatever moves a pointer, with a webcam, and with dedicated eye trackers. No hardware lock-in.

**Measurable targets for v1:**

| Target | Value | Why |
|---|---|---|
| Sustained typing speed, IR tracker, practised user | 15–20 words per minute | Best published dwell results are 18–20; a logged real-world ALS user averaged 8 |
| Usable with a plain webcam | Yes, on a coarse layout with large targets | Webcam accuracy is roughly 3–4°, so targets must be 4–5 cm |
| Time from app launch to first spoken word | Under 10 seconds, no setup required when a pointer source exists | Reliability matters more than features |
| Dwell feedback latency | One frame (16 ms) from fixation to visible progress | Feedback quality is a documented speed factor |
| Network requests in default install | Zero, enforced by a test | Offline is a promise |
| Text loss on crash | None; composition restored on restart | Losing a half-typed sentence costs minutes |

## 2. What the research found

Four research passes were run (competitive benchmark, gaze input routes, app shell and plugins, offline speech and prediction). Several vendor and paper sites were unreachable from the research environment, so some figures come from search extracts. Items that need checking before any public claim or licence decision are listed in [section 11](#11-risks).

### Competitive position

- **Nobody is cross-platform, hardware-agnostic and offline.** Tobii Dynavox TD Talk only does gaze on Tobii hardware. Grid 3 is Windows (£550) and its iPad version has no eye gaze per Smartbox's own comparison. OptiKey is free but Windows-only and GPL-3.0.
- **Dasher v6** (MIT, preview beta June 2026) is the only other open project heading to multiple platforms. It is a zooming text-entry method, not a conversation tool. Worth watching and possibly integrating as a plugin.
- **Only OptiKey has code plugins**, and only for tracker drivers on Windows. A plugin ecosystem for a speech keyboard does not exist.
- **Calibration is the top user complaint**, ahead of speed. One family spent about three months failing to get a commercial device calibrated.
- **Conversation features are thin everywhere.** Partner-facing displays exist only on Tobii hardware. Quick interjections and floor-holding ("hold on", "not finished") exist only in research.

### Typing speed evidence

| Method | Words per minute | Note |
|---|---|---|
| Fixed dwell, typical | 5–10 | |
| Real ALS user, field logging 2021–22 | 8.1 ± 3.9 | Google SpeakFaster Observer |
| User-adjustable dwell after 10 sessions | 6.9 → 19.9 | Dwell fell from 876 ms to 282 ms. Biggest single documented gain |
| Cascading dwell (dwell shortened for likely next letters) | 12.4 vs 10.6 static | No new skill for the user to learn |
| Multi-threshold dwell, novices | 18.3 vs 12.9 | |
| Dwell-free "swipe" (EyeSwipe, Filteryedping) | 11.7–16 | Simulated ceiling with a perfect recogniser is 46 |
| Dasher with a strong language model | 12.6–17.3 | |

Conclusion: the cheapest large wins are **adjustable per-class dwell**, **dwell that adapts to the language model**, and **good feedback**. Swipe typing has a high ceiling but real systems underdeliver, so it is a stretch goal for v1.

### Gaze input

- **The universal route is "something moves the system pointer and the app does its own dwell."** It works on every platform with no licence exposure. It is what the current prototype already does.
- **Tobii's consumer tracker (Eye Tracker 5) is a legal hazard.** Tobii declares it gaming-only, and its SDK licence appears to class AAC as "Medical Use" needing a separate licence. OptiKey dropped these trackers in v4. Do not ship Tobii SDK integration without written permission.
- **Windows has a vendor-neutral gaze API** (`GazeInputSourcePreview`, for trackers that follow the USB HID eye-tracker standard). Whether it works from an Electron app is untested.
- **iPad gives apps no gaze data.** Built-in Eye Tracking and Made-for-iPad trackers (TD Pilot, Irisbond Hiru, Skyle) all go through AssistiveTouch and reach the app as a pointer or taps. A WebKit bug report suggests a web view may receive taps only, with no continuous hover. This must be tested on a device.
- **Webcam gaze for an MIT project:** MediaPipe Face Landmarker (Apache-2.0) plus our own calibration, with WebEyeTrack (MIT, 2025) as the first model to evaluate. WebGazer is GPLv3 and no longer maintained; avoid it.
- **Vision Pro is confirmed out:** apps get no gaze data and no main camera without an enterprise entitlement.

### App shell and plugins

- **Obsidian's model is Electron on desktop and Capacitor on mobile**, with one JavaScript plugin bundle running in both. That is the proven route to "same plugins everywhere".
- **Obsidian has no sandbox** and says so: community plugins can read files, use the network and install programs. In May 2026 Obsidian added automated review of every plugin version and announced capability disclosures, which is an admission that the original model was too loose.
- **Apple's rules allow JavaScript plug-ins** (guideline 4.7) but forbid exposing native APIs to them without permission (4.7.2), require explicit per-plugin consent before sharing data or privacy permissions (4.7.3), and require an index of the available software (4.7.4). A permission system with per-plugin consent is therefore close to mandatory on iOS.
- **Tauri 2** is the runner-up shell. It loses because macOS would use the system web view (inconsistent with Windows), mobile support is younger than Capacitor's, sidecar processes are unsupported on mobile, and a v3 migration is coming.

### Offline speech and prediction

- **Voices:** operating-system voices are the reliable offline default. The browser speech API is missing in Android's web view. Apple Personal Voice is available to third-party apps through a native authorisation call. Windows does not let apps use its newer "natural" voices.
- **Neural voices:** most open engines (Piper, Kokoro) depend on espeak-ng, which is GPL-3 and must stay out of an MIT core. Kyutai Pocket TTS avoids it: MIT code, about 200 ms to first audio on a laptop, and it clones a voice from a few seconds of clean audio. Its weights licence has not been verified. Supertonic, an earlier candidate, is now archived and has no cloning route. sherpa-onnx (Apache-2.0) is the practical cross-platform runtime.
- **Prediction:** a small n-gram engine with a per-user adaptive layer answers in well under a millisecond on any device. General on-device language models of 1B parameters and up manage roughly 6–18 tokens per second on mid-range phones, which is too slow to run on every keystroke. Keyboard-sized models are a different matter; see the deep dive below.
- **The prototype's word list is a licence problem.** SUBTLEX-US is reported as CC BY-NC-ND. It must be replaced.
- **Message banking** is established clinical practice: people record whole phrases in their own voice before losing it. A phrase tile must be able to play a recording instead of synthesised speech.

### On-device AI deep dive

A second research pass looked at what local models can do today. Its conclusions, which change parts of this plan:

- **Word prediction does not need a large model.** Keyboard models are 25–40 million parameters. An open example (Typeling-25M, Apache-2.0, November 2026) is 28 MB, answers a full keystroke query in about 25 ms on a laptop processor, and saves 58% of keystrokes with a three-word bar against 49% for a trigram. These are the project's own benchmarks, not independently replicated, and nothing has been measured on a tablet.
- **Such a model is cheap to train.** Continued training on 150 million tokens took 40–55 minutes on one laptop graphics card, using permissively licensed text.
- **It tolerates noisy input better.** With every longer word mistyped, the trigram's savings fell by 9 points and the neural model's by 4. That matters for gaze, where the wrong key is hit often.
- **Models cannot run in the mobile web view.** On iPhone and iPad a web view reliably gets only about 300 MB for this kind of work and fails by silently reloading the page.
- **Two permissive native libraries cover all four platforms:** llama.cpp (MIT) for language models and sherpa-onnx (Apache-2.0) for speech.
- **Operating-system models cannot be the only engine.** Apple's, Google's and Microsoft's built-in models have content filters, short context and narrow device support.
- **Sentence-level replies and partner transcription remain v2.** The hardware can do it on recent Macs and flagship phones, but the only rigorous eye-gaze evidence is a two-person study.

## 3. What "best" means: feature scope

Priorities: **P0** is required for v1, **P1** is what makes v1 better than the incumbents, **P2** is a stretch.

### Input and selection

| Feature | Priority |
|---|---|
| Pointer source: anything that moves the system pointer | P0 |
| Tap/click mode with in-app dwell off, for iPad system dwell and touch use | P0 |
| Webcam gaze source with calibration | P0 |
| External driver source over a local socket (protocol + mock driver) | P0 |
| Dwell with separate times for letters, predictions, function keys and destructive keys | P0 |
| In-place dwell adjustment ("faster" / "slower" without opening settings) | P0 |
| Visual progress plus audible click, matched to dwell length | P0 |
| Jitter tolerance: progress decays instead of resetting when gaze briefly leaves a key | P0 |
| Rest zones and a pause-gaze control that needs a deliberate wake | P0 |
| Smoothing (One Euro filter) and fixation detection | P0 |
| Calibration quality score shown to the user | P0 |
| Language-model-adaptive dwell (likely next letters fire sooner) | P1 |
| Continuous drift correction learned from confirmed selections | P1 |
| Switch selection (gaze to point, switch or key to select) | P1 |
| Windows HID gaze driver | P1 |
| Head-pointer source (webcam) | P2 |
| Dwell-free swipe typing | P2 |
| Blink selection | P2 |

### Layouts

| Feature | Priority |
|---|---|
| Layouts defined as data (JSON), rendered by the host | P0 |
| "Precise" family: full QWERTY and alphabetical, about 30 targets, for IR trackers | P0 |
| "Coarse" family: 12 or fewer large cells with two-step letter groups, for webcams | P0 |
| Numbers and punctuation pages | P0 |
| Targets enlarged at screen edges and corners | P1 |
| Per-language layouts; at least one non-English layout to prove the mechanism | P1 |
| In-app layout editor | P2 |

### Text and speech

| Feature | Priority |
|---|---|
| Composition bar with delete letter, delete word, clear, undo | P0 |
| Speak on demand, speak each sentence, speak each word (clear default) | P0 |
| Operating-system voices with voice, rate and pitch settings | P0 |
| Stop speaking immediately | P0 |
| Word completion and next-word prediction that learn the user's vocabulary | P0 |
| Phrase bank with categories | P0 |
| Quick-fire bar: one-dwell interjections ("yes", "no", "hold on", "not finished") | P0 |
| Conversation history with re-speak | P0 |
| Always-available "get attention" alarm target | P0 |
| Message banking: phrase tiles that play a recording of the user's own voice | P1 |
| Phrase suggestions recalled from the user's own history | P1 |
| Neural keyboard model that refines word predictions, on devices measured to be fast enough | P1 |
| Partner display: second window or screen showing text as it is composed, with a "composing" indicator | P1 |
| Apple Personal Voice | P1 |
| Downloadable neural voice pack, including a voice cloned from the user's own recordings with their consent | P2 |
| Expressive controls (emphasis, tone presets) | P2 |

### Platform, plugins and care

| Feature | Priority |
|---|---|
| macOS and Windows desktop apps | P0 |
| iPad and Android apps from the same code | P0 (built), P1 (verified on devices and published) |
| Plugin API with declarative, logic and custom-UI tiers | P0 |
| Permission manifest with per-plugin consent | P0 |
| Restricted mode (no community code) on by default | P0 |
| Settings operable by gaze, plus a caregiver mode operable by touch or mouse | P0 |
| Profiles with export and import | P0 |
| Crash recovery of the composition | P0 |
| In-app plugin browser and community directory | P1 |
| Usage statistics kept locally (speed, error rate) for the user and therapist | P1 |
| Auto-update on desktop | P1 |

### Explicitly not in v1

Cloud AI suggestions, partner speech transcription, camera context, sync, accounts, typing into other apps, mouse emulation, symbol-based boards, and the Vision Pro companion mode described in section 8.

## 4. Architecture

### Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict | One language for core, UI and plugins |
| UI | React 19 + Tailwind | Already used; keeps existing styling |
| Build | pnpm workspaces, Vite, Vitest, Playwright | Create React App is retired; Playwright can drive synthetic gaze |
| Desktop shell | Electron | Consistent Chromium for camera ML and audio; easy sidecar processes |
| Mobile shell | Capacitor 8 | Obsidian's route; mature iOS and Android web view shells |
| Camera ML | MediaPipe Tasks Vision (WASM), WebGPU when present | Apache-2.0, runs in all four web views |
| Model inference | Native service behind the host bridge: llama.cpp for language models, sherpa-onnx for speech | Mobile web views cannot hold models; both libraries are permissive and cover all four platforms |
| Storage | Plain files: JSON and append-only JSONL | See [section 7](#storage) |
| CI | GitHub Actions | Lint, typecheck, unit tests, headless end-to-end tests, shell builds |

### Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Shells: apps/web (dev + demo) · apps/desktop · apps/mobile     │
│   each implements HostBridge: files, voices, windows,          │
│   sidecars, model inference                                    │
├──────────────────────────────────────────────────────────────┤
│ UI (packages/ui): regions, GazeTarget, keyboard view, settings │
├──────────────────────────────────────────────────────────────┤
│ Plugin host (packages/plugin-host): loader, permissions,       │
│   sandbox, RPC                                                 │
│ First-party plugins (plugins/*): keyboard, prediction,         │
│   phrases, quick-fire, history, partner display, voices        │
├──────────────────────────────────────────────────────────────┤
│ Engines, pure TypeScript with no DOM:                          │
│   core · gaze · prediction · speech · storage · layouts        │
└──────────────────────────────────────────────────────────────┘
```

Rules that keep this portable:

- **Engine packages never touch the DOM, Node or Electron.** They run in a browser, a worker, Node tests and both shells unchanged.
- **Everything platform-specific goes through `HostBridge`.** Plugins never see it; they see the plugin API, which the host implements on top of it.
- **Native device drivers are separate processes** speaking a small JSON protocol over a local WebSocket. A driver can be written in any language and carries its own licence, which keeps proprietary SDKs out of the MIT repo.
- **Models run in native code, never in the web view or a plugin sandbox.** The host exposes an inference service (load a model, score next tokens, generate, transcribe, synthesise). On desktop it runs in an Electron utility process; on mobile it is one in-house Capacitor plugin. Plugins ask the host to run a model; they do not load weights themselves.
- **Nothing in the default install depends on a model.** The app must be fully usable with no model downloaded.

### Repository layout

The new code is added alongside the existing Django app and React prototype, which stay where they are.

```
apps/
  web/            Vite host for development, tests and the public demo
  desktop/        Electron shell
  mobile/         Capacitor shell (ios/, android/)
packages/
  plugin-api/     Public types: manifest, contributions, permissions, RPC
  core/           Event bus, commands, composition buffer, settings, extension registry
  host/           HostBridge interface + browser implementation
  gaze/           Samples, filters, fixation, targets, selection, calibration maths
  gaze-web/       Pointer, WebSocket and webcam sources
  prediction/     Tokeniser, n-gram runtime, user model, completions
  speech/         Voice provider interface, utterance queue, providers
  storage/        Profile store, history log, export/import
  layouts/        Layout schema, validator, built-in layouts
  plugin-host/    Loader, permission manager, sandbox, installer
  inference/      Inference service interface, capability tiers, model registry
  ui/             React components and themes
plugins/          First-party plugins and sample plugins
sidecars/         Driver protocol, mock driver, native drivers
tools/            Language-model builder, typing evaluation harness, directory validator
directory/        Community plugin directory format (moves to its own repo later)
docs/             This plan, architecture decisions, plugin and driver guides
```

### Core concepts (`packages/core`)

- **Event bus:** typed, synchronous publish/subscribe. Every state change is an event, which is what plugins and tests observe.
- **Commands:** every action has an id (`composition.insert`, `speech.speak`, `gaze.pause`). Keys, plugins and tests all invoke commands; nothing calls UI handlers directly.
- **Composition buffer:** the text being written, with insert, delete letter, delete word, clear, replace-last-word (for predictions) and undo. It persists on every change for crash recovery.
- **Conversation log:** utterances by the user and, later, by partners. v1 writes only the user's side.
- **Settings registry:** each setting has a typed schema (carried over from the prototype's `SettingField`), so the settings screen is generated and is gaze-operable for free.
- **Extension registry:** named contribution points that plugins fill; see [section 6](#6-the-plugin-system).
- **Regions:** the screen is divided into named regions (composition bar, quick-fire bar, prediction strip, main area, side panels). Plugins contribute panels to regions; the user's profile decides which are shown and how large.

### Capability tiers

The app detects what the device can hold and offers features accordingly. Tier 0 is the default install and the fallback when the device is hot or low on battery. The memory figures and device mapping are engineering estimates that need validation on real devices.

| Tier | Contents | Resident memory | Typical devices | Version |
|---|---|---|---|---|
| 0 | n-gram and user cache, operating-system voice, nothing to download | Under 100 MB | Any device | v1 |
| 1 | Keyboard language model, small neural voice; later voice detection and small streaming transcription | 0.5–1 GB | 4–6 GB Android, older iPads, 8 GB Windows laptops | v1 for the keyboard model; rest later |
| 2 | Tier 1 plus a 1B-class model loaded on demand | 1.5–2.5 GB | 8 GB phones and tablets, 8 GB Macs, 16 GB Windows laptops | v2 |
| 3 | Tier 2 plus a 3–4B model and a heavier cloned voice | 3.5–6 GB | 16 GB Macs, M-series iPads, flagship phones | v2 |

Model weights are downloaded after install, on the user's request, and are stored outside the profile folder so that profiles stay small.

## 5. The input pipeline

This is the heart of the product, and the same pipeline serves every input device.

```
Source → calibration correction → filter → fixation detection
       → hit test against registered targets → selection method → command
```

### Sources

A source emits samples and declares what it is:

```ts
interface GazeSample { x: number; y: number; t: number; confidence: number; valid: boolean }
interface GazeSource {
  id: string;
  kind: 'pointer' | 'gaze';          // pointer: already smoothed by someone else
  capabilities: { calibrate: boolean; hover: boolean };
  start(onSample: (s: GazeSample) => void, onError: (e: SourceError) => void): void;
  stop(): void;
  calibrate?(session: CalibrationSession): Promise<CalibrationResult>;
}
```

| Source | Platforms | v1 |
|---|---|---|
| Pointer (mouse, OS eye control, any tracker's mouse emulation) | All | P0 |
| Tap only (no hover; iPad system dwell) | All | P0 |
| Webcam (MediaPipe landmarks + our calibration) | All | P0 |
| WebSocket driver (external process) | Desktop | P0 |
| Windows HID gaze driver (sidecar using `GazeInputSourcePreview`) | Windows | P1 |
| ARKit `lookAtPoint` (TrueDepth) | iPad/iPhone | P2 |

### Targets

UI elements do not handle hover themselves. Each selectable element registers a **target** with the target registry: an id, a rectangle, a dwell class, an optional likelihood and the command to run. The registry does the hit test, which lets the engine:

- **Expand targets** beyond their visible bounds and add hysteresis, so jitter at a key edge does not flip between neighbours.
- **Scale dwell time per target** from the language model (adaptive dwell).
- **Apply one consistent feedback style** (progress fill, click sound) everywhere, including inside third-party plugin panels.
- **Withhold raw gaze from plugins** unless they hold the `gaze.read` permission.
- **Report uncertainty to the predictor.** Each selection carries a probability over the nearby keys, not only the key that fired. A predictor that accepts this can correct a fixation that landed between two letters.

### Selection methods

| Method | Behaviour |
|---|---|
| Dwell | Progress accumulates while fixated, decays when gaze leaves briefly, fires at the class threshold, then requires a look-away or a longer repeat interval |
| Direct | A click or tap fires immediately; in-app dwell is off |
| Switch | Gaze highlights a target; a key, switch or blink confirms |
| Swipe (P2) | Dwell on the first letter, glance through the word, dwell on the last; a decoder proposes words |

Dwell details that the research says matter:

- **Classes:** letters, predictions, function keys, destructive keys (clear, delete word) each have their own time.
- **Adaptive dwell:** a target's time is multiplied by a factor from its likelihood, bounded so that unlikely letters never become unreachable.
- **In-place adjustment:** "faster" and "slower" keys change dwell by a step and say the new value.
- **Rest and pause:** the composition bar and margins are rest zones that never fire. A pause control stops all selection until a long deliberate dwell on a wake target.

### Calibration and drift

- **Calibration** (webcam and raw-gaze sources): a short sequence of targets; fit a correction model; report a quality score in plain terms ("good enough for the large layout", "good enough for the full keyboard").
- **Layout follows accuracy:** the measured accuracy recommends the precise or coarse layout family.
- **Drift correction (P1):** each confirmed selection is evidence that the user was looking at that key's centre. A slow-moving offset correction is learned from these, with a one-dwell "recentre" control as a manual fallback.

## 6. The plugin system

### Extension points

| Point | Tier | Examples |
|---|---|---|
| Layouts | Declarative | Keyboards, number pads, phrase boards |
| Themes | Declarative | High contrast, dark, large print |
| Phrase sets | Declarative | Medical needs, greetings, a language pack |
| Vocabularies | Declarative | Names, places, professional terms |
| Settings | Declarative | Schema-driven, rendered by the host |
| Commands | Logic | New actions bindable to keys |
| Prediction providers | Logic | Alternative word, phrase or sentence predictors |
| Context providers | Logic | Time of day, location, later: partner speech, people present |
| Text transforms | Logic | Abbreviation expansion, autocorrect |
| Voice providers | Logic | Neural voice packs, cloud voices |
| Output sinks | Logic | Send to a messaging app, share sheet, home automation |
| Panels | Custom UI | A suggestion panel, a game, a visual phrase picker |
| Gaze sources | Driver | Tracker drivers as external processes (desktop) |

Selection methods and input filters are first-party only in v1. They are safety-critical, and the interface should settle before it is opened.

**Context providers and prediction providers are deliberately separate.** A context provider writes facts into a shared context store ("it is evening", later "Sam is in the room"). Any prediction provider with permission can read them. That separation is what will let the v2 autocompletion research proceed as independent plugins.

**Plugins do not load models.** A prediction, voice or transcription plugin that needs a model asks the host's inference service to run one, under the `inference` permission. This keeps large weights out of sandboxed frames, lets several plugins share one loaded model, and lets the host refuse or unload models when the device is short of memory or hot.

### Three tiers of trust

1. **Declarative plugins contain no code.** JSON only; the host renders everything and owns all interaction. This should cover most community plugins and is safe on every platform, including under Apple's rules.
2. **Logic plugins run isolated.** Each runs in its own sandboxed frame with an opaque origin and a content security policy that blocks all network access unless granted; its code runs in a worker inside that frame so a slow plugin cannot stall typing. It talks to the host only through an asynchronous message API.
3. **Custom-UI plugins render inside a sandboxed frame** placed in a region. The frame is never directly interactive. The plugin registers its selectable rectangles with the host; the host does hit testing and dwell, draws the progress indicator on top, and sends back `activate` events. This keeps dwell behaviour identical everywhere and stops a panel from reading gaze through mouse events.

First-party plugins run in the main context for performance, on exactly the same API.

### Manifest

```jsonc
{
  "id": "community.example-phrases",
  "name": "Example phrases",
  "version": "1.2.0",
  "apiVersion": 1,
  "minAppVersion": "1.0.0",
  "description": "…",
  "author": "…",
  "authorUrl": "…",
  "fundingUrl": "…",
  "platforms": ["desktop", "mobile"],
  "main": "main.js",                       // optional: logic entry
  "panels": [{ "id": "picker", "entry": "panel.html", "region": "side" }],
  "contributes": {
    "layouts": ["layouts/compact.json"],
    "phraseSets": ["phrases/greetings.json"],
    "settings": [{ "key": "tone", "type": "select", "default": "casual", "options": ["casual", "formal"] }]
  },
  "permissions": ["composition.read", "speech.output"],
  "optionalPermissions": ["history.read"]
}
```

### Permissions

| Scope | Grants |
|---|---|
| `composition.read` / `composition.write` | See or change the text being written |
| `history.read` | Past conversations |
| `speech.output` | Speak aloud |
| `gaze.read` | Raw gaze samples |
| `camera`, `microphone` | Device streams, mediated by the host |
| `network:<host>` | Requests to one named host |
| `lm.read` / `lm.write` | The user's personal language data |
| `inference` | Run a model through the host's inference service |
| `native.sidecar` | Launch a driver process (desktop only) |

A plugin's own private storage needs no permission. Consent is requested at install and again at first use of each sensitive scope, is recorded per plugin, and can be revoked. History, camera and microphone are never granted silently.

### Distribution

- **Restricted mode is on by default.** Community code does not run until the user turns it on.
- **Directory:** a Git repository holding one JSON list. Each entry names the plugin's repository and, for every version, the bundle's SHA-256 hash, its minimum app version and its declared permissions. Installs are pinned to the hash, which closes the gap Obsidian had where updates were never reviewed.
- **Validation:** a script run in the directory's CI checks the manifest schema, the hash and the declared permissions on every submission and update.
- **Side-loading:** a plugin folder dropped into the profile's `plugins/` directory loads in developer mode, as in Obsidian.
- **Mobile fallback:** if Apple rejects downloadable logic plugins, iOS ships first-party plugins in the binary and accepts declarative community plugins only. The tiering makes that a configuration change, not a redesign.

## 7. Speech, prediction and storage

### Speech

```ts
interface VoiceProvider {
  id: string;
  listVoices(): Promise<Voice[]>;
  speak(utterance: Utterance, events: SpeechEvents): SpeechHandle;   // start, word boundary, end, error
  stop(): void;
}
```

| Platform | v1 default provider |
|---|---|
| Electron (macOS, Windows) | Chromium speech synthesis restricted to voices flagged local; these are the OS voices |
| iPad/iPhone | Native plugin over `AVSpeechSynthesizer`, with Personal Voice authorisation (P1) |
| Android | Native plugin over `TextToSpeech`, restricted to voices that need no network |
| Browser demo | Web speech synthesis, with the existing "tap to enable speech" prompt |

Also in the speech package: an utterance queue with immediate stop, the three speak modes, and a **recorded-message provider** that plays an audio file for message banking.

The neural voice pack (P2) goes behind the same interface as a separately installed plugin that runs through the host's inference service, which keeps GPL components and large model files out of the core. Kyutai Pocket TTS is the first candidate: it clones a voice from a few seconds of clean audio and needs no phonemizer. Before it ships, its weights licence must be read, a person must judge whether the cloned voice sounds like the user, and the app needs a consent step that is recorded with the voice. Cloning tools copy impaired speech, so recordings from before the illness matter.

### Prediction

A two-speed predictor behind one interface.

- **Instant layer (tier 0):** our own TypeScript n-gram model (word trigrams with backoff) in a compact binary format, plus a character model for unknown words. It answers in well under a millisecond and drives adaptive dwell.
- **User layer:** counts of the user's own words and word sequences, interpolated with the base model, weighted towards recent use, with a visible list the user can edit and delete. This is the personalisation method with evidence behind it.
- **Neural layer (tier 1, P1):** a 25–50 million parameter keyboard model run by the host's inference service. It refines the instant answer within roughly 20–50 ms. It is enabled per device only after that device class has been measured.
- **Interface:** a prediction request returns the instant answer synchronously and may be followed by a refined answer; the UI replaces candidates without moving the one the user is already dwelling on. Requests carry the typed context and, where available, the per-key probabilities from the input pipeline.
- **Outputs:** word completions, next-word candidates, per-letter probabilities (which drive adaptive dwell and, later, the swipe decoder), and whole-phrase suggestions recalled from the user's history. One constrained search over the neural model can produce the first three together.
- **Evaluation harness:** built before any model. It simulates typing real conversational text letter by letter and reports keystroke savings, top-three accuracy and latency percentiles, with variants for gaze noise and for the time cost of reading candidates. Every prediction change is measured with it.
- **Data:** a build tool turns any text corpus into a model file. Shipped models must come from text whose licence allows redistribution, shipped as separately licensed data files. Candidates to verify: Tatoeba (CC BY), public-domain text, and the permissive set another project trained on (FineWeb, WildChat, OpenAssistant, Ubuntu IRC). DailyDialog is non-commercial and must not be used. Until that is settled, development uses a small seed vocabulary written for this project.
- **Our own model:** training a purpose-built conversational keyboard model is realistic (under an hour per run on a laptop graphics card) and is the most valuable custom-engineering project identified. It needs a machine with a graphics card, so it is stage D work.
- **Larger models as providers:** general on-device or cloud LLMs plug in as additional prediction providers for sentence-level work in v2. Operating-system models are optional providers only, because of their content filters. Nothing in v1 depends on one.

### Storage

A **profile folder** of plain files, in the spirit of an Obsidian vault:

```
profile/
  profile.json            name, device id, schema version
  settings.json           app and plugin settings
  layouts/*.json          user layouts
  phrases/*.json          phrase sets; recordings in phrases/audio/
  history/2026-11.jsonl   append-only utterance log
  lm/user-counts.json     personal language data
  plugins/<id>/           installed plugins and their private data
  state/composition.json  crash-recovery snapshot
```

- **Why files and not SQLite in v1:** at 10–20 words per minute a user produces a few kilobytes a day. Plain files avoid a native database dependency on four platforms, are readable and backed up by any tool, and can be synced by any file-sync service on day one.
- **Ready for sync later:** every history record carries a UUID, a device id and a hybrid logical clock; history is append-only; deletions are tombstones. A database can be added behind the same `Store` interface if queries ever need it.
- **Revisit when retrieval arrives:** recalling relevant past conversations for sentence prediction (v2) wants a vector index, which plain files do not give. That index can be a derived cache rebuilt from the files, so the files stay the source of truth.
- **Privacy:** nothing leaves the folder. Export and import are a zip of it.

## 8. Platform notes

| Platform | How it runs | What must be verified on real hardware |
|---|---|---|
| macOS | Electron, full screen | Pointer from head tracking and third-party trackers; webcam gaze accuracy |
| Windows | Electron, full screen | Running alongside Tobii/Grid software; HID gaze sidecar from an unpackaged app |
| iPad/iPhone | Capacitor, full screen | Whether the web view receives hover from system Eye Tracking and MFi trackers, or taps only; WebGPU on iOS 26.4+; sandboxed frames under Capacitor's custom scheme |
| Android | Capacitor, full screen | Webcam gaze performance on mid-range tablets; web view GPU support; offline voice availability |

Design consequences already built into the plan:

- **Tap-only mode** exists because iPad may deliver taps and nothing else. In that mode the system does the dwelling and our adaptive dwell is unavailable.
- **The coarse layout family** exists because iPad's built-in eye tracking and webcams are imprecise.
- **Driver plugins are desktop-only**, and the manifest's `platforms` field says so.

### After v1: Vision Pro as an input device

Vision Pro is not a v1 platform, but the direction is decided: Forsee stays an iPad app (and later any other platform's app), with a **companion mode** in which a paired Vision Pro acts as its input and display surface. Background and evidence are in [`reports/Vision Pro exploration.md`](../reports/Vision%20Pro%20exploration.md).

- **The companion runs Forsee.** Prediction, voices, models, the profile and the conversation log stay on the iPad. It speaks aloud, shows the text to the conversation partner, and uses its own camera and microphone for any context features.
- **The headset app is thin.** It draws the layout it is sent (layouts are data) and sends selections back as commands. Selection is done by the system's Dwell Control, so the headset app receives taps and never sees gaze.
- **The companion is the safety net.** The headset sends a heartbeat. If it stops (crash, flat battery, headset removed) or the user selects "help", the companion raises an alarm.
- **Design for accurate tracking.** Vision Pro's eye tracking needs no smoothing, calibration or enlarged targets from us. Layouts for it can be dense and can use the large canvas; likely words and letters are made larger or nearer instead of faster, because the system's dwell time is fixed.
- **Foveated streaming is ruled out** as a way to obtain gaze: Apple restricts that data to streaming.

What v1 should keep in mind so this stays cheap later: the link between the main app and a second surface (the partner display in C5) should be a documented local protocol that carries layouts, composition state, commands and a heartbeat, not an Electron-only window.

Things that need the project owner, not code: Apple Developer and Google Play accounts, a Windows code-signing certificate, and a written answer from Tobii Dynavox about SDK terms for an open-source AAC app.

## 9. From the current code to v1

The existing app is a Django server plus a React prototype. V1 inverts that: a local app with no server. The Django project is not deleted; it becomes the starting point for the optional v2 hosted service.

| Existing | Fate in v1 |
|---|---|
| `keyboard-ui/src/components/Button.jsx` (hover timer + CSS dwell fill) | Replaced by `GazeTarget`, which registers with the target registry. The visual style and the CSS-variable dwell animation carry over |
| `keyboard-ui/src/components/Keyboard.js` (hard-coded QWERTY rows) | Replaced by a layout JSON file and the keyboard view |
| `keyboard-ui/src/components/Backspace.js` (dwell to delete, longer to clear) | Becomes key behaviours in the layout schema: repeat and escalate |
| `keyboard-ui/src/components/Layout.jsx` (expand/minimise panels) | Becomes the region manager |
| `keyboard-ui/src/components/Settings.js` (one dwell slider) | Replaced by the generated, gaze-operable settings screen |
| `keyboard-ui/src/components/SpeechWarningModal.js` | Kept only in the browser host, where speech needs a first user gesture |
| `keyboard-ui/src/plugins/plugin-types.js`, `PluginManager.js` | Superseded by `packages/plugin-api` and `packages/plugin-host`. The settings schema shape is kept |
| `keyboard-ui/src/plugins/SuggestionsPlugin.js`, `HintsPlugin.js`, `hooks/useLLM.ts` | Not in v1. Later ported as a "cloud suggestions" plugin using a model-provider extension point |
| `keyboard-ui/src/hooks/useVoiceRecorder.js`, `conversations/voice_stream.py` | Not in v1. Later a context-provider plugin for partner transcription |
| `keyboard-ui/src/autocomplete/` (prefix match over SUBTLEX lists) | Replaced by the prediction engine. The SUBTLEX files are not carried over because of their licence |
| `conversations/models.py` (`Conversation`, `Message` with user/contact sender) | Same shape, stored as local JSONL |
| Pusher, Groq, Django REST endpoints | Not used by v1 |
| Tailwind theme tokens in `keyboard-ui/tailwind.config.js` | Carried into `packages/ui` as theme variables |
| Root `package.json` (placeholder) | Becomes the workspace root |
| `README.md` | Rewritten at release; the goals section already matches this plan |

## 10. Work packages

Each package is one pull request with its own tests. "Verifiable here" means it can be proven by unit tests or headless-browser tests without devices.

### Stage A: foundation (sequential)

| ID | Package | Contents | Done when |
|---|---|---|---|
| A1 | Workspace and CI | pnpm workspace at the repo root; shared TypeScript, lint and test config; empty packages that build; `apps/web` hello-world with React and Tailwind; GitHub Actions running lint, typecheck, test, build | CI is green on a clean clone |
| A2 | Contracts and kernel | `plugin-api` types (manifest, contributions, permissions, RPC); `core` (event bus, commands, composition buffer with undo, settings registry, extension registry, regions); `host` interface with a browser implementation; type-only interfaces for gaze, speech, prediction, storage and layouts | Unit tests cover the kernel; every later package can compile against the interfaces |

Everything in stage B depends only on A2.

### Stage B: engines and shells (parallel)

| ID | Package | Contents | Verifiable here |
|---|---|---|---|
| B1 | Gaze engine | Sample types, One Euro filter (written from the paper), fixation detection, target registry with expansion and hysteresis, dwell selector with classes, decay and likelihood scaling, direct and switch selectors, rest and pause logic | Yes: synthetic sample streams and a fake clock |
| B2 | Sources and calibration | Pointer source, tap-only source, WebSocket source, driver protocol document, mock driver, calibration fitting and quality score, drift-correction model | Yes |
| B3 | Webcam source | MediaPipe face-landmark estimator behind an interface, feature extraction, per-user regression, head-movement compensation | Maths only; accuracy needs a camera and a person |
| B4 | Prediction engine | Two-speed provider interface (instant answer, optional refined answer, per-key probabilities as input); tokeniser, n-gram model format and runtime, user-adaptive layer, completions, next word, letter probabilities, phrase recall, the model build tool, seed vocabulary | Yes |
| B5 | Speech | Provider interface, utterance queue, speak modes, web speech provider limited to local voices, recorded-message provider | Queue and modes yes; audio output no |
| B6 | Storage | `Store` interface, profile folder layout, settings, JSONL history with ids and clocks, crash-recovery snapshot, schema migrations, export/import; browser and Node file implementations | Yes |
| B7 | Layouts | JSON schema and validator, layout-to-rectangle model, key behaviours (repeat, escalate, page switch), built-in precise and coarse layouts, numbers and punctuation | Yes |
| B8 | UI shell | App frame and regions, `GazeTarget`, dwell feedback and click sound, composition bar, keyboard view, prediction strip, generated settings screen, themes ported from the prototype | Yes: headless browser with synthetic pointer |
| B9 | Plugin host, part 1 | Manifest validation, extension loading for declarative and first-party plugins, permission manager and consent records, restricted mode | Yes |
| B10 | Plugin host, part 2 | Sandboxed frame and worker runtime, RPC layer, panel target-registration protocol, plugin SDK helper | Yes in Chromium; iOS web view needs a device |
| B11 | Desktop shell | Electron app implementing `HostBridge`: profile folder on disk, full screen, keep-awake, sidecar launch, second window for the partner display, packaging config, CI build on macOS and Windows runners | Builds yes; signing and real use no |
| B12 | Mobile shell | Capacitor app implementing `HostBridge`: files, native voice plugins, keep-awake, camera permission; CI debug builds | Android build yes; iOS needs a macOS runner; devices no |
| B13 | Typing evaluation harness | Simulated typist over test text; keystroke savings, top-three accuracy, latency percentiles; gaze-noise and reading-time variants; runs against any prediction provider | Yes |
| B14 | Inference service | `packages/inference` interface, capability-tier detection, model registry and download manager; desktop implementation in an Electron utility process using llama.cpp bindings; a stub that reports tier 0 elsewhere | Interface and desktop yes, with a tiny test model; mobile no |

### Stage C: the product, as first-party plugins (parallel after B)

| ID | Package | Depends on |
|---|---|---|
| C1 | Keyboard plugin: layouts, gaze and composition wired together; in-place dwell adjustment; pause and rest | B1, B2, B7, B8, B9 |
| C2 | Prediction plugin: strip, learning, adaptive dwell wired to letter probabilities | B4, C1 |
| C3 | Phrases, message banking and the quick-fire bar; alarm target | B5, B6, C1 |
| C4 | History with re-speak; local usage statistics | B6, C1 |
| C5 | Partner display and composing indicator | B11, C1 |
| C6 | Calibration screen, quality score, layout recommendation, drift correction, recentre | B2, B3, C1 |
| C7 | Onboarding, profiles, caregiver mode | B6, B8 |
| C8 | Sample plugins for each tier, plugin developer guide, directory format and validator, in-app plugin browser and installer | B9, B10 |
| C9 | Reliability: crash recovery end to end, zero-network test, performance budget, end-to-end typing tests with synthetic gaze | C1–C4 |
| C10 | Swipe decoder and UI (stretch) | B1, B4, C1 |
| C11 | Neural prediction provider: constrained search over a keyboard model for completions, next words and letter probabilities; mixes with the n-gram; measured with the harness | B4, B13, B14, C2 |

### Stage D: needs people and hardware

| ID | Work |
|---|---|
| D1 | Device test matrix: real trackers on Windows, iPad Eye Tracking and one MFi tracker, a mid-range Android tablet |
| D2 | Webcam gaze tuning with real users; decide between our regression and WebEyeTrack |
| D3 | Windows HID gaze sidecar; written request to Tobii Dynavox on SDK terms |
| D4 | Licensed corpus, shipped English model, licence audit of every dependency and data file |
| D5 | Native voice plugins on device, including Personal Voice |
| D6 | Signing, notarisation, store submissions, auto-update |
| D7 | Sessions with 5–10 daily gaze users and speech therapists; revise defaults from what they show |
| D8 | README, website, contributor guide, plugin directory repository |
| D9 | Keyboard model: verify corpus licences, train a conversational model on a machine with a graphics card, measure it on an iPad, a mid-range Android tablet and an ordinary Windows laptop, and decide per device class whether tier 1 is on |
| D10 | Mobile inference plugin (llama.cpp and sherpa-onnx in one Capacitor plugin), tested on devices for memory and heat |
| D11 | Cloned voice pack: read the Pocket TTS weights licence, build the consent flow, have people judge the result |

### What a single overnight run can and cannot produce

- **Can:** stages A and B, and most of stage C, as code that builds and passes its own unit and headless-browser tests.
- **Cannot:** anything in stage D. No real eye tracker, iPad, Android device, signing identity or human tester is reachable from an automated run, so tracker behaviour, webcam accuracy, mobile web view behaviour and speech audio will be written but unverified.
- **Order of merging:** A1, then A2, then stage B in any order, then stage C. Pull requests in a later stage are opened against the earlier stage's branch until it merges.

## 11. Risks

| Risk | Mitigation |
|---|---|
| iPad web view receives taps only, so in-app dwell and adaptive dwell do not work with system Eye Tracking | Tap-only mode is a first-class mode; test on a device early (D1); consider a native pointer-capture plugin if needed |
| Apple rejects downloadable logic plugins | Tiered design allows shipping declarative-only community plugins on iOS |
| Sandboxed frames or workers behave differently in WKWebView under Capacitor's custom URL scheme | Early spike on a device; fall back to QuickJS-in-WASM for logic plugins on iOS |
| Tobii licence terms block the most common consumer tracker | Pointer route needs no SDK; drivers are separate, separately licensed processes; ask Tobii Dynavox in writing |
| Webcam gaze is too inaccurate or drifts within a session | Coarse layout family; visible quality score; drift correction; one-dwell recentre |
| GPL code or non-commercial data enters the MIT core (espeak-ng, WebGazer, SUBTLEX, OptiKey or Dasher code) | Licence check in CI on dependencies; data files shipped under their own licences; reimplement ideas, never copy code |
| No shippable language-model data with a clean licence | Build tool accepts any corpus; verify Tatoeba and public-domain sources in D4; user-adaptive layer works from an empty base |
| Electron speech synthesis exposes poor or network-only voices on some machines | Filter to local voices; native voice module as a follow-up; neural voice pack as P2 |
| Regulatory framing as a medical device | Describe the app as a communication tool; get advice before making clinical claims |
| Large parallel build produces inconsistent code | Contracts land first in A2; one reviewer pass over every pull request; shared lint and test gates in CI |
| Research figures are from search extracts, not full texts | Re-verify every number and licence clause before publishing it or relying on it legally |
| The keyboard-model numbers come from one project's own benchmarks, and nothing is measured on tablets | Build the evaluation harness first (B13); measure on devices (D9) before enabling tier 1 anywhere; tier 0 is always the fallback |
| Model weights carry licences that differ from their code and mostly could not be read | Ship no weights in the app; read each weights licence before listing a model for download; avoid non-commercial and revenue-capped models (MobileLLM, LFM2.5) |
| Sustained inference heats devices and drains batteries | Tier detection drops to tier 0 when hot or low on battery; models load on demand and unload when idle |
| A cloned voice is sensitive biometric data and can be misused | Explicit recorded consent; voice files stay in the profile on the device; cloning only from the user's own recordings |

## 12. Open decisions

| Decision | Recommendation |
|---|---|
| Where legacy code lives | Leave in place for now; move Django and `keyboard-ui/` into `legacy/` once v1 runs |
| Plain files vs SQLite | Plain files for v1, behind an interface; add a derived index when v2 retrieval needs one |
| Whether the neural keyboard model is in the first release | Build the interface, harness and desktop inference service now; turn the model on per device class only after measurement |
| Asynchronous messaging (texting a reply) as part of "speech" | Out of v1 core; possible as an output-sink plugin |
| Licence | Keep MIT for the app and the plugin API; data files and voice packs carry their own licences |
| Directory location | Start in `directory/` in this repo; split into its own repository at release |
| Who may publish plugins | Open submission with automated validation and pinned hashes; manual review for anything requesting camera, microphone, history or network |

## 13. Sources

Key references from the research. Each should be re-read in full before being cited publicly.

**Competitive and speed**
- OptiKey: https://github.com/OptiKey/OptiKey
- Dasher project: https://github.com/dasher-project
- Majaranta et al. 2009, adjustable dwell: https://homepages.tuni.fi/oleg.spakov/publications/Majaranta_CHI_09.pdf
- Mott et al. 2017, cascading dwell: https://faculty.washington.edu/wobbrock/pubs/chi-17.02.pdf
- Kurauchi et al. 2016, EyeSwipe: https://www.cs.bu.edu/fac/betke/papers/Kurauchi-etal-CHI-2016.pdf
- Kristensson and Vertanen 2012, dwell-free ceiling: https://www.keithv.com/pub/dwellfree/kristensson-dwell-free.pdf
- SpeakFaster Observer, field typing speed: https://research.google/pubs/speakfaster-observer-long-term-instrumentation-of-eye-gaze-typing-for-measuring-aac-communication/
- Cai et al. 2024, SpeakFaster: https://www.nature.com/articles/s41467-024-53873-3
- Feit et al. 2017, tracker accuracy and target size: https://www.microsoft.com/en-us/research/publication/toward-everyday-gaze-input-accuracy-precision-eye-tracking-implications-design/
- MND Association, "Condemned to silence": https://www.mndassociation.org/sites/default/files/2022-12/appg-report-condemned-to-silence-full.pdf

**Gaze input**
- Tobii Eye Tracker 5 and Eye Control: https://help.tobii.com/hc/en-us/articles/360014744577-Eye-Tracker-5-is-not-compatible-with-Eye-Control
- Tobii developer licence: https://developer.tobii.com/pc-gaming/sdla/
- Windows gaze API: https://learn.microsoft.com/en-us/uwp/api/windows.devices.input.preview.gazeinputsourcepreview
- Apple forum, no gaze data for apps: https://developer.apple.com/forums/thread/766870
- WebKit bug on AssistiveTouch pointer input: https://bugs.webkit.org/show_bug.cgi?id=236390
- MediaPipe: https://github.com/google-ai-edge/mediapipe
- WebEyeTrack: https://github.com/RedForestAI/WebEyeTrack
- WebGazer (GPLv3, unmaintained): https://github.com/brownhci/WebGazer
- OptiKey point-source contract: https://github.com/OptiKey/OptiKey/blob/master/src/JuliusSweetland.OptiKey.Contracts/IPointService.cs

**Shell and plugins**
- Obsidian plugin manifest: https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/Manifest.md
- Obsidian community directory: https://github.com/obsidianmd/obsidian-releases
- Apple App Store Review Guidelines (2.5.2, 4.7): https://developer.apple.com/app-store/review/guidelines/
- Capacitor 8.5: https://ionic.io/blog/capacitor-8-5-released
- Tauri mobile sidecar issue: https://github.com/tauri-apps/tauri/issues/9774
- Figma plugin model: https://developers.figma.com/docs/plugins/how-plugins-run

**Speech and prediction**
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx
- Kyutai Pocket TTS: https://github.com/kyutai-labs/pocket-tts
- Piper (GPL): https://github.com/OHF-Voice/piper1-gpl
- Apple Personal Voice for apps: https://wwdcnotes.com/documentation/wwdc23-10033-extend-speech-synthesis-with-personal-and-custom-voices/
- Vertanen, AAC language modelling: https://keithv.com/pub/imagine/ and https://keithv.com/pub/aacllm/
- SUBTLEX-US licence note: https://rdrr.io/github/JackEdTaylor/LexOPS/f/inst/extdata/data-licenses/SUBTLEX-US-LICENSE.md
- Message banking (Costello): https://www.als-mnd.org/wp-content/uploads/2016/12/costello-message-banking-handout.pdf
- MND Association voice banking comparison: https://www.mndassociation.org/sites/default/files/public/2025-10/Voice%20banking%20services%20comparison%20chart%20-%20Oct%202025.pdf

**On-device AI** (full list in the research report)
- Typeling keyboard model and benchmarks: https://github.com/scarletkc/typeling
- Character predictions from subword models (TextSlinger): https://github.com/kdv123/textpredict
- llama.cpp bindings for Electron: https://github.com/withcatai/node-llama-cpp
- WebKit memory limit for web views: https://bugs.webkit.org/show_bug.cgi?id=269777
- Google Play model delivery: https://developer.android.com/google/play/on-device-ai
