import type { ErrorReporter, Kernel } from '@forsee/core';
import type { HostBridge } from '@forsee/host';
import type { LayoutValidator } from '@forsee/layouts';
import type {
  Disposable,
  ForseeApi,
  ForseeErrorData,
  GazeSample,
  InferenceService,
  PanelActivation,
  PanelTarget,
  PermissionScope,
  PluginManifest,
  PluginModule,
  PluginPlatform,
  PrivateStorageApi,
  Rect,
  RpcMessage,
  SettingField,
  SpeechEvent,
  TrustTier,
  ValidationIssue,
  ValidationResult,
  Voice,
} from '@forsee/plugin-api';

/**
 * Contracts of the plugin host. Part 1 (B9): manifest validation, loading
 * of declarative and first-party plugins, permissions and consent,
 * restricted mode. Part 2 (B10): sandboxed frame + worker runtime, RPC,
 * panel target protocol, plugin SDK helper. The public types (manifest,
 * `ForseeApi`, RPC envelopes) live in `@forsee/plugin-api`.
 */

export type {
  ForseeApi,
  PermissionScope,
  PluginManifest,
  PluginModule,
  RpcMessage,
  TrustTier,
} from '@forsee/plugin-api';

// ------------------------------------------------------------------ B9: manifests, loading

/** Options for `validateManifest`. */
export interface ManifestValidationOptions {
  /**
   * The manifest belongs to a first-party plugin shipped in the app binary.
   * Only first-party manifests may use the reserved `forsee.` id prefix.
   */
  readonly firstParty?: boolean;
}

/** Validates untrusted JSON into a manifest (rules on `PluginManifest`). */
export type ManifestValidator = (
  json: unknown,
  options?: ManifestValidationOptions,
) => ValidationResult<PluginManifest>;

/** Trust tier implied by a manifest (`TrustTier` docs). Pure. */
export type TrustTierOf = (manifest: PluginManifest) => TrustTier;

/** What a manifest is checked against before loading. */
export interface CompatibilityTarget {
  /** Running app version (semver). */
  readonly appVersion: string;
  /** Running platform family. */
  readonly platform: PluginPlatform;
}

/** Result of a compatibility check; `reasons` are user-presentable sentences. */
export type CompatibilityResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/** Where a plugin came from. */
export type PluginOrigin =
  /** Shipped in the app binary; runs in the main context. */
  | 'first-party'
  /** Installed from the community directory, pinned to a bundle hash. */
  | 'directory'
  /** Dropped into the profile's `plugins/` folder; loads only in developer mode. */
  | 'side-loaded';

/** A plugin known to the host. */
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
  readonly tier: TrustTier;
  /** Profile-relative folder, `plugins/<id>` (first-party: empty string). */
  readonly folder: string;
  /** SHA-256 of the bundle for `directory` plugins. */
  readonly sha256?: string;
  readonly enabled: boolean;
  /** A first-party plugin the app cannot run without: always enabled, `disable` rejects. */
  readonly required: boolean;
}

/**
 * Lifecycle state of a plugin in this session.
 *
 * - `inactive`: enabled, not running yet (before `start`, or between steps).
 * - `disabled`: switched off by the user.
 * - `blocked`: enabled but not allowed to run (restricted mode, developer
 *   mode, incompatible, no runtime, consent refused); `reason` says why.
 * - `loading`: being validated, loaded or activated.
 * - `active`: running; its contributions are registered.
 * - `deactivating`: being unloaded.
 * - `failed`: invalid manifest or contribution, or its code threw; `reason`
 *   and `issues` say why. Retried only on an explicit `enable`.
 */
export type PluginState =
  'inactive' | 'disabled' | 'blocked' | 'loading' | 'active' | 'deactivating' | 'failed';

/** A plugin as listed by the host. */
export interface PluginStatus extends InstalledPlugin {
  readonly state: PluginState;
  /** Why the plugin is `blocked` or `failed`, for the plugin manager screen. */
  readonly reason?: string;
  /** Validation issues behind a `failed` state, with paths. */
  readonly issues?: readonly ValidationIssue[];
}

/** A first-party plugin: manifest plus in-process module. */
export interface FirstPartyPlugin {
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
  /** Files listed in `manifest.contributes`, bundled with the app. */
  readonly files?: PluginFiles;
  /**
   * The app cannot work without it (for example the plugin that supplies the
   * keyboards): it is always enabled, whatever the stored record says, and
   * `disable` rejects with `invalid-argument`.
   */
  readonly required?: boolean;
}

/** What to install from the profile's plugin folder. */
export interface PluginInstallRequest {
  /** Profile-relative folder holding `manifest.json`; must be `plugins/<manifest id>`. */
  readonly folder: string;
  readonly origin: Exclude<PluginOrigin, 'first-party'>;
  /** Bundle hash the directory pinned (verified by the installer that fetched it). */
  readonly sha256?: string;
}

