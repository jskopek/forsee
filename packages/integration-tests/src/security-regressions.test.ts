/**
 * The two composition leaks found in review round 1, driven through the real
 * plugin host, kernel and prediction engine.
 */
import { isForseeError } from '@forsee/core';
import type {
  ForseeApi,
  PermissionScope,
  PredictionProvider,
  PredictionRequest,
} from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createHarness, firstParty, settle } from './harness';

const SECRET = 'my-private-sentence';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return isForseeError(error) ? error.code : `non-forsee: ${String(error)}`;
  }
}

function recordingProvider(received: PredictionRequest[]): PredictionProvider {
  return {
    id: 'spy',
    capabilities: { kinds: ['completions'], usesKeyDistributions: true },
    predict(request) {
      received.push(request);
      return {
        requestId: request.requestId,
        providerId: 'spy',
        stage: 'instant',
        completions: [],
        nextWords: [],
        letters: {},
        phrases: [],
      };
    },
  };
}

async function withPlugin(permissions: readonly PermissionScope[]) {
  let api: ForseeApi | undefined;
  const harness = await createHarness({
    firstParty: [
      firstParty('forsee.probe', permissions, {
        activate(forsee) {
          api = forsee;
        },
      }),
    ],
  });
  if (!api) throw new Error('plugin did not activate');
  return { harness, api };
}

describe('1a: prediction providers and the composition', () => {
  it('a plugin without composition.read cannot register a provider, so never sees the text', async () => {
    const { harness, api } = await withPlugin([]);
    const received: PredictionRequest[] = [];
    expect(await codeOf(api.register.predictionProvider(recordingProvider(received)))).toBe(
      'permission-denied',
    );
    await harness.kernel.commands.execute('composition.insert', { text: SECRET }, 'keyboard');
    harness.prediction.predict(harness.query());
    await settle();
    expect(received).toEqual([]);
  });

  it('revoking composition.read stops delivery at once', async () => {
    const { harness, api } = await withPlugin(['composition.read']);
    const received: PredictionRequest[] = [];
    await api.register.predictionProvider(recordingProvider(received));
    await harness.kernel.commands.execute('composition.insert', { text: 'hello' }, 'keyboard');
    harness.prediction.predict(harness.query());
    expect(received.map((r) => r.textBefore)).toEqual(['hello']);

    await harness.plugins.permissions.revoke('forsee.probe', 'composition.read');
    await harness.kernel.commands.execute('composition.insert', { text: SECRET }, 'keyboard');
    harness.prediction.predict(harness.query());
    await settle();
    expect(received.map((r) => r.textBefore)).toEqual(['hello']);
    expect(harness.kernel.extensions.list('predictionProviders')).toEqual([]);
  });
});

describe('1b: speech.speak no longer reads or clears the composition', () => {
  it('a plugin with only speech.output cannot take the composition', async () => {
    const { harness, api } = await withPlugin(['speech.output']);
    await harness.kernel.commands.execute('composition.insert', { text: SECRET }, 'keyboard');

    // The old no-text form is gone...
    expect(await codeOf(api.commands.execute('speech.speak', { log: false } as never))).toBe(
      'invalid-argument',
    );
    expect(await codeOf(api.commands.execute('speech.speak'))).toBe('invalid-argument');
    // ...and its replacement needs composition.read and composition.write.
    expect(await codeOf(api.commands.execute('composition.speak', { log: false }))).toBe(
      'permission-denied',
    );
    expect(harness.kernel.composition.text).toBe(SECRET);
    expect(harness.appVoice.spoken).toEqual([]);

    // Speaking its own text works and returns nothing of the composition.
    const result = await api.commands.execute('speech.speak', { text: 'hello', log: false });
    await settle();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(harness.appVoice.spoken.map((u) => u.text)).toEqual(['hello']);
    expect(harness.kernel.composition.text).toBe(SECRET);
  });
});
