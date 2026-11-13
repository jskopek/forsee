import type {
  Clock,
  CompositionBuffer,
  ErrorReporter,
  EventBus,
  ExtensionRegistry,
  SpeechService,
} from '@forsee/core';
import type {
  Disposable,
  SpeakMode,
  SpeakOptions,
  SpeechEndReason,
  SpeechEvent,
  SpeechEvents,
  SpeechHandle,
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
 *
 * Guarantees, per utterance: at most one `start`, then any `boundary`
 * events, then exactly one `end` (preceded by an `error` event when the
 * reason is `error`), and `done` resolves with the same reason. `stopAll`
 * is synchronous: when it returns, nothing is playing or pending, every
 * affected `done` has been settled, and late events from the provider are
 * ignored.
 */
export interface UtteranceQueue extends Disposable {
  /** Adds to the end of the queue. Starts at once when nothing is playing. */
  enqueue(utterance: Utterance): QueuedUtterance;
  /** Stops the current utterance and drops everything queued. */
  stopAll(): void;
  readonly speaking: boolean;
  /** Number of utterances waiting (excluding the one playing). */
  readonly pending: number;
  /** Every speech event, from whichever provider plays the utterance. */
  onEvent(listener: (event: SpeechEvent) => void): Disposable;
}

/** Starts speaking one utterance; what the queue calls (the engine routes to a provider). May throw. */
export type UtterancePlayer = (utterance: Utterance, events: SpeechEvents) => SpeechHandle;

/** Options for `createUtteranceQueue`. */
export interface UtteranceQueueOptions {
  readonly clock: Clock;
  readonly play: UtterancePlayer;
  /** Receives listener errors. Default: `defaultErrorReporter` from `@forsee/core`. */
  readonly reportError?: ErrorReporter;
  /**
   * How long an utterance may run before the queue gives up on a provider
   * that never ends it (it is stopped and ends with `error`). Default:
   * `defaultWatchdogMs`.
   */
  readonly watchdogMs?: (utterance: Utterance) => number;
}

/** The user's speech settings. Values are always within the limits below. */
export interface SpeechSettings {
  /** Preferred global voice id; absent means the provider's or locale's default. */
  readonly voiceId?: string;
  /** Preferred locale, used when `voiceId` is absent or unavailable. */
  readonly locale?: string;
  /** 0.1..10, default 1. */
  readonly rate: number;
  /** 0..2, default 1. */
  readonly pitch: number;
  /** 0..1, default 1. */
  readonly volume: number;
}

/** What `updateSettings` accepts: any subset, validated and clamped. `undefined` clears voice or locale. */
export type SpeechSettingsPatch = Partial<{
  voiceId: string | undefined;
  locale: string | undefined;
  rate: number;
  pitch: number;
  volume: number;
}>;

/** Whether a new utterance interrupts current speech or waits its turn. */
export type SpeakPolicy = 'queue' | 'interrupt';

/** Options for `createSpeechService` (B5), the kernel-facing service. */
export interface SpeechServiceOptions {
  readonly clock: Clock;
  /** Voice providers contributed through `voiceProviders` are picked up (and dropped) live. */
  readonly extensions?: ExtensionRegistry;
  /** Providers registered directly (the shell's web speech and recorded-message providers). */
  readonly providers?: readonly VoiceProvider[];
  /** Makes utterance ids. */
  readonly newId: () => string;
  /** Global id of the default voice (`<providerId>/<voiceId>`), or undefined for the first local one. */
  readonly voiceId?: string;
  /** Preferred locale, used when no voice id matches. */
  readonly locale?: string;
  readonly defaults?: Omit<SpeakOptions, 'log' | 'recording' | 'voiceId' | 'interrupt'>;
  /** What `speak` does when `options.interrupt` is absent. Default `queue`. */
  readonly policy?: SpeakPolicy;
  /** Provider used for `Utterance.recording`. Default `forsee.recorded`. */
  readonly recordedProviderId?: string;
  /** Provider used when no voice id names one. Default: the first registered synthesis provider. */
  readonly defaultProviderId?: string;
  readonly reportError?: ErrorReporter;
  readonly watchdogMs?: (utterance: Utterance) => number;
}

/** Events on `SpeechEngine.events`. */
export interface SpeechEngineEventMap {
  /** Every per-utterance speech event, re-emitted from the queue. */
  speech: SpeechEvent;
  /** A recording could not be played and the text is being synthesised instead. */
  fallback: { readonly utteranceId: string; readonly recording: string; readonly reason: string };
  settingsChanged: SpeechSettings;
  /** The set of (local) voices changed: a provider came or went, or voices finished loading. */
  voicesChanged: readonly Voice[];
}

/** The speech service B5 builds: queue + provider selection + `SpeechService` for the kernel. */
export interface SpeechEngine extends SpeechService, Disposable {
  /**
   * Speaks `text`. With `options.interrupt` (or the engine policy
   * `interrupt`) everything current and queued is stopped first; otherwise it
   * is queued. Resolves when it ends. Text that is blank and has no
   * recording resolves `completed` without speaking.
   */
  speak(text: string, options?: SpeakOptions): Promise<SpeechEndReason>;
  /** Synchronous: stops the current utterance and clears the queue. */
  stop(): void;
  readonly queue: UtteranceQueue;
  readonly events: EventBus<SpeechEngineEventMap>;
  /** Voices from every registered provider; by default only `local` ones. */
  listVoices(options?: { readonly includeNetwork?: boolean }): Promise<readonly Voice[]>;
  setVoice(voiceId: string): void;
  readonly settings: SpeechSettings;
  /** Validates and clamps `patch`, applies it, and returns the result. */
  updateSettings(patch: SpeechSettingsPatch): SpeechSettings;
  /** Picks a voice: by id, else by locale, else the default (local voices only). */
  resolveVoice(request?: {
    readonly voiceId?: string;
    readonly locale?: string;
  }): Promise<Voice | undefined>;
  /** Registers a provider directly. Throws `duplicate` for a taken id. */
  registerProvider(provider: VoiceProvider): Disposable;
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
  /** Receives failures of automatic speech. Default: `defaultErrorReporter`. */
  readonly reportError?: ErrorReporter;
}

// ------------------------------------------------------------------ injected platform pieces

/** A `SpeechSynthesisVoice`. */
export interface SpeechSynthesisVoiceLike {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
  readonly default: boolean;
}

/**
 * A `SpeechSynthesisUtterance`. Handlers are typed `(event: never) => void`
 * so that the real DOM object (whose handlers take `SpeechSynthesisEvent`)
 * is assignable; the provider treats the event argument as untrusted.
 */
export interface SpeechSynthesisUtteranceLike {
  text: string;
  lang: string;
  voice: SpeechSynthesisVoiceLike | null;
  rate: number;
  pitch: number;
  volume: number;
  onstart: ((event: never) => void) | null;
  onend: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
  onboundary: ((event: never) => void) | null;
}

/** The subset of the Web Speech API the web speech provider uses (`window.speechSynthesis`). */
export interface SpeechSynthesisLike {
  getVoices(): readonly SpeechSynthesisVoiceLike[];
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

/** Options for `createWebSpeechProvider`. */
export interface WebSpeechProviderOptions {
  readonly synthesis: SpeechSynthesisLike;
  /** Creates a `SpeechSynthesisUtterance`; injected so the package stays DOM-free. */
  readonly createUtterance: (text: string) => SpeechSynthesisUtteranceLike;
  readonly clock: Clock;
  /** Offer and use only `localService` voices (offline). Default true. */
  readonly localOnly?: boolean;
  /** Start locked: hold speech until `unlock()` (the browser needs a first user gesture). Default false. */
  readonly requireUnlock?: boolean;
  /** Longest text handed to the browser in one piece. Default 180 UTF-16 units. */
  readonly maxChunkChars?: number;
  /** How long `listVoices` waits for `voiceschanged` when no voices are loaded yet. Default 2000. */
  readonly voicesTimeoutMs?: number;
  /** Provider id. Default `forsee.web-speech`. */
  readonly id?: string;
}

/** The web speech provider: a voice provider plus the user-gesture unlock. */
export interface WebSpeechProvider extends VoiceProvider, Disposable {
  /**
   * True while the browser has not allowed speech yet (before the first user
   * gesture). While locked, `speak` holds the utterance (no events) and
   * `unlock()` plays it.
   */
  readonly locked: boolean;
  /** Call from inside a user gesture (a click handler): plays the held utterance, or primes speech. */
  unlock(): void;
  onLockedChange(listener: (locked: boolean) => void): Disposable;
}

/** Factory signatures B5 provides. */
export type WebSpeechProviderFactory = (options: WebSpeechProviderOptions) => WebSpeechProvider;

export type RecordedMessageProviderFactory = (options: {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly player: AudioPlayer;
  readonly clock: Clock;
  /** Provider id. Default `forsee.recorded`. */
  readonly id?: string;
}) => VoiceProvider;