/** The plugin host facade B9 provides as `createPluginHost(options)`. */
export interface PluginHost extends Disposable {
  list(): readonly PluginStatus[];
  /** One plugin's status, or `undefined`. */
  get(pluginId: string): PluginStatus | undefined;
  /** Loads consent and install records, then every enabled plugin allowed by restricted mode. Call once. */
  start(): Promise<void>;
  /**
   * Installs a community plugin: validates its manifest, checks
   * compatibility, asks for install consent, records it and (once started)
   * loads it. Rejects with `invalid-argument` (issues in `details`),
   * `duplicate`, `unavailable` (incompatible) or `permission-denied` (consent refused).
   */
  install(request: PluginInstallRequest): Promise<PluginStatus>;
  /** Deactivates and forgets a community plugin and its consent records. First-party plugins cannot be uninstalled. */
  uninstall(pluginId: string): Promise<void>;
  /** Enables a plugin and loads it if allowed. Also retries a `failed` plugin. */
  enable(pluginId: string): Promise<void>;
  /**
   * Disposes everything the plugin registered (`ExtensionRegistry.disposeOwner`, commands, context).
   * Rejects with `invalid-argument` for a required first-party plugin.
   */
  disable(pluginId: string): Promise<void>;
  /** Restricted mode (on by default): community code does not run. Declarative plugins still load. */
  readonly restrictedMode: boolean;
  setRestrictedMode(on: boolean): Promise<void>;
  readonly permissions: PermissionManager;
  /** Selectable rectangles registered by custom-UI panels (for the UI and B10). */
  readonly panels: PanelTargetRegistry;
  /** Called after any plugin's status changes, with its id (`null` for host-wide changes). */
  onDidChange(listener: (pluginId: string | null) => void): Disposable;
}

/** Persisted install record (`enabled` flag and provenance). */
export interface PluginInstallRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly origin: PluginOrigin;
  readonly folder: string;
  readonly sha256?: string;
  readonly enabled: boolean;
  /** Wall-clock ms since epoch. */
  readonly installedAt: number;
}

/** Persistence for install records (B6 can back it with a profile document). */
export interface PluginInstallStorage {
  /** Stored records as untrusted data (validated by the host); empty when none. */
  load(): Promise<readonly unknown[]>;
  save(records: readonly PluginInstallRecord[]): Promise<void>;
}

/** Reads a plugin's files (paths relative to its folder, already checked to be safe). */
export interface PluginFiles {
  readText(path: string): Promise<string>;
}

/** Options for `createPluginHost`. */
export interface PluginHostOptions {
  readonly kernel: Kernel;
  readonly host: HostBridge;
  readonly firstParty: readonly FirstPartyPlugin[];
  readonly validateLayout: LayoutValidator;
  readonly consent: ConsentPrompt;
  /** Developer mode: side-loaded plugins load. */
  readonly developerMode?: boolean;
  /**
   * Runtime for community logic and custom-UI plugins (B10). Without it
   * those plugins are `blocked` ("no runtime available").
   */
  readonly runtime?: PluginRuntime;
  /** Default: in memory (decisions are lost on restart). */
  readonly consentStorage?: ConsentStorage;
  /** Default: in memory. */
  readonly installStorage?: PluginInstallStorage;
  /** Private storage per plugin; `ProfileStore.pluginData(id)` satisfies it. Default: in memory. */
  readonly pluginStorage?: (pluginId: string) => PrivateStorageApi;
  /** Reads files of an installed plugin folder. Default: `host.files.readText(<folder>/<path>)`. */
  readonly files?: (folder: string) => PluginFiles;
  /** Optional services exposed through the plugin API. */
  readonly services?: Pick<PluginApiServices, 'listVoices' | 'speechEvents' | 'gazeSamples'>;
  /** Default: `host.platform.appVersion`. */
  readonly appVersion?: string;
  /** Default: derived from `host.platform` (`pluginPlatformOf`). */
  readonly platform?: PluginPlatform;
  /** Upper bound for a plugin's `activate`/`deactivate`, ms. Default 10 000. */
  readonly lifecycleTimeoutMs?: number;
  readonly reportError?: ErrorReporter;
}

/** Subscribes to a stream of events from a service the kernel does not own. */
export type EventSource<T> = (listener: (event: T) => void) => Disposable;

