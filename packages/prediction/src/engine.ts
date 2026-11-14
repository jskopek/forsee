import {
  CancellationSource,
  defaultErrorReporter,
  ForseeError,
  isForseeError,
  toDisposable,
  type Clock,
  type ErrorReporter,
} from '@forsee/core';
import type {
  Candidate,
  Disposable,
  ForgetRequest,
  LearnEvent,
  PhraseCandidate,
  PredictionKind,
  PredictionProvider,
  PredictionRequest,
  PredictionResult,
  RegisteredContribution,
} from '@forsee/plugin-api';
import type {
  CandidateStabiliser,
  PredictionEngine,
  PredictionEngineOptions,
  PredictionQuery,
  PredictionSession,
  ProviderAccess,
} from './contracts';

/**
 * The prediction engine: the two-speed orchestrator over every provider in
 * the `predictionProviders` extension point.
 *
 * Per query: a new `requestId` (strictly increasing); the previous session
 * is superseded (its refinements are cancelled and its listeners never fire
 * again). Each provider whose capabilities overlap the requested kinds gets
 * the request, stripped of `conversation`/`context` unless `access` allows
 * them. Synchronous answers form `session.instant`; promise answers (sandboxed
 * providers) and `refine` results arrive later as updates. A provider that
 * throws, rejects, answers with the wrong `requestId` or times out is
 * reported through `reportError` and left out; it never breaks typing.
 *
 * Merging rule (`mergeResults`): per list, each provider's scores are used
 * as probabilities (divided by their sum if that exceeds 1), multiplied by
 * the provider's weight (default 1), summed per candidate and divided by the
 * total weight of providers that can produce that kind. Candidates are
 * de-duplicated case-insensitively by `text`; the text shown is the one from
 * the provider that contributed most. Ties keep provider registration
 * order. Letters are the weighted mean over providers that returned any,
 * so they still sum to at most 1. A provider's refined result replaces its
 * own instant result.
 *
 * Updates are stabilised: after `session.pin(text)`, every update keeps
 * that candidate at the index it had in the last delivered result.
 */

export const ENGINE_PROVIDER_ID = 'forsee.engine';

type ListKind = 'completions' | 'nextWords' | 'phrases';

interface Entry {
  readonly contribution: RegisteredContribution<'predictionProviders'>;
  readonly provider: PredictionProvider;
  readonly request: PredictionRequest;
  readonly weight: number;
}

/** Keeps `pinnedText` at the index it had in `previous` (see `CandidateStabiliser`). */
export function stabiliseList<T extends { readonly text: string }>(
  previous: readonly T[],
  next: readonly T[],
  pinnedText: string | null,
): readonly T[] {
  if (pinnedText === null) return next;
  const index = previous.findIndex((c) => c.text === pinnedText);
  if (index < 0) return next;
  const nextIndex = next.findIndex((c) => c.text === pinnedText);
  const pinned = nextIndex >= 0 ? next[nextIndex]! : previous[index]!;
  const rest = nextIndex >= 0 ? next.filter((_, i) => i !== nextIndex) : [...next];
  const position = Math.min(index, rest.length);
  const cap = Math.max(previous.length, next.length);
  return [...rest.slice(0, position), pinned, ...rest.slice(position)].slice(0, cap);
}

/** The `CandidateStabiliser` B8 calls. */
export const stabiliseCandidates: CandidateStabiliser = stabiliseList;

const DEFAULT_ACCESS_APP: ProviderAccess = { conversation: true, context: true, learn: true };
const DEFAULT_ACCESS_OTHER: ProviderAccess = { conversation: false, context: false, learn: false };

