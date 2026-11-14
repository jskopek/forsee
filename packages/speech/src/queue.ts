import { defaultErrorReporter, EventBus, type Disposable } from '@forsee/core';
import type {
  SpeechEndReason,
  SpeechEvent,
  SpeechEvents,
  SpeechHandle,
  Utterance,
} from '@forsee/plugin-api';
import type { QueuedUtterance, UtteranceQueue, UtteranceQueueOptions } from './contracts';

/**
 * Longest an utterance may take before the queue gives up on a provider that
 * never ends it. Deliberately generous (about five times slower than normal
 * speech, plus a fixed allowance for start-up), stretched further for slow
 * rates. Recordings have unknown length, so they get ten minutes.
 */
export function defaultWatchdogMs(utterance: Utterance): number {
  if (utterance.recording !== undefined) return 600_000;
  const rate = utterance.rate !== undefined && utterance.rate > 0 ? Math.min(utterance.rate, 1) : 1;
  return Math.ceil((10_000 + 200 * utterance.text.length) / rate);
}

interface Item {
  readonly utterance: Utterance;
  readonly resolve: (reason: SpeechEndReason) => void;
  readonly done: Promise<SpeechEndReason>;
  state: 'pending' | 'playing' | 'finished';
  started: boolean;
  handle: SpeechHandle | undefined;
  watchdog: Disposable | undefined;
}

/** Creates the utterance queue (see `UtteranceQueue` for its guarantees). */
export function createUtteranceQueue(options: UtteranceQueueOptions): UtteranceQueue {
  return new Queue(options);
}

class Queue implements UtteranceQueue {
  private readonly bus: EventBus<{ event: SpeechEvent }>;
  private readonly watchdogMs: (utterance: Utterance) => number;
  private waiting: Item[] = [];
  private current: Item | undefined;
  private disposed = false;

  constructor(private readonly options: UtteranceQueueOptions) {
    this.bus = new EventBus({ onListenerError: options.reportError ?? defaultErrorReporter });
    this.watchdogMs = options.watchdogMs ?? defaultWatchdogMs;
  }

  get speaking(): boolean {
    return this.current !== undefined;
  }

  get pending(): number {
    return this.waiting.length;
  }

  onEvent(listener: (event: SpeechEvent) => void): Disposable {
    return this.bus.on('event', listener);
  }

  enqueue(utterance: Utterance): QueuedUtterance {
    let resolve: (reason: SpeechEndReason) => void = () => undefined;
    const done = new Promise<SpeechEndReason>((r) => {
      resolve = r;
    });
    const item: Item = {
      utterance,
      resolve,
      done,
      state: 'pending',
      started: false,
      handle: undefined,
      watchdog: undefined,
    };
    if (this.disposed) {
      item.state = 'finished';
      resolve('stopped');
    } else {
      this.waiting.push(item);
      this.advance();
    }
    return { utterance, done };
  }

  stopAll(): void {
    const playing = this.current;
    const doomed = this.waiting;
    this.current = undefined;
    this.waiting = [];
    const all = playing ? [playing, ...doomed] : doomed;
    // Mark everything finished first, so late provider events and
    // re-entrant enqueues from listeners see a consistent, empty queue.
    for (const item of all) {
      item.state = 'finished';
      item.watchdog?.dispose();
      item.watchdog = undefined;
    }
    if (playing?.handle) {
      try {
        playing.handle.stop();
      } catch (error) {
        this.report(error, 'speech.stop');
      }
    }
    for (const item of all) this.settle(item, 'stopped');
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.disposed = true;
    this.bus.dispose();
  }

  // ---------------------------------------------------------------- internals

  private advance(): void {
    if (this.current || this.disposed) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.begin(next);
  }

  private begin(item: Item): void {
    item.state = 'playing';
    this.current = item;
    this.armWatchdog(item);
    const events: SpeechEvents = {
      onStart: () => this.markStarted(item),
      onBoundary: (event) => {
        if (item.state !== 'playing') return;
        this.markStarted(item);
        this.emit({ ...event, utteranceId: item.utterance.id });
      },
      onError: (event) => this.fail(item, event.message),
      onEnd: (event) => this.finish(item, event.reason),
    };
    let handle: SpeechHandle;
    try {
      handle = this.options.play(item.utterance, events);
    } catch (error) {
      this.fail(item, errorMessage(error));
      return;
    }
    if (item.state !== 'playing') return; // ended while `play` was running
    item.handle = handle;
    // A provider that resolves `done` but forgot `onEnd` still ends the item.
    handle.done.then(
      (reason) => this.finish(item, reason),
      (error: unknown) => this.fail(item, errorMessage(error)),
    );
  }

  private markStarted(item: Item): void {
    if (item.state !== 'playing' || item.started) return;
    item.started = true;
    this.armWatchdog(item); // a fresh budget once the provider is demonstrably alive
    this.emit({ type: 'start', utteranceId: item.utterance.id, t: this.options.clock.now() });
  }

  private armWatchdog(item: Item): void {
    item.watchdog?.dispose();
    const budget = Math.max(1, this.watchdogMs(item.utterance));
    item.watchdog = this.options.clock.setTimeout(() => {
      if (item.state !== 'playing') return;
      this.fail(item, `Speech timed out after ${budget} ms`);
    }, budget);
  }

  private fail(item: Item, message: string): void {
    if (item.state !== 'playing') return;
    this.emit({
      type: 'error',
      utteranceId: item.utterance.id,
      message,
      t: this.options.clock.now(),
    });
    this.finish(item, 'error');
  }

  private finish(item: Item, reason: SpeechEndReason): void {
    if (item.state !== 'playing') return;
    item.state = 'finished';
    item.watchdog?.dispose();
    item.watchdog = undefined;
    if (this.current === item) this.current = undefined;
    if (reason === 'completed' && !item.started) {
      item.started = true;
      this.emit({ type: 'start', utteranceId: item.utterance.id, t: this.options.clock.now() });
    }
    if (reason !== 'completed' && item.handle) {
      // Release a provider that failed or was abandoned; ignore its answer.
      try {
        item.handle.stop();
      } catch (error) {
        this.report(error, 'speech.handle.stop');
      }
    }
    this.settle(item, reason);
    this.advance();
  }

  private settle(item: Item, reason: SpeechEndReason): void {
    this.emit({
      type: 'end',
      utteranceId: item.utterance.id,
      reason,
      t: this.options.clock.now(),
    });
    item.resolve(reason);
  }

  private emit(event: SpeechEvent): void {
    this.bus.emit('event', event);
  }

  private report(error: unknown, context: string): void {
    (this.options.reportError ?? defaultErrorReporter)(error, context);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
