import { compareHlc, MemoryFileSystem, type Kernel } from '@forsee/core';
import { DEFAULT_DWELL_CONFIG } from '@forsee/gaze';
import { createBrowserFileSystem } from '@forsee/host';
import { API_VERSION, type PluginManifest } from '@forsee/plugin-api';
import { BLOCK_REASONS, type FirstPartyPlugin } from '@forsee/plugin-host';
import {
  createNgramPredictionPlugin,
  manifest as ngramManifest,
  NGRAM_PLUGIN_ID,
} from '@forsee/plugin-prediction-ngram';
import { QUICKFIRE_PHRASE_SET_ID, QUICKFIRE_SPEAK_COMMAND } from '@forsee/plugin-quickfire';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFirstPartyPlugins } from './first-party';
import { PLUGIN_INSTALL_PATH } from './profile-storage';
import {
  createTestBrowser,
  dwellOn,
  lookAway,
  mountTestKeyboard,
  settle,
  type TestBrowser,
} from './testing';
import type { ForseeRuntime } from './types';

/** Completions the prediction engine offers for the current composition. */
function completions(kernel: Kernel, runtime: ForseeRuntime): string[] {
  const state = kernel.composition.state;
  return runtime.prediction
    .predict({
      textBefore: state.textBeforeCaret,
      partialWord: state.partialWord,
      partialWordSteps: state.partialWordSteps,
      locale: kernel.locale,
      maxCandidates: 8,
      kinds: ['completions'],
    })
    .instant.completions.map((c) => c.text);
}

/** Types `text` and presses Speak; the fake synthesis then finishes speaking it. */
async function say(browser: TestBrowser, runtime: ForseeRuntime, text: string): Promise<void> {
  await runtime.kernel.commands.execute('composition.insert', { text }, 'keyboard');
  await runtime.kernel.commands.execute('composition.speak', undefined, 'keyboard');
  await settle();
  browser.synthesis.start();
  browser.synthesis.end();
  await settle();
}

async function typed(runtime: ForseeRuntime, text: string): Promise<void> {
  await runtime.kernel.commands.execute('composition.insert', { text }, 'keyboard');
}

const running: ForseeRuntime[] = [];
async function boot(browser: TestBrowser, overrides = {}): Promise<ForseeRuntime> {
  const runtime = await browser.boot(overrides);
  running.push(runtime);
  return runtime;
}
afterEach(async () => {
  for (const runtime of running.splice(0)) await runtime.dispose();
  vi.unstubAllGlobals();
});