function defaultAccess(
  contribution: RegisteredContribution<'predictionProviders'>,
): ProviderAccess {
  return contribution.owner === 'app' ? DEFAULT_ACCESS_APP : DEFAULT_ACCESS_OTHER;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function clampScore(score: unknown): number {
  return typeof score === 'number' && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
}

function validList<T extends { text: string }>(list: unknown): T[] {
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter(
    (c): c is T =>
      typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string',
  );
}

/** An empty result for `requestId`. */
export function emptyResult(requestId: number, providerId = ENGINE_PROVIDER_ID): PredictionResult {
  return {
    requestId,
    providerId,
    stage: 'instant',
    completions: [],
    nextWords: [],
    letters: {},
    phrases: [],
  };
}

interface Contribution {
  readonly result: PredictionResult;
  readonly weight: number;
  readonly kinds: ReadonlySet<PredictionKind>;
}

/** Merges provider results (see the module comment for the rule). */
export function mergeResults(
  requestId: number,
  contributions: readonly Contribution[],
  maxCandidates: number,
): PredictionResult {
  const mergeList = (kind: ListKind): Candidate[] | PhraseCandidate[] => {
    const totals = new Map<
      string,
      { score: number; best: number; item: Candidate | PhraseCandidate; order: number }
    >();
    let weightSum = 0;
    let order = 0;
    for (const c of contributions) {
      if (!c.kinds.has(kind)) continue;
      weightSum += c.weight;
      const list = validList<Candidate | PhraseCandidate>(c.result[kind]);
      let sum = 0;
      for (const item of list) sum += clampScore(item.score);
      const scale = sum > 1 ? 1 / sum : 1;
      for (const item of list) {
        const key = item.text.toLowerCase();
        const share = clampScore(item.score) * scale * c.weight;
        const t = totals.get(key);
        if (!t) totals.set(key, { score: share, best: share, item, order: order++ });
        else {
          t.score += share;
          if (share > t.best) {
            t.best = share;
            t.item = item;
          }
        }
      }
    }
    if (weightSum <= 0) return [];
    return [...totals.values()]
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, Math.max(0, maxCandidates))
      .map((t) => {
        const score = Math.min(1, t.score / weightSum);
        return kind === 'phrases'
          ? { id: (t.item as PhraseCandidate).id ?? t.item.text, text: t.item.text, score }
          : { text: t.item.text, score };
      });
  };
  const letters: Record<string, number> = {};
  let letterWeight = 0;
  let refined = false;
  for (const c of contributions) {
    if (c.result.stage === 'refined') refined = true;
    const raw = c.result.letters as unknown;
    if (typeof raw !== 'object' || raw === null) continue;
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] > 0,
    );
    if (entries.length === 0) continue;
    const sum = entries.reduce((a, [, p]) => a + p, 0);
    const scale = sum > 1 ? 1 / sum : 1;
    letterWeight += c.weight;
    for (const [g, p] of entries) letters[g] = (letters[g] ?? 0) + p * scale * c.weight;
  }
  if (letterWeight > 0)
    for (const g of Object.keys(letters)) letters[g] = letters[g]! / letterWeight;
  return {
    requestId,
    providerId: ENGINE_PROVIDER_ID,
    stage: refined ? 'refined' : 'instant',
    completions: mergeList('completions') as Candidate[],
    nextWords: mergeList('nextWords') as Candidate[],
    letters,
    phrases: mergeList('phrases') as PhraseCandidate[],
  };
}

class Session implements PredictionSession {
  readonly cancellation: CancellationSource;
  instant: PredictionResult;
  private closed = false;
  private pinned: string | null = null;
  private delivered: PredictionResult;
  private readonly listeners = new Set<(result: PredictionResult) => void>();
  private readonly results = new Map<string, { entry: Entry; result: PredictionResult }>();
  private readonly order: string[] = [];
  private readonly timers: Disposable[] = [];

  constructor(
    readonly requestId: number,
    private readonly maxCandidates: number,
    private readonly kinds: ReadonlySet<PredictionKind>,
    private readonly reportError: ErrorReporter,
  ) {
    this.cancellation = new CancellationSource(reportError);
    this.instant = emptyResult(requestId);
    this.delivered = this.instant;
  }

  get active(): boolean {
    return !this.closed;
  }

  register(entry: Entry): void {
    this.order.push(entry.provider.id);
  }

  /** Records a provider result; returns false if it was rejected. */
  accept(entry: Entry, result: unknown, phase: string): boolean {
    if (typeof result !== 'object' || result === null) {
      this.reportError(
        new ForseeError('internal', `Provider ${entry.provider.id} returned no result`),
        phase,
      );
      return false;
    }
    const r = result as PredictionResult;
    if (r.requestId !== this.requestId) return false; // stale: dropped silently
    // A refined result already received from this provider wins over its late instant one.
    if (r.stage !== 'refined' && this.results.get(entry.provider.id)?.result.stage === 'refined')
      return false;
    this.results.set(entry.provider.id, { entry, result: r });
    return true;
  }

