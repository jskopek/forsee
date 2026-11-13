import { expect, it } from 'vitest';
import { CORE_PACKAGE } from './index';

it('exports its package name', () => {
  expect(CORE_PACKAGE).toBe('@forsee/core');
});