describe('restart', () => {
  it('brings back the half sentence, history, settings and learned words; new utterances sort last', async () => {
    const first = createTestBrowser();
    const a = await boot(first);
    await say(first, a, 'my zorblat is here');
    await typed(a, 'I would li');
    await a.gaze.adjustDwell('slower');
    a.speech.updateSettings({ voiceId: 'forsee.web-speech/Serena', rate: 1.2 });
    await a.flush();
    await a.dispose();
    const oldRecord = a.kernel.conversation.listRecent(1)[0]!;

    // A reload: same storage, fresh everything else, and a wall clock that did not move on.
    const second = createTestBrowser({ files: first.files });
    const b = await boot(second);
    expect(b.profile).toMatchObject({
      id: a.profile.id,
      deviceId: a.profile.deviceId,
      created: false,
    });
    expect(b.kernel.composition.text).toBe('I would li');
    expect(b.kernel.conversation.listRecent(10).map((u) => u.body)).toEqual(['my zorblat is here']);
    expect(b.gaze.pipeline.dwellConfig.classMs.letter).toBe(
      DEFAULT_DWELL_CONFIG.classMs.letter + 100,
    );
    expect(b.speech.settings).toMatchObject({ voiceId: 'forsee.web-speech/Serena', rate: 1.2 });
    expect(b.speech.engine.settings).toMatchObject({
      voiceId: 'forsee.web-speech/Serena',
      rate: 1.2,
    });

    await b.kernel.commands.execute('composition.clear', undefined, 'app');
    await typed(b, 'zor');
    expect(completions(b.kernel, b)).toContain('zorblat');

    await b.kernel.commands.execute('composition.clear', undefined, 'app');
    await say(second, b, 'Lovely');
    const records = b.kernel.conversation.listRecent(10);
    expect(records.map((u) => u.body)).toEqual(['my zorblat is here', 'Lovely']);
    expect(compareHlc(oldRecord.hlc, records[1]!.hlc)).toBeLessThan(0);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('flushes when the page is hidden or unloaded', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    await typed(runtime, 'hidden text');
    browser.pointer.setVisible(false);
    await settle();
    const snapshot = JSON.parse(await browser.files.readText('state/composition.json')) as {
      text: string;
    };
    expect(snapshot.text).toBe('hidden text');
  });
});

describe('the predictor is a plugin', () => {
  it('can be disabled (typing still works) and enabled again', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const { kernel } = runtime;
    expect(runtime.pluginHost.get(NGRAM_PLUGIN_ID)?.state).toBe('active');

    await runtime.pluginHost.disable(NGRAM_PLUGIN_ID);
    expect(kernel.extensions.list('predictionProviders')).toEqual([]);
    await typed(runtime, 'he');
    expect(kernel.composition.text).toBe('he');
    expect(completions(kernel, runtime)).toEqual([]);

    await runtime.pluginHost.enable(NGRAM_PLUGIN_ID);
    expect(runtime.pluginHost.get(NGRAM_PLUGIN_ID)?.state).toBe('active');
    expect(completions(kernel, runtime).length).toBeGreaterThan(0);
  });

  it('declares exactly what it uses: without composition.read it cannot register', async () => {
    expect([...(ngramManifest.permissions ?? [])].sort()).toEqual([
      'composition.read',
      'history.read',
      'lm.write',
    ]);
    const browser = createTestBrowser();
    const runtime = await boot(browser, {
      firstPartyPlugins: (context: { clock: never; locale: string }) => [
        {
          ...createNgramPredictionPlugin(context),
          manifest: { ...ngramManifest, permissions: ['lm.write', 'history.read'] },
        },
      ],
    });
    const status = runtime.pluginHost.get(NGRAM_PLUGIN_ID);
    expect(status?.state).toBe('failed');
    expect(status?.reason).toMatch(/composition\.read/);
    expect(runtime.kernel.extensions.list('predictionProviders')).toEqual([]);
    expect(runtime.startupIssues.map((i) => i.part)).toEqual(['plugins']);
    await typed(runtime, 'still typing');
    expect(runtime.kernel.composition.text).toBe('still typing');
  });
});

describe('learning', () => {
  it('offers a new word after it was spoken, and still after a restart', async () => {
    const first = createTestBrowser();
    const a = await boot(first);
    await typed(a, 'zor');
    expect(completions(a.kernel, a)).not.toContain('zorblat');
    await a.kernel.commands.execute('composition.clear', undefined, 'app');
    for (let i = 0; i < 3; i += 1) await say(first, a, 'the zorblat is lovely');
    await typed(a, 'zor');
    expect(completions(a.kernel, a)).toContain('zorblat');
    await a.dispose();

    const second = createTestBrowser({ files: first.files });
    const b = await boot(second);
    await b.kernel.commands.execute('composition.clear', undefined, 'app');
    await typed(b, 'zor');
    expect(completions(b.kernel, b)).toContain('zorblat');
  });

  it('does not learn announcements spoken with log: false', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    await runtime.kernel.commands.execute(
      'speech.speak',
      { text: 'quuxword quuxword quuxword', log: false },
      'app',
    );
    await settle();
    await typed(runtime, 'quu');
    expect(completions(runtime.kernel, runtime)).not.toContain('quuxword');
  });
});

