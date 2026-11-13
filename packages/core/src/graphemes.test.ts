import { describe, expect, it } from 'vitest';
import {
  hasNativeGraphemeSegmenter,
  lastGraphemeLength,
  lastGraphemeLengthFallback,
  splitGraphemes,
  splitGraphemesFallback,
} from './graphemes';

const CASES: readonly (readonly [string, readonly string[]])[] = [
  ['', []],
  ['abc', ['a', 'b', 'c']],
  ['é', ['é']],
  ['ñ́a', ['ñ́', 'a']],
  ['👍🏽x', ['👍🏽', 'x']],
  ['👨‍👩‍👧', ['👨‍👩‍👧']],
  ['🇬🇧🇺🇸', ['🇬🇧', '🇺🇸']],
  ['🇬🇧🇺', ['🇬🇧', '🇺']],
  ['1️⃣', ['1️⃣']],
  ['❤️', ['❤️']],
  [
    '🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
    ['🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'],
  ],
  ['a\r\nb', ['a', '\r\n', 'b']],
  ['𝒜b', ['𝒜', 'b']],
];

describe.each([
  ['fallback', splitGraphemesFallback, lastGraphemeLengthFallback],
  ['default', splitGraphemes, lastGraphemeLength],
] as const)('%s segmentation', (_name, split, lastLength) => {
  it.each(CASES)('splits %j', (text, expected) => {
    expect(split(text)).toEqual(expected);
  });

  it.each(CASES)('last grapheme length of %j', (text, expected) => {
    expect(lastLength(text)).toBe(expected.at(-1)?.length ?? 0);
  });
});

it('reports whether the native segmenter is used', () => {
  expect(typeof hasNativeGraphemeSegmenter).toBe('boolean');
});
