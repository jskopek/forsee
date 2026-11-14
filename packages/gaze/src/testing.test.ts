import { describe, expect, it, vi } from 'vitest';
import { GazeScript, ManualGazeSource, SeededRandom } from './testing';

describe('SeededRandom', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new SeededRandom(5);
    const b = new SeededRandom(5);
    const c = new SeededRandom(6);
    const seqA = Array.from({ length: 10 }, () => a.next());
    expect(Array.from({ length: 10 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 10 }, () => c.next())).not.toEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('gives roughly standard normal deviates', () => {
    const rng = new SeededRandom(1);
    const values = Array.from({ length: 20000 }, () => rng.gaussian());
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.sqrt(variance)).toBeCloseTo(1, 1);
  });
});

describe('GazeScript', () => {
  it('produces samples at the given rate, continuing in time', () => {
    const script = new GazeScript({ rateHz: 50, startT: 1000 })
      .fixate({ x: 1, y: 2 }, 100)
      .saccade({ x: 101, y: 2 }, 40)
      .blink(60)
      .gap(100)
      .press();
    const ts = script.samples.map((s) => s.t);
    expect(ts).toEqual([1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140, 1160, 1180, 1300]);
    expect(script.samples[6]).toMatchObject({ x: 101, y: 2, valid: true });
    expect(script.samples.slice(7, 10).every((s) => !s.valid)).toBe(true);
    expect(script.samples[10]).toMatchObject({ x: 101, y: 2, press: true });
  });

  it('adds seeded Gaussian jitter around the fixation point', () => {
    const one = new GazeScript({ seed: 3, jitterPx: 10 }).fixate({ x: 0, y: 0 }, 5000).samples;
    const two = new GazeScript({ seed: 3, jitterPx: 10 }).fixate({ x: 0, y: 0 }, 5000).samples;
    expect(two).toEqual(one);
    const rms = Math.sqrt(one.reduce((s, p) => s + p.x * p.x, 0) / one.length);
    expect(rms).toBeGreaterThan(8);
    expect(rms).toBeLessThan(12);
  });

  it('drifts linearly', () => {
    const samples = new GazeScript().fixate({ x: 0, y: 0 }, 0).drift({ x: 60, y: 0 }, 1000).samples;
    expect(samples).toHaveLength(60);
    expect(samples[29]?.x).toBeCloseTo(30, 9);
    expect(samples.at(-1)?.x).toBe(60);
  });
});

describe('ManualGazeSource', () => {
  it('delivers samples only while started, and stops on a fatal error', () => {
    const source = new ManualGazeSource('m', 'pointer');
    expect(source.kind).toBe('pointer');
    const onSample = vi.fn();
    const onError = vi.fn();
    source.emit({ x: 0, y: 0, t: 0, confidence: 1, valid: true });
    source.start(onSample, onError);
    expect(() => source.start(onSample, onError)).toThrow();
    source.emit({ x: 0, y: 0, t: 0, confidence: 1, valid: true });
    expect(onSample).toHaveBeenCalledTimes(1);
    source.fail({ code: 'internal', message: 'x', recoverable: false });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(source.running).toBe(false);
    source.emit({ x: 0, y: 0, t: 1, confidence: 1, valid: true });
    expect(onSample).toHaveBeenCalledTimes(1);
  });
});
