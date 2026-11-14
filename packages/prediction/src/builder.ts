import { encodeUtf8 } from '@forsee/core';
import type { LocaleTag } from '@forsee/plugin-api';
import { buildCodebook, ByteWriter, quantise } from './binary';
import { CharModelBuilder } from './char-model';
import {
  EOS_ID,
  FIRST_WORD_ID,
  MAX_VOCABULARY,
  MODEL_FORMAT_VERSION,
  MODEL_MAGIC,
  type ModelMetadata,
  SECTION,
  SOS_ID,
  UNK_ID,
} from './format';
import {
  createTokeniser,
  SENTENCE_END,
  SENTENCE_START,
  UNKNOWN_WORD,
  type ForseeTokeniser,
} from './tokeniser';

/**
 * Builds a model file from text (pure; `tools/lm-build` is the Node CLI).
 *
 * Estimation: interpolated Kneser–Ney (Chen & Goodman 1998) with one
 * absolute discount per order, `D = n1 / (n1 + 2 n2)` from the counts of
 * counts (clamped to 0.1..0.9). The highest order uses raw counts, lower
 * orders continuation counts (except n-grams starting at `<s>`, which cannot
 * be extended to the left and keep raw counts). The unigram level
 * interpolates with a uniform distribution and, when a word list is given,
 * with a Zipf prior over the list's rank order (`wordListWeight`).
 *
 * Why Kneser–Ney rather than stupid backoff: the runtime needs proper
 * probabilities, because letter probabilities must form a sub-distribution
 * and the base model is interpolated with the user layer. Stupid backoff
 * scores do not sum to one. KN's continuation counts also rank words that
 * follow many different words (good next-word guesses) above words that are
 * frequent only in one fixed phrase.
 *
 * The result is stored in backoff form (ARPA-style): every stored n-gram
 * keeps its interpolated probability and every context a backoff weight,
 * recomputed after pruning so each conditional distribution still sums to 1
 * (before 8-bit quantisation).
 *
 * Usage: call `addVocabularyText` over the whole corpus (pass 1, word counts
 * and display forms), then `addText` over it again (pass 2, n-gram counts),
 * then `build()`. A sentence never spans two calls. `buildModel` does both
 * passes over an in-memory list.
 */

export interface ModelBuildOptions {
  readonly locale?: LocaleTag;
  /** Word n-gram order, 1..3 (default 3). */
  readonly order?: number;
  /** Maximum vocabulary size, excluding pseudo words (default 50 000). */
  readonly maxVocab?: number;
  /** Minimum corpus count for a word to enter the vocabulary (default 1). Word-list words always enter. */
  readonly minCount?: number;
  /** Bigrams and trigrams seen fewer times than this are pruned (default 1: keep all). */
  readonly minNgramCount?: number;
  /** Optional word list in approximate frequency order (most frequent first). */
  readonly wordList?: readonly string[];
  /** Weight of the word-list prior in the unigram distribution, 0..1 (default 0.3 when a list is given). */
  readonly wordListWeight?: number;
  /** Character model order (default 5). */
  readonly charOrder?: number;
  /** Character contexts of two or more symbols seen fewer times than this are pruned (default 3). */
  readonly charMinCount?: number;
  /** Free text stored in the metadata. */
  readonly description?: string;
}

export interface ModelStats {
  readonly vocabulary: number;
  readonly unigrams: number;
  readonly bigrams: number;
  readonly trigrams: number;
  readonly charContexts: number;
  readonly tokens: number;
  readonly sentences: number;
  readonly bytes: number;
  readonly discounts: readonly number[];
}

const S = 1 << 17;

function clampDiscount(n1: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0.5;
  return Math.min(0.9, Math.max(0.1, n1 / (n1 + 2 * n2)));
}

function discountOf(values: Iterable<number>): number {
  let n1 = 0;
  let n2 = 0;
  for (const v of values) {
    if (v === 1) n1++;
    else if (v === 2) n2++;
  }
  return clampDiscount(n1, n2);
}

const LOG_FLOOR = -12;
function log10p(p: number): number {
  return p > 1e-12 ? Math.log10(p) : LOG_FLOOR;
}