describe('degraded starts', () => {
  it('starts without speech synthesis; Speak keeps the text and reports speech.unavailable', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser, { speechSynthesis: null });
    expect(runtime.speech.available).toBe(false);
    expect(runtime.startupIssues.map((i) => i.part)).toEqual(['speech']);
    const unavailable = vi.fn();
    runtime.kernel.bus.on('speech.unavailable', unavailable);
    await typed(runtime, 'hello there');
    await runtime.kernel.commands.execute('composition.speak', undefined, 'keyboard');
    expect(unavailable).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello there', reason: 'no-voice' }),
    );
    expect(runtime.kernel.conversation.listRecent(1).map((u) => u.body)).toEqual(['hello there']);
    await runtime.kernel.commands.execute('composition.undo', undefined, 'keyboard');
    expect(runtime.kernel.composition.text).toBe('hello there');
  });

  it('reports speech.unavailable when the browser fails to speak', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const unavailable = vi.fn();
    runtime.speech.onUnavailable(unavailable);
    await typed(runtime, 'hello');
    await runtime.kernel.commands.execute('composition.speak', undefined, 'keyboard');
    browser.synthesis.error('synthesis-failed');
    await settle();
    expect(unavailable).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', reason: 'error' }),
    );
  });

  it('starts on memory storage and says it is not persistent', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser, {
      storage: () => createBrowserFileSystem({ environment: {} }),
    });
    expect(runtime.profile).toMatchObject({ storage: 'memory', persistent: false });
    expect(runtime.profile.warning).toBeUndefined();
    await typed(runtime, 'ok');
    expect(runtime.kernel.composition.text).toBe('ok');
  });

  it('falls back to memory with a warning when storage cannot be opened', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser, {
      storage: () => Promise.reject(new Error('quota exceeded')),
    });
    expect(runtime.profile).toMatchObject({ storage: 'memory', persistent: false });
    expect(runtime.profile.warning).toMatch(/quota exceeded.*temporary storage/);
    expect(runtime.startupIssues.map((i) => i.part)).toEqual(['storage']);
    expect(browser.errors.map((e) => e.context)).toEqual(['runtime.storage']);
  });

  it('falls back to memory, leaving the stored profile alone, when it cannot be read', async () => {
    const files = new MemoryFileSystem();
    await files.writeText('profile.json', '{ torn');
    const browser = createTestBrowser({ files });
    const runtime = await boot(browser);
    expect(runtime.profile.persistent).toBe(false);
    expect(runtime.profile.warning).toMatch(/could not be opened/);
    await typed(runtime, 'still works');
    await runtime.flush();
    expect(await files.readText('profile.json')).toBe('{ torn');
  });

  it('starts when a first-party plugin throws in activate, and reports it', async () => {
    const broken: FirstPartyPlugin = {
      manifest: {
        id: 'forsee.broken',
        name: 'Broken',
        version: '1.0.0',
        apiVersion: API_VERSION,
        minAppVersion: '0.0.0',
        description: 'Throws.',
        author: 'Tests',
      } satisfies PluginManifest,
      module: {
        activate() {
          throw new Error('boom');
        },
      },
    };
    const browser = createTestBrowser();
    const runtime = await boot(browser, {
      firstPartyPlugins: (context: Parameters<typeof defaultFirstPartyPlugins>[0]) => [
        ...defaultFirstPartyPlugins(context),
        broken,
      ],
    });
    expect(runtime.pluginHost.get('forsee.broken')?.state).toBe('failed');
    expect(runtime.pluginHost.get(NGRAM_PLUGIN_ID)?.state).toBe('active');
    expect(runtime.startupIssues.map((i) => i.part)).toEqual(['plugins']);
    expect(runtime.startupIssues[0]?.message).toMatch(/boom/);
    expect(runtime.errors.list().map((e) => e.context)).toContain('plugin:forsee.broken:activate');
    await typed(runtime, 'fine');
    expect(runtime.kernel.composition.text).toBe('fine');
  });
});

describe('blocked first-party plugins', () => {
  // Found in a real browser: the harness passed appVersion "0.0.0-dev", which
  // sorts before the plugins' minAppVersion "0.0.0", so both were blocked and
  // nothing said so.
  it('are reported as startup issues', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser, { appVersion: '0.0.0-dev' });
    expect(runtime.pluginHost.get(NGRAM_PLUGIN_ID)?.state).toBe('blocked');
    expect(runtime.startupIssues.map((i) => i.part)).toEqual(['plugins', 'plugins']);
    expect(runtime.startupIssues[0]?.message).toMatch(/blocked: It needs Forsee 0\.0\.0/);
  });
});

