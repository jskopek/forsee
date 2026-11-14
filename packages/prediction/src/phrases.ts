import type { Clock } from '@forsee/core';
import type { LocaleTag, PhraseCandidate } from '@forsee/plugin-api';
import type { PhraseRecall } from './contracts';
import { addStamped, Decay } from './decay';
import { DEFAULT_HALF_LIFE_MS } from './user-model';
import { createTokeniser, type ForseeTokeniser } from './tokeniser';

/**
 * Phrase recall from the user's own utterances. Each utterance is keyed by
 * its normalised words (lower case, punctuation dropped). A suggestion is a
 * stored phrase whose key starts with the words typed so far in the current
 * sentence (the last typed word may be partial), ranked by recency-weighted
 * frequency ("frecency", same decay as the user model). With nothing typed
 * in the current sentence the most frecent phrases are suggested.
 */

export interface PhraseRecallOptions {
  readonly clock: Clock;
  readonly locale?: LocaleTag;
  readonly halfLifeMs?: number;
  /** Most phrases kept; the least frecent are dropped first (default 2000). */
  readonly maxPhrases?: number;
  /** Utterances with fewer words are not stored (default 2). */
  readonly minWords?: number;
}

interface PhraseEntry {
  text: string;
  count: number;
  value: number;
  at: number;
  lastUsedAt: number;
}

/** JSON form of the phrase store. */
export interface PhraseStoreData {
  readonly schemaVersion: 1;
  readonly kind: 'forsee.phrases';
  readonly halfLifeMs: number;
  /** `[text, count, weight, weightAt, lastUsedAt]` */
  readonly phrases: readonly (readonly [string, number, number, number, number])[];
}

export class PhraseStore implements PhraseRecall {
  private readonly clock: Clock;
  private readonly tokeniser: ForseeTokeniser;
  private decay: Decay;
  private readonly maxPhrases: number;
  private readonly minWords: number;
  private phrases = new Map<string, PhraseEntry>();

  constructor(options: PhraseRecallOptions) {
    this.clock = options.clock;
    this.tokeniser = createTokeniser(options.locale ?? 'en');
    this.decay = new Decay(options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS);
    this.maxPhrases = options.maxPhrases ?? 2000;
    this.minWords = options.minWords ?? 2;
  }

  get size(): number {
    return this.phrases.size;
  }

  private key(text: string): string {
    return this.tokeniser.words(text).join(' ');
  }

  add(text: string, createdAt: number): void {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    const key = this.key(trimmed);
    if (key === '' || key.split(' ').length < this.minWords) return;
    let entry = this.phrases.get(key);
    if (!entry) {
      entry = { text: trimmed, count: 0, value: 0, at: createdAt, lastUsedAt: createdAt };
      this.phrases.set(key, entry);
    }
    addStamped(this.decay, entry, 1, createdAt);
    entry.count += 1;
    if (createdAt >= entry.lastUsedAt) {
      entry.lastUsedAt = createdAt;
      entry.text = trimmed;
    }
    if (this.phrases.size > this.maxPhrases) this.trim();
  }

  remove(text: string): void {
    this.phrases.delete(this.key(text));
  }

  /** Removes every phrase containing one of `words` (used when the user forgets a word). */
  removeContaining(words: readonly string[]): void {
    const doomed = new Set(words.map((w) => this.tokeniser.normalise(w)));
    for (const key of [...this.phrases.keys()]) {
      if (key.split(' ').some((w) => doomed.has(w))) this.phrases.delete(key);
    }
  }

  clear(): void {
    this.phrases.clear();
  }

  suggest(textBefore: string, limit: number): readonly PhraseCandidate[] {
    if (limit <= 0 || this.phrases.size === 0) return [];
    const sentences = this.tokeniser.sentences(textBefore);
    const context = this.tokeniser.context(textBefore, Number.MAX_SAFE_INTEGER).slice(1);
    let typed = context.join(' ');
    // A word is complete when the text ends after it (space or punctuation).
    const last =
      sentences[sentences.length - 1]?.[(sentences[sentences.length - 1]?.length ?? 1) - 1];
    if (typed !== '' && last !== undefined && last.end < textBefore.length) typed += ' ';
    const now = this.clock.wallNow();
    const scored: [string, PhraseEntry, number][] = [];
    for (const [key, entry] of this.phrases) {
      if (!key.startsWith(typed) || key === typed.trimEnd()) continue;
      scored.push([key, entry, this.decay.valueAt(entry.value, entry.at, now)]);
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    // Score w / (w + 1): one recent use ≈ 0.5, frequent recent use → 1.
    return scored
      .slice(0, limit)
      .map(([, e, w]) => ({ id: e.text, text: e.text, score: w / (w + 1) }));
  }

  private trim(): void {
    const ranked = [...this.phrases.entries()].sort(
      (a, b) =>
        this.decay.rank(b[1].value, b[1].at) - this.decay.rank(a[1].value, a[1].at) ||
        (a[0] < b[0] ? -1 : 1),
    );
    this.phrases = new Map(ranked.slice(0, Math.floor(this.maxPhrases * 0.9)));
  }

  serialise(): PhraseStoreData {
    return {
      schemaVersion: 1,
      kind: 'forsee.phrases',
      halfLifeMs: this.decay.halfLifeMs,
      phrases: [...this.phrases.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, e]) => [e.text, e.count, e.value, e.at, e.lastUsedAt] as const),
    };
  }

  load(data: unknown): boolean {
    if (typeof data !== 'object' || data === null) return false;
    const d = data as Partial<PhraseStoreData>;
    if (d.schemaVersion !== 1 || d.kind !== 'forsee.phrases' || !Array.isArray(d.phrases))
      return false;
    if (typeof d.halfLifeMs !== 'number' || !(d.halfLifeMs > 0)) return false;
    const next = new Map<string, PhraseEntry>();
    for (const row of d.phrases as unknown[]) {
      if (!Array.isArray(row) || row.length !== 5 || typeof row[0] !== 'string') return false;
      const nums = row.slice(1) as unknown[];
      if (!nums.every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
      const [text, count, value, at, lastUsedAt] = row as [string, number, number, number, number];
      next.set(this.key(text), { text, count, value, at, lastUsedAt });
    }
    this.decay = new Decay(d.halfLifeMs);
    this.phrases = next;
    return true;
  }
}

/** Creates an empty phrase store. */
export function createPhraseRecall(options: PhraseRecallOptions): PhraseStore {
  return new PhraseStore(options);
}
