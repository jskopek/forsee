/**
 * Persisted record shapes shared across packages (plan section 7, "Storage").
 * Every persisted shape carries `schemaVersion` so the storage package can migrate it.
 */

/** Who said an utterance. v1 writes only `user`; `contact` arrives with partner transcription. */
export type HistorySender = 'user' | 'contact' | 'system';

/**
 * A hybrid logical clock timestamp, encoded as a string that sorts
 * lexicographically in causal order:
 * `<wall ms, 15 decimal digits>-<counter, 6 decimal digits>-<device id>`,
 * for example `001763035200000-000000-dev1`. Use the helpers in
 * `@forsee/core` (`encodeHlc`, `decodeHlc`, `compareHlc`) rather than parsing by hand.
 */
export type HlcString = string;

/** Fields common to every history record. */
interface HistoryRecordBase {
  readonly schemaVersion: 1;
  /** UUID (v4) of this record. */
  readonly id: string;
  /** Device that wrote the record (`ProfileMetadata.deviceId`). */
  readonly deviceId: string;
  /** Causal order across devices. Unique per record. */
  readonly hlc: HlcString;
  /** Wall-clock ms since epoch when the record was written. Display only; order by `hlc`. */
  readonly createdAt: number;
}

/** Something said in a conversation. */
export interface UtteranceRecord extends HistoryRecordBase {
  readonly kind: 'utterance';
  readonly sender: HistorySender;
  readonly body: string;
  /** Groups utterances into conversations. Absent means the default conversation. */
  readonly conversationId?: string;
}

/**
 * Marks an earlier record as deleted. History is append-only: deletion never
 * rewrites a file. Readers hide every record whose id appears as a tombstone's
 * `targetId`, and the tombstone itself.
 */
export interface TombstoneRecord extends HistoryRecordBase {
  readonly kind: 'tombstone';
  readonly targetId: string;
}

/** One line of a history `.jsonl` file. */
export type HistoryRecord = UtteranceRecord | TombstoneRecord;

/** `profile.json`: who this profile is and which device is writing it. */
export interface ProfileMetadata {
  readonly schemaVersion: 1;
  /** UUID of the profile; stable across devices and exports. */
  readonly id: string;
  /** Display name, for example the user's first name. */
  readonly name: string;
  /** UUID of this device's installation. Different on each device sharing the profile. */
  readonly deviceId: string;
  /** Wall-clock ms since epoch. */
  readonly createdAt: number;
  /** App version that last wrote the profile. */
  readonly appVersion: string;
}