describe('plugins', () => {
  it('keeps community code blocked (restricted mode) and loads first-party plugins', async () => {
    const files = new MemoryFileSystem();
    await files.writeText(
      'plugins/community.hello/manifest.json',
      JSON.stringify({
        id: 'community.hello',
        name: 'Hello',
        version: '1.0.0',
        apiVersion: API_VERSION,
        minAppVersion: '0.0.0',
        description: 'Community code.',
        author: 'Someone',
        main: 'main.js',
      }),
    );
    await files.writeText(
      PLUGIN_INSTALL_PATH,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            schemaVersion: 1,
            id: 'community.hello',
            origin: 'directory',
            folder: 'plugins/community.hello',
            enabled: true,
            installedAt: 0,
          },
        ],
      }),
    );
    const browser = createTestBrowser({ files });
    const runtime = await boot(browser);
    expect(runtime.pluginHost.restrictedMode).toBe(true);
    expect(runtime.pluginHost.get('community.hello')).toMatchObject({
      state: 'blocked',
      reason: BLOCK_REASONS.restricted,
    });
    expect(runtime.pluginHost.get('forsee.quickfire')?.state).toBe('active');
  });

  it('quick-fire: the phrase set is registered and its command interrupts current speech', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    expect(runtime.kernel.extensions.list('phraseSets').map((s) => s.id)).toEqual([
      QUICKFIRE_PHRASE_SET_ID,
    ]);
    await typed(runtime, 'a long sentence');
    await runtime.kernel.commands.execute('composition.speak', undefined, 'keyboard');
    await settle();
    browser.synthesis.start();
    await runtime.kernel.commands.execute(
      QUICKFIRE_SPEAK_COMMAND,
      { phraseId: 'please-wait' },
      'app',
    );
    await settle();
    expect(browser.synthesis.cancelCalls).toBeGreaterThan(0);
    expect(browser.synthesis.spoken.map((u) => u.text)).toEqual(['a long sentence', 'Please wait']);
    expect(runtime.kernel.conversation.listRecent(5).map((u) => u.body)).toEqual([
      'a long sentence',
      'Please wait',
    ]);
  });

  it('persists consent and install records in the profile', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    await runtime.pluginHost.disable('forsee.quickfire');
    await runtime.flush();
    const records = JSON.parse(await browser.files.readText(PLUGIN_INSTALL_PATH)) as {
      records: { id: string; enabled: boolean }[];
    };
    expect(records.records.find((r) => r.id === 'forsee.quickfire')?.enabled).toBe(false);
    expect(await browser.files.exists('state/plugin-consent.json')).toBe(true);
    await runtime.dispose();

    const again = await boot(createTestBrowser({ files: browser.files }));
    expect(again.pluginHost.get('forsee.quickfire')?.state).toBe('disabled');
  });
});

describe('input modes', () => {
  it('a touch tap selects directly; the mouse brings dwell back', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const keyboard = mountTestKeyboard(runtime);
    expect(runtime.gaze.selectionMethod).toBe('dwell');

    const a = keyboard.centreOf('k-a');
    browser.pointer.tap(a.x, a.y);
    await settle();
    expect(runtime.gaze.inputMode).toBe('tap');
    expect(runtime.gaze.selectionMethod).toBe('direct');
    expect(runtime.kernel.composition.text).toBe('a');

    browser.pointer.move(10, 10);
    expect(runtime.gaze.inputMode).toBe('hover');
    expect(runtime.gaze.selectionMethod).toBe('dwell');
    dwellOn(browser, keyboard, 'k-b');
    lookAway(browser);
    expect(runtime.kernel.composition.text).toBe('ab');
    keyboard.dispose();
  });

  it('dwell faster and slower change the pipeline, the setting, and say the new value', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const letter = DEFAULT_DWELL_CONFIG.classMs.letter;
    await runtime.gaze.adjustDwell('faster');
    expect(runtime.gaze.pipeline.dwellConfig.classMs.letter).toBe(letter - 100);
    expect(runtime.settings.get('app.gaze', 'dwell.letterMs')).toBe(letter - 100);
    expect(browser.synthesis.spoken.at(-1)?.text).toBe(
      `Dwell ${((letter - 100) / 1000).toFixed(1)} seconds`,
    );
    // Announcements are not history.
    expect(runtime.kernel.conversation.listRecent(5)).toEqual([]);
  });

  it('pauses and resumes through the kernel commands', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const changes = vi.fn();
    runtime.kernel.bus.on('gaze.pauseChanged', changes);
    await runtime.gaze.pause();
    expect(runtime.gaze.pipeline.paused).toBe(true);
    const keyboard = mountTestKeyboard(runtime);
    dwellOn(browser, keyboard, 'k-a');
    expect(runtime.kernel.composition.text).toBe('');
    await runtime.gaze.resume();
    expect(changes.mock.calls.map((c): unknown => c[0])).toEqual([
      { paused: true },
      { paused: false },
    ]);
    keyboard.dispose();
  });
});

