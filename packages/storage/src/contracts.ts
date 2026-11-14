import type {
  CompositionPersistence,
  ConversationPersistence,
  ProfileFileSystem,
  SettingsPersistence,
} from '@forsee/core';
import type { ErrorReporter } from '@forsee/core';
import type {
  HistoryRecord,
  JsonValue,
  ProfileMetadata,
  UtteranceRecord,
  ValidationResult,
} from '@forsee/plugin-api';

/**
 * Contracts of the storage package (B6 implements them; the kernel and
 * every plugin-data consumer use them). Storage is plain files in a profile
 * folder (plan section 7), reached only through `ProfileFileSystem` from
 * `@forsee/core`; this package never touches the DOM or Node directly.
 *
 * Profile folder layout (paths relative to the profile root):
 *
 *   profile.json            ProfileMetadata
 *   settings.json           SettingsSnapshot
 *   layouts/*.json          user layouts (LayoutDefinition)
 *   phrases/*.json          phrase sets (PhraseSet); recordings in phrases/audio/
 *   history/YYYY-MM.jsonl   append-only HistoryRecord lines, by createdAt month (UTC)
 *   lm/user-counts.json     personal language data (UserModel.serialise())
 *   plugins/<id>/           installed plugins; private data in plugins/<id>/data.json
 *   state/composition.json  CompositionSnapshot
 *   state/regions.json      RegionsSnapshot
 */

export type {
  HistoryRecord,
  ProfileMetadata,
  TombstoneRecord,
  UtteranceRecord,
} from '@forsee/plugin-api';
export type {
  CompositionPersistence,
  ConversationPersistence,
  ProfileFileSystem,
  SettingsPersistence,
} from '@forsee/core';

/** Well-known profile paths. */
export const PROFILE_PATHS = {
  profile: 'profile.json',
  settings: 'settings.json',
  layoutsDir: 'layouts',
  phrasesDir: 'phrases',
  phraseAudioDir: 'phrases/audio',
  historyDir: 'history',
  userLanguageModel: 'lm/user-counts.json',
  pluginsDir: 'plugins',
  compositionSnapshot: 'state/composition.json',
  regionsSnapshot: 'state/regions.json',
} as const;

/**
 * Low-level store: JSON documents and append-only JSON logs. The file
 * implementation maps keys to profile paths; a database could implement the
 * same interface later (plan section 7) without changing callers.
 */
export interface Store {
  /** Parsed document, or `undefined` if missing. Rejects on unparseable content. */
  getDocument(path: string): Promise<JsonValue | undefined>;
  /** Writes a document atomically (as far as the file system allows). */
  putDocument(path: string, value: JsonValue): Promise<void>;
  /**
   * Read-modify-write of one document, serialised with every other write to
   * it. `update` gets the current value (or `undefined`); returning
   * `undefined` deletes the document. Resolves with the stored value.
   * (Added by B6.)
   */
  updateDocument(
    path: string,
    update: (current: JsonValue | undefined) => JsonValue | undefined,
  ): Promise<JsonValue | undefined>;
  deleteDocument(path: string): Promise<void>;
  /** Document paths under a directory (non-recursive), sorted. */
  listDocuments(directory: string): Promise<readonly string[]>;
  /** Appends records as JSON lines, in order. */
  appendLog(path: string, records: readonly JsonValue[]): Promise<void>;
  /** Every record of a log, skipping (and reporting) unparseable lines such as a torn last line. */
  readLog(path: string): Promise<readonly JsonValue[]>;
  /** Resolves when every write submitted so far has finished. Never rejects. (Added by B6.) */
  flush(): Promise<void>;
}

/** History access beyond what the kernel needs: browsing, export, deletion. */
export interface HistoryStore extends ConversationPersistence {
  /** Records with `createdAt` in `[from, to)`, tombstones applied, oldest first. */
  listRange(from: number, to: number): Promise<readonly HistoryRecord[]>;
  /**
   * The newest `limit` utterances with tombstones applied, oldest first.
   * Reads only as many month files (newest first) as needed. (Added by B6.)
   */
  listRecent(limit: number): Promise<readonly UtteranceRecord[]>;
  /** Drops cached months; call after something else changed the folder, such as a file-sync tool. (Added by B6.) */
  invalidate(): void;
}

