import type { ErrorReporter } from '@forsee/core';

/**
 * Serialises asynchronous work per key (a file path), so two writes to one
 * file never interleave, while different files proceed independently.
 * Tasks for one key run strictly in submission order, even after a failure.
 */
export class WriteQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly reportError: ErrorReporter) {}

  /**
   * Runs `task` after every earlier task for `key`. The result rejects with
   * the task's error, which is also given to the error reporter.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      (error: unknown) => {
        try {
          this.reportError(error, `storage.write:${key}`);
        } catch {
          // A throwing reporter must not break the queue.
        }
      },
    );
    this.tails.set(key, settled);
    this.pending.add(settled);
    void settled.then(() => {
      this.pending.delete(settled);
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }

  /** Resolves when every task for `key` submitted so far has finished (successfully or not). */
  idle(key: string): Promise<void> {
    return this.tails.get(key) ?? Promise.resolve();
  }

  /**
   * Resolves when every task submitted so far, on any key, has finished.
   * Errors do not reject it: they were already delivered to each caller and
   * to the reporter.
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}
