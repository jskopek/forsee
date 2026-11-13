import type {
  CompositionPersistence,
  ConversationPersistence,
  ProfileFileSystem,
  SettingsPersistence,
} from '@forsee/core';
import type { HistoryRecord, JsonValue, ProfileMetadata } from '@forsee/plugin-api';

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
  /** Writes a document atomically. */
  putDocument(path: string, value: JsonValue): Promise<void>;
  deleteDocument(path: string): Promise<void>;
  /** Document paths under a directory (non-recursive), sorted. */
  listDocuments(directory: string): Promise<readonly string[]>;
  /** Appends records as JSON lines, in order. */
  appendLog(path: string, records: readonly JsonValue[]): Promise<void>;
  /** Every record of a log, skipping (and reporting) unparseable lines such as a torn last line. */
  readLog(path: string): Promise<readonly JsonValue[]>;
}

/** History access beyond what the kernel needs: browsing, export, deletion. */
export interface HistoryStore extends ConversationPersistence {
  /** Records with `createdAt` in `[from, to)`, tombstones applied, oldest first. */
  listRange(from: number, to: number): Promise<readonly HistoryRecord[]>;
}

/** Key-value store for one plugin's private data (`plugins/<id>/data.json`). */
export interface PluginDataStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
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
  /** Zip of the whole profile folder. */
  exportArchive(): Promise<Uint8Array>;
}

/** Options for `openProfile`. */
export interface OpenProfileOptions {
  readonly appVersion: string;
  /** Used only when creating a profile. */
  readonly newId: () => string;
  readonly wallNow: () => number;
  /** Display name for a new profile. */
  readonly name?: string;
}

/** Replaces a profile's contents from an export archive (after confirmation in the UI). */
export type ProfileImporter = (files: ProfileFileSystem, archive: Uint8Array) => Promise<void>;
