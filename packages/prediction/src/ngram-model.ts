import { decodeUtf8 } from '@forsee/core';
import type { Candidate, LocaleTag } from '@forsee/plugin-api';
import { ByteReader, ModelFormatError } from './binary';
import { CharModel, EOW_SYMBOL } from './char-model';
import type { LanguageModel } from './contracts';
import {
  FIRST_WORD_ID,
  MODEL_FORMAT_VERSION,
  MODEL_MAGIC,
  type ModelMetadata,
  SECTION,
  SOS_ID,
  UNK_ID,
} from './format';
import { createTokeniser, type ForseeTokeniser } from './tokeniser';
import { nextGrapheme } from './text';

/** Options for `loadLanguageModel`. */
export interface LoadModelOptions {
  /**
   * Weight of the character model in letter distributions when the word
   * model knows words with the typed prefix (default 0.1). When it knows
   * none, the character model is used alone.
   */
  readonly charWeight?: number;
}

/** A word with its conditional probability, internal form. */
export interface ScoredWord {
  readonly id: number;
  readonly p: number;
}

const SMALL_RANGE = 4096;

/**
 * Runtime of the binary model (see `format.ts`). Immutable and cheap to
 * query: completions and next words are found with binary searches over
 * the alphabetically ordered vocabulary and successor lists.
 */
export class NgramLanguageModel implements LanguageModel {
  readonly locale: LocaleTag;
  readonly metadata: ModelMetadata;
  readonly order: number;
  private readonly tokeniser: ForseeTokeniser;
  private readonly words: string[];
  private readonly idOf = new Map<string, number>();
  private readonly display = new Map<number, string>();
  private readonly p1: Float64Array;
  private readonly bow1: Float64Array;
  private readonly cum1: Float64Array;
  private readonly byProb: Uint32Array;
  private readonly biStart: Uint32Array;
  private readonly biWord: Uint16Array | Uint32Array;
  private readonly biP: Uint8Array;
  private readonly biBow: Uint8Array;
  private readonly biPBook: Float64Array;
  private readonly biBowBook: Float64Array;
  private readonly triStart: Uint32Array;
  private readonly triWord: Uint16Array | Uint32Array;
  private readonly triP: Uint8Array;
  private readonly triPBook: Float64Array;
  readonly chars: CharModel | null;
  private readonly charWeight: number;