  merged(): PredictionResult {
    const contributions: Contribution[] = [];
    for (const id of this.order) {
      const r = this.results.get(id);
      if (!r) continue;
      const kinds = new Set(r.entry.provider.capabilities.kinds.filter((k) => this.kinds.has(k)));
      contributions.push({ result: r.result, weight: r.entry.weight, kinds });
    }
    return mergeResults(this.requestId, contributions, this.maxCandidates);
  }

  setInstant(): void {
    this.instant = this.merged();
    this.delivered = this.instant;
  }

  /** Re-merges and notifies listeners, stabilised around the pinned candidate. */
  update(): void {
    if (this.closed) return;
    const next = this.merged();
    const stabilised: PredictionResult = {
      ...next,
      completions: stabiliseList(this.delivered.completions, next.completions, this.pinned),
      nextWords: stabiliseList(this.delivered.nextWords, next.nextWords, this.pinned),
      phrases: stabiliseList(this.delivered.phrases, next.phrases, this.pinned),
    };
    this.delivered = stabilised;
    for (const listener of [...this.listeners]) {
      try {
        listener(stabilised);
      } catch (error) {
        this.reportError(error, 'prediction.onUpdate');
      }
    }
  }

  addTimer(timer: Disposable): void {
    if (this.closed) timer.dispose();
    else this.timers.push(timer);
  }

  onUpdate(listener: (result: PredictionResult) => void): Disposable {
    if (this.closed) return toDisposable(() => undefined);
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  pin(text: string | null): void {
    this.pinned = text;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const t of this.timers.splice(0)) t.dispose();
    this.cancellation.cancel();
  }
}

class Engine implements PredictionEngine {
  private requestId = 0;
  private current: Session | null = null;
  private disposed = false;
  private readonly reportError: ErrorReporter;
  private readonly clock: Clock | undefined;
  private readonly predictTimeoutMs: number;
  private readonly refineTimeoutMs: number;

  constructor(private readonly options: PredictionEngineOptions) {
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.clock = options.clock;
    this.predictTimeoutMs = options.predictTimeoutMs ?? 250;
    this.refineTimeoutMs = options.refineTimeoutMs ?? 1000;
  }

  private entries(request: PredictionRequest, kinds: ReadonlySet<PredictionKind>): Entry[] {
    const access = this.options.access ?? defaultAccess;
    const out: Entry[] = [];
    for (const contribution of this.options.extensions.list('predictionProviders')) {
      const provider = contribution.contribution;
      if (!provider.capabilities.kinds.some((k) => kinds.has(k))) continue;
      let allowed: ProviderAccess;
      try {
        allowed = access(contribution);
      } catch (error) {
        this.reportError(error, `prediction.access:${provider.id}`);
        continue;
      }
      const { conversation, context, ...rest } = request;
      const filtered: PredictionRequest = {
        ...rest,
        ...(allowed.conversation && conversation !== undefined ? { conversation } : {}),
        ...(allowed.context && context !== undefined ? { context } : {}),
      };
      out.push({
        contribution,
        provider,
        request: filtered,
        weight: Math.max(0, this.options.weights?.[provider.id] ?? 1),
      });
    }
    return out;
  }

  predict(query: PredictionQuery): PredictionSession {
    this.current?.dispose();
    const requestId = ++this.requestId;
    const kinds = new Set(query.kinds);
    const session = new Session(requestId, query.maxCandidates, kinds, this.reportError);
    if (this.disposed) {
      session.dispose();
      return session;
    }
    this.current = session;
    let context: PredictionRequest['context'];
    if (this.options.context) {
      try {
        context = this.options.context();
      } catch (error) {
        this.reportError(error, 'prediction.context');
      }
    }
    const request: PredictionRequest = {
      requestId,
      textBefore: query.textBefore,
      partialWord: query.partialWord,
      ...(query.partialWordSteps === undefined ? {} : { partialWordSteps: query.partialWordSteps }),
      locale: query.locale,
      maxCandidates: query.maxCandidates,
      kinds: query.kinds,
      ...(query.conversation === undefined ? {} : { conversation: query.conversation }),
      ...(context === undefined ? {} : { context }),
    };
    const entries = this.entries(request, kinds);
    for (const entry of entries) session.register(entry);
    const pending: [Entry, PromiseLike<PredictionResult>][] = [];
    for (const entry of entries) {
      const phase = `prediction.predict:${entry.provider.id}`;
      try {
        const answer = entry.provider.predict(entry.request);
        if (isPromiseLike<PredictionResult>(answer)) pending.push([entry, answer]);
        else session.accept(entry, answer, phase);
      } catch (error) {
        this.reportError(error, phase);
      }
    }
    session.setInstant();
    for (const [entry, promise] of pending) this.awaitInstant(session, entry, promise);
    for (const entry of entries) if (entry.provider.refine) this.startRefine(session, entry);
    return session;
  }

