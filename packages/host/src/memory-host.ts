import {
  FakeClock,
  MemoryFileSystem,
  SequentialIdSource,
  toDisposable,
  type Clock,
  type IdSource,
  type ProfileFileSystem,
} from '@forsee/core';
import type { Disposable, InferenceService, VoiceProvider } from '@forsee/plugin-api';
import type {
  HostBridge,
  HostCapabilities,
  PartnerDisplay,
  PartnerDisplayMessage,
  PlatformInfo,
  SidecarLauncher,
  WindowControl,
} from './bridge';

/** Options for `createMemoryHost`. Everything is optional. */
export interface MemoryHostOptions {
  /** Default: a new `FakeClock`. */
  readonly clock?: Clock;
  /** Default: a new `SequentialIdSource`. */
  readonly ids?: IdSource;
  /** Default: a new `MemoryFileSystem`. */
  readonly files?: ProfileFileSystem;
  readonly platform?: Partial<PlatformInfo>;
  /** Whether the fake window supports a partner display. Default true. */
  readonly partnerDisplay?: boolean;
  readonly sidecars?: SidecarLauncher;
  readonly voices?: VoiceProvider;
  readonly inference?: InferenceService;
}

/** A memory host plus inspection hooks for tests. */
export interface MemoryHost extends HostBridge {
  /** The fake window's state. */
  readonly windowState: {
    readonly fullscreen: boolean;
    readonly keepAwake: boolean;
    /** Messages sent to the partner display, oldest first; empty if never opened. */
    readonly partnerMessages: readonly PartnerDisplayMessage[];
    readonly partnerOpen: boolean;
  };
  /** Simulates the user closing the partner display window. */
  closePartnerDisplay(): void;
}

/**
 * A complete in-memory `HostBridge` for tests: fake clock, deterministic ids,
 * in-memory profile, and a window whose state can be inspected. Optional
 * services are present only when passed in.
 */
export function createMemoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const clock = options.clock ?? new FakeClock();
  const ids = options.ids ?? new SequentialIdSource();
  const files = options.files ?? new MemoryFileSystem();
  const partnerSupported = options.partnerDisplay ?? true;
  const state = {
    fullscreen: false,
    keepAwake: false,
    partnerMessages: [] as PartnerDisplayMessage[],
    partnerOpen: false,
  };
  let partner: (PartnerDisplay & { close(): void }) | null = null;

  const createPartner = (): PartnerDisplay & { close(): void } => {
    const closeListeners = new Set<() => void>();
    let open = true;
    const close = (): void => {
      if (!open) return;
      open = false;
      state.partnerOpen = false;
      partner = null;
      for (const listener of [...closeListeners]) listener();
      closeListeners.clear();
    };
    return {
      update(message) {
        if (open) state.partnerMessages.push(message);
      },
      onClosed(listener): Disposable {
        closeListeners.add(listener);
        return toDisposable(() => closeListeners.delete(listener));
      },
      dispose: close,
      close,
    };
  };

  const window: WindowControl = {
    setFullscreen(on) {
      state.fullscreen = on;
      return Promise.resolve();
    },
    isFullscreen() {
      return Promise.resolve(state.fullscreen);
    },
    setKeepAwake(on) {
      state.keepAwake = on;
      return Promise.resolve();
    },
    openPartnerDisplay() {
      if (!partnerSupported) return Promise.resolve(null);
      if (!partner) {
        partner = createPartner();
        state.partnerOpen = true;
      }
      return Promise.resolve(partner);
    },
  };

  const capabilities: HostCapabilities = {
    fileSystem: 'memory',
    fullscreen: true,
    keepAwake: true,
    partnerDisplay: partnerSupported,
    sidecars: options.sidecars !== undefined,
    nativeVoices: options.voices !== undefined,
    inference: options.inference !== undefined,
  };

  const platform: PlatformInfo = {
    os: 'unknown',
    shell: 'memory',
    formFactor: 'desktop',
    appVersion: '0.0.0',
    locale: 'en-GB',
    ...options.platform,
  };

  return {
    platform,
    capabilities,
    clock,
    ids,
    files,
    window,
    ...(options.sidecars ? { sidecars: options.sidecars } : {}),
    ...(options.voices ? { voices: options.voices } : {}),
    ...(options.inference ? { inference: options.inference } : {}),
    windowState: state,
    closePartnerDisplay() {
      partner?.close();
    },
    dispose() {
      partner?.close();
    },
  };
}
