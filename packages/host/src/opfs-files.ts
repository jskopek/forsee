import {
  decodeUtf8,
  encodeUtf8,
  FileSystemError,
  splitProfilePath,
  type FileEntry,
  type ProfileFileSystem,
} from '@forsee/core';

/**
 * A `ProfileFileSystem` on the Origin Private File System. The handle types
 * are structural subsets of the DOM's, so tests can pass fakes and this file
 * does not depend on a particular `lib.dom` version.
 */

export interface OpfsFileLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsWritableLike {
  write(data: Uint8Array | { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface OpfsFileHandleLike {
  readonly kind: 'file';
  getFile(): Promise<OpfsFileLike>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableLike>;
}

export interface OpfsDirectoryHandleLike {
  readonly kind: 'directory';
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, OpfsDirectoryHandleLike | OpfsFileHandleLike]>;
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

/**
 * Maps a DOM exception to a `FileSystemError`. `typeMismatch` says what a
 * `TypeMismatchError` means in the calling context.
 */
function mapError(
  error: unknown,
  path: string,
  typeMismatch: 'is-directory' | 'not-directory',
): FileSystemError {
  if (error instanceof FileSystemError) return error;
  switch (errorName(error)) {
    case 'NotFoundError':
      return new FileSystemError('not-found', path);
    case 'TypeMismatchError':
      return new FileSystemError(typeMismatch, path);
    case 'InvalidModificationError':
      return new FileSystemError('not-empty', path);
    case 'TypeError':
      return new FileSystemError('invalid-path', path);
    default:
      return new FileSystemError(
        'io',
        path,
        error instanceof Error ? `${error.name}: ${error.message}` : `io: ${path}`,
      );
  }
}

/** Writes to one path are serialised: a second `createWritable` on a file that is open fails. */
class PathLocks {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export class OpfsFileSystem implements ProfileFileSystem {
  private readonly locks = new PathLocks();

  /** @param root the directory that holds the profile (the profile's root folder). */
  constructor(private readonly root: OpfsDirectoryHandleLike) {}

  async readText(path: string): Promise<string> {
    return decodeUtf8(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('is-directory', path);
    await this.settled(path);
    try {
      const dir = await this.directory(segments.slice(0, -1), false, path);
      const handle = await dir.getFileHandle(segments[segments.length - 1]!);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      throw mapError(error, path, 'is-directory');
    }
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, encodeUtf8(text));
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    await this.locks.run(path, async () => {
      try {
        const dir = await this.directory(segments.slice(0, -1), true, path);
        const handle = await dir.getFileHandle(segments[segments.length - 1]!, { create: true });
        // A writable stream stages the data in a swap file and replaces the
        // original on close, so a crash leaves either the old or the new content.
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw mapError(error, path, 'is-directory');
      }
    });
  }

  async appendText(path: string, text: string): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    const added = encodeUtf8(text);
    await this.locks.run(path, async () => {
      try {
        const dir = await this.directory(segments.slice(0, -1), true, path);
        const handle = await dir.getFileHandle(segments[segments.length - 1]!, { create: true });
        const size = (await handle.getFile()).size;
        const writable = await handle.createWritable({ keepExistingData: true });
        try {
          await writable.write({ type: 'write', position: size, data: added });
          await writable.close();
        } catch (error) {
          await writable.abort?.().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw mapError(error, path, 'is-directory');
      }
    });
  }

  async list(path: string): Promise<readonly FileEntry[]> {
    const segments = splitProfilePath(path);
    try {
      const dir = await this.directory(segments, false, path);
      const entries: FileEntry[] = [];
      for await (const [name, handle] of dir.entries()) {
        entries.push({ name, kind: handle.kind });
      }
      return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      throw mapError(error, path, 'not-directory');
    }
  }

  async delete(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    await this.locks.run(path, async () => {
      let dir: OpfsDirectoryHandleLike;
      try {
        dir = await this.directory(segments.slice(0, -1), false, path);
      } catch (error) {
        const mapped = mapError(error, path, 'not-directory');
        if (mapped.code === 'not-found' || mapped.code === 'not-directory') return;
        throw mapped;
      }
      try {
        await dir.removeEntry(segments[segments.length - 1]!, {
          recursive: options?.recursive === true,
        });
      } catch (error) {
        const mapped = mapError(error, path, 'is-directory');
        if (mapped.code !== 'not-found') throw mapped;
      }
    });
  }

  async exists(path: string): Promise<boolean> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) return true;
    try {
      const dir = await this.directory(segments.slice(0, -1), false, path);
      const name = segments[segments.length - 1]!;
      try {
        await dir.getFileHandle(name);
        return true;
      } catch (error) {
        if (errorName(error) !== 'TypeMismatchError') throw error;
        return true; // it is a directory
      }
    } catch (error) {
      const mapped = mapError(error, path, 'not-directory');
      if (mapped.code === 'not-found' || mapped.code === 'not-directory') return false;
      throw mapped;
    }
  }

  /** Waits for writes to `path` submitted before this call. */
  private settled(path: string): Promise<void> {
    return this.locks.run(path, () => Promise.resolve());
  }

  /** Resolves a folder; a file in the way is `not-directory`, a missing folder `not-found`. */
  private async directory(
    segments: readonly string[],
    create: boolean,
    path: string,
  ): Promise<OpfsDirectoryHandleLike> {
    let dir = this.root;
    try {
      for (const name of segments) {
        dir = await dir.getDirectoryHandle(name, { create });
      }
    } catch (error) {
      throw mapError(error, path, 'not-directory');
    }
    return dir;
  }
}