export class ModelBuilder {
  readonly options: Required<Omit<ModelBuildOptions, 'wordList'>> & { wordList: readonly string[] };
  private readonly tokeniser: ForseeTokeniser;
  // pass 1
  private readonly wordCounts = new Map<string, number>();
  private readonly lowerMid = new Map<string, number>();
  private readonly casedMid = new Map<string, Map<string, number>>();
  // pass 2
  private frozen = false;
  private words: string[] = [];
  private readonly idOf = new Map<string, number>();
  private uniRaw = new Float64Array(0);
  private readonly c2 = new Map<number, number>();
  private readonly c3 = new Map<number, number>();
  private tokens = 0;
  private sentences = 0;
  private lastStats: ModelStats | null = null;

  constructor(options: ModelBuildOptions = {}) {
    const wordList = options.wordList ?? [];
    const order = options.order ?? 3;
    if (!(order >= 1 && order <= 3)) throw new RangeError('order must be 1, 2 or 3');
    this.options = {
      locale: options.locale ?? 'en',
      order,
      maxVocab: Math.min(options.maxVocab ?? 50_000, MAX_VOCABULARY),
      minCount: options.minCount ?? 1,
      minNgramCount: options.minNgramCount ?? 1,
      wordList,
      wordListWeight: wordList.length > 0 ? (options.wordListWeight ?? 0.3) : 0,
      charOrder: options.charOrder ?? 5,
      charMinCount: options.charMinCount ?? 3,
      description: options.description ?? '',
    };
    this.tokeniser = createTokeniser(this.options.locale);
  }

  /** Pass 1: word counts and display forms. */
  addVocabularyText(text: string): void {
    if (this.frozen) throw new Error('Vocabulary is frozen: call addVocabularyText before addText');
    for (const sentence of this.tokeniser.sentences(text)) {
      for (const token of sentence) {
        this.wordCounts.set(token.normal, (this.wordCounts.get(token.normal) ?? 0) + 1);
        if (token.sentenceInitial || token.kind !== 'word') continue;
        if (token.surface === token.normal) {
          this.lowerMid.set(token.normal, (this.lowerMid.get(token.normal) ?? 0) + 1);
        } else {
          let forms = this.casedMid.get(token.normal);
          if (!forms) this.casedMid.set(token.normal, (forms = new Map<string, number>()));
          forms.set(token.surface, (forms.get(token.surface) ?? 0) + 1);
        }
      }
    }
  }

  /** Pass 2: n-gram counts. The first call freezes the vocabulary. */
  addText(text: string): void {
    this.freeze();
    const order = this.options.order;
    for (const sentence of this.tokeniser.sentences(text)) {
      this.sentences++;
      const ids = [SOS_ID];
      for (const token of sentence) ids.push(this.idOf.get(token.normal) ?? UNK_ID);
      ids.push(EOS_ID);
      this.tokens += sentence.length;
      for (let i = 1; i < ids.length; i++) {
        const w = ids[i]!;
        this.uniRaw[w] = (this.uniRaw[w] ?? 0) + 1;
        if (order >= 2) {
          const k2 = ids[i - 1]! * S + w;
          this.c2.set(k2, (this.c2.get(k2) ?? 0) + 1);
        }
        if (order >= 3 && i >= 2) {
          const k3 = (ids[i - 2]! * S + ids[i - 1]!) * S + w;
          this.c3.set(k3, (this.c3.get(k3) ?? 0) + 1);
        }
      }
    }
  }

