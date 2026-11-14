import {
  defaultErrorReporter,
  DisposableStore,
  EventBus,
  ForseeError,
  NOOP_DISPOSABLE,
  type Clock,
} from '@forsee/core';
import {
  API_VERSION,
  type ForseeApi,
  type PluginManifest,
  type PluginModule,
  type PrivateStorageApi,
  type ValidationIssue,
} from '@forsee/plugin-api';
import { createPluginApi } from './api';
import type {
  InstalledPlugin,
  PermissionManager,
  PluginApiSession,
  PluginFiles,
  PluginHost,
  PluginHostOptions,
  PluginInstallRecord,
  PluginInstallRequest,
  PluginInstallStorage,
  PluginOrigin,
  PluginRuntimeInstance,
  PluginState,
  PluginStatus,
} from './contracts';
import {
  issuesSummary,
  loadDeclarativeContributions,
  registerDeclarativeContributions,
} from './declarative';
import { isPlainObject, toForseeError } from './guards';
import { checkCompatibility, pluginPlatformOf, trustTierOf, validateManifest } from './manifest';
import { PanelTargets } from './panels';
import { isSafeRelativePath, PLUGIN_ID } from './patterns';
import { PluginPermissionManager } from './permissions';
import { SettingsSchemaSlot } from './settings-slot';

/** Settings namespace of the plugin host. */
export const PLUGIN_SETTINGS_NAMESPACE = 'app.plugins';
/** Setting key of restricted mode (boolean, default true). */
export const RESTRICTED_MODE_SETTING = 'restrictedMode';

/** Largest `manifest.json` read, in UTF-16 code units. */
const MAX_MANIFEST_SIZE = 256 * 1024;

/** User-presentable reasons a plugin does not run. */
export const BLOCK_REASONS = {
  restricted:
    'Restricted mode is on, so community plugins with code do not run. Turn restricted mode off in the plugin settings to run it.',
  developerMode: 'Side-loaded plugins load only in developer mode.',
  noRuntime:
    'No sandbox runtime is available here, so plugins with code or custom panels cannot run.',
  consent: 'Permission consent was refused. Enable the plugin again to be asked again.',
} as const;

/** Install records kept in memory (tests, and the default). */
export class MemoryInstallStorage implements PluginInstallStorage {
  private stored: readonly unknown[];

  constructor(initial: readonly unknown[] = []) {
    this.stored = initial;
  }

  load(): Promise<readonly unknown[]> {
    return Promise.resolve(this.stored);
  }

  save(records: readonly PluginInstallRecord[]): Promise<void> {
    this.stored = JSON.parse(JSON.stringify(records)) as unknown[];
    return Promise.resolve();
  }

  get records(): readonly unknown[] {
    return this.stored;
  }
}

/** Private storage kept in memory, one map per plugin (the default). */
export function createMemoryPluginStorage(): (pluginId: string) => PrivateStorageApi {
  const stores = new Map<string, Map<string, unknown>>();
  return (pluginId) => {
    let map = stores.get(pluginId);
    if (!map) {
      map = new Map();
      stores.set(pluginId, map);
    }
    const data = map;
    return {
      get: (key) => Promise.resolve(data.get(key) as never),
      set: (key, value) => {
        data.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        return Promise.resolve();
      },
      delete: (key) => {
        data.delete(key);
        return Promise.resolve();
      },
      keys: () => Promise.resolve([...data.keys()].sort()),
    };
  };
}

/** Runs a first-party module in the main context, through the same `ForseeApi`. */
export function createInProcessInstance(module: PluginModule): PluginRuntimeInstance {
  let status: 'ok' | 'terminated' = 'ok';
  return {
    async activate(api: ForseeApi) {
      await module.activate(api);
    },
    async deactivate() {
      await module.deactivate?.();
    },
    terminate() {
      status = 'terminated';
    },
    health: () => ({ status }),
    onDidCrash: () => NOOP_DISPOSABLE,
  };
}

interface Running {
  readonly contributions: DisposableStore;
  session: PluginApiSession | null;
  instance: PluginRuntimeInstance | null;
}

