import type { GazeSample } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER_CONFIG } from './config';
import {
  LowPassFilter,
  OneEuroFilter,
  PassThroughFilter,
  createGazeFilter,
  smoothingFactor,
} from './filter';
import { GazeScript } from './testing';

const s = (x: number, y: number, t: number, valid = true): GazeSample => ({
  x,
  y,
  t,
  confidence: 1,
  valid,
});

function run(filter: { filter(s: GazeSample): GazeSample }, samples: readonly GazeSample[]) {
  return samples.map((sample) => filter.filter(sample));
}

function rmsError(samples: readonly GazeSample[], x: number, y: number): number {
  const sq = samples.reduce((sum, p) => sum + (p.x - x) ** 2 + (p.y - y) ** 2, 0);
  return Math.sqrt(sq / samples.length);
}

describe('smoothingFactor', () => {
  it('follows alpha = 1 / (1 + tau / Te) with tau = 1 / (2 pi fc)', () => {
    const tau = 1 / (2 * Math.PI * 1);
    expect(smoothingFactor(1, 0.01)).toBeCloseTo(1 / (1 + tau / 0.01), 12);
  });

  it('tends to 1 for long intervals and 0 for short ones', () => {
    expect(smoothingFactor(1, 100)).toBeGreaterThan(0.99);
    expect(smoothingFactor(1, 1e-6)).toBeLessThan(1e-4);
  });
});

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    const f = new OneEuroFilter();
    expect(f.filter(s(123, 45, 0))).toEqual(s(123, 45, 0));
  });

  it('keeps t, confidence, valid and press', () => {
    const f = new OneEuroFilter();
    f.filter(s(0, 0, 0));
    const out = f.filter({ x: 10, y: 10, t: 16, confidence: 0.4, valid: true, press: true });
    expect(out).toMatchObject({ t: 16, confidence: 0.4, valid: true, press: true });
  });

  it('reduces fixation jitter substantially', () => {
    const samples = new GazeScript({ seed: 3, jitterPx: 15 }).fixate(
      { x: 400, y: 300 },
      3000,
    ).samples;
    const filtered = run(new OneEuroFilter(), samples);
    // Skip the first half-second warm-up.
    const raw = rmsError(samples.slice(30), 400, 300);
    const smooth = rmsError(filtered.slice(30), 400, 300);
    expect(raw).toBeGreaterThan(15);
    expect(smooth).toBeLessThan(raw * 0.4);
  });

  it('follows a step quickly (speed raises the cutoff) and settles on the new value', () => {
    const samples = new GazeScript()
      .fixate({ x: 0, y: 0 }, 1000)
      .fixate({ x: 500, y: 0 }, 1000).samples;
    const out = run(new OneEuroFilter(), samples);
    const stepIndex = samples.findIndex((p) => p.x === 500);
    const after = (ms: number) => out[stepIndex + Math.round(ms / (1000 / 60))];
    // Within 100 ms the filter has covered most of the step...
    expect(after(100)?.x).toBeGreaterThan(400);
    // ...without overshoot, and settles.
    expect(Math.max(...out.map((p) => p.x))).toBeLessThanOrEqual(500 + 1e-9);
    expect(out.at(-1)?.x).toBeCloseTo(500, 0);
  });

  it('responds faster to a step than the fixed low-pass at the same resting cutoff', () => {
    const samples = new GazeScript()
      .fixate({ x: 0, y: 0 }, 500)
      .fixate({ x: 500, y: 0 }, 500).samples;
    const stepIndex = samples.findIndex((p) => p.x === 500);
    const oneEuro = run(new OneEuroFilter(), samples)[stepIndex + 3];
    const lowPass = run(new LowPassFilter(1), samples)[stepIndex + 3];
    expect(oneEuro?.x).toBeGreaterThan((lowPass?.x ?? 0) + 100);
  });

  it('handles variable sample intervals', () => {
    const f = new OneEuroFilter();
    const times = [0, 5, 40, 41, 90, 150, 152, 200];
    const out = times.map((t) => f.filter(s(100, 100, t)));
    for (const p of out) expect(p).toMatchObject({ x: 100, y: 100 });
    // A moving signal sampled irregularly stays finite and between the inputs.
    const g = new OneEuroFilter();
    const moving = times.map((t) => g.filter(s(t, 0, t)));
    for (const p of moving) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(p.x).toBeLessThanOrEqual(p.t);
      expect(p.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('lets invalid samples through untouched and ignores them for state', () => {
    const a = new OneEuroFilter();
    const b = new OneEuroFilter();
    a.filter(s(0, 0, 0));
    b.filter(s(0, 0, 0));
    const invalid = s(999, 999, 10, false);
    expect(a.filter(invalid)).toBe(invalid);
    expect(a.filter(s(10, 0, 20))).toEqual(b.filter(s(10, 0, 20)));
  });

  it('resets after an invalid run longer than resetAfterGapMs, not after a blink', () => {
    const blink = new OneEuroFilter(undefined, 500);
    blink.filter(s(0, 0, 0));
    blink.filter(s(0, 0, 16));
    expect(blink.filter(s(300, 0, 216)).x).toBeLessThan(300);

    const long = new OneEuroFilter(undefined, 500);
    long.filter(s(0, 0, 0));
    long.filter(s(0, 0, 16));
    long.filter(s(0, 0, 300, false));
    expect(long.filter(s(300, 0, 616)).x).toBe(300);
  });

  it('keeps the previous estimate for a duplicate timestamp', () => {
    const f = new OneEuroFilter();
    f.filter(s(0, 0, 0));
    const first = f.filter(s(10, 0, 16));
    expect(f.filter(s(50, 0, 16))).toMatchObject({ x: first.x, y: first.y });
  });

  it('is deterministic', () => {
    const samples = new GazeScript({ seed: 9, jitterPx: 20 }).fixate({ x: 1, y: 2 }, 1000).samples;
    expect(run(new OneEuroFilter(), samples)).toEqual(run(new OneEuroFilter(), samples));
  });

  it('reset() forgets history', () => {
    const f = new OneEuroFilter();
    f.filter(s(0, 0, 0));
    f.reset();
    expect(f.filter(s(300, 0, 16)).x).toBe(300);
  });
});

describe('LowPassFilter', () => {
  it('converges on a constant and smooths a step', () => {
    const f = new LowPassFilter(4);
    const out = run(f, [s(0, 0, 0), s(100, 0, 16), s(100, 0, 33), s(100, 0, 50)]);
    expect(out[1]?.x).toBeGreaterThan(0);
    expect(out[1]?.x).toBeLessThan(100);
    expect(out[3]?.x).toBeGreaterThan(out[1]?.x ?? 0);
  });
});

describe('createGazeFilter', () => {
  it('does not filter pointer sources', () => {
    expect(createGazeFilter('pointer')).toBeInstanceOf(PassThroughFilter);
    const sample = s(1, 2, 3);
    expect(createGazeFilter('pointer').filter(sample)).toBe(sample);
  });

  it('picks the configured filter for gaze sources', () => {
    expect(createGazeFilter('gaze')).toBeInstanceOf(OneEuroFilter);
    expect(createGazeFilter('gaze', { ...DEFAULT_FILTER_CONFIG, kind: 'low-pass' })).toBeInstanceOf(
      LowPassFilter,
    );
    expect(createGazeFilter('gaze', { ...DEFAULT_FILTER_CONFIG, kind: 'none' })).toBeInstanceOf(
      PassThroughFilter,
    );
  });
});
