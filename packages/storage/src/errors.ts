import type { JsonValue } from '@forsee/plugin-api';

/** Why a storage operation failed. */
export type StorageErrorCode =
  /** A path or name escapes its folder or is otherwise unsafe. */
  | 'invalid-path'
  /** A stored document is not valid JSON or has the wrong shape. */
  | 'corrupt'
  /** `profile.json` is missing or invalid. */
  | 'invalid-profile'
  /** The profile was written by a newer schema than this build understands. */
  | 'newer-schema'
  /** A migration failed or the migration chain is incomplete. */
  | 'migration-failed'
  /** The archive is not a valid profile export. */
  | 'invalid-archive'
  /** The import target already holds a profile. */
  | 'not-empty'
  /** A caller-supplied validation hook rejected a document. */
  | 'invalid-document';

/** Error thrown by the storage package, with a stable `code`. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: JsonValue | undefined;

  constructor(
    code: StorageErrorCode,
    message: string,
    options?: { cause?: unknown; details?: JsonValue },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
    this.details = options?.details;
  }
}

/** True if `error` is a `StorageError`, optionally with the given code. */
export function isStorageError(error: unknown, code?: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && (code === undefined || error.code === code);
}
