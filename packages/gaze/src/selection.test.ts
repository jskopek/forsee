import { isForseeError } from '@forsee/core';
import type { ActivateEvent, ProgressEvent } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DWELL_CONFIG, DEFAULT_SELECTION_TUNING, likelihoodFactor } from './config';
import type { DwellConfig, SelectionEvent } from './contracts';
import {
  DirectSelection,
  DwellSelection,
  SwitchSelection,
  createSelectionMethod,
  effectiveDwellMs,
} from './selection';
import { createTargetRegistry } from './targets';
import {
  BAR_ID,
  DELETE_ID,
  DISABLED_ID,
  WAKE_ID,
  activations,
  centreOf,
  feed,
  fixtureRegistry,
  keyRect,
  letterCentre,
  letterTarget,
  progressOf,
} from './test-support';
import { GazeScript } from './testing';

const FRAME = 1000 / 60;
const A = 'keyboard/key-a';
const NOWHERE = { x: 400, y: 600 };
const BAR = { x: 500, y: 40 };
const WAKE = { x: 850, y: 450 };

/** Dwell config without adaptive scaling, so times are exact class times. */
const PLAIN: DwellConfig = {
  ...DEFAULT_DWELL_CONFIG,
  adaptive: { ...DEFAULT_DWELL_CONFIG.adaptive, enabled: false },
};

function dwellMethod(dwell: DwellConfig = PLAIN) {
  return new DwellSelection({ dwell });
}

function acts(events: readonly SelectionEvent[]): ActivateEvent[] {
  return activations(events);
}

function expectNear(actual: number | undefined, expected: number, tolerance = FRAME + 1e-6) {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThanOrEqual(tolerance);
}

describe('dwell: basic firing', () => {
  it('fires at the class time ± one sample', () => {
    const registry = fixtureRegistry();
    for (const [dwellClass, ms] of Object.entries(PLAIN.classMs)) {
      const reg = createTargetRegistry();
      reg.register({
        ...letterTarget('a', 0),
        dwellClass: dwellClass as keyof DwellConfig['classMs'],
      });
      const events = feed(
        dwellMethod(),
        reg,
        new GazeScript().fixate(letterCentre('a'), ms + 200).samples,
      );
      const fired = acts(events);
      expect(fired).toHaveLength(1);
      expectNear(fired[0]?.t, ms);
    }
    // And with jitter (seeded) inside the key.
    const jittery = feed(
      dwellMethod(),
      registry,
      new GazeScript({ seed: 11, jitterPx: 6 }).fixate(letterCentre('a'), 1000).samples,
    );
    expectNear(acts(jittery)[0]?.t, 800);
  });

  it('reports target, method, repeat index, point and distribution', () => {
    const events = feed(
      dwellMethod(),
      fixtureRegistry(),
      new GazeScript().fixate(letterCentre('b'), 900).samples,
    );
    const [event] = acts(events);
    expect(event).toMatchObject({
      type: 'activate',
      targetId: 'keyboard/key-b',
      method: 'dwell',
      repeatIndex: 0,
      point: letterCentre('b'),
    });
    expect(event?.distribution.entries[0]?.targetId).toBe('keyboard/key-b');
  });

  it('emits rising progress, at most one event per target per sample, then 0 after firing', () => {
    const events = feed(
      dwellMethod(),
      fixtureRegistry(),
      new GazeScript().fixate(letterCentre('a'), 900).samples,
    );
    const progress = progressOf(events, A) as ProgressEvent[];
    const perT = new Map<number, number>();
    for (const p of progress) perT.set(p.t, (perT.get(p.t) ?? 0) + 1);
    expect([...perT.values()].every((n) => n === 1)).toBe(true);
    const fireIndex = events.findIndex((e) => e.type === 'activate');
    const before = progressOf(events.slice(0, fireIndex), A) as ProgressEvent[];
    for (let i = 1; i < before.length; i++) {
      expect(before[i]?.progress ?? 0).toBeGreaterThan(before[i - 1]?.progress ?? 0);
    }
    expect(before.every((p) => p.dwellMs === 800)).toBe(true);
    expect(events[fireIndex + 1]).toMatchObject({ type: 'progress', targetId: A, progress: 0 });
  });

  it('never fires from invalid samples', () => {
    const script = new GazeScript().fixate(letterCentre('a'), 1);
    script.samples.length = 0;
    script.blink(5000);
    const events = feed(dwellMethod(), fixtureRegistry(), script.samples);
    expect(events).toEqual([]);
  });

  it('never fires disabled targets or rest zones', () => {
    const off = centreOf(keyRect(6));
    const events = feed(
      dwellMethod(),
      fixtureRegistry(),
      new GazeScript().fixate(off, 5000).fixate(BAR, 5000).samples,
    );
    expect(events).toEqual([]);
    expect(DISABLED_ID).toBe('keyboard/off');
  });
});

