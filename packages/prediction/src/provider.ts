import type {
  Candidate,
  ForgetRequest,
  LearnEvent,
  PhraseCandidate,
  PredictionProvider,
  PredictionProviderCapabilities,
  PredictionRequest,
  PredictionResult,
} from '@forsee/plugin-api';
import type { LanguageModel, PhraseRecall, UserModel } from './contracts';
import { decodePrefixes, type PrefixHypothesis } from './noisy';
import { capitaliseFirst } from './text';
import {
  createTokeniser,
  primaryLanguage,
  SENTENCE_START,
  type ForseeTokeniser,
} from './tokeniser';

/**
 * The first-party n-gram prediction provider (`forsee.ngram`).
 *
 * Every probability is a linear interpolation of the base model and the user
 * layer: `P(w|h) = (1 - λ) P_base(w|h) + λ P_user(w|h)`, with
 * `λ = userWeight · m / (m + userHalfMass)` growing with the user's
 * recency-weighted amount of learned text `m` (so an empty user layer has no
 * effect and an empty base model leaves the user layer in charge).
 *
 * - **completions**: candidates from every prefix hypothesis (see
 *   `decodePrefixes`), scored `Σ_h π_h P(w|h)` over hypotheses that prefix
 *   `w`, divided by the total probability of all hypotheses' prefixes; so a
 *   score is the posterior probability that `w` is the intended word.
 * - **nextWords**: `P(w|h)` for the following word, only when `partialWord`
 *   is empty; capitalised at the start of a sentence.
 * - **letters**: per hypothesis, a mix of the base and user letter
 *   distributions weighted by how much probability each gives the prefix,
 *   then averaged over hypotheses by posterior. The base distribution itself
 *   mixes word completions with the character model, so unknown words still
 *   get letter probabilities. Values sum to at most 1.
 * - **phrases**: from the `PhraseRecall`, when one is given.
 *
 * `predict` is synchronous and allocation-light; there is no `refine`.
 */

export interface NgramProviderOptions {
  readonly base: LanguageModel;
  readonly user: UserModel;
  readonly phrases?: PhraseRecall;
  /** Provider id (default `forsee.ngram`). */
  readonly id?: string;
  /** Upper bound of the user-layer weight λ (default 0.6). */
  readonly userWeight?: number;
  /** Learned mass at which λ reaches half of `userWeight` (default 5 words). */
  readonly userHalfMass?: number;
  /** Prefix beam width for uncertain input (default 8). */
  readonly beamWidth?: number;
  /** Letters below this probability are omitted (default 0.0005). */
  readonly minLetterProbability?: number;
  /** Capitalise next-word candidates at the start of a sentence (default true). */
  readonly capitaliseSentenceStart?: boolean;
}

/** The n-gram provider plus access to its parts (for "my words" screens and persistence). */
export interface NgramProvider extends PredictionProvider {
  readonly base: LanguageModel;
  readonly user: UserModel;
  readonly phrases: PhraseRecall | null;
  learn(event: LearnEvent): void;
  forget(request: ForgetRequest): void;
  predict(request: PredictionRequest): PredictionResult;
}

export const NGRAM_PROVIDER_ID = 'forsee.ngram';

interface PhraseMaintenance {
  removeContaining?(words: readonly string[]): void;
  clear?(): void;
}

class NgramProviderImpl implements NgramProvider {
  readonly id: string;
  readonly capabilities: PredictionProviderCapabilities;
  readonly base: LanguageModel;
  readonly user: UserModel;
  readonly phrases: PhraseRecall | null;
  private readonly userWeight: number;
  private readonly userHalfMass: number;
  private readonly beamWidth: number;
  private readonly minLetter: number;
  private readonly capitalise: boolean;
  private readonly tokenisers = new Map<string, ForseeTokeniser>();

