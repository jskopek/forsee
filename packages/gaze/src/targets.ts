import { ForseeError, defaultErrorReporter, type ErrorReporter } from '@forsee/core';
import {
  DWELL_CLASSES,
  type Disposable,
  type KeyDistribution,
  type KeyProbability,
  type Point,
  type TargetDescriptor,
} from '@forsee/plugin-api';
import { DEFAULT_HIT_TEST_CONFIG, resolveHitTestConfig, type HitTestConfig } from './config';
import type { HitTestResult, TargetHandle, TargetPatch, TargetRegistry } from './contracts';
import { isFinitePoint, rectArea, rectContains, rectDistance } from './geometry';

/**
 * The target registry and hit tester.
 *
 * Hit testing, in priority order:
 *
 * 1. **Hysteresis.** If `current` names a registered, non-rest target and
 *    the point is within `hysteresisPx` of its visible rect, it wins, even
 *    over a neighbour's visible rect or a rest zone. Jitter across a shared
 *    edge therefore does not flip between keys.
 * 2. **Visible rects.** A point inside a non-rest target's visible rect hits
 *    it. Overlapping rects: the smaller area wins (a button on a panel), then
 *    the lower id (lexicographic), so the outcome never depends on
 *    registration order.
 * 3. **Rest zones.** A point inside a `rest` target's rect hits nothing and
 *    reports `inRestZone`. Rest zones never expand, and other targets never
 *    expand into them.
 * 4. **Expansion.** Otherwise the nearest non-rest target whose visible rect
 *    is within `expansionPx` wins (ties: lower id). Nearest-rect assignment
 *    splits the gap between neighbours at its midline, so a hit area never
 *    covers a neighbour's visible rect.
 *
 * Disabled targets take part in all of this (they block their neighbours);
 * the selection methods refuse to fire them.
 */
export class GazeTargetRegistry implements TargetRegistry {
  private readonly targets = new Map<string, TargetDescriptor>();
  private readonly listeners = new Set<{ fn: () => void }>();
  private listCache: readonly TargetDescriptor[] | null = null;
  private batchDepth = 0;
  private changedInBatch = false;
  private config: HitTestConfig;
  private readonly reportError: ErrorReporter;

  constructor(options: { config?: Partial<HitTestConfig>; reportError?: ErrorReporter } = {}) {
    this.config = resolveHitTestConfig(options.config ?? {}, DEFAULT_HIT_TEST_CONFIG);
    this.reportError = options.reportError ?? defaultErrorReporter;
  }

  /** The hit-test configuration in force. */
  get hitTestConfig(): HitTestConfig {
    return this.config;
  }

  /** Changes hit-test parameters (validated; throws `ForseeError('invalid-argument')`). */
  setHitTestConfig(patch: Partial<HitTestConfig>): void {
    this.config = resolveHitTestConfig(patch, this.config);
    this.changed();
  }

  register(target: TargetDescriptor): TargetHandle {
    const [handle] = this.registerAll([target]);
    if (!handle) throw new ForseeError('internal', 'registerAll returned no handle');
    return handle;
  }

  registerAll(targets: readonly TargetDescriptor[]): TargetHandle[] {
    const seen = new Set<string>();
    for (const target of targets) {
      validateDescriptor(target);
      if (this.targets.has(target.id) || seen.has(target.id)) {
        throw new ForseeError('duplicate', `Gaze target "${target.id}" is already registered`);
      }
      seen.add(target.id);
    }
    const handles = targets.map((target) => {
      const stored = normalise(target);
      this.targets.set(stored.id, stored);
      return this.handleFor(stored);
    });
    if (handles.length > 0) this.changed();
    return handles;
  }

