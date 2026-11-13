import type { Clock, CompositionBuffer, ExtensionRegistry, SpeechService } from '@forsee/core';
import type {
  Disposable,
  SpeakMode,
  SpeakOptions,
  SpeechEndReason,
  SpeechEvent,
  Utterance,
  Voice,
  VoiceProvider,
} from '@forsee/plugin-api';

/**
 * Engine-internal contracts of the speech package (B5 implements them; the
 * kernel consumes `SpeechService`; C3 and C4 consume the queue). The provider
 * contract (`VoiceProvider`, `Utterance`, `SpeechEvents`, `SpeakMode`) is
 * public and lives in `@forsee/plugin-api`.
 *
 * Note: this is an engine package (no DOM). Providers that need browser APIs
 * (web speech, audio playback) take them as injected structural interfaces
 * below; the shell passes `window.speechSynthesis` or an audio player in.
 */

export type {
  SpeakMode,
  SpeechEndReason,
  SpeechEvent,
  SpeechEvents,
  SpeechHandle,
  Utterance,
  Voice,
  VoiceProvider,
} from '@forsee/plugin-api';
export type { SpeechService } from '@forsee/core';

/** An utterance waiting in, or playing from, the queue. */
export interface QueuedUtterance {
  readonly utterance: Utterance;
  /** Resolves when it finishes, is stopped, or fails. Never rejects. */
  readonly done: Promise<SpeechEndReason>;
}

/**
 * The utterance queue: plays utterances one at a time through the selected
 * voice provider, with immediate stop (plan section 3, "Stop speaking
 * immediately").
 */
export interface UtteranceQueue extends Disposable {
  /** Adds to the end of the queue. */
  enqueue(utterance: Utterance): QueuedUtterance;
  /** Stops the current utterance and drops everything queued. */
  stopAll(): void;
  readonly speaking: boolean;
  /** Number of utterances waiting (excluding the one playing). */
  readonly pending: number;
  /** Every speech event, from whichever provider plays the utterance. */
  onEvent(listener: (event: SpeechEvent) => void): Disposable;
}

/** Options for `createSpeechService` (B5), the kernel-facing service. */
export interface SpeechServiceOptions {
  readonly clock: Clock;
  readonly extensions: ExtensionRegistry;
  /** Makes utterance ids. */
  readonly newId: () => string;
  /** Global id of the default voice (`<providerId>/<voiceId>`), or undefined for the first local one. */
  readonly voiceId?: string;
  readonly defaults?: Omit<SpeakOptions, 'log' | 'recording' | 'voiceId'>;
}

/** The speech service B5 builds: queue + provider selection + `SpeechService` for the kernel. */
export interface SpeechEngine extends SpeechService, Disposable {
  readonly queue: UtteranceQueue;
  /** Voices from every registered provider; by default only `local` ones. */
  listVoices(options?: { readonly includeNetwork?: boolean }): Promise<readonly Voice[]>;
  setVoice(voiceId: string): void;
}

/**
 * Speaks the composition automatically in `each-sentence` and `each-word`
 * modes by watching composition changes; does nothing in `on-demand` mode.
 */
export interface SpeakModeController extends Disposable {
  readonly mode: SpeakMode;
  setMode(mode: SpeakMode): void;
}

/** Options for `createSpeakModeController` (B5). */
export interface SpeakModeControllerOptions {
  readonly composition: CompositionBuffer;
  readonly speech: SpeechService;
  readonly mode: SpeakMode;
}

// ------------------------------------------------------------------ injected platform pieces

/** The subset of the Web Speech API the web speech provider uses (`window.speechSynthesis`). */
export interface SpeechSynthesisLike {
  getVoices(): readonly {
    readonly voiceURI: string;
    readonly name: string;
    readonly lang: string;
    readonly localService: boolean;
    readonly default: boolean;
  }[];
  speak(utterance: unknown): void;
  cancel(): void;
  addEventListener(type: 'voiceschanged', listener: () => void): void;
  removeEventListener(type: 'voiceschanged', listener: () => void): void;
}

/** Plays recorded audio for the recorded-message (message banking) provider. */
export interface AudioPlayer {
  /** Plays bytes of an audio file; resolves when playback ends or is stopped. */
  play(
    audio: Uint8Array,
    mimeType: string,
  ): { stop(): void; readonly done: Promise<SpeechEndReason> };
}

/** Factory signatures B5 provides. */
export type WebSpeechProviderFactory = (options: {
  readonly synthesis: SpeechSynthesisLike;
  /** Creates a `SpeechSynthesisUtterance`; injected so the package stays DOM-free. */
  readonly createUtterance: (text: string) => unknown;
  readonly clock: Clock;
}) => VoiceProvider;

export type RecordedMessageProviderFactory = (options: {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly player: AudioPlayer;
  readonly clock: Clock;
}) => VoiceProvider;