  private freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    const listNormals = this.options.wordList
      .map((w) => this.tokeniser.normalise(w))
      .filter((w) => w !== '');
    // Word-list surfaces vote for display forms.
    this.options.wordList.forEach((surface, i) => {
      const normal = listNormals[i];
      if (normal === undefined || surface === normal) return;
      let forms = this.casedMid.get(normal);
      if (!forms) this.casedMid.set(normal, (forms = new Map<string, number>()));
      forms.set(surface, (forms.get(surface) ?? 0) + 1);
    });
    const chosen = new Set<string>();
    for (const w of listNormals) {
      if (chosen.size >= this.options.maxVocab) break;
      chosen.add(w);
    }
    const corpus = [...this.wordCounts.entries()]
      .filter(([w, c]) => c >= this.options.minCount && !chosen.has(w))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [w] of corpus) {
      if (chosen.size >= this.options.maxVocab) break;
      chosen.add(w);
    }
    this.words = [SENTENCE_START, SENTENCE_END, UNKNOWN_WORD, ...[...chosen].sort()];
    this.words.forEach((w, i) => this.idOf.set(w, i));
    this.uniRaw = new Float64Array(this.words.length);
  }

  /** Estimates the model and returns the file bytes. */
  build(): Uint8Array {
    this.freeze();
    const { order, minNgramCount, wordListWeight } = this.options;
    const V = this.words.length;

    // ---------------------------------------------------------- adjusted counts
    const a2 = new Map<number, number>();
    if (order === 3) {
      for (const k3 of this.c3.keys()) {
        const k2 = k3 % (S * S);
        a2.set(k2, (a2.get(k2) ?? 0) + 1);
      }
      for (const [k2, c] of this.c2) if (Math.floor(k2 / S) === SOS_ID) a2.set(k2, c);
    } else if (order === 2) {
      for (const [k2, c] of this.c2) a2.set(k2, c);
    }
    const a1 = new Float64Array(V);
    if (order >= 2) {
      for (const k2 of this.c2.keys()) a1[k2 % S] = (a1[k2 % S] ?? 0) + 1;
    } else {
      a1.set(this.uniRaw);
    }
    a1[SOS_ID] = 0;
    const d1 = discountOf(a1);
    const d2 = discountOf(a2.values());
    const d3 = discountOf(this.c3.values());

    // ---------------------------------------------------------- unigrams
    const p1 = new Float64Array(V);
    let A1 = 0;
    let T1 = 0;
    for (let w = 0; w < V; w++) {
      A1 += a1[w]!;
      if (a1[w]! > 0) T1++;
    }
    const predicted = Math.max(1, V - 1);
    for (let w = 1; w < V; w++) {
      p1[w] = A1 > 0 ? Math.max(a1[w]! - d1, 0) / A1 + (d1 * T1) / A1 / predicted : 1 / predicted;
    }
    if (wordListWeight > 0) {
      const prior = new Float64Array(V);
      let sum = 0;
      const seen = new Set<number>();
      this.options.wordList.forEach((surface, rank) => {
        const id = this.idOf.get(this.tokeniser.normalise(surface));
        if (id === undefined || seen.has(id)) return;
        seen.add(id);
        const v = 1 / (rank + 2.7);
        prior[id] = v;
        sum += v;
      });
      if (sum > 0) {
        const mu = A1 > 0 ? wordListWeight : 1;
        for (let w = 1; w < V; w++) p1[w] = (1 - mu) * p1[w]! + (mu * prior[w]!) / sum;
      }
    }
    p1[SOS_ID] = 0;

    // ---------------------------------------------------------- pruning decisions
    const keep3 = new Set<number>();
    for (const [k3, c] of this.c3) if (c >= minNgramCount) keep3.add(k3);
    const keep2 = new Set<number>();
    for (const [k2, c] of this.c2) if (c >= minNgramCount) keep2.add(k2);
    for (const k3 of keep3) keep2.add(Math.floor(k3 / S));

    // ---------------------------------------------------------- bigrams
    const bigramKeys = order >= 2 ? [...a2.keys()].sort((x, y) => x - y) : [];
    const ctx2 = new Map<number, { total: number; types: number }>();
    for (const k2 of bigramKeys) {
      const v = Math.floor(k2 / S);
      const e = ctx2.get(v) ?? { total: 0, types: 0 };
      e.total += a2.get(k2)!;
      e.types += 1;
      ctx2.set(v, e);
    }
    const gamma2 = (v: number): number => {
      const e = ctx2.get(v);
      return e ? (d2 * e.types) / e.total : 1;
    };
    const p2full = (v: number, w: number): number => {
      const a = a2.get(v * S + w);
      const e = ctx2.get(v);
      if (!e) return p1[w]!;
      return (a === undefined ? 0 : Math.max(a - d2, 0) / e.total) + gamma2(v) * p1[w]!;
    };
    const storedBigrams = bigramKeys.filter((k) => keep2.has(k));
    const bow1 = new Float64Array(V).fill(1);
    {
      const sums = new Map<number, [number, number]>();
      for (const k2 of storedBigrams) {
        const v = Math.floor(k2 / S);
        const w = k2 % S;
        const s = sums.get(v) ?? [0, 0];
        s[0] += p2full(v, w);
        s[1] += p1[w]!;
        sums.set(v, s);
      }
      for (const [v, [hi, lo]] of sums) bow1[v] = backoffWeight(hi, lo);
    }
    const bigramIndex = new Map<number, number>();
    storedBigrams.forEach((k, i) => bigramIndex.set(k, i));
    const p2runtime = (v: number, w: number): number =>
      bigramIndex.has(v * S + w) ? p2full(v, w) : bow1[v]! * p1[w]!;

    // ---------------------------------------------------------- trigrams
    const trigramKeys = order >= 3 ? [...this.c3.keys()].sort((x, y) => x - y) : [];
    const ctx3 = new Map<number, { total: number; types: number }>();
    for (const k3 of trigramKeys) {
      const h = Math.floor(k3 / S);
      const e = ctx3.get(h) ?? { total: 0, types: 0 };
      e.total += this.c3.get(k3)!;
      e.types += 1;
      ctx3.set(h, e);
    }
    const storedTrigrams = trigramKeys.filter((k) => keep3.has(k));
    const p3 = new Float64Array(storedTrigrams.length);
    const bow2 = new Float64Array(storedBigrams.length).fill(1);
    {
      const sums = new Map<number, [number, number]>();
      storedTrigrams.forEach((k3, i) => {
        const h = Math.floor(k3 / S);
        const v = h % S;
        const w = k3 % S;
        const e = ctx3.get(h)!;
        const p =
          Math.max(this.c3.get(k3)! - d3, 0) / e.total + ((d3 * e.types) / e.total) * p2full(v, w);
        p3[i] = p;
        const s = sums.get(h) ?? [0, 0];
        s[0] += p;
        s[1] += p2runtime(v, w);
        sums.set(h, s);
      });
      for (const [h, [hi, lo]] of sums) {
        const b = bigramIndex.get(h);
        if (b !== undefined) bow2[b] = backoffWeight(hi, lo);
      }
    }

    // ---------------------------------------------------------- write
    const out = new ByteWriter();
    const sections: [number, (w: ByteWriter) => void][] = [];
    const metadata: ModelMetadata = {
      locale: this.options.locale,
      description: this.options.description,
      discounts: order === 3 ? [d1, d2, d3] : order === 2 ? [d1, d2] : [d1],
      wordListWeight,
      tokens: this.tokens,
      sentences: this.sentences,
    };
    sections.push([SECTION.META, (w) => w.bytes(encodeUtf8(JSON.stringify(metadata)))]);
    sections.push([SECTION.VOCAB, (w) => writeStrings(w, this.words)]);
    const display = this.displayForms();
    sections.push([
      SECTION.DISPLAY,
      (w) => {
        w.u32(display.length);
        w.u32Array(display.map(([id]) => id));
        writeStringBody(
          w,
          display.map(([, s]) => s),
        );
      },
    ]);
    sections.push([
      SECTION.UNIGRAMS,
      (w) => {
        const lp = Array.from(p1, log10p);
        const lb = Array.from(bow1, log10p);
        const cbP = buildCodebook(lp.slice(1));
        const cbB = buildCodebook(lb);
        w.f32Array(cbP);
        w.f32Array(cbB);
        w.u8Array(lp.map((x) => quantise(cbP, x)));
        w.u8Array(lb.map((x) => quantise(cbB, x)));
      },
    ]);
    const idWidth = V <= 0x10000 ? 2 : 4;
    if (order >= 2) {
      sections.push([
        SECTION.BIGRAMS,
        (w) => {
          const B = storedBigrams.length;
          w.u32(B);
          w.u32(idWidth);
          const lp = storedBigrams.map((k) => log10p(p2full(Math.floor(k / S), k % S)));
          const lb = Array.from(bow2, log10p);
          const cbP = buildCodebook(lp);
          const cbB = buildCodebook(lb);
          w.f32Array(cbP);
          w.f32Array(cbB);
          const start = new Uint32Array(V + 1);
          for (const k of storedBigrams) start[Math.floor(k / S) + 1]!++;
          for (let i = 0; i < V; i++) start[i + 1]! += start[i]!;
          w.u32Array(start);
          const ids = storedBigrams.map((k) => k % S);
          if (idWidth === 2) w.u16Array(ids);
          else w.u32Array(ids);
          w.u8Array(lp.map((x) => quantise(cbP, x)));
          w.u8Array(lb.map((x) => quantise(cbB, x)));
        },
      ]);
    }
    if (order >= 3) {
      sections.push([
        SECTION.TRIGRAMS,
        (w) => {
          const T = storedTrigrams.length;
          w.u32(T);
          w.u32(idWidth);
          const lp = Array.from(p3, log10p);
          const cbP = buildCodebook(lp);
          w.f32Array(cbP);
          const start = new Uint32Array(storedBigrams.length + 1);
          for (const k3 of storedTrigrams) start[bigramIndex.get(Math.floor(k3 / S))! + 1]!++;
          for (let i = 0; i < storedBigrams.length; i++) start[i + 1]! += start[i]!;
          w.u32Array(start);
          const ids = storedTrigrams.map((k) => k % S);
          if (idWidth === 2) w.u16Array(ids);
          else w.u32Array(ids);
          w.u8Array(lp.map((x) => quantise(cbP, x)));
        },
      ]);
    }
    const chars = new CharModelBuilder(this.options.charOrder, this.options.charMinCount);
    for (let id = FIRST_WORD_ID; id < V; id++) {
      const word = this.words[id]!;
      const count = this.wordCounts.get(word) ?? 0;
      chars.addWord(word, 1 + Math.floor(Math.log2(1 + count)));
    }
    let charContexts = 0;
    sections.push([SECTION.CHARS, (w) => (charContexts = chars.write(w).contexts)]);

    // header
    for (const ch of MODEL_MAGIC) out.u8(ch.charCodeAt(0));
    out.u16(MODEL_FORMAT_VERSION);
    out.u16(order);
    out.u32(sections.length);
    out.u32(0);
    const table = out.position;
    for (const _ of sections) {
      out.u32(0);
      out.u32(0);
      out.u32(0);
    }
    sections.forEach(([tag, write], i) => {
      out.align4();
      const start = out.position;
      write(out);
      const length = out.position - start;
      out.patchU32(table + i * 12, tag);
      out.patchU32(table + i * 12 + 4, start);
      out.patchU32(table + i * 12 + 8, length);
    });
    out.align4();
    const bytes = out.toBytes();
    this.lastStats = {
      vocabulary: V - FIRST_WORD_ID,
      unigrams: V,
      bigrams: storedBigrams.length,
      trigrams: storedTrigrams.length,
      charContexts,
      tokens: this.tokens,
      sentences: this.sentences,
      bytes: bytes.length,
      discounts: metadata.discounts,
    };
    return bytes;
  }

  /** Statistics of the last `build()`. */
  stats(): ModelStats {
    if (!this.lastStats) throw new Error('build() has not been called');
    return this.lastStats;
  }

  private displayForms(): [number, string][] {
    const out: [number, string][] = [];
    for (let id = FIRST_WORD_ID; id < this.words.length; id++) {
      const word = this.words[id]!;
      const forms = this.casedMid.get(word);
      if (!forms) {
        const fallback = this.tokeniser.defaultDisplay(word);
        if (fallback !== word && !this.lowerMid.has(word)) out.push([id, fallback]);
        continue;
      }
      let best = word;
      let bestCount = this.lowerMid.get(word) ?? 0;
      for (const [surface, count] of [...forms.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (count > bestCount) {
          best = surface;
          bestCount = count;
        }
      }
      if (best !== word) out.push([id, best]);
    }
    return out;
  }
}

