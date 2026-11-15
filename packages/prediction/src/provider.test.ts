import { FakeClock } from '@forsee/core';
import type { InputStep, PredictionKind, PredictionRequest } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { buildModel } from './builder';
import { loadLanguageModel } from './ngram-model';
import { decodePrefixes } from './noisy';
import { loadEnglishModel } from './english';
import { createPhraseRecall } from './phrases';
import { createNgramProvider } from './provider';
import { createUserModel } from './user-model';

const ALL: PredictionKind[] = ['completions', 'nextWords', 'letters', 'phrases'];
const base = loadEnglishModel();

function setup(model = base) {
  const clock = new FakeClock();
  const user = createUserModel({ clock });
  const phrases = createPhraseRecall({ clock });
  const provider = createNgramProvider({ base: model, user, phrases });
  let id = 0;
  const ask = (textBefore: string, extra: Partial<PredictionRequest> = {}) => {
    const partialWord = /[\p{L}\p{M}\p{N}'-]*$/u.exec(textBefore)?.[0] ?? '';
    return provider.predict({
      requestId: ++id,
      textBefore,
      partialWord,
      locale: 'en',
      maxCandidates: 5,
      kinds: ALL,
      ...extra,
    });
  };
  const learn = (text: string) =>
    provider.learn({ text, origin: 'composition', locale: 'en', createdAt: clock.wallNow() });
  return { clock, user, phrases, provider, ask, learn };
}

const texts = (list: readonly { text: string }[]) => list.map((c) => c.text);
const sum = (r: Readonly<Record<string, number>>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('n-gram provider on the English model', () => {
  it('has the expected identity and capabilities', () => {
    const { provider } = setup();
    expect(provider.id).toBe('forsee.ngram');
    expect(provider.capabilities.kinds).toEqual(ALL);
    expect(provider.capabilities.usesKeyDistributions).toBe(true);
    expect('refine' in provider).toBe(false);
  });

  it('completes the partial word', () => {
    const { ask } = setup();
    const r = ask('hel');
    expect(r.requestId).toBe(1);
    expect(r.stage).toBe('instant');
    expect(texts(r.completions).slice(0, 2).sort()).toEqual(['hello', 'help']);
    expect(r.nextWords).toEqual([]);
    for (const c of r.completions) expect(c.score).toBeGreaterThan(0);
    const scores = r.completions.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(
      sum(Object.fromEntries(r.completions.map((c) => [c.text, c.score]))),
    ).toBeLessThanOrEqual(1);
  });

  it('uses the context for completions and next words', () => {
    const { ask } = setup();
    expect(texts(ask('Thank ').nextWords)[0]).toBe('you');
    expect(texts(ask('I would like a glass of ').nextWords)[0]).toBe('water');
    expect(texts(ask('Could you turn the light ').nextWords).slice(0, 2)).toContain('on');
    expect(texts(ask('Trevor ate a ba').completions)[0]).toBe('banana');
    expect(ask('Thank ').completions).toEqual([]);
  });

  it('capitalises next words at the start of a sentence and keeps display forms', () => {
    const { ask } = setup();
    for (const text of texts(ask('').nextWords)) expect(text[0]).toBe(text[0]?.toUpperCase());
    expect(texts(ask('Thanks. ').nextWords)[0]?.[0]).toMatch(/[A-Z]/);
    expect(texts(ask('Yes, i').completions)).toContain("I'm");
  });

  it('returns letter probabilities that sum to at most 1 and favour the right letters', () => {
    const { ask } = setup();
    const afterHel = ask('hel').letters;
    expect(sum(afterHel)).toBeLessThanOrEqual(1 + 1e-9);
    expect(afterHel.l! + afterHel.p!).toBeGreaterThan(0.8);
    const nextWord = ask('Thank ').letters;
    expect(sum(nextWord)).toBeLessThanOrEqual(1 + 1e-9);
    const top = Object.entries(nextWord).sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(top).toBe('y');
    const unknown = ask('xq').letters;
    expect(Object.keys(unknown).length).toBeGreaterThan(0);
    expect(sum(unknown)).toBeLessThanOrEqual(1 + 1e-9);
    for (const p of Object.values(unknown)) expect(p).toBeGreaterThan(0);
  });

  it('omits kinds that were not requested', () => {
    const { ask } = setup();
    const r = ask('hel', { kinds: ['letters'] });
    expect(r.completions).toEqual([]);
    expect(r.phrases).toEqual([]);
    expect(Object.keys(r.letters).length).toBeGreaterThan(0);
    expect(ask('hel', { maxCandidates: 2 }).completions).toHaveLength(2);
  });

  it('is deterministic', () => {
    const a = setup().ask('I need the t');
    const b = setup().ask('I need the t');
    expect(a).toEqual(b);
    expect(setup().ask('Could you ')).toEqual(setup().ask('Could you '));
  });
});

describe('uncertain input (noisy prefix)', () => {
  const steps = (j: number): InputStep[] => [
    {
      text: 'j',
      distribution: {
        entries: [
          { targetId: 'keyboard/key-j', text: 'j', probability: j },
          { targetId: 'keyboard/key-h', text: 'h', probability: 1 - j },
        ],
      },
    },
    { text: 'e', distribution: null },
    { text: 'l', distribution: null },
    { text: 'l', distribution: null },
  ];

  it('decodes alternative prefixes in a bounded beam', () => {
    const hyps = decodePrefixes('jell', steps(0.6), (s) => s.toLowerCase());
    expect(hyps.map((h) => h.prefix)).toEqual(['jell', 'hell']);
    expect(hyps[0]?.p).toBeCloseTo(0.6, 9);
    expect(decodePrefixes('jel', undefined, (s) => s)).toEqual([{ prefix: 'jel', p: 1 }]);
    expect(decodePrefixes('xyz', steps(0.6), (s) => s)).toEqual([{ prefix: 'xyz', p: 1 }]);
    const wide = Array.from({ length: 6 }, () => ({
      text: 'a',
      distribution: {
        entries: ['a', 'b', 'c', 'd'].map((t) => ({ targetId: t, text: t, probability: 0.25 })),
      },
    }));
    const beam = decodePrefixes('aaaaaa', wide, (s) => s, { beamWidth: 8 });
    expect(beam.length).toBeLessThanOrEqual(9);
    expect(beam.map((h) => h.prefix)).toContain('aaaaaa');
  });

  it('resolves an h/j ambiguity to "hello"', () => {
    const { ask } = setup();
    const certain = ask('jell');
    expect(texts(certain.completions)).not.toContain('hello');
    const noisy = ask('jell', { partialWordSteps: steps(0.55) });
    expect(texts(noisy.completions)[0]).toBe('hello');
    expect(noisy.letters.o).toBeGreaterThan(0.5);
    expect(sum(noisy.letters)).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('user layer in the provider', () => {
  it('learns new words and phrases, and forgets them', () => {
    const { ask, learn, provider } = setup();
    expect(texts(ask('Can you call Zub').completions)).toEqual([]);
    learn('Can you call Zubeida please?');
    expect(texts(ask('Can you call Zub').completions)[0]).toBe('Zubeida');
    expect(texts(ask('Can you call ').nextWords)).toContain('Zubeida');
    expect(texts(ask('Can you c').phrases)).toEqual(['Can you call Zubeida please?']);
    expect(provider.user.entries().map((e) => e.word)).toContain('Zubeida');
    provider.forget({ kind: 'words', words: ['zubeida'] });
    expect(texts(ask('Can you call Zub').completions)).toEqual([]);
    expect(ask('Can you c').phrases).toEqual([]);
    learn('Good morning sunshine');
    provider.forget({ kind: 'all' });
    expect(provider.user.entries()).toEqual([]);
    expect(ask('Good m').phrases).toEqual([]);
  });

  it('adapts the ranking towards the user', () => {
    const { ask, learn } = setup();
    const before = texts(ask('I want a ').nextWords);
    for (let i = 0; i < 5; i++) learn('I want a smoothie');
    const after = texts(ask('I want a ').nextWords);
    expect(before).not.toContain('smoothie');
    expect(after[0]).toBe('smoothie');
  });

  it('works from an empty base model', () => {
    const empty = loadLanguageModel(buildModel([]));
    const { ask, learn } = setup(empty);
    expect(ask('he').completions).toEqual([]);
    expect(ask('').nextWords).toEqual([]);
    learn('Hello Fiona. Hello Fred.');
    expect(texts(ask('he').completions)).toEqual(['hello']);
    expect(texts(ask('Hello ').nextWords).slice(0, 2).sort()).toEqual(['Fiona', 'Fred']);
    const letters = ask('Hello f').letters;
    expect(letters.i! + letters.r!).toBeCloseTo(1, 6);
  });

  it('falls back to the user layer for a locale the base model does not cover', () => {
    const { ask, learn } = setup();
    learn('bonjour');
    const r = ask('bon', { locale: 'fr' });
    expect(texts(r.completions)).toEqual(['bonjour']);
    expect(ask('hel', { locale: 'fr' }).completions).toEqual([]);
  });
});
