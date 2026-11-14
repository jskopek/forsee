import { describe, expect, it } from 'vitest';
import { createTokeniser, SENTENCE_START } from './tokeniser';

const en = createTokeniser('en-GB');

describe('tokeniser', () => {
  it('lower-cases words and keeps in-word apostrophes and hyphens', () => {
    expect(en.words("I DON'T think it's well-known")).toEqual([
      'i',
      "don't",
      'think',
      "it's",
      'well-known',
    ]);
  });

  it('folds curly apostrophes and Unicode hyphens, drops edge apostrophes', () => {
    expect(en.words('I can\u2019t, \u2018cause it\u2019s self\u2010made')).toEqual([
      'i',
      "can't",
      'cause',
      "it's",
      'self-made',
    ]);
  });

  it('keeps the surface form for display', () => {
    const tokens = en.tokens('Yes, I am');
    expect(tokens.map((t) => t.surface)).toEqual(['Yes', 'I', 'am']);
    expect(tokens.map((t) => t.sentenceInitial)).toEqual([true, false, false]);
  });

  it('treats numbers as single tokens', () => {
    const tokens = en.tokens('At 3:30 I paid 1,000.50 for 2nd place');
    expect(tokens.map((t) => [t.normal, t.kind])).toEqual([
      ['at', 'word'],
      ['3:30', 'number'],
      ['i', 'word'],
      ['paid', 'word'],
      ['1,000.50', 'number'],
      ['for', 'word'],
      ['2nd', 'word'],
      ['place', 'word'],
    ]);
  });

  it('treats emoji, including ZWJ sequences and flags, as tokens', () => {
    const tokens = en.tokens(
      'love it \u2764\uFE0F \u{1F44D}\u{1F3FD} \u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u{1F1EC}\u{1F1E7}',
    );
    expect(tokens.filter((t) => t.kind === 'emoji').map((t) => t.surface)).toEqual([
      '\u2764\uFE0F',
      '\u{1F44D}\u{1F3FD}',
      '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      '\u{1F1EC}\u{1F1E7}',
    ]);
    expect(tokens[2]?.normal).toBe('\u2764');
  });

  it('splits sentences on . ! ? and line breaks but not after abbreviations', () => {
    const sentences = en.sentences('Hello there! Is Dr. Smith in? Yes.\nGood\n\nthanks');
    expect(sentences.map((s) => s.map((t) => t.normal).join(' '))).toEqual([
      'hello there',
      'is dr smith in',
      'yes',
      'good',
      'thanks',
    ]);
  });

  it('builds prediction context from the current sentence', () => {
    expect(en.context('')).toEqual([SENTENCE_START]);
    expect(en.context('Hello. ')).toEqual([SENTENCE_START]);
    expect(en.context('Hello. How ')).toEqual([SENTENCE_START, 'how']);
    expect(en.context('Hello. How are ')).toEqual(['how', 'are']);
    expect(en.context('Hello. How are ', 3)).toEqual([SENTENCE_START, 'how', 'are']);
    expect(en.context('I saw Dr. ')).toEqual(['saw', 'dr']);
    expect(en.context('yes, please, ')).toEqual(['yes', 'please']);
  });

  it('falls back to generic rules for other locales', () => {
    const tr = createTokeniser('tr');
    expect(tr.normalise('I')).toBe('ı');
    expect(createTokeniser('fr-FR').words("C'est l'été")).toEqual(["c'est", "l'été"]);
  });
});
