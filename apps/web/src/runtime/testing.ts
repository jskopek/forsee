/**
 * Test support for the runtime (Node tests only; not imported by the app):
 * a fake browser around `createForseeRuntime`, and a minimal keyboard that
 * registers the active layout's keys as gaze targets and executes owner
 * activations the way the real keyboard view's activation adapter will.
 */
import { FakeClock, MemoryFileSystem, SequentialIdSource, type Disposable } from '@forsee/core';
import { withActivationDistribution, type TargetHandle } from '@forsee/gaze';
import { FakePointerEnvironment, PointerScript } from '@forsee/gaze-web/testing';
import { createMemoryHost } from '@forsee/host';
import { keyIdOfTarget, targetsForView, type KeyRect } from '@forsee/layouts';
import type { Point, Rect } from '@forsee/plugin-api';
import { fakeBrowserVoice, FakeSpeechSynthesis } from '@forsee/speech/testing';
import { createForseeRuntime } from './create-runtime';
import type {
  ForseeRuntime,
  ForseeRuntimeOptions,
  LifecycleEnvironment,
  RuntimeError,
} from './types';

/** Wall time the fake clocks start at. */
export const TEST_WALL_START = Date.UTC(2026, 10, 14, 12);

/** Local voices the fake speech synthesis offers. */
export const TEST_VOICES = [
  fakeBrowserVoice('Daniel', 'en-GB', { default: true }),
  fakeBrowserVoice('Serena', 'en-GB'),
  fakeBrowserVoice('Cloud voice', 'en-GB', { localService: false }),
];

/** A fake browser for one boot of the runtime. */
export interface TestBrowser {
  readonly clock: FakeClock;
  readonly files: MemoryFileSystem;
  readonly pointer: FakePointerEnvironment;
  readonly synthesis: FakeSpeechSynthesis;
  readonly lifecycle: LifecycleEnvironment;
  /** Errors the runtime reported (also in `runtime.errors`). */
  readonly errors: RuntimeError[];
  /** Options for `createForseeRuntime`, with overrides. */
  options(overrides?: Partial<ForseeRuntimeOptions>): ForseeRuntimeOptions;
  boot(overrides?: Partial<ForseeRuntimeOptions>): Promise<ForseeRuntime>;
}

/**
 * A fake browser: fake clock and ids, an in-memory "persistent" profile
 * (pass the `files` of an earlier browser to simulate a reload), the fake
 * speech synthesis with local voices loaded, the fake pointer environment,
 * and page lifecycle events on the same fake document.
 */
export function createTestBrowser(
  options: { readonly files?: MemoryFileSystem; readonly wall?: number } = {},
): TestBrowser {
  const clock = new FakeClock({ wall: options.wall ?? TEST_WALL_START });
  const ids = new SequentialIdSource(7);
  const files = options.files ?? new MemoryFileSystem();
  const pointer = new FakePointerEnvironment();
  const synthesis = new FakeSpeechSynthesis({ voices: TEST_VOICES });
  const errors: RuntimeError[] = [];
  const lifecycle: LifecycleEnvironment = {
    window: {
      addEventListener: (type, listener) => pointer.window.addEventListener(type, listener),
      removeEventListener: (type, listener) => pointer.window.removeEventListener(type, listener),
    },
    document: {
      get visibilityState() {
        return pointer.visible ? 'visible' : 'hidden';
      },
      addEventListener: (type, listener) => pointer.document.addEventListener(type, listener),
      removeEventListener: (type, listener) => pointer.document.removeEventListener(type, listener),
    },
  };
  const make = (overrides: Partial<ForseeRuntimeOptions> = {}): ForseeRuntimeOptions => ({
    storage: () => Promise.resolve({ files, kind: 'opfs', persistent: true }),
    createHost: (hostFiles) =>
      createMemoryHost({ clock, ids, files: hostFiles, platform: { shell: 'web' } }),
    speechSynthesis: { synthesis, createUtterance: synthesis.createUtterance },
    audioPlayer: null,
    pointerEnvironment: pointer,
    lifecycle,
    onError: (error) => errors.push(error),
    // The bundled model is a file next to the app; tests use the seed model.
    languageModel: null,
    ...overrides,
  });
  return {
    clock,
    files,
    pointer,
    synthesis,
    lifecycle,
    errors,
    options: make,
    boot: (overrides) => createForseeRuntime(make(overrides)),
  };
}

