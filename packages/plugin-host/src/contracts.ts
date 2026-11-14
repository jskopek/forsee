import type { Kernel } from '@forsee/core';
import type { HostBridge } from '@forsee/host';
import type { LayoutValidator } from '@forsee/layouts';
import type {
  Disposable,
  ForseeApi,
  PanelTarget,
  PermissionScope,
  PluginManifest,
  PluginModule,
  PrivateStorageApi,
  Rect,
  RpcMessage,
  TrustTier,
  ValidationResult,
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

/** Validates untrusted JSON into a manifest (rules on `PluginManifest`). */
export type ManifestValidator = (json: unknown) => ValidationResult<PluginManifest>;

/** Trust tier implied by a manifest (`TrustTier` docs). Pure. */
export type TrustTierOf = (manifest: PluginManifest) => TrustTier;

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
}

/** Lifecycle state of a plugin in this session. */
export type PluginState = 'disabled' | 'blocked' | 'loading' | 'active' | 'failed';

/** A first-party plugin: manifest plus in-process module. */
export interface FirstPartyPlugin {
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
}

/** The plugin host facade B9 provides as `createPluginHost(options)`. */
export interface PluginHost extends Disposable {
  list(): readonly (InstalledPlugin & { readonly state: PluginState })[];
  /** Loads every enabled plugin allowed by restricted mode. */
  start(): Promise<void>;
  enable(pluginId: string): Promise<void>;
  /** Disposes everything the plugin registered (`ExtensionRegistry.disposeOwner`, commands, context). */
  disable(pluginId: string): Promise<void>;
  /** Restricted mode (on by default): community code does not run. Declarative plugins still load. */
  readonly restrictedMode: boolean;
  setRestrictedMode(on: boolean): Promise<void>;
  readonly permissions: PermissionManager;
  onDidChange(listener: () => void): Disposable;
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
  /** Runtime for logic and custom-UI plugins (B10); without it those plugins are `blocked`. */
  readonly sandbox?: SandboxRuntime;
}

/**
 * Builds the `ForseeApi` object for one plugin on top of the kernel and host,
 * enforcing permissions on every call. Used directly for first-party plugins
 * and behind the RPC layer for sandboxed ones.
 */
export type PluginApiFactory = (context: {
  readonly kernel: Kernel;
  readonly host: HostBridge;
  readonly manifest: PluginManifest;
  readonly permissions: PermissionManager;
  /** The plugin's private storage; `ProfileStore.pluginData(id)` from `@forsee/storage` satisfies it. */
  readonly storage: PrivateStorageApi;
}) => ForseeApi;

// ------------------------------------------------------------------ B9: permissions and consent

/** A recorded consent decision (persisted per plugin in the profile). */
export interface ConsentRecord {
  readonly pluginId: string;
  readonly scope: PermissionScope;
  readonly granted: boolean;
  /** Wall-clock ms since epoch. */
  readonly decidedAt: number;
  /** Plugin version the decision was made for. */
  readonly version: string;
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
 * consent; `optionalPermissions` are asked for only via
 * `ForseeApi.permissions.request`. Consent can be revoked.
 */
export interface PermissionManager {
  has(pluginId: string, scope: PermissionScope): boolean;
  /** Ensures consent for a scope, prompting if needed. Resolves false if refused or undeclared. */
  ensure(pluginId: string, scope: PermissionScope): Promise<boolean>;
  revoke(pluginId: string, scope: PermissionScope): Promise<void>;
  records(pluginId?: string): readonly ConsentRecord[];
  onDidChange(listener: (pluginId: string) => void): Disposable;
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
 * custom-UI panels.
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
