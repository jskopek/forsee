import type { Clock } from '@forsee/core';
import type { Candidate, ForgetRequest, LearnEvent, LocaleTag } from '@forsee/plugin-api';
import type { UserModel, UserVocabularyEntry } from './contracts';
import { addStamped, Decay, type Stamped } from './decay';
import { nextGrapheme } from './text';
import { createTokeniser, isSpecialWord, SENTENCE_START, type ForseeTokeniser } from './tokeniser';

/**
 * The user-adaptive layer: recency-weighted counts of the user's own words,
 * bigrams and trigrams (new words included), estimated with Witten–Bell
 * interpolation:
 *
 *   P1(w)     = c(w) / C
 *   P2(w|v)   = (c(v w) + T(v) P1(w)) / (C(v) + T(v))
 *   P3(w|u v) = (c(u v w) + T(u v) P2(w|v)) / (C(u v) + T(u v))
 *
 * where `c` are counts decayed with a half-life (default 30 days, driven by
 * the injected clock's wall time) and `T` the number of distinct
 * continuations. The provider interpolates this with the base model.
 *
 * Persisted as plain JSON (`serialise`/`load`), stored by the storage
 * package at `lm/user-counts.json`.
 */

export interface UserModelOptions {
  readonly clock: Clock;
  readonly locale?: LocaleTag;
  /** Half-life of the recency weighting (default 30 days). */
  readonly halfLifeMs?: number;
  /** Caps; the least recently and least often used entries go first (defaults 20 000 / 60 000 / 60 000). */
  readonly maxWords?: number;
  readonly maxBigrams?: number;
  readonly maxTrigrams?: number;
  /** Weight of one occurrence per `LearnEvent.origin` (default composition 1, respeak 0.5, phrase 0.25). */
  readonly originWeights?: Partial<Record<LearnEvent['origin'], number>>;
}

export const USER_MODEL_SCHEMA_VERSION = 1;
export const DEFAULT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry extends Stamped {
  count: number;
  lastUsedAt: number;
}

interface WordEntry extends Entry {
  display: string;
}

interface Context {
  total: Stamped;
  readonly next: Set<string>;
}

const SEP = '\u0001';

/** JSON form of the user model. */
export interface UserModelData {
  readonly schemaVersion: 1;
  readonly kind: 'forsee.user-lm';
  readonly halfLifeMs: number;
  /** `[word, display, count, weight, weightAt, lastUsedAt]` */
  readonly words: readonly (readonly [string, string, number, number, number, number])[];
  /** `[w1, w2, count, weight, weightAt, lastUsedAt]`; `w1` may be `"<s>"`. */
  readonly bigrams: readonly (readonly [string, string, number, number, number, number])[];
  /** `[w1, w2, w3, count, weight, weightAt, lastUsedAt]` */
  readonly trigrams: readonly (readonly [string, string, string, number, number, number, number])[];
}

export class AdaptiveUserModel implements UserModel {
  readonly locale: LocaleTag;
  private readonly clock: Clock;
  private readonly tokeniser: ForseeTokeniser;
  private decay: Decay;
  private readonly limits: { words: number; bigrams: number; trigrams: number };
  private readonly originWeights: Record<LearnEvent['origin'], number>;
  private words = new Map<string, WordEntry>();
  private bigrams = new Map<string, Entry>();
  private trigrams = new Map<string, Entry>();
  private total: Stamped = { value: 0, at: 0 };
  private ctx2 = new Map<string, Context>();
  private ctx3 = new Map<string, Context>();
  private sorted: string[] | null = null;
  private byRank: string[] | null = null;

  constructor(options: UserModelOptions) {
    this.clock = options.clock;
    this.locale = options.locale ?? 'en';
    this.tokeniser = createTokeniser(this.locale);
    this.decay = new Decay(options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS);
    this.limits = {
      words: options.maxWords ?? 20_000,
      bigrams: options.maxBigrams ?? 60_000,
      trigrams: options.maxTrigrams ?? 60_000,
    };
    this.originWeights = {
      composition: 1,
      respeak: 0.5,
      phrase: 0.25,
      ...options.originWeights,
    };
  }

