import { decodeBase64 } from './binary';
import { ENGLISH_MODEL_BASE64 } from './en-tatoeba/model.generated';
import { loadLanguageModel, type NgramLanguageModel } from './ngram-model';

/**
 * The English model the app ships (`@forsee/prediction/english`): built by
 * `tools/lm-build` (`lm-build tatoeba`) from Tatoeba sentences
 * (https://tatoeba.org). The model data is licensed CC BY 2.0 FR, not MIT:
 * anything that ships it must credit Tatoeba (see
 * `packages/prediction/data/en-tatoeba/README.md`).
 *
 * It is embedded in the bundle (about 7.9 MB of base64 for a 5.9 MB model),
 * so it is a separate entry point: importing `@forsee/prediction` does not
 * load it.
 */

/** Bytes of the English model file (a fresh copy on each call). */
export function englishModelBytes(): Uint8Array {
  return decodeBase64(ENGLISH_MODEL_BASE64);
}

let shared: NgramLanguageModel | undefined;

/** The English model, decoded on first use and shared afterwards (it is read-only). */
export function loadEnglishModel(): NgramLanguageModel {
  return (shared ??= loadLanguageModel(englishModelBytes()));
}
