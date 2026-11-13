import type { CancellationToken, JsonObject, Point, Rect } from './common';

/**
 * One sample from a gaze or pointer source.
 *
 * - `x`, `y`: app viewport CSS pixels (see `common.ts`). May lie outside the
 *   viewport when the user looks off-screen.
 * - `t`: host monotonic milliseconds when the sample was *observed* (not when
 *   it was delivered). Non-decreasing within one source session.
 * - `confidence`: 0..1, the source's own estimate. Pointer sources report 1.
 * - `valid`: false when the source has no usable position (blink, face lost,
 *   tracker dropout). `x`/`y` then repeat the last valid position or are 0 and
 *   must be ignored.
 * - `press`: true when this sample is a discrete press at `(x, y)`: a click,
 *   tap or switch-down. The direct selection method fires on it. Tap-only
 *   sources (no hover) emit only press samples.
 */
export interface GazeSample {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly confidence: number;
  readonly valid: boolean;
  readonly press?: boolean;
}

/** Why a source failed or stopped. */
export interface SourceError {
  readonly code:
    'unavailable' | 'permission-denied' | 'disconnected' | 'calibration-required' | 'internal';
  readonly message: string;
  /** True when restarting the source may succeed (for example a driver reconnecting). */
  readonly recoverable: boolean;
}

/** What a source can do. */
export interface GazeSourceCapabilities {
  /** The source supports `calibrate()`. */
  readonly calibrate: boolean;
  /** The source delivers continuous position (false for tap-only input). */
  readonly hover: boolean;
}

/** A point shown to the user during calibration. */
export interface CalibrationPoint {
  readonly id: string;
  /** Target centre, app viewport CSS pixels. */
  readonly target: Point;
}

/**
 * Drives the on-screen part of a calibration run for a source that calibrates
 * itself (`GazeSource.calibrate`). The calibration screen implements it.
 */
export interface CalibrationSession {
  /** Points the session will present, in order. */
  readonly points: readonly CalibrationPoint[];
  /**
   * Shows `point` and resolves once the user has looked at it long enough for
   * the source to collect data (the screen owns the timing). Rejects if the
   * session is cancelled.
   */
  present(point: CalibrationPoint): Promise<void>;
  readonly cancellation: CancellationToken;
}

/** Layout families (see `layout.ts`); calibration recommends one. */
export type LayoutFamily = 'precise' | 'coarse';

/** Outcome of a calibration, in terms the user can act on. */
export interface CalibrationResult {
  /** False if calibration failed or was cancelled; the other fields are then best effort. */
  readonly ok: boolean;
  /** Mean distance between targets and corrected gaze, CSS pixels. */
  readonly accuracyPx: number;
  /** Root-mean-square sample spread around the mean, CSS pixels. */
  readonly precisionPx: number;
  /** Which layout family the measured accuracy supports. */
  readonly recommendedFamily: LayoutFamily;
  /** Plain-language summary, for example "Good enough for the large layout". */
  readonly summary: string;
}

/**
 * A source of samples (plan section 5). Implementations: pointer, tap-only,
 * WebSocket driver, webcam (packages `gaze-web`, plugins).
 *
 * Lifecycle: `start` may be called again only after `stop`. After `stop`
 * returns, no further callbacks are made. `onError` with a non-recoverable
 * error implies the source has stopped itself.
 */
export interface GazeSource {
  /** Stable id, for example `"pointer"` or `"<pluginId>/tobii-driver"`. */
  readonly id: string;
  /** `pointer`: already smoothed by someone else (system pointer, tracker mouse emulation). `gaze`: raw gaze. */
  readonly kind: 'pointer' | 'gaze';
  readonly capabilities: GazeSourceCapabilities;
  start(onSample: (sample: GazeSample) => void, onError: (error: SourceError) => void): void;
  stop(): void;
  /** Present only when `capabilities.calibrate` is true. */
  calibrate?(session: CalibrationSession): Promise<CalibrationResult>;
}

/**
 * Dwell time class of a target; each has its own user-adjustable dwell time.
 * `destructive` is for clear / delete word and should be the slowest.
 */
