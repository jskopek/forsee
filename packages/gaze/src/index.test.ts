import { expect, it } from 'vitest';
import { GAZE_PACKAGE } from './index';

it('exports its package name', () => {
  expect(GAZE_PACKAGE).toBe('@forsee/gaze');
});
