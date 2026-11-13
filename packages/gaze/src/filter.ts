import type { GazeSample } from '@forsee/plugin-api';
import { DEFAULT_FILTER_CONFIG, DEFAULT_ONE_EURO_PARAMS, type FilterConfig } from './config';
import type { GazeFilter, OneEuroParams } from './contracts';

/**
 * Smoothing filters.
 *
 * The One Euro filter is written from the description in Casiez, Roussel and
 * Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in
 * Interactive Systems" (CHI 2012): an exponential low-pass filter whose
 * cutoff frequency rises with the (itself low-pass filtered) speed of the
 * signal, so it is smooth when the signal is still and responsive when it
 * moves. For a cutoff `fc` and sample interval `Te` (seconds) the smoothing
 * factor is `alpha = 1 / (1 + tau / Te)` with `tau = 1 / (2 pi fc)`, which
 * makes the filter correct for variable sample intervals.
 *
 * All filters work per axis, use only `sample.t` for time, let invalid
 * samples through unchanged without touching their state, and reset after
 * an invalid run or gap longer than `resetAfterGapMs`.
 */

/** Exponential smoothing factor for cutoff `cutoffHz` and interval `dtSeconds`. */
export function smoothingFactor(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/** One axis of a One Euro filter. */
class OneEuroAxis {
  private estimate: number | null = null;
  private speed = 0;

  step(value: number, dtSeconds: number, params: OneEuroParams): number {
    if (this.estimate === null) {
      this.estimate = value;
      this.speed = 0;
      return value;
    }
    // Speed of the raw signal relative to the previous estimate, low-passed at dCutoff.
    const rawSpeed = (value - this.estimate) / dtSeconds;
    const aSpeed = smoothingFactor(params.dCutoff, dtSeconds);
    this.speed = aSpeed * rawSpeed + (1 - aSpeed) * this.speed;
    // The cutoff grows linearly with speed.
    const cutoff = params.minCutoff + params.beta * Math.abs(this.speed);
    const a = smoothingFactor(cutoff, dtSeconds);
    this.estimate = a * value + (1 - a) * this.estimate;
    return this.estimate;
  }

  reset(): void {
    this.estimate = null;
    this.speed = 0;
  }
}

/** Shared bookkeeping: time since the last valid sample, gap resets, duplicate timestamps. */
abstract class TimedFilter implements GazeFilter {
  private lastT: number | null = null;
  private last: { x: number; y: number } | null = null;

  constructor(private readonly resetAfterGapMs: number) {}

  filter(sample: GazeSample): GazeSample {
    if (!sample.valid) return sample;
    if (this.lastT !== null && sample.t - this.lastT > this.resetAfterGapMs) this.reset();
    if (this.lastT === null || this.last === null) {
      this.lastT = sample.t;
      this.last = this.first(sample.x, sample.y);
      return { ...sample, x: this.last.x, y: this.last.y };
    }
    const dtMs = sample.t - this.lastT;
    if (dtMs <= 0) {
      // Duplicate (or out-of-order) timestamp: no time has passed, so the estimate stands.
      return { ...sample, x: this.last.x, y: this.last.y };
    }
    this.lastT = sample.t;
    this.last = this.next(sample.x, sample.y, dtMs / 1000);
    return { ...sample, x: this.last.x, y: this.last.y };
  }

  reset(): void {
    this.lastT = null;
    this.last = null;
    this.resetState();
  }

  protected abstract first(x: number, y: number): { x: number; y: number };
  protected abstract next(x: number, y: number, dtSeconds: number): { x: number; y: number };
  protected abstract resetState(): void;
}

/** The One Euro filter, per axis. */
export class OneEuroFilter extends TimedFilter {
  private readonly ax = new OneEuroAxis();
  private readonly ay = new OneEuroAxis();

  constructor(
    private readonly params: OneEuroParams = DEFAULT_ONE_EURO_PARAMS,
    resetAfterGapMs: number = DEFAULT_FILTER_CONFIG.resetAfterGapMs,
  ) {
    super(resetAfterGapMs);
  }

  protected first(x: number, y: number): { x: number; y: number } {
    return { x: this.ax.step(x, 1, this.params), y: this.ay.step(y, 1, this.params) };
  }

  protected next(x: number, y: number, dt: number): { x: number; y: number } {
    return { x: this.ax.step(x, dt, this.params), y: this.ay.step(y, dt, this.params) };
  }

  protected resetState(): void {
    this.ax.reset();
    this.ay.reset();
  }
}

/** A first-order low-pass filter with a fixed cutoff (the simple alternative). */
export class LowPassFilter extends TimedFilter {
  private x = 0;
  private y = 0;

  constructor(
    private readonly cutoffHz: number = DEFAULT_FILTER_CONFIG.lowPassCutoffHz,
    resetAfterGapMs: number = DEFAULT_FILTER_CONFIG.resetAfterGapMs,
  ) {
    super(resetAfterGapMs);
  }

  protected first(x: number, y: number): { x: number; y: number } {
    this.x = x;
    this.y = y;
    return { x, y };
  }

  protected next(x: number, y: number, dt: number): { x: number; y: number } {
    const a = smoothingFactor(this.cutoffHz, dt);
    this.x = a * x + (1 - a) * this.x;
    this.y = a * y + (1 - a) * this.y;
    return { x: this.x, y: this.y };
  }

  protected resetState(): void {
    this.x = 0;
    this.y = 0;
  }
}

/** Identity filter, for `pointer` sources (already smoothed) and `kind: 'none'`. */
export class PassThroughFilter implements GazeFilter {
  filter(sample: GazeSample): GazeSample {
    return sample;
  }

  reset(): void {
    // stateless
  }
}

/**
 * The filter for a source: identity for `pointer` sources, otherwise the
 * one `config.kind` names.
 */
export function createGazeFilter(
  sourceKind: 'pointer' | 'gaze',
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): GazeFilter {
  if (sourceKind === 'pointer') return new PassThroughFilter();
  switch (config.kind) {
    case 'one-euro':
      return new OneEuroFilter(config.oneEuro, config.resetAfterGapMs);
    case 'low-pass':
      return new LowPassFilter(config.lowPassCutoffHz, config.resetAfterGapMs);
    case 'none':
      return new PassThroughFilter();
  }
}
