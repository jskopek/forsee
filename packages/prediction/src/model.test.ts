import { describe, expect, it } from 'vitest';
import { buildCodebook, decodeBase64, encodeBase64, quantise } from './binary';
import { buildModel, buildModelWithStats } from './builder';
import { EOS_ID, UNK_ID } from './format';
import { loadLanguageModel } from './ngram-model';
import { SENTENCE_START } from './tokeniser';

const TINY = ['a b', 'a b', 'a c'];

describe('model build, serialise and load', () => {
  it('round-trips and is deterministic', () => {
    const one = buildModel(TINY, { order: 3 });
    const two = buildModel([...TINY], { order: 3 });
    expect(one).toEqual(two);
    const model = loadLanguageModel(one);
    expect(model.vocabularySize).toBe(3);
    expect(model.locale).toBe('en');
    expect(model.metadata.sentences).toBe(3);
  });

  it('rejects files that are not models', () => {
    expect(() => loadLanguageModel(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      /Not a Forsee/,
    );
    const bytes = buildModel(TINY);
    bytes[4] = 99;
    expect(() => loadLanguageModel(bytes)).toThrow(/version/);
  });

  it('loads from an unaligned copy', () => {
    const bytes = buildModel(TINY);
    const shifted = new Uint8Array(bytes.length + 1);
    shifted.set(bytes, 1);
    const model = loadLanguageModel(shifted.subarray(1));
    expect(model.probability(['a'], 'b')).toBeCloseTo(
      loadLanguageModel(bytes).probability(['a'], 'b'),
      9,
    );
  });

  it('works with an empty corpus', () => {
    const model = loadLanguageModel(buildModel([]));
    expect(model.vocabularySize).toBe(0);
    expect(model.completions([], 'a', 5)).toEqual([]);
    expect(model.nextWords([], 5)).toEqual([]);
    expect(model.prefixProbability([], '')).toBe(0);
    expect(model.letterDistribution([], '')).toEqual({});
  });
});

describe('interpolated Kneser–Ney, hand-checked (order 2)', () => {
  // Sentences: <s> a b </s> ×2, <s> a c </s>.
  // Continuation counts: a 1, b 1, c 1, </s> 2 → A1 = 5, T1 = 4; D1 = 3/(3+2) = 0.6.
  // Uniform share: 0.6·4/5/5 = 0.096 over 5 predictable words.
  // p1(a) = p1(b) = p1(c) = 0.4/5 + 0.096 = 0.176; p1(</s>) = 1.4/5 + 0.096 = 0.376.
  // Bigram counts after a: b 2, c 1. D2 = n1/(n1+2n2) = 2/(2+4) = 1/3, γ(a) = (1/3)·2/3 = 2/9.
  // p(b|a) = (2 − 1/3)/3 + (2/9)·0.176; p(c|a) = (1 − 1/3)/3 + (2/9)·0.176; p(a|a) = (2/9)·0.176.
  const model = loadLanguageModel(buildModel(TINY, { order: 2 }));

  it('matches the hand calculation', () => {
    expect(model.metadata.discounts[0]).toBeCloseTo(0.6, 6);
    expect(model.metadata.discounts[1]).toBeCloseTo(1 / 3, 6);
    expect(model.probability([], 'a')).toBeCloseTo(0.176, 5);
    expect(model.probability(['a'], 'b')).toBeCloseTo(5 / 9 + (2 / 9) * 0.176, 5);
    expect(model.probability(['a'], 'c')).toBeCloseTo(2 / 9 + (2 / 9) * 0.176, 5);
    expect(model.probability(['a'], 'a')).toBeCloseTo((2 / 9) * 0.176, 5);
    expect(model.probability(['zzz'], 'a')).toBeCloseTo(0.176, 5);
  });

  it('ranks next words and completions', () => {
    expect(model.nextWords(['a'], 2).map((c) => c.text)).toEqual(['b', 'c']);
    expect(model.nextWords([SENTENCE_START], 1).map((c) => c.text)).toEqual(['a']);
    expect(model.completions(['a'], 'c', 5).map((c) => c.text)).toEqual(['c']);
  });
});

describe('normalisation on a richer corpus (order 3)', () => {
  const corpus = [
    'I would like a cup of tea please',
    'I would like some water',
    'I would love a cup of coffee',
    'could you help me please',
    'could you open the window',
    'thank you very much',
    'thank you so much',
    'how are you today',
    'how are you feeling',
    'I am feeling tired today',
  ];
  const { bytes, stats } = buildModelWithStats(corpus, { order: 3, minNgramCount: 1 });
  const model = loadLanguageModel(bytes);

  it('reports stats', () => {
    expect(stats.vocabulary).toBeGreaterThan(20);
    expect(stats.trigrams).toBeGreaterThan(30);
    expect(stats.bytes).toBe(bytes.length);
  });

  it('each conditional distribution sums to about 1', () => {
    for (const ctx of [
      [],
      [SENTENCE_START],
      ['would'],
      ['i', 'would'],
      ['you', 'very'],
      ['unknown', 'words'],
    ]) {
      const ids = model.context(ctx);
      // Regular words plus the pseudo words </s> and <unk>.
      const total =
        model.prefixProbability(ctx, '') + model.prob(ids, EOS_ID) + model.prob(ids, UNK_ID);
      expect(total).toBeGreaterThan(0.97);
      expect(total).toBeLessThan(1.03);
    }
  });

  it('prefix probability equals the sum of word probabilities', () => {
    const ctx = ['i', 'would'];
    const words = ['like', 'love', 'later'];
    const summed = model.completions(ctx, 'l', 50).reduce((a, c) => a + c.score, 0);
    expect(model.prefixProbability(ctx, 'l')).toBeCloseTo(summed, 6);
    expect(words.length).toBe(3);
  });

  it('uses the trigram context', () => {
    expect(model.nextWords(['i', 'would'], 2).map((c) => c.text)).toEqual(['like', 'love']);
    expect(
      model
        .nextWords(['cup', 'of'], 2)
        .map((c) => c.text)
        .sort(),
    ).toEqual(['coffee', 'tea']);
    expect(model.completions(['thank', 'you'], 'v', 1)[0]?.text).toBe('very');
  });

  it('learns display forms from mid-sentence casing and language defaults', () => {
    const cased = loadLanguageModel(buildModel(['we met Sarah', 'Sarah said hi', 'I said hi']));
    expect(cased.completions([], 'sa', 3).map((c) => c.text)).toContain('Sarah');
    expect(model.nextWords([SENTENCE_START], 3).map((c) => c.text)).toContain('I');
  });

  it('gives letter probabilities that sum to at most 1 and favour real continuations', () => {
    const letters = model.letterDistribution(['i', 'would'], 'l');
    const sum = Object.values(letters).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    expect(letters.i! + letters.o!).toBeGreaterThan(0.7);
    const unknown = model.letterDistribution([], 'qx');
    expect(Object.values(unknown).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Object.keys(unknown).length).toBeGreaterThan(0);
  });
});

describe('binary helpers', () => {
  it('base64 round-trips', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  it('quantises to the nearest centroid', () => {
    const values = Array.from({ length: 1000 }, (_, i) => -i / 100);
    const book = buildCodebook(values);
    for (const v of [-0.001, -3.33, -9.99]) {
      expect(Math.abs(book[quantise(book, v)]! - v)).toBeLessThan(0.05);
    }
  });
});
