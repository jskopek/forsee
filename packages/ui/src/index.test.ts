import { expect, it } from 'vitest';
import { UI_PACKAGE } from './index';

it('exports its package name', () => {
  expect(UI_PACKAGE).toBe('@forsee/ui');
});
