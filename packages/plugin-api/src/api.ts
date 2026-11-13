import type { Disposable, JsonValue } from './common';
import type { CommandArgs, CommandDescriptor, CommandHandler } from './commands';
import type { CompositionState } from './composition';
import type { ContextEntry, ContextEntryInput } from './context';
import type {
  CommandContribution,
  ContextProvider,
  GazeSourceContribution,
  OutputSink,
  PanelActivation,
  PanelTarget,
  PhraseSet,
  TextTransform,
  ThemeDefinition,
  Vocabulary,
} from './contributions';
import type { ForseeEventMap, ForseeEventType } from './events';
import type { InferenceService } from './inference';
import type { LayoutDefinition } from './layout';
import type { PermissionScope } from './manifest';
import type { PredictionProvider } from './prediction';
import type { SettingField, SettingValue } from './settings';
import type { SpeakOptions, Voice, VoiceProvider } from './speech';
import type { UtteranceRecord } from './storage';

/**
 * The object a plugin receives (`activate(api)`), identical for first-party
 * plugins in the main context and for sandboxed plugins, where it is a proxy
 * over `postMessage` (see `rpc.ts`).
 *
 * Rules that make proxying possible:
 * - Every method returns a promise, or is a subscription returning
 *   `Promise<Disposable>`. Nothing is synchronous across the boundary.
 * - Arguments and results are structured-clone-safe, except *handler
 *   objects*: listeners, command handlers and the implementation objects
 *   passed to `register.*`. Those stay in the plugin's realm; the RPC layer
 *   replaces them with an `RpcHandleRef` and calls back into them.
 * - `Disposable.dispose()` returned from a proxy sends a fire-and-forget
 *   message; the registration is gone once that message is processed.
 * - Calls needing a permission the plugin does not hold reject with an error
 *   whose `code` is `permission-denied` (see `ForseeErrorData`).
 * - Everything a plugin registers is disposed when the plugin is deactivated.
 */
export interface ForseeApi {
  /** `API_VERSION` the host implements. */
  readonly apiVersion: number;
  /** The plugin's own id and version, from its manifest. */
  readonly plugin: { readonly id: string; readonly version: string };

  readonly commands: CommandsApi;
  readonly composition: CompositionApi;
  readonly speech: SpeechApi;
  readonly settings: SettingsApi;
  readonly storage: PrivateStorageApi;
  readonly context: ContextApi;
  readonly history: HistoryApi;
  readonly events: EventsApi;
  readonly permissions: PermissionsApi;
  readonly panels: PanelsApi;
  /** Present only when the host offers an inference service; calls need `inference`. */
  readonly inference?: InferenceService;
  readonly register: RegisterApi;
}

/** Commands: execute any command, register the plugin's own. */
export interface CommandsApi {
  /**
   * Executes a command. Rejects with `unknown-command` or `handler-error`.
   * Executing a command is subject to the permissions its effect needs
   * (`composition.*` commands need `composition.write`, `speech.speak` needs `speech.output`).
   */
  execute<K extends string>(id: K, args?: CommandArgs<K>): Promise<unknown>;
  /** Lists every registered command. */
  list(): Promise<readonly CommandDescriptor[]>;
  /**
   * Registers a command. The id must start with the plugin id followed by
   * `.` or `/`. Rejects with `duplicate` if taken.
   */
  register(
    id: string,
    handler: CommandHandler,
    descriptor: { readonly title: string; readonly description?: string },
  ): Promise<Disposable>;
}

/** The text being written. Reading needs `composition.read`; changing it needs `composition.write`. */
export interface CompositionApi {
  getState(): Promise<CompositionState>;
  insert(text: string): Promise<void>;
  deleteGrapheme(): Promise<void>;
  deleteWord(): Promise<void>;
  clear(): Promise<void>;
  /** Replaces the current partial word, adding a trailing space (see `composition.acceptPrediction`). */
  acceptPrediction(text: string): Promise<void>;
  /** Replaces the whole text as one undoable step. */
  replace(text: string): Promise<void>;
  undo(): Promise<void>;
}

/** Speaking. `speak` needs `speech.output`. */
export interface SpeechApi {
  /** Speaks `text` (and logs it unless `options.log` is false). Resolves when speech has started. */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  /** Stops all speech immediately. */
  stop(): Promise<void>;
  listVoices(): Promise<readonly Voice[]>;
}

