import type { Clock, ErrorReporter, GazeControl } from '@forsee/core';
import type {
  ActivateEvent,
  CalibrationPoint,
  CalibrationResult,
  CommandInvocation,
  DwellClass,
  Disposable,
  GazeSample,
  GazeSource,
  KeyDistribution,
  LayoutFamily,
  Point,
  SelectionEvent,
  SelectionMethodId,
  SourceError,
  TargetDescriptor,
} from '@forsee/plugin-api';
import type { GazeEngineConfig, GazeEngineConfigPatch } from './config';

/**
 * Engine-internal contracts of the gaze package (B1 implements them; B2,
 * B3, B8 and C1 consume them). The pipeline, from plan section 5:
 *
 *   source → calibration correction → filter → fixation detection
 *          → hit test against registered targets → selection method → command
 *
 * Every stage is pure and driven by sample timestamps (`GazeSample.t`), never
 * by its own timers, so it can be tested with synthetic streams. The one
 * exception is `GazePipeline`, which takes a `Clock` to emit dwell progress
 * between samples (sources may deliver < 60 Hz).
 */

/** Re-exported shared contracts, so implementers can import everything from here. */
export type {
  ActivateEvent,
  CalibrationPoint,
  CalibrationResult,
  DwellClass,
  GazeSample,
  GazeSource,
  KeyDistribution,
  SelectionEvent,
  SelectionMethodId,
  TargetDescriptor,
} from '@forsee/plugin-api';

// ------------------------------------------------------------------ filter

/**
 * A smoothing filter (the One Euro filter for `gaze` sources; identity for
 * `pointer` sources). Invalid samples pass through unchanged and do not
 * update the filter state.
 */
export interface GazeFilter {
  /** Returns the filtered sample (same `t`, `confidence`, `valid`, `press`). */
  filter(sample: GazeSample): GazeSample;
  /** Forgets history (after a source restart or a long gap). */
  reset(): void;
}

/** One Euro filter parameters (Casiez et al., 2012). */
export interface OneEuroParams {
  /** Minimum cutoff frequency, Hz. Lower = smoother at rest. */
  readonly minCutoff: number;
  /** Speed coefficient. Higher = less lag during fast movement. */
  readonly beta: number;
  /** Cutoff for the derivative, Hz. */
  readonly dCutoff: number;
}

// ------------------------------------------------------------------ fixation

/** A detected fixation. */
export interface Fixation {
  /** Centroid, app viewport CSS pixels. */
  readonly x: number;
  readonly y: number;
  /** Monotonic ms of the first sample in the fixation. */
  readonly startT: number;
  /** Monotonic ms of the latest sample. */
  readonly t: number;
  /** `t - startT`. */
  readonly durationMs: number;
  /** Spread of the samples (max dispersion), CSS pixels. */
  readonly dispersionPx: number;
  /**
   * Per-axis standard deviation of the samples around the centroid,
   * `sqrt((varX + varY) / 2)`, CSS pixels. Drives the key distribution.
   */
  readonly spreadPx: number;
}

/** Output of the fixation detector for one sample. */
export interface FixationState {
  /** The current fixation, or null during a saccade, blink or before enough samples. */
  readonly fixation: Fixation | null;
  /** True on the first sample of a new fixation. */
  readonly started: boolean;
  /**
   * The fixation that ended with this sample (a saccade, or an invalid run
   * longer than the blink tolerance), if any. Both `ended` and `started`
   * are set only when a new fixation starts on the same sample, which needs
   * `minDurationMs` 0.
   */
  readonly ended?: Fixation;
}

/** Dispersion/duration-threshold fixation detector (I-DT or similar). */
export interface FixationDetector {
  update(sample: GazeSample): FixationState;
  reset(): void;
}

// ------------------------------------------------------------------ targets

/** Result of a hit test. */
export interface HitTestResult {
  /** The target under the point after expansion and hysteresis, or null (also null in rest zones). */
  readonly target: TargetDescriptor | null;
  /** True when the point is inside a `rest` target. */
  readonly inRestZone: boolean;
  /** Probability over nearby targets (see `KeyDistribution`); empty entries when `target` is null. */
  readonly distribution: KeyDistribution;
}

/**
 * Fields to change on a registered target. A field set to `undefined`
 * removes an optional field (for example `likelihood` back to "no opinion").
 */
export type TargetPatch = {
  readonly [K in Exclude<keyof TargetDescriptor, 'id'>]?: TargetDescriptor[K] | undefined;
};

/** Live handle on a registered target. */
export interface TargetHandle extends Disposable {
  readonly id: string;
  /**
   * Replaces fields of the descriptor (`id` cannot change). Cheap; call it
   * on every layout change. No-op after `dispose`. Throws
   * `ForseeError('invalid-argument')` for an invalid rect, class or role.
   */
  update(patch: TargetPatch): void;
}

/**
 * The target registry: UI elements register their rectangles here instead of
 * handling hover. It owns hit testing, target expansion (hit areas grow into
 * free space up to a limit) and hysteresis (the current target keeps winning
 * near its edge).
 */
