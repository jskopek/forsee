import { FileSystemError, type ErrorReporter, type ProfileFileSystem } from '@forsee/core';
import type { JsonValue } from '@forsee/plugin-api';
import type { Store } from './contracts';
import { StorageError } from './errors';
import { assertSafePath } from './paths';
import { WriteQueue } from './write-queue';

/** Options for `FileStore`. */
export interface FileStoreOptions {
  /**
   * Receives write failures (also delivered to the caller) and skipped
   * corrupt log lines. Default: ignore. Must not throw.
   */
  readonly reportError?: ErrorReporter;
}

const NEWLINE = 10;

/** True if `error` means the path does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof FileSystemError && error.code === 'not-found';
}

/**
 * `Store` on a `ProfileFileSystem`: pretty-printed JSON documents and
 * append-only JSONL logs.
 *
 * Every mutation of a path goes through a per-path queue, so concurrent
 * writers never interleave and reads wait for writes submitted before them.
 * Documents are replaced with a single `writeText`; the `ProfileFileSystem`
 * contract says implementations replace atomically where the platform allows
 * (write to temp, then rename), and this class relies on that rather than
 * renaming itself, because the interface has no rename.
 */
export class FileStore implements Store {
  private readonly queue: WriteQueue;
  private readonly reportError: ErrorReporter;
  /** Log files known to end with a newline (or not exist), so appends need no check. */
  private readonly cleanEnds = new Set<string>();

  constructor(
    readonly files: ProfileFileSystem,
    options: FileStoreOptions = {},
  ) {
    this.reportError =
      options.reportError ??
      (() => {
        // ignore
      });
    this.queue = new WriteQueue(this.reportError);
  }

  async getDocument(path: string): Promise<JsonValue | undefined> {
    assertSafePath(path);
    await this.queue.idle(path);
    return this.readDocument(path);
  }

  async putDocument(path: string, value: JsonValue): Promise<void> {
    assertSafePath(path);
    await this.queue.run(path, () => this.files.writeText(path, serialise(value)));
  }

  /**
   * Atomic read-modify-write of one document, serialised with every other
   * write to `path`. `update` receives the current value (or `undefined`)
   * and returns the new one; returning `undefined` deletes the document.
   * Resolves with the stored value.
   */
  async updateDocument(
    path: string,
    update: (current: JsonValue | undefined) => JsonValue | undefined,
  ): Promise<JsonValue | undefined> {
    assertSafePath(path);
    return await this.queue.run(path, async () => {
      const next = update(await this.readDocument(path));
      if (next === undefined) await this.files.delete(path);
      else await this.files.writeText(path, serialise(next));
      return next;
    });
  }

  async deleteDocument(path: string): Promise<void> {
    assertSafePath(path);
    await this.queue.run(path, () => this.files.delete(path));
  }

  async listDocuments(directory: string): Promise<readonly string[]> {
    if (directory !== '') assertSafePath(directory);
    let entries;
    try {
      entries = await this.files.list(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return entries
      .filter((e) => e.kind === 'file' && e.name.endsWith('.json'))
      .map((e) => (directory === '' ? e.name : `${directory}/${e.name}`))
      .sort();
  }

  async appendLog(path: string, records: readonly JsonValue[]): Promise<void> {
    assertSafePath(path);
    if (records.length === 0) return;
    const lines = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await this.queue.run(path, async () => {
      try {
        // A crash mid-append can leave a last line without its newline. Start
        // on a fresh line so the next record is not glued to the torn one.
        let prefix = '';
        if (!this.cleanEnds.has(path)) {
          prefix = (await this.endsMidLine(path)) ? '\n' : '';
        }
        await this.files.appendText(path, prefix + lines);
        this.cleanEnds.add(path);
      } catch (error) {
        this.cleanEnds.delete(path);
        throw error;
      }
    });
  }

  async readLog(path: string): Promise<readonly JsonValue[]> {
    assertSafePath(path);
    await this.queue.idle(path);
    let text: string;
    try {
      text = await this.files.readText(path);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const records: JsonValue[] = [];
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        records.push(JSON.parse(line) as JsonValue);
      } catch (cause) {
        const torn = index === lines.length - 1;
        this.report(
          new StorageError(
            'corrupt',
            `${torn ? 'Truncated last' : 'Corrupt'} line ${index + 1} in ${path} skipped`,
            { cause },
          ),
          `storage.log.corrupt:${path}`,
        );
      }
    });
    return records;
  }

  /** Resolves when every write submitted so far has finished. Never rejects. */
  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** Reports a non-fatal problem to the injected reporter. */
  report(error: unknown, context: string): void {
    try {
      this.reportError(error, context);
    } catch {
      // A throwing reporter must not break storage.
    }
  }

  private async readDocument(path: string): Promise<JsonValue | undefined> {
    let text: string;
    try {
      text = await this.files.readText(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    try {
      return JSON.parse(text) as JsonValue;
    } catch (cause) {
      throw new StorageError('corrupt', `${path} is not valid JSON`, { cause });
    }
  }

  private async endsMidLine(path: string): Promise<boolean> {
    try {
      const bytes = await this.files.readBytes(path);
      return bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

function serialise(value: JsonValue): string {
  return JSON.stringify(value, null, 2) + '\n';
}
