import { FakeClock, SequentialIdSource } from '@forsee/core';
import type { PredictionKind } from '@forsee/plugin-api';
import {
  createNgramProvider,
  createUserModel,
  loadLanguageModel,
  loadSeedModel,
  ModelBuilder,
  type LanguageModel,
} from '@forsee/prediction';
import { describe, expect, it } from 'vitest';
import { summariseLatency, type LatencySummary } from './evaluate';

/**
 * Micro-benchmark of `predict` latency: the seed model, and a synthetic
 * model with a 50 000-word vocabulary (pseudo-words with Zipf frequencies,
 * ~300 000 training tokens) standing in for a real corpus. Prints the
 * figures; the assertions are loose so slow CI machines pass.
 */

const SYLLABLES =
  'ba be bi bo bu da de di do du ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu ra re ri ro ru sa se si so su ta te ti to tu va ve vi vo vu za ze zi zo zu'.split(
    ' ',
  );

function syntheticCorpus(vocab: number, tokens: number): { words: string[]; sentences: string[] } {
  const ids = new SequentialIdSource(42);
  const words = new Set<string>();
  while (words.size < vocab) {
    const n = 1 + Math.floor(ids.random() * 4);
    let w = '';
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(ids.random() * SYLLABLES.length)];
    words.add(w);
  }
  const list = [...words];
  const cumulative: number[] = [];
  let total = 0;
  for (let r = 0; r < list.length; r++) cumulative.push((total += 1 / (r + 2.7)));
  const sample = (): string => {
    const x = ids.random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return list[lo]!;
  };
  const sentences: string[] = [];
  let count = 0;
  while (count < tokens) {
    const n = 4 + Math.floor(ids.random() * 9);
    const s: string[] = [];
    for (let i = 0; i < n; i++) s.push(sample());
    sentences.push(s.join(' '));
    count += n;
  }
  return { words: list, sentences };
}

function measure(base: LanguageModel, sentences: readonly string[]): LatencySummary {
  const provider = createNgramProvider({ base, user: createUserModel({ clock: new FakeClock() }) });
  const kinds: PredictionKind[] = ['completions', 'nextWords', 'letters'];
  const samples: number[] = [];
  let id = 0;
  for (const sentence of sentences) {
    let text = '';
    for (const word of sentence.split(' ')) {
      for (let i = 0; i <= word.length; i++) {
        const partialWord = word.slice(0, i);
        const t0 = performance.now();
        provider.predict({
          requestId: ++id,
          textBefore: text + partialWord,
          partialWord,
          locale: 'en',
          maxCandidates: 5,
          kinds,
        });
        samples.push(performance.now() - t0);
      }
      text += word + ' ';
    }
  }
  return summariseLatency(samples.slice(50)); // drop warm-up
}

const fmt = (l: LatencySummary): string =>
  `mean ${l.mean.toFixed(3)} ms, p50 ${l.p50.toFixed(3)} ms, p95 ${l.p95.toFixed(3)} ms, max ${l.max.toFixed(2)} ms over ${l.count} calls`;

describe('predict latency', () => {
  it('seed model', () => {
    const sentences = ['could you help me sit up please', 'I would like a cup of tea with milk'];
    const l = measure(loadSeedModel(), [...sentences, ...sentences, ...sentences]);
    console.log(`[bench] seed model: ${fmt(l)}`);
    expect(l.p50).toBeLessThan(5);
  });

  it('synthetic 50k-word model', () => {
    const { words, sentences } = syntheticCorpus(50_000, 300_000);
    const t0 = performance.now();
    const builder = new ModelBuilder({ wordList: words, maxVocab: 50_000 });
    for (const s of sentences) builder.addVocabularyText(s);
    for (const s of sentences) builder.addText(s);
    const bytes = builder.build();
    const buildMs = performance.now() - t0;
    const t1 = performance.now();
    const model = loadLanguageModel(bytes);
    const loadMs = performance.now() - t1;
    const stats = builder.stats();
    expect(model.vocabularySize).toBe(50_000);
    const l = measure(model, sentences.slice(0, 60));
    console.log(
      `[bench] synthetic model: ${stats.vocabulary} words, ${stats.bigrams} bigrams, ${stats.trigrams} trigrams, ` +
        `${(bytes.length / 1024 / 1024).toFixed(2)} MiB, built in ${buildMs.toFixed(0)} ms, loaded in ${loadMs.toFixed(0)} ms; predict ${fmt(l)}`,
    );
    expect(l.p50).toBeLessThan(5);
  }, 120_000);
});
