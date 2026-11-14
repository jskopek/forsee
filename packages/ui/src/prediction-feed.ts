import type { ErrorReporter, Kernel } from '@forsee/core';
import type { PredictionEngine, PredictionSession } from '@forsee/prediction';
import type { Disposable, PredictionKind, PredictionResult } from '@forsee/plugin-api';

/** What the prediction feed currently shows. Immutable; a new object on every change. */
export interface PredictionSnapshot {
  /** The live session (for `pin`), or null before the first query or without an engine. */
  readonly session: PredictionSession | null;
  /** The latest merged result of that session (instant, then each refinement). */
  readonly result: PredictionResult | null;
  /** The partial word the session was asked about. */
  readonly partialWord: string;
}

/** Options of `PredictionFeed`. */
export interface PredictionFeedOptions {
  /** Candidates per list. Default 6. */
  readonly maxCandidates?: number;
  /** Kinds to request. Default completions, next words and letters. */
  readonly kinds?: readonly PredictionKind[];
  readonly reportError: ErrorReporter;
}

const EMPTY: PredictionSnapshot = Object.freeze({ session: null, result: null, partialWord: '' });

/**
 * The host's single prediction session per composition state.
 *
 * Starting a session supersedes the previous one, so the prediction strip
 * and the keyboard (adaptive dwell) must share one: the feed runs one query
 * per composition change (and per locale change) and publishes the session
 * and its latest result as a snapshot for `useSyncExternalStore`.
 */
export class PredictionFeed {
  private snapshot: PredictionSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private session: PredictionSession | null = null;
  private sessionSubscription: Disposable | null = null;
  private readonly maxCandidates: number;
  private readonly kinds: readonly PredictionKind[];

  constructor(
    private readonly kernel: Kernel,
    private readonly engine: PredictionEngine,
    private readonly options: PredictionFeedOptions,
  ) {
    this.maxCandidates = options.maxCandidates ?? 6;
    this.kinds = options.kinds ?? ['completions', 'nextWords', 'letters'];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): PredictionSnapshot => this.snapshot;

  /** Queries now and on every composition or locale change, until disposed. */
  start(): Disposable {
    const subscriptions = [
      this.kernel.composition.events.on('changed', () => this.query()),
      this.kernel.settings.events.on('changed', (change) => {
        if (change.namespace === 'app.general' && change.key === 'locale') this.query();
      }),
    ];
    this.query();
    return {
      dispose: () => {
        for (const s of subscriptions) s.dispose();
        this.closeSession();
        this.publish(EMPTY);
      },
    };
  }

  private query(): void {
    const state = this.kernel.composition.state;
    this.closeSession();
    let session: PredictionSession;
    try {
      session = this.engine.predict({
        textBefore: state.textBeforeCaret,
        partialWord: state.partialWord,
        partialWordSteps: state.partialWordSteps,
        locale: this.kernel.locale,
        maxCandidates: this.maxCandidates,
        kinds: this.kinds,
      });
    } catch (error) {
      this.options.reportError(error, 'ui.prediction');
      this.publish(EMPTY);
      return;
    }
    this.session = session;
    const partialWord = state.partialWord;
    this.sessionSubscription = session.onUpdate((result) => {
      if (this.session !== session) return;
      this.publish({ session, result, partialWord });
    });
    this.publish({ session, result: session.instant, partialWord });
  }

  private closeSession(): void {
    this.sessionSubscription?.dispose();
    this.sessionSubscription = null;
    this.session?.dispose();
    this.session = null;
  }

  private publish(next: PredictionSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.reportError(error, 'ui.prediction.listener');
      }
    }
  }
}