  constructor(bytes: Uint8Array, options: LoadModelOptions = {}) {
    this.charWeight = options.charWeight ?? 0.1;
    const header = new ByteReader(bytes);
    let magic = '';
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(header.u8());
    if (magic !== MODEL_MAGIC) throw new ModelFormatError('Not a Forsee language model');
    const version = header.u16();
    if (version !== MODEL_FORMAT_VERSION) {
      throw new ModelFormatError(`Unsupported model format version ${version}`);
    }
    this.order = header.u16();
    const count = header.u32();
    header.u32();
    const sections = new Map<number, ByteReader>();
    for (let i = 0; i < count; i++) {
      const tag = header.u32();
      const offset = header.u32();
      const length = header.u32();
      if (offset + length > bytes.length) throw new ModelFormatError('Section out of range');
      sections.set(tag, new ByteReader(bytes, offset, offset + length));
    }
    const need = (tag: number, name: string): ByteReader => {
      const r = sections.get(tag);
      if (!r) throw new ModelFormatError(`Missing section ${name}`);
      return r;
    };

    const meta = need(SECTION.META, 'META');
    const metaBytes = meta.bytes(meta.remaining);
    this.metadata = JSON.parse(decodeUtf8(metaBytes)) as ModelMetadata;
    this.locale = this.metadata.locale;
    this.tokeniser = createTokeniser(this.locale);

    const vocab = need(SECTION.VOCAB, 'VOCB');
    const V = vocab.u32();
    this.words = readStringBody(vocab, V);
    this.words.forEach((w, i) => this.idOf.set(w, i));

    const disp = sections.get(SECTION.DISPLAY);
    if (disp) {
      const m = disp.u32();
      const ids = disp.u32Array(m);
      const forms = readStringBody(disp, m);
      forms.forEach((f, i) => this.display.set(ids[i]!, f));
    }

    const uni = need(SECTION.UNIGRAMS, 'UNIG');
    const pBook = linearBook(uni.f32Array(256));
    const bBook = linearBook(uni.f32Array(256));
    const qp = uni.u8Array(V);
    const qb = uni.u8Array(V);
    this.p1 = new Float64Array(V);
    this.bow1 = new Float64Array(V);
    this.cum1 = new Float64Array(V + 1);
    for (let i = 0; i < V; i++) {
      this.p1[i] = i === SOS_ID ? 0 : pBook[qp[i]!]!;
      this.bow1[i] = bBook[qb[i]!]!;
      this.cum1[i + 1] = this.cum1[i]! + (i >= FIRST_WORD_ID ? this.p1[i]! : 0);
    }
    const ids: number[] = [];
    for (let i = FIRST_WORD_ID; i < V; i++) ids.push(i);
    ids.sort((a, b) => this.p1[b]! - this.p1[a]! || a - b);
    this.byProb = Uint32Array.from(ids);

    const bi = sections.get(SECTION.BIGRAMS);
    if (bi) {
      const B = bi.u32();
      const width = bi.u32();
      this.biPBook = linearBook(bi.f32Array(256));
      this.biBowBook = linearBook(bi.f32Array(256));
      this.biStart = bi.u32Array(V + 1);
      this.biWord = width === 2 ? bi.u16Array(B) : bi.u32Array(B);
      this.biP = bi.u8Array(B);
      this.biBow = bi.u8Array(B);
    } else {
      this.biPBook = new Float64Array(256);
      this.biBowBook = new Float64Array(256);
      this.biStart = new Uint32Array(V + 1);
      this.biWord = new Uint32Array(0);
      this.biP = new Uint8Array(0);
      this.biBow = new Uint8Array(0);
    }
    const tri = sections.get(SECTION.TRIGRAMS);
    if (tri) {
      const T = tri.u32();
      const width = tri.u32();
      this.triPBook = linearBook(tri.f32Array(256));
      this.triStart = tri.u32Array(this.biWord.length + 1);
      this.triWord = width === 2 ? tri.u16Array(T) : tri.u32Array(T);
      this.triP = tri.u8Array(T);
    } else {
      this.triPBook = new Float64Array(256);
      this.triStart = new Uint32Array(this.biWord.length + 1);
      this.triWord = new Uint32Array(0);
      this.triP = new Uint8Array(0);
    }
    const ch = sections.get(SECTION.CHARS);
    this.chars = ch ? CharModel.read(ch) : null;
  }

  /** Number of regular words (excluding pseudo words). */
  get vocabularySize(): number {
    return this.words.length - FIRST_WORD_ID;
  }

  /** The id of a normalised word, or -1. */
  idOfWord(word: string): number {
    return this.idOf.get(word) ?? -1;
  }

  /** The display form of a word id (vocabulary casing such as `I'm`). */
  displayOf(id: number): string {
    return this.display.get(id) ?? this.words[id] ?? '';
  }

  /** The normalised form of a word id. */
  wordOf(id: number): string {
    return this.words[id] ?? '';
  }

  // ------------------------------------------------------------------ LanguageModel

  completions(previous: readonly string[], prefix: string, limit: number): readonly Candidate[] {
    return this.topWords(this.context(previous), this.tokeniser.normalise(prefix), limit).map(
      (s) => ({
        text: this.displayOf(s.id),
        score: s.p,
      }),
    );
  }

  nextWords(previous: readonly string[], limit: number): readonly Candidate[] {
    return this.completions(previous, '', limit);
  }

  probability(previous: readonly string[], word: string): number {
    const id = this.idOf.get(this.tokeniser.normalise(word));
    if (id === undefined || id < FIRST_WORD_ID) return 0;
    return this.prob(this.context(previous), id);
  }

  prefixProbability(previous: readonly string[], prefix: string): number {
    const [lo, hi] = this.prefixRange(this.tokeniser.normalise(prefix));
    return this.rangeMass(this.context(previous), lo, hi);
  }