/** The plugin's own settings (namespace = plugin id). No permission needed. */
export interface SettingsApi {
  /** Registers or replaces the plugin's setting schema (also possible from the manifest). */
  registerSchema(fields: readonly SettingField[]): Promise<void>;
  /** Current value, or the default. Rejects with `not-found` for an unregistered key. */
  get(key: string): Promise<SettingValue>;
  /** Rejects with `invalid-argument` if the value fails the schema. */
  set(key: string, value: SettingValue): Promise<void>;
  getAll(): Promise<Readonly<Record<string, SettingValue>>>;
}

/**
 * The plugin's private key-value storage, stored in `plugins/<id>/data.json`
 * in the profile. No permission needed. Values are JSON; keep it small (it is
 * read whole).
 */
export interface PrivateStorageApi {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/** The shared context store. Reading needs `context.read`; writing needs `context.write`. */
export interface ContextApi {
  /** Unexpired entry, or `undefined`. */
  get(key: string): Promise<ContextEntry | undefined>;
  /** Unexpired entries whose key starts with `prefix` (all when omitted). */
  list(prefix?: string): Promise<readonly ContextEntry[]>;
  /** Writes an entry with this plugin as source. */
  set(entry: ContextEntryInput): Promise<void>;
  /** Deletes an entry this plugin wrote. Entries from other sources are left alone. */
  delete(key: string): Promise<void>;
}

/** Conversation history. Needs `history.read`. */
export interface HistoryApi {
  /** Most recent utterances, newest last, tombstoned ones excluded. */
  listRecent(limit: number): Promise<readonly UtteranceRecord[]>;
}

/** Subscribing to app events (see `ForseeEventMap` for the permission each needs). */
export interface EventsApi {
  on<K extends ForseeEventType>(
    type: K,
    listener: (payload: ForseeEventMap[K]) => void,
  ): Promise<Disposable>;
}

/** Inspecting and requesting permissions. */
export interface PermissionsApi {
  /** Whether the plugin currently holds the scope. */
  has(scope: PermissionScope): Promise<boolean>;
  /**
   * Asks the user for an optional permission the manifest lists in
   * `optionalPermissions`. Resolves true if granted. Scopes not declared in
   * the manifest are refused without asking.
   */
  request(scope: PermissionScope): Promise<boolean>;
}

/** Custom-UI panels: register selectable rectangles and receive activations. */
export interface PanelsApi {
  /**
   * Replaces the full set of selectable targets of one of the plugin's panels
   * (`panelId` is the manifest's local panel id). Rectangles are relative to
   * the panel frame. Call it whenever the panel's layout changes.
   */
  setTargets(panelId: string, targets: readonly PanelTarget[]): Promise<void>;
  /** Called when the host's selection engine fires one of the plugin's panel targets. */
  onActivate(listener: (activation: PanelActivation) => void): Promise<Disposable>;
}

/**
 * Registration functions for each extension point. Contribution ids are
 * automatically prefixed with `<pluginId>/` when they do not already start
 * with it. The returned disposable unregisters.
 */
export interface RegisterApi {
  layout(layout: LayoutDefinition): Promise<Disposable>;
  theme(theme: ThemeDefinition): Promise<Disposable>;
  phraseSet(phraseSet: PhraseSet): Promise<Disposable>;
  vocabulary(vocabulary: Vocabulary): Promise<Disposable>;
  command(command: CommandContribution): Promise<Disposable>;
  /**
   * Requests carry `conversation` only if the plugin holds `history.read` and
   * `context` only with `context.read`; `learn`/`forget` are called only with `lm.write`.
   */
  predictionProvider(provider: PredictionProvider): Promise<Disposable>;
  contextProvider(provider: ContextProvider): Promise<Disposable>;
  /** Needs `composition.write`. */
  textTransform(transform: TextTransform): Promise<Disposable>;
  /** Needs `speech.output`. */
  voiceProvider(provider: VoiceProvider): Promise<Disposable>;
  /** Needs `composition.read`. Network sinks also need `network:<host>`. */
  outputSink(sink: OutputSink): Promise<Disposable>;
  /** Needs `native.sidecar` for driver sources. */
  gazeSource(source: GazeSourceContribution): Promise<Disposable>;
}

/**
 * The entry point a logic plugin's `main` module exports (as `activate`, and
 * optionally `deactivate`). Registrations made through `api` are disposed
 * automatically on deactivation; `deactivate` is for anything else.
 */
export interface PluginModule {
  activate(api: ForseeApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
