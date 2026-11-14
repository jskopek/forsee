import { ForseeError } from '@forsee/core';
import {
  DWELL_CLASSES,
  type DwellClass,
  type SelectionMethodId,
  type SettingField,
  type SettingValue,
  type ValidationIssue,
  type ValidationResult,
} from '@forsee/plugin-api';
import type { DwellConfig, OneEuroParams } from './contracts';

/**
 * Plain, JSON-serialisable configuration of the gaze engine, with defaults,
 * validation and the in-place dwell adjustment ("faster" / "slower" keys).
 *
 * Every default below says why it was chosen. They are starting points for a
 * new user on a typical laptop (about 96 CSS px per inch, 60 cm viewing
 * distance, so 1° of visual angle is roughly 40 CSS px); every one is a
 * setting.
 */

// ------------------------------------------------------------------ types

/** Which smoothing filter `gaze` sources get. `pointer` sources are never filtered. */
export type FilterKind = 'one-euro' | 'low-pass' | 'none';

/** Smoothing filter configuration. */
export interface FilterConfig {
  readonly kind: FilterKind;
  readonly oneEuro: OneEuroParams;
  /** Cutoff of the simple low-pass alternative, Hz. */
  readonly lowPassCutoffHz: number;
  /** An invalid run (or a gap between samples) longer than this resets the filter, ms. */
  readonly resetAfterGapMs: number;
}

/** Fixation detector (I-DT) configuration. */
export interface FixationConfig {
  /** Maximum dispersion `(maxX - minX) + (maxY - minY)` of a fixation, CSS px. */
  readonly dispersionPx: number;
  /** Minimum duration before a group of samples counts as a fixation, ms. */
  readonly minDurationMs: number;
  /** Invalid samples (blinks) shorter than this do not end a fixation, ms. */
  readonly maxGapMs: number;
}

/** Fine tuning of the dwell method that is not a user-facing dwell setting. */
export interface SelectionTuning {
  /**
   * Between samples, frame ticks keep crediting dwell to the engaged target
   * for at most this long after the last valid sample, ms (sources slower
   * than 60 Hz still get a smooth progress fill; a stalled source does not
   * keep dwelling).
   */
  readonly extrapolateMs: number;
  /**
   * After the last valid sample, progress is held (neither grows nor decays)
   * this long before it starts decaying, ms. Covers blinks. Valid samples at
   * most this far apart also count as continuous gaze (slow sources).
   */
  readonly holdMs: number;
  /** Likelihood at which adaptive dwell is neutral (factor 1). */
  readonly neutralLikelihood: number;
  /** Exponent of the adaptive dwell curve: factor = (likelihood / neutral) ^ -exponent, then clamped. */
  readonly likelihoodExponent: number;
}

/** Hit testing and key distribution configuration (owned by the target registry). */
export interface HitTestConfig {
  /** How far a target's hit area may grow into free space beyond its visible rect, CSS px. */
  readonly expansionPx: number;
  /** The currently engaged target keeps winning this far outside its visible rect, CSS px. */
  readonly hysteresisPx: number;
  /** Smallest standard deviation used for the key distribution, CSS px. */
  readonly sigmaFloorPx: number;
  /** Entries below this probability are dropped from a key distribution (the fired key is always kept). */
  readonly minProbability: number;
  /** At most this many entries in a key distribution. */
  readonly maxEntries: number;
}

/** Engine configuration the pipeline owns (the registry owns `HitTestConfig`, the user owns `DwellConfig`). */
export interface GazeEngineConfig {
  readonly filter: FilterConfig;
  readonly fixation: FixationConfig;
  readonly selection: SelectionTuning;
  /** Interval of the frame tick that advances dwell progress between samples, ms. 0 disables ticks. */
  readonly tickIntervalMs: number;
}

/** A partial `GazeEngineConfig`; missing fields keep their current (or default) value. */
export interface GazeEngineConfigPatch {
  readonly filter?: Partial<Omit<FilterConfig, 'oneEuro'>> & {
    readonly oneEuro?: Partial<OneEuroParams>;
  };
  readonly fixation?: Partial<FixationConfig>;
  readonly selection?: Partial<SelectionTuning>;
  readonly tickIntervalMs?: number;
}

