import { FileSystemError, MemoryFileSystem, type ProfileFileSystem } from '@forsee/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserFileSystem,
  KeyValueFileSystem,
  OpfsFileSystem,
  openIndexedDbBackend,
  type IdbDatabaseLike,
  type IdbFactoryLike,
  type IdbObjectStoreLike,
  type IdbOpenRequestLike,
  type IdbRequestLike,
  type IdbTransactionLike,
  type KeyValueBackend,
  type OpfsDirectoryHandleLike,
  type OpfsFileHandleLike,
  type OpfsWritableLike,
} from './index';

/* ----------------------------------------------------------- fake OPFS */

class DomError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

type FakeNode = FakeDir | FakeFile;

class FakeFile implements OpfsFileHandleLike {
  readonly kind = 'file';
  data = new Uint8Array(0);
  writers = 0;
  /** Makes `close` fail, to test cleanup. */
  failClose = false;

  getFile() {
    const data = this.data;
    return Promise.resolve({
      size: data.length,
      arrayBuffer: () => Promise.resolve(data.slice().buffer),
    });
  }

  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableLike> {
    // Real OPFS refuses a second writable while one is open.
    if (this.writers > 0) return Promise.reject(new DomError('NoModificationAllowedError'));
    this.writers += 1;
    let staged = options?.keepExistingData ? this.data.slice() : new Uint8Array(0);
    let cursor = 0;
    const put = (position: number, chunk: Uint8Array) => {
      const next = new Uint8Array(Math.max(staged.length, position + chunk.length));
      next.set(staged);
      next.set(chunk, position);
      staged = next;
      cursor = position + chunk.length;
    };
    return Promise.resolve({
      write: (arg) => {
        if (arg instanceof Uint8Array) put(cursor, arg);
        else put(arg.position, arg.data);
        return Promise.resolve();
      },
      close: () => {
        this.writers -= 1;
        if (this.failClose) return Promise.reject(new Error('quota'));
        this.data = staged; // commit on close: all or nothing
        return Promise.resolve();
      },
      abort: () => {
        this.writers = Math.max(0, this.writers - 1);
        return Promise.resolve();
      },
    });
  }
}

class FakeDir implements OpfsDirectoryHandleLike {
  readonly kind = 'directory';
  readonly children = new Map<string, FakeNode>();

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDir> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFile) return Promise.reject(new DomError('TypeMismatchError'));
    if (existing) return Promise.resolve(existing);
    if (!options?.create) return Promise.reject(new DomError('NotFoundError'));
    const dir = new FakeDir();
    this.children.set(name, dir);
    return Promise.resolve(dir);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDir) return Promise.reject(new DomError('TypeMismatchError'));
    if (existing) return Promise.resolve(existing);
    if (!options?.create) return Promise.reject(new DomError('NotFoundError'));
    const file = new FakeFile();
    this.children.set(name, file);
    return Promise.resolve(file);
  }

  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) return Promise.reject(new DomError('NotFoundError'));
    if (existing instanceof FakeDir && existing.children.size > 0 && !options?.recursive) {
      return Promise.reject(new DomError('InvalidModificationError'));
    }
    this.children.delete(name);
    return Promise.resolve();
  }

  async *entries(): AsyncIterable<[string, FakeNode]> {
    await Promise.resolve();
    for (const entry of [...this.children]) yield entry;
  }
}

/* ----------------------------------------------------------- fake IndexedDB */

class FakeIdb implements IdbFactoryLike {
  readonly stores = new Map<string, Map<string, unknown>>();
  opens = 0;
  failOpen = false;

  open(name: string): IdbOpenRequestLike {
    this.opens += 1;
    const request = {
      result: undefined as unknown as IdbDatabaseLike,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    } as IdbOpenRequestLike & { result: IdbDatabaseLike; error: unknown };
    const names = new Set<string>(this.stores.has(name) ? ['files'] : []);
    const data = this.stores.get(name) ?? new Map<string, unknown>();
    const db: IdbDatabaseLike = {
      objectStoreNames: { contains: (n) => names.has(n) },
      createObjectStore: (n) => {
        names.add(n);
        this.stores.set(name, data);
      },
      transaction: () => fakeTransaction(data),
      close: () => undefined,
    };
    request.result = db;
    void Promise.resolve().then(() => {
      if (this.failOpen) {
        request.error = new DomError('SecurityError');
        request.onerror?.({});
        return;
      }
      if (names.size === 0) request.onupgradeneeded?.({});
      request.onsuccess?.({});
    });
    return request;
  }
}

