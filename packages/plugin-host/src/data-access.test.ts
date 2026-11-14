/**
 * Rules about what data a plugin can observe, and what effects it can cause,
 * through paths other than the method that is documented for it (review
 * round 1): the composition reaches prediction providers, voice providers,
 * text transforms, command results and speech events; spoken text sits in
 * the undo stack.
 */
import { isForseeError, type SpeechService } from '@forsee/core';
import type {
  PermissionScope,
  PredictionProvider,
  PredictionRequest,
  SpeechEvent,
  TextTransform,
  Utterance,
  VoiceProvider,
} from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { createTestPluginApi, testManifest, type TestPluginApiOptions } from './testing';

const ID = 'community.probe';

async function setup(permissions: readonly PermissionScope[], options: TestPluginApiOptions = {}) {
  return createTestPluginApi({
    manifest: testManifest({ id: ID, permissions }),
    grant: 'all',
    ...options,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return isForseeError(error) ? error.code : `non-forsee: ${String(error)}`;
  }
}

const request = (textBefore: string): PredictionRequest => ({
  requestId: 1,
  textBefore,
  partialWord: textBefore,
  locale: 'en-GB',
  maxCandidates: 3,
  kinds: ['completions'],
});

function recordingSpeech() {
  const calls: { text: string; options: unknown }[] = [];
  const speech: SpeechService = {
    speak: (text, options) => {
      calls.push({ text, options });
      return Promise.resolve('completed');
    },
    stop: () => undefined,
  };
  return { speech, calls };
}

describe('prediction providers and composition.read', () => {
  const recordingProvider = (received: unknown[]): PredictionProvider => ({
    id: 'pp',
    capabilities: { kinds: ['completions'], usesKeyDistributions: false },
    predict: (r) => {
      received.push(r);
      return {
        requestId: r.requestId,
        providerId: 'pp',
        stage: 'instant',
        completions: [],
        nextWords: [],
        letters: {},
        phrases: [],
      };
    },
    refine: (r) => {
      received.push(r);
      return Promise.resolve(null);
    },
    learn: (e) => {
      received.push(e);
    },
  });

  it('cannot be registered without composition.read', async () => {
    const ctx = await setup([]);
    expect(await codeOf(ctx.api.register.predictionProvider(recordingProvider([])))).toBe(
      'permission-denied',
    );
    expect(ctx.kernel.extensions.list('predictionProviders')).toEqual([]);
  });

  it('is not called once composition.read is revoked, and its registration goes', async () => {
    const ctx = await setup(['composition.read', 'lm.write']);
    const received: unknown[] = [];
    await ctx.api.register.predictionProvider(recordingProvider(received));
    const entry = ctx.kernel.extensions.list('predictionProviders')[0];
    if (!entry) throw new Error('not registered');
    const wrapped = entry.contribution;
    void wrapped.predict(request('before'));
    expect(received).toHaveLength(1);

    await ctx.permissions.revoke(ID, 'composition.read');
    expect(ctx.kernel.extensions.list('predictionProviders')).toEqual([]);
    // A caller still holding the provider (an engine mid-request) gets nothing through.
    expect(wrapped.predict(request('secret after revoke'))).toMatchObject({
      requestId: 1,
      completions: [],
    });
    await expect(
      wrapped.refine?.(request('secret'), {
        cancelled: false,
        onCancel: () => ({ dispose: () => undefined }),
      }),
    ).resolves.toBeNull();
    await wrapped.learn?.({ text: 'secret', origin: 'composition', locale: 'en', createdAt: 1 });
    expect(JSON.stringify(received)).not.toContain('secret');
  });
});

describe('speech.speak and composition.speak', () => {
  it('speech.speak without text is rejected and neither reveals nor clears the composition', async () => {
    const { speech } = recordingSpeech();
    const ctx = await setup(['speech.output'], { kernelOptions: { speech } });
    await ctx.kernel.commands.execute('composition.insert', { text: 'my secret draft' });
    for (const args of [undefined, { log: false }, { text: '' }]) {
      expect(await codeOf(ctx.api.commands.execute('speech.speak', args as never))).toBe(
        'invalid-argument',
      );
    }
    expect(ctx.kernel.composition.text).toBe('my secret draft');
    const result = await ctx.api.commands.execute('speech.speak', { text: 'hello', log: false });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(ctx.kernel.composition.text).toBe('my secret draft');
  });

  it('composition.speak needs speech.output, composition.read and composition.write', async () => {
    for (const missing of ['speech.output', 'composition.read', 'composition.write'] as const) {
      const scopes = (['speech.output', 'composition.read', 'composition.write'] as const).filter(
        (s) => s !== missing,
      );
      const ctx = await setup(scopes);
      await ctx.kernel.commands.execute('composition.insert', { text: 'draft' });
      expect(await codeOf(ctx.api.commands.execute('composition.speak')), missing).toBe(
        'permission-denied',
      );
      expect(ctx.kernel.composition.text).toBe('draft');
    }
    const { speech, calls } = recordingSpeech();
    const ctx = await setup(['speech.output', 'composition.read', 'composition.write'], {
      kernelOptions: { speech },
    });
    await ctx.kernel.commands.execute('composition.insert', { text: 'draft' });
    expect(await ctx.api.commands.execute('composition.speak')).toMatchObject({
      spoken: true,
      text: 'draft',
    });
    expect(calls.map((c) => c.text)).toEqual(['draft']);
    expect(ctx.kernel.composition.text).toBe('');
  });

  it('passes every speak option, interrupt included, to the speech service', async () => {
    const { speech, calls } = recordingSpeech();
    const ctx = await setup(['speech.output'], { kernelOptions: { speech } });
    await ctx.api.speech.speak('help', {
      interrupt: true,
      voiceId: 'community.voices/neural/Ava',
      rate: 2,
      pitch: 1.2,
      volume: 0.3,
      recording: 'phrases/audio/help.wav',
      log: false,
    });
    expect(calls).toEqual([
      {
        text: 'help',
        options: {
          interrupt: true,
          voiceId: 'community.voices/neural/Ava',
          rate: 2,
          pitch: 1.2,
          volume: 0.3,
          recording: 'phrases/audio/help.wav',
        },
      },
    ]);
    expect(ctx.kernel.conversation.listRecent(5)).toEqual([]);
    for (const options of [
      { interrupt: 'yes' },
      { recording: '../profile.json' },
      { recording: 'https://example.com/a.wav' },
      { rate: 20 },
    ]) {
      expect(await codeOf(ctx.api.speech.speak('x', options as never))).toBe('invalid-argument');
    }
    expect(await codeOf(ctx.api.speech.speak('   '))).toBe('invalid-argument');
  });

  it('speech.stop needs speech.output; gaze.pause and gaze.resume are not for plugins', async () => {
    const ctx = await setup([]);
    expect(await codeOf(ctx.api.speech.stop())).toBe('permission-denied');
    const all = await setup(['speech.output', 'composition.write', 'composition.read']);
    expect(await codeOf(all.api.speech.stop())).toBe('ok');
    expect(await codeOf(all.api.commands.execute('gaze.pause'))).toBe('permission-denied');
    expect(await codeOf(all.api.commands.execute('gaze.resume'))).toBe('permission-denied');
  });
});

describe('composition data through command results and undo', () => {
  it('hides the results of composition commands without composition.read', async () => {
    const writer = await setup(['composition.write']);
    await writer.kernel.commands.execute('composition.insert', { text: 'abc' });
    for (const id of [
      'composition.deleteGrapheme',
      'composition.deleteWord',
      'composition.undo',
      'composition.clear',
    ]) {
      expect(await writer.api.commands.execute(id), id).toBeUndefined();
    }
    const reader = await setup(['composition.write', 'composition.read']);
    expect(await reader.api.commands.execute('composition.deleteGrapheme')).toBe(false);
    await reader.kernel.commands.execute('composition.insert', { text: 'abc' });
    expect(await reader.api.commands.execute('composition.deleteGrapheme')).toBe(true);
  });

  it('needs history.read to undo a commit, which would bring back spoken text', async () => {
    const ctx = await setup(['composition.write', 'composition.read']);
    await ctx.kernel.commands.execute('composition.insert', { text: 'what I said earlier' });
    await ctx.kernel.commands.execute('composition.speak');
    await ctx.kernel.commands.execute('composition.insert', { text: 'now' });
    await ctx.api.composition.undo(); // undoes "now": fine
    expect(ctx.kernel.composition.text).toBe('');
    expect(await codeOf(ctx.api.composition.undo())).toBe('permission-denied');
    expect(await codeOf(ctx.api.commands.execute('composition.undo'))).toBe('permission-denied');
    expect(ctx.kernel.composition.text).toBe('');
    const withHistory = await setup(['composition.write', 'composition.read', 'history.read'], {
      kernel: ctx.kernel,
      manifest: testManifest({
        id: 'community.historian',
        permissions: ['composition.write', 'composition.read', 'history.read'],
      }),
    });
    await withHistory.api.composition.undo();
    expect(ctx.kernel.composition.text).toBe('what I said earlier');
  });
});

describe('speech events', () => {
  const events: SpeechEvent[] = [
    { type: 'start', utteranceId: 'u', t: 1 },
    { type: 'boundary', utteranceId: 'u', charIndex: 3, charLength: 6, t: 2 },
    { type: 'error', utteranceId: 'u', message: 'could not say "my secret"', t: 3 },
    { type: 'end', utteranceId: 'u', reason: 'error', t: 4 },
  ];

  it('drop word boundaries and error text without composition.read', async () => {
    for (const scopes of [[], ['composition.read']] as PermissionScope[][]) {
      const listeners: ((e: SpeechEvent) => void)[] = [];
      const ctx = await setup(scopes, {
        services: {
          speechEvents: (listener) => {
            listeners.push(listener);
            return { dispose: () => undefined };
          },
        },
      });
      const seen: SpeechEvent[] = [];
      await ctx.api.events.on('speech.event', (e) => seen.push(e));
      for (const event of events) for (const listener of listeners) listener(event);
      if (scopes.length === 0) {
        expect(seen.map((e) => e.type)).toEqual(['start', 'error', 'end']);
        expect(JSON.stringify(seen)).not.toContain('secret');
      } else {
        expect(seen).toEqual(events);
      }
    }
  });
});

describe('text transforms and voice providers see the composition', () => {
  it('a text transform needs composition.read too, checked on every call', async () => {
    const writer = await setup(['composition.write']);
    const transformFn = vi.fn(() => null);
    const transform: TextTransform = {
      id: 'tt',
      name: 'TT',
      triggers: ['commit'],
      transform: transformFn,
    };
    expect(await codeOf(writer.api.register.textTransform(transform))).toBe('permission-denied');

    const ctx = await setup(['composition.write', 'composition.read']);
    await ctx.api.register.textTransform(transform);
    const wrapped = ctx.kernel.extensions.list('textTransforms')[0]?.contribution;
    if (!wrapped) throw new Error('not registered');
    await ctx.permissions.revoke(ID, 'composition.read');
    await expect(
      wrapped.transform({ trigger: 'commit', text: 'secret', locale: 'en' }),
    ).resolves.toBeNull();
    expect(transformFn).not.toHaveBeenCalled();
  });

  it('a voice provider needs composition.read, checked on every utterance', async () => {
    const spoken: Utterance[] = [];
    const provider: VoiceProvider = {
      id: 'vp',
      listVoices: () => Promise.resolve([]),
      speak: (u) => {
        spoken.push(u);
        return { utteranceId: u.id, stop: () => undefined, done: Promise.resolve('completed') };
      },
      stop: () => undefined,
    };
    const speaker = await setup(['speech.output']);
    expect(await codeOf(speaker.api.register.voiceProvider(provider))).toBe('permission-denied');

    const ctx = await setup(['speech.output', 'composition.read']);
    await ctx.api.register.voiceProvider(provider);
    const wrapped = ctx.kernel.extensions.list('voiceProviders')[0]?.contribution;
    if (!wrapped) throw new Error('not registered');
    expect(wrapped.id).toBe(`${ID}/vp`);
    const handle = wrapped.speak({ id: 'u1', text: 'hello' }, {});
    expect(handle.utteranceId).toBe('u1');
    await expect(handle.done).resolves.toBe('completed');
    await ctx.permissions.revoke(ID, 'composition.read');
    expect(() => wrapped.speak({ id: 'u2', text: 'secret' }, {})).toThrow(
      expect.objectContaining({ code: 'permission-denied' }) as Error,
    );
    expect(spoken.map((u) => u.text)).toEqual(['hello']);
  });

  it("validates a voice provider's handle", async () => {
    const ctx = await setup(['speech.output', 'composition.read']);
    let next: unknown = null;
    await ctx.api.register.voiceProvider({
      id: 'odd',
      listVoices: () => Promise.resolve([]),
      speak: () => next as never,
      stop: () => undefined,
    });
    const wrapped = ctx.kernel.extensions.list('voiceProviders')[0]?.contribution;
    if (!wrapped) throw new Error('not registered');
    expect(() => wrapped.speak({ id: 'u', text: 'x' }, {})).toThrow();
    next = { stop: () => undefined, done: 'soon' };
    expect(() => wrapped.speak({ id: 'u', text: 'x' }, {})).toThrow();
    next = { stop: () => undefined, done: Promise.resolve('whatever') };
    await expect(wrapped.speak({ id: 'u', text: 'x' }, {}).done).resolves.toBe('error');
  });
});
