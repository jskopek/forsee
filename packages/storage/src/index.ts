/**
 * @forsee/storage — the profile folder: store, settings, JSONL history with
 * ids and clocks, crash-recovery snapshot, migrations, export/import (work
 * package B6). Contracts are in `contracts.ts`.
 */
export * from './contracts';

/** Package name, for diagnostics. */
export const STORAGE_PACKAGE = '@forsee/storage';
