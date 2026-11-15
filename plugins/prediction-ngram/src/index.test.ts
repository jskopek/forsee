import { FakeClock } from '@forsee/core';
import type { PermissionScope, PluginManifest, PredictionRequest } from '@forsee/plugin-api';
import { validateManifest } from '@forsee/plugin-host';
import { createTestPluginApi } from '@forsee/plugin-host/testing';
import { loadLanguageModel, ModelBuilder, type LanguageModel } from '@forsee/prediction';
import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';
import {
  createNgramPredictionPlugin,
  LEARN_WORDS_SETTING,
  manifest,
  NEXT_WORDS_SETTING,
  NGRAM_PLUGIN_ID,
  USER_MODEL_KEY,
} from './index';

const PROVIDER_ID = `${NGRAM_PLUGIN_ID}/ngram`;

function request(textBefore: string, partialWord: string, requestId = 1): PredictionRequest {
  return {
    requestId,
    textBefore,
    partialWord,
    locale: 'en',
    maxCandidates: 5,
    kinds: ['completions', 'nextWords', 'letters', 'phrases'],
  };
}

/** A tiny base model that knows words the seed model does not. */
function zebraModel(): LanguageModel {
  const builder = new ModelBuilder({ locale: 'en' });
  const text = ['the zebra zigzags home', 'a zebra zigzags past', 'zebras zigzag'];
  for (const line of text) builder.addVocabularyText(line);
  for (const line of text) builder.addText(line);
  return loadLanguageModel(builder.build());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withPermissions(scopes: readonly PermissionScope[]): PluginManifest {
  return { ...manifest, permissions: scopes };
}

async function activate(m: PluginManifest = manifest) {
  const test = await createTestPluginApi({ manifest: m, origin: 'first-party' });
  const plugin = createNgramPredictionPlugin({ clock: test.clock });
  return { ...test, plugin };
}

function provider(kernel: Awaited<ReturnType<typeof activate>>['kernel']) {
  return kernel.extensions.list('predictionProviders').find((c) => c.id === PROVIDER_ID)
    ?.contribution;
}

describe('forsee.prediction-ngram', () => {
  it('has a manifest the real validator accepts as first-party', () => {
    const result = validateManifest(manifestJson, { firstParty: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(NGRAM_PLUGIN_ID);
  });

  it('declares exactly the permissions it uses', () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['composition.read', 'history.read', 'lm.write'].sort(),
    );
    expect(manifest.optionalPermissions).toBeUndefined();
  });

  it('registers the n-gram provider through the API and predicts', async () => {
    const { api, kernel, plugin } = await activate();
    await plugin.module.activate(api);
    const p = provider(kernel);
    expect(p).toBeDefined();
    const result = await p!.predict(request('he', 'he'));
    expect(result.providerId).toBe(PROVIDER_ID);
    expect(result.completions.length).toBeGreaterThan(0);
  });

  it('learns a new word and keeps it in its private storage', async () => {
    const { api, kernel, plugin, storage, clock } = await activate();
    await plugin.module.activate(api);
    const p = provider(kernel)!;
    for (let i = 0; i < 3; i += 1) {
      await p.learn!({
        text: 'my zorblat is here',
        origin: 'composition',
        locale: 'en',
        createdAt: clock.wallNow(),
      });
    }
    expect(await storage.get(USER_MODEL_KEY)).toBeDefined();
    const words = (await p.predict(request('zor', 'zor'))).completions.map((c) => c.text);
    expect(words).toContain('zorblat');

    // A fresh activation (after a restart) reads it back.
    await plugin.module.deactivate?.();
    kernel.extensions.disposeOwner(NGRAM_PLUGIN_ID);
    const again = createNgramPredictionPlugin({ clock });
    await again.module.activate(api);
    const back = await provider(kernel)!.predict(request('zor', 'zor', 2));
    expect(back.completions.map((c) => c.text)).toContain('zorblat');
  });

  it('cannot register without composition.read', async () => {
    const { api, plugin, kernel } = await activate(withPermissions(['lm.write', 'history.read']));
    await expect(plugin.module.activate(api)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(provider(kernel)).toBeUndefined();
  });

  it('does not learn without lm.write', async () => {
    const { api, plugin, kernel, storage, clock } = await activate(
      withPermissions(['composition.read', 'history.read']),
    );
    await plugin.module.activate(api);
    await provider(kernel)!.learn!({
      text: 'my zorblat',
      origin: 'composition',
      locale: 'en',
      createdAt: clock.wallNow(),
    });
    expect(await storage.get(USER_MODEL_KEY)).toBeUndefined();
  });

  it('rebuilds phrases from history with history.read, and works without it', async () => {
    const clock = new FakeClock();
    for (const scopes of [
      ['composition.read', 'lm.write', 'history.read'],
      ['composition.read', 'lm.write'],
    ] as const) {
      const test = await createTestPluginApi({
        manifest: withPermissions(scopes),
        origin: 'first-party',
      });
      test.kernel.conversation.append({ body: 'could you open the window', sender: 'user' });
      const plugin = createNgramPredictionPlugin({ clock });
      await plugin.module.activate(test.api);
      const result = await provider(test.kernel)!.predict(request('could you ', ''));
      const phrases = result.phrases.map((p) => p.text);
      if (scopes.length === 3) expect(phrases).toContain('could you open the window');
      else expect(phrases).toEqual([]);
    }
  });

  it('registers its settings, both on by default', async () => {
    const { api, kernel, plugin } = await activate();
    await plugin.module.activate(api);
    expect(kernel.settings.getAll(NGRAM_PLUGIN_ID)).toEqual({
      [LEARN_WORDS_SETTING]: true,
      [NEXT_WORDS_SETTING]: true,
    });
    const section = kernel.extensions.list('settings').find((c) => c.owner === NGRAM_PLUGIN_ID);
    expect(section?.contribution.fields.map((f) => f.key)).toEqual([
      LEARN_WORDS_SETTING,
      NEXT_WORDS_SETTING,
    ]);
  });

  it('stops learning while "Learn my words" is off, and starts again when it is on', async () => {
    const { api, kernel, plugin, storage, clock } = await activate();
    await plugin.module.activate(api);
    const p = provider(kernel)!;
    const learn = async (): Promise<void> =>
      await p.learn!({
        text: 'my zorblat',
        origin: 'composition',
        locale: 'en',
        createdAt: clock.wallNow(),
      });

    kernel.settings.set(NGRAM_PLUGIN_ID, LEARN_WORDS_SETTING, false);
    await learn();
    expect(await storage.get(USER_MODEL_KEY)).toBeUndefined();

    kernel.settings.set(NGRAM_PLUGIN_ID, LEARN_WORDS_SETTING, true);
    await learn();
    expect(await storage.get(USER_MODEL_KEY)).toBeDefined();
  });

  it('leaves out next words while "Suggest the next word" is off', async () => {
    const { api, kernel, plugin } = await activate();
    await plugin.module.activate(api);
    const p = provider(kernel)!;
    expect((await p.predict(request('how are ', ''))).nextWords.length).toBeGreaterThan(0);

    kernel.settings.set(NGRAM_PLUGIN_ID, NEXT_WORDS_SETTING, false);
    const off = await p.predict(request('how are ', '', 2));
    expect(off.nextWords).toEqual([]);
    expect((await p.predict(request('he', 'he', 3))).completions.length).toBeGreaterThan(0);
  });

  it('reads stored settings at activation', async () => {
    const { api, kernel, plugin } = await activate();
    await plugin.module.activate(api);
    kernel.settings.set(NGRAM_PLUGIN_ID, NEXT_WORDS_SETTING, false);
    await plugin.module.deactivate?.();
    kernel.extensions.disposeOwner(NGRAM_PLUGIN_ID);
    await plugin.module.activate(api);
    expect((await provider(kernel)!.predict(request('how are ', ''))).nextWords).toEqual([]);
  });
  it('predicts with the seed model until the base model has loaded, then uses it', async () => {
    const test = await createTestPluginApi({ manifest, origin: 'first-party' });
    const load = deferred<LanguageModel>();
    let calls = 0;
    const plugin = createNgramPredictionPlugin({
      clock: test.clock,
      baseModel: () => {
        calls++;
        return load.promise;
      },
    });
    await plugin.module.activate(test.api);
    const p = provider(test.kernel)!;
    const words = async (id: number) =>
      (await p.predict(request('the zebra zig', 'zig', id))).completions.map((c) => c.text);
    expect(await words(1)).not.toContain('zigzags');

    // What the user taught it before the switch is kept.
    await p.learn!({ text: 'zigzagging', origin: 'composition', locale: 'en', createdAt: 0 });
    load.resolve(zebraModel());
    await plugin.baseModelReady();
    expect(await words(2)).toContain('zigzags');
    expect(await words(3)).toContain('zigzagging');

    // Loaded once: a later activation uses it straight away.
    await plugin.module.deactivate?.();
    test.kernel.extensions.disposeOwner(NGRAM_PLUGIN_ID);
    await plugin.module.activate(test.api);
    const again = await provider(test.kernel)!.predict(request('the zebra zig', 'zig', 4));
    expect(again.completions.map((c) => c.text)).toContain('zigzags');
    expect(calls).toBe(1);
  });

  it('keeps the seed model and reports the error when the base model fails to load', async () => {
    const test = await createTestPluginApi({ manifest, origin: 'first-party' });
    const errors: unknown[] = [];
    const plugin = createNgramPredictionPlugin({
      clock: test.clock,
      baseModel: () => Promise.reject(new Error('offline')),
      onBaseModelError: (error) => errors.push(error),
    });
    await plugin.module.activate(test.api);
    await plugin.baseModelReady();
    expect(errors).toEqual([new Error('offline')]);
    const result = await provider(test.kernel)!.predict(request('he', 'he'));
    expect(result.completions.length).toBeGreaterThan(0);
  });
});