export interface TargetRegistry {
  /**
   * Throws `ForseeError('duplicate')` if the id is registered and
   * `ForseeError('invalid-argument')` for an invalid descriptor.
   */
  register(target: TargetDescriptor): TargetHandle;
  /**
   * Registers several targets at once with a single change notification.
   * All or nothing: if any descriptor is invalid or duplicated, none is
   * registered and the error is thrown.
   */
  registerAll(targets: readonly TargetDescriptor[]): TargetHandle[];
  /**
   * Runs `fn` with change notifications deferred; listeners are called once
   * afterwards if anything changed (bulk updates and disposals).
   */
  batch<T>(fn: () => T): T;
  get(id: string): TargetDescriptor | undefined;
  list(): readonly TargetDescriptor[];
  /**
   * Hit test with hysteresis relative to `current` (the target currently
   * dwelt on, if any).
   */
  hitTest(point: Point, current: string | null): HitTestResult;
  /**
   * The key distribution for a selection of `firedId` made while gaze was
   * centred at `centre` with per-axis spread `spreadPx` (a 2D Gaussian,
   * floored at the registry's minimum sigma, over nearby character targets).
   * A fired target without `text` gets a single entry of probability 1.
   */
  keyDistribution(centre: Point, spreadPx: number, firedId: string): KeyDistribution;
  /** Called after any register/update/dispose (the UI may redraw debug overlays). */
  onDidChange(listener: () => void): Disposable;
}

// ------------------------------------------------------------------ selection

/** Dwell configuration (stored in the `app.gaze` settings namespace). */
export interface DwellConfig {
  /** Dwell time per class, ms. */
  readonly classMs: Readonly<Record<DwellClass, number>>;
  /**
   * How fast progress decays while gaze is off the target, as a fraction of
   * full progress per second (jitter tolerance: progress decays instead of
   * resetting).
   */
  readonly decayPerSecond: number;
  /** Adaptive dwell: likelihood-based scaling of dwell time. */
  readonly adaptive: {
    readonly enabled: boolean;
    /** Lower bound of the factor (likely targets fire at most this much sooner). */
    readonly minFactor: number;
    /** Upper bound (unlikely targets are never slowed by more than this; must stay reachable). */
    readonly maxFactor: number;
  };
  /** Interval between repeats on `repeat` targets, ms. */
  readonly repeatIntervalMs: number;
  /** Dwell needed on a `wake` target while paused, ms. */
  readonly wakeMs: number;
}

/** Input to a selection method for one step. */
export type SelectionInput =
  | {
      readonly type: 'sample';
      readonly sample: GazeSample;
      readonly fixation: FixationState;
      readonly hit: HitTestResult;
    }
  /** Time passing without a sample (frame tick), so progress keeps moving. */
  | { readonly type: 'tick'; readonly t: number }
  /** A switch, key or blink press (switch method). */
  | { readonly type: 'switch'; readonly t: number; readonly pressed: boolean };

/**
 * A selection method: turns the stream of inputs into `progress` and
 * `activate` events. First-party only in v1.
 */
export interface SelectionMethod extends Disposable {
  readonly id: SelectionMethodId;
  process(input: SelectionInput): void;
  onEvent(listener: (event: SelectionEvent) => void): Disposable;
  /**
   * While paused, only `wake` targets can fire: by dwell (`wakeMs`) for the
   * dwell method, by press or switch for the others.
   */
  setPaused(paused: boolean): void;
  /** Clears all progress (for example after a layout change). */
  reset(): void;
}

// ------------------------------------------------------------------ calibration and drift

/** Samples gathered while the user looked at one calibration point. */
export interface CalibrationSample {
  readonly point: CalibrationPoint;
  /** Raw (uncorrected, unfiltered) valid samples. */
  readonly samples: readonly GazeSample[];
}

/**
 * A fitted correction from raw gaze to screen coordinates (for example an
 * affine or second-order polynomial regression). B2 implements fitting and
 * quality scoring; B3 and driver sources reuse it.
 */
export interface CalibrationModel {
  /** Applies the correction. Identity before a successful fit. */
  apply(point: Point): Point;
  /** Fits from calibration data and reports the quality in user terms. */
  fit(data: readonly CalibrationSample[]): CalibrationResult;
  /** JSON form for the profile; `load` accepts what `serialise` produced. */
  serialise(): unknown;
  load(data: unknown): boolean;
}

/** Maps measured accuracy to a layout family recommendation. */
export type LayoutRecommender = (
  accuracyPx: number,
  viewport: { width: number; height: number },
) => LayoutFamily;

/**
 * Continuous drift correction (P1): each confirmed selection is evidence the
 * user looked at the target's centre; a slow-moving offset is learned.
 */
export interface DriftCorrector {
  /** Records that the user selected a target centred at `target` while gaze was at `observed`. */
  observe(target: Point, observed: Point, t: number): void;
  correct(point: Point): Point;
  /** Forgets the learned offset (the "recentre" control). */
  reset(): void;
}

