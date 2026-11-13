import { isForseeError } from '@forsee/core';
import type { TargetDescriptor } from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { createTargetRegistry } from './targets';
import {
  BAR_ID,
  DISABLED_ID,
  GAP,
  KEY,
  ROW_Y,
  fixtureRegistry,
  keyRect,
  letterCentre,
  letterTarget,
} from './test-support';

const A = 'keyboard/key-a';
const B = 'keyboard/key-b';
const C = 'keyboard/key-c';

/** x coordinate of the shared boundary between key a (index 0) and key b (index 1), mid-gap. */
const GAP_MID = keyRect(0).x + KEY + GAP / 2;
const MID_Y = ROW_Y + KEY / 2;

function throwsCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(isForseeError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  throw new Error('expected a throw');
}

describe('target registry: registration', () => {
  it('registers, lists, gets and disposes targets', () => {
    const registry = createTargetRegistry();
    const handle = registry.register(letterTarget('a', 0));
    expect(handle.id).toBe(A);
    expect(registry.get(A)?.text).toBe('a');
    expect(registry.list().map((t) => t.id)).toEqual([A]);
    handle.dispose();
    handle.dispose();
    expect(registry.get(A)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('rejects duplicates and invalid descriptors', () => {
    const registry = createTargetRegistry();
    registry.register(letterTarget('a', 0));
    throwsCode(() => registry.register(letterTarget('a', 1)), 'duplicate');
    const bad = (patch: Partial<TargetDescriptor>) => ({ ...letterTarget('z', 9), ...patch });
    throwsCode(
      () => registry.register(bad({ rect: { x: 0, y: 0, width: -1, height: 1 } })),
      'invalid-argument',
    );
    throwsCode(
      () => registry.register(bad({ rect: { x: NaN, y: 0, width: 1, height: 1 } })),
      'invalid-argument',
    );
    throwsCode(() => registry.register(bad({ likelihood: 1.5 })), 'invalid-argument');
    throwsCode(() => registry.register(bad({ id: '' })), 'invalid-argument');
    throwsCode(
      () => registry.register(bad({ dwellClass: 'nope' as TargetDescriptor['dwellClass'] })),
      'invalid-argument',
    );
  });

  it('registerAll is all or nothing and notifies once', () => {
    const registry = createTargetRegistry();
    const listener = vi.fn();
    registry.onDidChange(listener);
    throwsCode(
      () => registry.registerAll([letterTarget('a', 0), letterTarget('a', 1)]),
      'duplicate',
    );
    expect(registry.list()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    const handles = registry.registerAll([letterTarget('a', 0), letterTarget('b', 1)]);
    expect(handles.map((h) => h.id)).toEqual([A, B]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('batch coalesces change notifications', () => {
    const registry = fixtureRegistry();
    const listener = vi.fn();
    registry.onDidChange(listener);
    const result = registry.batch(() => {
      for (const t of registry.list()) {
        if (t.text) registry.get(t.id);
      }
      registry.register(letterTarget('z', 9));
      registry.register(letterTarget('y', 10));
      return 42;
    });
    expect(result).toBe(42);
    expect(listener).toHaveBeenCalledTimes(1);
    registry.batch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('update patches fields, can clear optional ones, and is a no-op after dispose', () => {
    const registry = createTargetRegistry();
    const handle = registry.register({ ...letterTarget('a', 0), likelihood: 0.3 });
    handle.update({ rect: keyRect(3), likelihood: undefined, label: 'A' });
    const t = registry.get(A);
    expect(t?.rect).toEqual(keyRect(3));
    expect(t && 'likelihood' in t).toBe(false);
    expect(t?.label).toBe('A');
    throwsCode(() => handle.update({ likelihood: -1 }), 'invalid-argument');
    handle.dispose();
    handle.update({ label: 'gone' });
    expect(registry.get(A)).toBeUndefined();
  });

  it('stores a copy, so later mutation by the caller has no effect', () => {
    const registry = createTargetRegistry();
    const rect = { ...keyRect(0) };
    registry.register({ ...letterTarget('a', 0), rect });
    rect.x = 9999;
    expect(registry.get(A)?.rect.x).toBe(keyRect(0).x);
  });
});

describe('target registry: hit testing', () => {
  it('hits the target whose visible rect contains the point (half-open)', () => {
    const registry = fixtureRegistry({ expansionPx: 0, hysteresisPx: 0 });
    const r = keyRect(0);
    expect(registry.hitTest({ x: r.x, y: r.y }, null).target?.id).toBe(A);
    expect(registry.hitTest({ x: r.x + KEY - 0.001, y: r.y }, null).target?.id).toBe(A);
    expect(registry.hitTest({ x: r.x + KEY, y: r.y }, null).target).toBeNull();
  });

  it('expands targets into the gap, splitting it at the midline', () => {
    const registry = fixtureRegistry();
    expect(registry.hitTest({ x: GAP_MID - 1, y: MID_Y }, null).target?.id).toBe(A);
    expect(registry.hitTest({ x: GAP_MID + 1, y: MID_Y }, null).target?.id).toBe(B);
  });

  it('never lets an expanded area cover a neighbour’s visible rect', () => {
    const registry = fixtureRegistry({ expansionPx: 200 });
    const b = keyRect(1);
    for (let x = b.x; x < b.x + b.width; x += 3) {
      expect(registry.hitTest({ x, y: MID_Y }, null).target?.id).toBe(B);
    }
  });

  it('expands an isolated target only up to expansionPx', () => {
    const registry = fixtureRegistry({ expansionPx: 40 });
    const a = keyRect(0);
    expect(registry.hitTest({ x: a.x - 39, y: MID_Y }, null).target?.id).toBe(A);
    expect(registry.hitTest({ x: a.x - 41, y: MID_Y }, null).target).toBeNull();
    // Below the row (diagonal distance counts).
    expect(registry.hitTest({ x: a.x - 20, y: a.y + KEY + 20 }, null).target?.id).toBe(A);
  });

  it('keeps the engaged target within the hysteresis margin, even inside a neighbour', () => {
    const registry = fixtureRegistry({ hysteresisPx: 12 });
    const bLeft = keyRect(1).x;
    // Jitter around the shared edge does not flip while A is engaged...
    for (const x of [GAP_MID - 3, GAP_MID + 3, bLeft + 2, bLeft + 3.9]) {
      expect(registry.hitTest({ x, y: MID_Y }, A).target?.id).toBe(A);
    }
    // ...and a real move past the margin does.
    expect(registry.hitTest({ x: bLeft + 10, y: MID_Y }, A).target?.id).toBe(B);
    // Without an engaged target the midline decides.
    expect(registry.hitTest({ x: GAP_MID + 3, y: MID_Y }, null).target?.id).toBe(B);
    // Symmetric for B.
    expect(registry.hitTest({ x: GAP_MID - 3, y: MID_Y }, B).target?.id).toBe(B);
  });

  it('ignores an unknown hysteresis anchor', () => {
    const registry = fixtureRegistry();
    expect(registry.hitTest(letterCentre('c'), 'nope/missing').target?.id).toBe(C);
  });

  it('reports rest zones, which block expansion and never expand', () => {
    const registry = fixtureRegistry();
    const inBar = registry.hitTest({ x: 120, y: 79 }, null);
    expect(inBar).toMatchObject({ target: null, inRestZone: true });
    expect(inBar.distribution.entries).toEqual([]);
    // Just below the bar, above key a: within a's expansion and outside the bar.
    expect(registry.hitTest({ x: 120, y: 85 }, null).target?.id).toBe(A);
    // A rest target is never a hysteresis anchor.
    expect(registry.hitTest({ x: 120, y: 40 }, BAR_ID).inRestZone).toBe(true);
  });

  it('lets hysteresis reach a few pixels into a rest zone', () => {
    // The bar ends 20 px above the row.
    const registry = fixtureRegistry({ hysteresisPx: 24 });
    expect(registry.hitTest({ x: 120, y: 79 }, A).target?.id).toBe(A);
    expect(registry.hitTest({ x: 120, y: 60 }, A).inRestZone).toBe(true);
  });

  it('hit-tests disabled targets so they block their neighbours', () => {
    const registry = fixtureRegistry();
    const off = keyRect(6);
    expect(registry.hitTest({ x: off.x + 5, y: MID_Y }, null).target?.id).toBe(DISABLED_ID);
    expect(registry.hitTest({ x: off.x - 2, y: MID_Y }, null).target?.id).toBe(DISABLED_ID);
  });

  it('breaks ties deterministically, whatever the registration order', () => {
    const big = {
      id: 'z/panel',
      rect: { x: 0, y: 0, width: 400, height: 400 },
      dwellClass: 'function' as const,
    };
    const small = {
      id: 'z/button',
      rect: { x: 100, y: 100, width: 50, height: 50 },
      dwellClass: 'function' as const,
    };
    const twinA = {
      id: 'twin/a',
      rect: { x: 500, y: 0, width: 10, height: 10 },
      dwellClass: 'function' as const,
    };
    const twinB = { ...twinA, id: 'twin/b' };
    for (const order of [
      [big, small, twinA, twinB],
      [twinB, twinA, small, big],
    ]) {
      const registry = createTargetRegistry();
      registry.registerAll(order);
      // Overlap: the smaller rect wins.
      expect(registry.hitTest({ x: 120, y: 120 }, null).target?.id).toBe('z/button');
      // Identical rects: the lower id wins.
      expect(registry.hitTest({ x: 505, y: 5 }, null).target?.id).toBe('twin/a');
      // Equidistant expansion: lower id.
      expect(registry.hitTest({ x: 505, y: 15 }, null).target?.id).toBe('twin/a');
    }
  });

  it('returns no target for non-finite points', () => {
    const registry = fixtureRegistry();
    expect(registry.hitTest({ x: NaN, y: 0 }, A).target).toBeNull();
  });
});

describe('target registry: key distribution', () => {
  const sum = (entries: readonly { probability: number }[]) =>
    entries.reduce((s, e) => s + e.probability, 0);

  it('sums to 1, is sorted and ranks the nearest key first', () => {
    const registry = fixtureRegistry();
    const centre = { x: keyRect(1).x + 10, y: MID_Y };
    const d = registry.keyDistribution(centre, 15, B);
    expect(sum(d.entries)).toBeCloseTo(1, 9);
    expect(d.entries[0]).toMatchObject({ targetId: B, text: 'b' });
    expect(d.entries[1]?.targetId).toBe(A);
    for (let i = 1; i < d.entries.length; i++) {
      expect(d.entries[i - 1]?.probability ?? 0).toBeGreaterThanOrEqual(
        d.entries[i]?.probability ?? 0,
      );
    }
    // Only character targets appear.
    expect(d.entries.every((e) => e.text !== undefined)).toBe(true);
  });

  it('is nearly certain at a key centre with a small spread, and spreads out with a large one', () => {
    const registry = fixtureRegistry();
    const tight = registry.keyDistribution(letterCentre('c'), 2, C);
    expect(tight.entries[0]?.probability).toBeGreaterThan(0.95);
    const wide = registry.keyDistribution(letterCentre('c'), 60, C);
    expect(wide.entries[0]?.targetId).toBe(C);
    expect(wide.entries[0]?.probability).toBeLessThan(0.5);
    expect(wide.entries.length).toBeGreaterThan(2);
  });

  it('splits evenly between two keys when looking at the middle of the gap', () => {
    const registry = fixtureRegistry();
    const d = registry.keyDistribution({ x: GAP_MID, y: MID_Y }, 10, A);
    expect(d.entries[0]?.probability).toBeCloseTo(d.entries[1]?.probability ?? 0, 9);
    expect(
      d.entries
        .slice(0, 2)
        .map((e) => e.targetId)
        .sort(),
    ).toEqual([A, B]);
  });

  it('floors sigma, drops negligible keys and caps the number of entries', () => {
    const registry = fixtureRegistry({ sigmaFloorPx: 12, minProbability: 0.01, maxEntries: 3 });
    const zero = registry.keyDistribution(letterCentre('c'), 0, C);
    expect(sum(zero.entries)).toBeCloseTo(1, 9);
    expect(zero.entries.length).toBeLessThanOrEqual(3);
    const wide = registry.keyDistribution(letterCentre('c'), 500, C);
    expect(wide.entries).toHaveLength(3);
    expect(sum(wide.entries)).toBeCloseTo(1, 9);
  });

  it('always includes the fired key, even far from the centre', () => {
    const registry = fixtureRegistry({ maxEntries: 2 });
    const d = registry.keyDistribution(letterCentre('a'), 5, 'keyboard/key-e');
    expect(d.entries.some((e) => e.targetId === 'keyboard/key-e')).toBe(true);
    expect(d.entries).toHaveLength(2);
    expect(sum(d.entries)).toBeCloseTo(1, 9);
  });

  it('gives non-character targets a single certain entry', () => {
    const registry = fixtureRegistry();
    expect(registry.keyDistribution(letterCentre('a'), 30, 'keyboard/delete')).toEqual({
      entries: [{ targetId: 'keyboard/delete', probability: 1 }],
    });
    expect(registry.keyDistribution(letterCentre('a'), 30, 'missing').entries).toEqual([]);
  });

  it('hit results carry a distribution for the hit target', () => {
    const registry = fixtureRegistry();
    const hit = registry.hitTest(letterCentre('d'), null);
    expect(hit.distribution.entries[0]?.targetId).toBe('keyboard/key-d');
    expect(sum(hit.distribution.entries)).toBeCloseTo(1, 9);
  });
});

describe('target registry: configuration', () => {
  it('validates hit-test configuration', () => {
    throwsCode(() => createTargetRegistry({ config: { expansionPx: -1 } }), 'invalid-argument');
    const registry = createTargetRegistry();
    throwsCode(() => registry.setHitTestConfig({ maxEntries: 0.5 }), 'invalid-argument');
    registry.setHitTestConfig({ expansionPx: 0 });
    expect(registry.hitTestConfig.expansionPx).toBe(0);
  });
});
