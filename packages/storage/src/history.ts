import { compareHlc } from '@forsee/core';
import type { HistoryRecord, JsonValue, UtteranceRecord } from '@forsee/plugin-api';
import type { HistoryStore } from './contracts';
import { StorageError } from './errors';
import { isNotFound, type FileStore } from './file-store';

const HISTORY_DIR = 'history';
const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;

/** `YYYY-MM` of a wall-clock time, in UTC. */
export function monthKey(wallMs: number): string {
  const d = new Date(wallMs);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthPath(key: string): string {
  return `${HISTORY_DIR}/${key}.jsonl`;
}

/** Validates one parsed log line. Returns `undefined` for anything that is not a version 1 record. */
export function parseHistoryRecord(value: unknown): HistoryRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== 1) return undefined;
  if (typeof r.id !== 'string' || typeof r.deviceId !== 'string') return undefined;
  if (typeof r.hlc !== 'string' || !/^\d{15}-\d{6}-.+$/.test(r.hlc)) return undefined;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return undefined;
  if (r.kind === 'utterance') {
    if (typeof r.body !== 'string') return undefined;
    if (r.sender !== 'user' && r.sender !== 'contact' && r.sender !== 'system') return undefined;
    if (r.conversationId !== undefined && typeof r.conversationId !== 'string') return undefined;
    return value as UtteranceRecord;
  }
  if (r.kind === 'tombstone') {
    if (typeof r.targetId !== 'string') return undefined;
    return value as HistoryRecord;
  }
  return undefined;
}

/** Options for `HistoryLog`. */
export interface HistoryLogOptions {
  /** Month files kept parsed in memory. Default 4. */
  readonly maxCachedMonths?: number;
}

/**
 * The utterance log: `history/YYYY-MM.jsonl`, one file per UTC month of a
 * record's `createdAt`, append-only. Deletion is a tombstone record appended
 * later; nothing is ever rewritten.
 *
 * Reading merges records (deduplicated by id, so a synced copy of the same
 * line is harmless), orders them by HLC and applies tombstones. A line that
 * does not parse (for example the last line after a crash mid-append) is
 * skipped and reported through the store's error reporter. Parsed months are
 * cached (most recently used kept); `invalidate()` drops the cache after
 * something else (a file-sync tool) changed the folder.
 */
export class HistoryLog implements HistoryStore {
  private readonly cache = new Map<string, HistoryRecord[]>();
  private readonly maxCachedMonths: number;
  /** Bumped by every append, so a read that raced with one does not cache a stale month. */
  private epoch = 0;

  constructor(
    private readonly store: FileStore,
    options: HistoryLogOptions = {},
  ) {
    this.maxCachedMonths = Math.max(1, options.maxCachedMonths ?? 4);
  }

  async append(records: readonly HistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.epoch += 1;
    const byMonth = new Map<string, HistoryRecord[]>();
    for (const record of records) {
      if (parseHistoryRecord(record) === undefined) {
        throw new StorageError('invalid-document', 'Not a valid history record', {
          details: record.id,
        });
      }
      const key = monthKey(record.createdAt);
      const group = byMonth.get(key);
      if (group) group.push(record);
      else byMonth.set(key, [record]);
    }
    await Promise.all(
      [...byMonth].map(async ([key, group]) => {
        // Keep the cache in step immediately so readers see the record at once.
        const cached = this.cache.get(key);
        if (cached) this.merge(cached, group);
        try {
          await this.store.appendLog(monthPath(key), group as unknown as readonly JsonValue[]);
        } catch (error) {
          this.cache.delete(key);
          throw error;
        }
      }),
    );
  }

  /** The most recent `limit` records of every kind, HLC order (tombstones are not applied). */
  async loadRecent(limit: number): Promise<readonly HistoryRecord[]> {
    if (!(limit > 0)) return [];
    const collected: HistoryRecord[] = [];
    for (const key of (await this.monthKeys()).reverse()) {
      this.merge(collected, await this.loadMonth(key));
      if (collected.length >= limit) break;
    }
    return sortByHlc(collected).slice(-limit);
  }

  async listRecent(limit: number): Promise<readonly UtteranceRecord[]> {
    if (!(limit > 0)) return [];
    const collected: HistoryRecord[] = [];
    for (const key of (await this.monthKeys()).reverse()) {
      this.merge(collected, await this.loadMonth(key));
      if (liveUtterances(collected).length >= limit) break;
    }
    return liveUtterances(collected).slice(-limit);
  }

  async listRange(from: number, to: number): Promise<readonly HistoryRecord[]> {
    if (!(to > from)) return [];
    const first = monthKey(from);
    const collected: HistoryRecord[] = [];
    // A tombstone can live in any later month than its target, so read to the end.
    for (const key of await this.monthKeys()) {
      if (key < first) continue;
      this.merge(collected, await this.loadMonth(key));
    }
    return liveUtterances(collected).filter((r) => r.createdAt >= from && r.createdAt < to);
  }

  invalidate(): void {
    this.epoch += 1;
    this.cache.clear();
  }

  private async monthKeys(): Promise<string[]> {
    let entries;
    try {
      entries = await this.store.files.list(HISTORY_DIR);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      const match = entry.kind === 'file' ? MONTH_FILE.exec(entry.name) : null;
      if (match) keys.push(match[1]!);
    }
    return keys.sort();
  }

  private async loadMonth(key: string): Promise<readonly HistoryRecord[]> {
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const path = monthPath(key);
    const startEpoch = this.epoch;
    const parsed: HistoryRecord[] = [];
    for (const raw of await this.store.readLog(path)) {
      const record = parseHistoryRecord(raw);
      if (record) parsed.push(record);
      else {
        this.store.report(
          new StorageError('corrupt', `Unrecognised history record in ${path} skipped`),
          `storage.history.invalid-record:${path}`,
        );
      }
    }
    const records: HistoryRecord[] = [];
    this.merge(records, parsed);
    if (startEpoch !== this.epoch) return records; // an append raced with this read: do not cache
    this.cache.set(key, records);
    // Keep the newest months: recent history is what gets read again.
    while (this.cache.size > this.maxCachedMonths) {
      const oldest = [...this.cache.keys()].sort()[0];
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return records;
  }

  /** Adds records not already present (by id). */
  private merge(target: HistoryRecord[], incoming: readonly HistoryRecord[]): void {
    const seen = new Set(target.map((r) => r.id));
    for (const record of incoming) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      target.push(record);
    }
  }
}

function sortByHlc(records: readonly HistoryRecord[]): HistoryRecord[] {
  return [...records].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

/** Utterances not deleted by a tombstone, oldest first. */
function liveUtterances(records: readonly HistoryRecord[]): UtteranceRecord[] {
  const deleted = new Set<string>();
  for (const record of records) if (record.kind === 'tombstone') deleted.add(record.targetId);
  return sortByHlc(records).filter(
    (r): r is UtteranceRecord => r.kind === 'utterance' && !deleted.has(r.id),
  );
}
