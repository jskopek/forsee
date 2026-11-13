import type { GazeSample } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import type { FixationState } from './contracts';
import { IdtFixationDetector } from './fixation';
import { GazeScript } from './testing';

function run(samples: readonly GazeSample[], detector = new IdtFixationDetector()) {
  return samples.map((s) => detector.update(s));
}

function starts(states: readonly FixationState[]) {
  return states.filter((s) => s.started);
}

function ends(states: readonly FixationState[]) {
  return states.flatMap((s) => (s.ended ? [s.ended] : []));
}

describe('IdtFixationDetector', () => {
  it('starts a fixation after the minimum duration, once', () => {
    const states = run(
      new GazeScript({ seed: 1, jitterPx: 5 }).fixate({ x: 200, y: 200 }, 600).samples,
    );
    expect(starts(states)).toHaveLength(1);
    const first = states.findIndex((s) => s.fixation !== null);
    // 100 ms at 60 Hz: the window spans 100 ms on the 7th sample (index 6).
    expect(first).toBe(6);
    expect(states[first]?.started).toBe(true);
    expect(states.slice(first).every((s) => s.fixation !== null)).toBe(true);
  });

  it('reports the centroid, duration, dispersion and spread', () => {
    const states = run(
      new GazeScript({ seed: 2, jitterPx: 6 }).fixate({ x: 300, y: 150 }, 2000).samples,
    );
    const fix = states.at(-1)?.fixation;
    expect(fix).toBeTruthy();
    if (!fix) return;
    expect(fix.x).toBeCloseTo(300, 0);
    expect(fix.y).toBeCloseTo(150, 0);
    expect(fix.durationMs).toBeCloseTo(fix.t - fix.startT, 9);
    expect(fix.durationMs).toBeGreaterThan(1900);
    expect(fix.dispersionPx).toBeLessThanOrEqual(80);
    expect(fix.spreadPx).toBeGreaterThan(4.5);
    expect(fix.spreadPx).toBeLessThan(7.5);
  });

  it('ends a fixation at a saccade and starts a new one at the destination', () => {
    const states = run(
      new GazeScript({ seed: 3, jitterPx: 4 })
        .fixate({ x: 100, y: 100 }, 500)
        .saccade({ x: 500, y: 100 }, 40)
        .fixate({ x: 500, y: 100 }, 500).samples,
    );
    expect(starts(states)).toHaveLength(2);
    const ended = ends(states);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.x).toBeCloseTo(100, -1);
    expect(states.at(-1)?.fixation?.x).toBeCloseTo(500, -1);
  });

  it('survives a blink shorter than maxGapMs', () => {
    const states = run(
      new GazeScript({ seed: 4, jitterPx: 4 })
        .fixate({ x: 100, y: 100 }, 500)
        .blink(200)
        .fixate({ x: 100, y: 100 }, 500).samples,
    );
    expect(starts(states)).toHaveLength(1);
    expect(ends(states)).toHaveLength(0);
    // During the blink the open fixation is still reported.
    const blinkStates = states.slice(30, 42);
    expect(blinkStates.every((s) => s.fixation !== null)).toBe(true);
    const last = states.at(-1)?.fixation;
    expect(last?.startT).toBe(0);
    expect(last?.durationMs).toBeGreaterThan(1100);
  });

  it('ends the fixation when an invalid run exceeds maxGapMs', () => {
    const states = run(
      new GazeScript({ seed: 5 })
        .fixate({ x: 100, y: 100 }, 500)
        .blink(600)
        .fixate({ x: 100, y: 100 }, 500).samples,
    );
    expect(ends(states)).toHaveLength(1);
    expect(starts(states)).toHaveLength(2);
    expect(states.at(-1)?.fixation?.startT).toBeGreaterThan(1000);
  });

  it('ends the fixation after a gap without samples longer than maxGapMs', () => {
    const states = run(
      new GazeScript({ seed: 6 })
        .fixate({ x: 10, y: 10 }, 300)
        .gap(400)
        .fixate({ x: 10, y: 10 }, 300).samples,
    );
    expect(ends(states)).toHaveLength(1);
    expect(starts(states)).toHaveLength(2);
  });

  it('reports no fixation during a saccade or a slow sweep', () => {
    const states = run(new GazeScript({ seed: 7 }).saccade({ x: 1000, y: 0 }, 1000).samples);
    expect(states.every((s) => s.fixation === null)).toBe(true);
  });

  it('reset() forgets everything', () => {
    const detector = new IdtFixationDetector();
    run(new GazeScript().fixate({ x: 1, y: 1 }, 500).samples, detector);
    detector.reset();
    expect(detector.update({ x: 1, y: 1, t: 1000, confidence: 1, valid: true })).toEqual({
      fixation: null,
      started: false,
    });
  });

  it('honours its configuration', () => {
    const detector = new IdtFixationDetector({ dispersionPx: 10, minDurationMs: 0, maxGapMs: 50 });
    const first = detector.update({ x: 0, y: 0, t: 0, confidence: 1, valid: true });
    expect(first.started).toBe(true);
    const jump = detector.update({ x: 20, y: 0, t: 16, confidence: 1, valid: true });
    expect(jump.ended).toBeDefined();
    expect(jump.started).toBe(true);
  });
});
