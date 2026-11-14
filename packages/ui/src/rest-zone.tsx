import type { Rect, TargetDescriptor } from '@forsee/plugin-api';
import { useMemo } from 'react';
import { useTargetRegistrations } from './registration';
import { useMeasuredRect, type MeasureRef } from './use-measured-rect';

/** A rest-zone descriptor: gaze here never fires anything and resets dwell. */
export function restDescriptor(id: string, rect: Rect): TargetDescriptor {
  return { id, rect, dwellClass: 'function', role: 'rest', label: 'Rest' };
}

/**
 * Registers the measured element as a `rest` target while mounted. Returns
 * its measured rectangle and the ref callback to put on the element.
 */
export function useRestZone(id: string): readonly [Rect | null, MeasureRef] {
  const [rect, measureRef] = useMeasuredRect();
  const descriptors = useMemo(() => (rect ? [restDescriptor(id, rect)] : null), [id, rect]);
  useTargetRegistrations(descriptors);
  return [rect, measureRef];
}
