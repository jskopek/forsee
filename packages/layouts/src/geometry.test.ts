import type { LayoutKey, LayoutRow, Rect } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { BUILTIN_LAYOUTS } from './catalogue';
import { computeGeometry, computeSlots } from './geometry';

const key = (id: string, width?: number): LayoutKey => ({
  id,
  label: id,
  ...(width === undefined ? {} : { width }),
  action: { command: 'composition.insert', args: { text: id } },
});
const spacer = (id: string, width?: number): LayoutKey => ({
  id,
  spacer: true,
  ...(width === undefined ? {} : { width }),
});
const row = (keys: LayoutKey[], height?: number): LayoutRow => ({
  keys,
  ...(height === undefined ? {} : { height }),
});

const BOUNDS: Rect = { x: 10, y: 20, width: 1000, height: 400 };
const NO_GROWTH = { gapPx: 0, edgeGrowthPx: 0 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('computeSlots tiling', () => {
  const rows = [
    row([key('a'), key('b', 2), spacer('s', 0.5), key('c', 1.5)], 1),
    row([key('d'), key('e'), key('f')], 2),
    row([key('g', 3)], 1),
  ];

  it.each([
    { gapPx: 0, edgeGrowthPx: 0 },
    { gapPx: 6, edgeGrowthPx: 0 },
    { gapPx: 6, edgeGrowthPx: 40 },
    { gapPx: 3, edgeGrowthPx: 15 },
  ])('tiles the bounds exactly with %j', (options) => {
    for (const bounds of [BOUNDS, { x: 3.3, y: 7.7, width: 777.7, height: 333.3 }]) {
      const slots = computeSlots(rows, bounds, options);
      const gap = options.gapPx;
      const byRow = new Map<number, typeof slots>();
      for (const s of slots) byRow.set(s.rowIndex, [...(byRow.get(s.rowIndex) ?? []), s]);
      expect(byRow.size).toBe(rows.length);

      let nextY = bounds.y;
      for (const [r, rowSlots] of [...byRow.entries()].sort((x, y) => x[0] - y[0])) {
        const top = rowSlots[0]?.rect.y ?? NaN;
        expect(top).toBeCloseTo(nextY, 9);
        const height = rowSlots[0]?.rect.height ?? NaN;
        for (const s of rowSlots) {
          expect(s.rect.y).toBe(top);
          expect(s.rect.height).toBe(height);
        }
        nextY = top + height + gap;
        // The row's keys run left to right, separated by exactly `gap`.
        let x = bounds.x;
        for (const s of rowSlots) {
          expect(s.rect.x).toBeCloseTo(x, 9);
          x = s.rect.x + s.rect.width + gap;
        }
        const last = rowSlots[rowSlots.length - 1];
        expect((last?.rect.x ?? 0) + (last?.rect.width ?? 0)).toBeCloseTo(
          bounds.x + bounds.width,
          9,
        );
        expect(r).toBeLessThan(rows.length);
      }
      const bottomRow = [...byRow.get(rows.length - 1)!][0]!;
      expect(bottomRow.rect.y + bottomRow.rect.height).toBeCloseTo(bounds.y + bounds.height, 9);
    }
  });

  it('snaps interior edges to whole pixels and never overlaps', () => {
    const slots = computeSlots(
      rows,
      { x: 0, y: 0, width: 999, height: 401 },
      { gapPx: 5, edgeGrowthPx: 20 },
    );
    for (const s of slots) {
      expect(Number.isInteger(s.rect.x)).toBe(true);
      expect(Number.isInteger(s.rect.y)).toBe(true);
      expect(Number.isInteger(s.rect.width)).toBe(true);
      expect(Number.isInteger(s.rect.height)).toBe(true);
    }
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        expect(overlaps(slots[i]!.rect, slots[j]!.rect)).toBe(false);
      }
    }
  });

  it('shares width and height by weight', () => {
    const slots = computeSlots(
      [row([key('a'), key('b', 3)], 1), row([key('c')], 3)],
      { x: 0, y: 0, width: 400, height: 400 },
      NO_GROWTH,
    );
    const [a, b, c] = slots;
    expect(a?.rect.width).toBe(100);
    expect(b?.rect.width).toBe(300);
    expect(a?.rect.height).toBe(100);
    expect(c?.rect.height).toBe(300);
  });

  it('uses the gap between neighbours', () => {
    const slots = computeSlots(
      [row([key('a'), key('b')])],
      { x: 0, y: 0, width: 210, height: 50 },
      { gapPx: 10, edgeGrowthPx: 0 },
    );
    expect(slots.map((s) => [s.rect.x, s.rect.width])).toEqual([
      [0, 100],
      [110, 100],
    ]);
  });

  it('is deterministic', () => {
    const options = { gapPx: 4, edgeGrowthPx: 12 };
    expect(computeSlots(rows, BOUNDS, options)).toEqual(computeSlots(rows, BOUNDS, options));
  });

  it('returns nothing for no rows', () => {
    expect(computeSlots([], BOUNDS, NO_GROWTH)).toEqual([]);
  });
});