// ------------------------------------------------------------------ defaults

/**
 * One Euro defaults for gaze in CSS pixels.
 * - `minCutoff` 1 Hz: removes most fixation jitter (eye trackers and webcams
 *   jitter at 5-30 Hz) while a slow drift is still followed within a second.
 * - `beta` 0.007 per px/s: a saccade (thousands of px/s) raises the cutoff to
 *   tens of Hz, so the filtered point jumps with the eye instead of lagging
 *   by 100+ ms; filtered fixation jitter (a few hundred px/s) only raises it
 *   by 1-3 Hz.
 * - `dCutoff` 1 Hz: the value the paper recommends for the derivative.
 */
export const DEFAULT_ONE_EURO_PARAMS: OneEuroParams = Object.freeze({
  minCutoff: 1,
  beta: 0.007,
  dCutoff: 1,
});

/**
 * Filter defaults. One Euro for raw gaze (the plan's choice); the low-pass
 * alternative at 4 Hz is there for comparison and for sources that already
 * have a little smoothing. A gap of 500 ms (more than a blink) resets the
 * filter so the next fixation does not glide in from the old position.
 */
export const DEFAULT_FILTER_CONFIG: FilterConfig = Object.freeze({
  kind: 'one-euro',
  oneEuro: DEFAULT_ONE_EURO_PARAMS,
  lowPassCutoffHz: 4,
  resetAfterGapMs: 500,
});

/**
 * I-DT defaults.
 * - `dispersionPx` 80: about 2° at 60 cm, wide enough for filtered webcam
 *   gaze and still well under one key width of the coarse layouts.
 * - `minDurationMs` 100: the classic I-DT minimum fixation duration.
 * - `maxGapMs` 300: blinks last roughly 100-300 ms.
 */
export const DEFAULT_FIXATION_CONFIG: FixationConfig = Object.freeze({
  dispersionPx: 80,
  minDurationMs: 100,
  maxGapMs: 300,
});

/**
 * Dwell tuning defaults.
 * - `extrapolateMs` 100: covers sources down to 10 Hz without a jerky fill.
 * - `holdMs` 300: a blink does not cost progress.
 * - `neutralLikelihood` 0.05 and `likelihoodExponent` 0.35: a key the
 *   predictor gives about 1 in 20 (roughly a uniform letter) is unchanged;
 *   a 20% key is about 0.6x, a 1% key about 1.75x, before clamping to the
 *   user's min/max factor.
 */
export const DEFAULT_SELECTION_TUNING: SelectionTuning = Object.freeze({
  extrapolateMs: 100,
  holdMs: 300,
  neutralLikelihood: 0.05,
  likelihoodExponent: 0.35,
});

/**
 * Hit-test defaults.
 * - `expansionPx` 40: about 1° of visual angle; isolated buttons gain a
 *   generous margin, packed keys split the gap at its midline.
 * - `hysteresisPx` 12: larger than typical filtered jitter at a key edge,
 *   small compared with a key, so a deliberate move still switches quickly.
 * - `sigmaFloorPx` 12: the key distribution never claims more precision
 *   than this, even when a fixation's samples are almost identical.
 * - `minProbability` 0.01 and `maxEntries` 6: the predictor receives the
 *   handful of keys that matter, not the whole keyboard.
 */
export const DEFAULT_HIT_TEST_CONFIG: HitTestConfig = Object.freeze({
  expansionPx: 40,
  hysteresisPx: 12,
  sigmaFloorPx: 12,
  minProbability: 0.01,
  maxEntries: 6,
});

/** Engine defaults; ticks at 60 Hz (one display frame). */
export const DEFAULT_GAZE_ENGINE_CONFIG: GazeEngineConfig = Object.freeze({
  filter: DEFAULT_FILTER_CONFIG,
  fixation: DEFAULT_FIXATION_CONFIG,
  selection: DEFAULT_SELECTION_TUNING,
  tickIntervalMs: 1000 / 60,
});

