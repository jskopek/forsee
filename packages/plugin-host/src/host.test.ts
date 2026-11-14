import {
  createKernel,
  FakeClock,
  SequentialIdSource,
  toDisposable,
  type Kernel,
  type SpeechService,
} from '@forsee/core';
import { createMemoryHost, type MemoryHost } from '@forsee/host';
import type {
  ForseeApi,
  ForseeErrorData,
  PluginManifest,
  PluginModule,
  PredictionResult,
} from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import type {
  FirstPartyPlugin,
  InstalledPlugin,
  PluginFiles,
  PluginRuntime,
  PluginRuntimeInstance,
  PluginState,
} from './contracts';
import {
  BLOCK_REASONS,
  createPluginHost,
  MemoryInstallStorage,
  type PluginHostInstance,
} from './host';
import { MemoryConsentStorage } from './permissions';
import {
  MemoryPluginFiles,
  ScriptedConsentPrompt,
  testLayout,
  testLayoutValidator,
  testManifest,
} from './testing';

// ---------------------------------------------------------------- fixtures

interface Fixture {
  readonly kernel: Kernel;
  readonly clock: FakeClock;
  readonly host: MemoryHost;
  readonly plugins: PluginHostInstance;
  readonly consent: ScriptedConsentPrompt;
  readonly spoken: string[];
  readonly errors: { error: unknown; context: string }[];
  readonly consentStorage: MemoryConsentStorage;
  readonly installStorage: MemoryInstallStorage;
}

interface FixtureOptions {
  readonly firstParty?: readonly FirstPartyPlugin[];
  readonly runtime?: PluginRuntime;
  readonly developerMode?: boolean;
  readonly consent?: ScriptedConsentPrompt;
  readonly host?: MemoryHost;
  readonly consentStorage?: MemoryConsentStorage;
  readonly installStorage?: MemoryInstallStorage;
  readonly appVersion?: string;
  readonly start?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const clock = new FakeClock();
  const errors: { error: unknown; context: string }[] = [];
  const reportError = (error: unknown, context: string): void => {
    errors.push({ error, context });
  };
  const spoken: string[] = [];
  const speech: SpeechService = {
    speak: (text) => {
      spoken.push(text);
      return Promise.resolve('completed');
    },
    stop: () => undefined,
  };
  const host =
    options.host ??
    createMemoryHost({
      clock,
      platform: { appVersion: options.appVersion ?? '1.0.0', shell: 'web' },
    });
  const kernel = createKernel({
    clock,
    ids: new SequentialIdSource(),
    deviceId: 'device',
    speech,
    reportError,
  });
  await kernel.start();
  const consent = options.consent ?? new ScriptedConsentPrompt(true);
  const consentStorage = options.consentStorage ?? new MemoryConsentStorage();
  const installStorage = options.installStorage ?? new MemoryInstallStorage();
  const plugins = createPluginHost({
    kernel,
    host,
    firstParty: options.firstParty ?? [],
    validateLayout: testLayoutValidator,
    consent,
    consentStorage,
    installStorage,
    reportError,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.developerMode === undefined ? {} : { developerMode: options.developerMode }),
  });
  if (options.start !== false) await plugins.start();
  return { kernel, clock, host, plugins, consent, spoken, errors, consentStorage, installStorage };
}

