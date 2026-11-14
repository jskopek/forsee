import type { LayoutKey, LayoutRow, Rect } from '@forsee/plugin-api';
import type { EdgeSides, GeometryOptions, KeyRect, LayoutGeometry } from './contracts';
import { resolveKeyDwellClass } from './dwell';
import { isSpacer } from './keys';

/**
 * Geometry: turns rows of weighted keys into rectangles.
 *
 * Model
 * - Rows share the bounds' height by their `height` weight (default 1); keys
 *   share their row's width by `width` weight (default 1). Spacers take space
 *   like keys but produce no `KeyRect`.
 * - `gapPx` (rounded to a whole number of CSS pixels, minimum 0) separates
 *   neighbouring rows and keys. There is no gap against the bounds.
 *
 * Edge enlargement (plan P1: targets are bigger at screen edges and corners)
 * - With `edgeGrowthPx` = g > 0, every key that touches a screen edge of the
 *   bounds gets g more pixels in the direction towards the middle: keys in the
 *   first and last row grow taller, the first and last key of each row grow
 *   wider (a corner key does both). The room comes from the inner rows and
 *   keys, shrunk in proportion to their weights.
 * - Spacers never grow, a row's outermost key only counts as an edge key when
 *   it is not a spacer, and inner items never shrink below half their share,
 *   so the growth is capped at what that allows. Growth is therefore
 *   monotonic in g: edge keys never get smaller, inner keys never get bigger.
 * - `edges` says which sides of the bounds are screen edges (default all);
 *   a keyboard docked at the bottom would pass `{ top: false }`.
 *
 * Rounding
 * - Sizes are computed in continuous coordinates, then every key edge is
 *   snapped: the *end* of each item is rounded to a whole CSS pixel, and the
 *   next item starts exactly `gap` after it. The first item starts at the
 *   bounds' own edge and the last ends exactly on the bounds' far edge (so
 *   bounds with fractional coordinates stay exact at the outside only).
 *   Consequently rectangles never overlap, the gaps between neighbours equal
 *   `gapPx`, and with spacers included the items plus gaps sum exactly to the
 *   bounds. A rounded size is at most one pixel off its ideal size.
 * - Deterministic: same input, same output; no state.
 */

/** A placed row entry, including spacers. */
export interface KeySlot {
  readonly key: LayoutKey;
  readonly rect: Rect;
  readonly rowIndex: number;
  readonly columnIndex: number;
}

const ALL_EDGES: EdgeSides = { top: true, right: true, bottom: true, left: true };

/** Largest share of an inner item's ideal size that edge growth may take away. */
const MAX_SHRINK = 0.5;

/**
 * Splits `total` pixels over items with `weights`, growing items flagged in
 * `growFirst`/`growLast`. Returns continuous sizes that sum to `total - gaps`.
 */
function splitSizes(
  weights: readonly number[],
  total: number,
  gap: number,
  growth: number,
  growable: readonly boolean[],
  growFirst: boolean,
  growLast: boolean,
): number[] {
  const n = weights.length;
  const available = Math.max(0, total - gap * (n - 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const base = weights.map((w) => (available * w) / weightSum);
  if (growth <= 0 || n < 3) return base;

  const edge = new Set<number>();
  if (growFirst && growable[0] === true) edge.add(0);
  if (growLast && growable[n - 1] === true) edge.add(n - 1);
  if (edge.size === 0) return base;

  let innerBase = 0;
  for (let i = 0; i < n; i++) if (!edge.has(i)) innerBase += base[i] ?? 0;
  const wanted = growth * edge.size;
  const taken = Math.min(wanted, innerBase * MAX_SHRINK);
  const perEdge = taken / edge.size;
  return base.map((size, i) =>
    edge.has(i) ? size + perEdge : size - (taken * size) / (innerBase || 1),
  );
}

/** Converts continuous sizes to snapped `[start, end]` pairs along one axis. */
function snap(
  origin: number,
  total: number,
  gap: number,
  sizes: readonly number[],
): [number, number][] {
  const result: [number, number][] = [];
  let cursor = origin;
  let ideal = origin;
  const last = sizes.length - 1;
  sizes.forEach((size, i) => {
    ideal += size;
    const start = cursor;
    let end = i === last ? origin + total : Math.round(ideal);
    if (end < start) end = start;
    result.push([start, end]);
    cursor = end + gap;
    ideal += gap;
  });
  return result;
}

/**
 * Places every row entry, spacers included. Use `computeGeometry` for the
 * target rectangles only.
 */
export function computeSlots(
  rows: readonly LayoutRow[],
  bounds: Rect,
  options: GeometryOptions,
): KeySlot[] {
  if (rows.length === 0) return [];
  const gap = Math.max(0, Math.round(options.gapPx));
  const growth = Math.max(0, options.edgeGrowthPx);
  const edges: EdgeSides = { ...ALL_EDGES, ...options.edges };

  const rowSizes = splitSizes(
    rows.map((r) => r.height ?? 1),
    bounds.height,
    gap,
    growth,
    rows.map(() => true),
    edges.top,
    edges.bottom,
  );
  const rowSpans = snap(bounds.y, bounds.height, gap, rowSizes);

  const slots: KeySlot[] = [];
  rows.forEach((row, r) => {
    const span = rowSpans[r];
    if (!span || row.keys.length === 0) return;
    const keys = row.keys;
    const sizes = splitSizes(
      keys.map((k) => k.width ?? 1),
      bounds.width,
      gap,
      growth,
      keys.map((k) => !isSpacer(k)),
      edges.left,
      edges.right,
    );
    const spans = snap(bounds.x, bounds.width, gap, sizes);
    keys.forEach((key, c) => {
      const xs = spans[c];
      if (!xs) return;
      slots.push({
        key,
        rowIndex: r,
        columnIndex: c,
        rect: { x: xs[0], y: span[0], width: xs[1] - xs[0], height: span[1] - span[0] },
      });
    });
  });
  return slots;
}

/** `LayoutGeometry` implementation: key rectangles for a page (or any rows). Spacers are skipped. */
export const computeGeometry: LayoutGeometry = (page, bounds, options): readonly KeyRect[] => {
  const result: KeyRect[] = [];
  for (const slot of computeSlots(page.rows, bounds, options)) {
    const key = slot.key;
    if (isSpacer(key)) continue;
    result.push({ key, rect: slot.rect, dwellClass: resolveKeyDwellClass(key) });
  }
  return result;
};
