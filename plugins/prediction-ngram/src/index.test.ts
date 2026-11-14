import { FakeClock } from '@forsee/core';
import type { PermissionScope, PluginManifest, PredictionRequest } from '@forsee/plugin-api';
import { validateManifest } from '@forsee/plugin-host';
import { createTestPluginApi } from '@forsee/plugin-host/testing';
import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';
import { createNgramPredictionPlugin, manifest, NGRAM_PLUGIN_ID, USER_MODEL_KEY } from './index';

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
});