/** Key-value store for one plugin's private data (`plugins/<id>/data.json`). */
export interface PluginDataStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/** A single JSON file with an optional validation hook. (Added by B6.) */
export interface JsonDocument<T> {
  /** The validated document, or `undefined` if the file does not exist. Rejects if it is invalid. */
  read(): Promise<T | undefined>;
  /** Validates, then writes. Rejects with `invalid-document` if the hook rejects. */
  write(value: T): Promise<void>;
  delete(): Promise<void>;
}

/** A folder of `<name>.json` documents (layouts, phrase sets). (Added by B6.) */
export interface DocumentCollection<T> {
  /** Document names (file names without `.json`), sorted. */
  list(): Promise<readonly string[]>;
  /** The validated document, or `undefined` if missing. Rejects if it is invalid. */
  read(name: string): Promise<T | undefined>;
  /** Every valid document; invalid ones are skipped and reported. */
  readAll(): Promise<readonly { readonly name: string; readonly value: T }[]>;
  write(name: string, value: T): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Caller-supplied validation for documents: turn untrusted JSON into a `T` or list issues. */
export interface DocumentOptions<T> {
  readonly validate?: (value: unknown) => ValidationResult<T>;
}

/** Outcome of opening a profile. */
export interface OpenProfileResult {
  readonly store: ProfileStore;
  /** True if the profile was created now (first run). */
  readonly created: boolean;
  /** Migrations applied, by name, in order. */
  readonly migrations: readonly string[];
}

/**
 * One open profile. B6 provides `openProfile(files, options): Promise<OpenProfileResult>`
 * which creates `profile.json` on first run and migrates older schemas.
 * Its persistence members plug straight into `createKernel({ persistence })`.
 */
export interface ProfileStore {
  readonly metadata: ProfileMetadata;
  readonly files: ProfileFileSystem;
  readonly store: Store;
  readonly settings: SettingsPersistence;
  readonly history: HistoryStore;
  readonly composition: CompositionPersistence;
  pluginData(pluginId: string): PluginDataStore;
  /** One JSON file at a profile-relative path, for example `lm/user-counts.json`. (Added by B6.) */
  document<T = JsonValue>(path: string, options?: DocumentOptions<T>): JsonDocument<T>;
  /** A folder of `<name>.json` documents, for example `layouts`. (Added by B6.) */
  collection<T = JsonValue>(directory: string, options?: DocumentOptions<T>): DocumentCollection<T>;
  /** Resolves when every pending write has finished. Call before closing the app. (Added by B6.) */
  flush(): Promise<void>;
  /** Zip of the whole profile folder, after pending writes finish. */
  exportArchive(): Promise<Uint8Array>;
}

/** Options for `openProfile`. */
export interface OpenProfileOptions {
  readonly appVersion: string;
  /** Used only when creating a profile. */
  readonly newId: () => string;
  readonly wallNow: () => number;
  /** Display name for a new profile. Default `"Profile"`. */
  readonly name?: string;
  /**
   * Receives write failures and skipped corrupt lines (see `FileStore`).
   * Default: ignore. (Added by B6.)
   */
  readonly reportError?: ErrorReporter;
  /** Replaces the built-in migrations; for tests. (Added by B6.) */
  readonly migrations?: readonly ProfileMigration[];
  /** Maximum months of history kept parsed in memory. Default 4. (Added by B6.) */
  readonly maxCachedHistoryMonths?: number;
}

/** One step of the profile schema migration chain (see `migrations.ts`). (Added by B6.) */
export interface ProfileMigration {
  /** Schema version this step upgrades from. */
  readonly from: number;
  /** Schema version after this step. Must be greater than `from`. */
  readonly to: number;
  readonly name: string;
  /**
   * Upgrades the raw `profile.json` content and may touch other files. Must be
   * idempotent: a crash after the step ran but before the new schema version
   * was saved makes it run again.
   */
  run(
    profile: Record<string, unknown>,
    context: MigrationContext,
  ): Promise<Record<string, unknown>>;
}

/** What a migration may use. */
export interface MigrationContext {
  readonly files: ProfileFileSystem;
  readonly newId: () => string;
  readonly wallNow: () => number;
  readonly appVersion: string;
}

/**
 * Imports an export archive. Validates everything before writing; refuses a
 * non-empty target unless `overwrite` is set (after confirmation in the UI).
 * `importArchive` implements it with an optional third parameter.
 */
export type ProfileImporter = (files: ProfileFileSystem, archive: Uint8Array) => Promise<void>;
