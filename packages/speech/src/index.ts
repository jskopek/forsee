/**
 * @forsee/speech — voice providers, utterance queue, speak modes and the
 * recorded-message provider (work package B5). Contracts are in `contracts.ts`.
 * Test doubles are in `@forsee/speech/testing`.
 */
export * from './contracts';
export { chunkText, wordLengthAt, type TextChunk } from './chunking';
export { createSpeechEngine, createSpeechService, RECORDED_PROVIDER_ID } from './engine';
export { createUtteranceQueue, defaultWatchdogMs } from './queue';
export {
  createRecordedMessageProvider,
  mimeTypeOf,
  RECORDED_MESSAGE_PROVIDER_ID,
} from './recorded';
export { VoiceProviderRegistry, type ProviderRegistryEventMap } from './registry';
export { createSpeechSession, type SpeechSession } from './session';
export {
  applySpeechSettings,
  clampSetting,
  DEFAULT_SPEECH_SETTINGS,
  SPEECH_LIMITS,
  type SettingLimits,
  type SettingsValidation,
} from './settings';
export {
  completedPrefix,
  completedSentences,
  completedWords,
  createSpeakModeController,
  newSpeech,
} from './speak-mode';
export { createWebSpeechProvider, WEB_SPEECH_PROVIDER_ID } from './web-speech';
export {
  globalVoiceId,
  normaliseLocale,
  selectVoice,
  splitVoiceId,
  voiceGlobalId,
  type VoiceRequest,
} from './voices';

/** Package name, for diagnostics. */
export const SPEECH_PACKAGE = '@forsee/speech';
