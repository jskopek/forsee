import type { JsonValue } from './common';

/**
 * An entry in the shared context store. Context providers write facts ("it is
 * evening"); prediction providers with `context.read` read them.
 *
 * Keys are dot-separated, lower camel case segments, namespaced by topic, for
 * example `time.partOfDay` or `people.present`. One key holds one entry; a
 * later write replaces it regardless of source.
 *
 * Times are wall-clock milliseconds since the epoch, because entries are
 * written from sandboxed realms whose monotonic clocks differ from the host's.
 */
export interface ContextEntry {
  readonly key: string;
  readonly value: JsonValue;
  /** Who wrote it: a plugin id, or `"app"`. Set by the store, not trusted from the writer. */
  readonly source: string;
  /** When it was written. Set by the store. */
  readonly updatedAt: number;
  /** When it stops being valid; absent means until replaced or deleted. Expired entries are invisible. */
  readonly expiresAt?: number;
  /** 0..1, the writer's confidence. Absent means certain. */
  readonly confidence?: number;
}

/** What a writer supplies; the store adds `source` and `updatedAt`. */
export interface ContextEntryInput {
  readonly key: string;
  readonly value: JsonValue;
  /** Lifetime from now, ms. Converted to `expiresAt` by the store. */
  readonly ttlMs?: number;
  readonly confidence?: number;
}

/** Payload of a context change. `entry` is null when the key was deleted or expired. */
export interface ContextChange {
  readonly key: string;
  readonly entry: ContextEntry | null;
}
