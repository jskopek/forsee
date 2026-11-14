import type { Clock, GazeControl } from '@forsee/core';
import type {
  ActivateEvent,
  CalibrationPoint,
  CalibrationResult,
  DwellClass,
  Disposable,
  GazeSample,
  GazeSource,
  KeyDistribution,
  LayoutFamily,
  Point,
  SelectionEvent,
  SelectionMethodId,
  TargetDescriptor,
} from '@forsee/plugin-api';

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
}

/** Output of the fixation detector for one sample. */
export interface FixationState {
  /** The current fixation, or null during a saccade, blink or before enough samples. */
  readonly fixation: Fixation | null;
  /** True on the first sample of a new fixation. */
  readonly started: boolean;
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

/** Live handle on a registered target. */
export interface TargetHandle extends Disposable {
  readonly id: string;
  /** Replaces fields of the descriptor (`id` cannot change). Cheap; call it on every layout change. */
  update(patch: Partial<Omit<TargetDescriptor, 'id'>>): void;
}

/**
 * The target registry: UI elements register their rectangles here instead of
 * handling hover. It owns hit testing, target expansion (hit areas grow into
 * free space up to a limit) and hysteresis (the current target keeps winning
 * near its edge).
 */
export interface TargetRegistry {
  /** Throws `ForseeError('duplicate')` if the id is registered. */
  register(target: TargetDescriptor): TargetHandle;
  get(id: string): TargetDescriptor | undefined;
  list(): readonly TargetDescriptor[];
  /**
   * Hit test with hysteresis relative to `current` (the target currently
   * dwelt on, if any).
   */
  hitTest(point: Point, current: string | null): HitTestResult;
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
  /** While paused, only `wake` targets can fire (dwell method) or nothing (others). */
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
  /** Fired after a target's command ran (or failed). */
  onActivate(listener: (event: ActivateEvent) => void): Disposable;
}
