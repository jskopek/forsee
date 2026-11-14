import {
  MemoryFileSystem,
  toDisposable,
  type Clock,
  type IdSource,
  type ProfileFileSystem,
} from '@forsee/core';
import type { Disposable } from '@forsee/plugin-api';
import type {
  FormFactor,
  HostBridge,
  HostCapabilities,
  HostOs,
  PlatformInfo,
  WindowControl,
} from './bridge';

/**
 * The browser globals the web host uses, as a structural subset so tests can
 * pass fakes. Defaults to the real globals.
 */
export interface WebHostEnvironment {
  readonly performance: { now(): number };
  readonly dateNow: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly crypto?: {
    randomUUID?(): string;
    /** Fills `array` with random bytes. */
    getRandomValues(array: Uint8Array<ArrayBuffer>): unknown;
  };
  readonly random: () => number;
  readonly navigator?: {
    readonly userAgent?: string;
    readonly language?: string;
    readonly maxTouchPoints?: number;
    readonly wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
  };
  readonly document?: {
    readonly fullscreenElement: unknown;
    readonly documentElement: { requestFullscreen(): Promise<void> };
    exitFullscreen(): Promise<void>;
    readonly visibilityState?: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
}

/** Options for `createWebHost`. */
export interface WebHostOptions {
  readonly appVersion?: string;
  /**
   * Profile storage. Default: in memory (lost on reload). Persistent browser
   * storage (OPFS / IndexedDB) is a later package's job and plugs in here.
   */
  readonly files?: ProfileFileSystem;
  /** Overrides for tests. */
  readonly environment?: WebHostEnvironment;
}

/** The real browser environment. Only called when no override is given. */
function browserEnvironment(): WebHostEnvironment {
  const g = globalThis as typeof globalThis & { crypto?: Crypto };
  return {
    performance: g.performance,
    dateNow: () => Date.now(),
    setTimeout: (cb, ms) => g.setTimeout(cb, ms),
    clearTimeout: (h) => g.clearTimeout(h as number),
    setInterval: (cb, ms) => g.setInterval(cb, ms),
    clearInterval: (h) => g.clearInterval(h as number),
    ...(g.crypto
      ? {
          crypto: {
            randomUUID: () => g.crypto.randomUUID(),
            getRandomValues: (array: Uint8Array<ArrayBuffer>) => g.crypto.getRandomValues(array),
          },
        }
      : {}),
    random: () => Math.random(),
    ...(typeof navigator === 'undefined' ? {} : { navigator: navigator }),
    ...(typeof document === 'undefined' ? {} : { document }),
  };
}

/** A `Clock` on `performance.now`, `Date.now` and real timers. */
export function createWebClock(env: WebHostEnvironment): Clock {
  return {
    now: () => env.performance.now(),
    wallNow: () => env.dateNow(),
    setTimeout(callback, delayMs): Disposable {
      const handle = env.setTimeout(callback, Math.max(0, delayMs));
      return toDisposable(() => env.clearTimeout(handle));
    },
    setInterval(callback, intervalMs): Disposable {
      if (!(intervalMs > 0)) throw new RangeError('intervalMs must be > 0');
      const handle = env.setInterval(callback, intervalMs);
      return toDisposable(() => env.clearInterval(handle));
    },
  };
}

/** An `IdSource` on `crypto.randomUUID`, falling back to `getRandomValues`, then `Math.random`. */
export function createWebIdSource(env: WebHostEnvironment): IdSource {
  const randomBytes = (): Uint8Array => {
    const bytes = new Uint8Array(16);
    if (env.crypto) {
      env.crypto.getRandomValues(bytes);
      return bytes;
    }
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(env.random() * 256);
    return bytes;
  };
  return {
    uuid() {
      if (env.crypto?.randomUUID) return env.crypto.randomUUID();
      const b = randomBytes();
      b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
      b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    random: () => env.random(),
  };
}

/** Best-effort platform detection from the user agent. */
export function detectPlatform(
  env: WebHostEnvironment,
  appVersion: string,
): Omit<PlatformInfo, 'shell'> {
  const ua = env.navigator?.userAgent ?? '';
  const touch = (env.navigator?.maxTouchPoints ?? 0) > 1;
  let os: HostOs = 'unknown';
  if (/android/i.test(ua)) os = 'android';
  else if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && touch)) os = 'ios';
  else if (/cros/i.test(ua)) os = 'chromeos';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macos';
  else if (/windows/i.test(ua)) os = 'windows';
  else if (/linux/i.test(ua)) os = 'linux';
  let formFactor: FormFactor = 'unknown';
  if (/ipad|tablet/i.test(ua) || (os === 'ios' && /macintosh/i.test(ua))) formFactor = 'tablet';
  else if (/mobi|iphone/i.test(ua)) formFactor = 'phone';
  else if (os === 'android') formFactor = 'tablet';
  else if (os !== 'unknown') formFactor = 'desktop';
  return { os, formFactor, appVersion, locale: env.navigator?.language ?? 'en-GB' };
}

/**
 * `HostBridge` for the browser (development, tests in a browser, the public
 * demo). Real timers and `crypto.randomUUID` live here and in the desktop
 * and mobile shells only. No partner display, sidecars, native voices or
 * inference (the web speech provider lives in `@forsee/speech`).
 */
export function createWebHost(options: WebHostOptions = {}): HostBridge {
  const env = options.environment ?? browserEnvironment();
  const files = options.files ?? new MemoryFileSystem();
  const doc = env.document;
  const wakeLockApi = env.navigator?.wakeLock;
  let wakeLock: { release(): Promise<void> } | null = null;
  let wantAwake = false;

  const acquireWakeLock = async (): Promise<void> => {
    if (!wakeLockApi || wakeLock) return;
    try {
      wakeLock = await wakeLockApi.request('screen');
    } catch {
      wakeLock = null; // not allowed right now (e.g. page hidden); retried on visibility change
    }
  };
  // Browsers drop the wake lock when the page is hidden; take it again on return.
  const onVisibility = (): void => {
    if (wantAwake && doc?.visibilityState === 'visible') {
      wakeLock = null;
      void acquireWakeLock();
    }
  };
  doc?.addEventListener('visibilitychange', onVisibility);

  const window: WindowControl = {
    async setFullscreen(on) {
      if (!doc) return;
      try {
        if (on && !doc.fullscreenElement) await doc.documentElement.requestFullscreen();
        if (!on && doc.fullscreenElement) await doc.exitFullscreen();
      } catch {
        // Fullscreen needs a user gesture in browsers; unsupported is not an error here.
      }
    },
    isFullscreen() {
      return Promise.resolve(Boolean(doc?.fullscreenElement));
    },
    async setKeepAwake(on) {
      wantAwake = on;
      if (on) {
        await acquireWakeLock();
      } else if (wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release().catch(() => undefined);
      }
    },
    openPartnerDisplay() {
      return Promise.resolve(null);
    },
  };

  const capabilities: HostCapabilities = {
    fileSystem: options.files ? 'persistent' : 'memory',
    fullscreen: doc !== undefined,
    keepAwake: wakeLockApi !== undefined,
    partnerDisplay: false,
    sidecars: false,
    nativeVoices: false,
    inference: false,
  };

  return {
    platform: { ...detectPlatform(env, options.appVersion ?? '0.0.0'), shell: 'web' },
    capabilities,
    clock: createWebClock(env),
    ids: createWebIdSource(env),
    files,
    window,
    dispose() {
      doc?.removeEventListener('visibilitychange', onVisibility);
      wantAwake = false;
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
    },
  };
}
