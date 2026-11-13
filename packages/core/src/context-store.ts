import type {
  ContextChange,
  ContextEntry,
  ContextEntryInput,
  Disposable,
} from '@forsee/plugin-api';
import { ForseeError } from './errors';
import { EventBus, type EventBusOptions } from './event-bus';
import type { Clock } from './platform';

/** Events emitted by the context store. */
export interface ContextEventMap {
  changed: ContextChange;
}

/** Options for `ContextStore`. */
export interface ContextStoreOptions extends EventBusOptions {
  readonly clock: Clock;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/**
 * The shared context store (plan section 6). Context providers write facts;
 * prediction providers read them. In memory only.
 *
 * Expiry uses wall-clock time (`ContextEntry` explains why). Expired entries
 * are invisible to `get`/`list` at once; `prune()` removes them and emits
 * `changed` with `entry: null` for each. Permission checks are the plugin
 * host's job, not the store's.
 */
export class ContextStore implements Disposable {
  readonly events: EventBus<ContextEventMap>;
  private readonly entries = new Map<string, ContextEntry>();
  private readonly clock: Clock;

  constructor(options: ContextStoreOptions) {
    this.events = new EventBus(options);
    this.clock = options.clock;
  }

  /** Writes an entry on behalf of `source` (a plugin id or `"app"`). Throws `invalid-argument`. */
  set(source: string, input: ContextEntryInput): ContextEntry {
    if (!KEY_PATTERN.test(input.key)) {
      throw new ForseeError('invalid-argument', `Invalid context key: ${input.key}`);
    }
    if (input.ttlMs !== undefined && !(input.ttlMs > 0)) {
      throw new ForseeError('invalid-argument', 'ttlMs must be > 0');
    }
    if (input.confidence !== undefined && !(input.confidence >= 0 && input.confidence <= 1)) {
      throw new ForseeError('invalid-argument', 'confidence must be within 0..1');
    }
    const now = this.clock.wallNow();
    const entry: ContextEntry = {
      key: input.key,
      value: input.value,
      source,
      updatedAt: now,
      ...(input.ttlMs === undefined ? {} : { expiresAt: now + input.ttlMs }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    };
    this.entries.set(input.key, entry);
    this.events.emit('changed', { key: input.key, entry });
    return entry;
  }

  /** The unexpired entry for `key`. */
  get(key: string): ContextEntry | undefined {
    const entry = this.entries.get(key);
    return entry && !this.isExpired(entry) ? entry : undefined;
  }

  /** Unexpired entries whose key equals `prefix` or starts with `prefix + "."`; all when omitted. Sorted by key. */
  list(prefix?: string): readonly ContextEntry[] {
    const out: ContextEntry[] = [];
    for (const entry of this.entries.values()) {
      if (this.isExpired(entry)) continue;
      if (prefix !== undefined && entry.key !== prefix && !entry.key.startsWith(`${prefix}.`)) {
        continue;
      }
      out.push(entry);
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Deletes `key`. With `source`, only if that source wrote it. Returns
   * whether something was deleted.
   */
  delete(key: string, source?: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || (source !== undefined && entry.source !== source)) return false;
    this.entries.delete(key);
    this.events.emit('changed', { key, entry: null });
    return true;
  }

  /** Deletes every entry written by `source` (a plugin being unloaded). */
  deleteBySource(source: string): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.source === source && this.delete(entry.key)) count += 1;
    }
    return count;
  }

  /** Removes expired entries. Returns how many. */
  prune(): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.isExpired(entry)) {
        this.entries.delete(entry.key);
        this.events.emit('changed', { key: entry.key, entry: null });
        count += 1;
      }
    }
    return count;
  }

  dispose(): void {
    this.entries.clear();
    this.events.dispose();
  }

  private isExpired(entry: ContextEntry): boolean {
    return entry.expiresAt !== undefined && this.clock.wallNow() >= entry.expiresAt;
  }
}