  batch<T>(fn: () => T): T {
    this.batchDepth += 1;
    try {
      return fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.changedInBatch) {
        this.changedInBatch = false;
        this.notify();
      }
    }
  }

  get(id: string): TargetDescriptor | undefined {
    return this.targets.get(id);
  }

  list(): readonly TargetDescriptor[] {
    this.listCache ??= Object.freeze([...this.targets.values()]);
    return this.listCache;
  }

  onDidChange(listener: () => void): Disposable {
    const entry = { fn: listener };
    this.listeners.add(entry);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.listeners.delete(entry);
      },
    };
  }

  hitTest(point: Point, current: string | null): HitTestResult {
    if (!isFinitePoint(point)) return NO_HIT;
    const cfg = this.config;

    // 1. Hysteresis: the engaged target keeps priority near its edge.
    if (current !== null) {
      const cur = this.targets.get(current);
      if (
        cur &&
        roleOf(cur) !== 'rest' &&
        (rectContains(cur.rect, point) ||
          (cfg.hysteresisPx > 0 && rectDistance(cur.rect, point) <= cfg.hysteresisPx))
      ) {
        return this.hit(cur, point);
      }
    }

    // 2. Visible rects of selectable targets, then 3. rest zones.
    let inside: TargetDescriptor | null = null;
    let inRest = false;
    for (const t of this.targets.values()) {
      if (!rectContains(t.rect, point)) continue;
      if (roleOf(t) === 'rest') {
        inRest = true;
        continue;
      }
      if (inside === null || smallerFirst(t, inside) < 0) inside = t;
    }
    if (inside) return this.hit(inside, point);
    if (inRest) return REST_HIT;

    // 4. Expansion into free space: nearest rect within expansionPx.
    if (cfg.expansionPx <= 0) return NO_HIT;
    let best: TargetDescriptor | null = null;
    let bestDistance = Infinity;
    for (const t of this.targets.values()) {
      if (roleOf(t) === 'rest') continue;
      const d = rectDistance(t.rect, point);
      if (d > cfg.expansionPx) continue;
      if (d < bestDistance || (d === bestDistance && best !== null && t.id < best.id)) {
        best = t;
        bestDistance = d;
      }
    }
    return best ? this.hit(best, point) : NO_HIT;
  }

  keyDistribution(centre: Point, spreadPx: number, firedId: string): KeyDistribution {
    const fired = this.targets.get(firedId);
    if (!fired) return { entries: [] };
    if (fired.text === undefined || !isFinitePoint(centre)) return single(fired);
    const cfg = this.config;
    const sigma = Math.max(cfg.sigmaFloorPx, Number.isFinite(spreadPx) ? spreadPx : 0);
    const twoSigmaSq = 2 * sigma * sigma;

    // Unnormalised 2D Gaussian weight of each character target, by the
    // distance from the centre to the nearest point of its visible rect.
    const weighted: { target: TargetDescriptor; weight: number }[] = [];
    let total = 0;
    for (const t of this.targets.values()) {
      if (t.text === undefined || roleOf(t) !== 'select' || (t.disabled && t !== fired)) continue;
      const d = rectDistance(t.rect, centre);
      const weight = Math.exp(-(d * d) / twoSigmaSq);
      weighted.push({ target: t, weight });
      total += weight;
    }
    if (!(total > 0)) return single(fired);
    weighted.sort(
      (a, b) =>
        b.weight - a.weight || (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0),
    );

    // Keep the significant entries (at most maxEntries), always including the fired target.
    const kept: { target: TargetDescriptor; weight: number }[] = [];
    for (const entry of weighted) {
      if (kept.length >= cfg.maxEntries) break;
      if (entry.weight / total < cfg.minProbability && entry.target !== fired) continue;
      kept.push(entry);
    }
    if (!kept.some((e) => e.target === fired)) {
      const firedEntry = weighted.find((e) => e.target === fired);
      // The fired target is far from the centre: give it at least a token weight.
      const weight = Math.max(firedEntry?.weight ?? 0, total * 1e-6);
      if (kept.length >= cfg.maxEntries) kept.pop();
      kept.push({ target: fired, weight });
    }
    const keptTotal = kept.reduce((sum, e) => sum + e.weight, 0);
    const entries: KeyProbability[] = kept
      .map((e) => toProbability(e.target, e.weight / keptTotal))
      .sort(
        (a, b) =>
          b.probability - a.probability ||
          (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0),
      );
    return { entries };
  }

  private hit(target: TargetDescriptor, point: Point): HitTestResult {
    return {
      target,
      inRestZone: false,
      distribution: this.keyDistribution(point, this.config.sigmaFloorPx, target.id),
    };
  }

  private handleFor(target: TargetDescriptor): TargetHandle {
    const id = target.id;
    let disposed = false;
    return {
      id,
      update: (patch: TargetPatch) => {
        if (disposed) return;
        const existing = this.targets.get(id);
        if (!existing) return;
        const next: Record<string, unknown> = { ...existing };
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'id') continue;
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        const descriptor = next as unknown as TargetDescriptor;
        validateDescriptor(descriptor);
        this.targets.set(id, normalise(descriptor));
        this.changed();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.targets.delete(id)) this.changed();
      },
    };
  }

  private changed(): void {
    this.listCache = null;
    if (this.batchDepth > 0) {
      this.changedInBatch = true;
      return;
    }
    this.notify();
  }

  private notify(): void {
    for (const entry of [...this.listeners]) {
      if (!this.listeners.has(entry)) continue;
      try {
        entry.fn();
      } catch (error) {
        this.reportError(error, 'gaze.targets.changed');
      }
    }
  }
}

