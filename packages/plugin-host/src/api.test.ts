import { isForseeError } from '@forsee/core';
import {
  FIXED_PERMISSION_SCOPES,
  PLUGIN_EVENT_PERMISSIONS,
  type ForseeApi,
  type ForseeEventType,
  type InferenceService,
  type PermissionScope,
  type PluginManifest,
  type PredictionProvider,
  type PredictionRequest,
  type PredictionResult,
} from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { invokeApiMethod, PLUGIN_API_METHODS, type PluginApiMethod } from './api';
import {
  createTestPluginApi,
  ScriptedConsentPrompt,
  testLayout,
  testManifest,
  type TestPluginApi,
  type TestPluginApiOptions,
} from './testing';

// ---------------------------------------------------------------- helpers

interface FakeInference extends InferenceService {
  readonly loaded: Set<string>;
}

function fakeInference(): FakeInference {
  let next = 0;
  const loaded = new Set<string>();
  return {
    loaded,
    getStatus: () => Promise.resolve({ tier: 0 }),
    listModels: () => Promise.resolve([]),
    loadModel: (modelId) => {
      next += 1;
      const handleId = `h${next}`;
      loaded.add(handleId);
      return Promise.resolve({ handleId, modelId });
    },
    unloadModel: (handleId) => {
      loaded.delete(handleId);
      return Promise.resolve();
    },
    scoreNextTokens: () => Promise.resolve({ tokens: [{ text: 'a', logProb: -1 }] }),
    generate: (_request, onToken) => {
      onToken?.('hi');
      return Promise.resolve({ text: 'hi', finishReason: 'stop' as const });
    },
  };
}

const ALL_SCOPES: PermissionScope[] = [...FIXED_PERMISSION_SCOPES, 'network:api.example.com'];
const PANEL = { id: 'p', entry: 'p.html', region: 'side' as const };

function manifestWith(
  permissions: readonly PermissionScope[],
  extra: Partial<PluginManifest> = {},
) {
  return testManifest({ id: 'community.matrix', panels: [PANEL], permissions, ...extra });
}

async function setup(
  permissions: readonly PermissionScope[],
  options: TestPluginApiOptions = {},
): Promise<TestPluginApi & { inference: FakeInference }> {
  const inference = fakeInference();
  const ctx = await createTestPluginApi({
    manifest: manifestWith(permissions),
    grant: 'all',
    ...options,
    services: { inference, ...options.services },
  });
  return { ...ctx, inference };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return isForseeError(error) ? error.code : `non-forsee: ${String(error)}`;
  }
}

const request = (overrides: Partial<PredictionRequest> = {}): PredictionRequest => ({
  requestId: 7,
  textBefore: 'hel',
  partialWord: 'hel',
  locale: 'en-GB',
  maxCandidates: 2,
  kinds: ['completions'],
  conversation: { recent: [{ sender: 'contact', body: 'secret', createdAt: 1 }] },
  context: [{ key: 'time.partOfDay', value: 'evening', source: 'app', updatedAt: 1 }],
  ...overrides,
});

const provider = (received: PredictionRequest[] = []): PredictionProvider => ({
  id: 'pp',
  capabilities: { kinds: ['completions'], usesKeyDistributions: false },
  predict(r) {
    received.push(r);
    return {
      requestId: 999,
      providerId: 'spoofed',
      stage: 'refined',
      completions: [
        { text: 'hello', score: 3 },
        { text: 'help', score: 0.5 },
        { text: 'helm', score: 0.1 },
      ],
      nextWords: [],
      letters: { l: 0.7 },
      phrases: [],
    };
  },
});

// ---------------------------------------------------------------- the permission matrix

type Call = (api: ForseeApi) => Promise<unknown>;

const inferenceOf = (api: ForseeApi): InferenceService => {
  if (!api.inference) throw new Error('no inference');
  return api.inference;
};

