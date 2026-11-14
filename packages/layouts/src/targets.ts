import type { LayoutKey, Rect, TargetDescriptor } from '@forsee/plugin-api';
import type { GeometryOptions, KeyRect, LayoutView } from './contracts';
import { repeatsWhileGazed } from './dwell';
import { computeGeometry } from './geometry';
import { isGroupKey } from './keys';

/** Target id of a key: `<layoutId>/<pageId>/<keyId>`. */
export function targetId(layoutId: string, pageId: string, keyId: string): string {
  return `${layoutId}/${pageId}/${keyId}`;
}

/** The text a key types, if it is a plain character key (`composition.insert` with `{ text }`). */
export function keyText(key: LayoutKey): string | undefined {
  if (isGroupKey(key) || key.spacer === true) return undefined;
  if (key.behaviour?.type === 'escalate') return undefined;
  if (key.action.command !== 'composition.insert') return undefined;
  const text = key.action.args?.text;
  return typeof text === 'string' && text !== '' ? text : undefined;
}

/**
 * Turns placed keys into gaze targets.
 *
 * - `id`: `<layoutId>/<pageId>/<keyId>`.
 * - `dwellClass`: from the `KeyRect` (explicit class, else by command).
 * - `text`: set for character keys, so the gaze engine can build key
 *   distributions for the predictor.
 * - `afterActivate`: `repeat` for `repeat` and `escalate` keys.
 * - `label`: the key's label when it has one.
 * - **No `command`.** The keyboard view receives each `ActivateEvent` and
 *   calls `LayoutRuntime.activate(keyId, repeatIndex)`, which applies escalation,
 *   groups, page changes and `returnToPage` and returns the action to
 *   execute. A `command` here would make the gaze pipeline run the key's
 *   plain action as well and bypass all of that. Map target ids back to key
 *   ids with `keyIdOfTarget`.
 */
export function generateTargets(
  layoutId: string,
  pageId: string,
  keyRects: readonly KeyRect[],
): TargetDescriptor[] {
  return keyRects.map(({ key, rect, dwellClass }) => {
    const text = keyText(key);
    return {
      id: targetId(layoutId, pageId, key.id),
      rect,
      dwellClass,
      ...(text === undefined ? {} : { text }),
      ...(key.label === '' ? {} : { label: key.label }),
      ...(repeatsWhileGazed(key) ? { afterActivate: 'repeat' as const } : {}),
    };
  });
}

/** Recovers the key id from a target id made by `generateTargets`, or undefined for foreign ids. */
export function keyIdOfTarget(layoutId: string, pageId: string, id: string): string | undefined {
  const prefix = `${targetId(layoutId, pageId, '')}`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

/** Placed keys and gaze targets for what a runtime view shows. */
export interface ViewTargets {
  readonly keyRects: readonly KeyRect[];
  readonly targets: readonly TargetDescriptor[];
}

/**
 * Convenience for the keyboard view: geometry plus targets for the current
 * `LayoutRuntime.view`. Call again whenever the view or the bounds change and
 * re-register the targets.
 */
export function targetsForView(
  view: LayoutView,
  bounds: Rect,
  options: GeometryOptions,
): ViewTargets {
  const keyRects = computeGeometry({ id: view.pageId, rows: view.rows }, bounds, options);
  return { keyRects, targets: generateTargets(view.layoutId, view.pageId, keyRects) };
}