/** Creates a target registry. */
export function createTargetRegistry(
  options: { config?: Partial<HitTestConfig>; reportError?: ErrorReporter } = {},
): GazeTargetRegistry {
  return new GazeTargetRegistry(options);
}

const EMPTY_DISTRIBUTION: KeyDistribution = Object.freeze({ entries: Object.freeze([]) });
const NO_HIT: HitTestResult = Object.freeze({
  target: null,
  inRestZone: false,
  distribution: EMPTY_DISTRIBUTION,
});
const REST_HIT: HitTestResult = Object.freeze({
  target: null,
  inRestZone: true,
  distribution: EMPTY_DISTRIBUTION,
});

/** Role with the default applied. */
export function roleOf(target: TargetDescriptor): 'select' | 'rest' | 'wake' {
  return target.role ?? 'select';
}

function smallerFirst(a: TargetDescriptor, b: TargetDescriptor): number {
  return rectArea(a.rect) - rectArea(b.rect) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toProbability(target: TargetDescriptor, probability: number): KeyProbability {
  return target.text === undefined
    ? { targetId: target.id, probability }
    : { targetId: target.id, text: target.text, probability };
}

/** A single-entry distribution: the selection carries no uncertainty. */
export function singleEntryDistribution(target: TargetDescriptor): KeyDistribution {
  return single(target);
}

function single(target: TargetDescriptor): KeyDistribution {
  return { entries: [toProbability(target, 1)] };
}

function invalid(target: { id?: unknown }, message: string): never {
  throw new ForseeError('invalid-argument', `Gaze target "${String(target.id)}": ${message}`);
}

function validateDescriptor(target: TargetDescriptor): void {
  if (typeof target.id !== 'string' || target.id.length === 0)
    invalid(target, 'id must be a non-empty string');
  const r = target.rect as Partial<TargetDescriptor['rect']> | undefined;
  if (
    !r ||
    ![r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    (r.width ?? -1) < 0 ||
    (r.height ?? -1) < 0
  ) {
    invalid(target, 'rect must have finite x, y and non-negative width, height');
  }
  if (!DWELL_CLASSES.includes(target.dwellClass)) invalid(target, `unknown dwellClass`);
  if (target.role !== undefined && !['select', 'rest', 'wake'].includes(target.role)) {
    invalid(target, 'unknown role');
  }
  if (
    target.likelihood !== undefined &&
    !(typeof target.likelihood === 'number' && target.likelihood >= 0 && target.likelihood <= 1)
  ) {
    invalid(target, 'likelihood must be between 0 and 1');
  }
  if (
    target.afterActivate !== undefined &&
    target.afterActivate !== 'look-away' &&
    target.afterActivate !== 'repeat'
  ) {
    invalid(target, 'afterActivate must be look-away or repeat');
  }
}

/** Stores a frozen copy, so later mutation by the caller cannot change the registry. */
function normalise(target: TargetDescriptor): TargetDescriptor {
  return Object.freeze({ ...target, rect: Object.freeze({ ...target.rect }) });
}
