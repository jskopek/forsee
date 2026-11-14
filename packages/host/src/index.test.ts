import { expect, it } from 'vitest';
import { HOST_PACKAGE } from './index';

it('exports its package name', () => {
  expect(HOST_PACKAGE).toBe('@forsee/host');
});