  constructor(options: NgramProviderOptions) {
    this.id = options.id ?? NGRAM_PROVIDER_ID;
    this.base = options.base;
    this.user = options.user;
    this.phrases = options.phrases ?? null;
    this.userWeight = options.userWeight ?? 0.6;
    this.userHalfMass = options.userHalfMass ?? 5;
    this.beamWidth = options.beamWidth ?? 8;
    this.minLetter = options.minLetterProbability ?? 0.0005;
    this.capitalise = options.capitaliseSentenceStart ?? true;
    this.capabilities = {
      kinds: this.phrases
        ? ['completions', 'nextWords', 'letters', 'phrases']
        : ['completions', 'nextWords', 'letters'],
      usesKeyDistributions: true,
    };
  }

  private tokeniser(locale: string): ForseeTokeniser {
    let t = this.tokenisers.get(locale);
    if (!t) {
      t = createTokeniser(locale);
      this.tokenisers.set(locale, t);
    }
    return t;
  }

  predict(request: PredictionRequest): PredictionResult {
    const kinds = new Set(request.kinds);
    const tokeniser = this.tokeniser(request.locale);
    const partial = request.partialWord;
    const before = request.textBefore.endsWith(partial)
      ? request.textBefore.slice(0, request.textBefore.length - partial.length)
      : request.textBefore;
    const previous = tokeniser.context(before, 2);
    const atSentenceStart = previous.length === 1 && previous[0] === SENTENCE_START;
    const baseUsable = primaryLanguage(this.base.locale) === primaryLanguage(request.locale);
    const lambda = this.lambda(baseUsable);
    const max = Math.max(0, request.maxCandidates);
    const mix = (word: string): number =>
      (lambda < 1 ? (1 - lambda) * this.base.probability(previous, word) : 0) +
      (lambda > 0 ? lambda * this.user.probability(previous, word) : 0);
    const mixMass = (prefix: string): [number, number] => [
      lambda < 1 ? (1 - lambda) * this.base.prefixProbability(previous, prefix) : 0,
      lambda > 0 ? lambda * this.user.prefixProbability(previous, prefix) : 0,
    ];

    let completions: Candidate[] = [];
    let nextWords: Candidate[] = [];
    let letters: Record<string, number> = {};
    let phrases: readonly PhraseCandidate[] = [];
    const needHyps = partial !== '' && (kinds.has('completions') || kinds.has('letters'));
    const hyps: PrefixHypothesis[] = needHyps
      ? decodePrefixes(partial, request.partialWordSteps, (s) => tokeniser.normalise(s), {
          beamWidth: this.beamWidth,
        })
      : [{ prefix: '', p: 1 }];
    const masses = new Map<string, [number, number]>();
    const massOf = (prefix: string): [number, number] => {
      let m = masses.get(prefix);
      if (!m) masses.set(prefix, (m = mixMass(prefix)));
      return m;
    };

    if (kinds.has('completions') && partial !== '' && max > 0) {
      completions = this.rank(
        hyps,
        previous,
        max,
        lambda,
        mix,
        (h) => {
          const [b, u] = massOf(h.prefix);
          return b + u;
        },
        baseUsable,
      );
    }
    if (kinds.has('nextWords') && partial === '' && max > 0) {
      nextWords = this.rank(hyps, previous, max, lambda, mix, () => 1, baseUsable).map((c) =>
        this.capitalise && atSentenceStart
          ? { text: capitaliseFirst(c.text, request.locale), score: c.score }
          : c,
      );
    }
    if (kinds.has('letters')) {
      letters = this.letters(hyps, previous, lambda, massOf, baseUsable);
    }
    if (kinds.has('phrases') && this.phrases && max > 0) {
      phrases = this.phrases.suggest(request.textBefore, max);
    }
    return {
      requestId: request.requestId,
      providerId: this.id,
      stage: 'instant',
      completions,
      nextWords,
      letters,
      phrases,
    };
  }

  private lambda(baseUsable: boolean): number {
    if (!baseUsable) return 1;
    const m = this.user.mass();
    return m > 0 ? (this.userWeight * m) / (m + this.userHalfMass) : 0;
  }

