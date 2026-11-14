import type {
  HistoryRecord,
  SettingsSnapshot,
  SpeakOptions,
  SpeechEndReason,
} from '@forsee/plugin-api';
import type { CompositionSnapshot } from './composition';

/**
 * Services the kernel consumes but does not implement. Each is injected
 * into `createKernel` and may be absent; built-in commands that need an
 * absent service do nothing and resolve `false`.
 */

/**
 * What the kernel needs from the speech package (B5 implements it on top of
 * voice providers and the utterance queue).
 */
export interface SpeechService {
  /**
   * Speaks `text`, interrupting nothing (queued after current speech per the
   * speech package's policy). Resolves when the utterance ends.
   */
  speak(text: string, options?: SpeakOptions): Promise<SpeechEndReason>;
  /** Stops all speech immediately and clears the queue. */
  stop(): void;
}

/** What the kernel needs from the gaze pipeline (B1 implements it). */
export interface GazeControl {
  readonly paused: boolean;
  /** Stops all selection until resumed (or a wake target fires). */
  pause(): void;
  resume(): void;
}

/** Persistence for settings (`settings.json`); B6 implements it. */
export interface SettingsPersistence {
  /** Returns stored values, or an empty object when none exist. */
  load(): Promise<SettingsSnapshot>;
  save(snapshot: SettingsSnapshot): Promise<void>;
}

/** Persistence for the conversation log (`history/*.jsonl`); B6 implements it. */
export interface ConversationPersistence {
  /** Appends records durably, in order. */
  append(records: readonly HistoryRecord[]): Promise<void>;
  /**
   * Loads the most recent `limit` records of every kind (utterances and
   * tombstones), in HLC order. The log applies tombstones itself.
   */
  loadRecent(limit: number): Promise<readonly HistoryRecord[]>;
}

/** Persistence for the composition crash-recovery snapshot (`state/composition.json`); B6 implements it. */
export interface CompositionPersistence {
  /** Returns the stored snapshot as untrusted data, or `undefined` when none exists. */
  load(): Promise<unknown>;
  save(snapshot: CompositionSnapshot): Promise<void>;
}
