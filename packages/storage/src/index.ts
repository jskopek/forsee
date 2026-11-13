/**
 * @forsee/storage — the profile folder: store, settings, JSONL history with
 * ids and clocks, crash-recovery snapshot, migrations, export/import (work
 * package B6). Contracts are in `contracts.ts`.
 *
 * Everything goes through the injected `ProfileFileSystem`; this package
 * never touches the DOM or Node. Start with `openProfile`.
 */
export * from './contracts';
export { exportProfile, importArchive, type ImportOptions } from './archive';
export { createDocumentCollection, createJsonDocument } from './documents';
export { isStorageError, StorageError, type StorageErrorCode } from './errors';
export { FileStore, type FileStoreOptions } from './file-store';
export { HistoryLog, monthKey, parseHistoryRecord, type HistoryLogOptions } from './history';
export {
  CURRENT_SCHEMA_VERSION,
  PROFILE_MIGRATIONS,
  runMigrations,
  type MigrationOutcome,
} from './migrations';
export { assertPluginId, assertSafePath, assertSafeSegment } from './paths';
export { createPluginDataStore, pluginDataPath } from './plugin-data';
export { openProfile } from './profile';
export { WriteQueue } from './write-queue';

/** Package name, for diagnostics. */
export const STORAGE_PACKAGE = '@forsee/storage';