// ------------------------------------------------------------------ pipeline

/** Options to build a pipeline (B1 provides `createGazePipeline(options): GazePipeline`). */
export interface GazePipelineOptions {
  readonly clock: Clock;
  readonly targets: TargetRegistry;
  readonly dwell: DwellConfig;
  /** Executes a target's command on activation, typically `kernel.commands.execute`. */
  readonly executeCommand: (command: string, args: unknown, source: string) => Promise<unknown>;
  /** Initial selection method. Default `dwell`. */
  readonly method?: SelectionMethodId;
  /** Engine configuration (filter, fixation, dwell tuning, tick rate); missing fields use defaults. */
  readonly engine?: GazeEngineConfigPatch;
  /**
   * When an activated target's command is `composition.insert` and its args
   * carry no `distribution`, add the activation's `KeyDistribution` (with
   * `withActivationDistribution`). Default true.
   */
  readonly attachDistribution?: boolean;
  /** Where failed commands and throwing listeners go. Default: core's `defaultErrorReporter`. */
  readonly reportError?: ErrorReporter;
}

/**
 * Who executes an activation, passed to `GazePipeline.onActivate` listeners
 * with the `ActivateEvent`. Exactly one party executes each activation:
 *
 * - `pipeline`: the target has a `command` (at activation time), and the
 *   pipeline has executed it once, with the distribution attached
 *   (`invocation` is what it sent; `failed` says whether it rejected). A
 *   wake target without a command is also `pipeline`: the pipeline resumed
 *   itself. Listeners must not execute anything for it.
 * - `owner`: the target has no command; the pipeline executed nothing. The
 *   listener that owns the target (the keyboard view's activation adapter
 *   for layout keys, the panel host for panel targets) executes it, at most
 *   once, attaching the distribution with `withActivationDistribution`.
 *   Every other listener ignores it. An owner recognises its targets by id
 *   (for example by the owner prefix of `targetId`).
 */
export type ActivationOutcome =
  | {
      readonly executedBy: 'pipeline';
      /** The invocation the pipeline executed, absent for a wake target without a command. */
      readonly invocation?: CommandInvocation;
      /** True when the command rejected or threw (the error went to `reportError`). */
      readonly failed: boolean;
    }
  | { readonly executedBy: 'owner' };

/** The target gaze is engaged with changed (hover highlight for every method). */
export interface EngageEvent {
  /** The engaged target, or null (nothing, or a rest zone). */
  readonly targetId: string | null;
  readonly inRestZone: boolean;
  readonly t: number;
}

/**
 * The assembled input pipeline. Implements the kernel's `GazeControl` so it
 * can be injected into `createKernel({ gaze })`. A `wake` target's command
 * should be `gaze.resume`, so pausing and waking always go through commands.
 */
export interface GazePipeline extends GazeControl, Disposable {
  readonly targets: TargetRegistry;
  /** Replaces the active source (stopping the previous one). `null` stops input. */
  setSource(source: GazeSource | null): void;
  setSelectionMethod(method: SelectionMethodId): void;
  setDwellConfig(config: DwellConfig): void;
  setCalibration(model: CalibrationModel | null): void;
  /** Selection events, for feedback rendering (progress) and logging. */
  onSelection(listener: (event: SelectionEvent) => void): Disposable;
  /** Corrected, filtered samples. Exposed to plugins only with `gaze.read`. */
  onSample(listener: (sample: GazeSample) => void): Disposable;
  /**
   * Every activation, with the full `ActivateEvent` (target, method,
   * `repeatIndex`, point, distribution, time) and who executes it (see
   * `ActivationOutcome`). For a target with a command, called after the
   * pipeline's command settled (`executedBy: 'pipeline'`); for a target
   * without one, called synchronously with `executedBy: 'owner'`, and the
   * owning listener executes. The pipeline never executes a target without a
   * command, so an activation is never executed twice as long as owners
   * check `executedBy`.
   */
  onActivate(listener: (event: ActivateEvent, outcome: ActivationOutcome) => void): Disposable;
  /** The engaged (hovered, highlighted) target changed. */
  onEngage(listener: (event: EngageEvent) => void): Disposable;
  /** The active source reported an error (a non-recoverable one has stopped it). */
  onSourceError(listener: (error: SourceError) => void): Disposable;
  /** The switch method's confirm input (a key, switch or blink detector): `pressed` true fires. */
  switchInput(pressed: boolean): void;
  /** The current selection method. */
  readonly selectionMethod: SelectionMethodId;
  /** The current dwell configuration (for `adjustDwell`). */
  readonly dwellConfig: DwellConfig;
  /** The current engine configuration. */
  readonly engineConfig: GazeEngineConfig;
  /** Updates the engine configuration; throws `ForseeError('invalid-argument')`. Resets the filter and fixation state. */
  setEngineConfig(patch: GazeEngineConfigPatch): void;
}