describe('dwell: decay', () => {
  // decayPerSecond 2: progress drains completely in 500 ms.

  it('resumes from the decayed progress after a brief look away', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400) // progress 0.5
      .fixate(NOWHERE, 100) // decays by 0.2 to 0.3
      .fixate(letterCentre('a'), 1000).samples; // needs 0.7 x 800 = 560 ms
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    const fired = acts(events);
    expect(fired).toHaveLength(1);
    expectNear(fired[0]?.t, 400 + 100 + 560, 2 * FRAME);
  });

  it('starts over after looking away for longer than the decay window', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400)
      .fixate(NOWHERE, 600)
      .fixate(letterCentre('a'), 1000).samples;
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    // The decay reached 0 while away, and that was announced.
    const zero = (progressOf(events, A) as ProgressEvent[]).find((p) => p.progress === 0);
    expect(zero?.t).toBeGreaterThan(400);
    expect(zero?.t).toBeLessThan(1000);
    expectNear(acts(events)[0]?.t, 1000 + 800);
  });

  it('decays the previous target while dwelling on a new one', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400)
      .fixate(letterCentre('c'), 300).samples;
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    const lastA = (progressOf(events, A) as ProgressEvent[]).at(-1);
    expect(lastA?.progress).toBe(0);
    const lastC = (progressOf(events, 'keyboard/key-c') as ProgressEvent[]).at(-1);
    expect(lastC?.progress).toBeGreaterThan(0.3);
  });

  it('holds progress through a blink instead of decaying', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400)
      .blink(200)
      .fixate(letterCentre('a'), 1000).samples;
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    // 800 ms of looking plus the 200 ms blink, give or take a sample at either end.
    expectNear(acts(events)[0]?.t, 1000, 2 * FRAME);
  });

  it('decays during an invalid run longer than holdMs', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400)
      .blink(1000)
      .fixate(letterCentre('a'), 1000).samples;
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    expectNear(acts(events)[0]?.t, 1400 + 800);
  });
});

describe('dwell: adaptive (likelihood) scaling', () => {
  function fireTime(likelihood: number | undefined, dwell: DwellConfig = DEFAULT_DWELL_CONFIG) {
    const registry = createTargetRegistry();
    registry.register({
      ...letterTarget('a', 0),
      ...(likelihood === undefined ? {} : { likelihood }),
    });
    const events = feed(
      new DwellSelection({ dwell }),
      registry,
      new GazeScript().fixate(letterCentre('a'), 2000).samples,
    );
    return acts(events)[0]?.t;
  }

  it('leaves targets without a likelihood at the class time', () => {
    expectNear(fireTime(undefined), 800);
    expectNear(fireTime(0.05), 800); // the neutral likelihood
  });

  it('speeds up likely keys, but never below minFactor', () => {
    expectNear(fireTime(0.2), 800 * likelihoodFactor(0.2, DEFAULT_DWELL_CONFIG.adaptive));
    expect(likelihoodFactor(0.2, DEFAULT_DWELL_CONFIG.adaptive)).toBeLessThan(1);
    expectNear(fireTime(1), 800 * 0.6);
  });

  it('slows unlikely keys, but never beyond maxFactor (they stay reachable)', () => {
    expectNear(fireTime(0), 800 * 1.5);
    expectNear(fireTime(0.000001), 800 * 1.5);
  });

  it('can be switched off', () => {
    expectNear(fireTime(1, PLAIN), 800);
    expectNear(fireTime(0, PLAIN), 800);
  });

  it('honours custom bounds', () => {
    const dwell = {
      ...DEFAULT_DWELL_CONFIG,
      adaptive: { enabled: true, minFactor: 0.9, maxFactor: 1.1 },
    };
    expectNear(fireTime(1, dwell), 720);
    expectNear(fireTime(0, dwell), 880);
  });

  it('reports the effective dwell time in progress events', () => {
    const target = { ...letterTarget('a', 0), likelihood: 1 };
    expect(effectiveDwellMs(target, DEFAULT_DWELL_CONFIG)).toBeCloseTo(480, 9);
    const registry = createTargetRegistry();
    registry.register(target);
    const events = feed(
      new DwellSelection(),
      registry,
      new GazeScript().fixate(letterCentre('a'), 200).samples,
    );
    expect((progressOf(events, A)[0] as ProgressEvent).dwellMs).toBeCloseTo(480, 9);
  });
});

