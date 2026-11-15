import { ForseeError } from '@forsee/core';
import { loadLanguageModel, type LanguageModel } from '@forsee/prediction';
import englishModelUrl from '@forsee/prediction/data/en-tatoeba/model.bin?url';

/**
 * The English word-prediction model the app ships: built from Tatoeba
 * sentences (https://tatoeba.org, CC BY 2.0 FR; see
 * `packages/prediction/data/en-tatoeba/README.md`). It is a separate file
 * next to the bundle, about 6 MB, fetched once at startup; until it arrives
 * the word-prediction plugin uses the small seed model built into the bundle.
 */
export const BUNDLED_ENGLISH_MODEL_URL: string = englishModelUrl;

/** Fetches and opens a model file. Rejects with `unavailable` if it cannot be fetched. */
export async function fetchLanguageModel(
  url: string = BUNDLED_ENGLISH_MODEL_URL,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<LanguageModel> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new ForseeError('unavailable', `Could not download the word-prediction model`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new ForseeError(
      'unavailable',
      `Could not download the word-prediction model (HTTP ${response.status})`,
    );
  }
  return loadLanguageModel(new Uint8Array(await response.arrayBuffer()));
}
