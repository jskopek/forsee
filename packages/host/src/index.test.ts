import { createKernel, FakeClock, MemoryFileSystem } from '@forsee/core';
import type { VoiceProvider } from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserFileSystem,
  createMemoryHost,
  createWebClock,
  createWebHost,
  createWebIdSource,
  detectPlatform,
  HOST_PACKAGE,
  type WebHostEnvironment,
} from './index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeEnv(overrides: Partial<WebHostEnvironment> = {}): WebHostEnvironment {
  let now = 100;
  return {
    performance: { now: () => (now += 1) },
    dateNow: () => 1_700_000_000_000,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    random: () => 0.5,
    ...overrides,
  };
}

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    fullscreenElement: null as unknown,
    visibilityState: 'visible',
    documentElement: {
      requestFullscreen: vi.fn(() => {
        doc.fullscreenElement = {};
        return Promise.resolve();
      }),
    },
    exitFullscreen: vi.fn(() => {
      doc.fullscreenElement = null;
      return Promise.resolve();
    }),
    addEventListener: (_type: 'visibilitychange', l: () => void) => listeners.add(l),
    removeEventListener: (_type: 'visibilitychange', l: () => void) => listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
    listeners,
  };
  return doc;
}

it('exports its package name', () => {
  expect(HOST_PACKAGE).toBe('@forsee/host');
});

describe('createMemoryHost', () => {
  it('provides fake clock, deterministic ids and an in-memory profile', async () => {
    const host = createMemoryHost();
    expect(host.platform.shell).toBe('memory');
    expect(host.capabilities).toMatchObject({
      fileSystem: 'memory',
      sidecars: false,
      nativeVoices: false,
      inference: false,
    });
    expect(host.ids.uuid()).toBe('00000000-0000-4000-8000-000000000001');
    expect(host.clock.now()).toBe(0);
    await host.files.writeText('profile.json', '{}');
    expect(await host.files.readText('profile.json')).toBe('{}');
    expect(host.voices).toBeUndefined();
  });

  it('accepts injected services and reports them as capabilities', () => {
    const voices: VoiceProvider = {
      id: 'os',
      listVoices: () => Promise.resolve([]),
      speak: () => ({
        utteranceId: 'u',
        stop: () => undefined,
        done: Promise.resolve('completed'),
      }),
      stop: () => undefined,
    };
    const clock = new FakeClock();
    const files = new MemoryFileSystem();
    const host = createMemoryHost({ voices, clock, files, platform: { os: 'windows' } });
    expect(host.voices).toBe(voices);
    expect(host.clock).toBe(clock);
    expect(host.files).toBe(files);
    expect(host.capabilities.nativeVoices).toBe(true);
    expect(host.platform.os).toBe('windows');
  });

  it('records window state and drives a partner display', async () => {
    const host = createMemoryHost();
    await host.window.setFullscreen(true);
    await host.window.setKeepAwake(true);
    expect(await host.window.isFullscreen()).toBe(true);
    expect(host.windowState).toMatchObject({
      fullscreen: true,
      keepAwake: true,
      partnerOpen: false,
    });
    const partner = await host.window.openPartnerDisplay();
    expect(partner).not.toBeNull();
    expect(await host.window.openPartnerDisplay()).toBe(partner);
    const closed = vi.fn();
    partner?.onClosed(closed);
    partner?.update({ text: 'Hel', composing: true });
    host.closePartnerDisplay();
    partner?.update({ text: 'ignored', composing: false });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(host.windowState.partnerMessages).toEqual([{ text: 'Hel', composing: true }]);
    expect(host.windowState.partnerOpen).toBe(false);
  });

  it('returns null for the partner display when unsupported', async () => {
    const host = createMemoryHost({ partnerDisplay: false });
    expect(host.capabilities.partnerDisplay).toBe(false);
    expect(await host.window.openPartnerDisplay()).toBeNull();
  });

  it('can host a kernel', async () => {
    const host = createMemoryHost();
    const kernel = createKernel({ clock: host.clock, ids: host.ids, deviceId: 'dev' });
    await kernel.start();
    await kernel.commands.execute('composition.insert', { text: 'hi' });
    expect(kernel.composition.text).toBe('hi');
    kernel.dispose();
    host.dispose();
  });
});

