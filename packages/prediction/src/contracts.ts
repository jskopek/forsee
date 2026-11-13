import type { ExtensionRegistry } from '@forsee/core';
import type {
  Candidate,
  ConversationContext,
  Disposable,
  ForgetRequest,
  LearnEvent,
  LocaleTag,
  PhraseCandidate,
  PredictionKind,
  PredictionProvider,
  PredictionRequest,
  PredictionResult,
} from '@forsee/plugin-api';

/**
 * Engine-internal contracts of the prediction package (B4 implements them;
 * B8, B13, C2 and C11 consume them). The provider contract itself
 * (`PredictionProvider`, `PredictionRequest`, `PredictionResult`) is public
 * and lives in `@forsee/plugin-api`.
 */

export type {
  Candidate,
  ForgetRequest,
  InputStep,
  LearnEvent,
  PhraseCandidate,
  PredictionKind,
  PredictionProvider,
  PredictionRequest,
  PredictionResult,
} from '@forsee/plugin-api';

// ------------------------------------------------------------------ engine (what the UI talks to)

/** What the UI asks for on each keystroke. The engine fills in `requestId`, `context`, `conversation`. */
export interface PredictionQuery {
  readonly textBefore: string;
  readonly partialWord: string;
  readonly partialWordSteps?: PredictionRequest['partialWordSteps'];
  readonly locale: LocaleTag;
  readonly maxCandidates: number;
  readonly kinds: readonly PredictionKind[];
  readonly conversation?: ConversationContext;
}

/**
 * One live prediction: the instant merged answer, then zero or more updates
 * (refinements) until superseded by the next query.
 */
export interface PredictionSession extends Disposable {
  readonly requestId: number;
  /** Merged instant answer from every provider, available synchronously. */
  readonly instant: PredictionResult;
  /**
   * Called with each improved merged result. Never called after a newer
   * session has started or after `dispose`. Use `stabiliseCandidates` before
   * showing it.
   */
  onUpdate(listener: (result: PredictionResult) => void): Disposable;
}

/**
 * Combines providers registered in the extension registry
 * (`predictionProviders`) into one two-speed answer. B4 provides
 * `createPredictionEngine(options): PredictionEngine`.
 *
 * Merging rule (to be implemented by B4 and documented there): candidates
 * with the same `text` are combined; scores are a weighted mix per provider.
 */
export interface PredictionEngine extends Disposable {
  /** Starts a new session, cancelling refinements of the previous one. */
  predict(query: PredictionQuery): PredictionSession;
  /** Forwards to every provider's `learn` (respecting `lm.write` for plugins). */
  learn(event: LearnEvent): Promise<void>;
  /** Forwards to every provider's `forget`. */
  forget(request: ForgetRequest): Promise<void>;
}

/** Options for `createPredictionEngine`. */
export interface PredictionEngineOptions {
  readonly extensions: ExtensionRegistry;
  /** Per-provider weight when merging; default 1. */
  readonly weights?: Readonly<Record<string, number>>;
}

/**
 * Keeps the candidate the user is dwelling on in its slot when a refined
 * list arrives (plan section 7: "the UI replaces candidates without moving
 * the one the user is already dwelling on"). Returns `next` reordered so
 * that, if `pinnedText` is in both lists, it occupies the same index it had
 * in `previous`; if it is missing from `next` it is kept at that index.
 * Pure; B4 implements it, B8 calls it.
 */
export type CandidateStabiliser = (
  previous: readonly Candidate[],
  next: readonly Candidate[],
  pinnedText: string | null,
) => readonly Candidate[];

// ------------------------------------------------------------------ n-gram runtime internals

/** Splits text into word tokens the models understand. */
export interface Tokeniser {
  /** Word tokens of `text`, normalised (case folding is the model's choice and must be documented). */
  words(text: string): string[];
  /** Normalises a single word for lookup. */
  normalise(word: string): string;
}

/** A static language model loaded from a model file (word n-grams with backoff plus a character model). */
export interface LanguageModel {
  readonly locale: LocaleTag;
  /** Most likely completions of `prefix` given the previous words. */
  completions(previous: readonly string[], prefix: string, limit: number): readonly Candidate[];
  /** Most likely next words. */
  nextWords(previous: readonly string[], limit: number): readonly Candidate[];
  /** Distribution over the next grapheme after `prefix`. */
  letterDistribution(previous: readonly string[], prefix: string): Readonly<Record<string, number>>;
}

/** One entry of the user's visible, editable vocabulary. */
export interface UserVocabularyEntry {
  readonly word: string;
  readonly count: number;
  /** Wall-clock ms of last use. */
  readonly lastUsedAt: number;
}

/**
 * The per-user adaptive layer (counts of the user's words and sequences,
 * recency-weighted). Persisted as `lm/user-counts.json` by the storage package.
 */
export interface UserModel extends LanguageModel {
  learn(event: LearnEvent): void;
  forget(request: ForgetRequest): void;
  /** For the "my words" screen. */
  entries(): readonly UserVocabularyEntry[];
  /** JSON form; `load` accepts what `serialise` produced. */
  serialise(): unknown;
  load(data: unknown): boolean;
}

/** Signature of the first-party n-gram provider factory B4 exports. */
export type NgramProviderFactory = (options: {
  readonly base: LanguageModel;
  readonly user: UserModel;
}) => PredictionProvider;

/**
 * Recalls whole phrases from the user's own history (P1). Fed from the
 * conversation log; queried with the current composition text.
 */
export interface PhraseRecall {
  /** Indexes an utterance the user said. */
  add(text: string, createdAt: number): void;
  /** Removes an utterance (after a history deletion). */
  remove(text: string): void;
  suggest(textBefore: string, limit: number): readonly PhraseCandidate[];
}
