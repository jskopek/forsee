import type { InputStep } from '@forsee/plugin-api';

/**
 * Noisy-channel prefix decoding. Each `InputStep` with a `KeyDistribution`
 * says which keys the user may have meant; the typed prefix is then one of
 * several alternative prefixes, each with the product of its keys'
 * probabilities. Candidates are later scored as
 * `P(word | context) · π(prefix of word)`, which is the noisy-channel
 * posterior if the distributions are read as likelihoods under a uniform key
 * prior. (When the gaze stage already used letter probabilities to scale
 * dwell, this counts the language model twice; the effect is mild and only
 * sharpens confident predictions.)
 *
 * The beam is bounded (`beamWidth`, default 8) and drops hypotheses below
 * `minRatio` (default 0.002) of the best, except the literal typed prefix,
 * which is always kept.
 */

export interface PrefixHypothesis {
  /** Normalised prefix. */
  readonly prefix: string;
  /** Normalised probability among the returned hypotheses. */
  readonly p: number;
}

export interface DecodeOptions {
  readonly beamWidth?: number;
  readonly minRatio?: number;
}

const WORD_TEXT = /^[\p{L}\p{M}\p{N}'-]+$/u;

export function decodePrefixes(
  partialWord: string,
  steps: readonly InputStep[] | undefined,
  normalise: (text: string) => string,
  options: DecodeOptions = {},
): PrefixHypothesis[] {
  const literal = normalise(partialWord);
  if (
    steps === undefined ||
    steps.length === 0 ||
    !steps.some((s) => s.distribution !== null) ||
    steps.map((s) => s.text).join('') !== partialWord
  ) {
    return [{ prefix: literal, p: 1 }];
  }
  const beamWidth = Math.max(1, options.beamWidth ?? 8);
  const minRatio = options.minRatio ?? 0.002;
  let beam = new Map<string, number>([['', 1]]);
  let literalSoFar = '';
  for (const step of steps) {
    const typed = normalise(step.text);
    literalSoFar += typed;
    const alternatives = new Map<string, number>();
    if (step.distribution === null) {
      alternatives.set(typed, 1);
    } else {
      let sum = 0;
      for (const entry of step.distribution.entries) {
        if (entry.text === undefined || !(entry.probability > 0)) continue;
        const text = normalise(entry.text);
        if (text === '' || !WORD_TEXT.test(text)) continue;
        alternatives.set(text, (alternatives.get(text) ?? 0) + entry.probability);
        sum += entry.probability;
      }
      if (!alternatives.has(typed)) alternatives.set(typed, Math.max(1 - sum, 0.05));
      let total = 0;
      for (const p of alternatives.values()) total += p;
      for (const [k, p] of alternatives) alternatives.set(k, p / total);
    }
    const next = new Map<string, number>();
    for (const [prefix, p] of beam) {
      for (const [alt, q] of alternatives) {
        const key = prefix + alt;
        next.set(key, (next.get(key) ?? 0) + p * q);
      }
    }
    const ranked = [...next.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const best = ranked[0]?.[1] ?? 0;
    const kept = ranked.filter(([, p], i) => i < beamWidth && p >= best * minRatio);
    if (!kept.some(([k]) => k === literalSoFar)) {
      const lit = next.get(literalSoFar);
      if (lit !== undefined) kept.push([literalSoFar, lit]);
    }
    beam = new Map(kept);
  }
  let total = 0;
  for (const p of beam.values()) total += p;
  return [...beam.entries()]
    .map(([prefix, p]) => ({ prefix, p: total > 0 ? p / total : 0 }))
    .sort((a, b) => b.p - a.p || (a.prefix < b.prefix ? -1 : 1));
}