describe('computeGeometry', () => {
  it('leaves gaps for spacers and produces no rectangle for them', () => {
    const rects = computeGeometry(
      { id: 'p', rows: [row([key('a'), spacer('s'), key('b')])] },
      { x: 0, y: 0, width: 300, height: 100 },
      NO_GROWTH,
    );
    expect(rects.map((r) => r.key.id)).toEqual(['a', 'b']);
    expect(rects[0]?.rect).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(rects[1]?.rect).toEqual({ x: 200, y: 0, width: 100, height: 100 });
  });

  it('adds the resolved dwell class', () => {
    const rects = computeGeometry(
      {
        id: 'p',
        rows: [
          row([key('a'), { id: 'c', label: 'Clear', action: { command: 'composition.clear' } }]),
        ],
      },
      BOUNDS,
      NO_GROWTH,
    );
    expect(rects.map((r) => r.dwellClass)).toEqual(['letter', 'destructive']);
  });
});

describe('edge enlargement', () => {
  const grid = [0, 1, 2, 3].map((r) => row([0, 1, 2, 3, 4].map((c) => key(`k${r}${c}`))));
  const bounds = { x: 0, y: 0, width: 1000, height: 400 };
  const at = (growth: number, edges?: { top?: boolean; left?: boolean }) =>
    new Map(
      computeGeometry({ id: 'p', rows: grid }, bounds, {
        gapPx: 0,
        edgeGrowthPx: growth,
        ...(edges === undefined ? {} : { edges }),
      }).map((r) => [r.key.id, r.rect]),
    );

  it('makes edge and corner keys bigger and inner keys smaller, monotonically', () => {
    let previous = at(0);
    for (const growth of [10, 20, 40, 80]) {
      const now = at(growth);
      // edges: outer columns wider, outer rows taller
      expect(now.get('k11')!.width).toBeLessThanOrEqual(previous.get('k11')!.width);
      expect(now.get('k10')!.width).toBeGreaterThanOrEqual(previous.get('k10')!.width);
      expect(now.get('k14')!.width).toBeGreaterThanOrEqual(previous.get('k14')!.width);
      expect(now.get('k01')!.height).toBeGreaterThanOrEqual(previous.get('k01')!.height);
      expect(now.get('k31')!.height).toBeGreaterThanOrEqual(previous.get('k31')!.height);
      expect(now.get('k11')!.height).toBeLessThanOrEqual(previous.get('k11')!.height);
      // corner grows in both directions
      expect(now.get('k00')!.width).toBeGreaterThanOrEqual(previous.get('k00')!.width);
      expect(now.get('k00')!.height).toBeGreaterThanOrEqual(previous.get('k00')!.height);
      previous = now;
    }
    const flat = at(0);
    const grown = at(40);
    expect(grown.get('k10')!.width).toBeGreaterThan(flat.get('k10')!.width);
    expect(grown.get('k00')!.height).toBeGreaterThan(flat.get('k00')!.height);
    expect(grown.get('k22')!.width).toBeLessThan(flat.get('k22')!.width);
  });

  it('adds about the requested pixels to an edge key when there is room', () => {
    expect(at(0).get('k10')!.width).toBe(200);
    expect(at(20).get('k10')!.width).toBe(220);
    expect(at(20).get('k04')!.width).toBe(220);
  });

  it('caps the growth so inner keys keep at least half their size', () => {
    const huge = at(10_000);
    expect(huge.get('k22')!.width).toBeGreaterThanOrEqual(100 - 1);
    expect(huge.get('k22')!.height).toBeGreaterThanOrEqual(50 - 1);
    expect(at(10_000).get('k10')!.width).toBe(at(100_000).get('k10')!.width);
  });

  it('skips sides that are not screen edges', () => {
    const noTop = at(40, { top: false });
    const flat = at(0);
    expect(noTop.get('k00')!.height).toBeLessThanOrEqual(flat.get('k00')!.height + 0);
    expect(noTop.get('k00')!.width).toBeGreaterThan(flat.get('k00')!.width);
    const noLeft = at(40, { left: false });
    expect(noLeft.get('k10')!.width).toBeLessThanOrEqual(flat.get('k10')!.width);
  });

  it('does not enlarge spacers and does not treat a keyboard edge spacer as an edge key', () => {
    const rows = [row([spacer('s1', 0.5), key('a'), key('b'), key('c'), spacer('s2', 0.5)])];
    const slots = computeSlots(
      rows,
      { x: 0, y: 0, width: 400, height: 100 },
      { gapPx: 0, edgeGrowthPx: 30 },
    );
    expect(slots.map((s) => s.rect.width)).toEqual([50, 100, 100, 100, 50]);
  });

  it('does nothing for rows or rows of keys that have no inner items', () => {
    const slots = computeSlots(
      [row([key('a'), key('b')])],
      { x: 0, y: 0, width: 200, height: 100 },
      { gapPx: 0, edgeGrowthPx: 50 },
    );
    expect(slots.map((s) => s.rect.width)).toEqual([100, 100]);
  });
});

describe('built-in layouts fit a typical screen', () => {
  it('places every key of every page with positive size inside the bounds', () => {
    const bounds = { x: 0, y: 300, width: 1280, height: 420 };
    for (const layout of BUILTIN_LAYOUTS) {
      for (const page of layout.pages) {
        const rects = computeGeometry(page, bounds, { gapPx: 6, edgeGrowthPx: 16 });
        expect(rects.length).toBeGreaterThan(0);
        for (const { rect } of rects) {
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.height).toBeGreaterThan(0);
          expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
          expect(rect.y).toBeGreaterThanOrEqual(bounds.y);
          expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        }
      }
    }
  });
});
