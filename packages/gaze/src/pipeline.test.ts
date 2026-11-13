import { FakeClock, SequentialIdSource, createKernel, isForseeError } from '@forsee/core';
import type { ActivateEvent, GazeSample, KeyDistribution, Point } from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DWELL_CONFIG, type GazeEngineConfigPatch } from './config';
import type { CalibrationModel, EngageEvent, GazePipeline, SelectionEvent } from './contracts';
import { createGazePipeline } from './pipeline';
import { createTargetRegistry } from './targets';
import {
  DELETE_ID,
  WAKE_ID,
  centreOf,
  fixtureRegistry,
  keyRect,
  letterCentre,
} from './test-support';
import { GazeScript, ManualGazeSource } from './testing';

const FRAME = 1000 / 60;
const A = 'keyboard/key-a';
const NOWHERE = { x: 400, y: 600 };
const WAKE = { x: 850, y: 450 };
const PLAIN = {
  ...DEFAULT_DWELL_CONFIG,
  adaptive: { ...DEFAULT_DWELL_CONFIG.adaptive, enabled: false },
};

type Exec = (command: string, args: unknown, source: string) => Promise<unknown>;

function setup(
  options: {
    engine?: GazeEngineConfigPatch;
    method?: 'dwell' | 'direct' | 'switch';
    execute?: Exec;
    kind?: 'pointer' | 'gaze';
  } = {},
) {
  const clock = new FakeClock();
  const targets = fixtureRegistry();
  const execute = vi.fn<Exec>(options.execute ?? (() => Promise.resolve(true)));
  const reportError = vi.fn();
  const pipeline = createGazePipeline({
    clock,
    targets,
    dwell: PLAIN,
    executeCommand: execute,
    reportError,
    engine: { tickIntervalMs: 0, ...options.engine },
    ...(options.method ? { method: options.method } : {}),
  });
  const source = new ManualGazeSource('test', options.kind ?? 'gaze');
  pipeline.setSource(source);
  const selection: SelectionEvent[] = [];
  const activated: ActivateEvent[] = [];
  const samples: GazeSample[] = [];
  const engaged: EngageEvent[] = [];
  pipeline.onSelection((e) => selection.push(e));
  pipeline.onActivate((e) => activated.push(e));
  pipeline.onSample((s) => samples.push(s));
  pipeline.onEngage((e) => engaged.push(e));
  /** Advances the fake clock to each sample's time, then delivers it (ticks fire in between). */
  const play = (list: readonly GazeSample[]) => {
    for (const s of list) {
      if (s.t > clock.now()) clock.advance(s.t - clock.now());
      source.emit(s);
    }
  };
  return {
    clock,
    targets,
    execute,
    reportError,
    pipeline,
    source,
    selection,
    activated,
    samples,
    engaged,
    play,
  };
}