  // ------------------------------------------------------------------ learning

  learn(event: LearnEvent): void {
    const weight = this.originWeights[event.origin] ?? 1;
    if (!(weight > 0)) return;
    const t = event.createdAt;
    for (const sentence of this.tokeniser.sentences(event.text)) {
      const seq = [SENTENCE_START];
      for (const token of sentence) {
        const w = token.normal;
        seq.push(w);
        let entry = this.words.get(w);
        if (!entry) {
          entry = {
            value: 0,
            at: t,
            count: 0,
            lastUsedAt: t,
            display: this.tokeniser.defaultDisplay(w),
          };
          this.words.set(w, entry);
          this.sorted = null;
        }
        bump(this.decay, entry, weight, t);
        if (!token.sentenceInitial && token.kind === 'word') entry.display = token.surface;
        addStamped(this.decay, this.total, weight, t);
      }
      for (let i = 1; i < seq.length; i++) {
        const v = seq[i - 1]!;
        const w = seq[i]!;
        this.addNgram(this.bigrams, this.ctx2, v, w, weight, t);
        if (i >= 2) this.addNgram(this.trigrams, this.ctx3, seq[i - 2]! + SEP + v, w, weight, t);
      }
    }
    this.byRank = null;
    this.enforceLimits();
  }

  private addNgram(
    map: Map<string, Entry>,
    contexts: Map<string, Context>,
    ctx: string,
    w: string,
    weight: number,
    t: number,
  ): void {
    const key = ctx + SEP + w;
    let entry = map.get(key);
    if (!entry) {
      entry = { value: 0, at: t, count: 0, lastUsedAt: t };
      map.set(key, entry);
    }
    bump(this.decay, entry, weight, t);
    let c = contexts.get(ctx);
    if (!c) {
      c = { total: { value: 0, at: t }, next: new Set() };
      contexts.set(ctx, c);
    }
    c.next.add(w);
    addStamped(this.decay, c.total, weight, t);
  }

  forget(request: ForgetRequest): void {
    if (request.kind === 'all') {
      this.words.clear();
      this.bigrams.clear();
      this.trigrams.clear();
    } else {
      const doomed = new Set(request.words.map((w) => this.tokeniser.normalise(w)));
      for (const w of doomed) this.words.delete(w);
      const hit = (key: string): boolean => key.split(SEP).some((part) => doomed.has(part));
      for (const key of [...this.bigrams.keys()]) if (hit(key)) this.bigrams.delete(key);
      for (const key of [...this.trigrams.keys()]) if (hit(key)) this.trigrams.delete(key);
    }
    this.rebuild();
  }

  /** Recomputes totals and context indexes from the entry maps. */
  private rebuild(): void {
    this.total = { value: 0, at: 0 };
    for (const e of this.words.values()) addStamped(this.decay, this.total, e.value, e.at);
    this.ctx2 = indexContexts(this.decay, this.bigrams);
    this.ctx3 = indexContexts(this.decay, this.trigrams);
    this.sorted = null;
    this.byRank = null;
  }

  private enforceLimits(): void {
    let changed = false;
    const trim = <E extends Entry>(map: Map<string, E>, max: number): void => {
      if (map.size <= max) return;
      const keep = Math.floor(max * 0.9);
      const ranked = [...map.entries()].sort(
        (a, b) =>
          this.decay.rank(b[1].value, b[1].at) - this.decay.rank(a[1].value, a[1].at) ||
          cmp(a[0], b[0]),
      );
      for (const [key] of ranked.slice(keep)) map.delete(key);
      changed = true;
    };
    trim(this.words, this.limits.words);
    trim(this.bigrams, this.limits.bigrams);
    trim(this.trigrams, this.limits.trigrams);
    if (!changed) return;
    // Keep n-grams consistent with the vocabulary.
    const known = (key: string): boolean =>
      key.split(SEP).every((w) => w === SENTENCE_START || this.words.has(w));
    for (const key of [...this.bigrams.keys()]) if (!known(key)) this.bigrams.delete(key);
    for (const key of [...this.trigrams.keys()]) if (!known(key)) this.trigrams.delete(key);
    this.rebuild();
  }

