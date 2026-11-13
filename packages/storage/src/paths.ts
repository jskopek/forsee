import { StorageError } from './errors';

/**
 * Path safety. Every path that reaches the file system through this package
 * goes through these checks, so a document name, plugin id or archive entry
 * cannot climb out of its folder.
 */

// Control characters are rejected so names stay printable and portable.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Validates one path segment (a file or folder name): non-empty, not `.` or
 * `..`, no separators, no drive-letter colon, no control characters.
 */
export function assertSafeSegment(segment: string, what = 'name'): void {
  if (
    typeof segment !== 'string' ||
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes(':') ||
    CONTROL.test(segment)
  ) {
    throw new StorageError('invalid-path', `Unsafe ${what}: ${JSON.stringify(segment)}`);
  }
}

/**
 * Validates a profile-relative path and returns its segments. Rejects `..`,
 * `.`, empty segments (so also leading, trailing and doubled slashes),
 * absolute paths, backslashes, colons and control characters.
 */
export function assertSafePath(path: string): string[] {
  if (typeof path !== 'string' || path === '') {
    throw new StorageError('invalid-path', 'Path must not be empty');
  }
  const segments = path.split('/');
  for (const segment of segments) assertSafeSegment(segment, 'path segment');
  return segments;
}

/** Directory part of a path (`""` for a top-level entry). */
export function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

const PLUGIN_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Validates a plugin id (dot-separated `[a-z0-9-]` segments) so it is safe as a folder name. */
export function assertPluginId(id: string): void {
  if (typeof id !== 'string' || !PLUGIN_ID.test(id) || id.length > 128) {
    throw new StorageError('invalid-path', `Invalid plugin id: ${JSON.stringify(id)}`);
  }
}
