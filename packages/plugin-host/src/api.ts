import {
  APP_COMMAND_OWNER,
  defaultErrorReporter,
  ForseeError,
  NOOP_DISPOSABLE,
  toDisposable,
  type CommandCaller,
  type Kernel,
} from '@forsee/core';
import {
  API_VERSION,
  DWELL_CLASSES,
  PLUGIN_EVENT_PERMISSIONS,
  type CancellationToken,
  type CommandHandler,
  type CommandsApi,
  type CompositionApi,
  type ContextApi,
  type ContextProvider,
  type ContributionMap,
  type Disposable,
  type DwellClass,
  type EventsApi,
  type ExtensionPointId,
  type ForseeApi,
  type ForseeEventMap,
  type ForseeEventType,
  type GazeSourceContribution,
  type HistoryApi,
  type InferenceService,
  type JsonObject,
  type PanelActivation,
  type PanelsApi,
  type PanelTarget,
  type PermissionScope,
  type PermissionsApi,
  type PrivateStorageApi,
  type RegisterApi,
  type SettingsApi,
  type SettingValue,
  type SpeechApi,
  type SpeechEvent,
  type Voice,
} from '@forsee/plugin-api';
import {
  validatePhraseSet,
  validateSettingFieldsJson,
  validateTheme,
  validateVocabulary,
} from './contribution-validators';
import type {
  PermissionManager,
  PluginApiServices,
  PluginApiSession,
  PluginIdentity,
  SettingsSchemaHolder,
} from './contracts';
import {
  copyJson,
  copyJsonObject,
  invalid,
  isPlainObject,
  LIMITS,
  optionalString,
  own,
  requireArray,
  requireBoolean,
  requireFunction,
  requireKey,
  requireNumber,
  requireObject,
  requireString,
  toCloneSafe,
  toForseeError,
} from './guards';
import { isPermissionScope } from './manifest';
import { COMMAND_ID, CONTEXT_KEY, isSafeRelativePath, LOCAL_ID } from './patterns';
import {
  readContextEntryInput,
  VOICE_PROVIDER_SCOPES,
  wrapOutputSink,
  wrapPredictionProvider,
  wrapTextTransform,
  wrapVoiceProvider,
  type WrapperContext,
} from './providers';
import { SettingsSchemaSlot } from './settings-slot';

// ---------------------------------------------------------------- method table

type Namespace = Exclude<keyof ForseeApi, 'apiVersion' | 'plugin'>;
type MethodsOf<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** `"<namespace>.<method>"` for every `ForseeApi` method, for example `"composition.insert"`. */
export type PluginApiMethod = {
  [N in Namespace]: `${N}.${MethodsOf<NonNullable<ForseeApi[N]>> & string}`;
}[Namespace];

const METHOD_TABLE = {
  'commands.execute': true,
  'commands.list': true,
  'commands.register': true,
  'composition.getState': true,
  'composition.insert': true,
  'composition.deleteGrapheme': true,
  'composition.deleteWord': true,
  'composition.clear': true,
  'composition.acceptPrediction': true,
  'composition.replace': true,
  'composition.undo': true,
  'speech.speak': true,
  'speech.stop': true,
  'speech.listVoices': true,
  'settings.registerSchema': true,
  'settings.get': true,
  'settings.set': true,
  'settings.getAll': true,
  'storage.get': true,
  'storage.set': true,
  'storage.delete': true,
  'storage.keys': true,
  'context.get': true,
  'context.list': true,
  'context.set': true,
  'context.delete': true,
  'history.listRecent': true,
  'events.on': true,
  'permissions.has': true,
  'permissions.request': true,
  'panels.setTargets': true,
  'panels.onActivate': true,
  'inference.getStatus': true,
  'inference.listModels': true,
  'inference.loadModel': true,
  'inference.unloadModel': true,
  'inference.scoreNextTokens': true,
  'inference.generate': true,
  'register.layout': true,
  'register.theme': true,
  'register.phraseSet': true,
  'register.vocabulary': true,
  'register.command': true,
  'register.predictionProvider': true,
  'register.contextProvider': true,
  'register.textTransform': true,
  'register.voiceProvider': true,
  'register.outputSink': true,
  'register.gazeSource': true,
} as const satisfies Record<PluginApiMethod, true>;

/** Every `ForseeApi` method path. The RPC layer must dispatch only these. */
export const PLUGIN_API_METHODS = Object.keys(METHOD_TABLE) as readonly PluginApiMethod[];

/** Whether `method` names a `ForseeApi` method. */
export function isPluginApiMethod(method: unknown): method is PluginApiMethod {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(METHOD_TABLE, method);
}

/**
 * Calls a `ForseeApi` method by path, as the RPC layer does for a plugin's
 * request (`RpcRequest.method`, `RpcRequest.params`). Only paths in
 * `PLUGIN_API_METHODS` are dispatched, so a request can never reach
 * anything else on the object. Always returns a promise; rejects with
 * `not-found` for an unknown method and `unavailable` for `inference.*`
 * without an inference service.
 */