interface Entry {
  readonly id: string;
  readonly origin: PluginOrigin;
  readonly folder: string;
  readonly sha256?: string;
  readonly installedAt: number;
  enabled: boolean;
  /** `null` when the manifest could not be read or validated. */
  manifest: PluginManifest | null;
  module?: PluginModule;
  files?: PluginFiles;
  state: PluginState;
  reason?: string;
  issues?: readonly ValidationIssue[];
  running: Running | null;
}

function placeholderManifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: '0.0.0',
    apiVersion: API_VERSION,
    minAppVersion: '0.0.0',
    description: '',
    author: '',
  };
}

function parseInstallRecord(value: unknown): PluginInstallRecord | null {
  if (!isPlainObject(value)) return null;
  const { schemaVersion, id, origin, folder, sha256, enabled, installedAt } = value;
  if (
    schemaVersion !== 1 ||
    typeof id !== 'string' ||
    !PLUGIN_ID.test(id) ||
    (origin !== 'first-party' && origin !== 'directory' && origin !== 'side-loaded') ||
    typeof folder !== 'string' ||
    (origin !== 'first-party' && folder !== `plugins/${id}`) ||
    (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) ||
    typeof enabled !== 'boolean' ||
    typeof installedAt !== 'number'
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    id,
    origin,
    folder,
    enabled,
    installedAt,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

/** A `PluginHost` plus what tests and the shell need beyond the contract. */
export interface PluginHostInstance extends PluginHost {
  readonly permissions: PluginPermissionManager & PermissionManager;
  readonly panels: PanelTargets;
  /** Resolves when every queued lifecycle operation has finished. */
  idle(): Promise<void>;
}

/**
 * Creates the plugin host: the plugin lifecycle manager.
 *
 * Lifecycle of each plugin: install record → validate manifest → check
 * compatibility → install consent → load contributions → activate code →
 * (deactivate) → (uninstall). Lifecycle operations run one at a time in a
 * queue. A plugin whose files are invalid or whose `activate` throws ends in
 * `failed` with everything it registered undone; the app keeps working.
 *
 * Restricted mode (setting `app.plugins/restrictedMode`, on by default):
 * only first-party and purely declarative plugins load; community plugins
 * with code (`logic`, `custom-ui`) are listed as `blocked` with the reason.
 * With it off, they run in `options.runtime` (B10), or stay blocked
 * ("no runtime") without one.
 */
export function createPluginHost(options: PluginHostOptions): PluginHostInstance {
  const { kernel, host } = options;
  const reportError = options.reportError ?? defaultErrorReporter;
  const clock: Clock = kernel.clock;
  const appVersion = options.appVersion ?? host.platform.appVersion;
  const platform = options.platform ?? pluginPlatformOf(host.platform);
  const timeoutMs = options.lifecycleTimeoutMs ?? 10_000;
  const installStorage = options.installStorage ?? new MemoryInstallStorage();
  const pluginStorage = options.pluginStorage ?? createMemoryPluginStorage();
  const filesFor =
    options.files ??
    ((folder: string): PluginFiles => ({
      readText: (path) => {
        if (!isSafeRelativePath(path)) {
          return Promise.reject(
            new ForseeError('invalid-argument', `Unsafe path ${JSON.stringify(path)}`),
          );
        }
        return host.files.readText(`${folder}/${path}`);
      },
    }));
  const permissions = new PluginPermissionManager({
    consent: options.consent,
    clock,
    appVersion,
    reportError,
    ...(options.consentStorage ? { storage: options.consentStorage } : {}),
  });
  const panels = new PanelTargets({ reportError });
  const changes = new EventBus<{ changed: string | null }>({ onListenerError: reportError });
  const entries = new Map<string, Entry>();
  const subscriptions = new DisposableStore();
  let started = false;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  subscriptions.add(
    kernel.settings.registerSchema(PLUGIN_SETTINGS_NAMESPACE, [
      {
        key: RESTRICTED_MODE_SETTING,
        label: 'Restricted mode',
        type: 'boolean',
        description:
          'When on, community plugins that contain code do not run. Layouts, themes, phrases and vocabularies still load.',
        default: true,
      },
    ]),
  );
  const restricted = (): boolean =>
    kernel.settings.get(PLUGIN_SETTINGS_NAMESPACE, RESTRICTED_MODE_SETTING) !== false;

  const emit = (pluginId: string | null): void => changes.emit('changed', pluginId);

  /** Runs lifecycle operations one at a time. */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  const setState = (
    entry: Entry,
    state: PluginState,
    reason?: string,
    issues?: readonly ValidationIssue[],
  ): void => {
    entry.state = state;
    if (reason === undefined) delete entry.reason;
    else entry.reason = reason;
    if (issues === undefined) delete entry.issues;
    else entry.issues = issues;
    emit(entry.id);
  };

  const installed = (entry: Entry): InstalledPlugin => {
    const manifest = entry.manifest ?? placeholderManifest(entry.id);
    return {
      manifest,
      origin: entry.origin,
      tier: trustTierOf(manifest),
      folder: entry.folder,
      enabled: entry.enabled,
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    };
  };

  const status = (entry: Entry): PluginStatus => ({
    ...installed(entry),
    state: entry.state,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.issues === undefined ? {} : { issues: entry.issues }),
  });

  const saveRecords = async (): Promise<void> => {
    const records: PluginInstallRecord[] = [...entries.values()].map((entry) => ({
      schemaVersion: 1,
      id: entry.id,
      origin: entry.origin,
      folder: entry.folder,
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
    }));
    try {
      await installStorage.save(records);
    } catch (error) {
      reportError(error, 'plugins.save');
    }
  };

  const withTimeout = <T>(promise: Promise<T>, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        reject(new ForseeError('timeout', `${what} did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      promise.then(
        (value) => {
          timer.dispose();
          resolve(value);
        },
        (error: unknown) => {
          timer.dispose();
          reject(error instanceof Error ? error : toForseeError(error));
        },
      );
    });

  const readManifest = async (folder: string): Promise<unknown> => {
    const text = await filesFor(folder).readText('manifest.json');
    if (typeof text !== 'string' || text.length > MAX_MANIFEST_SIZE) {
      throw new ForseeError('invalid-argument', 'manifest.json is too large');
    }
    return JSON.parse(text) as unknown;
  };

  /** Loads and validates an installed plugin's manifest into its entry. */
  const refreshManifest = async (entry: Entry): Promise<void> => {
    let json: unknown;
    try {
      json = await readManifest(entry.folder);
    } catch (error) {
      entry.manifest = null;
      const message = error instanceof Error ? error.message : String(error);
      setState(entry, 'failed', `Its manifest could not be read: ${message}`);
      return;
    }
    const result = validateManifest(json);
    if (!result.ok) {
      entry.manifest = null;
      setState(entry, 'failed', 'Its manifest is invalid.', result.issues);
      return;
    }
    if (result.value.id !== entry.id) {
      entry.manifest = null;
      setState(
        entry,
        'failed',
        `Its manifest id "${result.value.id}" does not match ${entry.folder}.`,
      );
      return;
    }
    entry.manifest = result.value;
  };

  /** Why the plugin may not run now, or `null` if it may. */
  const blockReason = (entry: Entry, manifest: PluginManifest): string | null => {
    const compatible = checkCompatibility(manifest, { appVersion, platform });
    if (!compatible.ok) return compatible.reasons.join(' ');
    if (entry.origin === 'first-party') return null;
    if (entry.origin === 'side-loaded' && options.developerMode !== true) {
      return BLOCK_REASONS.developerMode;
    }
    if (trustTierOf(manifest) === 'declarative') return null;
    if (restricted()) return BLOCK_REASONS.restricted;
    if (!options.runtime) return BLOCK_REASONS.noRuntime;
    const supported = options.runtime.supports(installed(entry));
    return supported === true ? null : supported;
  };

  const cleanup = (entry: Entry): void => {
    const running = entry.running;
    entry.running = null;
    if (!running) return;
    const steps: [string, () => void][] = [
      ['terminate', () => running.instance?.terminate()],
      ['session', () => running.session?.dispose()],
      ['contributions', () => running.contributions.dispose()],
      ['extensions', () => kernel.extensions.disposeOwner(entry.id)],
      ['context', () => kernel.context.deleteBySource(entry.id)],
      ['panels', () => panels.clear(entry.id)],
    ];
    for (const [name, step] of steps) {
      try {
        step();
      } catch (error) {
        reportError(error, `plugin:${entry.id}:cleanup:${name}`);
      }
    }
  };

  const activate = async (entry: Entry, manifest: PluginManifest): Promise<void> => {
    setState(entry, 'loading');
    permissions.register(manifest, entry.origin);
    if (!(await permissions.requestInstall(entry.id))) {
      setState(entry, 'blocked', BLOCK_REASONS.consent);
      return;
    }
    const files: PluginFiles =
      entry.origin === 'first-party'
        ? (entry.files ?? {
            readText: (path) =>
              Promise.reject(new ForseeError('not-found', `No bundled file ${path}`)),
          })
        : filesFor(entry.folder);
    const running: Running = {
      contributions: new DisposableStore(),
      session: null,
      instance: null,
    };
    entry.running = running;
    try {
      const loaded = await loadDeclarativeContributions(manifest, files, options.validateLayout);
      if (!loaded.ok) {
        cleanup(entry);
        setState(
          entry,
          'failed',
          `Its contributed files are invalid: ${issuesSummary(loaded.issues)}`,
          loaded.issues,
        );
        return;
      }
      const schema = running.contributions.add(
        new SettingsSchemaSlot(kernel, entry.id, manifest.name),
      );
      running.contributions.add(
        registerDeclarativeContributions(kernel, entry.id, loaded.value, schema),
      );
      for (const panel of manifest.panels ?? []) {
        running.contributions.add(
          kernel.extensions.register('panels', entry.id, {
            id: `${entry.id}/${panel.id}`,
            title: panel.title ?? manifest.name,
            region: panel.region,
            render:
              entry.origin === 'first-party'
                ? { kind: 'component' }
                : { kind: 'frame', entry: panel.entry },
          }),
        );
      }
      const hasCode = entry.origin === 'first-party' || trustTierOf(manifest) !== 'declarative';
      if (hasCode) {
        const session = createPluginApi(kernel, { manifest, origin: entry.origin }, permissions, {
          storage: pluginStorage(entry.id),
          validateLayout: options.validateLayout,
          panels,
          settingsSchema: schema,
          reportError,
          ...(host.inference ? { inference: host.inference } : {}),
          ...options.services,
        });
        running.session = session;
        let instance: PluginRuntimeInstance;
        if (entry.origin === 'first-party' && entry.module) {
          instance = createInProcessInstance(entry.module);
        } else if (options.runtime) {
          instance = await withTimeout(
            options.runtime.load(installed(entry), files),
            `Loading ${entry.id}`,
          );
        } else {
          throw new ForseeError('unavailable', BLOCK_REASONS.noRuntime);
        }
        running.instance = instance;
        running.contributions.add(
          instance.onDidCrash((error) => {
            void enqueue(() => {
              if (entry.running === running) {
                cleanup(entry);
                setState(entry, 'failed', `It stopped unexpectedly: ${error.message}`);
              }
              return Promise.resolve();
            });
          }),
        );
        if (entry.running !== running) return;
        await withTimeout(instance.activate(session.api), `Activating ${entry.id}`);
      }
      if (entry.running !== running) return;
      setState(entry, 'active');
    } catch (error) {
      reportError(error, `plugin:${entry.id}:activate`);
      if (entry.running === running) cleanup(entry);
      const failure = toForseeError(error);
      setState(entry, 'failed', `It failed to start: ${failure.message}`);
    }
  };

  const deactivate = async (entry: Entry, next: PluginState, reason?: string): Promise<void> => {
    const running = entry.running;
    if (running) {
      setState(entry, 'deactivating');
      if (running.instance) {
        try {
          await withTimeout(running.instance.deactivate(), `Deactivating ${entry.id}`);
        } catch (error) {
          reportError(error, `plugin:${entry.id}:deactivate`);
        }
      }
      if (entry.running === running) cleanup(entry);
    }
    setState(entry, next, reason);
  };

  /** Brings one plugin to the state its settings call for. */
  const reconcile = async (entry: Entry): Promise<void> => {
    if (!started || disposed) return;
    if (!entry.enabled) {
      if (entry.running || entry.state !== 'disabled') await deactivate(entry, 'disabled');
      return;
    }
    const manifest = entry.manifest;
    if (!manifest) return; // stays failed
    const reason = blockReason(entry, manifest);
    if (reason !== null) {
      if (entry.running || entry.state !== 'blocked' || entry.reason !== reason) {
        await deactivate(entry, 'blocked', reason);
      }
      return;
    }
    if (entry.running || entry.state === 'failed') return;
    await activate(entry, manifest);
  };

  const reconcileAll = async (): Promise<void> => {
    for (const entry of [...entries.values()]) await reconcile(entry);
  };

  subscriptions.add(
    kernel.settings.events.on('changed', (change) => {
      if (change.namespace !== PLUGIN_SETTINGS_NAMESPACE) return;
      emit(null);
      if (started) void enqueue(reconcileAll);
    }),
  );

  const requireEntry = (pluginId: string): Entry => {
    const entry = entries.get(pluginId);
    if (!entry) throw new ForseeError('not-found', `No plugin ${pluginId}`);
    return entry;
  };

  const assertLive = (): void => {
    if (disposed) throw new ForseeError('disposed', 'The plugin host is disposed');
  };

  const pluginHost: PluginHostInstance = {
    permissions,
    panels,
    get restrictedMode() {
      return restricted();
    },

    list: () => [...entries.values()].map(status),

    get: (pluginId) => {
      const entry = entries.get(pluginId);
      return entry ? status(entry) : undefined;
    },

    start: () =>
      enqueue(async () => {
        assertLive();
        if (started) throw new ForseeError('invalid-argument', 'The plugin host already started');
        try {
          await permissions.load();
        } catch (error) {
          reportError(error, 'plugins.start.consent');
        }
        let stored: readonly unknown[] = [];
        try {
          stored = await installStorage.load();
        } catch (error) {
          reportError(error, 'plugins.start.records');
        }
        const records = new Map<string, PluginInstallRecord>();
        for (const value of stored) {
          const record = parseInstallRecord(value);
          if (record) records.set(record.id, record);
          else reportError(new Error('Skipped a malformed plugin install record'), 'plugins.start');
        }
        for (const plugin of options.firstParty) {
          const result = validateManifest(plugin.manifest, { firstParty: true });
          const id =
            typeof (plugin.manifest as { id?: unknown }).id === 'string'
              ? plugin.manifest.id
              : '(invalid)';
          if (entries.has(id)) {
            reportError(
              new ForseeError('duplicate', `Duplicate first-party plugin ${id}`),
              'plugins.start',
            );
            continue;
          }
          const record = records.get(id);
          const entry: Entry = {
            id,
            origin: 'first-party',
            folder: '',
            installedAt: record?.installedAt ?? clock.wallNow(),
            enabled: record?.origin === 'first-party' ? record.enabled : true,
            manifest: result.ok ? result.value : null,
            module: plugin.module,
            ...(plugin.files ? { files: plugin.files } : {}),
            state: 'inactive',
            running: null,
          };
          entries.set(id, entry);
          if (!result.ok) setState(entry, 'failed', 'Its manifest is invalid.', result.issues);
        }
        for (const record of records.values()) {
          if (record.origin === 'first-party' || entries.has(record.id)) continue;
          const entry: Entry = {
            id: record.id,
            origin: record.origin,
            folder: record.folder,
            installedAt: record.installedAt,
            enabled: record.enabled,
            manifest: null,
            ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }),
            state: record.enabled ? 'inactive' : 'disabled',
            running: null,
          };
          entries.set(record.id, entry);
          await refreshManifest(entry);
        }
        started = true;
        emit(null);
        await reconcileAll();
      }),

    install: (request) =>
      enqueue(async () => {
        assertLive();
        const r = request as Partial<PluginInstallRequest> | null;
        if (r?.origin !== 'directory' && r?.origin !== 'side-loaded') {
          throw new ForseeError('invalid-argument', 'origin must be "directory" or "side-loaded"');
        }
        if (typeof r.folder !== 'string' || !/^plugins\/[a-z0-9.-]+$/.test(r.folder)) {
          throw new ForseeError('invalid-argument', 'folder must be plugins/<plugin id>');
        }
        if (r.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(r.sha256)) {
          throw new ForseeError('invalid-argument', 'sha256 must be 64 lower-case hex digits');
        }
        let json: unknown;
        try {
          json = await readManifest(r.folder);
        } catch (error) {
          throw new ForseeError(
            'invalid-argument',
            `manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const result = validateManifest(json);
        if (!result.ok) {
          throw new ForseeError(
            'invalid-argument',
            `Invalid manifest: ${issuesSummary(result.issues)}`,
            {
              details: result.issues.map((i) => ({ path: i.path, message: i.message })),
            },
          );
        }
        const manifest = result.value;
        if (r.folder !== `plugins/${manifest.id}`) {
          throw new ForseeError(
            'invalid-argument',
            `A plugin with id ${manifest.id} must be installed in plugins/${manifest.id}`,
          );
        }
        if (entries.has(manifest.id)) {
          throw new ForseeError('duplicate', `${manifest.id} is already installed`);
        }
        const compatible = checkCompatibility(manifest, { appVersion, platform });
        if (!compatible.ok) {
          throw new ForseeError('unavailable', compatible.reasons.join(' '), {
            details: [...compatible.reasons],
          });
        }
        permissions.register(manifest, r.origin);
        if (!(await permissions.requestInstall(manifest.id))) {
          permissions.unregister(manifest.id);
          throw new ForseeError('permission-denied', `Installing ${manifest.id} was refused`);
        }
        const entry: Entry = {
          id: manifest.id,
          origin: r.origin,
          folder: r.folder,
          installedAt: clock.wallNow(),
          enabled: true,
          manifest,
          ...(r.sha256 === undefined ? {} : { sha256: r.sha256 }),
          state: 'inactive',
          running: null,
        };
        entries.set(entry.id, entry);
        await saveRecords();
        emit(entry.id);
        await reconcile(entry);
        return status(entry);
      }),

    uninstall: (pluginId) =>
      enqueue(async () => {
        assertLive();
        const entry = requireEntry(pluginId);
        if (entry.origin === 'first-party') {
          throw new ForseeError('invalid-argument', 'First-party plugins can only be disabled');
        }
        await deactivate(entry, 'disabled');
        entries.delete(pluginId);
        permissions.forget(pluginId);
        await saveRecords();
        emit(pluginId);
      }),

    enable: (pluginId) =>
      enqueue(async () => {
        assertLive();
        const entry = requireEntry(pluginId);
        entry.enabled = true;
        if (entry.origin !== 'first-party' && (entry.state === 'failed' || !entry.manifest)) {
          await refreshManifest(entry);
        }
        if (entry.manifest && (entry.state === 'failed' || entry.state === 'disabled')) {
          setState(entry, 'inactive');
        }
        await saveRecords();
        await reconcile(entry);
      }),

    disable: (pluginId) =>
      enqueue(async () => {
        assertLive();
        const entry = requireEntry(pluginId);
        entry.enabled = false;
        await saveRecords();
        if (started) await deactivate(entry, 'disabled');
        else setState(entry, 'disabled');
      }),

    setRestrictedMode: async (on) => {
      assertLive();
      kernel.settings.set(PLUGIN_SETTINGS_NAMESPACE, RESTRICTED_MODE_SETTING, on === true);
      await enqueue(() => Promise.resolve());
    },

    onDidChange: (listener) => changes.on('changed', listener),

    idle: () => enqueue(() => Promise.resolve()),

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) cleanup(entry);
      try {
        subscriptions.dispose();
      } catch (error) {
        reportError(error, 'plugins.dispose');
      }
      permissions.dispose();
      changes.dispose();
    },
  };
  return pluginHost;
}
