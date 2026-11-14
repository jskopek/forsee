import { FakeClock } from '@forsee/core';
import type { LearnEvent } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createPhraseRecall } from './phrases';
import { SENTENCE_START } from './tokeniser';
import { createUserModel, DEFAULT_HALF_LIFE_MS } from './user-model';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const clock = new FakeClock();
  const user = createUserModel({ clock });
  const learn = (text: string, origin: LearnEvent['origin'] = 'composition'): void =>
    user.learn({ text, origin, locale: 'en', createdAt: clock.wallNow() });
  return { clock, user, learn };
}

describe('user model', () => {
  it('starts empty', () => {
    const { user } = setup();
    expect(user.mass()).toBe(0);
    expect(user.entries()).toEqual([]);
    expect(user.completions([], 'a', 5)).toEqual([]);
    expect(user.letterDistribution([], '')).toEqual({});
    expect(user.prefixProbability([], '')).toBe(0);
  });

  it('learns words, new words and sequences', () => {
    const { user, learn } = setup();
    learn('Please call Zarah. Please call the nurse.');
    expect(user.entries().map((e) => [e.word, e.count])).toEqual([
      ['call', 2],
      ['please', 2],
      ['nurse', 1],
      ['the', 1],
      ['Zarah', 1],
    ]);
    expect(user.nextWords(['please'], 1)[0]?.text).toBe('call');
    expect(user.nextWords([SENTENCE_START], 1)[0]?.text).toBe('please');
    expect(user.completions(['call'], 'z', 1)[0]?.text).toBe('Zarah');
    // Proper distribution.
    expect(user.prefixProbability(['call'], '')).toBeCloseTo(1, 9);
    expect(user.prefixProbability([], '')).toBeCloseTo(1, 9);
    const letters = user.letterDistribution([], '');
    expect(Object.values(letters).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(letters.p).toBeCloseTo(2 / 7, 9);
  });

  it('weights recent use over old use (exponential decay)', () => {
    const { clock, user, learn } = setup();
    for (let i = 0; i < 3; i++) learn('water');
    clock.advance(3 * DEFAULT_HALF_LIFE_MS);
    learn('wine');
    learn('wine');
    // 3 uses decayed by 2^-3 = 0.375 < 2 recent uses.
    expect(user.completions([], 'w', 2).map((c) => c.text)).toEqual(['wine', 'water']);
    const before = user.mass();
    clock.advance(DEFAULT_HALF_LIFE_MS);
    expect(user.mass()).toBeCloseTo(before / 2, 9);
    expect(user.entries()[0]).toMatchObject({ word: 'water', count: 3 });
  });

  it('forgets words everywhere, and everything', () => {
    const { user, learn } = setup();
    learn('I love chocolate cake');
    learn('chocolate please');
    user.forget({ kind: 'words', words: ['Chocolate'] });
    expect(user.entries().map((e) => e.word)).not.toContain('chocolate');
    expect(user.nextWords(['love'], 5).map((c) => c.text)).not.toContain('chocolate');
    expect(user.completions([], 'ch', 5)).toEqual([]);
    expect(user.prefixProbability(['love'], '')).toBeCloseTo(1, 9);
    user.forget({ kind: 'all' });
    expect(user.entries()).toEqual([]);
    expect(user.mass()).toBe(0);
  });

  it('serialises to JSON and loads it back', () => {
    const { clock, user, learn } = setup();
    learn('good morning. good night');
    clock.advance(DAY);
    learn('good evening');
    const json = JSON.parse(JSON.stringify(user.serialise())) as unknown;
    const copy = createUserModel({ clock });
    expect(copy.load(json)).toBe(true);
    expect(copy.serialise()).toEqual(user.serialise());
    expect(copy.nextWords(['good'], 3)).toEqual(user.nextWords(['good'], 3));
    expect(copy.load({ schemaVersion: 99 })).toBe(false);
    expect(copy.load({ ...(json as object), words: [['x', 'x', 'bad', 0, 0, 0]] })).toBe(false);
    expect(copy.entries().length).toBe(user.entries().length);
  });

  it('caps its size', () => {
    const clock = new FakeClock();
    const user = createUserModel({ clock, maxWords: 10 });
    for (let i = 0; i < 30; i++) {
      user.learn({
        text: `word${i} common`,
        origin: 'composition',
        locale: 'en',
        createdAt: clock.wallNow(),
      });
      clock.advance(1000);
    }
    expect(user.entries().length).toBeLessThanOrEqual(10);
    expect(user.entries().map((e) => e.word)).toContain('common');
  });
});

describe('phrase recall', () => {
  it('suggests phrases by prefix and frecency', () => {
    const clock = new FakeClock();
    const phrases = createPhraseRecall({ clock });
    phrases.add('Can you turn me over, please?', clock.wallNow());
    phrases.add('Can you call my daughter?', clock.wallNow());
    phrases.add('Can you call my daughter?', clock.wallNow());
    phrases.add('Thank you', clock.wallNow());
    phrases.add('Yes', clock.wallNow()); // single words are not phrases
    expect(phrases.size).toBe(3);
    expect(phrases.suggest('', 5).map((p) => p.text)[0]).toBe('Can you call my daughter?');
    expect(phrases.suggest('can you t', 5).map((p) => p.text)).toEqual([
      'Can you turn me over, please?',
    ]);
    expect(phrases.suggest('Hello. Can you ', 5).map((p) => p.text)).toEqual([
      'Can you call my daughter?',
      'Can you turn me over, please?',
    ]);
    expect(phrases.suggest('can yo', 5)).toHaveLength(2);
    expect(phrases.suggest('thank you', 5)).toEqual([]); // nothing to add
    expect(phrases.suggest('can you z', 5)).toEqual([]);
  });

  it('prefers recent phrases and supports removal and persistence', () => {
    const clock = new FakeClock();
    const phrases = createPhraseRecall({ clock });
    phrases.add('I need the toilet', clock.wallNow());
    phrases.add('I need the toilet', clock.wallNow());
    clock.advance(4 * DEFAULT_HALF_LIFE_MS);
    phrases.add('I need my glasses', clock.wallNow());
    expect(phrases.suggest('I need', 2).map((p) => p.text)).toEqual([
      'I need my glasses',
      'I need the toilet',
    ]);
    const copy = createPhraseRecall({ clock });
    expect(copy.load(JSON.parse(JSON.stringify(phrases.serialise())))).toBe(true);
    expect(copy.suggest('I need', 2)).toEqual(phrases.suggest('I need', 2));
    phrases.remove('i need my glasses!');
    phrases.removeContaining(['TOILET']);
    expect(phrases.size).toBe(0);
  });
});
