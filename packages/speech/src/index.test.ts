import type { SpeechService } from '@forsee/core';
import { expect, expectTypeOf, it } from 'vitest';
import {
  createSpeakModeController,
  createSpeechService,
  createUtteranceQueue,
  SPEECH_PACKAGE,
  type SpeechEngine,
  type UtteranceQueue,
  type VoiceProvider,
  type WebSpeechProvider,
} from './index';
import type { FakeVoiceProvider } from './testing';

it('exports its package name', () => {
  expect(SPEECH_PACKAGE).toBe('@forsee/speech');
});

it('the speech engine can be injected into the kernel', () => {
  expectTypeOf<SpeechEngine>().toExtend<SpeechService>();
});

it('exports the factories and the testing doubles satisfy the contracts', () => {
  expect(typeof createSpeechService).toBe('function');
  expect(typeof createUtteranceQueue).toBe('function');
  expect(typeof createSpeakModeController).toBe('function');
  expectTypeOf<FakeVoiceProvider>().toExtend<VoiceProvider>();
  expectTypeOf<WebSpeechProvider>().toExtend<VoiceProvider>();
  expectTypeOf<ReturnType<typeof createUtteranceQueue>>().toExtend<UtteranceQueue>();
});
