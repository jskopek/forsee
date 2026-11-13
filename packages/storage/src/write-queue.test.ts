import { MemoryFileSystem, type ErrorReporter, type ProfileFileSystem } from '@forsee/core';
import { describe, expect, it } from 'vitest';
import { FileStore } from './file-store';
import { WriteQueue } from './write-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('WriteQueue', () => {
  it('runs tasks for one key strictly in order, even when earlier ones are slow', async () => {
    const queue = new WriteQueue(() => undefined);
    const log: string[] = [];
    const gate = deferred();
    const first = queue.run('a', async () => {
      log.push('1 start');
      await gate.promise;
      log.push('1 end');
    });
    const second = queue.run('a', () => {
      log.push('2');
      return Promise.resolve();
    });
    const other = queue.run('b', () => {
      log.push('b');
      return Promise.resolve();
    });
    await other;
    expect(log).toEqual(['1 start', 'b']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(['1 start', 'b', '1 end', '2']);
  });

  it('surfaces errors to the caller and the reporter, and keeps going', async () => {
    const seen: string[] = [];
    const reporter: ErrorReporter = (error, context) => {
      seen.push(`${context}:${(error as Error).message}`);
    };
    const queue = new WriteQueue(reporter);
    const failing = queue.run('k', () => Promise.reject(new Error('boom')));
    const after = queue.run('k', () => Promise.resolve('ok'));
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
    await queue.flush();
    expect(seen).toEqual(['storage.write:k:boom']);
  });

  it('flush waits for everything, including tasks queued while flushing', async () => {
    const queue = new WriteQueue(() => undefined);
    const gate = deferred();
    let done = 0;
    void queue.run('a', async () => {
      await gate.promise;
      done += 1;
      void queue.run('a', () => {
        done += 1;
        return Promise.resolve();
      });
    });
    const flushed = queue.flush().then(() => done);
    gate.resolve();
    expect(await flushed).toBe(2);
  });

  it('flush resolves even if a task failed', async () => {
    const queue = new WriteQueue(() => undefined);
    const failing = queue.run('a', () => Promise.reject(new Error('x')));
    failing.catch(() => undefined);
    await expect(queue.flush()).resolves.toBeUndefined();
  });
});

/** A file system whose appendText yields mid-way, so unserialised appends would interleave. */
class SlowFiles extends MemoryFileSystem {
  override async appendText(path: string, text: string): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await super.appendText(path, text);
  }
  override async writeText(path: string, text: string): Promise<void> {
    await Promise.resolve();
    await super.writeText(path, text);
  }
}

describe('FileStore write serialisation', () => {
  it('keeps concurrent puts to one document in submission order', async () => {
    const files: ProfileFileSystem = new SlowFiles();
    const store = new FileStore(files);
    const puts = Array.from({ length: 20 }, (_, i) => store.putDocument('x.json', { n: i }));
    await Promise.all(puts);
    expect(await store.getDocument('x.json')).toEqual({ n: 19 });
  });

  it('keeps concurrent appends complete and ordered', async () => {
    const store = new FileStore(new SlowFiles());
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => store.appendLog('log/a.jsonl', [{ i }, { i: i + 100 }])),
    );
    const records = await store.readLog('log/a.jsonl');
    expect(records).toHaveLength(60);
    expect(records.filter((_, k) => k % 2 === 0).map((r) => (r as { i: number }).i)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    );
  });

  it('reads see earlier writes, and flush resolves after all of them', async () => {
    const store = new FileStore(new SlowFiles());
    void store.putDocument('a.json', 1);
    const read = store.getDocument('a.json');
    void store.putDocument('b.json', 2);
    await store.flush();
    expect(await read).toBe(1);
    expect(await store.getDocument('b.json')).toBe(2);
  });

  it('serialises read-modify-write so no update is lost', async () => {
    const store = new FileStore(new SlowFiles());
    await Promise.all(
      Array.from({ length: 25 }, () =>
        store.updateDocument('n.json', (current) => ((current as number | undefined) ?? 0) + 1),
      ),
    );
    expect(await store.getDocument('n.json')).toBe(25);
  });

  it('reports failures to the reporter and the caller', async () => {
    const errors: string[] = [];
    class Failing extends MemoryFileSystem {
      override writeText(): Promise<void> {
        return Promise.reject(new Error('disk full'));
      }
    }
    const store = new FileStore(new Failing(), { reportError: (_e, ctx) => errors.push(ctx) });
    await expect(store.putDocument('a.json', 1)).rejects.toThrow('disk full');
    expect(errors).toEqual(['storage.write:a.json']);
  });

  it('rejects unsafe paths before touching the file system', async () => {
    const store = new FileStore(new MemoryFileSystem());
    await expect(store.putDocument('../x.json', 1)).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(store.getDocument('/abs.json')).rejects.toThrow();
  });

  it('reports a corrupt document as an error with code corrupt', async () => {
    const files = new MemoryFileSystem();
    await files.writeText('bad.json', '{nope');
    await expect(new FileStore(files).getDocument('bad.json')).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('lists documents sorted, non-recursively, and treats a missing folder as empty', async () => {
    const files = new MemoryFileSystem();
    const store = new FileStore(files);
    await store.putDocument('layouts/b.json', 1);
    await store.putDocument('layouts/a.json', 1);
    await files.writeText('layouts/readme.txt', 'x');
    await store.putDocument('layouts/sub/c.json', 1);
    expect(await store.listDocuments('layouts')).toEqual(['layouts/a.json', 'layouts/b.json']);
    expect(await store.listDocuments('nothing')).toEqual([]);
  });
});
