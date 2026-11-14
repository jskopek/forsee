import { decodeBase64 } from './binary';
import { loadLanguageModel, type LoadModelOptions, type NgramLanguageModel } from './ngram-model';
import { SEED_MODEL_BASE64 } from './seed/seed-model.generated';

/**
 * The prebuilt seed model: built by `tools/lm-build` (`pnpm --filter
 * @forsee/lm-build seed`) from `packages/prediction/data/seed/`, which is
 * original text written for this project (MIT). It is tiny and meant for
 * development and tests until a licensed corpus is chosen.
 */

/** Bytes of the seed model file (a fresh copy on each call). */
export function seedModelBytes(): Uint8Array {
  return decodeBase64(SEED_MODEL_BASE64);
}

/** Loads the seed model. */
export function loadSeedModel(options: LoadModelOptions = {}): NgramLanguageModel {
  return loadLanguageModel(seedModelBytes(), options);
}
