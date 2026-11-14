import {
  REGION_IDS,
  type Disposable,
  type RegionId,
  type RegionSize,
  type RegionState,
} from '@forsee/plugin-api';
import { ForseeError } from './errors';
import { EventBus, type EventBusOptions } from './event-bus';

/** Events emitted by the region model. */
export interface RegionEventMap {
  /** One region's state changed. */
  changed: RegionState;
}

/** Persisted form of the region layout (part of the profile's UI state). */
export interface RegionsSnapshot {
  readonly version: 1;
  readonly regions: readonly RegionState[];
}

const SIZES: readonly RegionSize[] = ['compact', 'normal', 'expanded'];

function initialState(id: RegionId): RegionState {
  return { id, panels: [], activePanel: null, visible: true, size: 'normal' };
}

/**
 * The region model: which panels are assigned to which named screen region,
 * and each region's visibility and size. No rendering.
 *
 * Invariants: a panel is in at most one region; `activePanel` is one of the
 * region's panels or `null`; assigning a panel to an empty region makes it
 * active; removing the active panel activates the next one (or `null`).
 */
export class RegionModel implements Disposable {
  readonly events: EventBus<RegionEventMap>;
  private readonly states = new Map<RegionId, RegionState>(
    REGION_IDS.map((id) => [id, initialState(id)] as const),
  );

  constructor(options: EventBusOptions = {}) {
    this.events = new EventBus(options);
  }

  get(id: RegionId): RegionState {
    return this.require(id);
  }

  list(): readonly RegionState[] {
    return REGION_IDS.map((id) => this.require(id));
  }

  /** Region a panel is in, or undefined. */
  regionOf(panelId: string): RegionId | undefined {
    for (const state of this.states.values()) {
      if (state.panels.includes(panelId)) return state.id;
    }
    return undefined;
  }

  /**
   * Assigns a panel to a region at `index` (default: the end), moving it out
   * of any other region first.
   */
  assignPanel(region: RegionId, panelId: string, index?: number): void {
    const current = this.regionOf(panelId);
    if (current !== undefined && current !== region) this.removePanel(panelId);
    const state = this.require(region);
    const panels = state.panels.filter((p) => p !== panelId);
    const at = index === undefined ? panels.length : Math.max(0, Math.min(index, panels.length));
    panels.splice(at, 0, panelId);
    this.update(region, { panels, activePanel: state.activePanel ?? panelId });
  }

  /** Removes a panel from whichever region holds it. Returns false if none does. */
  removePanel(panelId: string): boolean {
    const region = this.regionOf(panelId);
    if (region === undefined) return false;
    const state = this.require(region);
    const index = state.panels.indexOf(panelId);
    const panels = state.panels.filter((p) => p !== panelId);
    let activePanel = state.activePanel;
    if (activePanel === panelId) {
      activePanel = panels[Math.min(index, panels.length - 1)] ?? null;
    }
    this.update(region, { panels, activePanel });
    return true;
  }

  /** Makes a panel the region's active one. Throws `not-found` if it is not in the region. */
  setActivePanel(region: RegionId, panelId: string): void {
    const state = this.require(region);
    if (!state.panels.includes(panelId)) {
      throw new ForseeError('not-found', `Panel ${panelId} is not in region ${region}`);
    }
    this.update(region, { activePanel: panelId });
  }

  setVisible(region: RegionId, visible: boolean): void {
    this.update(region, { visible });
  }

  setSize(region: RegionId, size: RegionSize): void {
    if (!SIZES.includes(size)) throw new ForseeError('invalid-argument', `Unknown size: ${size}`);
    this.update(region, { size });
  }

  /** Steps the size up (+1) or down (-1), clamped. For "bigger"/"smaller" keys. */
  stepSize(region: RegionId, delta: 1 | -1): RegionSize {
    const index = SIZES.indexOf(this.require(region).size);
    const size = SIZES[Math.max(0, Math.min(SIZES.length - 1, index + delta))]!;
    this.setSize(region, size);
    return size;
  }

  snapshot(): RegionsSnapshot {
    return { version: 1, regions: this.list() };
  }

  /**
   * Restores a snapshot (untrusted data). Unknown regions and malformed
   * entries are skipped; returns false if the snapshot as a whole is unusable.
   */
  restore(snapshot: unknown): boolean {
    if (typeof snapshot !== 'object' || snapshot === null) return false;
    const s = snapshot as { version?: unknown; regions?: unknown };
    if (s.version !== 1 || !Array.isArray(s.regions)) return false;
    const seen = new Set<string>();
    for (const raw of s.regions as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Partial<Record<keyof RegionState, unknown>>;
      if (typeof r.id !== 'string' || !REGION_IDS.includes(r.id as RegionId)) continue;
      const panels = Array.isArray(r.panels)
        ? (r.panels as unknown[]).filter(
            (p): p is string => typeof p === 'string' && !seen.has(p) && (seen.add(p), true),
          )
        : [];
      const activePanel =
        typeof r.activePanel === 'string' && panels.includes(r.activePanel)
          ? r.activePanel
          : (panels[0] ?? null);
      this.update(r.id as RegionId, {
        panels,
        activePanel,
        visible: typeof r.visible === 'boolean' ? r.visible : true,
        size: SIZES.includes(r.size as RegionSize) ? (r.size as RegionSize) : 'normal',
      });
    }
    return true;
  }

  dispose(): void {
    this.events.dispose();
  }

  private require(id: RegionId): RegionState {
    const state = this.states.get(id);
    if (!state) throw new ForseeError('not-found', `Unknown region: ${String(id)}`);
    return state;
  }

  private update(id: RegionId, patch: Partial<Omit<RegionState, 'id'>>): void {
    const before = this.require(id);
    const next: RegionState = { ...before, ...patch, id };
    if (
      next.visible === before.visible &&
      next.size === before.size &&
      next.activePanel === before.activePanel &&
      next.panels.length === before.panels.length &&
      next.panels.every((p, i) => p === before.panels[i])
    ) {
      return;
    }
    this.states.set(id, next);
    this.events.emit('changed', next);
  }
}