/** For every `ForseeApi` method: the scope it needs (null: none) and a valid call. */
const MATRIX: Record<PluginApiMethod, { scope: PermissionScope | null; call: Call }> = {
  'commands.execute': {
    scope: 'composition.write',
    call: (api) => api.commands.execute('composition.insert', { text: 'a' }),
  },
  'commands.list': { scope: null, call: (api) => api.commands.list() },
  'commands.register': {
    scope: null,
    call: (api) => api.commands.register('community.matrix.go', () => 1, { title: 'Go' }),
  },
  'composition.getState': { scope: 'composition.read', call: (api) => api.composition.getState() },
  'composition.insert': { scope: 'composition.write', call: (api) => api.composition.insert('a') },
  'composition.deleteGrapheme': {
    scope: 'composition.write',
    call: (api) => api.composition.deleteGrapheme(),
  },
  'composition.deleteWord': {
    scope: 'composition.write',
    call: (api) => api.composition.deleteWord(),
  },
  'composition.clear': { scope: 'composition.write', call: (api) => api.composition.clear() },
  'composition.acceptPrediction': {
    scope: 'composition.write',
    call: (api) => api.composition.acceptPrediction('hello'),
  },
  'composition.replace': {
    scope: 'composition.write',
    call: (api) => api.composition.replace('x'),
  },
  'composition.undo': { scope: 'composition.write', call: (api) => api.composition.undo() },
  'speech.speak': { scope: 'speech.output', call: (api) => api.speech.speak('hello') },
  'speech.stop': { scope: null, call: (api) => api.speech.stop() },
  'speech.listVoices': { scope: null, call: (api) => api.speech.listVoices() },
  'settings.registerSchema': {
    scope: null,
    call: (api) =>
      api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: '' }]),
  },
  'settings.get': {
    scope: null,
    call: async (api) => {
      await api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: 'x' }]);
      return api.settings.get('a');
    },
  },
  'settings.set': {
    scope: null,
    call: async (api) => {
      await api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: 'x' }]);
      return api.settings.set('a', 'y');
    },
  },
  'settings.getAll': {
    scope: null,
    call: async (api) => {
      await api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: 'x' }]);
      return api.settings.getAll();
    },
  },
  'storage.get': { scope: null, call: (api) => api.storage.get('k') },
  'storage.set': { scope: null, call: (api) => api.storage.set('k', { a: [1] }) },
  'storage.delete': { scope: null, call: (api) => api.storage.delete('k') },
  'storage.keys': { scope: null, call: (api) => api.storage.keys() },
  'context.get': { scope: 'context.read', call: (api) => api.context.get('time.partOfDay') },
  'context.list': { scope: 'context.read', call: (api) => api.context.list('time') },
  'context.set': {
    scope: 'context.write',
    call: (api) => api.context.set({ key: 'time.partOfDay', value: 'evening' }),
  },
  'context.delete': { scope: 'context.write', call: (api) => api.context.delete('time.partOfDay') },
  'history.listRecent': { scope: 'history.read', call: (api) => api.history.listRecent(5) },
  'events.on': { scope: null, call: (api) => api.events.on('speech.event', () => undefined) },
  'permissions.has': { scope: null, call: (api) => api.permissions.has('camera') },
  'permissions.request': { scope: null, call: (api) => api.permissions.request('camera') },
  'panels.setTargets': {
    scope: null,
    call: (api) =>
      api.panels.setTargets('p', [
        { id: 't', rect: { x: 0, y: 0, width: 10, height: 10 }, dwellClass: 'function' },
      ]),
  },
  'panels.onActivate': { scope: null, call: (api) => api.panels.onActivate(() => undefined) },
  'inference.getStatus': { scope: 'inference', call: (api) => inferenceOf(api).getStatus() },
  'inference.listModels': { scope: 'inference', call: (api) => inferenceOf(api).listModels() },
  'inference.loadModel': { scope: 'inference', call: (api) => inferenceOf(api).loadModel('m') },
  'inference.unloadModel': {
    scope: 'inference',
    call: (api) => inferenceOf(api).unloadModel('h1'),
  },
  'inference.scoreNextTokens': {
    scope: 'inference',
    call: async (api) => {
      const handle = await inferenceOf(api).loadModel('m');
      return inferenceOf(api).scoreNextTokens({ handleId: handle.handleId, prompt: 'a', topK: 3 });
    },
  },
  'inference.generate': {
    scope: 'inference',
    call: async (api) => {
      const handle = await inferenceOf(api).loadModel('m');
      return inferenceOf(api).generate({ handleId: handle.handleId, prompt: 'a', maxTokens: 3 });
    },
  },
  'register.layout': { scope: null, call: (api) => api.register.layout(testLayout('compact')) },
  'register.theme': {
    scope: null,
    call: (api) =>
      api.register.theme({
        id: 'dark',
        name: 'Dark',
        colorScheme: 'dark',
        tokens: { text: '#fff' },
      }),
  },
  'register.phraseSet': {
    scope: null,
    call: (api) =>
      api.register.phraseSet({
        schemaVersion: 1,
        id: 'ps',
        name: 'P',
        locale: 'en-GB',
        categories: [],
      }),
  },
  'register.vocabulary': {
    scope: null,
    call: (api) =>
      api.register.vocabulary({
        schemaVersion: 1,
        id: 'v',
        name: 'V',
        locale: 'en',
        entries: [{ text: 'Forsee', weight: 2 }],
      }),
  },
  'register.command': {
    scope: null,
    call: (api) => api.register.command({ id: 'cmd', title: 'Cmd', handler: () => 1 }),
  },
  'register.predictionProvider': {
    scope: null,
    call: (api) => api.register.predictionProvider(provider()),
  },
  'register.contextProvider': {
    scope: 'context.write',
    call: (api) =>
      api.register.contextProvider({ id: 'cp', name: 'Clock', provides: ['time.partOfDay'] }),
  },
  'register.textTransform': {
    scope: 'composition.write',
    call: (api) =>
      api.register.textTransform({
        id: 'tt',
        name: 'TT',
        triggers: ['commit'],
        transform: () => null,
      }),
  },
  'register.voiceProvider': {
    scope: 'speech.output',
    call: (api) =>
      api.register.voiceProvider({
        id: 'vp',
        listVoices: () => Promise.resolve([]),
        speak: () => ({
          utteranceId: 'u',
          stop: () => undefined,
          done: Promise.resolve('completed'),
        }),
        stop: () => undefined,
      }),
  },
  'register.outputSink': {
    scope: 'composition.read',
    call: (api) =>
      api.register.outputSink({ id: 'os', name: 'Share', send: () => Promise.resolve() }),
  },
  'register.gazeSource': {
    scope: 'native.sidecar',
    call: (api) =>
      api.register.gazeSource({
        id: 'tracker',
        name: 'Tracker',
        kind: 'driver',
        executable: { linux: 'bin/driver' },
      }),
  },
};

