# The sweep: thousands of settings, no person needed

You record each physical setup once (camera, zoom, exposure, reflection helper); the sweep
replays those recordings through thousands of setting combinations and ranks them on validation
dots that no fit ever saw. The diagnosis then says, with numbers, why each setup's error is what
it is.

**Status: real recordings have never been through it.** It is tested on synthetic runs from the
simulator (`tests/sweep_synth.py`, `tests/test_sweep_*.py`), where the frames carry the truth
and no vision runs. Expect surprises with real recordings; every input problem should come back
as a plain message, not a traceback. If one does not, that is a bug: keep the recording.

## Running it

```sh
cd sidecars/phone-gaze/engine
.venv/bin/python -m phonegaze sweep RUN_ID          # a collection run (Collect page)
.venv/bin/python -m phonegaze sweep ~/.phonegaze/recordings/collect-runs/RUN_ID.json
.venv/bin/python -m phonegaze sweep ~/.phonegaze/recordings              # every recording there
.venv/bin/python -m phonegaze sweep ~/.phonegaze/recordings/20261117-0930 --minutes 20
.venv/bin/python -m phonegaze diagnose RUN_ID       # only the "why" part: the sweep's best setup (once swept) and the defaults
```

Or the **Sweep** page (`http://127.0.0.1:8765/sweep.html`; the Collect page links to it): choose the run, set the
time budget, **Start the sweep**. It runs in its own process: close or reload the page and it
picks the progress up again. **Stop** keeps everything done so far; starting the same sweep again
resumes it. When it finishes, the page shows the best setup, the per-setup table with the
diagnosis, the text summary (**Copy**) and **Apply best preset**.