/** Services `createPluginApi` builds on besides the kernel. */
export interface PluginApiServices {
  /** The plugin's private storage; `ProfileStore.pluginData(id)` from `@forsee/storage` satisfies it. */
  readonly storage: PrivateStorageApi;
  /** Validates layouts the plugin registers (`@forsee/layouts`). */
  readonly validateLayout: LayoutValidator;
  /** Host-wide panel target registry; panel calls reject with `unavailable` without it. */
  readonly panels?: PanelTargetStore;
  /** The host's inference service; `ForseeApi.inference` is absent without it. */
  readonly inference?: InferenceService;
  /** Voices for `speech.listVoices`. Default: every registered voice provider. */
  readonly listVoices?: () => Promise<readonly Voice[]>;
  /**
   * Speech progress events for `speech.event` subscriptions. The API drops
   * word boundaries and replaces error messages for plugins without
   * `composition.read`, so the source can pass events unfiltered.
   */
  readonly speechEvents?: EventSource<SpeechEvent>;
  /** Raw gaze samples for `gaze.sample` subscriptions. */
  readonly gazeSamples?: EventSource<GazeSample>;
  /**
   * Holder of the plugin's settings schema, shared with the loader that
   * registered `contributes.settings`, so `settings.registerSchema` replaces
   * it. Default: a holder owned by the session.
   */
  readonly settingsSchema?: SettingsSchemaHolder;
  /** Where errors thrown by the plugin's listeners go. */
  readonly reportError?: ErrorReporter;
}

/** Registers (and replaces) one plugin's settings schema. */
export interface SettingsSchemaHolder extends Disposable {
  /** Throws `invalid-argument` for an invalid schema, keeping the previous one. */
  replace(fields: readonly SettingField[]): void;
}

/** The plugin a `ForseeApi` is bound to. */
export interface PluginIdentity {
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
}

/**
 * A `ForseeApi` bound to one plugin plus the host-side handle that tears it
 * down. Hand `api` to the plugin (directly, or behind the RPC layer); keep
 * `dispose` for the host.
 */
export interface PluginApiSession extends Disposable {
  readonly api: ForseeApi;
  readonly pluginId: string;
  readonly disposed: boolean;
}

/**
 * Builds the `ForseeApi` object for one plugin on top of the kernel,
 * enforcing permissions on every call. Used directly for first-party plugins
 * and behind the RPC layer for sandboxed ones.
 */
export type PluginApiFactory = (
  kernel: Kernel,
  plugin: PluginIdentity,
  permissions: PermissionManager,
  services: PluginApiServices,
) => PluginApiSession;

// ------------------------------------------------------------------ B9: panels

/** Targets of one panel as registered by its plugin (rectangles relative to the panel frame). */
export interface PanelTargetSet {
  /** Global panel id, `<pluginId>/<panelId>`. */
  readonly panelId: string;
  readonly pluginId: string;
  readonly targets: readonly PanelTarget[];
}

/**
 * Read side of the panel target registry, for the UI and B10: they translate
 * the panel-relative rectangles into viewport targets and report activations.
 */
export interface PanelTargetRegistry {
  /** Targets of a panel (global id), empty if none. */
  get(panelId: string): readonly PanelTarget[];
  list(): readonly PanelTargetSet[];
  /** Called with the global panel id whenever a panel's targets change. */
  onDidChange(listener: (panelId: string) => void): Disposable;
  /**
   * Delivers an activation of a panel target to the owning plugin. Returns
   * false (and delivers nothing) if the panel or target is unknown.
   */
  activate(panelId: string, targetId: string, repeatIndex: number): boolean;
}

/** Write side used by plugin API sessions. */
export interface PanelTargetStore extends PanelTargetRegistry {
  set(pluginId: string, localPanelId: string, targets: readonly PanelTarget[]): void;
  clear(pluginId: string): void;
  onActivate(pluginId: string, listener: (activation: PanelActivation) => void): Disposable;
}

// ------------------------------------------------------------------ B9: permissions and consent

/**
 * Why a consent record was written.
 * - `install`: the install prompt (scopes in `permissions`).
 * - `first-use`: the first-use prompt (sensitive scopes, `optionalPermissions`).
 * - `first-party`: granted without prompting to a first-party plugin's `permissions`.
 * - `revoke` / `grant`: changed by the user in the permission settings.
 */
export type ConsentReason = 'install' | 'first-use' | 'first-party' | 'revoke' | 'grant';

/** A recorded consent decision (persisted per plugin in the profile). */
export interface ConsentRecord {
  readonly pluginId: string;
  readonly scope: PermissionScope;
  readonly granted: boolean;
  /** Wall-clock ms since epoch. */
  readonly decidedAt: number;
  /** Plugin version the decision was made for. */
  readonly version: string;
  /** App version the decision was made in. */
  readonly appVersion: string;
  readonly reason: ConsentReason;
}

/** Persistence for consent records (latest decision per plugin and scope). */
export interface ConsentStorage {
  /** Stored records as untrusted data (validated on load); empty when none. */
  load(): Promise<readonly unknown[]>;
  save(records: readonly ConsentRecord[]): Promise<void>;
}

