import type { Disposable } from '@forsee/plugin-api';
import { NOOP_DISPOSABLE, toDisposable } from './disposable';
import { defaultErrorReporter, type ErrorReporter } from './errors';

/** A listener for events of type `K` of event map `M`. */
export type Listener<M, K extends keyof M> = (payload: M[K]) => void;

/** Options for `EventBus`. */
export interface EventBusOptions {
  /** Where listener errors go. Default: `defaultErrorReporter`. */
  readonly onListenerError?: ErrorReporter;
}

/**
 * Typed, synchronous publish/subscribe over an event map `M` (event name →
 * payload type).
 *
 * - `emit` calls listeners synchronously, in subscription order.
 * - A listener that throws does not stop the others; its error goes to
 *   `onListenerError` and `emit` returns normally.
 * - Listeners added during an emit are not called for that emit; listeners
 *   removed during an emit are not called if they had not run yet.
 * - Subscribing the same function twice gives two independent subscriptions.
 */
export class EventBus<M extends object> implements Disposable {
  private readonly listeners = new Map<keyof M, Set<{ fn: (payload: never) => void }>>();
  private readonly anyListeners = new Set<{
    fn: (type: keyof M, payload: M[keyof M]) => void;
  }>();
  private readonly reportError: ErrorReporter;
  private disposed = false;

  constructor(options: EventBusOptions = {}) {
    this.reportError = options.onListenerError ?? defaultErrorReporter;
  }

  /** Subscribes to one event type. */
  on<K extends keyof M>(type: K, listener: Listener<M, K>): Disposable {
    if (this.disposed) return NOOP_DISPOSABLE;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const entry = { fn: listener as (payload: never) => void };
    set.add(entry);
    return toDisposable(() => {
      set.delete(entry);
    });
  }

  /** Subscribes for the next event of `type` only. */
  once<K extends keyof M>(type: K, listener: Listener<M, K>): Disposable {
    const subscription = this.on(type, (payload) => {
      subscription.dispose();
      listener(payload);
    });
    return subscription;
  }

  /** Subscribes to every event (for forwarding and logging). */
  onAny(listener: <K extends keyof M>(type: K, payload: M[K]) => void): Disposable {
    if (this.disposed) return NOOP_DISPOSABLE;
    const entry = { fn: listener };
    this.anyListeners.add(entry);
    return toDisposable(() => {
      this.anyListeners.delete(entry);
    });
  }

  /** Publishes an event to current listeners. No-op after `dispose`. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    if (this.disposed) return;
    const set = this.listeners.get(type);
    if (set && set.size > 0) {
      for (const entry of [...set]) {
        if (!set.has(entry)) continue;
        try {
          (entry.fn as Listener<M, K>)(payload);
        } catch (error) {
          this.reportError(error, `event:${String(type)}`);
        }
      }
    }
    if (this.anyListeners.size > 0) {
      for (const entry of [...this.anyListeners]) {
        if (!this.anyListeners.has(entry)) continue;
        try {
          entry.fn(type, payload);
        } catch (error) {
          this.reportError(error, `event:${String(type)}`);
        }
      }
    }
  }

  /** Number of listeners for `type` (for tests and diagnostics). */
  listenerCount(type: keyof M): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Removes all listeners; later `on` and `emit` calls do nothing. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.anyListeners.clear();
  }
}
