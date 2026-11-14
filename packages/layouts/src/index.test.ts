import { expect, it } from 'vitest';
import { LAYOUTS_PACKAGE } from './index';

it('exports its package name', () => {
  expect(LAYOUTS_PACKAGE).toBe('@forsee/layouts');
});
