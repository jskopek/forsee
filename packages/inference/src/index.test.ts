import { expect, it } from 'vitest';
import { INFERENCE_PACKAGE } from './index';

it('exports its package name', () => {
  expect(INFERENCE_PACKAGE).toBe('@forsee/inference');
});
