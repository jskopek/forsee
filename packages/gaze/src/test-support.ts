import type { GazeSample, Point, Rect, TargetDescriptor } from '@forsee/plugin-api';
import type { HitTestConfig } from './config';
import type { HitTestResult, SelectionEvent, SelectionMethod, TargetRegistry } from './contracts';
import { IdtFixationDetector } from './fixation';
import { createTargetRegistry, type GazeTargetRegistry } from './targets';

/**
 * Shared fixtures for this package's tests (not exported from the package).
 *
 * The fixture keyboard: a composition bar rest zone across the top, one row
 * of letter keys `a`..`e` (60 x 60 px, 8 px gaps), a repeating delete key, a
 * disabled key, and a wake target in the bottom-right corner.
 *
 *   y 0-80     rest zone "bar"
 *   y 100-160  a b c d e  [del]  [off]
 *   y 400-500                        [wake]
 */
export const KEY = 60;
export const GAP = 8;
export const ROW_Y = 100;

export function keyRect(index: number): Rect {
  return { x: 100 + index * (KEY + GAP), y: ROW_Y, width: KEY, height: KEY };
}

export function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export const LETTERS = ['a', 'b', 'c', 'd', 'e'] as const;

export function letterTarget(letter: string, index: number): TargetDescriptor {
  return {
    id: `keyboard/key-${letter}`,
    rect: keyRect(index),
    dwellClass: 'letter',
    text: letter,
    label: letter,
    command: { command: 'composition.insert', args: { text: letter } },
  };
}

export const DELETE_ID = 'keyboard/delete';
export const DISABLED_ID = 'keyboard/off';
export const WAKE_ID = 'app/wake';
export const BAR_ID = 'app/bar';

export function fixtureTargets(): TargetDescriptor[] {
  return [
    {
      id: BAR_ID,
      rect: { x: 0, y: 0, width: 1000, height: 80 },
      dwellClass: 'function',
      role: 'rest',
    },
    ...LETTERS.map((l, i) => letterTarget(l, i)),
    {
      id: DELETE_ID,
      rect: keyRect(5),
      dwellClass: 'destructive',
      afterActivate: 'repeat',
      command: { command: 'composition.deleteGrapheme' },
    },
    { id: DISABLED_ID, rect: keyRect(6), dwellClass: 'function', disabled: true },
    {
      id: WAKE_ID,
      rect: { x: 800, y: 400, width: 100, height: 100 },
      dwellClass: 'function',
      role: 'wake',
      command: { command: 'gaze.resume' },
    },
  ];
}

export function fixtureRegistry(config: Partial<HitTestConfig> = {}): GazeTargetRegistry {
  const registry = createTargetRegistry({ config });
  registry.registerAll(fixtureTargets());
  return registry;
}

export function letterCentre(letter: string): Point {
  const index = LETTERS.indexOf(letter as (typeof LETTERS)[number]);
  return centreOf(keyRect(index));
}

/**
 * Feeds samples straight into a selection method (no filter), hit-testing
 * each valid sample with hysteresis against the previous hit, as the
 * pipeline does. Returns the events, in order.
 */
export function feed(
  method: SelectionMethod,
  registry: TargetRegistry,
  samples: readonly GazeSample[],
  events: SelectionEvent[] = [],
): SelectionEvent[] {
  const sub = method.onEvent((e) => events.push(e));
  const fixation = new IdtFixationDetector();
  let current: string | null = null;
  for (const sample of samples) {
    const state = fixation.update(sample);
    const hit: HitTestResult = sample.valid
      ? registry.hitTest(sample, sample.press === true ? null : current)
      : { target: null, inRestZone: false, distribution: { entries: [] } };
    if (sample.valid) current = hit.target?.id ?? null;
    method.process({ type: 'sample', sample, fixation: state, hit });
  }
  sub.dispose();
  return events;
}

export function activations(events: readonly SelectionEvent[]) {
  return events.filter((e) => e.type === 'activate');
}

export function progressOf(events: readonly SelectionEvent[], targetId: string) {
  return events.filter((e) => e.type === 'progress' && e.targetId === targetId);
}
