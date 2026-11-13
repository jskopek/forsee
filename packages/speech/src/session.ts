import type { Clock } from '@forsee/core';
import type { SpeechEndReason, SpeechEvents, SpeechHandle } from '@forsee/plugin-api';

/**
 * Bookkeeping shared by every provider: delivers `SpeechEvents` in a legal
 * order (one `start`, boundaries, an optional `error`, exactly one `end`),
 * ignores anything after the end, resolves `done`, and keeps a throwing
 * callback from breaking the provider.
 */
export interface SpeechSession {
  readonly handle: SpeechHandle;
  readonly started: boolean;
  readonly ended: boolean;
  /** Emits `start` once. No-op after the end. */
  start(): void;
  boundary(charIndex: number, charLength: number): void;
  /** Emits `error` without ending (follow with `end('error')`, or use `fail`). */
  error(message: string): void;
  /** Emits `end` once and resolves `done`. */
  end(reason: SpeechEndReason): void;
  /** `error(message)` then `end('error')`. */
  fail(message: string): void;
}

/**
 * @param onStop what `handle.stop()` does to the underlying engine (it runs
 *   first, may throw); the session then ends with `stopped`.
 */
export function createSpeechSession(
  utteranceId: string,
  events: SpeechEvents,
  clock: Clock,
  onStop: () => void,
): SpeechSession {
  let started = false;
  let ended = false;
  let resolveDone: (reason: SpeechEndReason) => void = () => undefined;
  const done = new Promise<SpeechEndReason>((resolve) => {
    resolveDone = resolve;
  });

  const safely = (callback: () => void): void => {
    try {
      callback();
    } catch {
      // A consumer's callback must not break the provider; the queue
      // reports its own listener errors.
    }
  };

  const session: SpeechSession = {
    handle: {
      utteranceId,
      done,
      stop() {
        if (ended) return;
        safely(onStop);
        session.end('stopped');
      },
    },
    get started() {
      return started;
    },
    get ended() {
      return ended;
    },
    start() {
      if (ended || started) return;
      started = true;
      safely(() => events.onStart?.({ type: 'start', utteranceId, t: clock.now() }));
    },
    boundary(charIndex, charLength) {
      if (ended) return;
      session.start();
      safely(() =>
        events.onBoundary?.({
          type: 'boundary',
          utteranceId,
          charIndex,
          charLength,
          t: clock.now(),
        }),
      );
    },
    error(message) {
      if (ended) return;
      safely(() => events.onError?.({ type: 'error', utteranceId, message, t: clock.now() }));
    },
    end(reason) {
      if (ended) return;
      ended = true;
      safely(() => events.onEnd?.({ type: 'end', utteranceId, reason, t: clock.now() }));
      resolveDone(reason);
    },
    fail(message) {
      session.error(message);
      session.end('error');
    },
  };
  return session;
}
