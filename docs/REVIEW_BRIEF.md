# Review brief: Forsee v1, stage A and the first half of stage B

Written 2026-11-14 for a reviewer (human or AI agent) who has not seen this project before. It explains what is being built, how it is designed, what each open pull request contains, what is already known to be missing, and where a second opinion would help most.

## 1. What Forsee is

Forsee is a free, open-source (MIT) eye-tracking keyboard for **spoken conversation**, for people who cannot speak or use their hands (ALS/MND and similar conditions). The user selects on-screen keys by looking at them, and the app speaks the text aloud.

Product stance:

1. **Speech only.** Writing documents and controlling the computer are out of core scope.
2. **The same full-screen app on every platform:** macOS, Windows, iPadOS/iOS, Android.
3. **Fully offline.** No account, no server, no network request in the default install.
4. **Everything beyond the speech core is a plugin,** and the core is itself built from first-party plugins on the public plugin API. The model is Obsidian: a strong core, plus deep third-party extensibility.
5. **No hardware lock-in.** It works with anything that moves a pointer, with a webcam, and with dedicated eye trackers.

The long-term goal is conversation-speed communication using AI and a lot of context (partner speech, who is present, history). That is **v2** and arrives as plugins. v1 is the best possible offline eye-tracking speech keyboard.

Source documents, all on branch `claude/dreamy-ride-sa47pg`:

