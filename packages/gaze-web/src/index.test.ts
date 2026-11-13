import { expect, it } from 'vitest';
import { GAZE_WEB_PACKAGE } from './index';

it('exports its package name', () => {
  expect(GAZE_WEB_PACKAGE).toBe('@forsee/gaze-web');
});