/** Lets pending promise callbacks (command completion) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const activations = (events: readonly SelectionEvent[]) =>
  events.filter((e): e is ActivateEvent => e.type === 'activate');

describe('gaze pipeline: dwell end to end', () => {
  it('fires the target command through the executor with source "gaze"', async () => {
    const t = setup();
    t.play(new GazeScript({ seed: 1, jitterPx: 4 }).fixate(letterCentre('a'), 1000).samples);
    const fired = activations(t.selection);
    expect(fired).toHaveLength(1);
    expect(Math.abs((fired[0]?.t ?? 0) - 800)).toBeLessThanOrEqual(FRAME + 1e-6);
    expect(t.execute).toHaveBeenCalledTimes(1);
    const [command, args, source] = t.execute.mock.calls[0] ?? [];
    expect(command).toBe('composition.insert');
    expect(source).toBe('gaze');
    expect(args).toMatchObject({ text: 'a' });
    await flush();
    expect(t.activated.map((e) => e.targetId)).toEqual([A]);
  });

  it('attaches the selection distribution to composition.insert', () => {
    const t = setup();
    t.play(new GazeScript({ seed: 2, jitterPx: 6 }).fixate(letterCentre('a'), 1000).samples);
    const args = t.execute.mock.calls[0]?.[1] as { text: string; distribution: KeyDistribution };
    const sum = args.distribution.entries.reduce((s, e) => s + e.probability, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(args.distribution.entries[0]).toMatchObject({ targetId: A, text: 'a' });
    expect(args.distribution).toEqual(activations(t.selection)[0]?.distribution);
  });

  it('can leave composition.insert args alone', () => {
    const clock = new FakeClock();
    const execute = vi.fn<Exec>(() => Promise.resolve());
    const pipeline = createGazePipeline({
      clock,
      targets: fixtureRegistry(),
      dwell: PLAIN,
      executeCommand: execute,
      attachDistribution: false,
      engine: { tickIntervalMs: 0 },
    });
    const source = new ManualGazeSource();
    pipeline.setSource(source);
    source.emit(...new GazeScript().fixate(letterCentre('a'), 1000).samples);
    expect(execute.mock.calls[0]?.[1]).toEqual({ text: 'a' });
  });

  it('builds the distribution from the fixation centroid and spread', () => {
    const t = setup();
    // Looking at the right edge of "a", near "b", with jitter.
    const point: Point = { x: keyRect(0).x + 56, y: letterCentre('a').y };
    t.play(new GazeScript({ seed: 3, jitterPx: 8 }).fixate(point, 1200).samples);
    const [event] = activations(t.selection);
    expect(event?.targetId).toBe(A);
    const entries = event?.distribution.entries ?? [];
    expect(entries[0]?.targetId).toBe(A);
    expect(entries[1]?.targetId).toBe('keyboard/key-b');
    expect(entries[1]?.probability).toBeGreaterThan(0.1);
  });

  it('runs repeat targets with increasing repeatIndex', () => {
    const t = setup();
    t.play(new GazeScript().fixate(centreOf(keyRect(5)), 4000).samples);
    expect(activations(t.selection).map((e) => [e.targetId, e.repeatIndex])).toEqual([
      [DELETE_ID, 0],
      [DELETE_ID, 1],
      [DELETE_ID, 2],
    ]);
    expect(t.execute.mock.calls.map((c) => c[0])).toEqual([
      'composition.deleteGrapheme',
      'composition.deleteGrapheme',
      'composition.deleteGrapheme',
    ]);
  });

  it('reports failed commands and still notifies onActivate', async () => {
    const t = setup({ execute: () => Promise.reject(new Error('boom')) });
    t.play(new GazeScript().fixate(letterCentre('a'), 1000).samples);
    await flush();
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'gaze.command:composition.insert',
    );
    expect(t.activated).toHaveLength(1);
  });

  it('reports synchronous executor throws the same way', async () => {
    const t = setup({
      execute: () => {
        throw new Error('sync boom');
      },
    });
    t.play(new GazeScript().fixate(letterCentre('a'), 1000).samples);
    await flush();
    expect(t.reportError).toHaveBeenCalledTimes(1);
    expect(t.activated).toHaveLength(1);
  });

  it('never activates from invalid or non-finite samples', () => {
    const t = setup();
    const c = letterCentre('a');
    const bad: GazeSample[] = [];
    for (let i = 0; i < 300; i++) {
      bad.push({ ...c, t: i * FRAME, confidence: 0, valid: false });
      bad.push({ x: NaN, y: c.y, t: i * FRAME + 1, confidence: 1, valid: true });
    }
    t.play(bad);
    expect(t.selection).toEqual([]);
    expect(t.execute).not.toHaveBeenCalled();
    expect(t.samples.every((s) => !s.valid)).toBe(true);
  });
});

describe('gaze pipeline: stages', () => {
  it('filters gaze sources and passes pointer sources through', () => {
    const script = new GazeScript({ seed: 4, jitterPx: 20 }).fixate(
      { x: 300, y: 300 },
      500,
    ).samples;
    const gaze = setup();
    gaze.play(script);
    const pointer = setup({ kind: 'pointer' });
    pointer.play(script);
    expect(pointer.samples).toEqual(script);
    expect(gaze.samples.slice(1)).not.toEqual(script.slice(1));
    const spread = (list: readonly GazeSample[]) =>
      Math.max(...list.map((s) => s.x)) - Math.min(...list.map((s) => s.x));
    expect(spread(gaze.samples.slice(10))).toBeLessThan(spread(script.slice(10)) / 2);
  });

  it('applies the calibration correction before filtering', () => {
    const t = setup({ kind: 'pointer' });
    const shift: CalibrationModel = {
      apply: (p) => ({ x: p.x + 1000, y: p.y }),
      fit: () => ({
        ok: true,
        accuracyPx: 0,
        precisionPx: 0,
        recommendedFamily: 'precise',
        summary: '',
      }),
      serialise: () => null,
      load: () => true,
    };
    t.pipeline.setCalibration(shift);
    t.play([{ x: 1, y: 2, t: 0, confidence: 1, valid: true }]);
    expect(t.samples[0]).toMatchObject({ x: 1001, y: 2 });
    t.pipeline.setCalibration(null);
    t.play([{ x: 1, y: 2, t: 10, confidence: 1, valid: true }]);
    expect(t.samples[1]).toMatchObject({ x: 1, y: 2 });
  });

  it('reports engagement changes, including rest zones', () => {
    const t = setup({ kind: 'pointer' });
    t.play(
      new GazeScript()
        .fixate(letterCentre('a'), 100)
        .fixate({ x: 500, y: 40 }, 100)
        .fixate(NOWHERE, 100).samples,
    );
    expect(t.engaged.map((e) => [e.targetId, e.inRestZone])).toEqual([
      [A, false],
      [null, true],
      [null, false],
    ]);
  });

  it('uses hysteresis against the previously engaged target', () => {
    const t = setup({ kind: 'pointer' });
    const bLeft = keyRect(1).x;
    const y = letterCentre('a').y;
    // Settle on a, then jitter just across the edge into b.
    const list: GazeSample[] = [];
    let time = 0;
    for (let i = 0; i < 20; i++)
      list.push({ x: letterCentre('a').x, y, t: (time += FRAME), confidence: 1, valid: true });
    for (let i = 0; i < 30; i++) {
      list.push({
        x: i % 2 === 0 ? bLeft - 6 : bLeft + 3,
        y,
        t: (time += FRAME),
        confidence: 1,
        valid: true,
      });
    }
    t.play(list);
    expect(t.engaged.map((e) => e.targetId)).toEqual([A]);
  });

  it('advances dwell between samples with clock ticks', () => {
    const t = setup({ engine: { tickIntervalMs: FRAME } });
    const samples = new GazeScript({ rateHz: 5 }).fixate(letterCentre('a'), 1200).samples;
    t.play(samples);
    const progress = t.selection.filter((e) => e.type === 'progress' && e.t < 790);
    // 5 Hz source, but the fill moves every frame.
    expect(progress.length).toBeGreaterThan(20);
    const fired = activations(t.selection);
    expect(fired).toHaveLength(1);
    expect(Math.abs((fired[0]?.t ?? 0) - 800)).toBeLessThanOrEqual(FRAME + 1e-6);
  });

  it('is deterministic: the same input gives the same events', () => {
    const run = () => {
      const t = setup({ engine: { tickIntervalMs: FRAME } });
      t.play(
        new GazeScript({ seed: 42, jitterPx: 12, rateHz: 30 })
          .fixate(letterCentre('a'), 900)
          .saccade(letterCentre('d'))
          .fixate(letterCentre('d'), 400)
          .blink(150)
          .fixate(letterCentre('d'), 700)
          .drift(centreOf(keyRect(5)), 500)
          .fixate(centreOf(keyRect(5)), 3000).samples,
      );
      return { selection: t.selection, calls: t.execute.mock.calls, engaged: t.engaged };
    };
    const one = run();
    expect(activations(one.selection).length).toBeGreaterThan(2);
    expect(run()).toEqual(one);
  });
});

describe('gaze pipeline: layout changes', () => {
  it('drops progress when the engaged target is removed, so it cannot fire', () => {
    const t = setup({ engine: { tickIntervalMs: FRAME } });
    const handle = t.targets.register({
      id: 'panel/go',
      rect: { x: 100, y: 700, width: 100, height: 100 },
      dwellClass: 'letter',
      command: { command: 'panel.go' },
    });
    const at = { x: 150, y: 750 };
    t.play(new GazeScript().fixate(at, 780).samples);
    handle.dispose();
    expect(t.selection.at(-1)).toMatchObject({ targetId: 'panel/go', progress: 0 });
    expect(t.engaged.at(-1)?.targetId).toBeNull();
    t.clock.advance(200);
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('keeps progress when other targets change (likelihood updates)', () => {
    const t = setup();
    t.play(new GazeScript().fixate(letterCentre('a'), 400).samples);
    const before = t.selection.length;
    t.targets.batch(() => {
      t.targets.register({
        id: 'x/new',
        rect: { x: 0, y: 900, width: 10, height: 10 },
        dwellClass: 'letter',
      });
    });
    expect(t.selection.length).toBe(before);
    t.play(new GazeScript({ startT: 400 }).fixate(letterCentre('a'), 500).samples);
    expect(Math.abs((activations(t.selection)[0]?.t ?? 0) - 800)).toBeLessThanOrEqual(FRAME + 1e-6);
  });
});

describe('gaze pipeline: methods', () => {
  it('direct: a press fires immediately with a certain distribution', () => {
    const t = setup({ method: 'direct', kind: 'pointer' });
    t.play(new GazeScript().fixate(letterCentre('a'), 3000).press(letterCentre('c')).samples);
    expect(t.execute).toHaveBeenCalledTimes(1);
    expect(t.execute.mock.calls[0]?.[1]).toEqual({
      text: 'c',
      distribution: { entries: [{ targetId: 'keyboard/key-c', text: 'c', probability: 1 }] },
    });
  });

  it('direct: a press is not pulled to the previously engaged target by hysteresis', () => {
    const t = setup({ method: 'direct', kind: 'pointer' });
    const bLeft = keyRect(1).x;
    t.play(
      new GazeScript()
        .fixate(letterCentre('a'), 200)
        .press({ x: bLeft + 2, y: letterCentre('a').y }).samples,
    );
    expect(activations(t.selection)[0]?.targetId).toBe('keyboard/key-b');
  });

  it('switch: gaze highlights and switchInput confirms', () => {
    const t = setup({ method: 'switch' });
    t.play(new GazeScript().fixate(letterCentre('e'), 3000).samples);
    expect(t.execute).not.toHaveBeenCalled();
    t.pipeline.switchInput(true);
    t.pipeline.switchInput(false);
    expect(activations(t.selection).map((e) => e.targetId)).toEqual(['keyboard/key-e']);
  });

  it('switches methods at run time and clears progress', () => {
    const t = setup();
    t.play(new GazeScript().fixate(letterCentre('a'), 400).samples);
    t.pipeline.setSelectionMethod('direct');
    expect(t.pipeline.selectionMethod).toBe('direct');
    expect(t.selection.at(-1)).toMatchObject({ type: 'progress', targetId: A, progress: 0 });
    t.play(new GazeScript({ startT: 400 }).fixate(letterCentre('a'), 2000).samples);
    expect(t.execute).not.toHaveBeenCalled();
  });

  it('rejects the unimplemented swipe method', () => {
    const t = setup();
    expect(() => t.pipeline.setSelectionMethod('swipe')).toThrow();
    expect(t.pipeline.selectionMethod).toBe('dwell');
  });
});

describe('gaze pipeline: pause and wake', () => {
  it('pause stops selection until the wake target fires its command', () => {
    const t = setup();
    t.pipeline.pause();
    expect(t.pipeline.paused).toBe(true);
    t.play(new GazeScript().fixate(letterCentre('a'), 3000).samples);
    expect(t.execute).not.toHaveBeenCalled();
    t.play(new GazeScript({ startT: 3000 }).fixate(WAKE, 2500).samples);
    // The pipeline does not resume behind the kernel's back: the command does it.
    expect(t.execute).toHaveBeenCalledWith('gaze.resume', undefined, 'gaze');
    expect(t.pipeline.paused).toBe(true);
  });

  it('a wake target without a command resumes the pipeline itself', () => {
    const clock = new FakeClock();
    const targets = createTargetRegistry();
    targets.register({
      id: WAKE_ID,
      rect: { x: 800, y: 400, width: 100, height: 100 },
      dwellClass: 'function',
      role: 'wake',
    });
    const execute = vi.fn<Exec>(() => Promise.resolve());
    const pipeline = createGazePipeline({
      clock,
      targets,
      dwell: PLAIN,
      executeCommand: execute,
      engine: { tickIntervalMs: 0 },
    });
    const source = new ManualGazeSource();
    pipeline.setSource(source);
    pipeline.pause();
    source.emit(...new GazeScript().fixate(WAKE, 1900).samples);
    expect(pipeline.paused).toBe(true);
    source.emit(...new GazeScript({ startT: 1900 }).fixate(WAKE, 200).samples);
    expect(pipeline.paused).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('works with the real kernel: gaze.pause and wake via gaze.resume', async () => {
    const clock = new FakeClock();
    const targets = fixtureRegistry();
    // The pipeline needs the kernel's execute and the kernel needs the
    // pipeline: the executor closes over a binding initialised just below.
    const pipeline: GazePipeline = createGazePipeline({
      clock,
      targets,
      dwell: PLAIN,
      executeCommand: (command, args, source) =>
        kernel.commands.execute(command, args as never, source),
      engine: { tickIntervalMs: 0 },
    });
    const kernel = createKernel({
      clock,
      ids: new SequentialIdSource(),
      deviceId: 'dev1',
      gaze: pipeline,
    });
    await kernel.start();
    const pauseEvents: boolean[] = [];
    kernel.bus.on('gaze.pauseChanged', (e) => pauseEvents.push(e.paused));
    const source = new ManualGazeSource();
    pipeline.setSource(source);

    source.emit(...new GazeScript().fixate(letterCentre('a'), 1000).samples);
    expect(kernel.composition.state.text).toBe('a');
    expect(kernel.composition.state.partialWordSteps[0]?.distribution?.entries[0]?.targetId).toBe(
      A,
    );

    await kernel.commands.execute('gaze.pause');
    expect(pipeline.paused).toBe(true);
    source.emit(...new GazeScript({ startT: 1000 }).fixate(letterCentre('b'), 3000).samples);
    expect(kernel.composition.state.text).toBe('a');

    source.emit(...new GazeScript({ startT: 4000 }).fixate(WAKE, 2100).samples);
    expect(pipeline.paused).toBe(false);
    expect(pauseEvents).toEqual([true, false]);

    source.emit(...new GazeScript({ startT: 6100 }).fixate(letterCentre('b'), 1000).samples);
    expect(kernel.composition.state.text).toBe('ab');
    kernel.dispose();
  });
});

describe('gaze pipeline: sources and lifecycle', () => {
  it('replacing the source stops the old one and ignores its samples', () => {
    const t = setup();
    const next = new ManualGazeSource('next');
    t.pipeline.setSource(next);
    expect(t.source.stops).toBe(1);
    t.source.emit(...new GazeScript().fixate(letterCentre('a'), 2000).samples);
    expect(t.samples).toEqual([]);
    next.emit({ x: 1, y: 1, t: 0, confidence: 1, valid: true });
    expect(t.samples).toHaveLength(1);
    t.pipeline.setSource(null);
    expect(next.stops).toBe(1);
  });

  it('a non-recoverable source error drops the source and is reported', () => {
    const t = setup();
    const errors: string[] = [];
    t.pipeline.onSourceError((e) => errors.push(e.code));
    t.source.fail({ code: 'disconnected', message: 'gone', recoverable: false });
    expect(errors).toEqual(['disconnected']);
    t.pipeline.setSource(null);
    // The pipeline did not call stop() on a source that stopped itself.
    expect(t.source.stops).toBe(0);
  });

  it('a recoverable error keeps the source', () => {
    const t = setup();
    t.source.fail({ code: 'disconnected', message: 'blip', recoverable: true });
    t.play(new GazeScript().fixate(letterCentre('a'), 1000).samples);
    expect(t.execute).toHaveBeenCalledTimes(1);
  });

  it('dispose stops the source and timers, and later calls are inert or throw disposed', () => {
    const t = setup({ engine: { tickIntervalMs: FRAME } });
    expect(t.clock.pendingTimers).toBe(1);
    t.pipeline.dispose();
    t.pipeline.dispose();
    expect(t.source.stops).toBe(1);
    expect(t.clock.pendingTimers).toBe(0);
    t.pipeline.pause();
    expect(t.pipeline.paused).toBe(false);
    try {
      t.pipeline.setSource(new ManualGazeSource());
      expect.unreachable();
    } catch (error) {
      expect(isForseeError(error, 'disposed')).toBe(true);
    }
  });

  it('validates configuration', () => {
    const t = setup();
    const bad = { ...PLAIN, classMs: { ...PLAIN.classMs, letter: -5 } };
    expect(() => t.pipeline.setDwellConfig(bad)).toThrow(/letter/);
    expect(() => t.pipeline.setEngineConfig({ fixation: { dispersionPx: 0 } })).toThrow();
    t.pipeline.setDwellConfig({ ...PLAIN, classMs: { ...PLAIN.classMs, letter: 400 } });
    expect(t.pipeline.dwellConfig.classMs.letter).toBe(400);
    t.play(new GazeScript().fixate(letterCentre('a'), 600).samples);
    expect(Math.abs((activations(t.selection)[0]?.t ?? 0) - 400)).toBeLessThanOrEqual(FRAME + 1e-6);
    t.pipeline.setEngineConfig({ filter: { kind: 'none' } });
    expect(t.pipeline.engineConfig.filter.kind).toBe('none');
  });
});
