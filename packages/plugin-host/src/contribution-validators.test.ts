import type { ValidationResult } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  THEME_TOKENS,
  validatePhraseSet,
  validateSettingFieldsJson,
  validateTheme,
  validateVocabulary,
} from './contribution-validators';

const THEME = { id: 'p/contrast', name: 'Contrast', colorScheme: 'dark', tokens: { text: '#fff' } };
const PHRASES = {
  schemaVersion: 1,
  id: 'greetings',
  name: 'Greetings',
  locale: 'en-GB',
  categories: [
    {
      id: 'hi',
      name: 'Hi',
      phrases: [{ id: 'hello', text: 'Hello', recording: 'audio/hello.ogg' }],
    },
  ],
};
const VOCABULARY = {
  schemaVersion: 1,
  id: 'names',
  name: 'Names',
  locale: 'en',
  entries: [{ text: 'Ann' }],
};

const paths = (result: ValidationResult<unknown>): string[] =>
  result.ok ? [] : result.issues.map((i) => i.path);

describe('validateTheme', () => {
  it('accepts every token with every colour form', () => {
    const colours = [
      '#fff',
      '#ffff',
      '#a0b1c2',
      '#a0b1c2d3',
      'red',
      'rgb(1, 2, 3)',
      'rgba(1 2 3 / 50%)',
      'hsl(120deg 50% 50%)',
      'oklch(0.7 0.1 200)',
    ];
    const tokens = Object.fromEntries(THEME_TOKENS.map((t, i) => [t, colours[i % colours.length]]));
    expect(paths(validateTheme({ ...THEME, tokens, fontScale: 1.5 }))).toEqual([]);
  });

  it.each([
    ['url()', { text: 'url(https://evil.example/x.png)' }],
    ['var()', { text: 'var(--x)' }],
    ['a declaration break', { text: 'red; background: url(x)' }],
    ['nested functions', { text: 'rgb(calc(1) 2 3)' }],
    ['a five-digit hex', { text: '#12345' }],
    ['a number', { text: 3 }],
  ])('rejects %s', (_name, tokens) => {
    expect(paths(validateTheme({ ...THEME, tokens }))).toEqual(['/tokens/text']);
  });

  it('rejects unknown tokens, schemes, ids and scales', () => {
    expect(
      paths(
        validateTheme({
          id: '../x',
          name: '',
          colorScheme: 'blue',
          tokens: { nope: '#fff' },
          fontScale: 10,
          extra: 1,
        }),
      ).sort(),
    ).toEqual(['/colorScheme', '/extra', '/fontScale', '/id', '/name', '/tokens/nope'].sort());
  });
});

describe('validatePhraseSet', () => {
  it('accepts a phrase set', () => {
    expect(paths(validatePhraseSet(PHRASES))).toEqual([]);
  });

  it('rejects duplicates, unsafe recordings and bad locales', () => {
    const result = validatePhraseSet({
      ...PHRASES,
      locale: 'english!',
      categories: [
        {
          id: 'hi',
          name: 'Hi',
          phrases: [
            { id: 'a', text: 'A', recording: '../../secrets.ogg' },
            { id: 'a', text: '' },
          ],
        },
        { id: 'hi', name: 'Again', phrases: [] },
      ],
    });
    expect(paths(result).sort()).toEqual(
      [
        '/locale',
        '/categories/0/phrases/0/recording',
        '/categories/0/phrases/1/id',
        '/categories/0/phrases/1/text',
        '/categories/1/id',
      ].sort(),
    );
  });

  it('requires schemaVersion 1', () => {
    expect(paths(validatePhraseSet({ ...PHRASES, schemaVersion: 2 }))).toEqual(['/schemaVersion']);
  });
});

describe('validateVocabulary', () => {
  it('accepts a vocabulary', () => {
    expect(paths(validateVocabulary(VOCABULARY))).toEqual([]);
  });

  it('rejects empty entries and non-positive weights', () => {
    const result = validateVocabulary({
      ...VOCABULARY,
      entries: [
        { text: '' },
        { text: 'a', weight: 0 },
        { text: 'b', weight: Number.POSITIVE_INFINITY },
        'c',
      ],
    });
    expect(paths(result)).toEqual([
      '/entries/0/text',
      '/entries/1/weight',
      '/entries/2/weight',
      '/entries/3',
    ]);
  });
});

describe('validateSettingFieldsJson', () => {
  it('accepts the plan shorthand for select options', () => {
    expect(
      paths(
        validateSettingFieldsJson([
          {
            key: 'tone',
            label: 'Tone',
            type: 'select',
            default: 'casual',
            options: ['casual', 'formal'],
          },
          { key: 'size', label: 'Size', type: 'range', default: 2, min: 1, max: 5, step: 1 },
        ]),
      ),
    ).toEqual([]);
  });

  it('checks shape first, then the settings registry rules', () => {
    expect(paths(validateSettingFieldsJson({}))).toEqual(['']);
    expect(
      paths(validateSettingFieldsJson([{ key: 'a', label: 'A', type: 'string', default: {} }])),
    ).toEqual(['/0/default']);
    expect(
      paths(
        validateSettingFieldsJson([
          { key: 'a', label: 'A', type: 'range', default: 1 },
          { key: 'a', label: 'B', type: 'string', default: '' },
        ]),
      ),
    ).toEqual(['/0', '/1']);
  });
});