| Document                                      | Contents                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `docs/V1_PLAN.md`                             | The plan: scope, architecture, input pipeline, plugin system, work packages, risks |
| `reports/On device AI for speech keyboard.md` | Research on on-device speech-to-text, voices and prediction                        |
| `reports/Vision Pro exploration.md`           | Why Vision Pro is a later "companion mode", not a v1 platform                      |
| `docs/ARCHITECTURE.md` (from PR #7 onward)    | Package graph, conventions, contract table, recorded decisions                     |
| `docs/DEVELOPMENT.md` (from PR #6 onward)     | Workspace conventions and how to run checks                                        |

## 2. Where the project stands

**There is no working keyboard yet.** What exists is a workspace, a kernel and six engine packages, each with its own unit tests. The web app still renders only a placeholder heading. Nothing visible, no input source, no app shell, and no wiring between the engines exists yet.

This matters for the review: the engines were built **in parallel, by separate workers, against shared contracts**, and have never been run together or used by a person. Integration is the largest unknown.

How it was built: an orchestrating agent wrote the plan and each package brief, separate AI workers implemented each package in an isolated worktree, and the orchestrator re-ran the checks and opened one pull request per package. No human has reviewed the code yet.

## 3. Architecture in brief

```
Shells: apps/web (dev and demo) · apps/desktop (Electron) · apps/mobile (Capacitor)
   each implements HostBridge: files, voices, windows, sidecars, model inference
UI (packages/ui): regions, gaze targets, keyboard view, settings
Plugin host (packages/plugin-host): loader, permissions, sandbox, RPC
First-party plugins (plugins/*): keyboard, prediction, phrases, history, ...
Engines, pure TypeScript with no DOM or Node:
   core · gaze · prediction · speech · storage · layouts · inference
Public contract: packages/plugin-api (types and a few constants; the leaf of the graph)
```

Rules the code is meant to follow:

- **Engine packages never touch the DOM, Node or Electron.** They compile against bare ES2022, and ESLint rejects `react`, `electron`, `node:*`, `window` and `document` in them. Platform services (`Clock`, `IdSource`, `ProfileFileSystem`) are defined in `core` and injected.
- **Everything platform-specific goes through `HostBridge`** (`packages/host`). Plugins never see it.
- **One coordinate space:** CSS pixels in the app viewport, origin top-left.
- **Two time bases:** monotonic milliseconds (fields named `t`) for anything within a session; wall-clock milliseconds (fields named `*At`) for anything persisted or sent to a sandbox.
- **Every action is a command** with an id (`composition.insert`, `speech.speak`). Keys, plugins and tests invoke commands; nothing calls UI handlers directly.
- **The plugin API is asynchronous and structured-clone safe throughout,** so the same interface serves first-party plugins in the main context and sandboxed plugins over `postMessage`.
- **Models run in native code behind the host bridge,** never in the web view or a plugin sandbox. Nothing in the default install depends on a model.
- **Storage is plain files** (JSON and append-only JSONL), not a database.

The input pipeline, which is the heart of the product:

```
Source → calibration correction → filter → fixation detection
       → hit test against registered targets → selection method → command
```

UI elements do not handle hover themselves. Each selectable element registers a **target**; the gaze engine does hit testing and dwell. This is what allows adaptive dwell, consistent feedback, and safe third-party panels.

Plugins come in three trust tiers: **declarative** (JSON only), **logic** (isolated code talking over RPC) and **custom UI** (an isolated frame whose selectable rectangles are registered with the host, which does the dwelling).

## 4. The pull requests

All are open and unmerged. They form a stack: #5 is the base, #6 sits on #5, #7 on #6, and **#8 to #13 each sit directly on #7 and are independent of one another**.

| PR  | Branch                      | Head          | Package                 | Base   |
| --- | --------------------------- | ------------- | ----------------------- | ------ |
| #5  | `claude/dreamy-ride-sa47pg` | moving (docs) | Plan and research       | `main` |
| #6  | `claude/v1-a1-workspace`    | `03c4896`     | A1 workspace and CI     | #5     |
| #7  | `claude/v1-a2-contracts`    | `8858a27`     | A2 contracts and kernel | #6     |
| #8  | `claude/v1-b7-layouts`      | `1be4882`     | B7 layouts              | #7     |
| #9  | `claude/v1-b6-storage`      | `f90a09f`     | B6 storage              | #7     |
| #10 | `claude/v1-b5-speech`       | `a082819`     | B5 speech               | #7     |
| #11 | `claude/v1-b1-gaze`         | `10906d7`     | B1 gaze engine          | #7     |
| #12 | `claude/v1-b9-plugin-host`  | `42e9634`     | B9 plugin host, part 1  | #7     |
| #13 | `claude/v1-b4-prediction`   | `0c3932a`     | B4 prediction           | #7     |

Each PR description on GitHub lists its own verification results and known gaps. Summaries follow.

### #5: Plan and research

Documents only. Read `docs/V1_PLAN.md` first; sections 4 to 7 are the specification the code is meant to implement, and section 10 lists the work packages.

### #6: A1, workspace and CI

pnpm workspace, strict TypeScript with project references, ESLint, Prettier, Vitest, a Playwright smoke test and a GitHub Actions workflow. Twelve skeleton packages under `@forsee/*` and a placeholder `apps/web`. Packages are consumed from source (`exports` points at `src/index.ts`), so there is no build step in dev or tests. The legacy Django app and `keyboard-ui/` prototype are untouched and outside the workspace.

### #7: A2, contracts and kernel

The foundation everything else compiles against.

- `packages/plugin-api`: the manifest, permission scopes, a contribution type for each of 13 extension points, the shared data contracts (gaze, prediction, speech, layouts, storage, context, inference), `ForseeApi` (the object a plugin receives) and the RPC envelope types.
- `packages/core`: event bus, injected clock and id sources, hybrid logical clock, command registry, composition buffer (the text being written), conversation log, settings registry, extension registry, region model, context store, and `createKernel`.
- `packages/host`: the `HostBridge` interface with memory and web implementations.
- A `contracts.ts` in each stage B package declaring what it must implement.

Two fixes were made after an earlier review: command handlers' own error codes are now preserved, and plugin commands are private by default, with `CommandRegistry.authorize` checking cross-plugin calls.

### #8: B7, layouts

Keyboards as data. A validator, a published JSON Schema, geometry that tiles a rectangle exactly, generation of gaze targets, a runtime for pages, two-step group keys and key behaviours (single, repeat, escalate), and four built-in layouts: QWERTY, alphabetical, German QWERTZ, and a 12-cell coarse layout for imprecise trackers.

### #9: B6, storage

The profile folder: `profile.json`, `settings.json`, monthly append-only history files with tombstones for deletion, the crash-recovery snapshot, plugin private data, schema migrations, and zip export and import. Also a persistent browser file system (Origin Private File System, then IndexedDB, then memory) added to `packages/host`. Adds one dependency, `fflate` (MIT).

### #10: B5, speech

An utterance queue with immediate stop and a watchdog, voice selection restricted to offline voices by default, the three speak modes (on demand, each sentence, each word), a browser speech-synthesis provider that handles its known quirks, and a recorded-message provider for message banking. Browser APIs are injected. Adds an optional `interrupt` flag to the public `SpeakOptions`.

### #11: B1, gaze engine

One Euro filter, dispersion-threshold fixation detection, a target registry with expanded hit areas and hysteresis, dwell selection with per-class times, decay and likelihood-scaled (adaptive) timing, direct and switch selection, rest zones, pause and wake, in-place dwell adjustment, a per-selection probability distribution over nearby keys, and the pipeline that ties these together.

### #12: B9, plugin host, part 1

Manifest validation with a published JSON Schema, the permission manager with persisted consent records, `createPluginApi` (the permission-checked implementation of `ForseeApi`, bound to one plugin), the plugin lifecycle, restricted mode (on by default), and loaders for declarative and first-party plugins. The sandbox for community code (B10) is not built; it will implement the `PluginRuntime` interface defined here.

### #13: B4, prediction

A tokeniser, a trigram language model with interpolated Kneser–Ney smoothing and an order-5 character model, a compact binary model format, a user-adaptive layer with recency decay, phrase recall, noisy-prefix decoding from key probabilities, the synchronous `forsee.ngram` provider, and the engine that merges instant and refined answers. Also `tools/lm-build`, a command-line model builder, and seed data written for this project.

## 5. How to check out and run

```bash
git fetch origin
git checkout claude/v1-a2-contracts        # or any PR branch from the table
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
pnpm e2e                                    # browser smoke test; needs Chromium
```

Requirements: Node 22 or later, pnpm 10. To see the stage B packages together, merge the six branches onto `claude/v1-a2-contracts` locally. Expect small conflicts in `pnpm-lock.yaml` and the root `tsconfig.json`, and check that the additive change to `packages/plugin-api/src/speech.ts` from #10 survives. **Nobody has done this merge yet, so whether the six packages typecheck together is itself an open question.**

## 6. What has and has not been verified

Verified, for every PR: lint, format check, strict typecheck, unit tests and build pass on the head commit, both locally and in GitHub Actions.

Not verified, anywhere:

- The engines working together.
- Any real input: no eye tracker, webcam or person has driven the gaze engine. Its tests use synthetic gaze.
- Any real output: no audio has been produced. The speech provider is tested against a scripted stand-in for the browser API.
- Real browser storage. The file systems are tested against fakes.
- Prediction quality. The seed corpus is 963 sentences written for the project; the reported 67.8% keystroke saving is on held-out sentences in the same style and is optimistic.
- Any default value (dwell times, filter parameters, hit-test margins, watchdog budgets). They come from the literature, not from tuning.
- A community code plugin running. Without the sandbox they are listed as blocked.

## 7. Known issues, so they need not be re-reported

Already identified and deliberately deferred:

1. **The second-screen link is too narrow.** `PartnerDisplayMessage` in `packages/host/src/bridge.ts` carries only text and a "composing" flag. A later decision (Vision Pro as an input surface for an iPad) needs a general local protocol carrying layouts, commands and a heartbeat.
2. **One screen is assumed.** Coordinates are defined for a single document; a second surface will need a surface identifier on targets and samples.
3. **Plugins cannot record the partner's side of a conversation.** `HistoryApi` is read-only.
4. **`HostBridge` has no lifecycle events** (suspend, resume, low battery).
5. **Word detection assumes spaces** (`PARTIAL_WORD` in `packages/core/src/composition.ts`).
6. **Speaking with no voice available still clears the text.** It is logged and undo restores it, but the UI is not told.
7. **A plugin's voice, rate, pitch, volume and recording options are dropped** when it calls `speech.speak` through the plugin API, because the kernel command accepts only text and a log flag.
8. **No rate limits or storage quotas for plugins,** and no timeouts on calls into plugin providers.
9. **Network use by plugin output sinks is not enforced** in the plugin host; it depends on the sandbox's content security policy.
10. **Bundle hashes are recorded but not verified** at install.
11. **A repeating key's interval is not carried on `TargetDescriptor`.**
12. **Layouts type lowercase only;** nothing capitalises the start of a sentence automatically.
13. **Two browser tabs writing one profile are not coordinated.**
14. **CI runs twice** on a branch with an open pull request (`push` and `pull_request` triggers).

## 8. Where a review would help most

In rough order of value:

1. **Do the contracts fit together?** Each stage B package refined its own `contracts.ts` independently. Look for mismatches between what one package produces and another consumes. Specific seams:
   - `gaze` produces `ActivateEvent` and `KeyDistribution`; `layouts` resolves an activation to a command; `core` receives `composition.insert` with a distribution; `prediction` reads `partialWordSteps`. Does a key probability survive that whole path?
   - `layouts` generates targets **without** a command and expects the keyboard view to ask its runtime what a key does; `gaze` executes a target's command if it has one and attaches the distribution. Are these two designs consistent, and who attaches the distribution when the layout runtime runs the action?
   - `storage` implements the persistence interfaces in `packages/core/src/services.ts`; `plugin-host` defines its own `ConsentStorage` and install storage. Do they line up with the profile layout?
   - `speech` implements the kernel's `SpeechService`; `plugin-host` exposes speech to plugins through the kernel command.
   - `prediction` has an `access` hook for per-provider permissions; `plugin-host` filters prediction requests itself. Is filtering done once, twice or inconsistently?
2. **Is the public plugin API right?** `packages/plugin-api` is the surface third parties will depend on and the hardest thing to change later. Is anything missing that the v2 goals (context providers, sentence-level prediction, model providers) will need? Is anything exposed that should not be?
3. **Security of the plugin host.** Look for ways a plugin could exceed its permissions: confused-deputy paths, argument validation gaps, information leaking through events or error messages, anything reachable through `invokeApiMethod`.
4. **Correctness of the tricky logic:**
   - the composition buffer's auto-space, punctuation and undo rules;
   - dwell accumulation, decay and the "slow source" handling in the gaze engine;
   - history ordering by hybrid logical clock, tombstones and torn-line recovery;
   - Kneser–Ney backoff weights after pruning, and letter probabilities summing to at most 1;
   - the speech queue's stop and watchdog behaviour.
5. **Design choices worth challenging.** The 26 decisions recorded in `docs/ARCHITECTURE.md`, and the plan's choices of Electron plus Capacitor, plain files over SQLite, and an n-gram first predictor.
6. **Test quality.** Tests were written by the same worker as the code. Look for tests that assert the implementation's behaviour without checking it is the right behaviour, and for important paths with no test.
7. **Over-engineering.** Anything built that v1 does not need.

## 9. Constraints a suggestion should respect

- **Licences.** The project is MIT. No GPL, LGPL or non-commercial code or data may enter the core. In particular: no code from OptiKey, Dasher, WebGazer, KenLM or Presage; no espeak-ng; no SUBTLEX, wordfreq or DailyDialog data. The legacy prototype's SUBTLEX word lists must not be reused.
- **Offline.** The default install makes no network request.
- **Engine purity.** No DOM or Node in engine packages.
- **`plugin-api` changes should be additive.**
- **The legacy code stays in place:** `app/`, `conversations/`, `templates/`, `keyboard-ui/`, `manage.py`, `pyproject.toml`.

## 10. What would make a finding most useful

- The file and line, on which branch.
- A concrete scenario: the inputs or state that produce the wrong result.
- Whether it is a defect, a contract mismatch between packages, a security issue, or a design suggestion.
- For a design suggestion, what it would cost to change now compared with after the UI and plugins are built on top.
