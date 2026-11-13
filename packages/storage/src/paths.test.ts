import { describe, expect, it } from 'vitest';
import { isStorageError } from './errors';
import { assertPluginId, assertSafePath, assertSafeSegment, parentPath } from './paths';

describe('assertSafePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(assertSafePath('plugins/community.x/data.json')).toEqual([
      'plugins',
      'community.x',
      'data.json',
    ]);
    expect(assertSafePath('a')).toEqual(['a']);
  });

  it.each([
    '',
    '..',
    '../x',
    'a/../b',
    'a/./b',
    '/etc/passwd',
    'a//b',
    'a/',
    'a\\b',
    '..\\x',
    'C:/x',
    'a/b\0c',
    'a/\nb',
  ])('rejects %j', (path) => {
    try {
      assertSafePath(path);
      expect.unreachable();
    } catch (error) {
      expect(isStorageError(error, 'invalid-path')).toBe(true);
    }
  });
});

it('assertSafeSegment rejects separators and dots', () => {
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'c:']) {
    expect(() => assertSafeSegment(bad)).toThrow();
  }
  expect(() => assertSafeSegment('My layout (2)')).not.toThrow();
});

it('assertPluginId allows only dot-separated lower case ids', () => {
  expect(() => assertPluginId('forsee.history')).not.toThrow();
  for (const bad of ['', '..', '../x', 'a/b', 'A', 'a..b', '.a', 'a.', 'a b', 'a\\b']) {
    expect(() => assertPluginId(bad), bad).toThrow();
  }
});

it('parentPath returns the folder', () => {
  expect(parentPath('a/b/c.json')).toBe('a/b');
  expect(parentPath('c.json')).toBe('');
});