  // ------------------------------------------------------------------ listing and persistence

  entries(): readonly UserVocabularyEntry[] {
    return [...this.words.entries()]
      .filter(([w]) => !isSpecialWord(w))
      .sort((a, b) => b[1].count - a[1].count || cmp(a[0], b[0]))
      .map(([, e]) => ({ word: e.display, count: e.count, lastUsedAt: e.lastUsedAt }));
  }

  mass(): number {
    return this.decay.valueAt(this.total.value, this.total.at, this.clock.wallNow());
  }

  /** Number of distinct learned words. */
  get size(): number {
    return this.words.size;
  }

  serialise(): UserModelData {
    const sortedEntries = <E>(map: Map<string, E>): [string, E][] =>
      [...map.entries()].sort((a, b) => cmp(a[0], b[0]));
    return {
      schemaVersion: USER_MODEL_SCHEMA_VERSION,
      kind: 'forsee.user-lm',
      halfLifeMs: this.decay.halfLifeMs,
      words: sortedEntries(this.words).map(
        ([w, e]) => [w, e.display, e.count, e.value, e.at, e.lastUsedAt] as const,
      ),
      bigrams: sortedEntries(this.bigrams).map(([k, e]) => {
        const [a = '', b = ''] = k.split(SEP);
        return [a, b, e.count, e.value, e.at, e.lastUsedAt] as const;
      }),
      trigrams: sortedEntries(this.trigrams).map(([k, e]) => {
        const [a = '', b = '', c = ''] = k.split(SEP);
        return [a, b, c, e.count, e.value, e.at, e.lastUsedAt] as const;
      }),
    };
  }

  load(data: unknown): boolean {
    if (
      !isRecord(data) ||
      data.schemaVersion !== USER_MODEL_SCHEMA_VERSION ||
      data.kind !== 'forsee.user-lm'
    ) {
      return false;
    }
    const { halfLifeMs, words, bigrams, trigrams } = data;
    if (typeof halfLifeMs !== 'number' || !(halfLifeMs > 0)) return false;
    if (!Array.isArray(words) || !Array.isArray(bigrams) || !Array.isArray(trigrams)) return false;
    const nextWords = new Map<string, WordEntry>();
    for (const row of words as unknown[]) {
      if (!isRow(row, 2, 4)) return false;
      const [w, display, count, value, at, last] = row as [
        string,
        string,
        number,
        number,
        number,
        number,
      ];
      nextWords.set(w, { display, count, value, at, lastUsedAt: last });
    }
    const readNgrams = (rows: unknown[], n: number): Map<string, Entry> | null => {
      const map = new Map<string, Entry>();
      for (const row of rows) {
        if (!isRow(row, n, 4)) return null;
        const r = row as unknown[];
        const [count, value, at, last] = r.slice(n) as number[];
        map.set((r.slice(0, n) as string[]).join(SEP), {
          count: count!,
          value: value!,
          at: at!,
          lastUsedAt: last!,
        });
      }
      return map;
    };
    const nextBigrams = readNgrams(bigrams as unknown[], 2);
    const nextTrigrams = readNgrams(trigrams as unknown[], 3);
    if (!nextBigrams || !nextTrigrams) return false;
    this.decay = new Decay(halfLifeMs);
    this.words = nextWords;
    this.bigrams = nextBigrams;
    this.trigrams = nextTrigrams;
    this.rebuild();
    return true;
  }

  // ------------------------------------------------------------------ LanguageModel

