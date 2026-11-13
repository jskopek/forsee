import { expect, it } from 'vitest';
import { STORAGE_PACKAGE } from './index';

it('exports its package name', () => {
  expect(STORAGE_PACKAGE).toBe('@forsee/storage');
});