describe('permission matrix', () => {
  it('covers every ForseeApi method', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PLUGIN_API_METHODS].sort());
  });

  const cases = Object.entries(MATRIX) as [PluginApiMethod, (typeof MATRIX)[PluginApiMethod]][];

  it.each(cases.filter(([, c]) => c.scope !== null))(
    '%s is denied without its scope',
    async (_method, { call }) => {
      const { api, consent } = await setup([]);
      expect(await codeOf(call(api))).toBe('permission-denied');
      // Undeclared scopes are refused without asking the user.
      expect(consent.requests.filter((r) => r.reason === 'first-use')).toEqual([]);
    },
  );

  it.each(cases.filter(([, c]) => c.scope !== null))(
    '%s is denied with every scope but its own',
    async (_method, { scope, call }) => {
      const { api } = await setup(ALL_SCOPES.filter((s) => s !== scope));
      expect(await codeOf(call(api))).toBe('permission-denied');
    },
  );

  it.each(cases)('%s is allowed with its scope', async (_method, { scope, call }) => {
    const { api, errors } = await setup(scope === null ? [] : [scope]);
    expect(await codeOf(call(api))).toBe('ok');
    expect(errors).toEqual([]);
  });

  it.each(cases.filter(([, c]) => c.scope !== null))(
    '%s is denied when the user refuses the first-use prompt of an optional scope',
    async (_method, { scope, call }) => {
      const consent = new ScriptedConsentPrompt(true);
      const ctx = await createTestPluginApi({
        manifest: manifestWith([], { optionalPermissions: scope === null ? [] : [scope] }),
        consent,
        services: { inference: fakeInference() },
      });
      consent.setAnswer(false);
      expect(await codeOf(call(ctx.api))).toBe('permission-denied');
      expect(consent.requests.at(-1)).toEqual({
        pluginId: 'community.matrix',
        scopes: [scope],
        reason: 'first-use',
      });
    },
  );

  it('dispatches every method through invokeApiMethod and nothing else', async () => {
    const { api } = await setup(ALL_SCOPES);
    expect(await codeOf(invokeApiMethod(api, 'composition.insert', ['a']))).toBe('ok');
    expect(await codeOf(invokeApiMethod(api, 'composition.constructor', []))).toBe('not-found');
    expect(await codeOf(invokeApiMethod(api, '__proto__.toString', []))).toBe('not-found');
    expect(await codeOf(invokeApiMethod(api, 'plugin.id', []))).toBe('not-found');
    expect(await codeOf(invokeApiMethod(api, 'composition.insert', 'a' as never))).toBe(
      'invalid-argument',
    );
    const noInference = await createTestPluginApi({ manifest: manifestWith(ALL_SCOPES) });
    expect(noInference.api.inference).toBeUndefined();
    expect(await codeOf(invokeApiMethod(noInference.api, 'inference.getStatus', []))).toBe(
      'unavailable',
    );
  });
});