/** Lets pending promise callbacks run. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Where the test keyboard is drawn. */
export const KEYBOARD_BOUNDS: Rect = { x: 0, y: 300, width: 1000, height: 400 };

/** A keyboard mounted on the runtime's active layout. */
export interface TestKeyboard extends Disposable {
  /** Placed keys of the current view. */
  readonly keys: readonly KeyRect[];
  /** Centre of a visible key. Throws for a key not on the current view. */
  centreOf(keyId: string): Point;
  /** Every command the keyboard executed, in order. */
  readonly executed: { readonly command: string; readonly args: unknown }[];
}

/**
 * Registers the active layout's keys as targets (again whenever the view or
 * the layout changes) and handles owner activations with the layout runtime
 * plus `withActivationDistribution`, executing each action exactly once:
 * the job of the keyboard view's activation adapter in `packages/ui`.
 */
export function mountTestKeyboard(runtime: ForseeRuntime, bounds = KEYBOARD_BOUNDS): TestKeyboard {
  let handles: TargetHandle[] = [];
  let keys: readonly KeyRect[] = [];
  let viewSubscription: Disposable | null = null;
  const executed: { command: string; args: unknown }[] = [];

  const register = (): void => {
    for (const handle of handles) handle.dispose();
    const placed = targetsForView(runtime.layout.runtime.view, bounds, {
      gapPx: 4,
      edgeGrowthPx: 0,
    });
    keys = placed.keyRects;
    handles = runtime.gaze.targets.registerAll(placed.targets);
  };
  const follow = (): void => {
    viewSubscription?.dispose();
    viewSubscription = runtime.layout.runtime.onDidChangeView(register);
    register();
  };
  follow();
  const layoutSubscription = runtime.layout.onDidChange(follow);

  const activation = runtime.gaze.pipeline.onActivate((event, outcome) => {
    if (outcome.executedBy !== 'owner') return;
    const layoutRuntime = runtime.layout.runtime;
    const view = layoutRuntime.view;
    const keyId = keyIdOfTarget(view.layoutId, view.pageId, event.targetId);
    if (keyId === undefined) return;
    const action = layoutRuntime.activate(keyId, event.repeatIndex);
    if (!action) return;
    const run = withActivationDistribution(action, event);
    executed.push({ command: run.command, args: run.args });
    runtime.kernel.commands.execute(run.command, run.args as never, 'keyboard').catch(() => {
      // Failures reach the runtime's error stream through the kernel.
    });
  });

  return {
    get keys() {
      return keys;
    },
    executed,
    centreOf(keyId) {
      const placed = keys.find((k) => k.key.id === keyId);
      if (!placed) throw new Error(`Key ${keyId} is not on the current view`);
      const { x, y, width, height } = placed.rect;
      return { x: x + width / 2, y: y + height / 2 };
    },
    dispose() {
      activation.dispose();
      layoutSubscription.dispose();
      viewSubscription?.dispose();
      for (const handle of handles) handle.dispose();
      handles = [];
    },
  };
}

/** Rests the mouse on a key long enough to dwell it out (then the caller moves on). */
export function dwellOn(
  browser: TestBrowser,
  keyboard: TestKeyboard,
  keyId: string,
  ms = 1300,
): void {
  new PointerScript()
    .jumpTo(keyboard.centreOf(keyId))
    .rest(ms)
    .play(browser.pointer, browser.clock);
}

/** Moves the mouse to empty space above the keyboard (no target) and waits. */
export function lookAway(browser: TestBrowser, ms = 200): void {
  new PointerScript().jumpTo({ x: 500, y: 100 }).rest(ms).play(browser.pointer, browser.clock);
}
