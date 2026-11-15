import { readFile } from 'node:fs/promises';
import { FakeClock } from '@forsee/core';
import { createNgramProvider, createUserModel, loadLanguageModel } from '@forsee/prediction';
import { describe, expect, it } from 'vitest';
import { keystrokeSavings } from './evaluate';
import {
  dedupeKey,
  namesStockName,
  prepareTatoeba,
  TATOEBA_HELDOUT_PATH,
  TATOEBA_MODEL_PATH,
  tatoebaSentence,
} from './tatoeba';

describe('Tatoeba preparation', () => {
  it('reads the text column of the export', () => {
    expect(tatoebaSentence('1276\teng\tLet’s try something. ')).toBe('Let’s try something.');
    expect(tatoebaSentence('1\teng\t')).toBeNull();
    expect(tatoebaSentence('no tabs')).toBeNull();
  });

  it('de-duplicates on a loose key', () => {
    expect(dedupeKey('I  like  tea!')).toBe(dedupeKey('i like tea'));
    expect(dedupeKey("Don't go.")).toBe("don't go");
    const split = prepareTatoeba(['I like tea.', 'I like tea!', 'i like TEA', 'Go.'], {
      heldOut: 0,
    });
    expect(split.unique).toBe(2);
    expect(split.train).toHaveLength(2);
  });

  it('holds sentences out deterministically, whatever the input order', () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence number ${i}.`);
    const a = prepareTatoeba(sentences, { heldOut: 20 });
    const b = prepareTatoeba([...sentences].reverse(), { heldOut: 20 });
    expect(a.heldOut).toHaveLength(20);
    expect(a.train).toHaveLength(180);
    expect(b.heldOut).toEqual(a.heldOut);
    expect(b.train).toEqual(a.train);
    for (const s of a.heldOut) expect(a.train).not.toContain(s);
  });

  it('keeps about one in ten training sentences that name a stock name', () => {
    expect(namesStockName("Tom's here.")).toBe(true);
    expect(namesStockName('Tomorrow is fine.')).toBe(false);
    const named = Array.from({ length: 1000 }, (_, i) => `Tom has ${i} apples.`);
    const plain = Array.from({ length: 100 }, (_, i) => `I have ${i} pears.`);
    const split = prepareTatoeba([...named, ...plain], { heldOut: 0 });
    const keptNamed = split.train.filter(namesStockName).length;
    expect(keptNamed).toBeGreaterThan(60);
    expect(keptNamed).toBeLessThan(140);
    expect(split.train.length - keptNamed).toBe(100);
    expect(split.droppedForNames).toBe(1000 - keptNamed);
    expect(prepareTatoeba(named, { heldOut: 0, stockNameKeepOneIn: 1 }).train).toHaveLength(1000);
  });
});

describe('checked-in Tatoeba model', () => {
  const load = async () => {
    const base = loadLanguageModel(new Uint8Array(await readFile(TATOEBA_MODEL_PATH)));
    return createNgramProvider({ base, user: createUserModel({ clock: new FakeClock() }) });
  };
  const predict = (
    provider: Awaited<ReturnType<typeof load>>,
    textBefore: string,
    partialWord: string,
  ): string[] => {
    const r = provider.predict({
      requestId: 1,
      textBefore,
      partialWord,
      locale: 'en-GB',
      maxCandidates: 4,
      kinds: ['completions', 'nextWords'],
    });
    return (partialWord === '' ? r.nextWords : r.completions).map((c) => c.text);
  };

  it('uses the sentence so far', async () => {
    const provider = await load();
    expect(predict(provider, 'Trevor ate a ba', 'ba')).toContain('banana');
    expect(predict(provider, 'I would like a glass of ', '')).toContain('water');
    expect(predict(provider, 'I am hun', 'hun')[0]).toBe('hungry');
    expect(predict(provider, '', '')).not.toContain('Tom');
  });

  it('saves keystrokes on held-out Tatoeba sentences', async () => {
    const provider = await load();
    const heldOut = (await readFile(TATOEBA_HELDOUT_PATH, 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    expect(heldOut.length).toBe(2000);
    const result = keystrokeSavings(provider, heldOut.slice(0, 300), {
      maxCandidates: 3,
      now: () => performance.now(),
    });
    // About 57% on all 2000 (README); a floor well below that.
    expect(result.savings).toBeGreaterThan(0.5);
  });
});