function fakeTransaction(data: Map<string, unknown>): IdbTransactionLike {
  let pending = 0;
  const tx = {
    error: null as unknown,
    oncomplete: null as ((e: unknown) => void) | null,
    onerror: null,
    onabort: null,
    objectStore: (): IdbObjectStoreLike => {
      const request = <T>(run: () => T): IdbRequestLike<T> => {
        pending += 1;
        const req = { result: undefined as T, error: null, onsuccess: null, onerror: null } as {
          result: T;
          error: unknown;
          onsuccess: ((e: unknown) => void) | null;
          onerror: ((e: unknown) => void) | null;
        };
        void Promise.resolve().then(() => {
          req.result = run();
          req.onsuccess?.({});
          pending -= 1;
          if (pending === 0) void Promise.resolve().then(() => tx.oncomplete?.({}));
        });
        return req;
      };
      return {
        get: (key) => request(() => data.get(key)),
        put: (value, key) =>
          request(() => {
            data.set(key, value);
            return key;
          }),
        delete: (key) =>
          request(() => {
            data.delete(key);
            return undefined;
          }),
        getAllKeys: () => request(() => [...data.keys()]),
      };
    },
  };
  return tx;
}

/* ----------------------------------------------------------- conformance */

class MemoryBackend implements KeyValueBackend {
  readonly map = new Map<string, Uint8Array>();
  get(key: string) {
    return Promise.resolve(this.map.get(key)?.slice());
  }
  put(key: string, value: Uint8Array) {
    this.map.set(key, value.slice());
    return Promise.resolve();
  }
  remove(keys: readonly string[]) {
    for (const k of keys) this.map.delete(k);
    return Promise.resolve();
  }
  keys() {
    return Promise.resolve([...this.map.keys()]);
  }
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof FileSystemError ? e.code : `other:${String(e)}`),
  );

