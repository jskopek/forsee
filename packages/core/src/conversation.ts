import type {
  Disposable,
  HistoryRecord,
  HistorySender,
  TombstoneRecord,
  UtteranceRecord,
} from '@forsee/plugin-api';
import { defaultErrorReporter, type ErrorReporter } from './errors';
import { EventBus } from './event-bus';
import { compareHlc, HybridLogicalClock } from './hlc';
import type { Clock, IdSource } from './platform';
import type { ConversationPersistence } from './services';

/** Events emitted by the conversation log. */
export interface ConversationEventMap {
  appended: UtteranceRecord;
  removed: { readonly id: string; readonly tombstone: TombstoneRecord };
}

/** Options for `ConversationLog`. */
export interface ConversationLogOptions {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly deviceId: string;
  readonly persistence?: ConversationPersistence;
  /** Records kept in memory. Default 500. */
  readonly memoryLimit?: number;
  /** Where persistence and listener errors go. */
  readonly reportError?: ErrorReporter;
}

/**
 * In-memory conversation log (plan section 4). Appends are visible at once
 * and persisted in the background, in order; a failed write is reported to
 * `reportError` and does not throw at the caller (losing the in-memory record
 * would be worse). `flush()` waits for pending writes.
 */
export class ConversationLog implements Disposable {
  readonly events: EventBus<ConversationEventMap>;
  readonly hlc: HybridLogicalClock;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly persistence: ConversationPersistence | undefined;
  private readonly memoryLimit: number;
  private readonly reportError: ErrorReporter;
  private utterances: UtteranceRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ConversationLogOptions) {
    this.clock = options.clock;
    this.ids = options.ids;
    this.persistence = options.persistence;
    this.memoryLimit = options.memoryLimit ?? 500;
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.events = new EventBus({ onListenerError: this.reportError });
    this.hlc = new HybridLogicalClock(options.clock, options.deviceId);
  }

  /**
   * Loads recent records from persistence, replacing memory. Tombstoned
   * utterances are dropped and the HLC is advanced past every loaded record.
   */
  async load(): Promise<void> {
    if (!this.persistence) return;
    const records = await this.persistence.loadRecent(this.memoryLimit);
    const deleted = new Set<string>();
    for (const record of records) {
      this.hlc.observe(record.hlc);
      if (record.kind === 'tombstone') deleted.add(record.targetId);
    }
    this.utterances = records
      .filter((r): r is UtteranceRecord => r.kind === 'utterance' && !deleted.has(r.id))
      .sort((a, b) => compareHlc(a.hlc, b.hlc))
      .slice(-this.memoryLimit);
  }

  /** Appends an utterance and returns its record. */
  append(input: {
    readonly body: string;
    readonly sender?: HistorySender;
    readonly conversationId?: string;
  }): UtteranceRecord {
    const record: UtteranceRecord = {
      schemaVersion: 1,
      kind: 'utterance',
      id: this.ids.uuid(),
      deviceId: this.hlc.deviceId,
      hlc: this.hlc.now(),
      createdAt: this.clock.wallNow(),
      sender: input.sender ?? 'user',
      body: input.body,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    };
    this.utterances.push(record);
    if (this.utterances.length > this.memoryLimit) this.utterances.shift();
    this.persist([record]);
    this.events.emit('appended', record);
    return record;
  }

  /** Deletes an utterance by appending a tombstone. Returns false if it is not in memory. */
  remove(id: string): boolean {
    const index = this.utterances.findIndex((u) => u.id === id);
    if (index < 0) return false;
    this.utterances.splice(index, 1);
    const tombstone: TombstoneRecord = {
      schemaVersion: 1,
      kind: 'tombstone',
      id: this.ids.uuid(),
      deviceId: this.hlc.deviceId,
      hlc: this.hlc.now(),
      createdAt: this.clock.wallNow(),
      targetId: id,
    };
    this.persist([tombstone]);
    this.events.emit('removed', { id, tombstone });
    return true;
  }

  /** The most recent `limit` utterances, oldest first. */
  listRecent(limit: number): readonly UtteranceRecord[] {
    if (limit <= 0) return [];
    return this.utterances.slice(-limit);
  }

  /** Looks up an utterance in memory. */
  get(id: string): UtteranceRecord | undefined {
    return this.utterances.find((u) => u.id === id);
  }

  /** Resolves when every write started so far has finished (successfully or not). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  dispose(): void {
    this.events.dispose();
  }

  private persist(records: readonly HistoryRecord[]): void {
    const persistence = this.persistence;
    if (!persistence) return;
    this.writeChain = this.writeChain
      .then(() => persistence.append(records))
      .catch((error: unknown) => this.reportError(error, 'conversation.persist'));
  }
}
