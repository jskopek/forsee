import type { LocaleTag } from './common';

/** A voice offered by a provider. */
export interface Voice {
  /** Unique within its provider. The global id is `<providerId>/<id>`. */
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly locale: LocaleTag;
  /** True when the voice works with no network. Only local voices are offered by default. */
  readonly local: boolean;
  /** The provider's default voice for its locale. */
  readonly isDefault?: boolean;
}

/**
 * Something to say. Either `text` is synthesised, or, when `recording` is
 * set, the recorded message is played (message banking) and `text` is only
 * shown and logged.
 */
export interface Utterance {
  /** Unique per utterance (UUID). Events echo it. */
  readonly id: string;
  readonly text: string;
  /** Global voice id (`<providerId>/<voiceId>`); absent means the user's chosen voice. */
  readonly voiceId?: string;
  /** Speaking rate multiplier, 1 is normal; providers clamp to their range (typically 0.1..10). */
  readonly rate?: number;
  /** Pitch multiplier, 1 is normal, 0..2. */
  readonly pitch?: number;
  /** 0..1. */
  readonly volume?: number;
  /** Profile-relative path of a recorded audio file to play instead of synthesis. */
  readonly recording?: string;
}

/** Why speech stopped. */
export type SpeechEndReason = 'completed' | 'stopped' | 'error';

/** Speech progress events. `t` is host monotonic ms. */
export type SpeechEvent =
  | { readonly type: 'start'; readonly utteranceId: string; readonly t: number }
  | {
      readonly type: 'boundary';
      readonly utteranceId: string;
      /** UTF-16 offset of the word in `Utterance.text`. */
      readonly charIndex: number;
      readonly charLength: number;
      readonly t: number;
    }
  | {
      readonly type: 'end';
      readonly utteranceId: string;
      readonly reason: SpeechEndReason;
      readonly t: number;
    }
  | {
      readonly type: 'error';
      readonly utteranceId: string;
      readonly message: string;
      readonly t: number;
    };

/**
 * Callbacks for one utterance. Exactly one `onEnd` is delivered per utterance,
 * after any `onError` (with reason `error`).
 */
export interface SpeechEvents {
  onStart?(event: Extract<SpeechEvent, { type: 'start' }>): void;
  onBoundary?(event: Extract<SpeechEvent, { type: 'boundary' }>): void;
  onEnd?(event: Extract<SpeechEvent, { type: 'end' }>): void;
  onError?(event: Extract<SpeechEvent, { type: 'error' }>): void;
}

/** Handle on one utterance being spoken. */
export interface SpeechHandle {
  readonly utteranceId: string;
  /** Stops this utterance at once. No-op if already ended. */
  stop(): void;
  /** Resolves when the utterance ends, with the reason. Never rejects. */
  readonly done: Promise<SpeechEndReason>;
}

/**
 * A voice provider (plan section 7). Operating-system voices, web speech,
 * recorded messages and neural voice packs all implement it.
 * A provider speaks one utterance at a time; queueing is the speech
 * package's utterance queue's job. Calling `speak` while speaking stops the
 * current utterance first.
 */
export interface VoiceProvider {
  readonly id: string;
  listVoices(): Promise<readonly Voice[]>;
  speak(utterance: Utterance, events: SpeechEvents): SpeechHandle;
  /** Stops whatever this provider is saying, immediately. */
  stop(): void;
}

/**
 * When the composition is spoken:
 * - `on-demand`: only when the user activates Speak (the default).
 * - `each-sentence`: whenever a sentence is finished (`.`, `?`, `!`).
 * - `each-word`: whenever a word is finished (space or punctuation).
 */
export type SpeakMode = 'on-demand' | 'each-sentence' | 'each-word';

/** Options when asking the app to speak (the plugin-facing subset of `Utterance`). */
export interface SpeakOptions {
  readonly voiceId?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  /** Profile-relative recording path (message banking). */
  readonly recording?: string;
  /** Append the utterance to the conversation history. Default true. */
  readonly log?: boolean;
  /**
   * Stop whatever is being said (and drop everything queued) before speaking
   * this, as quick-fire phrases do. Default false: the utterance is queued
   * after current speech.
   */
  readonly interrupt?: boolean;
}
