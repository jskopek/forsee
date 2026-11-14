import { defaultErrorReporter, EventBus, type Clock, type ErrorReporter } from '@forsee/core';
import {
  NETWORK_PERMISSION_PREFIX,
  SENSITIVE_PERMISSION_SCOPES,
  type Disposable,
  type PermissionScope,
  type PluginManifest,
} from '@forsee/plugin-api';
import type {
  ConsentPrompt,
  ConsentReason,
  ConsentRecord,
  ConsentStorage,
  PermissionManager,
  PluginOrigin,
} from './contracts';
import { isPlainObject } from './guards';
import { isPermissionScope, isPluginIdSyntax } from './manifest';

/** Options for `PluginPermissionManager`. */
export interface PermissionManagerOptions {
  readonly consent: ConsentPrompt;
  readonly clock: Pick<Clock, 'wallNow'>;
  /** Running app version, stored with each decision. */
  readonly appVersion: string;
  /** Default: in memory. */
  readonly storage?: ConsentStorage;
  readonly reportError?: ErrorReporter;
}

interface Registration {
  readonly manifest: PluginManifest;
  readonly origin: PluginOrigin;
}

const CONSENT_REASONS: readonly ConsentReason[] = [
  'install',
  'first-use',
  'first-party',
  'revoke',
  'grant',
];

/** Whether a scope needs first-use consent even after install consent. */
export function isSensitiveScope(scope: PermissionScope): boolean {
  return (SENSITIVE_PERMISSION_SCOPES as readonly string[]).includes(scope);
}

/** Consent storage that keeps records in memory (tests, and the default). */
export class MemoryConsentStorage implements ConsentStorage {
  private stored: readonly unknown[];
  /** Number of `save` calls, for tests. */
  saves = 0;

  constructor(initial: readonly unknown[] = []) {
    this.stored = initial;
  }

  load(): Promise<readonly unknown[]> {
    return Promise.resolve(this.stored);
  }

  save(records: readonly ConsentRecord[]): Promise<void> {
    this.saves += 1;
    // Round-trip through JSON like a file would.
    this.stored = JSON.parse(JSON.stringify(records)) as unknown[];
    return Promise.resolve();
  }

  /** What a file would contain now. */
  get records(): readonly unknown[] {
    return this.stored;
  }
}

function parseRecord(value: unknown): ConsentRecord | null {
  if (!isPlainObject(value)) return null;
  const { pluginId, scope, granted, decidedAt, version, appVersion, reason } = value;
  if (
    !isPluginIdSyntax(pluginId) ||
    !isPermissionScope(scope) ||
    typeof granted !== 'boolean' ||
    typeof decidedAt !== 'number' ||
    !Number.isFinite(decidedAt) ||
    typeof version !== 'string' ||
    typeof appVersion !== 'string' ||
    !CONSENT_REASONS.includes(reason as ConsentReason)
  ) {
    return null;
  }
  return {
    pluginId,
    scope,
    granted,
    decidedAt,
    version,
    appVersion,
    reason: reason as ConsentReason,
  };
}

/**
 * The permission manager. One record per plugin and scope holds the latest
 * decision (see `ConsentRecord`), persisted through `ConsentStorage`.
 *
 * Rules:
 * - A scope must be declared in the manifest (`permissions` or
 *   `optionalPermissions`); anything else is never held and never prompted
 *   for. `network:<host>` scopes match the declared host exactly.
 * - `permissions` are granted by one install prompt (`requestInstall`).
 *   First-party plugins get them without prompting, nothing more.
 * - A sensitive scope (`SENSITIVE_PERMISSION_SCOPES`) in `permissions` is
 *   held only after a second, first-use prompt (`ensure`), except for
 *   first-party plugins. A scope in `optionalPermissions` is held only after
 *   a first-use prompt.
 * - A refusal at first use, and a revocation, are remembered: `ensure` does
 *   not ask again; the user can `grant` from the permission settings.
 * - Prompts are shown one at a time; concurrent `ensure` calls for the same
 *   plugin and scope share one prompt.
 * - Every change emits `onDidChange(pluginId)` synchronously, before the
 *   change is persisted, so API sessions can drop dependent registrations at once.
 */
