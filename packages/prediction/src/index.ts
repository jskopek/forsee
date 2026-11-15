/**
 * @forsee/prediction — two-speed word prediction: tokeniser, n-gram runtime,
 * user-adaptive layer, completions, next words, letter probabilities, phrase
 * recall (work package B4). Contracts are in `contracts.ts`; the design and
 * the model file format are described in this package's README.
 */
export * from './contracts';
export { decodeBase64, encodeBase64, ModelFormatError } from './binary';
export {
  buildModel,
  buildModelWithStats,
  ModelBuilder,
  type ModelBuildOptions,
  type ModelStats,
} from './builder';
export { CharModel } from './char-model';
export {
  createPredictionEngine,
  emptyResult,
  ENGINE_PROVIDER_ID,
  mergeResults,
  stabiliseCandidates,
  stabiliseList,
} from './engine';
export { MAX_VOCABULARY, MODEL_FORMAT_VERSION, MODEL_MAGIC, type ModelMetadata } from './format';
export { loadLanguageModel, NgramLanguageModel, type LoadModelOptions } from './ngram-model';
export { decodePrefixes, type DecodeOptions, type PrefixHypothesis } from './noisy';
export {
  createPhraseRecall,
  PhraseStore,
  type PhraseRecallOptions,
  type PhraseStoreData,
} from './phrases';
export {
  createNgramProvider,
  NGRAM_PROVIDER_ID,
  type NgramProvider,
  type NgramProviderOptions,
} from './provider';
export {
  createTokeniser,
  isSpecialWord,
  LANGUAGE_RULES,
  primaryLanguage,
  SENTENCE_END,
  SENTENCE_START,
  UNKNOWN_WORD,
  type ForseeTokeniser,
  type LanguageRules,
  type Token,
  type TokenKind,
} from './tokeniser';
export {
  AdaptiveUserModel,
  createUserModel,
  DEFAULT_HALF_LIFE_MS,
  USER_MODEL_SCHEMA_VERSION,
  type UserModelData,
  type UserModelOptions,
} from './user-model';

/** Package name, for diagnostics. */
export const PREDICTION_PACKAGE = '@forsee/prediction';