describe('dwell: after activation', () => {
  it('look-away targets fire once while gaze stays, and again after looking away', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 3000)
      .fixate(NOWHERE, 50)
      .fixate(letterCentre('a'), 1000).samples;
    const fired = acts(feed(dwellMethod(), fixtureRegistry(), samples));
    expect(fired.map((e) => e.repeatIndex)).toEqual([0, 0]);
    expectNear(fired[1]?.t, 3050 + 800);
  });

  it('look-away also clears after moving to a neighbour', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 900)
      .fixate(letterCentre('b'), 900)
      .fixate(letterCentre('a'), 900).samples;
    const fired = acts(feed(dwellMethod(), fixtureRegistry(), samples));
    expect(fired.map((e) => e.targetId)).toEqual([A, 'keyboard/key-b', A]);
  });

  it('repeat targets fire again every repeat interval with repeatIndex 0, 1, 2', () => {
    const del = centreOf(keyRect(5));
    const samples = new GazeScript().fixate(del, 1500 + 2 * 1200 + 100).samples;
    const fired = acts(feed(dwellMethod(), fixtureRegistry(), samples));
    expect(fired.map((e) => [e.targetId, e.repeatIndex])).toEqual([
      [DELETE_ID, 0],
      [DELETE_ID, 1],
      [DELETE_ID, 2],
    ]);
    expectNear(fired[0]?.t, 1500);
    expectNear(fired[1]?.t, 2700, 2 * FRAME);
    expectNear(fired[2]?.t, 3900, 3 * FRAME);
  });

  it('repeat progress is measured against the repeat interval', () => {
    const del = centreOf(keyRect(5));
    const events = feed(
      dwellMethod(),
      fixtureRegistry(),
      new GazeScript().fixate(del, 2000).samples,
    );
    const afterFirst = (progressOf(events, DELETE_ID) as ProgressEvent[]).filter((p) => p.t > 1520);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.every((p) => p.dwellMs === 1200)).toBe(true);
  });

  it('looking away ends the repeat chain', () => {
    const del = centreOf(keyRect(5));
    const samples = new GazeScript()
      .fixate(del, 2800)
      .fixate(NOWHERE, 600)
      .fixate(del, 1600).samples;
    const fired = acts(feed(dwellMethod(), fixtureRegistry(), samples));
    expect(fired.map((e) => e.repeatIndex)).toEqual([0, 1, 0]);
  });
});

describe('dwell: rest zones', () => {
  it('resets all progress, announcing 0', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 400)
      .fixate(BAR, 50)
      .fixate(letterCentre('a'), 1000).samples;
    const events = feed(dwellMethod(), fixtureRegistry(), samples);
    const zero = (progressOf(events, A) as ProgressEvent[]).find((p) => p.progress === 0);
    expectNear(zero?.t, 400, FRAME);
    expectNear(acts(events)[0]?.t, 450 + 800);
  });

  it('never fires and ends a repeat chain', () => {
    const del = centreOf(keyRect(5));
    const samples = new GazeScript().fixate(del, 1600).fixate(BAR, 3000).fixate(del, 1600).samples;
    const fired = acts(feed(dwellMethod(), fixtureRegistry(), samples));
    expect(fired.map((e) => e.repeatIndex)).toEqual([0, 0]);
    expect(BAR_ID).toBe('app/bar');
  });
});

