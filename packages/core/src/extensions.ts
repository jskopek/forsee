import {
  EXTENSION_POINTS,
  type ContributionMap,
  type Disposable,
  type ExtensionChange,
  type ExtensionPointId,
  type RegisteredContribution,
} from '@forsee/plugin-api';
import { toDisposable } from './disposable';
import { ForseeError } from './errors';
import { EventBus, type EventBusOptions } from './event-bus';

/** Events emitted by the extension registry. */
export interface ExtensionEventMap {
  changed: ExtensionChange;
}

/**
 * The extension registry (plan section 6): named contribution points that
 * plugins (and the app, as owner `"app"`) fill.
 *
 * - Contribution ids are unique within a point across all owners;
 *   registering a taken id throws `ForseeError('duplicate')`. (The plugin
 *   host prefixes plugin contributions with the plugin id, so clashes are
 *   bugs.)
 * - `list(point)` returns contributions in registration order.
 * - `disposeOwner(owner)` removes everything an owner registered, which is
 *   how a plugin is unloaded.
 * - This registry stores and announces contributions; it never calls into
 *   them. Consumers (prediction engine, speech, UI) watch `changed`.
 */
export class ExtensionRegistry implements Disposable {
  readonly events: EventBus<ExtensionEventMap>;
  private readonly points = new Map<ExtensionPointId, Map<string, RegisteredContribution>>();

  constructor(options: EventBusOptions = {}) {
    this.events = new EventBus(options);
  }

  /** Registers a contribution. Its `id` is taken from `contribution.id`. */
  register<P extends ExtensionPointId>(
    point: P,
    owner: string,
    contribution: ContributionMap[P],
  ): Disposable {
    if (!(point in EXTENSION_POINTS)) {
      throw new ForseeError('invalid-argument', `Unknown extension point: ${String(point)}`);
    }
    const id = contribution.id;
    if (typeof id !== 'string' || id === '') {
      throw new ForseeError('invalid-argument', `Contribution to ${point} needs an id`);
    }
    let entries = this.points.get(point);
    if (!entries) {
      entries = new Map();
      this.points.set(point, entries);
    }
    if (entries.has(id)) {
      throw new ForseeError('duplicate', `${point} already has a contribution with id ${id}`);
    }
    const registered: RegisteredContribution<P> = { point, id, owner, contribution };
    entries.set(id, registered);
    this.events.emit('changed', { point, id, owner, change: 'added' });
    return toDisposable(() => this.remove(point, id, registered));
  }

  /** Contributions to a point, in registration order. */
  list<P extends ExtensionPointId>(point: P): readonly RegisteredContribution<P>[] {
    const entries = this.points.get(point);
    return entries ? ([...entries.values()] as RegisteredContribution<P>[]) : [];
  }

  /** One contribution by id. */
  get<P extends ExtensionPointId>(point: P, id: string): RegisteredContribution<P> | undefined {
    return this.points.get(point)?.get(id) as RegisteredContribution<P> | undefined;
  }

  /** Everything one owner has registered, across points. */
  listByOwner(owner: string): readonly RegisteredContribution[] {
    const out: RegisteredContribution[] = [];
    for (const entries of this.points.values()) {
      for (const entry of entries.values()) if (entry.owner === owner) out.push(entry);
    }
    return out;
  }

  /** Removes every contribution of `owner`. Returns how many were removed. */
  disposeOwner(owner: string): number {
    const doomed = this.listByOwner(owner);
    for (const entry of doomed) this.remove(entry.point, entry.id, entry);
    return doomed.length;
  }

  dispose(): void {
    this.points.clear();
    this.events.dispose();
  }

  private remove(point: ExtensionPointId, id: string, entry: RegisteredContribution): void {
    const entries = this.points.get(point);
    if (entries?.get(id) !== entry) return;
    entries.delete(id);
    this.events.emit('changed', { point, id, owner: entry.owner, change: 'removed' });
  }
}