function conformance(label: string, make: () => Promise<ProfileFileSystem> | ProfileFileSystem) {
  describe(`${label} as a ProfileFileSystem`, () => {
    it('writes and reads text and bytes, creating parents', async () => {
      const fs = await make();
      await fs.writeText('a/b/c.json', '{"é":"✓"}');
      expect(await fs.readText('a/b/c.json')).toBe('{"é":"✓"}');
      await fs.writeBytes('bin', Uint8Array.from([0, 255, 7]));
      expect([...(await fs.readBytes('bin'))]).toEqual([0, 255, 7]);
      await fs.writeText('bin', 'replaced and shorter');
      expect(await fs.readText('bin')).toBe('replaced and shorter');
    });

    it('does not let callers mutate stored data', async () => {
      const fs = await make();
      const input = Uint8Array.from([1, 2, 3]);
      await fs.writeBytes('x', input);
      input[0] = 9;
      const out = await fs.readBytes('x');
      out[1] = 9;
      expect([...(await fs.readBytes('x'))]).toEqual([1, 2, 3]);
    });

    it('appends, creating the file when missing', async () => {
      const fs = await make();
      await fs.appendText('log/a.jsonl', 'one\n');
      await fs.appendText('log/a.jsonl', 'two\n');
      expect(await fs.readText('log/a.jsonl')).toBe('one\ntwo\n');
    });

    it('lists sorted entries with kinds, and reports missing and non-directories', async () => {
      const fs = await make();
      expect(await fs.list('')).toEqual([]);
      await fs.writeText('b.txt', '');
      await fs.writeText('a/x', '');
      await fs.writeText('a/y/z', '');
      expect(await fs.list('')).toEqual([
        { name: 'a', kind: 'directory' },
        { name: 'b.txt', kind: 'file' },
      ]);
      expect(await fs.list('a')).toEqual([
        { name: 'x', kind: 'file' },
        { name: 'y', kind: 'directory' },
      ]);
      expect(await codeOf(fs.list('nope'))).toBe('not-found');
      expect(await codeOf(fs.list('b.txt'))).toBe('not-directory');
    });

    it('reports errors with FileSystemError codes', async () => {
      const fs = await make();
      await fs.writeText('f', 'x');
      await fs.writeText('d/inner', 'x');
      expect(await codeOf(fs.readText('missing'))).toBe('not-found');
      expect(await codeOf(fs.readText('d'))).toBe('is-directory');
      expect(await codeOf(fs.readText('f/under'))).toMatch(/not-found|not-directory/);
      expect(await codeOf(fs.writeText('d', 'x'))).toBe('is-directory');
      expect(await codeOf(fs.writeText('f/under', 'x'))).toBe('not-directory');
      expect(await codeOf(fs.readText('../x'))).toBe('invalid-path');
      expect(await codeOf(fs.writeText('a//b', 'x'))).toBe('invalid-path');
      expect(await codeOf(fs.writeText('', 'x'))).toMatch(/invalid-path|is-directory/);
      expect(await codeOf(fs.delete(''))).toBe('invalid-path');
    });

    it('deletes files and folders, tolerating missing paths', async () => {
      const fs = await make();
      await fs.writeText('d/a', '1');
      await fs.writeText('d/e/b', '2');
      await fs.writeText('keep', '3');
      expect(await codeOf(fs.delete('d'))).toBe('not-empty');
      await fs.delete('d/a');
      await fs.delete('d/a');
      await fs.delete('nothing/at/all');
      await fs.delete('d', { recursive: true });
      expect(await fs.exists('d')).toBe(false);
      expect(await fs.exists('d/e/b')).toBe(false);
      expect(await fs.exists('keep')).toBe(true);
    });

    it('answers exists for files, folders and the root', async () => {
      const fs = await make();
      await fs.writeText('d/f', '');
      expect(await fs.exists('')).toBe(true);
      expect(await fs.exists('d')).toBe(true);
      expect(await fs.exists('d/f')).toBe(true);
      expect(await fs.exists('d/g')).toBe(false);
      expect(await fs.exists('d/f/deeper')).toBe(false);
    });

    it('keeps concurrent appends complete and ordered', async () => {
      const fs = await make();
      await Promise.all(Array.from({ length: 25 }, (_, i) => fs.appendText('log', `${i}\n`)));
      expect((await fs.readText('log')).split('\n').filter(Boolean)).toEqual(
        Array.from({ length: 25 }, (_, i) => String(i)),
      );
    });

    it('serialises concurrent writes to one file', async () => {
      const fs = await make();
      await Promise.all(Array.from({ length: 10 }, (_, i) => fs.writeText('w', `v${i}`)));
      expect(await fs.readText('w')).toBe('v9');
    });
  });
}

conformance('MemoryFileSystem (reference)', () => new MemoryFileSystem());
conformance('OpfsFileSystem', () => new OpfsFileSystem(new FakeDir()));
conformance('KeyValueFileSystem', () => new KeyValueFileSystem(new MemoryBackend()));
conformance('KeyValueFileSystem on IndexedDB', async () => {
  return new KeyValueFileSystem(await openIndexedDbBackend(new FakeIdb(), 'db'));
});

/* ----------------------------------------------------------- specifics */

describe('OpfsFileSystem', () => {
  it('stages writes and keeps the old content if the write fails', async () => {
    const root = new FakeDir();
    const fs = new OpfsFileSystem(root);
    await fs.writeText('f', 'old');
    const file = root.children.get('f') as FakeFile;
    file.failClose = true;
    expect(await codeOf(fs.writeText('f', 'new'))).toBe('io');
    file.failClose = false;
    expect(await fs.readText('f')).toBe('old');
    await fs.writeText('f', 'newer'); // the failed writer was released
    expect(await fs.readText('f')).toBe('newer');
  });

  it('wraps unknown failures as io errors', async () => {
    const root = new FakeDir();
    root.getDirectoryHandle = () => Promise.reject(new DomError('SecurityError'));
    expect(await codeOf(new OpfsFileSystem(root).readText('a/b'))).toBe('io');
  });
});