describe('event permissions', () => {
  const events = Object.entries(PLUGIN_EVENT_PERMISSIONS) as [
    ForseeEventType,
    PermissionScope | null,
  ][];

  it.each(events.filter(([, scope]) => scope !== null))('%s is denied without %s', async (type) => {
    const { api } = await setup([]);
    expect(await codeOf(api.events.on(type, () => undefined))).toBe('permission-denied');
  });

  it.each(events)('%s is allowed with %s', async (type, scope) => {
    const { api } = await setup(scope === null ? [] : [scope]);
    expect(await codeOf(api.events.on(type, () => undefined))).toBe('ok');
  });

  it('delivers kernel events as copies, and only the plugin’s own settings changes', async () => {
    const samples: ((s: never) => void)[] = [];
    const ctx = await setup(ALL_SCOPES, {
      services: {
        gazeSamples: (listener) => {
          samples.push(listener);
          return { dispose: () => samples.splice(0) };
        },
      },
    });
    const seen: [string, unknown][] = [];
    for (const type of Object.keys(PLUGIN_EVENT_PERMISSIONS) as ForseeEventType[]) {
      await ctx.api.events.on(type, (payload) => seen.push([type, payload]));
    }
    await ctx.kernel.commands.execute('composition.insert', { text: 'a' });
    await ctx.kernel.commands.execute('speech.speak', { text: 'hi' });
    await ctx.api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: '' }]);
    ctx.kernel.settings.set('app.general', 'locale', 'fr-FR');
    await ctx.api.settings.set('a', 'b');
    ctx.kernel.context.set('app', { key: 'time.partOfDay', value: 'evening' });
    samples[0]?.({ x: 1, y: 2, t: 3, confidence: 1, valid: true } as never);
    expect(seen.map(([type]) => type)).toEqual([
      'composition.changed',
      'history.appended',
      'settings.changed',
      'context.changed',
      'gaze.sample',
    ]);
    const composition = seen[0]?.[1] as { state: object };
    expect(composition.state).not.toBe(ctx.kernel.composition.state);
    expect(composition.state).toEqual(ctx.kernel.composition.state);
  });

  it('rejects unknown event types, including prototype keys', async () => {
    const { api } = await setup(ALL_SCOPES);
    for (const type of ['constructor', '__proto__', 'toString', 'command.didExecute', 3]) {
      expect(await codeOf(api.events.on(type as never, () => undefined))).toBe('invalid-argument');
    }
  });

  it('isolates a throwing listener', async () => {
    const ctx = await setup(['composition.read']);
    await ctx.api.events.on('composition.changed', () => {
      throw new Error('plugin bug');
    });
    await ctx.kernel.commands.execute('composition.insert', { text: 'a' });
    expect(ctx.kernel.composition.text).toBe('a');
    expect(ctx.errors.map((e) => e.context)).toEqual([
      'plugin:community.matrix:event:composition.changed',
    ]);
  });
});

// ---------------------------------------------------------------- commands across plugins

