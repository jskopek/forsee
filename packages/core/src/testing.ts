import type { Disposable } from '@forsee/plugin-api';
import { toDisposable } from './disposable';
import type { Clock, IdSource } from './platform';

/**
 * Deterministic test doubles for `Clock` and `IdSource`. Exported from
 * `@forsee/core` so every package's tests use the same ones.
 */

interface FakeTimer {
  readonly id: number;
  dueAt: number;
  readonly intervalMs: number | null;
  readonly callback: () => void;
}

/**
 * A manually advanced clock. Time only moves when the test calls `advance`
 * or `setWallTime`. Timers fire during `advance`, in due order (ties in
 * creation order), with `now()` equal to their due time.
 */
export class FakeClock implements Clock {
  private monotonic: number;
  private wallOffset: number;
  private nextTimerId = 1;
  private timers: FakeTimer[] = [];

  /**
   * @param start.now initial monotonic time (default 0)
   * @param start.wall initial wall time, epoch ms (default 2026-01-01T00:00:00Z)
   */
  constructor(start: { now?: number; wall?: number } = {}) {
    this.monotonic = start.now ?? 0;
    this.wallOffset = (start.wall ?? Date.UTC(2026, 0, 1)) - this.monotonic;
  }

  now(): number {
    return this.monotonic;
  }

  wallNow(): number {
    return this.monotonic + this.wallOffset;
  }

  /** Moves the wall clock (forwards or backwards) without touching monotonic time: simulates clock skew. */
  setWallTime(wall: number): void {
    this.wallOffset = wall - this.monotonic;
  }

  setTimeout(callback: () => void, delayMs: number): Disposable {
    return this.addTimer(callback, Math.max(0, delayMs), null);
  }

  setInterval(callback: () => void, intervalMs: number): Disposable {
    if (!(intervalMs > 0)) throw new RangeError('intervalMs must be > 0');
    return this.addTimer(callback, intervalMs, intervalMs);
  }

  /** Advances both clocks by `ms`, firing due timers along the way. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock cannot go backwards; use setWallTime for skew');
    const target = this.monotonic + ms;
    for (;;) {
      const next = this.nextDue();
      if (!next || next.dueAt > target) break;
      this.monotonic = next.dueAt;
      if (next.intervalMs === null) {
        this.timers = this.timers.filter((t) => t !== next);
      } else {
        next.dueAt += next.intervalMs;
      }
      next.callback();
    }
    this.monotonic = target;
  }

  /** Number of pending timers. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  private nextDue(): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const timer of this.timers) {
      if (!best || timer.dueAt < best.dueAt || (timer.dueAt === best.dueAt && timer.id < best.id)) {
        best = timer;
      }
    }
    return best;
  }

  private addTimer(callback: () => void, delay: number, intervalMs: number | null): Disposable {
    const timer: FakeTimer = {
      id: this.nextTimerId++,
      dueAt: this.monotonic + delay,
      intervalMs,
      callback,
    };
    this.timers.push(timer);
    return toDisposable(() => {
      this.timers = this.timers.filter((t) => t !== timer);
    });
  }
}

/**
 * Deterministic ids: `uuid()` returns valid-looking v4 UUIDs counting up
 * from `00000000-0000-4000-8000-000000000001`; `random()` is a seeded
 * mulberry32 generator.
 */
export class SequentialIdSource implements IdSource {
  private counter = 0;
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  uuid(): string {
    this.counter += 1;
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }

  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