async function writePlugin(
  host: MemoryHost,
  manifest: PluginManifest | Record<string, unknown>,
  files: Readonly<Record<string, unknown>> = {},
  folder = `plugins/${String(manifest.id)}`,
): Promise<string> {
  await host.files.writeText(`${folder}/manifest.json`, JSON.stringify(manifest));
  for (const [path, value] of Object.entries(files)) {
    await host.files.writeText(
      `${folder}/${path}`,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  return folder;
}

const THEME = {
  id: 'contrast',
  name: 'High contrast',
  colorScheme: 'dark',
  tokens: { text: '#ffffff' },
};
const PHRASES = {
  schemaVersion: 1,
  id: 'greetings',
  name: 'Greetings',
  locale: 'en-GB',
  categories: [{ id: 'hi', name: 'Hi', phrases: [{ id: 'hello', text: 'Hello!' }] }],
};
const VOCABULARY = {
  schemaVersion: 1,
  id: 'names',
  name: 'Names',
  locale: 'en-GB',
  entries: [{ text: 'Siobhan', weight: 3 }],
};

const declarativeManifest = (id = 'community.phrases'): PluginManifest =>
  testManifest({
    id,
    contributes: {
      layouts: ['layouts/compact.json'],
      themes: ['themes/contrast.json'],
      phraseSets: ['phrases/greetings.json'],
      vocabularies: ['vocabularies/names.json'],
      settings: [
        {
          key: 'tone',
          label: 'Tone',
          type: 'select',
          default: 'casual',
          options: ['casual', 'formal'],
        },
      ],
    },
  });

const declarativeFiles = {
  'layouts/compact.json': testLayout('compact'),
  'themes/contrast.json': THEME,
  'phrases/greetings.json': PHRASES,
  'vocabularies/names.json': VOCABULARY,
};

/** A runtime double standing in for B10's sandbox. */
class FakeRuntime implements PluginRuntime {
  readonly name = 'fake';
  readonly loaded: string[] = [];
  readonly instances = new Map<
    string,
    { crash(error: ForseeErrorData): void; terminated: boolean }
  >();

  constructor(private readonly modules: Readonly<Record<string, PluginModule>>) {}

  supports(plugin: InstalledPlugin): true | string {
    return plugin.manifest.id.endsWith('unsupported') ? 'Not on this device.' : true;
  }

  async load(plugin: InstalledPlugin, files: PluginFiles): Promise<PluginRuntimeInstance> {
    const main = plugin.manifest.main;
    if (main !== undefined) this.loaded.push(await files.readText(main));
    const module = this.modules[plugin.manifest.id];
    if (!module) throw new Error('no module');
    const crashListeners = new Set<(error: ForseeErrorData) => void>();
    const record = {
      terminated: false,
      crash: (error: ForseeErrorData) => {
        for (const listener of crashListeners) listener(error);
      },
    };
    this.instances.set(plugin.manifest.id, record);
    return {
      activate: async (api) => module.activate(api),
      deactivate: async () => module.deactivate?.(),
      terminate: () => {
        record.terminated = true;
      },
      health: () => ({ status: record.terminated ? 'terminated' : 'ok' }),
      onDidCrash: (listener) => {
        crashListeners.add(listener);
        return toDisposable(() => crashListeners.delete(listener));
      },
    };
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

const stateOf = (f: Fixture, id: string): PluginState | undefined => f.plugins.get(id)?.state;

// ---------------------------------------------------------------- first-party end to end

describe('first-party plugins', () => {
  it('activate end to end on a real kernel through the same API', async () => {
    let api: ForseeApi | undefined;
    const module: PluginModule = {
      async activate(forsee) {
        api = forsee;
        await forsee.commands.register('forsee.demo.greet', () => 'greeted', { title: 'Greet' });
        await forsee.register.predictionProvider({
          id: 'words',
          capabilities: { kinds: ['completions'], usesKeyDistributions: false },
          predict: (request): PredictionResult => ({
            requestId: request.requestId,
            providerId: 'words',
            stage: 'instant',
            completions: [{ text: `${request.partialWord}lo`, score: 0.9 }],
            nextWords: [],
            letters: {},
            phrases: [],
          }),
        });
        await forsee.composition.insert('hel');
      },
    };
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({
            id: 'forsee.demo',
            permissions: ['composition.read', 'composition.write', 'speech.output', 'history.read'],
          }),
          module,
        },
      ],
    });
    expect(stateOf(f, 'forsee.demo')).toBe('active');
    expect(f.consent.requests).toEqual([]);
    if (!api) throw new Error('not activated');

    expect(await f.kernel.commands.execute('forsee.demo.greet')).toBe('greeted');
    const provider = f.kernel.extensions.get('predictionProviders', 'forsee.demo/words');
    expect(provider?.owner).toBe('forsee.demo');
    const prediction = provider?.contribution.predict({
      requestId: 1,
      textBefore: f.kernel.composition.text,
      partialWord: f.kernel.composition.partialWord,
      locale: 'en-GB',
      maxCandidates: 3,
      kinds: ['completions'],
    }) as PredictionResult;
    expect(prediction.completions).toEqual([{ text: 'hello', score: 0.9 }]);

    await api.composition.acceptPrediction('hello');
    await api.composition.insert('world');
    expect((await api.composition.getState()).text).toBe('hello world');
    await api.speech.speak((await api.composition.getState()).text);
    expect(f.spoken).toEqual(['hello world']);
    expect((await api.history.listRecent(1)).map((u) => u.body)).toEqual(['hello world']);
    // Nothing beyond the manifest: no optional or undeclared scope.
    expect(await api.permissions.has('camera')).toBe(false);
    expect(f.errors).toEqual([]);

    await f.plugins.disable('forsee.demo');
    expect(f.kernel.commands.has('forsee.demo.greet')).toBe(false);
    expect(f.kernel.extensions.listByOwner('forsee.demo')).toEqual([]);
    await expect(api.composition.insert('x')).rejects.toMatchObject({ code: 'disposed' });
  });

  it('go through the lifecycle states, with change events', async () => {
    const deactivations: string[] = [];
    const f = await fixture({
      start: false,
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.states' }),
          module: { activate: () => undefined, deactivate: () => void deactivations.push('bye') },
        },
      ],
    });
    const states: (PluginState | undefined)[] = [];
    f.plugins.onDidChange((id) => {
      if (id === 'forsee.states') states.push(stateOf(f, id));
    });
    await f.plugins.start();
    await f.plugins.disable('forsee.states');
    await f.plugins.enable('forsee.states');
    expect(states).toEqual([
      'loading',
      'active',
      'deactivating',
      'disabled',
      'inactive',
      'loading',
      'active',
    ]);
    expect(deactivations).toEqual(['bye']);
    expect(f.installStorage.records).toEqual([
      expect.objectContaining({ id: 'forsee.states', origin: 'first-party', enabled: true }),
    ]);
  });

  it('isolate a plugin that throws in activate and undo what it registered', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.broken', permissions: ['composition.read'] }),
          module: {
            async activate(api) {
              await api.commands.register('forsee.broken.half', () => 1, { title: 'Half' });
              await api.events.on('composition.changed', () => undefined);
              throw new Error('boom');
            },
          },
        },
        { manifest: testManifest({ id: 'forsee.fine' }), module: { activate: () => undefined } },
      ],
    });
    expect(f.plugins.get('forsee.broken')).toMatchObject({
      state: 'failed',
      reason: 'It failed to start: boom',
    });
    expect(stateOf(f, 'forsee.fine')).toBe('active');
    expect(f.kernel.commands.has('forsee.broken.half')).toBe(false);
    expect(f.kernel.bus.listenerCount('composition.changed')).toBe(0);
    expect(f.errors.map((e) => e.context)).toEqual(['plugin:forsee.broken:activate']);
    // The app keeps working.
    await f.kernel.commands.execute('composition.insert', { text: 'ok' });
    expect(f.kernel.composition.text).toBe('ok');
  });

  it('isolate a plugin that throws in deactivate', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.grumpy' }),
          module: {
            async activate(api) {
              await api.commands.register('forsee.grumpy.x', () => 1, { title: 'X' });
            },
            deactivate: () => {
              throw new Error('will not go');
            },
          },
        },
      ],
    });
    await f.plugins.disable('forsee.grumpy');
    expect(stateOf(f, 'forsee.grumpy')).toBe('disabled');
    expect(f.kernel.commands.has('forsee.grumpy.x')).toBe(false);
    expect(f.errors.map((e) => e.context)).toEqual(['plugin:forsee.grumpy:deactivate']);
  });

  it('time out an activate that never finishes', async () => {
    const f = await fixture({
      start: false,
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.slow' }),
          module: { activate: () => new Promise<void>(() => undefined) },
        },
      ],
    });
    const started = f.plugins.start();
    await flush();
    expect(stateOf(f, 'forsee.slow')).toBe('loading');
    f.clock.advance(10_000);
    await started;
    expect(f.plugins.get('forsee.slow')?.reason).toContain('did not finish within 10000 ms');
  });

  it('fail with issues when the first-party manifest is invalid', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: { ...testManifest({ id: 'forsee.bad' }), version: 'one' },
          module: { activate: () => undefined },
        },
      ],
    });
    expect(f.plugins.get('forsee.bad')).toMatchObject({
      state: 'failed',
      issues: [{ path: '/version', message: 'Expected a semantic version (MAJOR.MINOR.PATCH)' }],
    });
  });

  it('remember a disabled first-party plugin across restarts', async () => {
    const installStorage = new MemoryInstallStorage();
    const plugin: FirstPartyPlugin = {
      manifest: testManifest({ id: 'forsee.optional' }),
      module: { activate: () => undefined },
    };
    const first = await fixture({ firstParty: [plugin], installStorage });
    await first.plugins.disable('forsee.optional');
    const second = await fixture({ firstParty: [plugin], installStorage });
    expect(stateOf(second, 'forsee.optional')).toBe('disabled');
  });

  it('keep a required first-party plugin on: disable rejects, and a stored "off" is ignored', async () => {
    const installStorage = new MemoryInstallStorage([
      {
        schemaVersion: 1,
        id: 'forsee.needed',
        origin: 'first-party',
        folder: '',
        enabled: false,
        installedAt: 0,
      },
    ]);
    const plugin: FirstPartyPlugin = {
      manifest: testManifest({ id: 'forsee.needed' }),
      module: { activate: () => undefined },
      required: true,
    };
    const f = await fixture({ firstParty: [plugin], installStorage });
    expect(f.plugins.get('forsee.needed')).toMatchObject({
      state: 'active',
      enabled: true,
      required: true,
    });
    await expect(f.plugins.disable('forsee.needed')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(stateOf(f, 'forsee.needed')).toBe('active');
  });

  it('load bundled declarative contributions', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.themes', contributes: { themes: ['dark.json'] } }),
          module: { activate: () => undefined },
          files: new MemoryPluginFiles({ 'dark.json': THEME }),
        },
      ],
    });
    expect(f.kernel.extensions.get('themes', 'forsee.themes/contrast')?.owner).toBe(
      'forsee.themes',
    );
  });
});

