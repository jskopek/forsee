import type { Rect, TargetDescriptor } from '@forsee/plugin-api';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useMeasuredRect } from './use-measured-rect';
import { useTargetRegistrations } from './registration';
import { restDescriptor } from './rest-zone';

/** Props of `AppFrame`. */
export interface AppFrameProps {
  /**
   * A row above the composition bar (the quick-fire replies, a prompt such
   * as "turn on speech"). Absent: no row.
   */
  readonly banner?: ReactNode;
  /** Top region: the composition bar. */
  readonly composition?: ReactNode;
  /** Under it: the prediction strip. */
  readonly predictions?: ReactNode;
  /** The rest of the height: the keyboard (at least `keyboardMinPercent` of the frame). */
  readonly keyboard?: ReactNode;
  /** A slim bar of actions (speak, pause, dwell speed). */
  readonly actions?: ReactNode;
  /** Where the action bar goes. Default `side` (right); `bottom` suits portrait screens. */
  readonly actionsPosition?: 'side' | 'bottom';
  /** Smallest share of the height the keyboard gets, percent. Default 55. */
  readonly keyboardMinPercent?: number;
  /** Rendered above everything (the pause overlay, dialogs). */
  readonly overlay?: ReactNode;
  /**
   * Makes the regions inert (not focusable, not clickable) while a dialog in
   * `overlay` is open. Gaze targets are hidden from gaze separately, by the
   * overlay's occlusion.
   */
  readonly inert?: boolean;
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

/** Options of `appFrameGrid`. */
export interface AppFrameGridOptions {
  readonly actions: 'side' | 'bottom' | 'none';
  /** A banner row above the composition bar. */
  readonly banner: boolean;
  /** Smallest share of the frame's height the keyboard row may get, percent. */
  readonly keyboardMinPercent: number;
}

/**
 * The CSS grid of `AppFrame`, with the named areas `banner`, `composition`,
 * `predictions`, `keyboard` and `actions`. The fixed rows are clamped to the
 * viewport height and the keyboard row takes the rest, never less than
 * `keyboardMinPercent` of the height. A side action bar spans every row.
 */
export function appFrameGrid({
  actions,
  banner,
  keyboardMinPercent,
}: AppFrameGridOptions): CSSProperties {
  const stacked = actions === 'bottom';
  const rows: [string, string][] = [];
  if (banner) {
    rows.push(['banner', stacked ? 'clamp(3.25rem, 7vh, 5rem)' : 'clamp(3rem, 8vh, 4.5rem)']);
  }
  // With a banner, the text and prediction rows give up a little height.
  if (stacked) {
    rows.push(['composition', banner ? 'clamp(4rem, 11vh, 7rem)' : 'clamp(4rem, 13vh, 8rem)']);
    rows.push(['predictions', banner ? 'clamp(3.5rem, 9vh, 6rem)' : 'clamp(3.5rem, 11vh, 6.5rem)']);
  } else {
    rows.push([
      'composition',
      banner ? 'clamp(4rem, 13vh, 8.5rem)' : 'clamp(4.5rem, 15vh, 9.5rem)',
    ]);
    rows.push([
      'predictions',
      banner ? 'clamp(3.5rem, 11vh, 6.5rem)' : 'clamp(4rem, 13vh, 7.5rem)',
    ]);
  }
  rows.push(['keyboard', `minmax(${keyboardMinPercent}%, 1fr)`]);
  if (stacked) rows.push(['actions', 'clamp(3.5rem, 9vh, 5.5rem)']);
  const side = actions === 'side';
  return {
    gridTemplateAreas: rows.map(([area]) => (side ? `"${area} actions"` : `"${area}"`)).join(' '),
    gridTemplateColumns: side ? 'minmax(0, 1fr) clamp(6.5rem, 11vw, 10.5rem)' : 'minmax(0, 1fr)',
    gridTemplateRows: rows.map(([, size]) => size).join(' '),
  };
}

/**
 * The full-screen frame with named regions: an optional banner row, the
 * composition bar, the prediction strip under it, the keyboard filling the
 * rest (never less than `keyboardMinPercent` of the height), and a slim
 * action bar at the side or the bottom. No page scrolling; safe-area insets
 * respected (tablets); the margin around the content is a rest zone.
 */
export function AppFrame({
  banner,
  composition,
  predictions,
  keyboard,
  actions,
  actionsPosition = 'side',
  keyboardMinPercent = 55,
  overlay,
  inert = false,
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
  const hasBanner = banner !== undefined && banner !== null && banner !== false;
  const gridStyle = appFrameGrid({
    actions: hasActions ? actionsPosition : 'none',
    banner: hasBanner,
    keyboardMinPercent,
  });

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
        inert={inert}
      >
        {hasBanner && (
          <div className="min-h-0 min-w-0" style={{ gridArea: 'banner' }} data-region="banner">
            {banner}
          </div>
        )}
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