export class PluginPermissionManager implements PermissionManager {
  private readonly consent: ConsentPrompt;
  private readonly clock: Pick<Clock, 'wallNow'>;
  private readonly appVersion: string;
  private readonly storage: ConsentStorage;
  private readonly reportError: ErrorReporter;
  private readonly events: EventBus<{ changed: string }>;
  private readonly registrations = new Map<string, Registration>();
  /** pluginId → scope → latest record. */
  private readonly decisions = new Map<string, Map<string, ConsentRecord>>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private promptChain: Promise<unknown> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: PermissionManagerOptions) {
    this.consent = options.consent;
    this.clock = options.clock;
    this.appVersion = options.appVersion;
    this.storage = options.storage ?? new MemoryConsentStorage();
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.events = new EventBus({ onListenerError: this.reportError });
  }

  /** Loads stored records (malformed ones are skipped and reported). */
  async load(): Promise<void> {
    const raw = await this.storage.load();
    let skipped = 0;
    for (const value of raw) {
      const record = parseRecord(value);
      if (!record) {
        skipped += 1;
        continue;
      }
      this.decisionsOf(record.pluginId).set(record.scope, record);
    }
    if (skipped > 0) {
      this.reportError(new Error(`Skipped ${skipped} malformed consent records`), 'consent.load');
    }
  }

  /** Resolves when every save started so far has finished. */
  flush(): Promise<void> {
    return this.saveChain;
  }

  /**
   * Declares a plugin (its manifest and origin). First-party plugins are
   * granted their `permissions` without prompting, unless the user revoked one.
   */
  register(manifest: PluginManifest, origin: PluginOrigin): void {
    this.registrations.set(manifest.id, { manifest, origin });
    if (origin !== 'first-party') return;
    const decisions = this.decisionsOf(manifest.id);
    let changed = false;
    for (const scope of manifest.permissions ?? []) {
      if (decisions.has(scope)) continue;
      decisions.set(scope, this.record(manifest, scope, true, 'first-party'));
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Whether a plugin is registered. */
  isRegistered(pluginId: string): boolean {
    return this.registrations.has(pluginId);
  }

  /** Forgets a plugin's registration (it stays in the records). */
  unregister(pluginId: string): void {
    this.registrations.delete(pluginId);
  }

  /** Deletes every record of a plugin (uninstall). */
  forget(pluginId: string): void {
    this.registrations.delete(pluginId);
    if (this.decisions.delete(pluginId)) {
      this.events.emit('changed', pluginId);
      this.persist();
    }
  }

  /** Scopes in `permissions` that still need the install prompt. */
  pendingInstallScopes(pluginId: string): readonly PermissionScope[] {
    const registration = this.registrations.get(pluginId);
    if (!registration) return [];
    const decisions = this.decisions.get(pluginId);
    return (registration.manifest.permissions ?? []).filter((scope) => {
      const record = decisions?.get(scope);
      // Undecided, or refused at an earlier install prompt (the plugin was not installed then).
      return !record || (record.reason === 'install' && !record.granted);
    });
  }

  /**
   * Install-time consent: asks once for every scope in `permissions` that
   * has no decision yet. Resolves true when nothing is pending afterwards
   * (granted now or earlier, or later revoked by the user).
   */
  async requestInstall(pluginId: string): Promise<boolean> {
    const registration = this.registrations.get(pluginId);
    if (!registration) return false;
    const scopes = this.pendingInstallScopes(pluginId);
    if (scopes.length === 0) return true;
    const granted = await this.prompt(registration.manifest, scopes, 'install');
    if (granted === null) return false;
    const decisions = this.decisionsOf(pluginId);
    for (const scope of scopes) {
      decisions.set(scope, this.record(registration.manifest, scope, granted, 'install'));
    }
    this.events.emit('changed', pluginId);
    this.persist();
    return granted;
  }

  has(pluginId: string, scope: PermissionScope): boolean {
    const registration = this.registrations.get(pluginId);
    if (!registration || !isPermissionScope(scope)) return false;
    const { manifest, origin } = registration;
    const record = this.decisions.get(pluginId)?.get(scope);
    if (!record?.granted) return false;
    if (manifest.permissions?.includes(scope)) {
      if (record.reason !== 'install') return true;
      return !isSensitiveScope(scope) || origin === 'first-party';
    }
    if (manifest.optionalPermissions?.includes(scope)) {
      return record.reason === 'first-use' || record.reason === 'grant';
    }
    return false;
  }

  /** Exact hosts the plugin may reach now (from its held `network:<host>` scopes). */
  allowedNetworkHosts(pluginId: string): readonly string[] {
    const registration = this.registrations.get(pluginId);
    if (!registration) return [];
    const { manifest } = registration;
    return [...(manifest.permissions ?? []), ...(manifest.optionalPermissions ?? [])]
      .filter((scope) => scope.startsWith(NETWORK_PERMISSION_PREFIX) && this.has(pluginId, scope))
      .map((scope) => scope.slice(NETWORK_PERMISSION_PREFIX.length));
  }

  /** Whether the plugin may make requests to `host` (exact, case-insensitive match). */
  allowsHost(pluginId: string, host: string): boolean {
    return this.has(pluginId, `${NETWORK_PERMISSION_PREFIX}${host.toLowerCase()}`);
  }

  ensure(pluginId: string, scope: PermissionScope): Promise<boolean> {
    if (this.has(pluginId, scope)) return Promise.resolve(true);
    const registration = this.registrations.get(pluginId);
    if (!registration || !isPermissionScope(scope)) return Promise.resolve(false);
    const { manifest } = registration;
    const declaredInstall = manifest.permissions?.includes(scope) === true;
    const declaredOptional = manifest.optionalPermissions?.includes(scope) === true;
    if (!declaredInstall && !declaredOptional) return Promise.resolve(false);
    const record = this.decisions.get(pluginId)?.get(scope);
    // Install consent must come first; remembered refusals are not asked again.
    if (declaredInstall && !record?.granted) return Promise.resolve(false);
    if (record && !record.granted) return Promise.resolve(false);
    const key = `${pluginId}\u0000${scope}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const granted = await this.prompt(manifest, [scope], 'first-use');
      if (granted === null) return false;
      // The plugin may have been unregistered or the scope decided meanwhile.
      if (this.registrations.get(pluginId)?.manifest !== manifest) return false;
      this.decisionsOf(pluginId).set(scope, this.record(manifest, scope, granted, 'first-use'));
      this.events.emit('changed', pluginId);
      this.persist();
      return granted;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  revoke(pluginId: string, scope: PermissionScope): Promise<void> {
    const registration = this.registrations.get(pluginId);
    const decisions = this.decisions.get(pluginId);
    const record = decisions?.get(scope);
    if (!decisions || !record) return Promise.resolve();
    const version = registration?.manifest.version ?? record.version;
    decisions.set(scope, {
      pluginId,
      scope,
      granted: false,
      decidedAt: this.clock.wallNow(),
      version,
      appVersion: this.appVersion,
      reason: 'revoke',
    });
    this.events.emit('changed', pluginId);
    this.persist();
    return this.saveChain;
  }

  grant(pluginId: string, scope: PermissionScope): Promise<boolean> {
    const registration = this.registrations.get(pluginId);
    if (!registration || !isPermissionScope(scope)) return Promise.resolve(false);
    const { manifest } = registration;
    if (!manifest.permissions?.includes(scope) && !manifest.optionalPermissions?.includes(scope)) {
      return Promise.resolve(false);
    }
    this.decisionsOf(pluginId).set(scope, this.record(manifest, scope, true, 'grant'));
    this.events.emit('changed', pluginId);
    this.persist();
    return this.saveChain.then(() => true);
  }

  records(pluginId?: string): readonly ConsentRecord[] {
    const out: ConsentRecord[] = [];
    for (const [id, decisions] of this.decisions) {
      if (pluginId !== undefined && id !== pluginId) continue;
      out.push(...decisions.values());
    }
    return out;
  }

  onDidChange(listener: (pluginId: string) => void): Disposable {
    return this.events.on('changed', listener);
  }

  dispose(): void {
    this.events.dispose();
  }

  private decisionsOf(pluginId: string): Map<string, ConsentRecord> {
    let decisions = this.decisions.get(pluginId);
    if (!decisions) {
      decisions = new Map();
      this.decisions.set(pluginId, decisions);
    }
    return decisions;
  }

  private record(
    manifest: PluginManifest,
    scope: PermissionScope,
    granted: boolean,
    reason: ConsentReason,
  ): ConsentRecord {
    return {
      pluginId: manifest.id,
      scope,
      granted,
      decidedAt: this.clock.wallNow(),
      version: manifest.version,
      appVersion: this.appVersion,
      reason,
    };
  }

  /** Shows one prompt at a time. Resolves `null` if the prompt failed (nothing is recorded). */
  private prompt(
    manifest: PluginManifest,
    scopes: readonly PermissionScope[],
    reason: 'install' | 'first-use',
  ): Promise<boolean | null> {
    const run = async (): Promise<boolean | null> => {
      try {
        return (await this.consent.ask({ manifest, scopes: [...scopes], reason })) === true;
      } catch (error) {
        this.reportError(error, `consent.${reason}:${manifest.id}`);
        return null;
      }
    };
    const result = this.promptChain.then(run, run);
    this.promptChain = result;
    return result;
  }

  private persist(): void {
    const snapshot = this.records();
    this.saveChain = this.saveChain
      .then(() => this.storage.save(snapshot))
      .catch((error: unknown) => this.reportError(error, 'consent.save'));
  }
}