function backoffWeight(sumHigh: number, sumLow: number): number {
  const num = Math.max(1 - sumHigh, 1e-9);
  const den = 1 - sumLow;
  if (den <= 1e-9) return 1;
  return num / den;
}

function writeStrings(w: ByteWriter, strings: readonly string[]): void {
  w.u32(strings.length);
  writeStringBody(w, strings);
}

function writeStringBody(w: ByteWriter, strings: readonly string[]): void {
  const encoded = strings.map((s) => encodeUtf8(s));
  const offsets = [0];
  for (const e of encoded) offsets.push(offsets[offsets.length - 1]! + e.length);
  w.u32Array(offsets);
  for (const e of encoded) w.bytes(e);
}

/** Builds a model from in-memory texts (both passes). */
export function buildModel(texts: readonly string[], options: ModelBuildOptions = {}): Uint8Array {
  return buildModelWithStats(texts, options).bytes;
}

/** Like `buildModel`, also returning the statistics. */
export function buildModelWithStats(
  texts: readonly string[],
  options: ModelBuildOptions = {},
): { bytes: Uint8Array; stats: ModelStats } {
  const builder = new ModelBuilder(options);
  for (const t of texts) builder.addVocabularyText(t);
  for (const t of texts) builder.addText(t);
  const bytes = builder.build();
  return { bytes, stats: builder.stats() };
}