Options: `--minutes` (time budget, default 45), `--max-combos` (setups fitted per condition,
default 100 per minute of `--minutes`, at least 400: 4,500 for 45 minutes; when it stops a sweep with more than a quarter of the time left, the summary says so and how to raise it), `--workers` (default every core), `--models auto,ridge,...` (only these model
setups), `--max-vision` (vision combinations per condition, default 16), `--every N` (every Nth
frame; default every other frame, every frame below 20 fps), `--vision real|oracle` (oracle reads
the simulator's truth), `--no-preset`, `--fresh` (forget earlier fits; caches are kept).

What it accepts:

- a **collection run** (the Collect page): one recording per condition with a `collect.json`
  manifest (calibration, poses, validation and pursuit phases), listed in
  `<recordings>/collect-runs/<run id>.json`. Only the run's completed recordings are swept, not
  abandoned attempts;
- **ordinary recordings** (Recordings page) with a calibration and a **Validate**: the phases
  come from the recorded calibration events (grid dots, head positions, validation dots, the
  moving dot). Without a validation, every third calibration dot is held out instead, and the
  report says so;
- **tools/eye-capture sessions**, as the lab reads them (no validation dots: the same hold-out).

What it does with bad input (each case has a test in `tests/test_sweep_core.py`); the rest of the
run is swept either way:

| Input                                                      | What you get                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| No face found in any frame                                 | "no setup could be scored ... only 0 calibration dot(s) had enough frames with the eyes found"; the diagnosis: eyes found in 0 % |
| A condition abandoned halfway (Esc, stop or skip)          | not swept; a note names it ("front ARKit: not finished (1 attempt(s), last: aborted (stop)); not swept")                         |
| An empty validation phase, or a recording with no Validate | every third calibration dot is held out instead, and the note says so; such a condition ranks after those with real validation   |
| A stream file cut short                                    | the dots after the last frame are dropped with a note ("the file looks cut short"); if most dots are gone, a plain refusal       |
| Dot times that do not match the frames, a bad manifest     | the recording is skipped with the reason; if nothing is left, the command says so and exits                                      |

The worker processes write MediaPipe's own start-up messages to `<recordings>/sweeps/cache/workers.log`
instead of the terminal.

## What it does

**Stage 1, observations.** For each condition and each combination of _vision_ settings
(estimator chain; face detector confidence and tiles; iris fit, edge share, eyelid mask and
minimum confidence; reflection threshold; distance source; head pose smoothing and source; crop
size for eye-capture sessions) the recording is decoded once and every frame inside a dot is run
through the estimators. The observations are cached under `<recordings>/sweeps/cache/`, keyed by
a hash of those settings and of the recording file, so nothing is decoded twice. The coarse list
is: the estimator chains, then one vision setting at a time; the single changes that helped are
then combined. Stage 1 may use at most 40 % of the time budget; the summary says when vision
combinations were left out.

**Stage 2, fitting.** For each cached observation set, combinations of _model and calibration_
settings: the gaze model (`auto` = what live calibration does, or one of geometric, ridge,
kernel, reflection, hybrid, blend, residual pinned), ridge regularisation, the geometric model's
eyeball centre, kappa prior and eye choice, per-dot sample handling (outlier rule, samples
discarded after the dot appears, weighting), with or without the head-position (poses) block,
with or without the moving dot merged, error-map correction (learned from the training dots'
leave-one-dot-out errors), and the smoothing filter. Feature sets follow from the estimator
chain and the model; there is no separate switch for them.

Every setup is **fitted on the calibration phase (and the poses phase when it says so) only** and
**scored on the validation phase**. Validation samples never reach a fit: they are marked
`validate`, which the fitting code drops, and the sweep asserts it before every fit (a test
spies on every fit to check).

**The search** does not try everything (a run has millions of combinations; the report says what
share was covered). It is steered only by calibration data, never by validation: the score that
picks where to look next is the leave-one-dot-out error on the training dots, or the error on
_other head positions_ when that is worse (cross-pose generalisation: fitted without the poses
block, it is tested on the poses dots; fitted with it, it is scored leave-one-head-position-out).
Order: every model with and without poses under every vision combination; then one setting at a
time around the best three; then all the single changes that helped together; then random
moves of one to three settings around the best, until `--max-combos`, `--minutes`, or three
rounds without a gain. All cores run fits in parallel.

**Resuming.** Each result is appended to `<recordings>/sweeps/<name>/results.jsonl` as it
arrives. Run the same command again (or press Start again) and it skips everything already
fitted; a line cut short by the interruption is fitted again. Results are redone when a
recording changes.

## Reading the leaderboard

`<recordings>/sweeps/<name>/`: `leaderboard.html` (also on the page), `leaderboard.md`,
`leaderboard.json`, `summary.txt` (plain text sized to paste into a chat), `diagnosis.json`,
`best_preset.json`, `state.json` (progress), `results.jsonl` (every fit).

- **Accuracy** is degrees of gaze between each validation dot and the mean of the predictions
  while it was shown, averaged over the dots. **Precision** is the RMS change between consecutive
  predictions within a dot (after the filter): jitter.
- **Confirmed.** With hundreds of setups, the best validation score is flattered: some setups
  are lucky on these particular dots. So the validation dots are split, alternately in time, into
  two halves (**Half A**, **Half B** columns). The best setup is picked on half A and scored on
  half B, and the other way round; **confirmed** is the mean of those two scores, on dots that
  played no part in the pick: what to expect from "sweep, then use the winner". Next to it, the
  same picks on the half they were picked on; the difference is the optimism. The leaderboard
  itself is ordered by all the validation dots, so the winner is chosen on the most data. If the
  confirmed number is much worse than the winner's accuracy, the ranking is mostly luck: record
  more validation dots (a longer protocol) before trusting it.
- **95 %** is a bootstrap interval over dots (resampling which dots were shown). With 8-12
  validation dots it is wide: a 0.3 degree difference is usually inside it.
- **(noise)** marks a setup whose difference from the best, dot by dot, has a 95 % interval that
  includes zero: you cannot tell them apart on this recording. **Within noise** in the summary
  means the same for two physical setups (their intervals overlap). Record both again before
  choosing; don't let 0.1 degrees decide.
- **Calib. score** is the calibration-only score the search used. "Picked by calibration data
  alone" is what the search would choose without any validation; if it is close to the winner,
  calibration data is enough to choose settings live.
- **Cross-pose** is the error on head positions the fit did not see.
- **Horizontal / vertical** split the error by axis, and the region table shows where on the
  screen it is worst.
- **Live defaults** is the same recording with the default settings (`auto`, default chain): the
  improvement the sweep found.
- **Repeats.** When a run records the same setup twice (same camera, zoom and settings), each
  recording's winner is also scored on the other recording. If it holds up there, believe it.

Best per camera and best overall pick the condition whose winner has the lowest accuracy on all
its validation dots.

## The preset

The overall winner is saved as the preset **best from sweep** (Experiments page, Presets;
`presets.json` next to the config): mode `replace`, with the condition's own settings, the
camera (`lens.camera_prefer`) and zoom (`lens.zoom`, auto zoom off), the vision settings
(`estimators.*`), the model (`models.candidates` and `models.pinned`), the calibration options
(including `calibration.pose_rounds` when the poses block won and `calibration.moving_dot` when
merging the moving dot won) and the filter. Its description says which camera and zoom it
applies to; `best_preset.json` repeats that with the scores. **Apply best preset** on the Sweep
page (or the Collect page) applies it. It is a setting change, not a calibration: calibrate
afterwards.

Mapping caveats: in a collection run the discarded samples (`calibration.discard_ms`) count from
the moment the dot appeared, live they count after `calibration.settle_ms`, so the live setting is
a little conservative. The error map is learned from training dots here; live it is learned from
validation dots. The simulator-only estimator chains (`sim_oracle*`) never go into a preset.

## The diagnosis

For each condition, from the recorded observations (the winner's vision settings) and the
winner's held-out result:

- **Availability**: share of frames with a face, each eye, an iris fit, the reflection, a
  distance; frames per second, gaps and the longest gap.
- **Precision floor**: how much each raw measurement scatters within a fixation (the median over
  dots of the standard deviation, after 0.3 s): iris centre, reflection, eye corners, iris minus
  corners, iris minus reflection, the estimator's gaze direction, head rotation and position. Pixels
  are converted to degrees of gaze with the measured geometry: the iris centre moves about
  `fx * 10.5 mm * pi/180 / distance` pixels per degree of eye rotation. The raw iris centre also
  moves with the head, so with a moving head its own "jitter" is large; iris minus corners is the
  signal that matters.
- **Signal strength**: for each measurement and axis, how much of its frame-to-frame variation is
  explained by which dot was shown (between-dot share of variance, head-still dots only), and the
  observed pixels per degree as a multiple of the geometry's prediction (1.0x is right; much less
  means the measurement is not following the eye).
- **Ceiling versus achieved**: ridge and geometric models fitted on every dot, validation
  included, and scored on the same dots. No calibration can do better than this with this signal.
  If the held-out error is close to it, the limit is the signal; if far above it, the limit is
  calibration or generalisation.
- **Bias versus jitter**: the constant offset of the validation dots and how much of the error it
  explains, the scale (does the pointer cover the full distance the eyes moved), horizontal
  against vertical, error by screen region, left eye only against right eye only, drift during
  validation (when it lasted half a minute or more), and how far the head really moved in each phase (the drift of its per-dot median position, per axis; the frame-to-frame noise of the estimated position is reported apart, and a noisy distance along the camera axis gets its own verdict naming `estimators.distance_smoothing_s`) and
  how far it sat from its calibration place during validation (the poses block moves it on
  purpose and is not counted).
- **Verdict**: each problem found gets a rough size in degrees; the largest is the verdict, with
  the most promising next step, and the next two are listed as "also". Thresholds are in
  `signal_report.THRESHOLDS` (eyes usable in under 80 % of frames; more than 1 degree of jitter;
  under 60 % of the signal explained by the dot; an offset over 0.8 degrees that explains most of
  the error; the head moving more than 30 mm; vertical 1.5 times horizontal...). They come from
  the simulator and from reading, not from real eyes.

## How long it takes

On the synthetic test run (5 conditions, each 9 calibration, 12 pose and 10 validation dots and
6 s of moving dot at 15 fps; the frames carry the truth, so stage 1 is near free): 310 setups in
5.6 minutes on 4 cores, with another job sharing the machine; the diagnosis alone takes 14
seconds. A fit costs 0.2-8 s of one core (`auto` and `blend` fit every model, with
leave-one-dot-out and leave-one-head-position-out scores, and are the slowest).

Real recordings, by estimate only: fits cost about the same per dot (30 fps, every other frame,
gives the same 15 frames per second), and scale with the number of dots. Stage 1 runs face
landmarks and the iris fit on every frame inside a dot: perhaps 20-40 ms per frame, so about a
minute per (condition, vision combination) for a 2-minute recording, 16 combinations per
condition, divided by the cores. With 6 conditions on a 4-core Mac: stage 1 15-25 minutes (capped
at 40 % of the budget), then about 1,000-2,000 fits in the default 45 minutes. A second run of the
same sweep reuses every cached observation set and every fit.
