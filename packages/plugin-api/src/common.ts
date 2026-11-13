/**
 * Shared primitive types and conventions used by every Forsee contract.
 *
 * ## Conventions
 *
 * **Coordinates.** Every point and rectangle is in CSS pixels in the app
 * viewport (the top-level document's layout viewport), origin at the top-left,
 * x increasing to the right, y increasing downwards. Panels in sandboxed
 * frames report rectangles relative to their own frame; the plugin host
 * translates them before they reach any engine.
 *
 * **Time.** Values named `t`, `*Ms` timestamps or `monotonic` are milliseconds
 * from the host's monotonic clock (`Clock.now()`; like `performance.now()`).
 * They only compare meaningfully with other values from the same host clock,
 * never with a sandboxed plugin's own `performance.now()`. Values named
 * `*At` (for example `createdAt`, `expiresAt`) are wall-clock milliseconds
 * since the Unix epoch (`Clock.wallNow()`), used for anything persisted or
 * shared across realms. Durations are always in milliseconds.
 *
 * **Data.** Everything that crosses the plugin boundary must survive
 * `structuredClone`: plain objects, arrays, strings, finite numbers, booleans,
 * `null`, `undefined`, `ArrayBuffer` and `Uint8Array`. No class instances,
 * functions (except handler objects passed to `register*` functions; see
 * `rpc.ts`), `Map`, `Set` or `Date`.
 */

/** Something that holds resources and can release them. `dispose()` is idempotent. */
export interface Disposable {
  /** Releases the resource. Calling it more than once has no further effect. */
  dispose(): void;
}

/** A JSON-compatible value. Used for persisted data and command arguments. */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;

/** A JSON-compatible array. */
export type JsonArray = readonly JsonValue[];

/** A JSON-compatible object. Values that are `undefined` are dropped on serialisation. */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** A point in app viewport CSS pixels (see the coordinate convention above). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * An axis-aligned rectangle in app viewport CSS pixels. `width` and `height`
 * are never negative. A point is inside when `x <= p.x < x + width` and
 * `y <= p.y < y + height`.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** BCP 47 language tag, for example `"en-GB"`. */
export type LocaleTag = string;

/** A problem found while validating data. */
export interface ValidationIssue {
  /** JSON-pointer-like path to the offending value, for example `"/pages/0/rows/2"`. Empty for the root. */
  readonly path: string;
  /** Human-readable explanation, suitable for a developer, not necessarily the end user. */
  readonly message: string;
}

/** Outcome of validating untrusted data into a typed value. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * A cooperative cancellation signal (`AbortSignal` is not available to engine
 * packages, and does not cross `postMessage`). Over RPC, cancellation travels
 * as an `RpcCancel` envelope and the receiving side recreates a token.
 */
export interface CancellationToken {
  /** True once cancellation has been requested. Never goes back to false. */
  readonly cancelled: boolean;
  /**
   * Calls `listener` once when cancellation is requested. If already
   * cancelled, the listener is called synchronously.
   */
  onCancel(listener: () => void): Disposable;
}

/** Stable error codes shared by commands, RPC and the plugin API. */
export type ForseeErrorCode =
  | 'unknown-command'
  | 'duplicate'
  | 'handler-error'
  | 'invalid-argument'
  | 'permission-denied'
  | 'not-found'
  | 'unavailable'
  | 'cancelled'
  | 'timeout'
  | 'disposed'
  | 'internal';

/** Structured-clone-safe description of an error. */
export interface ForseeErrorData {
  readonly code: ForseeErrorCode;
  readonly message: string;
  /** Optional extra detail (for example validation issues). */
  readonly details?: JsonValue;
}
