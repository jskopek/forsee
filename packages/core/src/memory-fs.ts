import {
  FileSystemError,
  splitProfilePath,
  type FileEntry,
  type ProfileFileSystem,
} from './platform';
import { decodeUtf8, encodeUtf8 } from './utf8';

type Node = { kind: 'file'; data: Uint8Array } | { kind: 'directory'; children: Map<string, Node> };

/**
 * An in-memory `ProfileFileSystem`. Used by `createMemoryHost`, by the web
 * host until persistent browser storage lands, and by tests. Byte arrays are
 * copied on the way in and out, so callers cannot mutate stored data.
 */
export class MemoryFileSystem implements ProfileFileSystem {
  private readonly root: Node & { kind: 'directory' } = { kind: 'directory', children: new Map() };

  readText(path: string): Promise<string> {
    return this.run(() => decodeUtf8(this.readFile(path)));
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.run(() => this.readFile(path).slice());
  }

  writeText(path: string, text: string): Promise<void> {
    return this.run(() => this.writeFile(path, encodeUtf8(text)));
  }

  writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    return this.run(() => this.writeFile(path, bytes.slice()));
  }

  appendText(path: string, text: string): Promise<void> {
    return this.run(() => {
      const existing = this.lookup(path);
      if (existing?.kind === 'directory') throw new FileSystemError('is-directory', path);
      const added = encodeUtf8(text);
      const before = existing?.data ?? new Uint8Array(0);
      const data = new Uint8Array(before.length + added.length);
      data.set(before, 0);
      data.set(added, before.length);
      this.writeFile(path, data);
    });
  }

  list(path: string): Promise<readonly FileEntry[]> {
    return this.run(() => {
      const node = this.lookup(path);
      if (!node) throw new FileSystemError('not-found', path);
      if (node.kind !== 'directory') throw new FileSystemError('not-directory', path);
      return [...node.children.entries()]
        .map(([name, child]): FileEntry => ({ name, kind: child.kind }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }

  delete(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    return this.run(() => {
      const segments = splitProfilePath(path);
      if (segments.length === 0) throw new FileSystemError('invalid-path', path);
      const parent = this.lookupSegments(segments.slice(0, -1));
      if (parent?.kind !== 'directory') return;
      const name = segments[segments.length - 1]!;
      const node = parent.children.get(name);
      if (!node) return;
      if (node.kind === 'directory' && node.children.size > 0 && !options?.recursive) {
        throw new FileSystemError('not-empty', path);
      }
      parent.children.delete(name);
    });
  }

  exists(path: string): Promise<boolean> {
    return this.run(() => this.lookup(path) !== undefined);
  }

  private run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private lookup(path: string): Node | undefined {
    return this.lookupSegments(splitProfilePath(path));
  }

  private lookupSegments(segments: readonly string[]): Node | undefined {
    let node: Node = this.root;
    for (const segment of segments) {
      if (node.kind !== 'directory') return undefined;
      const child = node.children.get(segment);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  private readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (!node) throw new FileSystemError('not-found', path);
    if (node.kind !== 'file') throw new FileSystemError('is-directory', path);
    return node.data;
  }

  private writeFile(path: string, data: Uint8Array): void {
    const segments = splitProfilePath(path);
    if (segments.length === 0) throw new FileSystemError('invalid-path', path);
    let dir: Node = this.root;
    for (const segment of segments.slice(0, -1)) {
      if (dir.kind !== 'directory') throw new FileSystemError('not-directory', path);
      let child = dir.children.get(segment);
      if (!child) {
        child = { kind: 'directory', children: new Map() };
        dir.children.set(segment, child);
      }
      dir = child;
    }
    if (dir.kind !== 'directory') throw new FileSystemError('not-directory', path);
    const name = segments[segments.length - 1]!;
    if (dir.children.get(name)?.kind === 'directory') {
      throw new FileSystemError('is-directory', path);
    }
    dir.children.set(name, { kind: 'file', data });
  }
}
