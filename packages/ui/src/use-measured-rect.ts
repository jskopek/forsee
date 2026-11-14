import type { Rect } from '@forsee/plugin-api';
import { useState, useSyncExternalStore } from 'react';
import { MeasuredRectStore } from './dom';
import { useHostUi } from './provider';

/** A ref callback that measures its element (React 19: it returns its own cleanup). */
export type MeasureRef = (element: Element | null) => (() => void) | undefined;

/**
 * Measures an element in app viewport CSS pixels through the provider's
 * `UiDomEnvironment`, re-rendering when its rectangle changes (resize,
 * scroll). Put the returned ref callback on the element; the rectangle is
 * null until it is attached.
 */
export function useMeasuredRect(): readonly [Rect | null, MeasureRef] {
  const { dom } = useHostUi();
  const [store] = useState(() => new MeasuredRectStore(dom));
  const rect = useSyncExternalStore(store.subscribe, store.get);
  return [rect, store.attach];
}
