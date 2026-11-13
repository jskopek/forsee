import type {
  DwellClass,
  KeyAction,
  LayoutActionKey,
  LayoutGroupKey,
  LayoutKey,
} from '@forsee/plugin-api';
import { isGroupKey, isSpacer } from './keys';

/** Commands whose effect is hard to notice or undo; their keys default to `destructive`. */
export const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'composition.clear',
  'composition.deleteWord',
]);

/** Default dwell class for an action: letters, destructive commands, everything else. */
export function defaultDwellClassForAction(action: KeyAction): DwellClass {
  if (action.command === 'composition.insert') return 'letter';
  if (DESTRUCTIVE_COMMANDS.has(action.command)) return 'destructive';
  return 'function';
}

/** The action a key stands for at repeat index 0 (an escalating key's first step). */
function firstAction(key: LayoutActionKey): KeyAction {
  const behaviour = key.behaviour;
  if (behaviour?.type === 'escalate') return behaviour.steps[0] ?? key.action;
  return key.action;
}

function resolveGroupDwellClass(key: LayoutGroupKey): DwellClass {
  return key.keys.every((k) => resolveKeyDwellClass(k) === 'letter') ? 'letter' : 'function';
}

/**
 * The dwell class of a key. Explicit `dwellClass` wins; otherwise the default
 * for its (first) action. A group key is `letter` when every key in it types
 * text, else `function`. Spacers have no class (`function`, unused).
 */
export function resolveKeyDwellClass(key: LayoutKey): DwellClass {
  if (isSpacer(key)) return 'function';
  if (isGroupKey(key)) return resolveGroupDwellClass(key);
  return key.dwellClass ?? defaultDwellClassForAction(firstAction(key));
}

/** Index of the escalation step for a repeat index, clamped to the last step. */
export function escalationStep(stepCount: number, repeatIndex: number): number {
  const index = Number.isFinite(repeatIndex) ? Math.max(0, Math.floor(repeatIndex)) : 0;
  return Math.min(index, Math.max(0, stepCount - 1));
}

/** The action fired by `key` at `repeatIndex` (escalation applied). */
export function actionForRepeat(key: LayoutActionKey, repeatIndex: number): KeyAction {
  const behaviour = key.behaviour;
  if (behaviour?.type === 'escalate' && behaviour.steps.length > 0) {
    return behaviour.steps[escalationStep(behaviour.steps.length, repeatIndex)] ?? key.action;
  }
  return key.action;
}

/** Dwell class for an activation at `repeatIndex`, honouring `stepDwellClasses`. */
export function dwellClassForRepeat(key: LayoutKey, repeatIndex: number): DwellClass {
  const own = resolveKeyDwellClass(key);
  if (isSpacer(key) || isGroupKey(key)) return own;
  const behaviour = key.behaviour;
  if (behaviour?.type === 'escalate') {
    const step = escalationStep(behaviour.steps.length, repeatIndex);
    return behaviour.stepDwellClasses?.[step] ?? own;
  }
  return own;
}

/** Repeat interval requested by a `repeat` key, if any (the gaze engine otherwise uses the user's setting). */
export function keyRepeatIntervalMs(key: LayoutKey): number | undefined {
  if (isSpacer(key) || isGroupKey(key)) return undefined;
  const behaviour = key.behaviour;
  return behaviour?.type === 'repeat' ? behaviour.intervalMs : undefined;
}

/** True when the gaze engine should keep firing the key while gaze stays (`repeat` and `escalate`). */
export function repeatsWhileGazed(key: LayoutKey): boolean {
  if (isSpacer(key) || isGroupKey(key)) return false;
  const type = key.behaviour?.type;
  return type === 'repeat' || type === 'escalate';
}
