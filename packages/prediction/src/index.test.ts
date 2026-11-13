import { expect, it } from 'vitest';
import { PREDICTION_PACKAGE } from './index';

it('exports its package name', () => {
  expect(PREDICTION_PACKAGE).toBe('@forsee/prediction');
});
