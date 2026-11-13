import type {
  GazeSample,
  GazeSource,
  GazeSourceCapabilities,
  Point,
  SourceError,
} from '@forsee/plugin-api';

/**
 * Deterministic test doubles for gaze: a seeded random generator, a
 * synthetic gaze stream builder and a manually driven source. Exported so
 * other packages (UI, sources, the typing evaluation harness) can use them.
 */

/** A seeded pseudo-random generator (xorshift32 with a splitmix-style seed scramble). */
export class SeededRandom {
  private state: number;

  constructor(seed = 1) {
    let s = (seed ^ 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x85ebca6b) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
    this.state = (s ^ (s >>> 16)) >>> 0 || 0x6d2b79f5;
  }

  /** A float in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 4294967296;
  }

  /** A standard normal deviate (Box-Muller). */
  gaussian(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Options of `GazeScript`. */
export interface GazeScriptOptions {
  /** Sample rate, Hz. Default 60. */
  readonly rateHz?: number;
  /** Time of the first sample, ms. Default 0. */
  readonly startT?: number;
  /** Seed of the jitter generator. Default 1. */
  readonly seed?: number;
  /** Default per-axis jitter standard deviation, px. Default 0. */
  readonly jitterPx?: number;
}

/**
 * Builds a synthetic gaze stream, one segment at a time. Every segment
 * appends samples at the script's rate, continuing from where the previous
 * one ended (time and position).
 *
 * ```ts
 * const samples = new GazeScript({ rateHz: 60, seed: 7, jitterPx: 5 })
 *   .fixate({ x: 100, y: 100 }, 500)
 *   .saccade({ x: 300, y: 100 }, 40)
 *   .blink(150)
 *   .fixate({ x: 300, y: 100 }, 800)
 *   .samples;
 * ```
 */
export class GazeScript {
  readonly samples: GazeSample[] = [];
  private readonly intervalMs: number;
  private readonly rng: SeededRandom;
  private readonly defaultJitter: number;
  private nextT: number;
  private position: Point = { x: 0, y: 0 };

  constructor(options: GazeScriptOptions = {}) {
    this.intervalMs = 1000 / (options.rateHz ?? 60);
    this.nextT = options.startT ?? 0;
    this.rng = new SeededRandom(options.seed ?? 1);
    this.defaultJitter = options.jitterPx ?? 0;
  }

  /** Time the next sample will carry, ms. */
  get t(): number {
    return this.nextT;
  }

  /** Last intended (noise-free) position. */
  get at(): Point {
    return this.position;
  }

  /** Looks at `point` for `durationMs`, with Gaussian jitter. */
  fixate(point: Point, durationMs: number, options: { jitterPx?: number } = {}): this {
    const jitter = options.jitterPx ?? this.defaultJitter;
    this.position = point;
    for (const t of this.times(durationMs)) this.push(point, t, jitter);
    return this;
  }

  /** Moves linearly to `to` over `durationMs` (a saccade is 20-60 ms). */
  saccade(to: Point, durationMs = 40, options: { jitterPx?: number } = {}): this {
    return this.move(to, durationMs, options.jitterPx ?? 0);
  }

  /** Slow linear drift to `to` over `durationMs`, with fixation jitter. */
  drift(to: Point, durationMs: number, options: { jitterPx?: number } = {}): this {
    return this.move(to, durationMs, options.jitterPx ?? this.defaultJitter);
  }

  /** Invalid samples (blink, tracking lost) for `durationMs`; position repeats the last one. */
  blink(durationMs: number): this {
    for (const t of this.times(durationMs)) {
      this.samples.push({ x: this.position.x, y: this.position.y, t, confidence: 0, valid: false });
    }
    return this;
  }

  /** No samples at all for `durationMs` (a stalled source). */
  gap(durationMs: number): this {
    this.nextT += durationMs;
    return this;
  }

  /** One press sample at `point` (a click or tap), then stays there. */
  press(point: Point = this.position): this {
    this.position = point;
    this.samples.push({
      x: point.x,
      y: point.y,
      t: this.nextT,
      confidence: 1,
      valid: true,
      press: true,
    });
    this.nextT += this.intervalMs;
    return this;
  }

  private move(to: Point, durationMs: number, jitter: number): this {
    const from = this.position;
    const times = this.times(durationMs);
    times.forEach((t, i) => {
      const f = (i + 1) / times.length;
      this.push({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }, t, jitter);
    });
    this.position = to;
    return this;
  }

  private times(durationMs: number): number[] {
    const count = Math.max(0, Math.round(durationMs / this.intervalMs));
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(this.nextT);
      this.nextT += this.intervalMs;
    }
    return out;
  }

  private push(point: Point, t: number, jitter: number): void {
    const x = point.x + (jitter > 0 ? this.rng.gaussian() * jitter : 0);
    const y = point.y + (jitter > 0 ? this.rng.gaussian() * jitter : 0);
    this.samples.push({ x, y, t, confidence: 1, valid: true });
  }
}

/** A `GazeSource` driven by the test: `emit` delivers samples synchronously. */
export class ManualGazeSource implements GazeSource {
  readonly capabilities: GazeSourceCapabilities;
  private onSample: ((sample: GazeSample) => void) | null = null;
  private onError: ((error: SourceError) => void) | null = null;
  /** Number of `start` calls. */
  starts = 0;
  /** Number of `stop` calls. */
  stops = 0;

  constructor(
    readonly id = 'manual',
    readonly kind: 'pointer' | 'gaze' = 'gaze',
    capabilities: Partial<GazeSourceCapabilities> = {},
  ) {
    this.capabilities = { calibrate: false, hover: true, ...capabilities };
  }

  get running(): boolean {
    return this.onSample !== null;
  }

  start(onSample: (sample: GazeSample) => void, onError: (error: SourceError) => void): void {
    if (this.onSample) throw new Error('ManualGazeSource already started');
    this.starts += 1;
    this.onSample = onSample;
    this.onError = onError;
  }

  stop(): void {
    this.stops += 1;
    this.onSample = null;
    this.onError = null;
  }

  /** Delivers samples (no-op while stopped). */
  emit(...samples: readonly GazeSample[]): void {
    for (const sample of samples) this.onSample?.(sample);
  }

  /** Reports an error; a non-recoverable one stops the source. */
  fail(error: SourceError): void {
    const onError = this.onError;
    if (!error.recoverable) {
      this.onSample = null;
      this.onError = null;
    }
    onError?.(error);
  }
}