  letterDistribution(
    previous: readonly string[],
    prefix: string,
  ): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    const normal = this.tokeniser.normalise(prefix);
    const ctx = this.context(previous);
    const [lo, hi] = this.prefixRange(normal);
    const total = this.rangeMass(ctx, lo, hi);
    const charP = this.chars?.distribution(normal) ?? null;
    const alpha = total > 0 ? (charP ? this.charWeight : 0) : 1;
    if (total > 0) {
      let i = lo;
      // The word equal to the prefix (if any) sorts first: it is "end of word".
      if (i < hi && this.words[i]!.length === normal.length) i++;
      while (i < hi) {
        const g = nextGrapheme(this.words[i]!, normal.length);
        const groupPrefix = normal + g;
        const end = this.upperBound(groupPrefix, i, hi);
        const mass = this.rangeMass(ctx, i, end);
        if (mass > 0) out[g] = (out[g] ?? 0) + ((1 - alpha) * mass) / total;
        i = end;
      }
    }
    if (charP && alpha > 0) {
      for (let s = EOW_SYMBOL + 1; s < charP.length; s++) {
        const p = charP[s]!;
        if (p <= 0) continue;
        const g = this.chars!.symbolText(s);
        out[g] = (out[g] ?? 0) + alpha * p;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ internals

  /** Context ids `[u, v]` (u or v may be -1 for none). */
  context(previous: readonly string[]): [number, number] {
    const n = previous.length;
    const look = (k: number): number => {
      if (k < 0 || this.order < 2) return -1;
      const w = previous[k];
      if (w === undefined) return -1;
      return this.idOf.get(this.tokeniser.normalise(w)) ?? UNK_ID;
    };
    const v = look(n - 1);
    const u = this.order >= 3 && v >= 0 ? look(n - 2) : -1;
    return [u, v];
  }

  /** `[lo, hi)` word ids (regular words only) starting with `prefix`. */
  prefixRange(prefix: string): [number, number] {
    const V = this.words.length;
    if (prefix === '') return [FIRST_WORD_ID, V];
    const lo = this.lowerBound(prefix, FIRST_WORD_ID, V);
    return [lo, this.upperBound(prefix, lo, V)];
  }

  private lowerBound(prefix: string, lo: number, hi: number): number {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.words[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index in `[lo, hi)` whose word does not start with `prefix` (assuming all before do). */
  private upperBound(prefix: string, lo: number, hi: number): number {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.words[mid]!.startsWith(prefix)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private bigram(v: number, w: number): number {
    return search(this.biWord, this.biStart[v] ?? 0, this.biStart[v + 1] ?? 0, w);
  }

  private trigram(b: number, w: number): number {
    return search(this.triWord, this.triStart[b] ?? 0, this.triStart[b + 1] ?? 0, w);
  }

  /** P(w | context) in backoff form. */
  prob(ctx: [number, number], w: number): number {
    const [u, v] = ctx;
    let scale = 1;
    if (u >= 0 && v >= 0) {
      const b = this.bigram(u, v);
      if (b >= 0) {
        const t = this.trigram(b, w);
        if (t >= 0) return this.triPBook[this.triP[t]!]!;
        scale = this.biBowBook[this.biBow[b]!]!;
      }
    }
    if (v >= 0) {
      const b = this.bigram(v, w);
      if (b >= 0) return scale * this.biPBook[this.biP[b]!]!;
      scale *= this.bow1[v]!;
    }
    return scale * this.p1[w]!;
  }

  /** Bigram-level probability P(w | v). */
  private prob2(v: number, w: number): number {
    if (v < 0) return this.p1[w]!;
    const b = this.bigram(v, w);
    return b >= 0 ? this.biPBook[this.biP[b]!]! : this.bow1[v]! * this.p1[w]!;
  }

  /** Σ P(w | context) for word ids in `[lo, hi)`. */
  rangeMass(ctx: [number, number], lo: number, hi: number): number {
    if (lo >= hi) return 0;
    const [u, v] = ctx;
    let mass = this.cum1[hi]! - this.cum1[lo]!;
    if (v >= 0) {
      const s = this.biStart[v]!;
      const e = this.biStart[v + 1]!;
      const a = lowerBoundIds(this.biWord, s, e, lo);
      const z = lowerBoundIds(this.biWord, a, e, hi);
      let seen = 0;
      let seenLow = 0;
      for (let i = a; i < z; i++) {
        seen += this.biPBook[this.biP[i]!]!;
        seenLow += this.p1[this.biWord[i]!]!;
      }
      mass = seen + this.bow1[v]! * Math.max(0, mass - seenLow);
      if (u >= 0) {
        const b = this.bigram(u, v);
        if (b >= 0) {
          const s3 = this.triStart[b]!;
          const e3 = this.triStart[b + 1]!;
          const a3 = lowerBoundIds(this.triWord, s3, e3, lo);
          const z3 = lowerBoundIds(this.triWord, a3, e3, hi);
          let seen3 = 0;
          let seen3Low = 0;
          for (let i = a3; i < z3; i++) {
            seen3 += this.triPBook[this.triP[i]!]!;
            seen3Low += this.prob2(v, this.triWord[i]!);
          }
          mass = seen3 + this.biBowBook[this.biBow[b]!]! * Math.max(0, mass - seen3Low);
        }
      }
    }
    return mass;
  }

  /** The `limit` most probable word ids starting with `prefix` (normalised). */
  topWords(ctx: [number, number], prefix: string, limit: number): ScoredWord[] {
    if (limit <= 0) return [];
    const [lo, hi] = this.prefixRange(prefix);
    if (lo >= hi) return [];
    const [u, v] = ctx;
    const found = new Map<number, number>();
    let scale = 1;
    if (u >= 0 && v >= 0) {
      const b = this.bigram(u, v);
      if (b >= 0) {
        const s = this.triStart[b]!;
        const e = this.triStart[b + 1]!;
        const z = lowerBoundIds(this.triWord, s, e, hi);
        for (let i = lowerBoundIds(this.triWord, s, e, lo); i < z; i++) {
          found.set(this.triWord[i]!, this.triPBook[this.triP[i]!]!);
        }
        scale = this.biBowBook[this.biBow[b]!]!;
      }
    }
    if (v >= 0) {
      const s = this.biStart[v]!;
      const e = this.biStart[v + 1]!;
      const z = lowerBoundIds(this.biWord, s, e, hi);
      for (let i = lowerBoundIds(this.biWord, s, e, lo); i < z; i++) {
        const w = this.biWord[i]!;
        if (!found.has(w)) found.set(w, scale * this.biPBook[this.biP[i]!]!);
      }
      scale *= this.bow1[v]!;
    }
    const top = new TopK(limit);
    for (const [id, p] of found) top.offer(id, p);
    // Unigram backoff candidates not already scored.
    let taken = 0;
    if (hi - lo <= SMALL_RANGE) {
      for (let id = lo; id < hi; id++) {
        if (!found.has(id)) top.offer(id, scale * this.p1[id]!);
      }
    } else {
      for (let i = 0; i < this.byProb.length && taken < limit; i++) {
        const id = this.byProb[i]!;
        if (id < lo || id >= hi || found.has(id)) continue;
        top.offer(id, scale * this.p1[id]!);
        taken++;
      }
    }
    return top.result();
  }
}

/** Keeps the best `k` (id, p) pairs; ties broken by lower id. */
export class TopK {
  private readonly items: ScoredWord[] = [];
  constructor(private readonly k: number) {}

  offer(id: number, p: number): void {
    const items = this.items;
    if (items.length === this.k) {
      const last = items[items.length - 1]!;
      if (p < last.p || (p === last.p && id > last.id)) return;
    }
    let i = items.length;
    while (i > 0) {
      const prev = items[i - 1]!;
      if (prev.p > p || (prev.p === p && prev.id < id)) break;
      i--;
    }
    items.splice(i, 0, { id, p });
    if (items.length > this.k) items.pop();
  }

  result(): ScoredWord[] {
    return this.items;
  }
}

function search(arr: Uint16Array | Uint32Array, lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = arr[mid]!;
    if (x === value) return mid;
    if (x < value) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

function lowerBoundIds(
  arr: Uint16Array | Uint32Array,
  lo: number,
  hi: number,
  value: number,
): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function linearBook(logBook: Float32Array): Float64Array {
  const out = new Float64Array(logBook.length);
  for (let i = 0; i < logBook.length; i++) out[i] = Math.pow(10, logBook[i]!);
  return out;
}

function readStringBody(r: ByteReader, n: number): string[] {
  const offsets = r.u32Array(n + 1);
  const body = r.bytes(offsets[n] ?? 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(decodeUtf8(body.subarray(offsets[i], offsets[i + 1])));
  return out;
}

/** Loads a model file. Throws `ModelFormatError` when the bytes are not a valid model. */
export function loadLanguageModel(
  bytes: Uint8Array,
  options: LoadModelOptions = {},
): NgramLanguageModel {
  return new NgramLanguageModel(bytes, options);
}
