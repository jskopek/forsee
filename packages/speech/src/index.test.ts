import type { SpeechService } from '@forsee/core';
import { expect, expectTypeOf, it } from 'vitest';
import { SPEECH_PACKAGE, type SpeechEngine } from './index';

it('exports its package name', () => {
  expect(SPEECH_PACKAGE).toBe('@forsee/speech');
});

it('the speech engine can be injected into the kernel', () => {
  expectTypeOf<SpeechEngine>().toExtend<SpeechService>();
});