  private withTimeout<T>(
    session: Session,
    entry: Entry,
    promise: PromiseLike<T>,
    timeoutMs: number,
    phase: string,
    onTimeout: () => void,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: { ok: true; value: T } | { ok: false }): void => {
        if (settled) return;
        settled = true;
        timer?.dispose();
        resolve(v);
      };
      const timer = this.clock?.setTimeout(() => {
        if (settled) return;
        if (session.active) {
          this.reportError(
            new ForseeError(
              'timeout',
              `Prediction provider ${entry.provider.id} timed out after ${timeoutMs} ms`,
            ),
            phase,
          );
        }
        onTimeout();
        finish({ ok: false });
      }, timeoutMs);
      if (timer) session.addTimer(timer);
      promise.then(
        (value) => finish({ ok: true, value }),
        (error: unknown) => {
          if (!settled && session.active && !isForseeError(error, 'cancelled')) {
            this.reportError(error, phase);
          }
          finish({ ok: false });
        },
      );
    });
  }

  private awaitInstant(
    session: Session,
    entry: Entry,
    promise: PromiseLike<PredictionResult>,
  ): void {
    const phase = `prediction.predict:${entry.provider.id}`;
    void this.withTimeout(
      session,
      entry,
      promise,
      this.predictTimeoutMs,
      phase,
      () => undefined,
    ).then((r) => {
      if (!r.ok || !session.active) return;
      if (session.accept(entry, r.value, phase)) session.update();
    });
  }

  private startRefine(session: Session, entry: Entry): void {
    const phase = `prediction.refine:${entry.provider.id}`;
    const own = new CancellationSource(this.reportError);
    const link = session.cancellation.token.onCancel(() => own.cancel());
    let promise: Promise<PredictionResult | null>;
    try {
      promise = entry.provider.refine!(entry.request, own.token);
    } catch (error) {
      link.dispose();
      this.reportError(error, phase);
      return;
    }
    void this.withTimeout(session, entry, promise, this.refineTimeoutMs, phase, () =>
      own.cancel(),
    ).then((r) => {
      link.dispose();
      if (!r.ok || r.value === null || !session.active) return;
      if (session.accept(entry, r.value, phase)) session.update();
    });
  }

  private learners(): PredictionProvider[] {
    const access = this.options.access ?? defaultAccess;
    const out: PredictionProvider[] = [];
    for (const contribution of this.options.extensions.list('predictionProviders')) {
      try {
        if (access(contribution).learn) out.push(contribution.contribution);
      } catch (error) {
        this.reportError(error, `prediction.access:${contribution.contribution.id}`);
      }
    }
    return out;
  }

  async learn(event: LearnEvent): Promise<void> {
    await Promise.all(
      this.learners().map(async (p) => {
        if (!p.learn) return;
        try {
          await p.learn(event);
        } catch (error) {
          this.reportError(error, `prediction.learn:${p.id}`);
        }
      }),
    );
  }

  async forget(request: ForgetRequest): Promise<void> {
    await Promise.all(
      this.learners().map(async (p) => {
        if (!p.forget) return;
        try {
          await p.forget(request);
        } catch (error) {
          this.reportError(error, `prediction.forget:${p.id}`);
        }
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.current?.dispose();
    this.current = null;
  }
}

/** Creates the prediction engine. */
export function createPredictionEngine(options: PredictionEngineOptions): PredictionEngine {
  return new Engine(options);
}