describe('dwell: pause and wake', () => {
  it('while paused only wake targets fire, after the long wake dwell', () => {
    const method = dwellMethod();
    method.setPaused(true);
    const samples = new GazeScript().fixate(letterCentre('a'), 3000).fixate(WAKE, 2500).samples;
    const fired = acts(feed(method, fixtureRegistry(), samples));
    expect(fired.map((e) => e.targetId)).toEqual([WAKE_ID]);
    expectNear(fired[0]?.t, 3000 + PLAIN.wakeMs);
  });

  it('wake targets do nothing while not paused', () => {
    const fired = acts(
      feed(dwellMethod(), fixtureRegistry(), new GazeScript().fixate(WAKE, 5000).samples),
    );
    expect(fired).toEqual([]);
  });

  it('pausing clears progress, announcing 0', () => {
    const method = dwellMethod();
    const events = feed(
      method,
      fixtureRegistry(),
      new GazeScript().fixate(letterCentre('a'), 400).samples,
    );
    const sub = method.onEvent((e) => events.push(e));
    method.setPaused(true);
    sub.dispose();
    expect(events.at(-1)).toMatchObject({ type: 'progress', targetId: A, progress: 0 });
    expect(method.progressOf(A)).toBe(0);
  });
});

describe('dwell: ticks', () => {
  it('fills progress between samples of a slow source', () => {
    const method = dwellMethod();
    const registry = fixtureRegistry();
    const events: SelectionEvent[] = [];
    const samples = new GazeScript({ rateHz: 10 }).fixate(letterCentre('a'), 1000).samples;
    method.onEvent((e) => events.push(e));
    for (const sample of samples) {
      method.process({
        type: 'sample',
        sample,
        fixation: { fixation: null, started: false },
        hit: registry.hitTest(sample, A),
      });
      for (let k = 1; k < 6; k++) method.process({ type: 'tick', t: sample.t + k * FRAME });
    }
    const progress = progressOf(events, A);
    // Six progress events per 100 ms sample interval rather than one.
    expect(progress.filter((p) => p.t < 500).length).toBeGreaterThan(20);
    expectNear(acts(events)[0]?.t, 800);
  });

  it('does not keep dwelling on a stalled source', () => {
    const method = dwellMethod();
    const registry = fixtureRegistry();
    const events: SelectionEvent[] = [];
    method.onEvent((e) => events.push(e));
    const sample = { ...letterCentre('a'), t: 0, confidence: 1, valid: true };
    method.process({
      type: 'sample',
      sample,
      fixation: { fixation: null, started: false },
      hit: registry.hitTest(sample, null),
    });
    let peak = 0;
    for (let t = FRAME; t < 3000; t += FRAME) {
      method.process({ type: 'tick', t });
      peak = Math.max(peak, method.progressOf(A));
    }
    // extrapolateMs 100 of 800 ms, then held, then decayed away.
    expect(peak).toBeCloseTo(100 / 800, 2);
    expect(method.progressOf(A)).toBe(0);
    expect(acts(events)).toEqual([]);
  });
});

describe('dwell: housekeeping', () => {
  it('reset clears progress and announces 0', () => {
    const method = dwellMethod();
    const events = feed(
      method,
      fixtureRegistry(),
      new GazeScript().fixate(letterCentre('a'), 300).samples,
    );
    method.onEvent((e) => events.push(e));
    method.reset();
    expect(events.at(-1)).toMatchObject({ type: 'progress', targetId: A, progress: 0 });
  });

  it('a listener that pauses during an activation sees consistent state', () => {
    const method = dwellMethod();
    method.onEvent((e) => {
      if (e.type === 'activate') method.setPaused(true);
    });
    const events = feed(
      method,
      fixtureRegistry(),
      new GazeScript().fixate(letterCentre('a'), 2000).samples,
    );
    expect(acts(events)).toHaveLength(1);
  });

  it('does nothing after dispose', () => {
    const method = dwellMethod();
    const events: SelectionEvent[] = [];
    method.onEvent((e) => events.push(e));
    method.dispose();
    feed(method, fixtureRegistry(), new GazeScript().fixate(letterCentre('a'), 2000).samples);
    expect(events).toEqual([]);
  });

  it('is deterministic', () => {
    const script = () =>
      new GazeScript({ seed: 99, jitterPx: 10 })
        .fixate(letterCentre('a'), 700)
        .saccade(letterCentre('c'))
        .fixate(letterCentre('c'), 300)
        .blink(120)
        .fixate(letterCentre('c'), 900)
        .drift(letterCentre('d'), 800)
        .fixate(centreOf(keyRect(5)), 4000).samples;
    const one = feed(new DwellSelection(), fixtureRegistry(), script());
    const two = feed(new DwellSelection(), fixtureRegistry(), script());
    expect(one.length).toBeGreaterThan(50);
    expect(two).toEqual(one);
  });
});

