import type { ForseeErrorCode, ForseeErrorData, JsonValue } from '@forsee/plugin-api';

/**
 * Error with a stable `code` (see `ForseeErrorCode`). Thrown or rejected by
 * the kernel; `toData()` gives the structured-clone-safe form for RPC.
 */
export class ForseeError extends Error {
  readonly code: ForseeErrorCode;
  readonly details: JsonValue | undefined;

  constructor(
    code: ForseeErrorCode,
    message: string,
    options?: { cause?: unknown; details?: JsonValue },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ForseeError';
    this.code = code;
    this.details = options?.details;
  }

  toData(): ForseeErrorData {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** True if `error` is a `ForseeError`, optionally with the given code. */
export function isForseeError(error: unknown, code?: ForseeErrorCode): error is ForseeError {
  return error instanceof ForseeError && (code === undefined || error.code === code);
}

/**
 * Receives errors that must not propagate to the caller: a throwing event
 * listener, a failed background save. `context` says where it happened, for
 * example `"event:composition.changed"`.
 */
export type ErrorReporter = (error: unknown, context: string) => void;

/**
 * Default reporter: surfaces the error as an unhandled promise rejection, so
 * it appears in the browser console and fails Vitest runs, without breaking
 * the code that reported it.
 */
export const defaultErrorReporter: ErrorReporter = (error, context) => {
  const wrapped =
    error instanceof Error ? error : new Error(`${context}: ${String(error)}`, { cause: error });
  void Promise.reject(wrapped);
};