// ---------------------------------------------------------------- declarative plugins

describe('declarative plugins', () => {
  it('load every contributed file under the plugin id', async () => {
    const f = await fixture({ start: false });
    const folder = await writePlugin(f.host, declarativeManifest(), declarativeFiles);
    await f.plugins.start();
    const status = await f.plugins.install({ folder, origin: 'directory', sha256: 'a'.repeat(64) });
    expect(status).toMatchObject({ state: 'active', tier: 'declarative', sha256: 'a'.repeat(64) });
    const owned = f.kernel.extensions
      .listByOwner('community.phrases')
      .map((c) => `${c.point}:${c.id}`);
    expect(owned.sort()).toEqual(
      [
        'layouts:community.phrases/compact',
        'phraseSets:community.phrases/greetings',
        'settings:community.phrases',
        'themes:community.phrases/contrast',
        'vocabularies:community.phrases/names',
      ].sort(),
    );
    expect(f.kernel.settings.get('community.phrases', 'tone')).toBe('casual');
    await f.plugins.disable('community.phrases');
    expect(f.kernel.extensions.listByOwner('community.phrases')).toEqual([]);
    expect(f.kernel.settings.hasSchema('community.phrases')).toBe(false);
  });

  it('reject the whole plugin when one file is invalid, listing every issue', async () => {
    const f = await fixture();
    const folder = await writePlugin(f.host, declarativeManifest(), {
      ...declarativeFiles,
      'themes/contrast.json': { ...THEME, tokens: { text: 'url(https://evil.example)' } },
      'vocabularies/names.json': '{ not json',
    });
    const status = await f.plugins.install({ folder, origin: 'directory' });
    expect(status.state).toBe('failed');
    expect(status.issues?.map((i) => i.path)).toEqual([
      '/contributes/themes/0/tokens/text',
      '/contributes/vocabularies/0',
    ]);
    expect(status.issues?.[0]?.message).toContain('themes/contrast.json');
    expect(f.kernel.extensions.listByOwner('community.phrases')).toEqual([]);
    expect(f.kernel.settings.hasSchema('community.phrases')).toBe(false);
  });

  it('reject a plugin with a missing file or a clashing id', async () => {
    const f = await fixture();
    const files = { ...declarativeFiles } as Record<string, unknown>;
    delete files['phrases/greetings.json'];
    const missing = await f.plugins.install({
      folder: await writePlugin(f.host, declarativeManifest(), files),
      origin: 'directory',
    });
    expect(missing.state).toBe('failed');
    expect(missing.issues?.[0]?.path).toBe('/contributes/phraseSets/0');

    f.kernel.extensions.register('themes', 'app', {
      ...THEME,
      id: 'community.clash/contrast',
    } as never);
    const clash = await f.plugins.install({
      folder: await writePlugin(f.host, declarativeManifest('community.clash'), declarativeFiles),
      origin: 'directory',
    });
    expect(clash.state).toBe('failed');
    expect(f.kernel.extensions.listByOwner('community.clash')).toEqual([]);
  });

  it('still load in restricted mode', async () => {
    const f = await fixture();
    expect(f.plugins.restrictedMode).toBe(true);
    const status = await f.plugins.install({
      folder: await writePlugin(f.host, declarativeManifest(), declarativeFiles),
      origin: 'directory',
    });
    expect(status.state).toBe('active');
  });
});

