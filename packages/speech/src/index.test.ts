import { expect, it } from 'vitest';
import { SPEECH_PACKAGE } from './index';

it('exports its package name', () => {
  expect(SPEECH_PACKAGE).toBe('@forsee/speech');
});
