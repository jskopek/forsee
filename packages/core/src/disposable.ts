import type { Disposable } from '@forsee/plugin-api';

export type { Disposable } from '@forsee/plugin-api';

/** Wraps a function as an idempotent disposable. */
export function toDisposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}

/** A disposable that does nothing. */
export const NOOP_DISPOSABLE: Disposable = Object.freeze({ dispose: (): void => undefined });

/**
 * Collects disposables and disposes them together, in reverse order of
 * addition. Adding to a disposed store disposes the item immediately. If
 * several items throw, every item is still disposed and an `AggregateError`
 * (or the single error) is thrown at the end.
 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposedFlag = false;

  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** Adds `item` and returns it, for chaining. */
  add<T extends Disposable>(item: T): T {
    if (this.disposedFlag) {
      item.dispose();
    } else {
      this.items.push(item);
    }
    return item;
  }

  /** Removes `item` without disposing it. */
  delete(item: Disposable): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
  }

  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    const items = this.items.reverse();
    this.items = [];
    disposeAll(items);
  }
}

/** Disposes every item even if some throw; rethrows the error(s) afterwards. */
export function disposeAll(items: Iterable<Disposable>): void {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      item.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Several disposables failed');
}