describe('layout', () => {
  it('switches to the coarse family and back, replacing the runtime', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const changed = vi.fn();
    runtime.layout.onDidChange(changed);
    const before = runtime.layout.runtime;
    runtime.layout.setFamily('coarse');
    expect(runtime.layout.definition.family).toBe('coarse');
    expect(runtime.layout.runtime).not.toBe(before);
    expect(changed).toHaveBeenCalledTimes(1);
    runtime.layout.select('forsee/en-alphabetical');
    expect(runtime.layout.definition.id).toBe('forsee/en-alphabetical');
    expect(() => runtime.layout.select('nope/missing')).toThrow(/no layout/);
    await runtime.kernel.commands.execute('layout.showPage', { page: 'numbers' }, 'app');
    expect(runtime.layout.runtime.view.pageId).toBe('numbers');
  });
});

describe('no leaks', () => {
  it('leaves no listeners and no timers after dispose, even mid-utterance', async () => {
    const browser = createTestBrowser();
    const runtime = await boot(browser);
    const keyboard = mountTestKeyboard(runtime);
    expect(browser.pointer.listenerCount()).toBeGreaterThan(0);
    dwellOn(browser, keyboard, 'k-h');
    await typed(runtime, 'i');
    await runtime.kernel.commands.execute('composition.speak', undefined, 'keyboard');
    browser.synthesis.start(); // still speaking at dispose
    keyboard.dispose();
    await runtime.dispose();
    await runtime.dispose(); // idempotent
    expect(browser.pointer.listenerCount()).toBe(0);
    expect(browser.clock.pendingTimers).toBe(0);
    expect(browser.synthesis.voicesListenerCount).toBe(0);
  });

  it('also when voices had not loaded yet', async () => {
    const browser = createTestBrowser();
    browser.synthesis.loadVoices([]);
    const runtime = await boot(browser);
    await runtime.dispose();
    expect(browser.clock.pendingTimers).toBe(0);
    expect(browser.synthesis.voicesListenerCount).toBe(0);
  });
});

describe('offline promise', () => {
  it('makes no network request while booting and through a conversation', async () => {
    const calls: string[] = [];
    const deny =
      (name: string) =>
      (...args: unknown[]): never => {
        calls.push(`${name} ${String(args[0])}`);
        throw new Error(`${name} is not allowed offline`);
      };
    vi.stubGlobal('fetch', deny('fetch'));
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        constructor() {
          deny('XMLHttpRequest')();
        }
      },
    );
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: unknown) {
          deny('WebSocket')(url);
        }
      },
    );
    vi.stubGlobal('navigator', {
      ...(globalThis.navigator as object | undefined),
      sendBeacon: deny('sendBeacon'),
    });

    const browser = createTestBrowser();
    // Default storage too (in Node: no OPFS or IndexedDB, so memory).
    const options = browser.options();
    const { storage: _default, ...rest } = options;
    const runtime = await boot(browser, rest);
    const keyboard = mountTestKeyboard(runtime);
    dwellOn(browser, keyboard, 'k-h');
    dwellOn(browser, keyboard, 'k-i');
    dwellOn(browser, keyboard, 'k-speak', 1600);
    lookAway(browser);
    await settle();
    browser.synthesis.start();
    browser.synthesis.end();
    await runtime.kernel.commands.execute(QUICKFIRE_SPEAK_COMMAND, { phraseId: 'yes' }, 'app');
    await runtime.flush();
    keyboard.dispose();
    await runtime.dispose();
    expect(browser.synthesis.spoken.map((u) => u.text)).toEqual(['hi', 'Yes']);
    expect(calls).toEqual([]);
  });
});
