import {
  decodeUtf8,
  encodeUtf8,
  FileSystemError,
  splitProfilePath,
  type FileEntry,
  type ProfileFileSystem,
} from '@forsee/core';

/**
 * A `ProfileFileSystem` on a flat key-value store (IndexedDB in browsers
 * without a usable Origin Private File System). Files are stored under their
 * full path; folders are implicit, so an empty folder does not exist.
 */

/** The little a flat store must offer. */
export interface KeyValueBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  /** Resolves once the value is durably stored. */
  put(key: string, value: Uint8Array): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export class KeyValueFileSystem implements ProfileFileSystem {
  /** Mutations run one at a time: each is a read-modify-write across several keys. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly backend: KeyValueBackend) {}

  async readText(path: string): Promise<string> {
    return decodeUtf8(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('is-directory', path);
    await this.chain;
    const data = await this.backend.get(path);
    if (data) return data.slice();
    const keys = await this.backend.keys();
    if (hasChildren(keys, path)) throw new FileSystemError('is-directory', path);
    throw new FileSystemError('not-found', path);
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, encodeUtf8(text));
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    const copy = bytes.slice();
    await this.mutate(async () => {
      await this.assertWritable(path, segments);
      await this.backend.put(path, copy);
    });
  }

  async appendText(path: string, text: string): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    const added = encodeUtf8(text);
    await this.mutate(async () => {
      await this.assertWritable(path, segments);
      const before = (await this.backend.get(path)) ?? new Uint8Array(0);
      const data = new Uint8Array(before.length + added.length);
      data.set(before, 0);
      data.set(added, before.length);
      await this.backend.put(path, data);
    });
  }

  async list(path: string): Promise<readonly FileEntry[]> {
    const segments = splitProfilePath(path);
    await this.chain;
    const keys = await this.backend.keys();
    if (segments.length > 0 && !hasChildren(keys, path)) {
      if (keys.includes(path)) throw new FileSystemError('not-directory', path);
      throw new FileSystemError('not-found', path);
    }
    const prefix = path === '' ? '' : `${path}/`;
    const found = new Map<string, FileEntry['kind']>();
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) found.set(rest, 'file');
      else found.set(rest.slice(0, slash), 'directory');
    }
    return [...found]
      .map(([name, kind]): FileEntry => ({ name, kind }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async delete(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    await this.mutate(async () => {
      const keys = await this.backend.keys();
      const children = keys.filter((k) => k.startsWith(`${path}/`));
      if (children.length > 0 && options?.recursive !== true) {
        throw new FileSystemError('not-empty', path);
      }
      const doomed = keys.filter((k) => k === path || k.startsWith(`${path}/`));
      if (doomed.length > 0) await this.backend.remove(doomed);
    });
  }

  async exists(path: string): Promise<boolean> {
    const segments = splitProfilePath(path);
    if (segments.length === 0) return true;
    await this.chain;
    const keys = await this.backend.keys();
    return keys.includes(path) || hasChildren(keys, path);
  }

  private mutate(task: () => Promise<void>): Promise<void> {
    const result = this.chain.then(task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** A file cannot replace a folder, and no parent may be a file. */
  private async assertWritable(path: string, segments: readonly string[]): Promise<void> {
    const keys = await this.backend.keys();
    if (hasChildren(keys, path)) throw new FileSystemError('is-directory', path);
    for (let i = 1; i < segments.length; i += 1) {
      if (keys.includes(segments.slice(0, i).join('/'))) {
        throw new FileSystemError('not-directory', path);
      }
    }
  }
}

function hasChildren(keys: readonly string[], path: string): boolean {
  const prefix = `${path}/`;
  return keys.some((k) => k.startsWith(prefix));
}

/* ---------------------------------------------------------------- IndexedDB */

/** Structural subsets of the IndexedDB types, so tests can pass fakes. */
export interface IdbRequestLike<T> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  getAllKeys(): IdbRequestLike<readonly unknown[]>;
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  readonly error: unknown;
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(store: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  close(): void;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((event: unknown) => void) | null;
  onblocked: ((event: unknown) => void) | null;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

const STORE = 'files';

function failure(error: unknown, what: string): Error {
  if (error instanceof Error) return error;
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : 'IndexedDB error';
  return new Error(`${what}: ${name}`);
}

/** Opens (creating if needed) an IndexedDB database as a `KeyValueBackend`. */
export function openIndexedDbBackend(
  factory: IdbFactoryLike,
  databaseName = 'forsee-profile',
): Promise<KeyValueBackend> {
  return new Promise<IdbDatabaseLike>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error, 'Cannot open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).then((db): KeyValueBackend => {
    const read = <T>(make: (store: IdbObjectStoreLike) => IdbRequestLike<unknown>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const request = make(db.transaction(STORE, 'readonly').objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(failure(request.error, 'IndexedDB read failed'));
      });
    const write = (apply: (store: IdbObjectStoreLike) => void): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(failure(tx.error, 'IndexedDB write failed'));
        tx.onabort = () => reject(failure(tx.error, 'IndexedDB write aborted'));
        apply(tx.objectStore(STORE));
      });
    return {
      async get(key) {
        const value = await read<unknown>((s) => s.get(key));
        return value instanceof Uint8Array ? value : undefined;
      },
      put: (key, value) =>
        write((s) => {
          s.put(value, key);
        }),
      remove: (keys) =>
        write((s) => {
          for (const key of keys) s.delete(key);
        }),
      async keys() {
        const keys = await read<readonly unknown[]>((s) => s.getAllKeys());
        return keys.filter((k): k is string => typeof k === 'string');
      },
    };
  });
}