export type DwellClass = 'letter' | 'prediction' | 'function' | 'destructive';

/** All dwell classes. */
export const DWELL_CLASSES: readonly DwellClass[] = [
  'letter',
  'prediction',
  'function',
  'destructive',
];

/**
 * Role of a registered target:
 * - `select`: an ordinary selectable target.
 * - `rest`: a rest zone; gaze here never fires anything and resets dwell.
 * - `wake`: fires only while selection is paused and needs the long wake dwell.
 */
export type TargetRole = 'select' | 'rest' | 'wake';

/** A command id plus its arguments. Arguments must be JSON. */
export interface CommandInvocation {
  readonly command: string;
  readonly args?: JsonObject;
}

/**
 * A selectable element, as registered with the gaze target registry. UI
 * elements never handle hover themselves; they describe themselves here.
 */
export interface TargetDescriptor {
  /** Unique among registered targets. Convention: `<owner>/<local id>`, for example `keyboard/key-a`. */
  readonly id: string;
  /** Visible bounds, app viewport CSS pixels. The engine may expand the hit area beyond it. */
  readonly rect: Rect;
  readonly dwellClass: DwellClass;
  /** Defaults to `select`. */
  readonly role?: TargetRole;
  /**
   * Prior probability (0..1) that this target is the user's next choice,
   * usually from the predictor. Drives adaptive dwell. Absent means no
   * opinion (factor 1).
   */
  readonly likelihood?: number;
  /** Command executed on activation. Absent for targets that only emit `activate` events (plugin panels). */
  readonly command?: CommandInvocation;
  /**
   * Text this target types, if it is a character key (for example `"a"`).
   * Used to build the `KeyDistribution` the predictor receives.
   */
  readonly text?: string;
  /** Short label for spoken or visual feedback. */
  readonly label?: string;
  /**
   * After activation: `look-away` (default) requires gaze to leave before it
   * can fire again; `repeat` fires again after the repeat interval while gaze
   * stays (used by delete and escalating keys; see `ActivateEvent.repeatIndex`).
   */
  readonly afterActivate?: 'look-away' | 'repeat';
  /** Disabled targets are hit-tested (they block neighbours) but never fire. */
  readonly disabled?: boolean;
}

/** Probability that the user intended one particular target. */
export interface KeyProbability {
  readonly targetId: string;
  /** The target's `text`, when it has one. */
  readonly text?: string;
  /** 0..1. */
  readonly probability: number;
}

/**
 * Uncertainty attached to a selection ("report uncertainty to the predictor").
 * Entries are sorted by descending probability, probabilities sum to 1
 * (within 1e-6), and the fired target is always present. A selection made
 * without uncertainty (a click) has a single entry with probability 1.
 */
export interface KeyDistribution {
  readonly entries: readonly KeyProbability[];
}

/** Selection methods (first-party only in v1). */
export type SelectionMethodId = 'dwell' | 'direct' | 'switch' | 'swipe';

/**
 * Dwell progress on a target, emitted at most once per frame while it
 * changes. `progress` is 0..1; a `progress` of 0 means dwell on that target
 * has reset or fully decayed (UI hides the indicator).
 */
export interface ProgressEvent {
  readonly type: 'progress';
  readonly targetId: string;
  readonly progress: number;
  /** Effective dwell time for this target after class and likelihood scaling, ms. */
  readonly dwellMs: number;
  readonly t: number;
}

/** A target fired. The command, if any, is executed by the pipeline after this event. */
export interface ActivateEvent {
  readonly type: 'activate';
  readonly targetId: string;
  readonly method: SelectionMethodId;
  /**
   * 0 for the first activation; 1, 2, ... for repeated activations while gaze
   * stays on a `repeat` target. Escalating keys use it (delete letter, then
   * word, then clear).
   */
  readonly repeatIndex: number;
  /** Where the user was looking (corrected and filtered), app viewport CSS pixels. */
  readonly point: Point;
  readonly distribution: KeyDistribution;
  readonly t: number;
}

/** Events from the selection stage of the input pipeline. */
export type SelectionEvent = ProgressEvent | ActivateEvent;