  completions(previous: readonly string[], prefix: string, limit: number): readonly Candidate[] {
    const normal = this.tokeniser.normalise(prefix);
    const now = this.clock.wallNow();
    const [u, v] = this.contextOf(previous);
    const [lo, hi] = this.range(normal);
    if (lo >= hi || limit <= 0) return [];
    const sorted = this.sortedWords();
    const inRange = (w: string): boolean => w.startsWith(normal) && !isSpecialWord(w);
    const found = new Map<string, number>();
    const c3 = u !== null && v !== null ? this.ctx3.get(u + SEP + v) : undefined;
    const c2 = v !== null ? this.ctx2.get(v) : undefined;
    if (c3) for (const w of c3.next) if (inRange(w)) found.set(w, this.prob(u, v, w, now));
    if (c2)
      for (const w of c2.next)
        if (inRange(w) && !found.has(w)) found.set(w, this.prob(u, v, w, now));
    const out: [string, number][] = [...found.entries()];
    let taken = 0;
    if (hi - lo <= 256) {
      for (let i = lo; i < hi; i++) {
        const w = sorted[i]!;
        if (!found.has(w) && !isSpecialWord(w)) out.push([w, this.prob(u, v, w, now)]);
      }
    } else {
      for (const w of this.rankedWords()) {
        if (taken >= limit) break;
        if (!inRange(w) || found.has(w)) continue;
        out.push([w, this.prob(u, v, w, now)]);
        taken++;
      }
    }
    return out
      .filter(([, p]) => p > 0)
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, limit)
      .map(([w, p]) => ({ text: this.words.get(w)?.display ?? w, score: p }));
  }

  nextWords(previous: readonly string[], limit: number): readonly Candidate[] {
    return this.completions(previous, '', limit);
  }

  probability(previous: readonly string[], word: string): number {
    const [u, v] = this.contextOf(previous);
    return this.prob(u, v, this.tokeniser.normalise(word), this.clock.wallNow());
  }

  prefixProbability(previous: readonly string[], prefix: string): number {
    const [lo, hi] = this.range(this.tokeniser.normalise(prefix));
    const [u, v] = this.contextOf(previous);
    return this.rangeMass(u, v, lo, hi, this.clock.wallNow());
  }

  letterDistribution(
    previous: readonly string[],
    prefix: string,
  ): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    const normal = this.tokeniser.normalise(prefix);
    const [u, v] = this.contextOf(previous);
    const now = this.clock.wallNow();
    const [lo, hi] = this.range(normal);
    const total = this.rangeMass(u, v, lo, hi, now);
    if (!(total > 0)) return out;
    const sorted = this.sortedWords();
    let i = lo;
    if (i < hi && sorted[i]!.length === normal.length) i++;
    while (i < hi) {
      const g = nextGrapheme(sorted[i]!, normal.length);
      const group = normal + g;
      let end = i + 1;
      while (end < hi && sorted[end]!.startsWith(group)) end++;
      const mass = this.rangeMass(u, v, i, end, now);
      if (mass > 0) out[g] = (out[g] ?? 0) + mass / total;
      i = end;
    }
    return out;
  }

  // ------------------------------------------------------------------ internals

  private contextOf(previous: readonly string[]): [string | null, string | null] {
    const n = previous.length;
    const v = n >= 1 ? this.tokeniser.normalise(previous[n - 1]!) : null;
    const u = n >= 2 ? this.tokeniser.normalise(previous[n - 2]!) : null;
    return [u, v];
  }

  private weightOf(e: Stamped | undefined, now: number): number {
    return e ? this.decay.valueAt(e.value, e.at, now) : 0;
  }

  private p1(w: string, now: number): number {
    const total = this.weightOf(this.total, now);
    return total > 0 ? this.weightOf(this.words.get(w), now) / total : 0;
  }

  private p2(v: string | null, w: string, now: number): number {
    const lower = this.p1(w, now);
    const c = v === null ? undefined : this.ctx2.get(v);
    if (!c) return lower;
    const total = this.weightOf(c.total, now);
    const types = c.next.size;
    return (this.weightOf(this.bigrams.get(v + SEP + w), now) + types * lower) / (total + types);
  }

  private prob(u: string | null, v: string | null, w: string, now: number): number {
    if (isSpecialWord(w)) return 0;
    const lower = this.p2(v, w, now);
    const c = u === null || v === null ? undefined : this.ctx3.get(u + SEP + v);
    if (!c) return lower;
    const total = this.weightOf(c.total, now);
    const types = c.next.size;
    return (
      (this.weightOf(this.trigrams.get(u + SEP + v + SEP + w), now) + types * lower) /
      (total + types)
    );
  }

  /** Σ P(w | u v) over sorted words `[lo, hi)`. */
  private rangeMass(
    u: string | null,
    v: string | null,
    lo: number,
    hi: number,
    now: number,
  ): number {
    if (lo >= hi) return 0;
    const sorted = this.sortedWords();
    const total = this.weightOf(this.total, now);
    if (!(total > 0)) return 0;
    let m1 = 0;
    for (let i = lo; i < hi; i++) m1 += this.weightOf(this.words.get(sorted[i]!), now);
    m1 /= total;
    const lowW = sorted[lo]!;
    const highW = sorted[hi - 1]!;
    const within = (w: string): boolean => w >= lowW && w <= highW && !isSpecialWord(w);
    const c2 = v === null ? undefined : this.ctx2.get(v);
    let m2 = m1;
    if (c2) {
      const t2 = this.weightOf(c2.total, now);
      let seen = 0;
      for (const w of c2.next)
        if (within(w)) seen += this.weightOf(this.bigrams.get(v + SEP + w), now);
      m2 = (seen + c2.next.size * m1) / (t2 + c2.next.size);
    }
    const c3 = u === null || v === null ? undefined : this.ctx3.get(u + SEP + v);
    if (!c3) return m2;
    const t3 = this.weightOf(c3.total, now);
    let seen3 = 0;
    for (const w of c3.next)
      if (within(w)) seen3 += this.weightOf(this.trigrams.get(u + SEP + v + SEP + w), now);
    return (seen3 + c3.next.size * m2) / (t3 + c3.next.size);
  }

  private sortedWords(): string[] {
    this.sorted ??= [...this.words.keys()].sort(cmp);
    return this.sorted;
  }

  private rankedWords(): string[] {
    this.byRank ??= [...this.words.entries()]
      .sort(
        (a, b) =>
          this.decay.rank(b[1].value, b[1].at) - this.decay.rank(a[1].value, a[1].at) ||
          cmp(a[0], b[0]),
      )
      .map(([w]) => w);
    return this.byRank;
  }

  private range(prefix: string): [number, number] {
    const sorted = this.sortedWords();
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    let top = sorted.length;
    while (end < top) {
      const mid = (end + top) >>> 1;
      if (sorted[mid]!.startsWith(prefix)) end = mid + 1;
      else top = mid;
    }
    return [lo, end];
  }
}

function bump(decay: Decay, entry: Entry, weight: number, t: number): void {
  addStamped(decay, entry, weight, t);
  entry.count += 1;
  if (t > entry.lastUsedAt) entry.lastUsedAt = t;
}

function indexContexts(decay: Decay, map: Map<string, Entry>): Map<string, Context> {
  const out = new Map<string, Context>();
  for (const [key, e] of map) {
    const cut = key.lastIndexOf(SEP);
    const ctx = key.slice(0, cut);
    let c = out.get(ctx);
    if (!c) {
      c = { total: { value: 0, at: 0 }, next: new Set() };
      out.set(ctx, c);
    }
    c.next.add(key.slice(cut + 1));
    addStamped(decay, c.total, e.value, e.at);
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRow(row: unknown, strings: number, numbers: number): boolean {
  if (!Array.isArray(row) || row.length !== strings + numbers) return false;
  for (let i = 0; i < row.length; i++) {
    const x: unknown = row[i];
    if (i < strings ? typeof x !== 'string' : typeof x !== 'number' || !Number.isFinite(x))
      return false;
  }
  return true;
}

/** Creates an empty user model. */
export function createUserModel(options: UserModelOptions): AdaptiveUserModel {
  return new AdaptiveUserModel(options);
}
