import type {
  CompositionPersistence,
  CompositionSnapshot,
  ProfileFileSystem,
  SettingsPersistence,
} from '@forsee/core';
import type { JsonValue, ProfileMetadata, SettingsSnapshot } from '@forsee/plugin-api';
import { exportProfile } from './archive';
import {
  PROFILE_PATHS,
  type DocumentCollection,
  type DocumentOptions,
  type HistoryStore,
  type JsonDocument,
  type MigrationContext,
  type OpenProfileOptions,
  type OpenProfileResult,
  type PluginDataStore,
  type ProfileStore,
  type Store,
} from './contracts';
import { createDocumentCollection, createJsonDocument } from './documents';
import { StorageError } from './errors';
import { FileStore } from './file-store';
import { HistoryLog } from './history';
import {
  CURRENT_SCHEMA_VERSION,
  metadataToJson,
  PROFILE_MIGRATIONS,
  runMigrations,
  validateProfileMetadata,
} from './migrations';
import { createPluginDataStore } from './plugin-data';

interface SettingsFile {
  readonly version: 1;
  readonly values: SettingsSnapshot;
}

/** `settings.json` as the kernel's `SettingsPersistence`. */
function createSettingsPersistence(store: FileStore): SettingsPersistence {
  const path = PROFILE_PATHS.settings;
  return {
    async load() {
      const raw = await store.getDocument(path);
      if (raw === undefined) return {};
      const values =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, JsonValue | undefined>).values
          : undefined;
      if (typeof values !== 'object' || values === null || Array.isArray(values)) {
        throw new StorageError('corrupt', `${path} has no "values" object`);
      }
      return values as unknown as SettingsSnapshot;
    },
    save(snapshot) {
      const file: SettingsFile = { version: 1, values: snapshot };
      return store.putDocument(path, file as unknown as JsonValue);
    },
  };
}

/**
 * `state/composition.json` as the kernel's `CompositionPersistence`. A
 * snapshot that cannot be parsed (for example torn by a crash while writing)
 * is reported and treated as absent, so the user can always start typing.
 */
function createCompositionPersistence(store: FileStore): CompositionPersistence {
  const path = PROFILE_PATHS.compositionSnapshot;
  return {
    async load() {
      try {
        return await store.getDocument(path);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'corrupt') {
          store.report(error, `storage.composition.corrupt:${path}`);
          return undefined;
        }
        throw error;
      }
    },
    save(snapshot: CompositionSnapshot) {
      return store.putDocument(path, snapshot as unknown as JsonValue);
    },
  };
}

class OpenProfile implements ProfileStore {
  readonly store: Store;
  readonly settings: SettingsPersistence;
  readonly history: HistoryStore;
  readonly composition: CompositionPersistence;

  constructor(
    readonly metadata: ProfileMetadata,
    readonly files: ProfileFileSystem,
    private readonly fileStore: FileStore,
    private readonly wallNow: () => number,
    maxCachedHistoryMonths: number | undefined,
  ) {
    this.store = fileStore;
    this.settings = createSettingsPersistence(fileStore);
    this.history = new HistoryLog(fileStore, {
      ...(maxCachedHistoryMonths === undefined ? {} : { maxCachedMonths: maxCachedHistoryMonths }),
    });
    this.composition = createCompositionPersistence(fileStore);
  }

  pluginData(pluginId: string): PluginDataStore {
    return createPluginDataStore(this.fileStore, pluginId);
  }

  document<T = JsonValue>(path: string, options?: DocumentOptions<T>): JsonDocument<T> {
    return createJsonDocument(this.fileStore, path, options);
  }

  collection<T = JsonValue>(
    directory: string,
    options?: DocumentOptions<T>,
  ): DocumentCollection<T> {
    return createDocumentCollection(this.fileStore, directory, options);
  }

  flush(): Promise<void> {
    return this.fileStore.flush();
  }

  async exportArchive(): Promise<Uint8Array> {
    await this.flush();
    return exportProfile(this.files, this.wallNow());
  }
}

/**
 * Opens the profile in `files`, creating it on first run (new profile id and
 * device id, current schema) and migrating an older schema step by step.
 * Refuses a profile written by a newer schema (`newer-schema`) without
 * changing anything. Hand the result to the kernel:
 *
 * ```ts
 * const { store } = await openProfile(host.files, { appVersion, newId: () => host.ids.uuid(), wallNow: () => host.clock.wallNow() });
 * const kernel = createKernel({
 *   clock: host.clock, ids: host.ids, deviceId: store.metadata.deviceId,
 *   persistence: { settings: store.settings, conversation: store.history, composition: store.composition },
 * });
 * ```
 */
export async function openProfile(
  files: ProfileFileSystem,
  options: OpenProfileOptions,
): Promise<OpenProfileResult> {
  const fileStore = new FileStore(files, {
    ...(options.reportError ? { reportError: options.reportError } : {}),
  });
  const path = PROFILE_PATHS.profile;

  let raw: JsonValue | undefined;
  try {
    raw = await fileStore.getDocument(path);
  } catch (cause) {
    throw new StorageError('invalid-profile', 'profile.json cannot be read', { cause });
  }

  const open = (metadata: ProfileMetadata): ProfileStore =>
    new OpenProfile(metadata, files, fileStore, options.wallNow, options.maxCachedHistoryMonths);

  if (raw === undefined) {
    const metadata: ProfileMetadata = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: options.newId(),
      name: options.name ?? 'Profile',
      deviceId: options.newId(),
      createdAt: options.wallNow(),
      appVersion: options.appVersion,
    };
    await fileStore.putDocument(path, metadataToJson(metadata));
    return { store: open(metadata), created: true, migrations: [] };
  }

  const context: MigrationContext = {
    files,
    newId: options.newId,
    wallNow: options.wallNow,
    appVersion: options.appVersion,
  };
  const { profile, applied } = await runMigrations(
    raw,
    options.migrations ?? PROFILE_MIGRATIONS,
    CURRENT_SCHEMA_VERSION,
    context,
    (migrated) => fileStore.putDocument(path, migrated as JsonValue),
  );
  let metadata = validateProfileMetadata(profile);
  if (metadata.appVersion !== options.appVersion) {
    metadata = { ...metadata, appVersion: options.appVersion };
    await fileStore.putDocument(path, metadataToJson(metadata));
  }
  return { store: open(metadata), created: false, migrations: applied };
}