/**
 * Dwell defaults, chosen for a new user (the research shows dwell falls from
 * about 900 ms to under 300 ms with practice, so "faster" is one key away).
 * - letters 800 ms; predictions 900 ms (a whole word, worth a little more
 *   care); function keys 1000 ms; destructive keys 1500 ms (clear, delete
 *   word: slowest, as the plan requires).
 * - `decayPerSecond` 2: progress drains completely in 500 ms off target, so
 *   a glance away of a few frames costs little but a real move resets.
 * - adaptive dwell on, factor 0.6-1.5: likely keys are at most 40% faster,
 *   unlikely keys at most 50% slower, so nothing becomes instant or
 *   unreachable. Targets without a likelihood are unaffected.
 * - `repeatIntervalMs` 1200: longer than a letter dwell, so repeats are deliberate.
 * - `wakeMs` 2000: a long, deliberate dwell to resume after a pause.
 */
export const DEFAULT_DWELL_CONFIG: DwellConfig = Object.freeze({
  classMs: Object.freeze({ letter: 800, prediction: 900, function: 1000, destructive: 1500 }),
  decayPerSecond: 2,
  adaptive: Object.freeze({ enabled: true, minFactor: 0.6, maxFactor: 1.5 }),
  repeatIntervalMs: 1200,
  wakeMs: 2000,
});

// ------------------------------------------------------------------ validation helpers

/** Bounds enforced by validation (inclusive). */
export const DWELL_LIMITS = Object.freeze({
  classMs: { min: 100, max: 10_000 },
  decayPerSecond: { min: 0, max: 100 },
  minFactor: { min: 0.25, max: 1 },
  maxFactor: { min: 1, max: 4 },
  repeatIntervalMs: { min: 100, max: 10_000 },
  wakeMs: { min: 500, max: 20_000 },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  readonly issues: ValidationIssue[] = [];

  number(path: string, value: unknown, min: number, max: number, integer = false): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.issues.push({ path, message: 'must be a finite number' });
      return min;
    }
    if (value < min || value > max) {
      this.issues.push({ path, message: `must be between ${min} and ${max}` });
    }
    if (integer && !Number.isInteger(value)) {
      this.issues.push({ path, message: 'must be an integer' });
    }
    return value;
  }

  boolean(path: string, value: unknown): boolean {
    if (typeof value !== 'boolean') this.issues.push({ path, message: 'must be a boolean' });
    return value === true;
  }

  record(path: string, value: unknown): Record<string, unknown> {
    if (isRecord(value)) return value;
    this.issues.push({ path, message: 'must be an object' });
    return {};
  }

  oneOf<T extends string>(path: string, value: unknown, options: readonly T[]): T {
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) {
      return value as T;
    }
    this.issues.push({ path, message: `must be one of ${options.join(', ')}` });
    return options[0]!;
  }

  result<T>(value: T): ValidationResult<T> {
    return this.issues.length === 0 ? { ok: true, value } : { ok: false, issues: this.issues };
  }
}