  /** Candidates over prefix hypotheses (one hypothesis `""` for next words). */
  private rank(
    hyps: readonly PrefixHypothesis[],
    previous: readonly string[],
    max: number,
    lambda: number,
    mix: (word: string) => number,
    hypMass: (h: PrefixHypothesis) => number,
    baseUsable: boolean,
  ): Candidate[] {
    const pool = max * 2 + 4;
    const display = new Map<string, string>();
    const tokeniser = this.tokeniser(this.user.locale);
    for (const h of hyps) {
      if (baseUsable && lambda < 1) {
        for (const c of this.base.completions(previous, h.prefix, pool)) {
          const key = tokeniser.normalise(c.text);
          if (!display.has(key)) display.set(key, c.text);
        }
      }
      if (lambda > 0) {
        for (const c of this.user.completions(previous, h.prefix, pool)) {
          const key = tokeniser.normalise(c.text);
          if (!display.has(key)) display.set(key, c.text);
        }
      }
    }
    let z = 0;
    for (const h of hyps) z += h.p * hypMass(h);
    if (!(z > 0)) return [];
    const scored: [string, number][] = [];
    for (const [key, text] of display) {
      let pi = 0;
      for (const h of hyps) if (key.startsWith(h.prefix)) pi += h.p;
      const s = (pi * mix(key)) / z;
      if (s > 0) scored.push([text, Math.min(1, s)]);
    }
    scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return scored.slice(0, max).map(([text, score]) => ({ text, score }));
  }

  private letters(
    hyps: readonly PrefixHypothesis[],
    previous: readonly string[],
    lambda: number,
    massOf: (prefix: string) => [number, number],
    baseUsable: boolean,
  ): Record<string, number> {
    const weights = hyps.map((h) => {
      const [b, u] = massOf(h.prefix);
      return h.p * Math.max(b + u, 1e-9);
    });
    const wTotal = weights.reduce((a, b) => a + b, 0);
    const out: Record<string, number> = {};
    hyps.forEach((h, i) => {
      const rho = wTotal > 0 ? weights[i]! / wTotal : 0;
      if (rho <= 0) return;
      const [b, u] = massOf(h.prefix);
      let wb = baseUsable ? b : 0;
      let wu = u;
      if (wb + wu <= 0) {
        wb = baseUsable ? 1 : 0;
        wu = baseUsable ? 0 : 1;
      }
      const norm = wb + wu;
      if (wb > 0) add(out, this.base.letterDistribution(previous, h.prefix), (rho * wb) / norm);
      if (wu > 0 && lambda > 0)
        add(out, this.user.letterDistribution(previous, h.prefix), (rho * wu) / norm);
    });
    const result: Record<string, number> = {};
    let sum = 0;
    for (const [g, p] of Object.entries(out).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )) {
      if (p < this.minLetter) continue;
      result[g] = p;
      sum += p;
    }
    // Guard against rounding pushing the total over 1.
    if (sum > 1) for (const g of Object.keys(result)) result[g] = result[g]! / sum;
    return result;
  }

  learn(event: LearnEvent): void {
    this.user.learn(event);
    if (event.origin !== 'phrase') this.phrases?.add(event.text, event.createdAt);
  }

  forget(request: ForgetRequest): void {
    this.user.forget(request);
    const maintenance: (PhraseRecall & PhraseMaintenance) | null = this.phrases;
    if (!maintenance) return;
    if (request.kind === 'all') maintenance.clear?.();
    else maintenance.removeContaining?.(request.words);
  }
}

function add(
  out: Record<string, number>,
  dist: Readonly<Record<string, number>>,
  weight: number,
): void {
  for (const [g, p] of Object.entries(dist)) out[g] = (out[g] ?? 0) + weight * p;
}

/** Creates the n-gram provider (satisfies `NgramProviderFactory`). */
export function createNgramProvider(options: NgramProviderOptions): NgramProvider {
  return new NgramProviderImpl(options);
}
