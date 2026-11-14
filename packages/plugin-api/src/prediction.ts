import type { CancellationToken, LocaleTag } from './common';
import type { ContextEntry } from './context';
import type { KeyDistribution } from './gaze';
import type { HistorySender } from './storage';

/**
 * The two-speed prediction contract (plan section 7).
 *
 * Flow for one keystroke:
 * 1. The prediction engine builds a `PredictionRequest` with a new, strictly
 *    increasing `requestId`.
 * 2. It calls `predict` on every provider. In-process providers answer
 *    synchronously (`PredictionResult`); sandboxed providers answer with a
 *    promise. The merged *instant* answer is shown at once.
 * 3. It then calls `refine` on providers that have it, passing a cancellation
 *    token that is cancelled as soon as a newer request starts. A refined
 *    result carries the same `requestId`; the engine drops any result whose
 *    `requestId` is not the current one.
 * 4. The UI replaces candidates with the refined set, keeping any candidate
 *    the user is currently dwelling on in its slot (candidates are identified
 *    by `text`; see `Candidate`).
 */

/** What a request asks for. Providers may ignore kinds they cannot produce. */
export type PredictionKind = 'completions' | 'nextWords' | 'letters' | 'phrases';

/**
 * One input step that contributed to the current partial word: the text a
 * single `composition.insert` added plus, when it came from an uncertain
 * selection, the distribution over the keys the user might have meant.
 * The `text` of the steps, concatenated in order, equals `partialWord`.
 */
export interface InputStep {
  readonly text: string;
  readonly distribution: KeyDistribution | null;
}

/** A recent utterance, for conversation-aware predictors. */
export interface ConversationTurn {
  readonly sender: HistorySender;
  readonly body: string;
  /** Wall-clock ms since epoch. */
  readonly createdAt: number;
}

/** Conversation context passed with a request (requires `history.read` for plugins). */
export interface ConversationContext {
  readonly conversationId?: string;
  /** Most recent last. At most a handful of turns. */
  readonly recent: readonly ConversationTurn[];
}

/** A prediction request. Built by the prediction engine from composition state. */
export interface PredictionRequest {
  /** Strictly increasing per engine instance. Results echo it. */
  readonly requestId: number;
  /** Composition text before the caret (v1: the whole composition). */
  readonly textBefore: string;
  /** The word being typed: a suffix of `textBefore`, empty after a space or punctuation. */
  readonly partialWord: string;
  /**
   * Per-insert uncertainty for `partialWord` (see `InputStep`). Absent when
   * the input pipeline gave none; providers must then treat `partialWord` as certain.
   */
  readonly partialWordSteps?: readonly InputStep[];
  readonly locale: LocaleTag;
  /** Maximum number of candidates per list the UI will show. */
  readonly maxCandidates: number;
  readonly kinds: readonly PredictionKind[];
  /** Present only for providers allowed to see it (`history.read`). */
  readonly conversation?: ConversationContext;
  /** Unexpired context store entries, present only for providers with `context.read`. */
  readonly context?: readonly ContextEntry[];
}

/**
 * A word candidate. `text` is the candidate's identity: the same word must
 * have the same `text` in the instant and refined results of a request, which
 * is how the UI keeps a dwelt-on candidate in place.
 */
export interface Candidate {
  /** The full word as it should appear once accepted (not only the missing suffix). */
  readonly text: string;
  /**
   * 0..1, comparable within one result; higher is better. Engines merging
   * several providers may re-normalise.
   */
  readonly score: number;
}

/** A whole-phrase suggestion, for example recalled from the user's history. */
export interface PhraseCandidate {
  /** Stable id (history record id or phrase id), or the text itself. */
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

/**
 * The answer to a request. Lists are sorted by descending score and hold at
 * most `maxCandidates` entries. Lists for kinds not requested are empty.
 */
export interface PredictionResult {
  readonly requestId: number;
  readonly providerId: string;
  readonly stage: 'instant' | 'refined';
  /** Completions of `partialWord` (empty when `partialWord` is empty). */
  readonly completions: readonly Candidate[];
  /** Candidates for the word after the current one (used when `partialWord` is empty). */
  readonly nextWords: readonly Candidate[];
  /**
   * Probability of each possible next grapheme (lower-case unless case is
   * meaningful), for adaptive dwell. Values in 0..1 summing to at most 1;
   * the remainder is "anything else". Empty when not computed.
   */
  readonly letters: Readonly<Record<string, number>>;
  readonly phrases: readonly PhraseCandidate[];
}

/** Something the user produced that a provider may learn from. */
export interface LearnEvent {
  /** The text spoken or committed. */
  readonly text: string;
  /** How it came about: spoken from the composition, a phrase tile, or a re-speak. */
  readonly origin: 'composition' | 'phrase' | 'respeak';
  readonly locale: LocaleTag;
  /** Wall-clock ms since epoch. */
  readonly createdAt: number;
}

/** What to remove from the user layer. */
export type ForgetRequest =
  { readonly kind: 'words'; readonly words: readonly string[] } | { readonly kind: 'all' };

/** What a provider can do; the engine skips calls a provider cannot answer. */
export interface PredictionProviderCapabilities {
  readonly kinds: readonly PredictionKind[];
  /** Whether `partialWordSteps` are used. */
  readonly usesKeyDistributions: boolean;
}

/**
 * A prediction provider. First-party (the n-gram engine) or a plugin
 * (`register.predictionProvider`).
 *
 * `predict` must be fast: in-process providers should answer synchronously
 * within 1 ms; it must never wait on a model. Slow work belongs in `refine`.
 * Providers must not mutate the request.
 */
export interface PredictionProvider {
  /** Unique id, for example `"forsee.ngram"` or `"<pluginId>/neural"`. */
  readonly id: string;
  readonly capabilities: PredictionProviderCapabilities;
  /** The instant answer. */
  predict(request: PredictionRequest): PredictionResult | Promise<PredictionResult>;
  /**
   * An optional later, better answer with `stage: 'refined'`. Resolve `null`
   * when there is nothing to add. Stop work and resolve `null` (or reject with
   * code `cancelled`) once `cancellation` fires.
   */
  refine?(
    request: PredictionRequest,
    cancellation: CancellationToken,
  ): Promise<PredictionResult | null>;
  /** Update the user layer (requires `lm.write` for plugins). */
  learn?(event: LearnEvent): void | Promise<void>;
  /** Remove data from the user layer (requires `lm.write` for plugins). */
  forget?(request: ForgetRequest): void | Promise<void>;
}