/** Asks the user (or caregiver) for consent; implemented by the UI. */
export interface ConsentPrompt {
  /** Resolves true if granted. `reason` is `install` or `first-use`. */
  ask(request: {
    readonly manifest: PluginManifest;
    readonly scopes: readonly PermissionScope[];
    readonly reason: 'install' | 'first-use';
  }): Promise<boolean>;
}

/**
 * Decides what each plugin may do. Install-time consent covers
 * `permissions`; `SENSITIVE_PERMISSION_SCOPES` additionally need first-use
 * consent; `optionalPermissions` are asked for at first use (or via
 * `ForseeApi.permissions.request`). Consent can be revoked.
 */
export interface PermissionManager {
  /** Whether the plugin holds the scope right now, without prompting. */
  has(pluginId: string, scope: PermissionScope): boolean;
  /** Ensures consent for a scope, prompting if needed. Resolves false if refused or undeclared. */
  ensure(pluginId: string, scope: PermissionScope): Promise<boolean>;
  /** Withdraws a scope at once (subsequent calls are denied; dependent registrations are disposed). */
  revoke(pluginId: string, scope: PermissionScope): Promise<void>;
  /** Grants a declared scope on the user's explicit request (permission settings). Resolves false if undeclared. */
  grant(pluginId: string, scope: PermissionScope): Promise<boolean>;
  records(pluginId?: string): readonly ConsentRecord[];
  onDidChange(listener: (pluginId: string) => void): Disposable;
}

// ------------------------------------------------------------------ B9/B10: runtimes

/** Health of a running plugin instance. */
export interface PluginHealth {
  readonly status: 'ok' | 'unresponsive' | 'crashed' | 'terminated';
  readonly detail?: string;
}

/**
 * One loaded plugin in a runtime. The in-process runtime (first-party) is
 * built in; B10 provides the sandboxed one.
 */
export interface PluginRuntimeInstance {
  /**
   * Activates the plugin with the host-side API. A sandbox runtime serves
   * `api` over RPC (see `invokeApiMethod`) and calls the plugin's `activate`.
   * Rejects if the plugin's `activate` throws.
   */
  activate(api: ForseeApi): Promise<void>;
  /** Calls the plugin's `deactivate`, if any. The host bounds it with a timeout. */
  deactivate(): Promise<void>;
  /** Stops the instance at once (removes frame and worker). Idempotent. */
  terminate(): void;
  health(): PluginHealth;
  /** Called once if the instance dies on its own (worker crash, frame gone). */
  onDidCrash(listener: (error: ForseeErrorData) => void): Disposable;
}

/** Runs `logic` and `custom-ui` plugins. B10 implements it with sandboxed frames and workers. */
export interface PluginRuntime {
  /** For diagnostics, for example `"sandbox"`. */
  readonly name: string;
  /** `true` if it can run the plugin here, else a user-presentable reason. */
  supports(plugin: InstalledPlugin): true | string;
  /** Loads the plugin's code (`manifest.main`, panel entries) without activating it. */
  load(plugin: InstalledPlugin, files: PluginFiles): Promise<PluginRuntimeInstance>;
}

// ------------------------------------------------------------------ B10: sandbox and RPC

/** One end of a message channel (a `MessagePort`, a worker, or a test double). */
export interface RpcTransport {
  post(message: RpcMessage): void;
  onMessage(listener: (message: RpcMessage) => void): Disposable;
}

/**
 * Turns a transport into calls: the host side serves a `ForseeApi`, the
 * plugin side gets a proxy `ForseeApi`. B10 provides both ends.
 */
export interface RpcEndpoint extends Disposable {
  /** Calls a method on the other side. */
  call(method: string, params: readonly unknown[]): Promise<unknown>;
}

/** A running sandboxed plugin. */
export interface SandboxedPlugin extends Disposable {
  readonly pluginId: string;
  readonly transport: RpcTransport;
}

/**
 * Creates sandboxed frames (opaque origin, CSP without network unless
 * granted) with a worker inside for logic, and frames placed in regions for
 * custom-UI panels. B10 builds its `PluginRuntime` on top of it.
 */
export interface SandboxRuntime {
  startLogic(plugin: InstalledPlugin, readEntry: () => Promise<string>): Promise<SandboxedPlugin>;
  /** Mounts a panel frame; the host positions it over `rect`. The frame never receives pointer events. */
  mountPanel(plugin: InstalledPlugin, panelId: string, container: HTMLElement): Promise<PanelFrame>;
}

/** A mounted custom-UI panel frame. */
export interface PanelFrame extends Disposable {
  readonly panelId: string;
  /** Frame bounds in app viewport CSS pixels, used to translate `PanelTarget` rects. */
  readonly bounds: Rect;
  /** Targets the panel registered, in frame coordinates. */
  readonly targets: readonly PanelTarget[];
}
