/**
 * Seams found while wiring the application runtime (apps/web/src/runtime),
 * each fixed at its source and pinned here with the real packages.
 */
import { createKernel, FakeClock, SequentialIdSource } from '@forsee/core';
import { createMemoryHost } from '@forsee/host';
import { validateLayout } from '@forsee/layouts';
import type { PermissionScope } from '@forsee/plugin-api';
import { createPluginHost, predictionAccess } from '@forsee/plugin-host';
import { ScriptedConsentPrompt } from '@forsee/plugin-host/testing';
import {
  createNgramPredictionPlugin,
  manifest as ngramManifest,
} from '@forsee/plugin-prediction-ngram';
import { createPredictionEngine, type PredictionEngineOptions } from '@forsee/prediction';
import { createSpeechEngine, createWebSpeechProvider } from '@forsee/speech';
import { fakeBrowserVoice, FakeSpeechSynthesis } from '@forsee/speech/testing';
import { describe, expect, it, vi } from 'vitest';
import { settle } from './harness';

async function predictorSetup(
  permissions: readonly PermissionScope[],
  access?: 'plugin-host' | 'engine-default',
) {
  const clock = new FakeClock();
  const kernel = createKernel({ clock, ids: new SequentialIdSource(), deviceId: 'd' });
  await kernel.start();
  const plugin = createNgramPredictionPlugin({ clock });
  const plugins = createPluginHost({
    kernel,
    host: createMemoryHost({ clock }),
    firstParty: [{ ...plugin, manifest: { ...ngramManifest, permissions } }],
    validateLayout,
    consent: new ScriptedConsentPrompt(true),
  });
  const options: PredictionEngineOptions = {
    extensions: kernel.extensions,
    ...(access === 'plugin-host' ? { access: predictionAccess(plugins.permissions) } : {}),
  };
  const engine = createPredictionEngine(options);
  await plugins.start();
  const learnAndPredict = async (): Promise<string[]> => {
    for (let i = 0; i < 3; i += 1) {
      await engine.learn({
        text: 'the zorblat is here',
        origin: 'composition',
        locale: 'en',
        createdAt: clock.wallNow(),
      });
    }
    return engine
      .predict({
        textBefore: 'zor',
        partialWord: 'zor',
        locale: 'en',
        maxCandidates: 5,
        kinds: ['completions'],
      })
      .instant.completions.map((c) => c.text);
  };
  return { learnAndPredict };
}

describe('prediction engine and plugin host agree on what a plugin provider may do', () => {
  it('a plugin predictor with lm.write learns when the engine uses predictionAccess', async () => {
    const { learnAndPredict } = await predictorSetup(
      ['composition.read', 'lm.write', 'history.read'],
      'plugin-host',
    );
    expect(await learnAndPredict()).toContain('zorblat');
  });

  it('without lm.write it does not learn', async () => {
    const { learnAndPredict } = await predictorSetup(
      ['composition.read', 'history.read'],
      'plugin-host',
    );
    expect(await learnAndPredict()).not.toContain('zorblat');
  });

  it("the engine's default access denies every plugin provider learning (why the host must supply it)", async () => {
    const { learnAndPredict } = await predictorSetup(
      ['composition.read', 'lm.write', 'history.read'],
      'engine-default',
    );
    expect(await learnAndPredict()).not.toContain('zorblat');
  });

  it('predictionAccess grants conversation, context and learning only with the scopes', () => {
    const held = new Set(['p/composition.read', 'p/history.read', 'q/lm.write']);
    const access = predictionAccess({ has: (id, scope) => held.has(`${id}/${scope}`) });
    expect(access({ owner: 'app' })).toEqual({ conversation: true, context: true, learn: true });
    expect(access({ owner: 'p' })).toEqual({ conversation: true, context: false, learn: false });
    // lm.write without composition.read: the provider is never called at all.
    expect(access({ owner: 'q' })).toEqual({ conversation: false, context: false, learn: false });
  });
});

describe('kernel and speech engine agree on failed speech', () => {
  it('a browser synthesis error reaches the UI as speech.unavailable', async () => {
    const clock = new FakeClock();
    const ids = new SequentialIdSource();
    const synthesis = new FakeSpeechSynthesis({ voices: [fakeBrowserVoice('Daniel', 'en-GB')] });
    const engine = createSpeechEngine({
      clock,
      newId: () => ids.uuid(),
      providers: [
        createWebSpeechProvider({ synthesis, createUtterance: synthesis.createUtterance, clock }),
      ],
    });
    const kernel = createKernel({ clock, ids, deviceId: 'd', speech: engine });
    await kernel.start();
    const unavailable = vi.fn();
    kernel.bus.on('speech.unavailable', unavailable);
    await kernel.commands.execute('composition.insert', { text: 'hello' });
    const result = await kernel.commands.execute('composition.speak');
    synthesis.error('synthesis-failed');
    await settle();
    expect(unavailable).toHaveBeenCalledWith({
      text: 'hello',
      recordId: (result as { recordId: string }).recordId,
      reason: 'error',
    });
  });
});