describe('direct method', () => {
  it('fires on press samples only, with a certain distribution', () => {
    const samples = new GazeScript()
      .fixate(letterCentre('a'), 3000)
      .press(letterCentre('b')).samples;
    const fired = acts(feed(new DirectSelection(), fixtureRegistry(), samples));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      targetId: 'keyboard/key-b',
      method: 'direct',
      repeatIndex: 0,
      distribution: { entries: [{ targetId: 'keyboard/key-b', text: 'b', probability: 1 }] },
    });
  });

  it('ignores presses in rest zones, on nothing and on disabled targets', () => {
    const samples = new GazeScript()
      .press(BAR)
      .press(NOWHERE)
      .press(centreOf(keyRect(6))).samples;
    expect(feed(new DirectSelection(), fixtureRegistry(), samples)).toEqual([]);
  });

  it('while paused only wake targets fire', () => {
    const method = new DirectSelection();
    method.setPaused(true);
    const samples = new GazeScript().press(letterCentre('a')).press(WAKE).samples;
    expect(acts(feed(method, fixtureRegistry(), samples)).map((e) => e.targetId)).toEqual([
      WAKE_ID,
    ]);
  });

  it('ignores invalid press samples', () => {
    const sample = { ...letterCentre('a'), t: 0, confidence: 0, valid: false, press: true };
    expect(feed(new DirectSelection(), fixtureRegistry(), [sample])).toEqual([]);
  });
});

describe('switch method', () => {
  function setup() {
    const method = new SwitchSelection();
    const registry = fixtureRegistry();
    const events: SelectionEvent[] = [];
    method.onEvent((e) => events.push(e));
    const look = (point: { x: number; y: number }, ms = 300) =>
      feed(method, registry, new GazeScript({ startT: lastT }).fixate(point, ms).samples);
    let lastT = 0;
    const press = (pressed: boolean) => {
      lastT += 10;
      method.process({ type: 'switch', t: lastT, pressed });
    };
    return { method, events, look, press };
  }

  it('gaze highlights, the switch confirms; no dwell', () => {
    const { method, events, look, press } = setup();
    look(letterCentre('c'), 5000);
    expect(acts(events)).toEqual([]);
    expect(method.highlightedId).toBe('keyboard/key-c');
    press(true);
    const [event] = acts(events);
    expect(event).toMatchObject({ targetId: 'keyboard/key-c', method: 'switch', repeatIndex: 0 });
    expect(event?.distribution.entries[0]?.targetId).toBe('keyboard/key-c');
  });

  it('fires once per press, not while held', () => {
    const { events, look, press } = setup();
    look(letterCentre('a'));
    press(true);
    press(true);
    press(true);
    expect(acts(events)).toHaveLength(1);
    press(false);
    press(true);
    expect(acts(events)).toHaveLength(2);
  });

  it('a rest zone or empty space clears the highlight; blinks keep it', () => {
    const { method, events, look, press } = setup();
    look(letterCentre('a'));
    look(BAR);
    expect(method.highlightedId).toBeNull();
    press(true);
    press(false);
    look(letterCentre('a'));
    feed(method, fixtureRegistry(), new GazeScript({ startT: 5000 }).blink(500).samples);
    expect(method.highlightedId).toBe(A);
    look(NOWHERE);
    press(true);
    expect(acts(events)).toEqual([]);
  });

  it('a press sample also confirms', () => {
    const { events } = setup();
    const method = new SwitchSelection();
    const fired = acts(
      feed(
        method,
        fixtureRegistry(),
        new GazeScript().fixate(letterCentre('d'), 100).press().samples,
        events,
      ),
    );
    expect(fired.map((e) => e.targetId)).toEqual(['keyboard/key-d']);
  });

  it('while paused only wake targets fire', () => {
    const { method, events, look, press } = setup();
    method.setPaused(true);
    look(letterCentre('a'));
    press(true);
    press(false);
    look(WAKE);
    press(true);
    expect(acts(events).map((e) => e.targetId)).toEqual([WAKE_ID]);
  });
});