export function invokeApiMethod(
  api: ForseeApi,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  if (!isPluginApiMethod(method)) {
    return Promise.reject(new ForseeError('not-found', `Unknown plugin API method: ${method}`));
  }
  if (!Array.isArray(params) || params.length > 8) {
    return Promise.reject(new ForseeError('invalid-argument', 'params must be a short array'));
  }
  const [namespace, member] = method.split('.') as [Namespace, string];
  const target = api[namespace] as Record<string, unknown> | undefined;
  if (!target) {
    return Promise.reject(new ForseeError('unavailable', `${namespace} is not available`));
  }
  const fn = target[member];
  if (typeof fn !== 'function') {
    return Promise.reject(new ForseeError('not-found', `Unknown plugin API method: ${method}`));
  }
  try {
    return Promise.resolve((fn as (...args: unknown[]) => unknown).apply(target, params));
  } catch (error) {
    return Promise.reject(toForseeError(error));
  }
}

// ---------------------------------------------------------------- factory

const SENSITIVE_PROVIDER_SCOPES: readonly PermissionScope[] = [
  'history.read',
  'context.read',
  'lm.write',
];

interface Tracked {
  readonly inner: Disposable;
  /** Scopes this registration depends on; losing one disposes it. */
  readonly scopes: readonly PermissionScope[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Builds the `ForseeApi` for one plugin (see `PluginApiFactory`).
 *
 * Every method:
 * - rejects with `disposed` once the session is disposed;
 * - validates its arguments (types, sizes, id grammar) and copies data
 *   before it reaches the kernel, rejecting with `invalid-argument`;
 * - checks the permission documented in `api.ts`/`events.ts` through
 *   `PermissionManager.ensure` (which may show a first-use prompt) and
 *   rejects with `permission-denied` otherwise;
 * - returns structured-clone-safe copies, never kernel objects.
 *
 * Everything the plugin registers or subscribes is tracked; registrations
 * that depend on a scope are disposed as soon as that scope is revoked, and
 * everything is disposed with the session.
 */
export function createPluginApi(
  kernel: Kernel,
  plugin: PluginIdentity,
  permissions: PermissionManager,
  services: PluginApiServices,
): PluginApiSession {
  const { manifest } = plugin;
  const pluginId = manifest.id;
  const reportError = services.reportError ?? defaultErrorReporter;
  const tracked = new Set<Tracked>();
  const modelHandles = new Set<string>();
  const ownSchema = services.settingsSchema === undefined;
  const schema: SettingsSchemaHolder =
    services.settingsSchema ?? new SettingsSchemaSlot(kernel, pluginId, manifest.name);
  const panelIds = new Set((manifest.panels ?? []).map((p) => p.id));
  let disposed = false;

  const disposedError = (): ForseeError =>
    new ForseeError('disposed', `Plugin ${pluginId} has been deactivated`);
  const assertLive = (): void => {
    if (disposed) throw disposedError();
  };
  const has = (scope: PermissionScope): boolean => permissions.has(pluginId, scope);
  const caller: CommandCaller = { pluginId, hasPermission: has };
  const wrapperContext: WrapperContext = { pluginId, has, assertLive };

  /** Runs an API method body: liveness check, error normalisation, always a promise. */
  const call = <T>(body: () => Promise<T> | T): Promise<T> => {
    if (disposed) return Promise.reject(disposedError());
    return (async () => {
      try {
        return await body();
      } catch (error) {
        throw toForseeError(error);
      }
    })();
  };

  const requireScope = async (scope: PermissionScope): Promise<void> => {
    const granted = await permissions.ensure(pluginId, scope);
    assertLive();
    if (!granted) {
      throw new ForseeError(
        'permission-denied',
        `${pluginId} does not hold the ${scope} permission`,
        {
          details: { scope },
        },
      );
    }
  };

  const safeDispose = (item: Disposable, context: string): void => {
    try {
      item.dispose();
    } catch (error) {
      reportError(error, context);
    }
  };

  /** Tracks a registration and returns the plugin-facing disposable. */
  const track = (inner: Disposable, scopes: readonly PermissionScope[] = []): Disposable => {
    if (disposed) {
      safeDispose(inner, `plugin:${pluginId}:dispose`);
      throw disposedError();
    }
    const entry: Tracked = { inner, scopes };
    tracked.add(entry);
    return toDisposable(() => {
      if (tracked.delete(entry)) safeDispose(inner, `plugin:${pluginId}:dispose`);
    });
  };

  const register = <P extends ExtensionPointId>(
    point: P,
    contribution: ContributionMap[P],
    scopes: readonly PermissionScope[] = [],
  ): Disposable => track(kernel.extensions.register(point, pluginId, contribution), scopes);

  /** `<pluginId>/<local>` from a plugin-supplied id. */
  const prefixed = (raw: unknown, name: string): string => {
    const id = requireKey(raw, name, LIMITS.localIdLength + pluginId.length + 1);
    const local = id.startsWith(`${pluginId}/`) ? id.slice(pluginId.length + 1) : id;
    if (!LOCAL_ID.test(local) || local.includes('..')) {
      invalid(`${name} must be letters, digits, "_", "-" and "." (no "/" or "..")`);
    }
    return `${pluginId}/${local}`;
  };

  /** A command id this plugin may register: `<pluginId>.<x>` or `<pluginId>/<x>`. */
  const ownCommandId = (raw: unknown, autoPrefix: boolean): string => {
    const id = requireKey(raw, 'command id', LIMITS.commandIdLength);
    const owned = id.startsWith(`${pluginId}.`) || id.startsWith(`${pluginId}/`);
    const full = owned ? id : autoPrefix ? `${pluginId}/${id}` : null;
    if (full === null) {
      throw new ForseeError(
        'permission-denied',
        `Command ids registered by ${pluginId} must start with "${pluginId}." or "${pluginId}/"`,
      );
    }
    if (full.length > LIMITS.commandIdLength || !COMMAND_ID.test(full) || full === pluginId) {
      invalid('command id must be "." or "/" separated segments of letters, digits, "_" and "-"');
    }
    return full;
  };

  const readScopes = (value: unknown, name: string): PermissionScope[] => {
    if (value === undefined) return [];
    const list = requireArray(value, name, 16);
    return list.map((scope, i) => {
      if (!isPermissionScope(scope)) invalid(`${name}[${i}] is not a permission scope`);
      return scope;
    });
  };

  const wrapCommandHandler =
    (handler: (...args: unknown[]) => unknown): CommandHandler<unknown> =>
    (args, context) => {
      assertLive();
      const result = handler(toCloneSafe(args), {
        commandId: context.commandId,
        source: context.source,
      });
      if (typeof (result as { then?: unknown } | null)?.then === 'function') {
        return Promise.resolve(result).then((r) => toCloneSafe(r));
      }
      return toCloneSafe(result);
    };

  /**
   * Authorises and runs a command on the plugin's behalf.
   *
   * Beyond `CommandRegistry.authorize`, two checks are about the data a
   * built-in command would reveal rather than the command itself:
   * - Undoing a commit brings back text that was spoken, which is history,
   *   so `composition.undo` at a commit step also needs `history.read`.
   * - The results of the built-in `composition.*` commands (whether anything
   *   was deleted, cleared or undone) reveal the composition, so they reach
   *   a plugin only if it holds `composition.read`; otherwise it gets
   *   `undefined`.
   */
  const runCommand = async (id: string, args: JsonObject | undefined): Promise<unknown> => {
    const descriptor = kernel.commands.list().find((d) => d.id === id);
    if (descriptor && descriptor.owner !== pluginId && descriptor.public) {
      // Give sensitive or optional scopes their first-use prompt before the check.
      for (const scope of descriptor.requires) await permissions.ensure(pluginId, scope);
      assertLive();
    }
    kernel.commands.authorize(id, caller);
    const builtin = descriptor?.owner === APP_COMMAND_OWNER;
    if (builtin && id === 'composition.undo' && kernel.composition.nextUndoReason === 'commit') {
      await requireScope('history.read');
    }
    const result = toCloneSafe(await kernel.commands.execute(id, args, pluginId));
    if (builtin && id.startsWith('composition.') && !has('composition.read')) return undefined;
    return result;
  };

  const text = (value: unknown, name = 'text'): string =>
    requireString(value, name, { max: LIMITS.textLength });

  // ---------------------------------------------------------------- commands

  const commands: CommandsApi = {
    execute: (id, args) =>
      call(async () => {
        const commandId = requireKey(id, 'command id', LIMITS.commandIdLength);
        if (!COMMAND_ID.test(commandId)) invalid('command id has an invalid format');
        return runCommand(commandId, copyJsonObject(args, 'args'));
      }),
    list: () => call(() => toCloneSafe(kernel.commands.list()) as never),
    register: (id, handler, descriptor) =>
      call(() => {
        const commandId = ownCommandId(id, false);
        const fn = requireFunction(handler, 'handler');
        const d = requireObject(descriptor, 'descriptor');
        const description = optionalString(own(d, 'description'), 'description');
        const isPublic = own(d, 'public');
        const registration = kernel.commands.register(commandId, wrapCommandHandler(fn), {
          title: requireString(own(d, 'title'), 'title', { min: 1, max: LIMITS.labelLength }),
          owner: pluginId,
          public: isPublic === undefined ? false : requireBoolean(isPublic, 'public'),
          requires: readScopes(own(d, 'requires'), 'requires'),
          ...(description === undefined ? {} : { description }),
        });
        return track(registration);
      }),
  };

  // ---------------------------------------------------------------- composition

  const writeCommand = (id: string, args?: JsonObject): Promise<void> =>
    call(async () => {
      await requireScope('composition.write');
      await runCommand(id, args);
    });

  const composition: CompositionApi = {
    getState: () =>
      call(async () => {
        await requireScope('composition.read');
        return toCloneSafe(kernel.composition.state) as never;
      }),
    insert: (value) => {
      try {
        return writeCommand('composition.insert', { text: text(value) });
      } catch (error) {
        return Promise.reject(toForseeError(error));
      }
    },
    deleteGrapheme: () => writeCommand('composition.deleteGrapheme'),
    deleteWord: () => writeCommand('composition.deleteWord'),
    clear: () => writeCommand('composition.clear'),
    undo: () => writeCommand('composition.undo'),
    acceptPrediction: (value) => {
      try {
        return writeCommand('composition.acceptPrediction', {
          text: requireString(value, 'text', { max: 200 }),
        });
      } catch (error) {
        return Promise.reject(toForseeError(error));
      }
    },
    replace: (value) =>
      call(async () => {
        const next = text(value);
        await requireScope('composition.write');
        kernel.composition.replace(next);
      }),
  };

  // ---------------------------------------------------------------- speech

  const SPEAK_OPTIONS = ['voiceId', 'rate', 'pitch', 'volume', 'recording', 'log', 'interrupt'];

  const speech: SpeechApi = {
    speak: (value, options) =>
      call(async () => {
        const utterance = text(value);
        if (utterance.trim() === '') invalid('text must not be blank');
        const args: Record<string, string | number | boolean> = { text: utterance };
        if (options !== undefined) {
          const o = requireObject(options, 'options');
          for (const key of Object.keys(o)) {
            if (!SPEAK_OPTIONS.includes(key)) invalid(`options.${key} is not a speak option`);
          }
          const voiceId = optionalString(own(o, 'voiceId'), 'options.voiceId', LIMITS.keyLength);
          if (voiceId !== undefined) args.voiceId = requireKey(voiceId, 'options.voiceId');
          if (own(o, 'rate') !== undefined) {
            args.rate = requireNumber(o.rate, 'options.rate', { min: 0.1, max: 10 });
          }
          if (own(o, 'pitch') !== undefined) {
            args.pitch = requireNumber(o.pitch, 'options.pitch', { min: 0, max: 2 });
          }
          if (own(o, 'volume') !== undefined) {
            args.volume = requireNumber(o.volume, 'options.volume', { min: 0, max: 1 });
          }
          if (own(o, 'recording') !== undefined) {
            if (!isSafeRelativePath(o.recording)) {
              invalid('options.recording must be a safe relative path');
            }
            args.recording = o.recording;
          }
          if (own(o, 'log') !== undefined) args.log = requireBoolean(o.log, 'options.log');
          if (own(o, 'interrupt') !== undefined) {
            args.interrupt = requireBoolean(o.interrupt, 'options.interrupt');
          }
        }
        await requireScope('speech.output');
        await runCommand('speech.speak', args);
      }),
    stop: () =>
      call(async () => {
        await runCommand('speech.stop', undefined);
      }),
    listVoices: () =>
      call(async () => {
        if (services.listVoices) return toCloneSafe(await services.listVoices()) as never;
        const voices: Voice[] = [];
        for (const { id, contribution } of kernel.extensions.list('voiceProviders')) {
          try {
            voices.push(...(await contribution.listVoices()));
          } catch (error) {
            reportError(error, `voiceProvider:${id}`);
          }
        }
        return toCloneSafe(voices) as never;
      }),
  };

  // ---------------------------------------------------------------- settings

  const settingValue = (value: unknown): SettingValue => {
    if (typeof value === 'string') return text(value, 'value');
    if (typeof value === 'boolean') return value;
    return requireNumber(value, 'value');
  };

  const settings: SettingsApi = {
    registerSchema: (fields) =>
      call(() => {
        const copy = copyJson(fields, 'fields', LIMITS.smallJsonSize * 4);
        const result = validateSettingFieldsJson(copy);
        if (!result.ok) invalid('Invalid settings schema', result.issues);
        assertLive();
        schema.replace(result.value);
      }),
    get: (key) =>
      call(() => kernel.settings.get(pluginId, requireKey(key, 'key', LIMITS.keyLength))),
    set: (key, value) =>
      call(() => {
        kernel.settings.set(
          pluginId,
          requireKey(key, 'key', LIMITS.keyLength),
          settingValue(value),
        );
      }),
    getAll: () => call(() => toCloneSafe(kernel.settings.getAll(pluginId)) as never),
  };

  // ---------------------------------------------------------------- storage

  const store = services.storage;
  const storage: PrivateStorageApi = {
    get: (key) => call(async () => toCloneSafe(await store.get(requireKey(key, 'key'))) as never),
    set: (key, value) =>
      call(async () => {
        const k = requireKey(key, 'key');
        await store.set(k, copyJson(value, 'value', LIMITS.storageJsonSize));
      }),
    delete: (key) => call(() => store.delete(requireKey(key, 'key'))),
    keys: () => call(async () => toCloneSafe(await store.keys()) as never),
  };

  // ---------------------------------------------------------------- context

  const contextKey = (value: unknown, name = 'key'): string => {
    const key = requireKey(value, name);
    if (!CONTEXT_KEY.test(key)) invalid(`${name} must be dot-separated [A-Za-z0-9_-] segments`);
    return key;
  };

  const context: ContextApi = {
    get: (key) =>
      call(async () => {
        const k = contextKey(key);
        await requireScope('context.read');
        return toCloneSafe(kernel.context.get(k)) as never;
      }),
    list: (prefix) =>
      call(async () => {
        const p = prefix === undefined ? undefined : contextKey(prefix, 'prefix');
        await requireScope('context.read');
        return toCloneSafe(kernel.context.list(p)) as never;
      }),
    set: (entry) =>
      call(async () => {
        const input = readContextEntryInput(entry);
        await requireScope('context.write');
        kernel.context.set(pluginId, input);
      }),
    delete: (key) =>
      call(async () => {
        const k = contextKey(key);
        await requireScope('context.write');
        kernel.context.delete(k, pluginId);
      }),
  };

  // ---------------------------------------------------------------- history

  const history: HistoryApi = {
    listRecent: (limit) =>
      call(async () => {
        const n = requireNumber(limit, 'limit', { integer: true, min: 0 });
        await requireScope('history.read');
        return toCloneSafe(
          kernel.conversation.listRecent(Math.min(n, LIMITS.historyLimit)),
        ) as never;
      }),
  };

  // ---------------------------------------------------------------- events

  const subscribe = <K extends ForseeEventType>(
    type: K,
    deliver: (payload: ForseeEventMap[K]) => void,
  ): Disposable => {
    const bus = kernel.bus;
    switch (type) {
      case 'composition.changed':
        return bus.on('composition.changed', deliver as never);
      case 'gaze.pauseChanged':
        return bus.on('gaze.pauseChanged', deliver as never);
      case 'context.changed':
        return bus.on('context.changed', deliver as never);
      case 'history.appended':
        return bus.on('conversation.appended', deliver as never);
      case 'settings.changed':
        return bus.on('settings.changed', (change) => {
          if (change.namespace === pluginId) (deliver as (p: typeof change) => void)(change);
        });
      case 'speech.event':
        return services.speechEvents?.(deliver as never) ?? NOOP_DISPOSABLE;
      case 'gaze.sample':
        return services.gazeSamples?.(deliver as never) ?? NOOP_DISPOSABLE;
      default:
        return NOOP_DISPOSABLE;
    }
  };

  /**
   * `speech.event` needs no permission, but word boundaries give the
   * position and length of every spoken word, and a provider's error message
   * may quote the text, so without `composition.read` boundaries are
   * dropped and error messages replaced.
   */
  const redactSpeechEvent = (event: SpeechEvent): SpeechEvent | undefined => {
    if (has('composition.read')) return event;
    if (event.type === 'boundary') return undefined;
    if (event.type === 'error') return { ...event, message: 'Speech failed' };
    return event;
  };

  const events: EventsApi = {
    on: (type, listener) =>
      call(async () => {
        if (
          typeof type !== 'string' ||
          !Object.prototype.hasOwnProperty.call(PLUGIN_EVENT_PERMISSIONS, type)
        ) {
          invalid(`Unknown event type ${JSON.stringify(type)}`);
        }
        const fn = requireFunction(listener, 'listener');
        const scope = PLUGIN_EVENT_PERMISSIONS[type];
        if (scope !== null) await requireScope(scope);
        const subscription = subscribe(type, (payload) => {
          if (disposed || (scope !== null && !has(scope))) return;
          const visible =
            type === 'speech.event' ? redactSpeechEvent(payload as SpeechEvent) : payload;
          if (visible === undefined) return;
          try {
            fn(toCloneSafe(visible));
          } catch (error) {
            reportError(error, `plugin:${pluginId}:event:${type}`);
          }
        });
        return track(subscription, scope === null ? [] : [scope]);
      }),
  };

  // ---------------------------------------------------------------- permissions

  const scopeArg = (value: unknown): PermissionScope => {
    if (!isPermissionScope(value)) invalid(`${JSON.stringify(value)} is not a permission scope`);
    return value;
  };

  const permissionsApi: PermissionsApi = {
    has: (scope) => call(() => has(scopeArg(scope))),
    request: (scope) =>
      call(async () => {
        const s = scopeArg(scope);
        const granted = await permissions.ensure(pluginId, s);
        assertLive();
        return granted;
      }),
  };

  // ---------------------------------------------------------------- panels

  const readTarget = (value: unknown, i: number): PanelTarget => {
    const t = requireObject(value, `targets[${i}]`);
    const r = requireObject(own(t, 'rect'), `targets[${i}].rect`);
    const dwellClass = own(t, 'dwellClass');
    if (!DWELL_CLASSES.includes(dwellClass as DwellClass)) {
      invalid(`targets[${i}].dwellClass must be one of ${DWELL_CLASSES.join(', ')}`);
    }
    const label = optionalString(own(t, 'label'), `targets[${i}].label`, LIMITS.labelLength);
    const afterActivate = own(t, 'afterActivate');
    if (
      afterActivate !== undefined &&
      afterActivate !== 'look-away' &&
      afterActivate !== 'repeat'
    ) {
      invalid(`targets[${i}].afterActivate must be "look-away" or "repeat"`);
    }
    const disabled = own(t, 'disabled');
    const coordinate = { min: -100_000, max: 100_000 };
    return {
      id: requireKey(own(t, 'id'), `targets[${i}].id`, LIMITS.localIdLength),
      rect: {
        x: requireNumber(own(r, 'x'), `targets[${i}].rect.x`, coordinate),
        y: requireNumber(own(r, 'y'), `targets[${i}].rect.y`, coordinate),
        width: requireNumber(own(r, 'width'), `targets[${i}].rect.width`, { min: 0, max: 100_000 }),
        height: requireNumber(own(r, 'height'), `targets[${i}].rect.height`, {
          min: 0,
          max: 100_000,
        }),
      },
      dwellClass: dwellClass as DwellClass,
      ...(label === undefined ? {} : { label }),
      ...(afterActivate === undefined ? {} : { afterActivate }),
      ...(disabled === undefined
        ? {}
        : { disabled: requireBoolean(disabled, `targets[${i}].disabled`) }),
    };
  };

  const panelStore = (): NonNullable<PluginApiServices['panels']> => {
    if (!services.panels) throw new ForseeError('unavailable', 'Panels are not available here');
    return services.panels;
  };

  const panels: PanelsApi = {
    setTargets: (panelId, targets) =>
      call(() => {
        const id = requireKey(panelId, 'panelId', 64);
        if (!panelIds.has(id)) {
          throw new ForseeError('not-found', `${pluginId} declares no panel "${id}"`);
        }
        const list = requireArray(targets, 'targets', LIMITS.panelTargets).map(readTarget);
        const ids = new Set<string>();
        for (const target of list) {
          if (ids.has(target.id)) invalid(`Duplicate target id "${target.id}"`);
          ids.add(target.id);
        }
        panelStore().set(pluginId, id, deepFreeze(list));
      }),
    onActivate: (listener) =>
      call(() => {
        const fn = requireFunction(listener, 'listener');
        const subscription = panelStore().onActivate(pluginId, (activation: PanelActivation) => {
          if (disposed) return;
          try {
            fn(toCloneSafe(activation));
          } catch (error) {
            reportError(error, `plugin:${pluginId}:panel.activate`);
          }
        });
        return track(subscription);
      }),
  };

  // ---------------------------------------------------------------- inference

  const service = services.inference;
  const unloadModels = (): void => {
    if (!service) return;
    for (const handleId of [...modelHandles]) {
      modelHandles.delete(handleId);
      service.unloadModel(handleId).catch((error: unknown) => {
        reportError(error, `plugin:${pluginId}:inference.unload`);
      });
    }
  };
  /** Only handles this plugin loaded can be used (checked after the permission). */
  const assertOwnHandle = (handleId: string): void => {
    if (!modelHandles.has(handleId)) {
      throw new ForseeError('not-found', `Unknown model handle ${handleId}`);
    }
  };
  const cancellationArg = (value: unknown): CancellationToken | undefined => {
    if (value === undefined) return undefined;
    const token = requireObject(value, 'cancellation');
    requireFunction(token.onCancel, 'cancellation.onCancel');
    return token as unknown as CancellationToken;
  };

  const inference: InferenceService | undefined = service && {
    getStatus: () =>
      call(async () => {
        await requireScope('inference');
        return toCloneSafe(await service.getStatus()) as never;
      }),
    listModels: () =>
      call(async () => {
        await requireScope('inference');
        return toCloneSafe(await service.listModels()) as never;
      }),
    loadModel: (modelId) =>
      call(async () => {
        const id = requireKey(modelId, 'modelId');
        await requireScope('inference');
        const handle = await service.loadModel(id);
        if (disposed) {
          await service.unloadModel(handle.handleId);
          throw disposedError();
        }
        modelHandles.add(handle.handleId);
        return { handleId: handle.handleId, modelId: handle.modelId };
      }),
    unloadModel: (handleId) =>
      call(async () => {
        const id = requireKey(handleId, 'handleId');
        await requireScope('inference');
        if (!modelHandles.delete(id)) return;
        await service.unloadModel(id);
      }),
    scoreNextTokens: (request, cancellation) =>
      call(async () => {
        const r = requireObject(request, 'request');
        const constraintPrefix = optionalString(
          own(r, 'constraintPrefix'),
          'constraintPrefix',
          200,
        );
        const copy = {
          handleId: requireKey(own(r, 'handleId'), 'handleId'),
          prompt: requireString(own(r, 'prompt'), 'prompt', { max: 100_000 }),
          topK: requireNumber(own(r, 'topK'), 'topK', { integer: true, min: 1, max: 1000 }),
          ...(constraintPrefix === undefined ? {} : { constraintPrefix }),
        };
        const token = cancellationArg(cancellation);
        await requireScope('inference');
        assertOwnHandle(copy.handleId);
        return toCloneSafe(await service.scoreNextTokens(copy, token)) as never;
      }),
    generate: (request, onToken, cancellation) =>
      call(async () => {
        const r = requireObject(request, 'request');
        const temperature = own(r, 'temperature');
        const stop = own(r, 'stop');
        const copy = {
          handleId: requireKey(own(r, 'handleId'), 'handleId'),
          prompt: requireString(own(r, 'prompt'), 'prompt', { max: 100_000 }),
          maxTokens: requireNumber(own(r, 'maxTokens'), 'maxTokens', {
            integer: true,
            min: 1,
            max: 4096,
          }),
          ...(temperature === undefined
            ? {}
            : { temperature: requireNumber(temperature, 'temperature', { min: 0, max: 2 }) }),
          ...(stop === undefined
            ? {}
            : {
                stop: requireArray(stop, 'stop', 16).map((s, i) =>
                  requireString(s, `stop[${i}]`, { min: 1, max: 100 }),
                ),
              }),
        };
        const callback = onToken === undefined ? undefined : requireFunction(onToken, 'onToken');
        const token = cancellationArg(cancellation);
        await requireScope('inference');
        assertOwnHandle(copy.handleId);
        const deliver = callback
          ? (piece: string): void => {
              if (disposed) return;
              try {
                callback(piece);
              } catch (error) {
                reportError(error, `plugin:${pluginId}:inference.onToken`);
              }
            }
          : undefined;
        return toCloneSafe(await service.generate(copy, deliver, token)) as never;
      }),
  };

  // ---------------------------------------------------------------- register

  const validated = <T>(
    result:
      { ok: true; value: T } | { ok: false; issues: readonly { path: string; message: string }[] },
    what: string,
  ): T => {
    if (!result.ok) invalid(`Invalid ${what}`, result.issues);
    return result.value;
  };

  /** Copies a JSON contribution, prefixes its id and validates it. */
  const declarative = <T>(
    value: unknown,
    what: string,
    validate: (
      json: unknown,
    ) =>
      { ok: true; value: T } | { ok: false; issues: readonly { path: string; message: string }[] },
  ): T => {
    const copy = copyJson(value, what, 4 * 1024 * 1024);
    if (!isPlainObject(copy)) invalid(`${what} must be an object`);
    const withId = { ...copy, id: prefixed(copy.id, `${what}.id`) };
    return deepFreeze(validated(validate(withId), what));
  };

  const registerApi: RegisterApi = {
    layout: (layout) =>
      call(() => register('layouts', declarative(layout, 'layout', services.validateLayout))),
    theme: (theme) => call(() => register('themes', declarative(theme, 'theme', validateTheme))),
    phraseSet: (phraseSet) =>
      call(() => register('phraseSets', declarative(phraseSet, 'phraseSet', validatePhraseSet))),
    vocabulary: (vocabulary) =>
      call(() =>
        register('vocabularies', declarative(vocabulary, 'vocabulary', validateVocabulary)),
      ),
    command: (command) =>
      call(() => {
        const c = requireObject(command, 'command');
        const id = ownCommandId(own(c, 'id'), true);
        const title = requireString(own(c, 'title'), 'title', { min: 1, max: LIMITS.labelLength });
        const description = optionalString(own(c, 'description'), 'description');
        const isPublic = own(c, 'public');
        const exposure = {
          public: isPublic === undefined ? false : requireBoolean(isPublic, 'public'),
          requires: readScopes(own(c, 'requires'), 'requires'),
        };
        const handler = wrapCommandHandler(requireFunction(own(c, 'handler'), 'handler'));
        const registration = kernel.commands.register(id, handler, {
          title,
          owner: pluginId,
          ...exposure,
          ...(description === undefined ? {} : { description }),
        });
        let contribution: Disposable;
        try {
          contribution = kernel.extensions.register('commands', pluginId, {
            id,
            title,
            handler: handler,
            ...exposure,
            ...(description === undefined ? {} : { description }),
          });
        } catch (error) {
          registration.dispose();
          throw error;
        }
        return track(
          toDisposable(() => {
            contribution.dispose();
            registration.dispose();
          }),
        );
      }),
    predictionProvider: (provider) =>
      call(async () => {
        const p = requireObject(provider, 'provider');
        const wrapped = wrapPredictionProvider(p, prefixed(p.id, 'provider.id'), wrapperContext);
        // Every request carries the composition.
        await requireScope('composition.read');
        // Registering a provider is the first use of the data it would receive.
        for (const scope of SENSITIVE_PROVIDER_SCOPES) {
          if (manifest.permissions?.includes(scope)) await permissions.ensure(pluginId, scope);
        }
        assertLive();
        return register('predictionProviders', wrapped, ['composition.read']);
      }),
    contextProvider: (provider) =>
      call(async () => {
        const p = requireObject(provider, 'provider');
        const id = prefixed(p.id, 'provider.id');
        const name = requireString(own(p, 'name'), 'provider.name', {
          min: 1,
          max: LIMITS.labelLength,
        });
        const provides = requireArray(own(p, 'provides'), 'provider.provides', 64).map((key, i) =>
          contextKey(key, `provider.provides[${i}]`),
        );
        const refresh =
          p.refresh === undefined ? undefined : requireFunction(p.refresh, 'provider.refresh');
        await requireScope('context.write');
        const wrapped: ContextProvider = {
          id,
          name,
          provides,
          ...(refresh
            ? {
                async refresh() {
                  assertLive();
                  if (!has('context.write')) return [];
                  const entries = requireArray(await refresh.call(p), 'refresh result', 100).map(
                    (entry, i) => readContextEntryInput(entry, `entries[${i}]`),
                  );
                  if (disposed || !has('context.write')) return [];
                  for (const entry of entries) kernel.context.set(pluginId, entry);
                  return entries;
                },
              }
            : {}),
        };
        return register('contextProviders', wrapped, ['context.write']);
      }),
    textTransform: (transform) =>
      call(async () => {
        const t = requireObject(transform, 'transform');
        const wrapped = wrapTextTransform(t, prefixed(t.id, 'transform.id'), wrapperContext);
        // A transform is given the composition and changes it.
        await requireScope('composition.read');
        await requireScope('composition.write');
        return register('textTransforms', wrapped, ['composition.read', 'composition.write']);
      }),
    voiceProvider: (provider) =>
      call(async () => {
        const p = requireObject(provider, 'provider');
        const wrapped = wrapVoiceProvider(p, prefixed(p.id, 'provider.id'), wrapperContext);
        // A voice provider is given everything the user says, which is the composition.
        for (const scope of VOICE_PROVIDER_SCOPES) await requireScope(scope);
        return register('voiceProviders', wrapped, VOICE_PROVIDER_SCOPES);
      }),
    outputSink: (sink) =>
      call(async () => {
        const s = requireObject(sink, 'sink');
        const wrapped = wrapOutputSink(s, prefixed(s.id, 'sink.id'), wrapperContext);
        await requireScope('composition.read');
        return register('outputSinks', wrapped, ['composition.read']);
      }),
    gazeSource: (source) =>
      call(async () => {
        const s = requireObject(source, 'source');
        const id = prefixed(own(s, 'id'), 'source.id');
        const name = requireString(own(s, 'name'), 'source.name', {
          min: 1,
          max: LIMITS.labelLength,
        });
        const kind = own(s, 'kind');
        if (kind === 'in-process') {
          if (plugin.origin !== 'first-party') {
            throw new ForseeError(
              'permission-denied',
              'Only first-party plugins can register in-process gaze sources',
            );
          }
          const impl = requireObject(own(s, 'source'), 'source.source');
          requireFunction(impl.start, 'source.source.start');
          const contribution = {
            id,
            name,
            kind: 'in-process',
            source: impl as never,
          } as const satisfies GazeSourceContribution;
          return register('gazeSources', contribution);
        }
        if (kind !== 'driver') invalid('source.kind must be "driver" or "in-process"');
        const executable = requireObject(own(s, 'executable'), 'source.executable');
        const paths: Partial<Record<'macos' | 'windows' | 'linux', string>> = {};
        for (const key of Object.keys(executable)) {
          if (key !== 'macos' && key !== 'windows' && key !== 'linux') {
            invalid(`source.executable.${key} is not a desktop OS`);
          }
          const path = executable[key];
          if (!isSafeRelativePath(path)) {
            invalid(`source.executable.${key} must be a safe relative path in the plugin folder`);
          }
          paths[key] = path;
        }
        if (Object.keys(paths).length === 0) invalid('source.executable names no executable');
        const args = own(s, 'args');
        const platforms = own(s, 'platforms');
        if (platforms !== undefined) {
          const list = requireArray(platforms, 'source.platforms', 1);
          if (list.some((p) => p !== 'desktop')) invalid('Driver sources run only on desktop');
        }
        await requireScope('native.sidecar');
        const contribution: GazeSourceContribution = {
          id,
          name,
          kind: 'driver',
          executable: paths,
          ...(args === undefined
            ? {}
            : {
                args: requireArray(args, 'source.args', 32).map((a, i) =>
                  requireString(a, `source.args[${i}]`, { max: 1000 }),
                ),
              }),
          ...(platforms === undefined ? {} : { platforms: ['desktop'] as const }),
        };
        return register('gazeSources', deepFreeze(contribution), ['native.sidecar']);
      }),
  };

  // ---------------------------------------------------------------- revocation and disposal

  const permissionSubscription = permissions.onDidChange((changed) => {
    if (changed !== pluginId || disposed) return;
    for (const entry of [...tracked]) {
      if (entry.scopes.some((scope) => !has(scope))) {
        tracked.delete(entry);
        safeDispose(entry.inner, `plugin:${pluginId}:revoke`);
      }
    }
    if (!has('inference')) unloadModels();
  });

  const api: ForseeApi = deepFreeze({
    apiVersion: API_VERSION,
    plugin: { id: pluginId, version: manifest.version },
    commands,
    composition,
    speech,
    settings,
    storage,
    context,
    history,
    events,
    permissions: permissionsApi,
    panels,
    ...(inference ? { inference } : {}),
    register: registerApi,
  });

  return {
    api,
    pluginId,
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      safeDispose(permissionSubscription, `plugin:${pluginId}:dispose`);
      for (const entry of [...tracked].reverse()) {
        safeDispose(entry.inner, `plugin:${pluginId}:dispose`);
      }
      tracked.clear();
      if (ownSchema) safeDispose(schema, `plugin:${pluginId}:dispose`);
      services.panels?.clear(pluginId);
      unloadModels();
      kernel.context.deleteBySource(pluginId);
    },
  };
}
