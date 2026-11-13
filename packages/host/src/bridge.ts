import type { Clock, IdSource, ProfileFileSystem } from '@forsee/core';
import type { Disposable, InferenceService, VoiceProvider } from '@forsee/plugin-api';

/**
 * The platform boundary (plan section 4). Everything platform-specific goes
 * through a `HostBridge`; engines receive the pieces they need by injection
 * and plugins never see it.
 *
 * Implementations: `createMemoryHost` (tests), `createWebHost` (browser and
 * the web demo), the Electron shell (B11) and the Capacitor shell (B12).
 *
 * The bridge's types are deliberately DOM-free, so engine packages could
 * consume them if they ever needed to.
 */

/** Operating system family. */
export type HostOs = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'chromeos' | 'unknown';

/** Which shell is running the app. */
export type HostShell = 'web' | 'electron' | 'capacitor' | 'memory';

/** Rough device class, for layout defaults and capability tiers. */
export type FormFactor = 'desktop' | 'tablet' | 'phone' | 'unknown';

/** Static facts about the platform. */
export interface PlatformInfo {
  readonly os: HostOs;
  readonly shell: HostShell;
  readonly formFactor: FormFactor;
  /** App version (semver). */
  readonly appVersion: string;
  /** User's preferred locale (BCP 47) as reported by the platform. */
  readonly locale: string;
}

/** Feature flags so callers can test before using optional parts. */
export interface HostCapabilities {
  /** `persistent`: the profile survives restarts. `memory`: it does not (tests, current web host). */
  readonly fileSystem: 'persistent' | 'memory';
  readonly fullscreen: boolean;
  readonly keepAwake: boolean;
  /** A second window or screen for the partner display. */
  readonly partnerDisplay: boolean;
  /** `HostBridge.sidecars` is present (desktop only). */
  readonly sidecars: boolean;
  /** `HostBridge.voices` is present (native operating-system voices). */
  readonly nativeVoices: boolean;
  /** `HostBridge.inference` is present. */
  readonly inference: boolean;
}

/** What the partner display shows. Extended by the partner-display plugin as needed. */
export interface PartnerDisplayMessage {
  /** Text being composed, or the last utterance. */
  readonly text: string;
  /** True while the user is still composing (shows the "composing" indicator). */
  readonly composing: boolean;
}

/** A partner display window or screen. */
export interface PartnerDisplay extends Disposable {
  /** Replaces what is shown. Fire-and-forget. */
  update(message: PartnerDisplayMessage): void;
  /** Called once if the window is closed by the user or the system. */
  onClosed(listener: () => void): Disposable;
}

/** Window and device control. Every method resolves even when the feature is unsupported (it then does nothing). */
export interface WindowControl {
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  /** Prevents the screen from sleeping while on. */
  setKeepAwake(on: boolean): Promise<void>;
  /** Opens the partner display, or resolves `null` when unsupported. Opening twice returns the same display. */
  openPartnerDisplay(): Promise<PartnerDisplay | null>;
}

/** How to launch a sidecar (a native driver process). */
export interface SidecarSpec {
  /** Stable id for logs, for example `"<pluginId>/driver"`. */
  readonly id: string;
  /** Absolute path, resolved by the plugin host from the plugin folder. */
  readonly executable: string;
  readonly args?: readonly string[];
  /** Extra environment variables. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A running sidecar. */
export interface SidecarProcess extends Disposable {
  readonly id: string;
  /** Called once when the process exits; `code` is null when killed by a signal. */
  onExit(listener: (code: number | null) => void): Disposable;
  /** Each line the process writes to stdout or stderr (for logs only; drivers talk over WebSocket). */
  onOutput(listener: (stream: 'stdout' | 'stderr', line: string) => void): Disposable;
  /** Terminates the process; resolves once it has exited. `dispose()` kills without waiting. */
  kill(): Promise<void>;
}

/** Launches sidecar processes (desktop only; needs the plugin's `native.sidecar` permission). */
export interface SidecarLauncher {
  launch(spec: SidecarSpec): Promise<SidecarProcess>;
}

/** The host bridge. */
export interface HostBridge extends Disposable {
  readonly platform: PlatformInfo;
  readonly capabilities: HostCapabilities;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** The current profile folder. */
  readonly files: ProfileFileSystem;
  readonly window: WindowControl;
  /** Present when `capabilities.sidecars`. */
  readonly sidecars?: SidecarLauncher;
  /** Native operating-system voices; present when `capabilities.nativeVoices`. */
  readonly voices?: VoiceProvider;
  /** Present when `capabilities.inference`. */
  readonly inference?: InferenceService;
}