describe('createSelectionMethod', () => {
  it('creates each implemented method', () => {
    expect(createSelectionMethod('dwell').id).toBe('dwell');
    expect(createSelectionMethod('direct').id).toBe('direct');
    expect(createSelectionMethod('switch').id).toBe('switch');
  });

  it('reserves swipe', () => {
    try {
      createSelectionMethod('swipe');
      expect.unreachable();
    } catch (error) {
      expect(isForseeError(error, 'unavailable')).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ review round 1, defect A

/** One step of a hand-written stream: a valid sample at `at`, or an invalid one when `at` is null. */
interface Step {
  readonly t: number;
  readonly at: { x: number; y: number } | null;
}

/** Valid samples on `at` every `everyMs` from `from` to `to` inclusive (a slow source). */
function every(at: { x: number; y: number }, from: number, to: number, everyMs = 200): Step[] {
  const steps: Step[] = [];
  for (let t = from; t <= to; t += everyMs) steps.push({ t, at });
  return steps;
}

/**
 * Plays `steps` into `method` as the pipeline would, with frame ticks every
 * `tickMs` between samples and after the last one until `ticksUntil`.
 * Hit tests use hysteresis against the previous hit. Returns the events and
 * the sample times.
 */
function drive(
  method: DwellSelection | DirectSelection | SwitchSelection,
  steps: readonly Step[],
  options: { tickMs?: number; ticksUntil?: number } = {},
) {
  const registry = fixtureRegistry();
  const tickMs = options.tickMs ?? FRAME;
  const events: SelectionEvent[] = [];
  const sub = method.onEvent((e) => events.push(e));
  const sampleTimes = new Set<number>();
  let current: string | null = null;
  let prev: number | null = null;
  const tickTo = (end: number) => {
    if (prev === null || tickMs <= 0) return;
    for (let t = prev + tickMs; t < end - 1e-9; t += tickMs) method.process({ type: 'tick', t });
  };
  for (const step of steps) {
    tickTo(step.t);
    prev = step.t;
    sampleTimes.add(step.t);
    if (step.at === null) {
      method.process({
        type: 'sample',
        sample: { x: 0, y: 0, t: step.t, confidence: 0, valid: false },
        fixation: { fixation: null, started: false },
        hit: { target: null, inRestZone: false, distribution: { entries: [] } },
      });
      continue;
    }
    const sample = { ...step.at, t: step.t, confidence: 1, valid: true };
    const hit = registry.hitTest(sample, current);
    current = hit.target?.id ?? null;
    method.process({ type: 'sample', sample, fixation: { fixation: null, started: false }, hit });
  }
  if (options.ticksUntil !== undefined) tickTo(options.ticksUntil);
  sub.dispose();
  return { events, sampleTimes };
}

const B = 'keyboard/key-b';

function progressValues(events: readonly SelectionEvent[], targetId: string): ProgressEvent[] {
  return progressOf(events, targetId) as ProgressEvent[];
}

describe('dwell: only observed dwell counts (slow sources)', () => {
  it('a 5 Hz source that stays on a key still fires at the configured time', () => {
    const { events } = drive(dwellMethod(), every(letterCentre('a'), 0, 1000));
    expect(acts(events).map((e) => [e.targetId, e.t])).toEqual([[A, 800]]);
  });

  it('reviewer reproduction: key at 0-600 ms, rest zone at 800 ms does not fire the key', () => {
    const method = dwellMethod();
    const { events } = drive(method, [
      ...every(letterCentre('a'), 0, 600),
      ...every(BAR, 800, 1400),
    ]);
    expect(acts(events)).toEqual([]);
    // The rest-zone sample announced 0 for the key and gave it no credit for the gap.
    const a = progressValues(events, A);
    expect(a.filter((p) => p.t >= 800).map((p) => p.progress)).toEqual([0]);
    expect(a.find((p) => p.t === 800)?.progress).toBe(0);
    expect(method.progressOf(A)).toBe(0);
  });

  it('the same reproduction without ticks does not fire either', () => {
    const { events } = drive(
      dwellMethod(),
      [...every(letterCentre('a'), 0, 600), ...every(BAR, 800, 1400)],
      { tickMs: 0 },
    );
    expect(acts(events)).toEqual([]);
  });

  it('key A to key B just before A would fire: A does not fire, B starts at the B sample', () => {
    const { events } = drive(dwellMethod(), [
      ...every(letterCentre('a'), 0, 600),
      ...every(letterCentre('b'), 800, 2000),
    ]);
    expect(acts(events).map((e) => [e.targetId, e.t])).toEqual([[B, 1600]]);
    // No progress for B before (or at) its first sample.
    expect(progressValues(events, B).filter((p) => p.t <= 800 && p.progress > 0)).toEqual([]);
    // A gained nothing after its last confirmed sample (600 of 800 ms).
    const aAfter = progressValues(events, A).filter((p) => p.t >= 800);
    expect(aAfter.every((p) => p.progress <= 0.75)).toBe(true);
    expect(aAfter.at(-1)?.progress).toBe(0);
  });

  it('key to empty space just before the threshold: no activation, the key decays', () => {
    const method = dwellMethod();
    const { events } = drive(method, [
      ...every(letterCentre('a'), 0, 600),
      ...every(NOWHERE, 800, 2000),
    ]);
    expect(acts(events)).toEqual([]);
    const aAfter = progressValues(events, A).filter((p) => p.t >= 800);
    expect(aAfter.every((p) => p.progress <= 0.75)).toBe(true);
    expect(method.progressOf(A)).toBe(0);
  });

  it('key to a disabled key just before the threshold: no activation', () => {
    const { events } = drive(dwellMethod(), [
      ...every(letterCentre('a'), 0, 600),
      ...every(centreOf(keyRect(6)), 800, 2000),
    ]);
    expect(acts(events)).toEqual([]);
  });

  it('while paused, a wake target left for a letter just before wakeMs does not wake', () => {
    const method = dwellMethod();
    method.setPaused(true);
    const { events } = drive(method, [
      ...every(WAKE, 0, PLAIN.wakeMs - 200),
      ...every(letterCentre('a'), PLAIN.wakeMs, PLAIN.wakeMs + 2000),
    ]);
    expect(acts(events)).toEqual([]);
  });

  it('an invalid sample breaks the chain: the time around it is not dwell', () => {
    const { events } = drive(dwellMethod(), [
      ...every(letterCentre('a'), 0, 400), // 400 ms confirmed
      { t: 500, at: null },
      ...every(letterCentre('a'), 600, 1400), // credit restarts at 600: 400 more by 1000
    ]);
    expect(acts(events).map((e) => e.t)).toEqual([1000]);
  });

  it('a gap longer than holdMs on the same key is not dwell', () => {
    const { events } = drive(
      dwellMethod(),
      [0, 400, 800, 1200, 1600, 2000].map((t) => ({ t, at: letterCentre('a') })),
      { tickMs: 0 },
    );
    expect(acts(events)).toEqual([]);
  });
});

describe('dwell: ticks never fire', () => {
  /** Letter dwell 650 ms, so the extrapolated fill crosses the threshold between 600 and 700 ms. */
  const SHORT: DwellConfig = { ...PLAIN, classMs: { ...PLAIN.classMs, letter: 650 } };

  it('a stalled source never fires from the provisional fill, even past the threshold', () => {
    const method = dwellMethod(SHORT);
    const { events } = drive(method, every(letterCentre('a'), 0, 600), { ticksUntil: 3000 });
    expect(acts(events)).toEqual([]);
    // The fill is shown (display only), then held and decayed away.
    expect(Math.max(...progressValues(events, A).map((p) => p.progress))).toBe(1);
    expect(method.progressOf(A)).toBe(0);
  });

  it('a threshold crossed during extrapolation fires only if the next sample confirms', () => {
    const left = drive(dwellMethod(SHORT), [
      ...every(letterCentre('a'), 0, 600),
      { t: 800, at: BAR },
    ]);
    expect(acts(left.events)).toEqual([]);

    const stayed = drive(dwellMethod(SHORT), every(letterCentre('a'), 0, 800));
    expect(acts(stayed.events).map((e) => e.t)).toEqual([800]);
  });

  it('every activation happens on a sample on the fired target, for fast sources too', () => {
    const samples = new GazeScript({ seed: 5, jitterPx: 4 })
      .fixate(letterCentre('a'), 1000)
      .fixate(letterCentre('c'), 1000).samples;
    const steps = samples.map((s) => ({ t: s.t, at: { x: s.x, y: s.y } }));
    const { events, sampleTimes } = drive(dwellMethod(), steps, { tickMs: FRAME / 3 });
    const fired = acts(events);
    expect(fired.map((e) => e.targetId)).toEqual([A, 'keyboard/key-c']);
    for (const e of fired) expect(sampleTimes.has(e.t)).toBe(true);
    // Fast sources still fire on time (within one sample of the class time).
    expectNear(fired[0]?.t, 800);
    expectNear(fired[1]?.t, 1000 + 800, 2 * FRAME);
  });

  it('at most extrapolateMs of unconfirmed fill is ever shown', () => {
    const { events } = drive(dwellMethod(), every(letterCentre('a'), 0, 400), {
      ticksUntil: 2000,
    });
    const peak = Math.max(...progressValues(events, A).map((p) => p.progress));
    expect(peak).toBeCloseTo((400 + DEFAULT_SELECTION_TUNING.extrapolateMs) / 800, 9);
  });
});

describe('dwell: repeat targets and unobserved time', () => {
  const DEL = centreOf(keyRect(5));

  it('control: staying on a repeat key at 5 Hz repeats on schedule', () => {
    const { events } = drive(dwellMethod(), every(DEL, 0, 2800));
    // 1500 ms destructive dwell (first sample at or after it: 1600), then 1200 ms repeat.
    expect(acts(events).map((e) => [e.repeatIndex, e.t])).toEqual([
      [0, 1600],
      [1, 2800],
    ]);
  });

  it('leaving just before the repeat would fire does not repeat', () => {
    const toKey = drive(dwellMethod(), [
      ...every(DEL, 0, 2600),
      ...every(letterCentre('a'), 2800, 3000),
    ]);
    expect(acts(toKey.events).map((e) => [e.targetId, e.repeatIndex])).toEqual([[DELETE_ID, 0]]);

    const toRest = drive(dwellMethod(), [...every(DEL, 0, 2600), ...every(BAR, 2800, 3000)]);
    expect(acts(toRest.events).map((e) => [e.targetId, e.repeatIndex])).toEqual([[DELETE_ID, 0]]);
  });
});

describe('direct and switch methods: unaffected by the dwell rule', () => {
  it('direct fires only on the press, whatever was looked at before, and ignores ticks', () => {
    const method = new DirectSelection();
    const { events } = drive(method, every(letterCentre('a'), 0, 1600));
    expect(events).toEqual([]);
    const pressed: SelectionEvent[] = [];
    method.onEvent((e) => pressed.push(e));
    method.process({
      type: 'sample',
      sample: { ...letterCentre('b'), t: 1700, confidence: 1, valid: true, press: true },
      fixation: { fixation: null, started: false },
      hit: fixtureRegistry().hitTest(letterCentre('b'), null),
    });
    expect(acts(pressed).map((e) => [e.targetId, e.t])).toEqual([[B, 1700]]);
  });

  it('switch confirms the latest highlight; a slow move to a rest zone clears it', () => {
    const method = new SwitchSelection();
    drive(method, [...every(letterCentre('a'), 0, 600), { t: 800, at: BAR }]);
    expect(method.highlightedId).toBeNull();
    const events: SelectionEvent[] = [];
    method.onEvent((e) => events.push(e));
    method.process({ type: 'switch', t: 900, pressed: true });
    expect(events).toEqual([]);
    method.process({ type: 'switch', t: 950, pressed: false });
    drive(method, every(letterCentre('a'), 1000, 1000));
    method.process({ type: 'switch', t: 1100, pressed: true });
    expect(acts(events).map((e) => e.targetId)).toEqual([A]);
  });
});
