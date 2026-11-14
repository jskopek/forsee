import type { Rect, TargetDescriptor } from '@forsee/plugin-api';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useMeasuredRect } from './use-measured-rect';
import { useTargetRegistrations } from './registration';
import { restDescriptor } from './rest-zone';

/** Props of `AppFrame`. */
export interface AppFrameProps {
  /** Top region: the composition bar. */
  readonly composition?: ReactNode;
  /** Under it: the prediction strip. */
  readonly predictions?: ReactNode;
  /** The rest of the height: the keyboard (always at least 60% of the frame). */
  readonly keyboard?: ReactNode;
  /** A slim bar of actions (speak, pause, dwell speed). */
  readonly actions?: ReactNode;
  /** Where the action bar goes. Default `side` (right). */
  readonly actionsPosition?: 'side' | 'bottom';
  /** Rendered above everything (the pause overlay, dialogs). */
  readonly overlay?: ReactNode;
  /**
   * Width of the rest-zone margin around the frame's content, CSS pixels.
   * Gaze there selects nothing. Default 12; 0 disables.
   */
  readonly restMarginPx?: number;
  readonly className?: string;
}

/** The four margin strips between `outer` and `inner`, as rest-zone descriptors. */
export function marginRestZones(outer: Rect, inner: Rect, idPrefix = 'frame'): TargetDescriptor[] {
  const top = inner.y - outer.y;
  const left = inner.x - outer.x;
  const right = outer.x + outer.width - (inner.x + inner.width);
  const bottom = outer.y + outer.height - (inner.y + inner.height);
  const zones: [string, Rect][] = [
    ['top', { x: outer.x, y: outer.y, width: outer.width, height: top }],
    ['bottom', { x: outer.x, y: inner.y + inner.height, width: outer.width, height: bottom }],
    ['left', { x: outer.x, y: inner.y, width: left, height: inner.height }],
    ['right', { x: inner.x + inner.width, y: inner.y, width: right, height: inner.height }],
  ];
  return zones
    .filter(([, rect]) => rect.width > 0 && rect.height > 0)
    .map(([side, rect]) => restDescriptor(`${idPrefix}/margin-${side}`, rect));
}

const SIDE_GRID: CSSProperties = {
  gridTemplateAreas: '"composition actions" "predictions actions" "keyboard actions"',
  gridTemplateColumns: 'minmax(0, 1fr) clamp(6.5rem, 11vw, 10.5rem)',
  gridTemplateRows: 'clamp(4.5rem, 15vh, 9.5rem) clamp(4rem, 13vh, 7.5rem) minmax(60%, 1fr)',
};

const BOTTOM_GRID: CSSProperties = {
  gridTemplateAreas: '"composition" "predictions" "keyboard" "actions"',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridTemplateRows:
    'clamp(4rem, 13vh, 8rem) clamp(3.5rem, 11vh, 6.5rem) minmax(60%, 1fr) clamp(3.5rem, 9vh, 5.5rem)',
};

const NO_ACTIONS_GRID: CSSProperties = {
  gridTemplateAreas: '"composition" "predictions" "keyboard"',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridTemplateRows: SIDE_GRID.gridTemplateRows,
};

/**
 * The full-screen frame with named regions: composition bar on top,
 * prediction strip under it, the keyboard filling the rest (never less than
 * 60% of the height), and a slim action bar at the side or the bottom.
 * No page scrolling; safe-area insets respected (tablets); the margin
 * around the content is a rest zone.
 */
export function AppFrame({
  composition,
  predictions,
  keyboard,
  actions,
  actionsPosition = 'side',
  overlay,
  restMarginPx = 12,
  className = '',
}: AppFrameProps): ReactNode {
  const [outer, outerRef] = useMeasuredRect();
  const [inner, innerRef] = useMeasuredRect();
  const zones = useMemo(
    () => (outer && inner && restMarginPx > 0 ? marginRestZones(outer, inner) : null),
    [outer, inner, restMarginPx],
  );
  useTargetRegistrations(zones);

  const margin = `${restMarginPx}px`;
  const padding: CSSProperties = {
    paddingTop: `calc(env(safe-area-inset-top, 0px) + ${margin})`,
    paddingRight: `calc(env(safe-area-inset-right, 0px) + ${margin})`,
    paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${margin})`,
    paddingLeft: `calc(env(safe-area-inset-left, 0px) + ${margin})`,
  };
  const hasActions = actions !== undefined && actions !== null;
  const grid = actionsPosition === 'side' ? SIDE_GRID : BOTTOM_GRID;
  const gridStyle: CSSProperties = hasActions ? grid : NO_ACTIONS_GRID;

  return (
    <div
      ref={outerRef}
      data-forsee-measure="frame"
      className={`fixed inset-0 overflow-hidden overscroll-none bg-surface font-ui text-ink ${className}`}
      style={padding}
    >
      <div
        ref={innerRef}
        data-forsee-measure="frame-inner"
        className="grid h-full w-full gap-[clamp(0.375rem,1.2vh,0.75rem)]"
        style={gridStyle}
      >
        <div
          className="min-h-0 min-w-0"
          style={{ gridArea: 'composition' }}
          data-region="composition"
        >
          {composition}
        </div>
        <div
          className="min-h-0 min-w-0"
          style={{ gridArea: 'predictions' }}
          data-region="predictions"
        >
          {predictions}
        </div>
        <main className="min-h-0 min-w-0" style={{ gridArea: 'keyboard' }} data-region="keyboard">
          {keyboard}
        </main>
        {hasActions && (
          <aside
            aria-label="Actions"
            className={`flex min-h-0 min-w-0 gap-[clamp(0.375rem,1.2vh,0.75rem)] ${
              actionsPosition === 'side' ? 'flex-col' : 'flex-row'
            }`}
            style={{ gridArea: 'actions' }}
            data-region="actions"
          >
            {actions}
          </aside>
        )}
      </div>
      {overlay}
    </div>
  );
}
