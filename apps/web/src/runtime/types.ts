import type {
  Clock,
  IdSource,
  Kernel,
  KernelEventMap,
  ProfileFileSystem,
  SettingsTrial,
} from '@forsee/core';
import type { GazePipeline, TargetRegistry } from '@forsee/gaze';
import type { InputMode, PointerEnvironment } from '@forsee/gaze-web';
import type { BrowserFileSystem, HostBridge } from '@forsee/host';
import type { LayoutRuntime } from '@forsee/layouts';
import type {
  Disposable,
  LayoutDefinition,
  SelectionMethodId,
  SettingValue,
  SpeakMode,
  Voice,
} from '@forsee/plugin-api';
import type { ConsentPrompt, FirstPartyPlugin, PluginHostInstance } from '@forsee/plugin-host';
import type { PredictionEngine } from '@forsee/prediction';
import type {
  AudioPlayer,
  SpeechEngine,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
} from '@forsee/speech';
import type { HostUiServices } from '@forsee/ui';

/**
 * The application runtime's public shape: what `createForseeRuntime` returns
 * and what the React layer codes against. Everything behind the screen,
 * nothing React.
 */

// ------------------------------------------------------------------ options

/** The browser's speech synthesis, injected (tests pass `FakeSpeechSynthesis`). */
export interface SpeechSynthesisEnvironment {
  readonly synthesis: SpeechSynthesisLike;
  readonly createUtterance: (text: string) => SpeechSynthesisUtteranceLike;
}

/**
 * Page lifecycle events, for flushing on `pagehide` and when the page is
 * hidden. Structural: the real `window` and `document` fit, and so do the
 * fake targets of `@forsee/gaze-web/testing`.
 */
