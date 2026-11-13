import type { GazeSample } from '@forsee/plugin-api';
import { DEFAULT_FIXATION_CONFIG, type FixationConfig } from './config';
import type { Fixation, FixationDetector, FixationState } from './contracts';

/**
 * Online dispersion-threshold fixation detection (I-DT, Salvucci and
 * Goldberg 2000), adapted to a stream.
 *
 * Why I-DT rather than velocity thresholds (I-VT): the samples arriving here
 * have already been through the One Euro filter, whose lag and variable
 * sample rate (webcams deliver 15-30 Hz with jitter) make point-to-point
 * velocities unreliable, whereas spatial dispersion is robust to both.
 *
 * - Dispersion is `(maxX - minX) + (maxY - minY)` of a group of samples.
 * - Before a fixation, a sliding candidate window keeps the most recent
 *   valid samples whose dispersion is within `dispersionPx`. Once the window
 *   spans `minDurationMs`, a fixation starts (`started: true`).
 * - During a fixation, each sample that keeps the whole fixation within
 *   `dispersionPx` extends it (centroid and spread are running statistics).
 *   A sample that would exceed it ends the fixation (`ended`) and seeds a
 *   new candidate window.
 * - Invalid samples (blinks, dropouts) leave the fixation open for up to
 *   `maxGapMs` after the last valid sample; a longer run, or a longer gap
 *   between valid samples, ends it.
 */
export class IdtFixationDetector implements FixationDetector {
  private window: GazeSample[] = [];
  private current: FixationAccumulator | null = null;
  private lastValidT: number | null = null;

  constructor(private readonly config: FixationConfig = DEFAULT_FIXATION_CONFIG) {}

  update(sample: GazeSample): FixationState {
    const usable = sample.valid && Number.isFinite(sample.x) && Number.isFinite(sample.y);
    let ended: Fixation | undefined;
    if (this.lastValidT !== null && sample.t - this.lastValidT > this.config.maxGapMs) {
      ended = this.current?.snapshot();
      this.current = null;
      this.window = [];
      this.lastValidT = null;
    }
    if (!usable) {
      return withEnded({ fixation: this.current?.snapshot() ?? null, started: false }, ended);
    }
    this.lastValidT = sample.t;

    if (this.current) {
      if (this.current.dispersionWith(sample) <= this.config.dispersionPx) {
        this.current.add(sample);
        return withEnded({ fixation: this.current.snapshot(), started: false }, ended);
      }
      ended = this.current.snapshot();
      this.current = null;
      this.window = [];
    }

    this.window.push(sample);
    while (this.window.length > 1 && dispersion(this.window) > this.config.dispersionPx) {
      this.window.shift();
    }
    const first = this.window[0];
    if (first && sample.t - first.t >= this.config.minDurationMs) {
      const accumulator = new FixationAccumulator(first);
      for (let i = 1; i < this.window.length; i++) {
        const s = this.window[i];
        if (s) accumulator.add(s);
      }
      this.current = accumulator;
      this.window = [];
      return withEnded({ fixation: accumulator.snapshot(), started: true }, ended);
    }
    return withEnded({ fixation: null, started: false }, ended);
  }

  reset(): void {
    this.window = [];
    this.current = null;
    this.lastValidT = null;
  }
}

function withEnded(state: FixationState, ended: Fixation | undefined): FixationState {
  return ended === undefined ? state : { ...state, ended };
}

function dispersion(samples: readonly GazeSample[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  }
  return maxX - minX + (maxY - minY);
}

/** Running statistics of a fixation; sums are taken relative to the first sample for precision. */
class FixationAccumulator {
  private readonly ox: number;
  private readonly oy: number;
  private readonly startT: number;
  private t: number;
  private n = 0;
  private sx = 0;
  private sy = 0;
  private sxx = 0;
  private syy = 0;
  private minX: number;
  private maxX: number;
  private minY: number;
  private maxY: number;

  constructor(first: GazeSample) {
    this.ox = first.x;
    this.oy = first.y;
    this.startT = first.t;
    this.t = first.t;
    this.minX = this.maxX = first.x;
    this.minY = this.maxY = first.y;
    this.add(first);
  }

  dispersionWith(s: GazeSample): number {
    return (
      Math.max(this.maxX, s.x) -
      Math.min(this.minX, s.x) +
      (Math.max(this.maxY, s.y) - Math.min(this.minY, s.y))
    );
  }

  add(s: GazeSample): void {
    const dx = s.x - this.ox;
    const dy = s.y - this.oy;
    this.n += 1;
    this.sx += dx;
    this.sy += dy;
    this.sxx += dx * dx;
    this.syy += dy * dy;
    this.minX = Math.min(this.minX, s.x);
    this.maxX = Math.max(this.maxX, s.x);
    this.minY = Math.min(this.minY, s.y);
    this.maxY = Math.max(this.maxY, s.y);
    this.t = s.t;
  }

  snapshot(): Fixation {
    const mx = this.sx / this.n;
    const my = this.sy / this.n;
    const varX = Math.max(0, this.sxx / this.n - mx * mx);
    const varY = Math.max(0, this.syy / this.n - my * my);
    return {
      x: this.ox + mx,
      y: this.oy + my,
      startT: this.startT,
      t: this.t,
      durationMs: this.t - this.startT,
      dispersionPx: this.maxX - this.minX + (this.maxY - this.minY),
      spreadPx: Math.sqrt((varX + varY) / 2),
    };
  }
}