function throwIfInvalid<T>(result: ValidationResult<T>, what: string): T {
  if (result.ok) return result.value;
  const detail = result.issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ');
  throw new ForseeError('invalid-argument', `Invalid ${what}: ${detail}`, {
    details: result.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

// ------------------------------------------------------------------ dwell config

/** Validates untrusted data (for example from settings) as a `DwellConfig`. */
export function validateDwellConfig(value: unknown): ValidationResult<DwellConfig> {
  const c = new Checker();
  const root = c.record('', value);
  const classMsIn = c.record('/classMs', root.classMs);
  const classMs = {} as Record<DwellClass, number>;
  for (const cls of DWELL_CLASSES) {
    classMs[cls] = c.number(
      `/classMs/${cls}`,
      classMsIn[cls],
      DWELL_LIMITS.classMs.min,
      DWELL_LIMITS.classMs.max,
    );
  }
  const decayPerSecond = c.number(
    '/decayPerSecond',
    root.decayPerSecond,
    DWELL_LIMITS.decayPerSecond.min,
    DWELL_LIMITS.decayPerSecond.max,
  );
  const adaptiveIn = c.record('/adaptive', root.adaptive);
  const adaptive = {
    enabled: c.boolean('/adaptive/enabled', adaptiveIn.enabled),
    minFactor: c.number(
      '/adaptive/minFactor',
      adaptiveIn.minFactor,
      DWELL_LIMITS.minFactor.min,
      DWELL_LIMITS.minFactor.max,
    ),
    maxFactor: c.number(
      '/adaptive/maxFactor',
      adaptiveIn.maxFactor,
      DWELL_LIMITS.maxFactor.min,
      DWELL_LIMITS.maxFactor.max,
    ),
  };
  const repeatIntervalMs = c.number(
    '/repeatIntervalMs',
    root.repeatIntervalMs,
    DWELL_LIMITS.repeatIntervalMs.min,
    DWELL_LIMITS.repeatIntervalMs.max,
  );
  const wakeMs = c.number('/wakeMs', root.wakeMs, DWELL_LIMITS.wakeMs.min, DWELL_LIMITS.wakeMs.max);
  return c.result({ classMs, decayPerSecond, adaptive, repeatIntervalMs, wakeMs });
}

/** Like `validateDwellConfig`, but throws `ForseeError('invalid-argument')`. */
export function assertDwellConfig(value: unknown): DwellConfig {
  return throwIfInvalid(validateDwellConfig(value), 'dwell config');
}

// ------------------------------------------------------------------ engine config

/** Validates untrusted data as a complete `GazeEngineConfig`. */
export function validateGazeEngineConfig(value: unknown): ValidationResult<GazeEngineConfig> {
  const c = new Checker();
  const root = c.record('', value);
  const f = c.record('/filter', root.filter);
  const oe = c.record('/filter/oneEuro', f.oneEuro);
  const filter: FilterConfig = {
    kind: c.oneOf('/filter/kind', f.kind, ['one-euro', 'low-pass', 'none'] as const),
    oneEuro: {
      minCutoff: c.number('/filter/oneEuro/minCutoff', oe.minCutoff, 0.001, 1000),
      beta: c.number('/filter/oneEuro/beta', oe.beta, 0, 100),
      dCutoff: c.number('/filter/oneEuro/dCutoff', oe.dCutoff, 0.001, 1000),
    },
    lowPassCutoffHz: c.number('/filter/lowPassCutoffHz', f.lowPassCutoffHz, 0.001, 1000),
    resetAfterGapMs: c.number('/filter/resetAfterGapMs', f.resetAfterGapMs, 0, 60_000),
  };
  const fx = c.record('/fixation', root.fixation);
  const fixation: FixationConfig = {
    dispersionPx: c.number('/fixation/dispersionPx', fx.dispersionPx, 1, 10_000),
    minDurationMs: c.number('/fixation/minDurationMs', fx.minDurationMs, 0, 10_000),
    maxGapMs: c.number('/fixation/maxGapMs', fx.maxGapMs, 0, 10_000),
  };
  const s = c.record('/selection', root.selection);
  const selection: SelectionTuning = {
    extrapolateMs: c.number('/selection/extrapolateMs', s.extrapolateMs, 0, 1000),
    holdMs: c.number('/selection/holdMs', s.holdMs, 0, 10_000),
    neutralLikelihood: c.number('/selection/neutralLikelihood', s.neutralLikelihood, 1e-6, 1),
    likelihoodExponent: c.number('/selection/likelihoodExponent', s.likelihoodExponent, 0, 4),
  };
  const tickIntervalMs = c.number('/tickIntervalMs', root.tickIntervalMs, 0, 1000);
  return c.result({ filter, fixation, selection, tickIntervalMs });
}

/**
 * Merges `patch` over `base` (default: the engine defaults) and validates the
 * result. Throws `ForseeError('invalid-argument')` on invalid values.
 */
export function resolveGazeEngineConfig(
  patch: GazeEngineConfigPatch = {},
  base: GazeEngineConfig = DEFAULT_GAZE_ENGINE_CONFIG,
): GazeEngineConfig {
  const merged = {
    filter: {
      ...base.filter,
      ...patch.filter,
      oneEuro: { ...base.filter.oneEuro, ...patch.filter?.oneEuro },
    },
    fixation: { ...base.fixation, ...patch.fixation },
    selection: { ...base.selection, ...patch.selection },
    tickIntervalMs: patch.tickIntervalMs ?? base.tickIntervalMs,
  };
  return throwIfInvalid(validateGazeEngineConfig(merged), 'gaze engine config');
}

/** Validates untrusted data as a complete `HitTestConfig`. */
export function validateHitTestConfig(value: unknown): ValidationResult<HitTestConfig> {
  const c = new Checker();
  const root = c.record('', value);
  return c.result({
    expansionPx: c.number('/expansionPx', root.expansionPx, 0, 1000),
    hysteresisPx: c.number('/hysteresisPx', root.hysteresisPx, 0, 1000),
    sigmaFloorPx: c.number('/sigmaFloorPx', root.sigmaFloorPx, 0.5, 1000),
    minProbability: c.number('/minProbability', root.minProbability, 0, 0.5),
    maxEntries: c.number('/maxEntries', root.maxEntries, 1, 100, true),
  });
}

/** Merges `patch` over `base` and validates; throws `ForseeError('invalid-argument')`. */
export function resolveHitTestConfig(
  patch: Partial<HitTestConfig> = {},
  base: HitTestConfig = DEFAULT_HIT_TEST_CONFIG,
): HitTestConfig {
  return throwIfInvalid(validateHitTestConfig({ ...base, ...patch }), 'hit test config');
}

// ------------------------------------------------------------------ adaptive dwell

/**
 * The adaptive dwell factor for a target's `likelihood`:
 * `(likelihood / neutral) ^ -exponent`, clamped to
 * `[adaptive.minFactor, adaptive.maxFactor]`. 1 when adaptive dwell is off
 * or the target has no likelihood.
 */
export function likelihoodFactor(
  likelihood: number | undefined,
  adaptive: DwellConfig['adaptive'],
  tuning: SelectionTuning = DEFAULT_SELECTION_TUNING,
): number {
  if (!adaptive.enabled || likelihood === undefined || !Number.isFinite(likelihood)) return 1;
  const l = Math.min(1, Math.max(1e-9, likelihood));
  const raw = Math.pow(l / tuning.neutralLikelihood, -tuning.likelihoodExponent);
  return Math.min(adaptive.maxFactor, Math.max(adaptive.minFactor, raw));
}

// ------------------------------------------------------------------ in-place adjustment

/** Options for `adjustDwell`. */
export interface DwellAdjustment {
  readonly direction: 'faster' | 'slower';
  /** Classes to change; default all. */
  readonly classes?: readonly DwellClass[];
  /** Step, ms. Default 100. */
  readonly stepMs?: number;
  /** Lower bound, ms. Default 200 (below that, nobody can read the key before it fires). */
  readonly minMs?: number;
  /** Upper bound, ms. Default 5000. */
  readonly maxMs?: number;
}

/** Result of `adjustDwell`. */
export interface DwellAdjustmentResult {
  /** The new configuration (the input is not modified). */
  readonly config: DwellConfig;
  /** New dwell time of each adjusted class, ms. */
  readonly changed: Readonly<Partial<Record<DwellClass, number>>>;
  /** True when at least one class hit a bound and could not move the full step. */
  readonly atLimit: boolean;
}

/** Default step and bounds of `adjustDwell`. */
export const DWELL_ADJUSTMENT_DEFAULTS = Object.freeze({ stepMs: 100, minMs: 200, maxMs: 5000 });

/**
 * Steps dwell times faster (shorter) or slower (longer) within bounds, for
 * the in-place "faster" / "slower" keys. Pure: the caller stores the new
 * config in settings and passes it to `GazePipeline.setDwellConfig`, then
 * says the new value (`changed`).
 */
export function adjustDwell(
  config: DwellConfig,
  adjustment: DwellAdjustment,
): DwellAdjustmentResult {
  const stepMs = adjustment.stepMs ?? DWELL_ADJUSTMENT_DEFAULTS.stepMs;
  const minMs = adjustment.minMs ?? DWELL_ADJUSTMENT_DEFAULTS.minMs;
  const maxMs = adjustment.maxMs ?? DWELL_ADJUSTMENT_DEFAULTS.maxMs;
  if (!(stepMs > 0) || !(minMs > 0) || !(maxMs >= minMs)) {
    throw new ForseeError(
      'invalid-argument',
      'adjustDwell needs stepMs > 0 and 0 < minMs <= maxMs',
    );
  }
  const classes = adjustment.classes ?? DWELL_CLASSES;
  const sign = adjustment.direction === 'faster' ? -1 : 1;
  const classMs: Record<DwellClass, number> = { ...config.classMs };
  const changed: Partial<Record<DwellClass, number>> = {};
  let atLimit = false;
  for (const cls of classes) {
    const wanted = classMs[cls] + sign * stepMs;
    const next = Math.round(Math.min(maxMs, Math.max(minMs, wanted)));
    if (next !== Math.round(wanted)) atLimit = true;
    classMs[cls] = next;
    changed[cls] = next;
  }
  return { config: { ...config, classMs }, changed, atLimit };
}

// ------------------------------------------------------------------ settings

/** Settings namespace of the gaze engine. */
export const GAZE_SETTINGS_NAMESPACE = 'app.gaze';

const CLASS_LABELS: Readonly<Record<DwellClass, string>> = {
  letter: 'Letter dwell (ms)',
  prediction: 'Prediction dwell (ms)',
  function: 'Function key dwell (ms)',
  destructive: 'Delete and clear dwell (ms)',
};

/**
 * Settings schema for `app.gaze`, so the generated settings screen can edit
 * the user-facing gaze settings. Register it with
 * `kernel.settings.registerSchema(GAZE_SETTINGS_NAMESPACE, GAZE_SETTING_FIELDS)`
 * and turn values into configs with `gazeConfigFromSettings`.
 */
export const GAZE_SETTING_FIELDS: readonly SettingField[] = Object.freeze([
  {
    key: 'selectionMethod',
    label: 'Selection method',
    type: 'select',
    default: 'dwell',
    options: [
      { label: 'Dwell', value: 'dwell' },
      { label: 'Click or tap', value: 'direct' },
      { label: 'Look and press a switch', value: 'switch' },
    ],
  },
  ...DWELL_CLASSES.map((cls): SettingField => ({
    key: `dwell.${cls}Ms`,
    label: CLASS_LABELS[cls],
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.classMs[cls],
    min: DWELL_LIMITS.classMs.min,
    max: DWELL_LIMITS.classMs.max,
    step: DWELL_ADJUSTMENT_DEFAULTS.stepMs,
  })),
  {
    key: 'dwell.decayPerSecond',
    label: 'Dwell decay (fraction per second)',
    description: 'How fast dwell progress drains while you look away.',
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.decayPerSecond,
    min: DWELL_LIMITS.decayPerSecond.min,
    max: DWELL_LIMITS.decayPerSecond.max,
    step: 0.5,
  },
  {
    key: 'dwell.adaptive',
    label: 'Faster dwell on likely keys',
    type: 'boolean',
    default: DEFAULT_DWELL_CONFIG.adaptive.enabled,
  },
  {
    key: 'dwell.adaptiveMinFactor',
    label: 'Fastest likely-key factor',
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.adaptive.minFactor,
    min: DWELL_LIMITS.minFactor.min,
    max: DWELL_LIMITS.minFactor.max,
    step: 0.05,
  },
  {
    key: 'dwell.adaptiveMaxFactor',
    label: 'Slowest unlikely-key factor',
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.adaptive.maxFactor,
    min: DWELL_LIMITS.maxFactor.min,
    max: DWELL_LIMITS.maxFactor.max,
    step: 0.05,
  },
  {
    key: 'dwell.repeatIntervalMs',
    label: 'Repeat interval (ms)',
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.repeatIntervalMs,
    min: DWELL_LIMITS.repeatIntervalMs.min,
    max: DWELL_LIMITS.repeatIntervalMs.max,
    step: 100,
  },
  {
    key: 'dwell.wakeMs',
    label: 'Wake dwell (ms)',
    type: 'number',
    default: DEFAULT_DWELL_CONFIG.wakeMs,
    min: DWELL_LIMITS.wakeMs.min,
    max: DWELL_LIMITS.wakeMs.max,
    step: 100,
  },
  {
    key: 'targets.expansionPx',
    label: 'Target expansion (px)',
    type: 'number',
    default: DEFAULT_HIT_TEST_CONFIG.expansionPx,
    min: 0,
    max: 200,
    step: 4,
  },
  {
    key: 'targets.hysteresisPx',
    label: 'Edge stickiness (px)',
    type: 'number',
    default: DEFAULT_HIT_TEST_CONFIG.hysteresisPx,
    min: 0,
    max: 100,
    step: 2,
  },
  {
    key: 'filter.minCutoff',
    label: 'Smoothing at rest (Hz, lower is smoother)',
    type: 'number',
    default: DEFAULT_ONE_EURO_PARAMS.minCutoff,
    min: 0.05,
    max: 20,
    step: 0.05,
  },
  {
    key: 'filter.beta',
    label: 'Smoothing speed response',
    type: 'number',
    default: DEFAULT_ONE_EURO_PARAMS.beta,
    min: 0,
    max: 1,
    step: 0.001,
  },
]);

/** Configs derived from `app.gaze` setting values. */
export interface GazeSettingsConfig {
  readonly method: SelectionMethodId;
  readonly dwell: DwellConfig;
  readonly hitTest: Partial<HitTestConfig>;
  readonly engine: GazeEngineConfigPatch;
}

/**
 * Builds configs from `app.gaze` values (missing keys use defaults). Values
 * are expected to have passed the settings registry's validation; the dwell
 * config is validated again and throws `ForseeError('invalid-argument')`.
 */
export function gazeConfigFromSettings(
  values: Readonly<Record<string, SettingValue>>,
): GazeSettingsConfig {
  const num = (key: string, fallback: number): number => {
    const v = values[key];
    return typeof v === 'number' ? v : fallback;
  };
  const d = DEFAULT_DWELL_CONFIG;
  const classMs = {} as Record<DwellClass, number>;
  for (const cls of DWELL_CLASSES) classMs[cls] = num(`dwell.${cls}Ms`, d.classMs[cls]);
  const dwell = assertDwellConfig({
    classMs,
    decayPerSecond: num('dwell.decayPerSecond', d.decayPerSecond),
    adaptive: {
      enabled:
        typeof values['dwell.adaptive'] === 'boolean'
          ? values['dwell.adaptive']
          : d.adaptive.enabled,
      minFactor: num('dwell.adaptiveMinFactor', d.adaptive.minFactor),
      maxFactor: num('dwell.adaptiveMaxFactor', d.adaptive.maxFactor),
    },
    repeatIntervalMs: num('dwell.repeatIntervalMs', d.repeatIntervalMs),
    wakeMs: num('dwell.wakeMs', d.wakeMs),
  });
  const methodValue = values.selectionMethod;
  const method: SelectionMethodId =
    methodValue === 'direct' || methodValue === 'switch' ? methodValue : 'dwell';
  return {
    method,
    dwell,
    hitTest: {
      expansionPx: num('targets.expansionPx', DEFAULT_HIT_TEST_CONFIG.expansionPx),
      hysteresisPx: num('targets.hysteresisPx', DEFAULT_HIT_TEST_CONFIG.hysteresisPx),
    },
    engine: {
      filter: {
        oneEuro: {
          minCutoff: num('filter.minCutoff', DEFAULT_ONE_EURO_PARAMS.minCutoff),
          beta: num('filter.beta', DEFAULT_ONE_EURO_PARAMS.beta),
        },
      },
    },
  };
}

/** The `app.gaze` setting values for a dwell config (to persist after `adjustDwell`). */
export function dwellConfigToSettings(config: DwellConfig): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const cls of DWELL_CLASSES) out[`dwell.${cls}Ms`] = config.classMs[cls];
  out['dwell.decayPerSecond'] = config.decayPerSecond;
  out['dwell.adaptive'] = config.adaptive.enabled;
  out['dwell.adaptiveMinFactor'] = config.adaptive.minFactor;
  out['dwell.adaptiveMaxFactor'] = config.adaptive.maxFactor;
  out['dwell.repeatIntervalMs'] = config.repeatIntervalMs;
  out['dwell.wakeMs'] = config.wakeMs;
  return out;
}
