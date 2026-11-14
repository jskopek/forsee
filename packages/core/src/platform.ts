import type { Disposable } from '@forsee/plugin-api';

/**
 * Platform services that engine code receives by injection. Engine packages
 * never call `Date.now`, `performance.now`, `setTimeout` or `crypto`
 * directly; they take these interfaces, so tests can use `FakeClock` and
 * `SequentialIdSource`. Real implementations live in `@forsee/host`.
 */

/** Time and timers. */
export interface Clock {
  /**
   * Monotonic milliseconds (like `performance.now()`), with sub-millisecond
   * precision where available. Never decreases. Unrelated to wall time.
   */
  now(): number;
  /** Wall-clock milliseconds since the Unix epoch (like `Date.now()`). May jump. */
  wallNow(): number;
  /**
   * Calls `callback` once after at least `delayMs` (clamped to >= 0).
   * Disposing before it fires cancels it.
   */
  setTimeout(callback: () => void, delayMs: number): Disposable;
  /** Calls `callback` every `intervalMs` (> 0) until disposed. */
  setInterval(callback: () => void, intervalMs: number): Disposable;
}

/** Identifiers and randomness. */
export interface IdSource {
  /** A new RFC 4122 version 4 UUID string, lower case. */
  uuid(): string;
  /** A float in [0, 1). Not for cryptographic use. */
  random(): number;
}

/** Kind of an entry in a directory listing. */
export type FileKind = 'file' | 'directory';

/** One entry of `ProfileFileSystem.list`. */
export interface FileEntry {
  /** Name within the directory (no slashes). */
  readonly name: string;
  readonly kind: FileKind;
}

/**
 * The profile folder (plan section 7). Paths are relative to the profile
 * root, use `/` separators, have no leading `/`, no empty, `.` or `..`
 * segments, and no trailing `/`; the root itself is `""` (only valid for
 * `list` and `exists`). Writes create missing parent directories. Text is
 * UTF-8.
 *
 * Errors reject with `FileSystemError`.
 */
export interface ProfileFileSystem {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** Replaces the file atomically where the platform allows (write to temp, rename). */
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Appends to the file, creating it if missing. Used for `.jsonl` logs. */
  appendText(path: string, text: string): Promise<void>;
  /** Entries of a directory, sorted by name. Rejects with `not-found` if missing. */
  list(path: string): Promise<readonly FileEntry[]>;
  /** Deletes a file, or a directory with `recursive`. Missing paths are not an error. */
  delete(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Why a file system call failed. */
export type FileSystemErrorCode =
  'not-found' | 'invalid-path' | 'is-directory' | 'not-directory' | 'not-empty' | 'io';

/** Error thrown by `ProfileFileSystem` implementations. */
export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;
  readonly path: string;

  constructor(code: FileSystemErrorCode, path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = 'FileSystemError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Validates a profile path and returns its segments (empty array for the
 * root `""`). Throws `FileSystemError('invalid-path')`.
 */
export function splitProfilePath(path: string): string[] {
  if (path === '') return [];
  if (path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
    throw new FileSystemError('invalid-path', path);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\0')) {
      throw new FileSystemError('invalid-path', path);
    }
  }
  return segments;
}
