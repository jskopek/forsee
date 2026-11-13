import { isForseeError } from '@forsee/core';
import type { ActivateEvent, ProgressEvent } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DWELL_CONFIG, likelihoodFactor } from './config';
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