// ---------------------------------------------------------------- install, consent, compatibility

describe('installing', () => {
  it('validates, checks compatibility, asks for consent and records the install', async () => {
    const f = await fixture();
    const manifest = testManifest({ id: 'community.words', permissions: ['context.read'] });
    const status = await f.plugins.install({
      folder: await writePlugin(f.host, manifest),
      origin: 'directory',
    });
    expect(status.state).toBe('active');
    expect(f.consent.requests).toEqual([
      { pluginId: 'community.words', scopes: ['context.read'], reason: 'install' },
    ]);
    expect(f.installStorage.records).toEqual([
      {
        schemaVersion: 1,
        id: 'community.words',
        origin: 'directory',
        folder: 'plugins/community.words',
        enabled: true,
        installedAt: f.clock.wallNow(),
      },
    ]);
  });

  it('refuses invalid manifests with every issue', async () => {
    const f = await fixture();
    const folder = await writePlugin(f.host, { id: 'community.bad', version: '1' });
    const error = await f.plugins.install({ folder, origin: 'directory' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid-argument' });
    expect((error as { details: unknown[] }).details.length).toBeGreaterThan(3);
    expect(f.plugins.list()).toEqual([]);
  });

  it.each([
    [
      'a folder that does not match the id',
      { folder: 'plugins/community.other' },
      'invalid-argument',
    ],
    ['a folder outside plugins/', { folder: '../plugins/community.x' }, 'invalid-argument'],
    ['first-party origin', { origin: 'first-party' }, 'invalid-argument'],
    ['a malformed hash', { sha256: 'abc' }, 'invalid-argument'],
  ])('refuses %s', async (_name, patch, code) => {
    const f = await fixture();
    const folder = await writePlugin(f.host, testManifest({ id: 'community.x' }));
    await writePlugin(f.host, testManifest({ id: 'community.x' }), {}, 'plugins/community.other');
    await expect(
      f.plugins.install({ folder, origin: 'directory', ...patch } as never),
    ).rejects.toMatchObject({ code });
  });

  it('refuses a duplicate, a forsee id and an incompatible plugin', async () => {
    const f = await fixture({ appVersion: '1.0.0' });
    const folder = await writePlugin(f.host, testManifest({ id: 'community.x' }));
    await f.plugins.install({ folder, origin: 'directory' });
    await expect(f.plugins.install({ folder, origin: 'directory' })).rejects.toMatchObject({
      code: 'duplicate',
    });
    const forsee = await writePlugin(f.host, testManifest({ id: 'forsee.fake' }));
    await expect(f.plugins.install({ folder: forsee, origin: 'directory' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const future = await writePlugin(
      f.host,
      testManifest({ id: 'community.future', minAppVersion: '2.0.0' }),
    );
    await expect(f.plugins.install({ folder: future, origin: 'directory' })).rejects.toMatchObject({
      code: 'unavailable',
      message: 'It needs Forsee 2.0.0 or later; this is 1.0.0. Update the app to use it.',
    });
    const desktop = await writePlugin(
      f.host,
      testManifest({ id: 'community.desk', platforms: ['desktop'] }),
    );
    await expect(f.plugins.install({ folder: desktop, origin: 'directory' })).rejects.toMatchObject(
      {
        code: 'unavailable',
        message: 'It runs only on desktop, not on web.',
      },
    );
  });

  it('does not install when consent is refused', async () => {
    const f = await fixture({ consent: new ScriptedConsentPrompt(false) });
    const folder = await writePlugin(
      f.host,
      testManifest({ id: 'community.x', permissions: ['camera'] }),
    );
    await expect(f.plugins.install({ folder, origin: 'directory' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(f.plugins.list()).toEqual([]);
    expect(f.consentStorage.records).toEqual([
      expect.objectContaining({
        pluginId: 'community.x',
        scope: 'camera',
        granted: false,
        reason: 'install',
      }),
    ]);
  });

  it('restores installs and consent after a restart without prompting', async () => {
    const consentStorage = new MemoryConsentStorage();
    const installStorage = new MemoryInstallStorage();
    const first = await fixture({ consentStorage, installStorage });
    const manifest = testManifest({ id: 'community.words', permissions: ['context.read'] });
    await first.plugins.install({
      folder: await writePlugin(first.host, manifest),
      origin: 'directory',
    });
    await first.plugins.permissions.flush();
    const consent = new ScriptedConsentPrompt(false);
    const second = await fixture({ host: first.host, consent, consentStorage, installStorage });
    expect(stateOf(second, 'community.words')).toBe('active');
    expect(consent.requests).toEqual([]);
    expect(second.plugins.permissions.has('community.words', 'context.read')).toBe(true);
  });

  it('marks a plugin whose manifest changed on disk as failed', async () => {
    const installStorage = new MemoryInstallStorage();
    const first = await fixture({ installStorage });
    const folder = await writePlugin(first.host, testManifest({ id: 'community.x' }));
    await first.plugins.install({ folder, origin: 'directory' });
    await writePlugin(first.host, testManifest({ id: 'community.y' }), {}, folder);
    const second = await fixture({ host: first.host, installStorage });
    expect(second.plugins.get('community.x')).toMatchObject({ state: 'failed' });
    expect(second.plugins.get('community.x')?.reason).toContain('does not match');
  });

  it('uninstalls a community plugin and forgets its consent', async () => {
    const f = await fixture();
    const folder = await writePlugin(
      f.host,
      testManifest({ id: 'community.x', permissions: ['context.read'] }),
      declarativeFiles,
    );
    await f.plugins.install({ folder, origin: 'directory' });
    await f.plugins.uninstall('community.x');
    expect(f.plugins.list()).toEqual([]);
    expect(f.plugins.permissions.records('community.x')).toEqual([]);
    expect(f.installStorage.records).toEqual([]);
    await expect(f.plugins.uninstall('community.x')).rejects.toMatchObject({ code: 'not-found' });
  });
});

// ---------------------------------------------------------------- restricted mode and runtimes

describe('restricted mode', () => {
  const logicManifest = (id = 'community.logic'): PluginManifest =>
    testManifest({ id, main: 'main.js', permissions: ['composition.write'] });

  const logicModule: PluginModule = {
    async activate(api) {
      await api.commands.register('community.logic.hello', () => 'hi', { title: 'Hello' });
      await api.composition.insert('from plugin');
    },
  };

  async function withLogicPlugin(options: FixtureOptions = {}) {
    const runtime = new FakeRuntime({ 'community.logic': logicModule });
    const f = await fixture({ runtime, ...options });
    const folder = await writePlugin(f.host, logicManifest(), {
      'main.js': 'export function activate() {}',
    });
    const status = await f.plugins.install({ folder, origin: 'directory' });
    return { f, runtime, status };
  }

  it('blocks community code plugins with the reason while on (the default)', async () => {
    const { f, runtime, status } = await withLogicPlugin();
    expect(status).toMatchObject({
      state: 'blocked',
      reason: BLOCK_REASONS.restricted,
      tier: 'logic',
    });
    expect(runtime.loaded).toEqual([]);
    expect(f.kernel.composition.text).toBe('');
    expect(f.kernel.settings.get('app.plugins', 'restrictedMode')).toBe(true);
  });

  it('runs them in the runtime once turned off, and stops them when turned back on', async () => {
    const { f, runtime } = await withLogicPlugin();
    await f.plugins.setRestrictedMode(false);
    expect(f.plugins.restrictedMode).toBe(false);
    expect(stateOf(f, 'community.logic')).toBe('active');
    expect(runtime.loaded).toEqual(['export function activate() {}']);
    expect(f.kernel.composition.text).toBe('from plugin');
    expect(await f.kernel.commands.execute('community.logic.hello')).toBe('hi');

    await f.plugins.setRestrictedMode(true);
    expect(f.plugins.get('community.logic')).toMatchObject({
      state: 'blocked',
      reason: BLOCK_REASONS.restricted,
    });
    expect(f.kernel.commands.has('community.logic.hello')).toBe(false);
    expect(runtime.instances.get('community.logic')?.terminated).toBe(true);
  });

  it('follows the setting when changed from the settings screen', async () => {
    const { f } = await withLogicPlugin();
    f.kernel.settings.set('app.plugins', 'restrictedMode', false);
    await f.plugins.idle();
    expect(stateOf(f, 'community.logic')).toBe('active');
  });

  it('never blocks first-party code', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.code', main: 'main.js' }),
          module: { activate: () => undefined },
        },
      ],
    });
    expect(stateOf(f, 'forsee.code')).toBe('active');
  });

  it('blocks code plugins without a runtime, with a clear reason', async () => {
    const f = await fixture();
    await f.plugins.setRestrictedMode(false);
    const folder = await writePlugin(f.host, logicManifest());
    const status = await f.plugins.install({ folder, origin: 'directory' });
    expect(status).toMatchObject({ state: 'blocked', reason: BLOCK_REASONS.noRuntime });
    const panel = await writePlugin(
      f.host,
      testManifest({
        id: 'community.panel',
        panels: [{ id: 'p', entry: 'p.html', region: 'side' }],
      }),
    );
    expect(await f.plugins.install({ folder: panel, origin: 'directory' })).toMatchObject({
      state: 'blocked',
      tier: 'custom-ui',
      reason: BLOCK_REASONS.noRuntime,
    });
  });

  it("reports the runtime's own refusal", async () => {
    const runtime = new FakeRuntime({});
    const f = await fixture({ runtime });
    await f.plugins.setRestrictedMode(false);
    const folder = await writePlugin(f.host, logicManifest('community.unsupported'));
    expect(await f.plugins.install({ folder, origin: 'directory' })).toMatchObject({
      state: 'blocked',
      reason: 'Not on this device.',
    });
  });

  it('marks a crashed plugin failed and cleans up', async () => {
    const { f, runtime } = await withLogicPlugin();
    await f.plugins.setRestrictedMode(false);
    runtime.instances.get('community.logic')?.crash({ code: 'internal', message: 'worker died' });
    await f.plugins.idle();
    expect(f.plugins.get('community.logic')).toMatchObject({
      state: 'failed',
      reason: 'It stopped unexpectedly: worker died',
    });
    expect(f.kernel.commands.has('community.logic.hello')).toBe(false);
    // Enabling again retries.
    await f.plugins.enable('community.logic');
    expect(stateOf(f, 'community.logic')).toBe('active');
  });

  it('registers custom-UI panels as frames', async () => {
    const runtime = new FakeRuntime({ 'community.panel': { activate: () => undefined } });
    const f = await fixture({ runtime });
    await f.plugins.setRestrictedMode(false);
    const folder = await writePlugin(
      f.host,
      testManifest({
        id: 'community.panel',
        panels: [{ id: 'picker', entry: 'ui/picker.html', region: 'side' }],
      }),
    );
    await f.plugins.install({ folder, origin: 'directory' });
    expect(f.kernel.extensions.get('panels', 'community.panel/picker')?.contribution).toEqual({
      id: 'community.panel/picker',
      title: 'Test plugin',
      region: 'side',
      render: { kind: 'frame', entry: 'ui/picker.html' },
    });
  });
});

describe('side-loaded plugins', () => {
  it('load only in developer mode', async () => {
    const off = await fixture();
    const folder = await writePlugin(off.host, declarativeManifest(), declarativeFiles);
    expect(await off.plugins.install({ folder, origin: 'side-loaded' })).toMatchObject({
      state: 'blocked',
      reason: BLOCK_REASONS.developerMode,
    });
    const on = await fixture({ developerMode: true });
    await writePlugin(on.host, declarativeManifest(), declarativeFiles);
    expect(await on.plugins.install({ folder, origin: 'side-loaded' })).toMatchObject({
      state: 'active',
    });
  });
});

describe('host disposal', () => {
  it('unloads every plugin and refuses further operations', async () => {
    const f = await fixture({
      firstParty: [
        {
          manifest: testManifest({ id: 'forsee.x' }),
          module: {
            async activate(api) {
              await api.commands.register('forsee.x.y', () => 1, { title: 'Y' });
            },
          },
        },
      ],
    });
    f.plugins.dispose();
    expect(f.kernel.commands.has('forsee.x.y')).toBe(false);
    await expect(f.plugins.enable('forsee.x')).rejects.toMatchObject({ code: 'disposed' });
  });
});