describe('web clock and ids', () => {
  it('uses the environment for time and timers', async () => {
    const clock = createWebClock(fakeEnv());
    expect(clock.wallNow()).toBe(1_700_000_000_000);
    const a = clock.now();
    expect(clock.now()).toBeGreaterThan(a);
    const fired = vi.fn();
    clock.setTimeout(fired, 1);
    const cancelled = vi.fn();
    clock.setTimeout(cancelled, 1).dispose();
    const ticks = vi.fn();
    const interval = clock.setInterval(ticks, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    interval.dispose();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(ticks).toHaveBeenCalled();
    expect(() => clock.setInterval(ticks, 0)).toThrow(RangeError);
  });

  it('prefers crypto.randomUUID, then getRandomValues, then Math.random', () => {
    const withUuid = createWebIdSource(
      fakeEnv({ crypto: { randomUUID: () => 'from-crypto', getRandomValues: (a) => a } }),
    );
    expect(withUuid.uuid()).toBe('from-crypto');
    const withBytes = createWebIdSource(
      fakeEnv({ crypto: { getRandomValues: (a) => a.fill(0xab) } }),
    );
    expect(withBytes.uuid()).toMatch(UUID_V4);
    const bare = createWebIdSource(fakeEnv());
    expect(bare.uuid()).toMatch(UUID_V4);
    expect(bare.random()).toBe(0.5);
  });

  it('uses the real globals by default', () => {
    const host = createWebHost();
    expect(host.ids.uuid()).toMatch(UUID_V4);
    expect(host.clock.wallNow()).toBeGreaterThan(1_700_000_000_000);
    host.dispose();
  });

  it('makes ids outside a secure context, where crypto has no randomUUID (plain HTTP on a LAN)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array),
    });
    try {
      const host = createWebHost();
      const a = host.ids.uuid();
      expect(a).toMatch(UUID_V4);
      expect(host.ids.uuid()).not.toBe(a);
      host.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('detectPlatform', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit', 0, 'macos', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit', 5, 'ios', 'tablet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows', 'desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 0, 'linux', 'desktop'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', 5, 'android', 'phone'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X710)', 5, 'android', 'tablet'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, 'ios', 'phone'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0, 'chromeos', 'desktop'],
    ['', 0, 'unknown', 'unknown'],
  ] as const)('%s', (userAgent, maxTouchPoints, os, formFactor) => {
    const info = detectPlatform(
      fakeEnv({ navigator: { userAgent, maxTouchPoints, language: 'fr-FR' } }),
      '1.2.3',
    );
    expect(info).toEqual({ os, formFactor, appVersion: '1.2.3', locale: 'fr-FR' });
  });
});

describe('createWebHost', () => {
  it('reports capabilities from the environment', () => {
    const bare = createWebHost({ environment: fakeEnv() });
    expect(bare.platform.shell).toBe('web');
    expect(bare.capabilities).toEqual({
      fileSystem: 'memory',
      fullscreen: false,
      keepAwake: false,
      partnerDisplay: false,
      sidecars: false,
      nativeVoices: false,
      inference: false,
    });
    const persistent = createWebHost({ environment: fakeEnv(), files: new MemoryFileSystem() });
    expect(persistent.capabilities.fileSystem).toBe('persistent');
  });

  it("reports createBrowserFileSystem's in-memory fallback as not persistent", async () => {
    // No OPFS and no IndexedDB: the browser file system falls back to memory.
    const storage = await createBrowserFileSystem({ environment: {} });
    expect(storage.kind).toBe('memory');
    const host = createWebHost({
      environment: fakeEnv(),
      files: storage.files,
      persistent: storage.persistent,
    });
    expect(host.capabilities.fileSystem).toBe('memory');
  });

  it('toggles fullscreen through the document', async () => {
    const doc = fakeDocument();
    const host = createWebHost({ environment: fakeEnv({ document: doc }) });
    expect(host.capabilities.fullscreen).toBe(true);
    await host.window.setFullscreen(true);
    await host.window.setFullscreen(true);
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(await host.window.isFullscreen()).toBe(true);
    await host.window.setFullscreen(false);
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(await host.window.isFullscreen()).toBe(false);
  });

  it('swallows fullscreen refusals (no user gesture)', async () => {
    const doc = fakeDocument();
    doc.documentElement.requestFullscreen.mockImplementation(() =>
      Promise.reject(new Error('gesture')),
    );
    const host = createWebHost({ environment: fakeEnv({ document: doc }) });
    await expect(host.window.setFullscreen(true)).resolves.toBeUndefined();
  });

  it('holds a wake lock, re-acquires it on visibility, and releases it', async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(() => Promise.resolve({ release }));
    const doc = fakeDocument();
    const host = createWebHost({
      environment: fakeEnv({ document: doc, navigator: { wakeLock: { request } } }),
    });
    expect(host.capabilities.keepAwake).toBe(true);
    await host.window.setKeepAwake(true);
    expect(request).toHaveBeenCalledTimes(1);
    doc.fire();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    await host.window.setKeepAwake(false);
    expect(release).toHaveBeenCalledTimes(1);
    doc.fire();
    expect(request).toHaveBeenCalledTimes(2);
    host.dispose();
    expect(doc.listeners.size).toBe(0);
  });

  it('tolerates a refused wake lock', async () => {
    const request = vi.fn(() => Promise.reject(new Error('denied')));
    const host = createWebHost({ environment: fakeEnv({ navigator: { wakeLock: { request } } }) });
    await expect(host.window.setKeepAwake(true)).resolves.toBeUndefined();
    expect(await host.window.openPartnerDisplay()).toBeNull();
  });
});