export interface LifecycleEnvironment {
  readonly window?: {
    addEventListener(type: 'pagehide', listener: () => void): void;
    removeEventListener(type: 'pagehide', listener: () => void): void;
  };
  readonly document?: {
    readonly visibilityState?: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

/** What a first-party plugin factory gets from the runtime. */
export interface FirstPartyPluginContext {
  readonly clock: Clock;
  readonly locale: string;
}

/**
 * Options of `createForseeRuntime`. Every browser dependency is injected,
 * with the real browser as the default, so the whole runtime runs in Node
 * tests.
 */
export interface ForseeRuntimeOptions {
  /** App version (semver). Default `"0.0.0"`. */
  readonly appVersion?: string;
  /**
   * Opens the profile storage. Default: `createBrowserFileSystem()` (OPFS,
   * then IndexedDB, then memory). If it throws, or the profile in it cannot
   * be opened, the runtime starts on memory storage and sets
   * `profile.warning`.
   */
  readonly storage?: () => Promise<BrowserFileSystem>;
  /**
   * Builds the host bridge on the profile files. Default: `createWebHost`
   * (real clock, `crypto.randomUUID`). Tests pass `createMemoryHost` with a
   * `FakeClock`.
   */
  readonly createHost?: (files: ProfileFileSystem, persistent: boolean) => HostBridge;
  /** Speech synthesis. Default: `window.speechSynthesis`; `null` means none (speech unavailable). */
  readonly speechSynthesis?: SpeechSynthesisEnvironment | null;
  /** Hold speech until `speech.unlock()` (a first user gesture). Default false: locks on a `not-allowed` error. */
  readonly speechRequiresUnlock?: boolean;
  /** Plays recorded messages. Default: an `HTMLAudioElement` player; `null` disables recordings. */
  readonly audioPlayer?: AudioPlayer | null;
  /** Pointer input. Default: the real `window` and `document`. */
  readonly pointerEnvironment?: PointerEnvironment;
  /** Page lifecycle. Default: the real `window` and `document`; `null` disables flush on hide. */
  readonly lifecycle?: LifecycleEnvironment | null;
  /** Asks for plugin consent. Default: refuses (no consent UI yet; first-party plugins need none). */
  readonly consent?: ConsentPrompt;
  /**
   * The first-party plugins. Default: `defaultFirstPartyPlugins` (word
   * prediction, quick-fire). Tests use it to add a failing plugin.
   */
  readonly firstPartyPlugins?: (context: FirstPartyPluginContext) => readonly FirstPartyPlugin[];
  /** Default locale for a new profile (`app.general/locale`). Default `"en-GB"`. */
  readonly defaultLocale?: string;
  /** Also receives every reported error (after `errors` has it). Default: `console.error` in a browser. */
  readonly onError?: (error: RuntimeError) => void;
}

// ------------------------------------------------------------------ result

/** A problem reported anywhere in the app (a failed save, a throwing listener, a plugin that failed). */
export interface RuntimeError {
  readonly error: unknown;
  /** Where it happened, for example `"plugin:forsee.quickfire:activate"`. */
  readonly context: string;
  /** Wall-clock ms. */
  readonly at: number;
}

/** The error stream: everything reported through the error reporters, so the UI can show it. */
export interface RuntimeErrors {
  /** The most recent errors (at most 100), oldest first. */
  list(): readonly RuntimeError[];
  /** Called for every new error. */
  on(listener: (error: RuntimeError) => void): Disposable;
}

/** A boot step that failed; the app started without it. */
export interface StartupIssue {
  readonly part: 'storage' | 'speech' | 'prediction' | 'plugins' | 'gaze' | 'layout' | 'lifecycle';
  readonly message: string;
}

/** The open profile. */
export interface RuntimeProfile {
  readonly id: string;
  readonly name: string;
  readonly deviceId: string;
  /** True on the first run with this storage. */
  readonly created: boolean;
  /** Which backend holds it. */
  readonly storage: BrowserFileSystem['kind'];
  /** False when nothing will survive a reload (memory storage). */
  readonly persistent: boolean;
  /**
   * Set when the runtime could not open the profile storage and fell back to
   * memory: show it, because nothing typed or learned will be kept.
   */
  readonly warning?: string;
}

/** The app's speech settings (`app.speech`). */
export interface RuntimeSpeechSettings {
  /** Global voice id (`<providerId>/<voiceId>`), or `""` for automatic. */
  readonly voiceId: string;
  readonly rate: number;
  readonly pitch: number;
  readonly volume: number;
  readonly speakMode: SpeakMode;
}

/** Speech. */
export interface RuntimeSpeech {
  readonly engine: SpeechEngine;
  /** False when nothing can synthesise (no speech synthesis in this browser). */
  readonly available: boolean;
  /** True until the browser allows speech (first user gesture). */
  readonly locked: boolean;
  /** Call from inside a user gesture (a click handler) to allow speech. */
  unlock(): void;
  onLockedChange(listener: (locked: boolean) => void): Disposable;
  /**
   * Text could not be spoken (no synthesis, no voice, or the browser failed):
   * the kernel's `speech.unavailable`. The text is in history and, after the
   * Speak key, one undo away; show it to the user.
   */
  onUnavailable(listener: (event: KernelEventMap['speech.unavailable']) => void): Disposable;
  /** Local voices (offline). */
  listVoices(): Promise<readonly Voice[]>;
  readonly settings: RuntimeSpeechSettings;
  /** Changes speech settings (stored in `app.speech`). Throws `invalid-argument` for invalid values. */
  updateSettings(patch: Partial<RuntimeSpeechSettings>): void;
}

/** Gaze and pointer input. */
export interface RuntimeGaze {
  readonly pipeline: GazePipeline;
  readonly targets: TargetRegistry;
  /** Last seen pointer kind (`hover` mouse or pen, `tap` touch), or null before any input. */
  readonly inputMode: InputMode | null;
  /** The selection method in force (dwell for hover input, direct for touch). */
  readonly selectionMethod: SelectionMethodId;
  onInputModeChange(listener: (mode: InputMode) => void): Disposable;
  /** The in-place "faster" / "slower" dwell keys: steps every dwell class and stores it. Same as the `gaze.dwellFaster` / `gaze.dwellSlower` commands. */
  adjustDwell(direction: 'faster' | 'slower'): Promise<void>;
  /** Pauses selection through the `gaze.pause` command. */
  pause(): Promise<void>;
  /** Resumes selection through the `gaze.resume` command. */
  resume(): Promise<void>;
}

/**
 * The active keyboard. Plugins offer keyboards (the standard ones come from
 * the required `forsee.keyboards` plugin); exactly one is in use.
 */
export interface RuntimeLayout {
  /** Every keyboard on offer: the layouts contributed by enabled plugins. */
  readonly catalogue: readonly LayoutDefinition[];
  readonly definition: LayoutDefinition;
  /** Runtime of the active layout; replaced (a new object) when the layout changes. */
  readonly runtime: LayoutRuntime;
  /** True when no plugin offers a keyboard and the built-in fallback keyboard is shown. */
  readonly fallback: boolean;
  /** Called when the active layout (and so `runtime`) is replaced. */
  onDidChange(
    listener: (layout: { definition: LayoutDefinition; runtime: LayoutRuntime }) => void,
  ): Disposable;
  /** Chooses the keyboard by id (stored in `app.layout`). Throws `not-found` for one not on offer. */
  select(layoutId: string): void;
}

/** Settings helpers (the generated settings screen reads `kernel.settings` directly). */
export interface RuntimeSettings {
  /** The app's settings namespaces. */
  readonly namespaces: {
    readonly general: string;
    readonly speech: string;
    readonly gaze: string;
    readonly layout: string;
    /** `app.ui`: click sound, physical keyboard typing. */
    readonly ui: string;
    readonly plugins: string;
  };
  get(namespace: string, key: string): SettingValue;
  set(namespace: string, key: string, value: SettingValue): void;
  /**
   * Timed revert for risky changes (`danger` other than `none`): the
   * settings screen applies them through `trial.apply`, and they are undone
   * unless the user selects Keep with the new values in effect.
   */
  readonly trial: SettingsTrial;
}

/** A booted Forsee. */
export interface ForseeRuntime {
  /** What trusted UI infrastructure receives (`<ForseeProvider services={runtime.hostUi}>`). */
  readonly hostUi: HostUiServices;
  readonly kernel: Kernel;
  readonly host: HostBridge;
  readonly profile: RuntimeProfile;
  readonly speech: RuntimeSpeech;
  readonly gaze: RuntimeGaze;
  readonly prediction: PredictionEngine;
  readonly layout: RuntimeLayout;
  readonly settings: RuntimeSettings;
  readonly pluginHost: PluginHostInstance;
  readonly errors: RuntimeErrors;
  /**
   * Reports an error into `errors` (and `onError`): for the UI layer, so a
   * failed command from a click or a throwing UI listener is shown like any
   * other problem.
   */
  readonly reportError: (error: unknown, context: string) => void;
  /** Optional parts that failed to start (the app runs without them). */
  readonly startupIssues: readonly StartupIssue[];
  /** Writes everything pending: composition, history, settings, consent, learned words. */
  flush(): Promise<void>;
  /** Flushes, then tears everything down in reverse order. Leaves no listeners or timers. Idempotent. */
  dispose(): Promise<void>;
}

/** Re-exported so callers can build options without importing every package. */
export type { BrowserFileSystem, Clock, IdSource };
