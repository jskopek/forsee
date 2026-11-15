import { isForseeError } from '@forsee/core';
import { ModelBuilder } from '@forsee/prediction';
import { describe, expect, it } from 'vitest';
import { BUNDLED_ENGLISH_MODEL_URL, fetchLanguageModel } from './language-model';

describe('fetchLanguageModel', () => {
  it('points at the bundled English model file', () => {
    expect(BUNDLED_ENGLISH_MODEL_URL).toMatch(/model\.bin/);
  });

  it('opens the model it downloads', async () => {
    const builder = new ModelBuilder({ locale: 'en' });
    builder.addVocabularyText('hello there');
    builder.addText('hello there');
    const bytes = builder.build();
    const requested: unknown[] = [];
    const model = await fetchLanguageModel('/m.bin', (input) => {
      requested.push(input);
      return Promise.resolve(new Response(new Blob([new Uint8Array(bytes)])));
    });
    expect(requested).toEqual(['/m.bin']);
    expect(model.completions([], 'hel', 3).map((c) => c.text)).toContain('hello');
  });

  it('rejects with `unavailable` when the download fails', async () => {
    const notFound = fetchLanguageModel('/m.bin', () =>
      Promise.resolve(new Response('', { status: 404 })),
    );
    await expect(notFound).rejects.toSatisfy((e: unknown) => isForseeError(e, 'unavailable'));
    const offline = fetchLanguageModel('/m.bin', () => Promise.reject(new TypeError('offline')));
    await expect(offline).rejects.toSatisfy((e: unknown) => isForseeError(e, 'unavailable'));
  });
});
