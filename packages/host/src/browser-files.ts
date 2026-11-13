import { MemoryFileSystem, type ProfileFileSystem } from '@forsee/core';
import { KeyValueFileSystem, openIndexedDbBackend, type IdbFactoryLike } from './kv-files';
import { OpfsFileSystem, type OpfsDirectoryHandleLike } from './opfs-files';

/** Where the profile ended up. */
export type BrowserFileSystemKind = 'opfs' | 'indexeddb' | 'memory';

/** The browser globals `createBrowserFileSystem` looks at, as structural subsets so tests can pass fakes. */
export interface BrowserStorageEnvironment {
  readonly navigator?: {
    readonly storage?: {
      getDirectory?(): Promise<OpfsDirectoryHandleLike>;
      /** Asks the browser not to evict our data under storage pressure. */
      persist?(): Promise<boolean>;
    };
  };
  readonly indexedDB?: IdbFactoryLike;
}

/** Options for `createBrowserFileSystem`. */
export interface BrowserFileSystemOptions {
  /** Defaults to the real `navigator` and `indexedDB`. */
  readonly environment?: BrowserStorageEnvironment;
  /** Folder (OPFS) or database (IndexedDB) name. Default `"forsee-profile"`. */
  readonly name?: string;
  /** Called for each backend that was tried and failed, to log why persistence is unavailable. */
  readonly onFallback?: (from: Exclude<BrowserFileSystemKind, 'memory'>, reason: unknown) => void;
}

/** Result of `createBrowserFileSystem`. */
export interface BrowserFileSystem {
  readonly files: ProfileFileSystem;
  readonly kind: BrowserFileSystemKind;
  /** False for the in-memory fallback: the profile is lost on reload. */
  readonly persistent: boolean;
}

const PROBE = '.forsee-probe';

function browserEnvironment(): BrowserStorageEnvironment {
  const g = globalThis as {
    navigator?: BrowserStorageEnvironment['navigator'];
    indexedDB?: IdbFactoryLike;
  };
  return {
    ...(g.navigator ? { navigator: g.navigator } : {}),
    ...(g.indexedDB ? { indexedDB: g.indexedDB } : {}),
  };
}

/** Checks that a file system can write, read back and delete, so a half-working backend is not chosen. */
async function probe(files: ProfileFileSystem): Promise<void> {
  const bytes = Uint8Array.from([1, 2, 3]);
  await files.writeBytes(PROBE, bytes);
  const back = await files.readBytes(PROBE);
  await files.delete(PROBE);
  if (back.length !== 3 || back[2] !== 3) throw new Error('storage probe read back wrong data');
}

/**
 * Picks the best persistent `ProfileFileSystem` the browser offers:
 *
 * 1. the Origin Private File System (writes replace atomically);
 * 2. IndexedDB, when OPFS is missing or unusable (some Safari versions lack
 *    `createWritable` on the main thread, private windows may refuse);
 * 3. the in-memory file system, with `persistent: false`, so the app still
 *    works and can warn that nothing will be saved.
 *
 * Each choice is probed with a real write, not just feature-detected. Pass
 * the result's `files` to `createWebHost({ files })`.
 */
export async function createBrowserFileSystem(
  options: BrowserFileSystemOptions = {},
): Promise<BrowserFileSystem> {
  const env = options.environment ?? browserEnvironment();
  const name = options.name ?? 'forsee-profile';

  const requestPersistence = (): void => {
    try {
      void env.navigator?.storage?.persist?.().catch(() => undefined);
    } catch {
      // best effort
    }
  };

  const getDirectory = env.navigator?.storage?.getDirectory?.bind(env.navigator.storage);
  if (getDirectory) {
    try {
      const root = await (await getDirectory()).getDirectoryHandle(name, { create: true });
      const files = new OpfsFileSystem(root);
      await probe(files);
      requestPersistence();
      return { files, kind: 'opfs', persistent: true };
    } catch (error) {
      options.onFallback?.('opfs', error);
    }
  }

  if (env.indexedDB) {
    try {
      const files = new KeyValueFileSystem(await openIndexedDbBackend(env.indexedDB, name));
      await probe(files);
      requestPersistence();
      return { files, kind: 'indexeddb', persistent: true };
    } catch (error) {
      options.onFallback?.('indexeddb', error);
    }
  }

  return { files: new MemoryFileSystem(), kind: 'memory', persistent: false };
}