describe('cross-plugin command rules', () => {
  async function twoPlugins(bScopes: readonly PermissionScope[]) {
    const a = await createTestPluginApi({
      manifest: testManifest({ id: 'community.a', permissions: ['composition.write'] }),
    });
    const b = await createTestPluginApi({
      kernel: a.kernel,
      manifest: testManifest({ id: 'community.b', permissions: bScopes }),
    });
    await a.api.commands.register('community.a.secret', () => 'secret', { title: 'Secret' });
    await a.api.commands.register('community.a/shout', () => 'shout', {
      title: 'Shout',
      public: true,
      requires: ['composition.write'],
    });
    await a.api.commands.register('community.a.hello', () => 'hello', {
      title: 'Hi',
      public: true,
    });
    await b.api.commands.register('community.b.own', () => 'own', { title: 'Own' });
    return { a, b };
  }

  it('lets a plugin run its own commands, private or not', async () => {
    const { a, b } = await twoPlugins([]);
    expect(await a.api.commands.execute('community.a.secret')).toBe('secret');
    expect(await b.api.commands.execute('community.b.own')).toBe('own');
  });

  it("refuses another plugin's private command", async () => {
    const { b } = await twoPlugins(['composition.write']);
    expect(await codeOf(b.api.commands.execute('community.a.secret'))).toBe('permission-denied');
  });

  it('runs a public command only with the scopes it requires', async () => {
    const without = await twoPlugins([]);
    expect(await codeOf(without.b.api.commands.execute('community.a/shout'))).toBe(
      'permission-denied',
    );
    expect(await without.b.api.commands.execute('community.a.hello')).toBe('hello');
    const withScope = await twoPlugins(['composition.write']);
    expect(await withScope.b.api.commands.execute('community.a/shout')).toBe('shout');
  });

  it('applies the built-in requirements', async () => {
    const { b } = await twoPlugins([]);
    expect(await codeOf(b.api.commands.execute('composition.insert', { text: 'x' }))).toBe(
      'permission-denied',
    );
    expect(await codeOf(b.api.commands.execute('speech.speak', { text: 'x' }))).toBe(
      'permission-denied',
    );
    expect(await codeOf(b.api.commands.execute('speech.stop'))).toBe('ok');
    expect(await codeOf(b.api.commands.execute('no.such.command'))).toBe('unknown-command');
    expect(b.kernel.composition.text).toBe('');
  });

  it('authorizes before executing, with the plugin as source', async () => {
    const { a, b } = await twoPlugins(['composition.write']);
    const order: string[] = [];
    const authorize = vi.spyOn(a.kernel.commands, 'authorize').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      order.push(`authorize:${args[0]}:${args[1].pluginId}`);
    });
    const execute = vi.spyOn(a.kernel.commands, 'execute');
    execute.mockImplementation((id, _args, source) => {
      order.push(`execute:${id}:${source}`);
      return Promise.resolve(undefined);
    });
    await b.api.composition.insert('x');
    await b.api.commands.execute('community.a/shout');
    expect(order).toEqual([
      'authorize:composition.insert:community.b',
      'execute:composition.insert:community.b',
      'authorize:community.a/shout:community.b',
      'execute:community.a/shout:community.b',
    ]);
    authorize.mockRestore();
    execute.mockRestore();
  });

  it('records the plugin as owner and enforces the id prefix', async () => {
    const { a, b } = await twoPlugins([]);
    const descriptor = (await b.api.commands.list()).find((d) => d.id === 'community.a/shout');
    expect(descriptor).toMatchObject({
      owner: 'community.a',
      public: true,
      requires: ['composition.write'],
    });
    expect(a.kernel.commands.list().find((d) => d.id === 'community.b.own')?.public).toBe(false);
    for (const id of [
      'community.a.steal',
      'composition.insert',
      'community.bx.cmd',
      'community.b',
    ]) {
      expect(await codeOf(b.api.commands.register(id, () => 1, { title: 'x' }))).toBe(
        'permission-denied',
      );
    }
    expect(await codeOf(b.api.commands.register('community.b.own', () => 1, { title: 'x' }))).toBe(
      'duplicate',
    );
    expect(await codeOf(b.api.commands.register('community.b/../x', () => 1, { title: 'x' }))).toBe(
      'invalid-argument',
    );
  });

  it('auto-prefixes register.command and registers it as a contribution too', async () => {
    const { b } = await twoPlugins([]);
    await b.api.register.command({ id: 'wave', title: 'Wave', handler: (args) => args });
    expect(b.kernel.extensions.get('commands', 'community.b/wave')?.owner).toBe('community.b');
    expect(await b.api.commands.execute('community.b/wave', { n: 1 })).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------- provider data filtering

describe('prediction provider filtering', () => {
  const registered = (ctx: TestPluginApi): PredictionProvider => {
    const entry = ctx.kernel.extensions.list('predictionProviders')[0];
    if (!entry) throw new Error('no provider');
    return entry.contribution;
  };

  it('strips conversation and context without history.read and context.read', async () => {
    const ctx = await setup([]);
    const received: PredictionRequest[] = [];
    await ctx.api.register.predictionProvider(provider(received));
    const wrapped = registered(ctx);
    expect(wrapped.id).toBe('community.matrix/pp');
    const result = wrapped.predict(request());
    expect(received[0]).toEqual({
      requestId: 7,
      textBefore: 'hel',
      partialWord: 'hel',
      locale: 'en-GB',
      maxCandidates: 2,
      kinds: ['completions'],
    });
    // The result is validated: ids forced, list capped, scores clamped.
    expect(result).toEqual({
      requestId: 7,
      providerId: 'community.matrix/pp',
      stage: 'instant',
      completions: [
        { text: 'hello', score: 1 },
        { text: 'help', score: 0.5 },
      ],
      nextWords: [],
      letters: { l: 0.7 },
      phrases: [],
    });
  });

  it('passes them with the scopes, as copies', async () => {
    const ctx = await setup(['history.read', 'context.read']);
    const received: PredictionRequest[] = [];
    await ctx.api.register.predictionProvider(provider(received));
    const original = request();
    void registered(ctx).predict(original);
    expect(received[0]?.conversation).toEqual(original.conversation);
    expect(received[0]?.context).toEqual(original.context);
    expect(received[0]?.conversation).not.toBe(original.conversation);
  });

  it('asks for first-use consent of a sensitive install scope when the provider registers', async () => {
    const consent = new ScriptedConsentPrompt(true);
    const ctx = await createTestPluginApi({
      manifest: manifestWith(['history.read']),
      consent,
    });
    await ctx.api.register.predictionProvider(provider());
    expect(consent.requests.at(-1)).toEqual({
      pluginId: 'community.matrix',
      scopes: ['history.read'],
      reason: 'first-use',
    });
    expect(ctx.permissions.has('community.matrix', 'history.read')).toBe(true);
  });

  it('stops passing history as soon as history.read is revoked', async () => {
    const ctx = await setup(['history.read']);
    const received: PredictionRequest[] = [];
    await ctx.api.register.predictionProvider(provider(received));
    await ctx.permissions.revoke('community.matrix', 'history.read');
    void registered(ctx).predict(request());
    expect(received[0]?.conversation).toBeUndefined();
  });

  it('forwards learn and forget only with lm.write', async () => {
    for (const scopes of [[], ['lm.write']] as PermissionScope[][]) {
      const ctx = await setup(scopes);
      const calls: string[] = [];
      await ctx.api.register.predictionProvider({
        ...provider(),
        learn: () => {
          calls.push('learn');
        },
        forget: () => {
          calls.push('forget');
        },
      });
      const wrapped = registered(ctx);
      await wrapped.learn?.({ text: 'hi', origin: 'composition', locale: 'en', createdAt: 1 });
      await wrapped.forget?.({ kind: 'all' });
      expect(calls).toEqual(scopes.length === 0 ? [] : ['learn', 'forget']);
    }
  });

  it('keeps asynchronous providers asynchronous and validates refined results', async () => {
    const ctx = await setup([]);
    await ctx.api.register.predictionProvider({
      id: 'async',
      capabilities: { kinds: ['completions'], usesKeyDistributions: false },
      predict: (r) =>
        Promise.resolve({ ...(provider().predict(r) as PredictionResult), completions: [] }),
      refine: () => Promise.resolve({ completions: [{ text: 42 }] } as never),
    });
    const wrapped = registered(ctx);
    const instant = wrapped.predict(request());
    expect(instant).toBeInstanceOf(Promise);
    expect((await instant).completions).toEqual([]);
    expect(
      await codeOf(
        wrapped.refine?.(request(), {
          cancelled: false,
          onCancel: () => ({ dispose: () => undefined }),
        }) ?? Promise.resolve(),
      ),
    ).toBe('invalid-argument');
  });
});

// ---------------------------------------------------------------- hostile input

describe('argument validation', () => {
  const hostile: [string, (api: ForseeApi) => Promise<unknown>][] = [
    ['a huge insert', (api) => api.composition.insert('x'.repeat(50_000))],
    ['a non-string insert', (api) => api.composition.insert(42 as never)],
    ['an object as text', (api) => api.speech.speak({ toString: () => 'hi' } as never)],
    ['unknown speak options', (api) => api.speech.speak('hi', { volume: 5 })],
    [
      'a recording path escaping the profile',
      (api) => api.speech.speak('hi', { recording: '../x.wav' }),
    ],
    ['a command id with a newline', (api) => api.commands.execute('composition.insert\n')],
    [
      'class instance arguments',
      (api) => api.commands.execute('composition.insert', new Date() as never),
    ],
    [
      'function arguments',
      (api) => api.commands.execute('community.matrix.x', { f: (() => 1) as never }),
    ],
    ['an empty storage key', (api) => api.storage.set('', 1)],
    ['a storage key with control characters', (api) => api.storage.set('a\u0000b', 1)],
    ['a storage value with a function', (api) => api.storage.set('k', { f: (() => 1) as never })],
    ['a storage value with NaN', (api) => api.storage.set('k', Number.NaN)],
    [
      'a cyclic storage value',
      (api) => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        return api.storage.set('k', cyclic as never);
      },
    ],
    ['a storage value over 1 MB', (api) => api.storage.set('k', 'x'.repeat(1_100_000))],
    [
      'a deeply nested value',
      (api) => {
        let value: unknown = 1;
        for (let i = 0; i < 100; i += 1) value = [value];
        return api.storage.set('k', value as never);
      },
    ],
    [
      'a __proto__ key',
      (api) =>
        api.context.set({ key: 'a', value: JSON.parse('{"__proto__": {"polluted": 1}}') as never }),
    ],
    ['a context key with path tricks', (api) => api.context.set({ key: '../etc', value: 1 })],
    ['a negative ttl', (api) => api.context.set({ key: 'a', value: 1, ttlMs: -1 })],
    ['a negative history limit', (api) => api.history.listRecent(-1)],
    ['a fractional history limit', (api) => api.history.listRecent(1.5)],
    ['a setting value of the wrong type', (api) => api.settings.set('a', [] as never)],
    ['an invalid settings schema', (api) => api.settings.registerSchema([{ key: 'a b' } as never])],
    [
      'a theme id with a path trick',
      (api) => api.register.theme({ id: '../../evil', name: 'E', colorScheme: 'dark', tokens: {} }),
    ],
    [
      "a theme id in another plugin's namespace",
      (api) =>
        api.register.theme({ id: 'community.other/t', name: 'E', colorScheme: 'dark', tokens: {} }),
    ],
    [
      'a theme colour that fetches',
      (api) =>
        api.register.theme({
          id: 't',
          name: 'T',
          colorScheme: 'dark',
          tokens: { text: 'url(https://evil.example/x)' },
        }),
    ],
    [
      'an invalid layout',
      (api) => api.register.layout({ ...testLayout('l'), initialPage: 'missing' }),
    ],
    [
      'a provider without predict',
      (api) =>
        api.register.predictionProvider({
          id: 'x',
          capabilities: { kinds: [], usesKeyDistributions: false },
        } as never),
    ],
    [
      'a provider with unknown kinds',
      (api) =>
        api.register.predictionProvider({
          ...provider(),
          capabilities: { kinds: ['minds'], usesKeyDistributions: false },
        } as never),
    ],
    [
      'a driver outside the plugin folder',
      (api) =>
        api.register.gazeSource({
          id: 'g',
          name: 'G',
          kind: 'driver',
          executable: { linux: '/usr/bin/evil' },
        }),
    ],
    [
      'a panel rect with NaN',
      (api) =>
        api.panels.setTargets('p', [
          { id: 't', rect: { x: Number.NaN, y: 0, width: 1, height: 1 }, dwellClass: 'letter' },
        ]),
    ],
    [
      'duplicate panel target ids',
      (api) =>
        api.panels.setTargets('p', [
          { id: 't', rect: { x: 0, y: 0, width: 1, height: 1 }, dwellClass: 'letter' },
          { id: 't', rect: { x: 0, y: 0, width: 1, height: 1 }, dwellClass: 'letter' },
        ]),
    ],
    [
      'too many panel targets',
      (api) =>
        api.panels.setTargets(
          'p',
          Array.from({ length: 501 }, (_, i) => ({
            id: `t${i}`,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            dwellClass: 'letter' as const,
          })),
        ),
    ],
    [
      'an inference prompt of the wrong type',
      (api) => inferenceOf(api).scoreNextTokens({ handleId: 'h', prompt: 1 as never, topK: 1 }),
    ],
    [
      'a hostile proxy',
      (api) =>
        api.storage.set(
          'k',
          new Proxy(
            {},
            {
              ownKeys: () => {
                throw new Error('gotcha');
              },
            },
          ),
        ),
    ],
  ];

  it.each(hostile)('rejects %s with invalid-argument', async (_name, call) => {
    const ctx = await setup(ALL_SCOPES);
    await ctx.api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: '' }]);
    expect(await codeOf(call(ctx.api))).toBe('invalid-argument');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ctx.kernel.composition.text).toBe('');
  });

  it('rejects panel targets for undeclared panels and inference on foreign handles', async () => {
    const ctx = await setup(ALL_SCOPES);
    expect(await codeOf(ctx.api.panels.setTargets('other', []))).toBe('not-found');
    expect(
      await codeOf(inferenceOf(ctx.api).scoreNextTokens({ handleId: 'h99', prompt: 'a', topK: 1 })),
    ).toBe('not-found');
  });

  it('only lets first-party plugins register in-process gaze sources', async () => {
    const source = {
      id: 'g',
      name: 'G',
      kind: 'in-process' as const,
      source: {
        id: 'g',
        kind: 'gaze',
        capabilities: { calibrate: false, hover: true },
        start: () => undefined,
        stop: () => undefined,
      } as never,
    };
    const community = await setup(ALL_SCOPES);
    expect(await codeOf(community.api.register.gazeSource(source))).toBe('permission-denied');
    const firstParty = await setup(ALL_SCOPES, { origin: 'first-party' });
    expect(await codeOf(firstParty.api.register.gazeSource(source))).toBe('ok');
  });

  it('returns structured-clone-safe copies', async () => {
    const ctx = await setup(ALL_SCOPES);
    await ctx.api.composition.insert('hi');
    await ctx.api.context.set({ key: 'a.b', value: { n: [1, 2] } });
    const state = await ctx.api.composition.getState();
    const entries = await ctx.api.context.list();
    const commands = await ctx.api.commands.list();
    for (const value of [state, entries, commands]) {
      expect(structuredClone(value)).toEqual(value);
    }
    (entries[0]?.value as { n: number[] }).n.push(3);
    expect(ctx.kernel.context.get('a.b')?.value).toEqual({ n: [1, 2] });
  });

  it('tags context writes with the plugin and deletes only its own entries', async () => {
    const ctx = await setup(ALL_SCOPES);
    await ctx.api.context.set({ key: 'mine', value: 1, source: 'app' } as never);
    expect(ctx.kernel.context.get('mine')?.source).toBe('community.matrix');
    ctx.kernel.context.set('app', { key: 'theirs', value: 2 });
    await ctx.api.context.delete('theirs');
    expect(ctx.kernel.context.get('theirs')?.value).toBe(2);
    await ctx.api.context.delete('mine');
    expect(ctx.kernel.context.get('mine')).toBeUndefined();
  });

  it('uses the plugin id as settings namespace, and settings.registerSchema replaces', async () => {
    const ctx = await setup([]);
    await ctx.api.settings.registerSchema([{ key: 'a', label: 'A', type: 'number', default: 1 }]);
    await ctx.api.settings.set('a', 5);
    expect(ctx.kernel.settings.get('community.matrix', 'a')).toBe(5);
    expect(await codeOf(ctx.api.settings.set('a', 'five'))).toBe('invalid-argument');
    await ctx.api.settings.registerSchema([
      { key: 'a', label: 'A', type: 'number', default: 1 },
      { key: 'b', label: 'B', type: 'boolean', default: true },
    ]);
    expect(await ctx.api.settings.getAll()).toEqual({ a: 5, b: true });
    expect(await codeOf(ctx.api.settings.get('missing'))).toBe('not-found');
    expect(
      ctx.kernel.extensions.get('settings', 'community.matrix')?.contribution.fields,
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- revocation and deactivation

describe('revocation', () => {
  it('disposes registrations and subscriptions that depend on the revoked scope', async () => {
    const ctx = await setup(ALL_SCOPES);
    const seen: string[] = [];
    await ctx.api.events.on('composition.changed', (c) => seen.push(c.state.text));
    await ctx.api.register.textTransform({
      id: 'upper',
      name: 'Upper',
      triggers: ['commit'],
      transform: ({ text }) => text.toUpperCase(),
    });
    await inferenceOf(ctx.api).loadModel('m');
    await ctx.kernel.commands.execute('composition.insert', { text: 'a' });
    await ctx.permissions.revoke('community.matrix', 'composition.read');
    await ctx.kernel.commands.execute('composition.insert', { text: 'b' });
    expect(seen).toEqual(['a']);
    expect(ctx.kernel.extensions.list('textTransforms')).toHaveLength(1);
    await ctx.permissions.revoke('community.matrix', 'composition.write');
    expect(ctx.kernel.extensions.list('textTransforms')).toHaveLength(0);
    expect(await codeOf(ctx.api.composition.insert('c'))).toBe('permission-denied');
    expect(ctx.inference.loaded.size).toBe(1);
    await ctx.permissions.revoke('community.matrix', 'inference');
    expect(ctx.inference.loaded.size).toBe(0);
  });
});

describe('deactivation', () => {
  it('disposes everything the plugin registered and rejects later calls', async () => {
    const samples = new Set<() => void>();
    const ctx = await setup(ALL_SCOPES, {
      services: {
        gazeSamples: (listener) => {
          const entry = (): void => listener({ x: 0, y: 0, t: 0, confidence: 1, valid: true });
          samples.add(entry);
          return { dispose: () => samples.delete(entry) };
        },
      },
    });
    const { api, kernel, session, panels } = ctx;
    const seen: string[] = [];
    await api.commands.register('community.matrix.go', () => 1, { title: 'Go' });
    await api.register.command({ id: 'cmd', title: 'Cmd', handler: () => 1 });
    await api.register.predictionProvider(provider());
    await api.register.layout(testLayout('compact'));
    await api.register.contextProvider({ id: 'cp', name: 'CP', provides: ['a'] });
    await api.events.on('composition.changed', () => seen.push('composition'));
    await api.events.on('gaze.sample', () => seen.push('gaze'));
    await api.context.set({ key: 'a', value: 1 });
    await api.settings.registerSchema([{ key: 'a', label: 'A', type: 'string', default: '' }]);
    await api.panels.setTargets('p', [
      { id: 't', rect: { x: 0, y: 0, width: 1, height: 1 }, dwellClass: 'letter' },
    ]);
    await api.panels.onActivate(() => seen.push('panel'));
    await inferenceOf(api).loadModel('m');
    expect(kernel.extensions.listByOwner('community.matrix').length).toBeGreaterThan(3);
    expect(samples.size).toBe(1);

    session.dispose();
    expect(session.disposed).toBe(true);
    expect(kernel.commands.has('community.matrix.go')).toBe(false);
    expect(kernel.commands.has('community.matrix/cmd')).toBe(false);
    expect(kernel.extensions.listByOwner('community.matrix')).toEqual([]);
    expect(kernel.context.get('a')).toBeUndefined();
    expect(kernel.settings.hasSchema('community.matrix')).toBe(false);
    expect(panels.get('community.matrix/p')).toEqual([]);
    expect(samples.size).toBe(0);
    expect(ctx.inference.loaded.size).toBe(0);
    await kernel.commands.execute('composition.insert', { text: 'a' });
    expect(panels.activate('community.matrix/p', 't', 0)).toBe(false);
    expect(seen).toEqual([]);

    for (const [method, { call }] of Object.entries(MATRIX)) {
      expect([method, await codeOf(call(api))]).toEqual([method, 'disposed']);
    }
  });

  it('disposes a registration that completes after deactivation', async () => {
    const consent = new ScriptedConsentPrompt(true);
    let answer: (granted: boolean) => void = () => undefined;
    const ctx = await createTestPluginApi({
      manifest: manifestWith([], { optionalPermissions: ['composition.read'] }),
      consent,
    });
    consent.setAnswer(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const pending = ctx.api.events.on('composition.changed', () => undefined);
    await Promise.resolve();
    ctx.session.dispose();
    answer(true);
    expect(await codeOf(pending)).toBe('disposed');
    expect(ctx.kernel.bus.listenerCount('composition.changed')).toBe(0);
  });

  it('lets the plugin dispose its own registrations', async () => {
    const ctx = await setup([]);
    const registration = await ctx.api.register.layout(testLayout('l'));
    registration.dispose();
    registration.dispose();
    expect(ctx.kernel.extensions.list('layouts')).toEqual([]);
  });
});

describe('panels', () => {
  it('keeps rectangles panel-relative and delivers activations to the owner', async () => {
    const ctx = await setup([]);
    const activations: unknown[] = [];
    await ctx.api.panels.onActivate((a) => activations.push(a));
    const changes: string[] = [];
    ctx.panels.onDidChange((id) => changes.push(id));
    await ctx.api.panels.setTargets('p', [
      {
        id: 'yes',
        rect: { x: 5, y: 6, width: 50, height: 40 },
        dwellClass: 'function',
        label: 'Yes',
      },
      {
        id: 'off',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dwellClass: 'letter',
        disabled: true,
      },
    ]);
    expect(changes).toEqual(['community.matrix/p']);
    expect(ctx.panels.get('community.matrix/p')[0]?.rect).toEqual({
      x: 5,
      y: 6,
      width: 50,
      height: 40,
    });
    expect(ctx.panels.list()).toHaveLength(1);
    expect(ctx.panels.activate('community.matrix/p', 'yes', 2)).toBe(true);
    expect(ctx.panels.activate('community.matrix/p', 'off', 0)).toBe(false);
    expect(ctx.panels.activate('community.matrix/p', 'nope', 0)).toBe(false);
    expect(activations).toEqual([{ panelId: 'p', targetId: 'yes', repeatIndex: 2 }]);
  });
});
