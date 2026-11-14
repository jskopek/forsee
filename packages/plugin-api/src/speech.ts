import type { LocaleTag } from './common';

/**
 * Identity of voice providers and voices.
 *
 * - **Provider id.** A provider registered by the app itself has a bare id
 *   with no `/` (`forsee.web-speech`, `forsee.recorded`). A provider
 *   registered by a plugin through `ForseeApi.register.voiceProvider` has the
 *   id `<pluginId>/<localId>`: the plugin host adds the prefix, and neither
 *   part contains `/` (plugin ids are dot-separated `[a-z0-9-]` segments,
 *   local ids are `[A-Za-z0-9_.-]`). So a provider id contains at most one
 *   `/`, and the speech engine accepts both forms.
 * - **Voice id** (`Voice.id`). Any non-empty string chosen by the provider,
 *   unique within that provider. It may contain `/` (browser voice URIs do).
 * - **Global voice id.** `<providerId>/<escaped voice id>`, built by
 *   `formatVoiceId`. The voice id is escaped so that it contains no `/`
 *   (`%` → `%25`, then `/` → `%2F`; nothing else changes), which makes the
 *   **last** `/` the separator whatever the provider id looks like.
 *   `parseVoiceId` reverses it. Examples: `forsee.web-speech/Samantha`,
 *   `community.voices/neural/Ava`, `forsee.web-speech/urn%2Fvoice%2F1` for the
 *   voice `urn/voice/1`.
 *
 * `SpeakOptions.voiceId`, `Utterance.voiceId` and the user's chosen voice are
 * global voice ids. A provider receives the global id in `Utterance.voiceId`
 * and uses `parseVoiceId` to get its own voice id back.
 */

/** Builds a global voice id from a provider id and the provider's own voice id. */
export function formatVoiceId(providerId: string, voiceId: string): string {
  return `${providerId}/${voiceId.replace(/%/g, '%25').replace(/\//g, '%2F')}`;
}

/**
 * Splits a global voice id (see `formatVoiceId`) at its last `/` and
 * unescapes the voice part. Returns `undefined` when either part is empty.
 */
export function parseVoiceId(
  globalId: string,
): { readonly providerId: string; readonly voiceId: string } | undefined {
  const slash = globalId.lastIndexOf('/');
  if (slash <= 0 || slash === globalId.length - 1) return undefined;
  const voiceId = globalId
    .slice(slash + 1)
    .replace(/%(?:25|2F)/gi, (escape) => (escape === '%25' ? '%' : '/'));
  return { providerId: globalId.slice(0, slash), voiceId };
}

/** A voice offered by a provider. */
export interface Voice {
  /** Unique within its provider; may contain `/`. The global id is `formatVoiceId(providerId, id)`. */
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
  /** Global voice id (see `formatVoiceId`); absent means the user's chosen voice. */
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
  /** Global voice id (see `formatVoiceId`); absent means the user's chosen voice. */
  readonly voiceId?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  /**
   * Profile-relative recording path (message banking): `/`-separated
   * segments, no empty, `.` or `..` segment, no leading `/`, no `\\` or `:`.
   */
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
