import { EventBus, type ErrorReporter } from '@forsee/core';
import type { RuntimeError, RuntimeErrors } from './types';

/** How many errors `list()` keeps. */
export const MAX_KEPT_ERRORS = 100;

/** Collects every reported error so the UI can show problems instead of failing silently. */
export function createErrorCollector(options: {
  readonly wallNow: () => number;
  readonly onError?: (error: RuntimeError) => void;
}): { readonly errors: RuntimeErrors; readonly report: ErrorReporter; dispose(): void } {
  const kept: RuntimeError[] = [];
  const bus = new EventBus<{ error: RuntimeError }>({
    // A throwing error listener must not recurse into the collector.
    onListenerError: () => undefined,
  });
  let disposed = false;
  const report: ErrorReporter = (error, context) => {
    const entry: RuntimeError = { error, context, at: options.wallNow() };
    kept.push(entry);
    if (kept.length > MAX_KEPT_ERRORS) kept.splice(0, kept.length - MAX_KEPT_ERRORS);
    if (!disposed) bus.emit('error', entry);
    try {
      options.onError?.(entry);
    } catch {
      // The sink must not break the code that reported.
    }
  };
  return {
    errors: {
      list: () => [...kept],
      on: (listener) => bus.on('error', listener),
    },
    report,
    dispose() {
      disposed = true;
      bus.dispose();
    },
  };
}