describe('createBrowserFileSystem', () => {
  const opfsEnv = (root = new FakeDir()) => ({
    navigator: {
      storage: {
        getDirectory: () => Promise.resolve(root),
        persist: vi.fn(() => Promise.resolve(true)),
      },
    },
  });

  it('prefers OPFS, keeps the profile in a named folder, and requests persistence', async () => {
    const root = new FakeDir();
    const environment = { ...opfsEnv(root), indexedDB: new FakeIdb() };
    const result = await createBrowserFileSystem({ environment });
    expect(result).toMatchObject({ kind: 'opfs', persistent: true });
    await result.files.writeText('profile.json', '{}');
    const folder = root.children.get('forsee-profile') as FakeDir;
    expect(folder.children.has('profile.json')).toBe(true);
    expect(folder.children.has('.forsee-probe')).toBe(false);
    expect(environment.navigator.storage.persist).toHaveBeenCalled();
    expect(environment.indexedDB.opens).toBe(0);
  });

  it('persists across a reload (a second call sees the same data)', async () => {
    const root = new FakeDir();
    const first = await createBrowserFileSystem({ environment: opfsEnv(root) });
    await first.files.writeText('settings.json', '{"a":1}');
    const second = await createBrowserFileSystem({ environment: opfsEnv(root) });
    expect(await second.files.readText('settings.json')).toBe('{"a":1}');
  });

  it('falls back to IndexedDB when OPFS is missing', async () => {
    const idb = new FakeIdb();
    const result = await createBrowserFileSystem({ environment: { indexedDB: idb } });
    expect(result).toMatchObject({ kind: 'indexeddb', persistent: true });
    await result.files.writeText('a/b', 'hello');
    const again = await createBrowserFileSystem({ environment: { indexedDB: idb } });
    expect(await again.files.readText('a/b')).toBe('hello');
  });

  it('falls back to IndexedDB when OPFS cannot write (no createWritable)', async () => {
    const root = new FakeDir();
    const noWritable = new FakeFile();
    noWritable.createWritable = () =>
      Promise.reject(new TypeError('createWritable is not a function'));
    root.getDirectoryHandle = () => {
      const dir = new FakeDir();
      dir.getFileHandle = () => Promise.resolve(noWritable);
      return Promise.resolve(dir);
    };
    const onFallback = vi.fn<(from: string, reason: unknown) => void>();
    const result = await createBrowserFileSystem({
      environment: { ...opfsEnv(root), indexedDB: new FakeIdb() },
      onFallback,
    });
    expect(result.kind).toBe('indexeddb');
    expect(onFallback).toHaveBeenCalledWith('opfs', expect.anything());
  });

  it('falls back to IndexedDB when getDirectory rejects (private window)', async () => {
    const result = await createBrowserFileSystem({
      environment: {
        navigator: {
          storage: { getDirectory: () => Promise.reject(new DomError('SecurityError')) },
        },
        indexedDB: new FakeIdb(),
      },
    });
    expect(result.kind).toBe('indexeddb');
  });

  it('falls back to memory when nothing persistent works', async () => {
    const idb = new FakeIdb();
    idb.failOpen = true;
    const onFallback = vi.fn<(from: string, reason: unknown) => void>();
    const result = await createBrowserFileSystem({
      environment: {
        navigator: {
          storage: { getDirectory: () => Promise.reject(new DomError('SecurityError')) },
        },
        indexedDB: idb,
      },
      onFallback,
    });
    expect(result).toMatchObject({ kind: 'memory', persistent: false });
    expect(result.files).toBeInstanceOf(MemoryFileSystem);
    expect(onFallback.mock.calls.map((c) => c[0])).toEqual(['opfs', 'indexeddb']);
    await result.files.writeText('x', 'still works');
    expect(await result.files.readText('x')).toBe('still works');
  });

  it('uses memory when the browser offers neither API', async () => {
    expect((await createBrowserFileSystem({ environment: {} })).kind).toBe('memory');
  });

  it('survives a throwing persist()', async () => {
    const root = new FakeDir();
    const result = await createBrowserFileSystem({
      environment: {
        navigator: {
          storage: {
            getDirectory: () => Promise.resolve(root),
            persist: () => {
              throw new Error('nope');
            },
          },
        },
      },
    });
    expect(result.kind).toBe('opfs');
  });
});
