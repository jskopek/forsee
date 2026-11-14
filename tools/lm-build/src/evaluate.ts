import type { PredictionProvider, PredictionRequest, PredictionResult } from '@forsee/plugin-api';
import { createTokeniser } from '@forsee/prediction';

/**
 * A deliberately small keystroke-savings self-check (the full evaluation
 * harness is work package B13). A simulated typist enters each held-out
 * sentence word by word, letter by letter, and selects the intended word as
 * soon as it appears among the top `maxCandidates` predictions (one
 * keystroke, which includes the space). Without prediction each word costs
 * its letters plus a space. Case and punctuation are ignored.
 */

export interface SelfCheckResult {
  readonly sentences: number;
  readonly words: number;
  readonly keystrokesWithout: number;
  readonly keystrokesWith: number;
  /** 1 − with / without. */
  readonly savings: number;
  readonly latencyMs: LatencySummary;
}

export interface LatencySummary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export function summariseLatency(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return {
    count: sorted.length,
    mean,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function keystrokeSavings(
  provider: PredictionProvider,
  sentences: readonly string[],
  options: { maxCandidates?: number; now: () => number; locale?: string },
): SelfCheckResult {
  const max = options.maxCandidates ?? 3;
  const locale = options.locale ?? 'en';
  const tokeniser = createTokeniser(locale);
  let requestId = 0;
  let without = 0;
  let withPrediction = 0;
  let words = 0;
  const latencies: number[] = [];
  for (const sentence of sentences) {
    let text = '';
    for (const word of tokeniser.words(sentence)) {
      words++;
      const chars = [...word];
      without += chars.length + 1;
      let typed = '';
      for (let i = 0; ; i++) {
        const request: PredictionRequest = {
          requestId: ++requestId,
          textBefore: text + typed,
          partialWord: typed,
          locale,
          maxCandidates: max,
          kinds: typed === '' ? ['nextWords'] : ['completions'],
        };
        const t0 = options.now();
        const result = provider.predict(request) as PredictionResult;
        latencies.push(options.now() - t0);
        const list = typed === '' ? result.nextWords : result.completions;
        withPrediction++;
        if (list.slice(0, max).some((c) => tokeniser.normalise(c.text) === word)) break;
        if (i >= chars.length) break; // typed the whole word: this keystroke was the space
        typed += chars[i];
      }
      text += word + ' ';
    }
  }
  return {
    sentences: sentences.length,
    words,
    keystrokesWithout: without,
    keystrokesWith: withPrediction,
    savings: without > 0 ? 1 - withPrediction / without : 0,
    latencyMs: summariseLatency(latencies),
  };
}
