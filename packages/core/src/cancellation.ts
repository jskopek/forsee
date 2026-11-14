import type { CancellationToken, Disposable } from '@forsee/plugin-api';
import { NOOP_DISPOSABLE, toDisposable } from './disposable';
import { defaultErrorReporter, type ErrorReporter } from './errors';

/** Creates and controls a `CancellationToken`. */
export class CancellationSource {
  private cancelledFlag = false;
  private readonly listeners = new Set<() => void>();
  /** The token to hand to the work being controlled. */
  readonly token: CancellationToken;

  constructor(private readonly reportError: ErrorReporter = defaultErrorReporter) {
    const isCancelled = (): boolean => this.cancelledFlag;
    const onCancel = (listener: () => void): Disposable => {
      if (this.cancelledFlag) {
        listener();
        return NOOP_DISPOSABLE;
      }
      const entry = (): void => listener();
      this.listeners.add(entry);
      return toDisposable(() => {
        this.listeners.delete(entry);
      });
    };
    this.token = {
      get cancelled() {
        return isCancelled();
      },
      onCancel,
    };
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  /** Requests cancellation. Listeners run once, synchronously; their errors are reported, not thrown. */
  cancel(): void {
    if (this.cancelledFlag) return;
    this.cancelledFlag = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.reportError(error, 'cancellation');
      }
    }
  }
}

/** A token that is never cancelled. */
export const NEVER_CANCELLED: CancellationToken = Object.freeze({
  cancelled: false,
  onCancel: () => NOOP_DISPOSABLE,
});
