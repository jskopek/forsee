import { MemoryFileSystem, type ErrorReporter, type ProfileFileSystem } from '@forsee/core';
import { createBrowserFileSystem, type BrowserFileSystem, type HostBridge } from '@forsee/host';
import type { JsonValue } from '@forsee/plugin-api';
import type {
  ConsentRecord,
  ConsentStorage,
  PluginInstallRecord,
  PluginInstallStorage,
} from '@forsee/plugin-host';
import {
  openProfile,
  StorageError,
  type OpenProfileResult,
  type ProfileStore,
} from '@forsee/storage';

/** Consent decisions of the plugin host, in the profile. */
export const PLUGIN_CONSENT_PATH = 'state/plugin-consent.json';
/** Plugin install records (enabled flags, provenance), in the profile. */
export const PLUGIN_INSTALL_PATH = 'state/plugins.json';

interface RecordsFile {
  readonly schemaVersion: 1;
  readonly records: readonly JsonValue[];
}

/**
 * A list of records in one profile document (`{ schemaVersion, records }`).
 * Records are returned as untrusted data; the plugin host validates them.
 */
function recordList<T>(
  profile: ProfileStore,
  path: string,
): {
  load(): Promise<readonly unknown[]>;
  save(records: readonly T[]): Promise<void>;
} {
  const document = profile.document(path);
  return {
    async load() {
      const raw = await document.read();
      if (raw === undefined) return [];
      const records =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, JsonValue | undefined>).records
          : undefined;
      if (!Array.isArray(records)) {
        throw new StorageError('corrupt', `${path} has no "records" list`);
      }
      return records as readonly unknown[];
    },
    save(records) {
      const file: RecordsFile = { schemaVersion: 1, records: records as unknown as JsonValue[] };
      return document.write(file as unknown as JsonValue);
    },
  };
}

/** The plugin host's consent storage on the profile. */
export function profileConsentStorage(profile: ProfileStore): ConsentStorage {
  return recordList<ConsentRecord>(profile, PLUGIN_CONSENT_PATH);
}

/** The plugin host's install storage on the profile. */
export function profileInstallStorage(profile: ProfileStore): PluginInstallStorage {
  return recordList<PluginInstallRecord>(profile, PLUGIN_INSTALL_PATH);
}

/** Host, storage and profile as the runtime opened them. */
export interface OpenedProfile {
  readonly host: HostBridge;
  readonly storage: BrowserFileSystem;
  readonly opened: OpenProfileResult;
  /** Why the runtime fell back to memory, if it did. */
  readonly warning?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memoryStorage(): BrowserFileSystem {
  return { files: new MemoryFileSystem(), kind: 'memory', persistent: false };
}

/**
 * Picks the storage backend, builds the host on it and opens (or creates)
 * the profile. If the storage cannot be opened, or the profile in it cannot
 * be read (corrupt, or written by a newer app), everything is opened in
 * memory instead, the stored profile is left untouched, and `warning` says
 * why. Only a failure to open even the in-memory profile rejects.
 */
export async function openHostAndProfile(options: {
  readonly storage: () => Promise<BrowserFileSystem>;
  readonly createHost: (files: ProfileFileSystem, persistent: boolean) => HostBridge;
  readonly appVersion: string;
  readonly reportError: ErrorReporter;
}): Promise<OpenedProfile> {
  const open = (host: HostBridge): Promise<OpenProfileResult> =>
    openProfile(host.files, {
      appVersion: options.appVersion,
      newId: () => host.ids.uuid(),
      wallNow: () => host.clock.wallNow(),
      reportError: options.reportError,
    });

  let failure = 'Profile storage is not available.';
  let storage: BrowserFileSystem | undefined;
  try {
    storage = await options.storage();
  } catch (error) {
    options.reportError(error, 'runtime.storage');
    failure = `Profile storage is not available (${messageOf(error)}).`;
  }
  if (storage) {
    const host = options.createHost(storage.files, storage.persistent);
    try {
      return { host, storage, opened: await open(host) };
    } catch (error) {
      options.reportError(error, 'runtime.profile.open');
      host.dispose();
      failure = `The saved profile could not be opened (${messageOf(error)}).`;
    }
  }
  const memory = memoryStorage();
  const host = options.createHost(memory.files, false);
  return {
    host,
    storage: memory,
    opened: await open(host),
    warning: `${failure} Forsee is running on temporary storage: nothing you type, say or change will be kept after this page closes.`,
  };
}

/** The default storage: OPFS, then IndexedDB, then memory, reporting why each fallback happened. */
export function defaultStorage(reportError: ErrorReporter): () => Promise<BrowserFileSystem> {
  return () =>
    createBrowserFileSystem({
      onFallback: (from, reason) => reportError(reason, `runtime.storage.fallback:${from}`),
    });
}
