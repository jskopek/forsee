import {
  BUILTIN_COMMAND_IDS,
  type HistoryRecord,
  type SettingsSnapshot,
  type TextTransform,
} from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionSnapshot } from './composition';
import { ConversationLog } from './conversation';
import { compareHlc } from './hlc';
import {
  createKernel,
  GENERAL_SETTINGS_NAMESPACE,
  type KernelOptions,
  type SpeakCommandResult,
} from './kernel';
import type {
  CompositionPersistence,
  ConversationPersistence,
  GazeControl,
  SpeechService,
} from './services';
import { FakeClock, SequentialIdSource } from './testing';

function memoryConversation(initial: HistoryRecord[] = []) {
  const records = [...initial];
  const persistence: ConversationPersistence = {
    append: (r) => {
      records.push(...r);
      return Promise.resolve();
    },
    loadRecent: (limit) => Promise.resolve(records.slice(-limit)),
  };
  return { records, persistence };
}

function setup(overrides: Partial<KernelOptions> = {}) {
  const clock = new FakeClock({ wall: Date.UTC(2026, 10, 13, 12) });
  const ids = new SequentialIdSource();
  const reportError = vi.fn();
  const kernel = createKernel({ clock, ids, deviceId: 'dev1', reportError, ...overrides });
  return { kernel, clock, ids, reportError };
}

describe('ConversationLog', () => {
  it('appends records with ids, hlc and device id, and lists recent', async () => {
    const clock = new FakeClock({ wall: 1_000 });
    const mem = memoryConversation();
    const log = new ConversationLog({
      clock,
      ids: new SequentialIdSource(),
      deviceId: 'd',
      persistence: mem.persistence,
    });
    const appended = vi.fn();
    log.events.on('appended', appended);
    const a = log.append({ body: 'hello' });
    clock.advance(10);
    const b = log.append({ body: 'hi', sender: 'contact', conversationId: 'c1' });
    expect(a).toMatchObject({
      schemaVersion: 1,
      kind: 'utterance',
      sender: 'user',
      deviceId: 'd',
      createdAt: 1000,
    });
    expect(b).toMatchObject({ sender: 'contact', conversationId: 'c1' });
    expect(compareHlc(a.hlc, b.hlc)).toBeLessThan(0);
    expect(log.listRecent(1)).toEqual([b]);
    expect(log.listRecent(0)).toEqual([]);
    expect(log.get(a.id)).toBe(a);
    expect(appended).toHaveBeenCalledTimes(2);
    await log.flush();
    expect(mem.records).toEqual([a, b]);
  });

  it('removes with a tombstone and loads honouring tombstones', async () => {
    const mem = memoryConversation();
    const clock = new FakeClock({ wall: 5_000 });
    const log = new ConversationLog({
      clock,
      ids: new SequentialIdSource(),
      deviceId: 'd',
      persistence: mem.persistence,
    });
    const a = log.append({ body: 'secret' });
    const b = log.append({ body: 'fine' });
    expect(log.remove(a.id)).toBe(true);
    expect(log.remove(a.id)).toBe(false);
    await log.flush();
    expect(mem.records.at(-1)).toMatchObject({ kind: 'tombstone', targetId: a.id });

    const reloaded = new ConversationLog({
      clock,
      ids: new SequentialIdSource(100),
      deviceId: 'd',
      persistence: mem.persistence,
    });
    await reloaded.load();
    expect(reloaded.listRecent(10)).toEqual([b]);
    // HLC continues after the persisted records even if the wall clock went back
    clock.setWallTime(1);
    const c = reloaded.append({ body: 'later' });
    expect(compareHlc(mem.records.at(-1)!.hlc, c.hlc)).toBeLessThan(0);
  });

  it('caps memory and reports persistence errors without throwing', async () => {
    const report = vi.fn();
    const log = new ConversationLog({
      clock: new FakeClock(),
      ids: new SequentialIdSource(),
      deviceId: 'd',
      memoryLimit: 2,
      reportError: report,
      persistence: {
        append: () => Promise.reject(new Error('disk full')),
        loadRecent: () => Promise.resolve([]),
      },
    });
    log.append({ body: '1' });
    log.append({ body: '2' });
    log.append({ body: '3' });
    expect(log.listRecent(10).map((r) => r.body)).toEqual(['2', '3']);
    await log.flush();
    expect(report).toHaveBeenCalledTimes(3);
  });
});

describe('createKernel', () => {
  it('registers every built-in command', () => {
    const { kernel } = setup();
    expect(BUILTIN_COMMAND_IDS.every((id) => kernel.commands.has(id))).toBe(true);
  });

  it('drives the composition through commands and forwards events to the bus', async () => {
    const { kernel } = setup();
    const changes: string[] = [];
    kernel.bus.on('composition.changed', (e) => changes.push(`${e.reason}:${e.state.text}`));
    await kernel.commands.execute('composition.insert', { text: 'hel' });
    await kernel.commands.execute('composition.acceptPrediction', { text: 'hello' });
    await kernel.commands.execute('composition.insert', { text: 'wrld' });
    await kernel.commands.execute('composition.deleteGrapheme');
    await kernel.commands.execute('composition.deleteWord');
    await kernel.commands.execute('composition.undo');
    await kernel.commands.execute('composition.clear');
    expect(changes).toEqual([
      'insert:hel',
      'accept-prediction:hello ',
      'insert:hello wrld',
      'delete-grapheme:hello wrl',
      'delete-word:hello ',
      'undo:hello wrl',
      'clear:',
    ]);
  });

  it('rejects malformed command args', async () => {
    const { kernel } = setup();
    await expect(
      kernel.commands.execute('composition.insert', {} as { text: string }),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      kernel.commands.execute(
        'composition.acceptPrediction',
        undefined as unknown as { text: string },
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('declares which permissions other plugins need for the built-in commands', () => {
    const { kernel } = setup();
    const byId = new Map(kernel.commands.list().map((d) => [d.id, d]));
    for (const id of [
      'composition.insert',
      'composition.deleteGrapheme',
      'composition.deleteWord',
      'composition.clear',
      'composition.undo',
      'composition.acceptPrediction',
    ]) {
      expect(byId.get(id)).toMatchObject({ public: true, requires: ['composition.write'] });
    }
    expect(byId.get('speech.speak')).toMatchObject({ public: true, requires: ['speech.output'] });
    expect(byId.get('speech.stop')).toMatchObject({ public: true, requires: ['speech.output'] });
    expect(byId.get('composition.speak')).toMatchObject({
      public: true,
      requires: ['speech.output', 'composition.read', 'composition.write'],
    });
    for (const id of ['gaze.pause', 'gaze.resume']) {
      expect(byId.get(id)).toMatchObject({ public: false, requires: [] });
    }

    const typist = { pluginId: 'community.typist', hasPermission: () => false };
    for (const id of ['composition.insert', 'speech.stop', 'gaze.pause', 'composition.speak']) {
      expect(() => kernel.commands.authorize(id, typist), id).toThrow(
        expect.objectContaining({ code: 'permission-denied' }) as Error,
      );
    }
    const speaker = {
      pluginId: 'community.speaker',
      hasPermission: (scope: string) => scope === 'speech.output',
    };
    expect(() => kernel.commands.authorize('speech.speak', speaker)).not.toThrow();
    expect(() => kernel.commands.authorize('speech.stop', speaker)).not.toThrow();
    // Speaking the composition also reads and clears it.
    expect(() => kernel.commands.authorize('composition.speak', speaker)).toThrow(
      expect.objectContaining({ code: 'permission-denied' }) as Error,
    );
  });

  it('composition.speak commits the composition, logs it and calls the speech service', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    const requested = vi.fn();
    kernel.bus.on('speech.requested', requested);
    kernel.composition.insert('  I am hungry ');
    const result = (await kernel.commands.execute('composition.speak')) as SpeakCommandResult;
    expect(result).toMatchObject({ spoken: true, text: 'I am hungry' });
    expect(kernel.composition.text).toBe('');
    expect(kernel.composition.nextUndoReason).toBe('commit');
    expect(speech.speak).toHaveBeenCalledWith('I am hungry', {});
    expect(kernel.conversation.listRecent(1)[0]).toMatchObject({
      body: 'I am hungry',
      sender: 'user',
    });
    expect(requested).toHaveBeenCalledWith({ text: 'I am hungry', recordId: result.recordId });
    await kernel.commands.execute('composition.undo');
    expect(kernel.composition.text).toBe('  I am hungry ');
  });

  it('composition.speak honours log: false and does nothing on an empty composition', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    await expect(kernel.commands.execute('composition.speak')).resolves.toEqual({
      spoken: false,
      text: '',
      recordId: null,
    });
    expect(speech.speak).not.toHaveBeenCalled();
    kernel.composition.insert('quiet');
    await expect(kernel.commands.execute('composition.speak', { log: false })).resolves.toEqual({
      spoken: true,
      text: 'quiet',
      recordId: null,
    });
    expect(kernel.conversation.listRecent(5)).toEqual([]);
    await expect(
      kernel.commands.execute('composition.speak', { log: 'no' } as never),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('speech.speak speaks the given text and never reads or changes the composition', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    kernel.composition.insert('secret draft');
    const changes = vi.fn();
    kernel.bus.on('composition.changed', changes);
    const result = (await kernel.commands.execute('speech.speak', {
      text: 'Yes',
      log: false,
    })) as SpeakCommandResult;
    expect(result).toEqual({ spoken: true, text: 'Yes', recordId: null });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(kernel.composition.text).toBe('secret draft');
    expect(changes).not.toHaveBeenCalled();
    expect(kernel.conversation.listRecent(5)).toEqual([]);
  });

  it('speech.speak requires non-empty text (the old no-text form is gone)', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    kernel.composition.insert('secret draft');
    for (const args of [
      undefined,
      {},
      { log: false },
      { text: '' },
      { text: '   ' },
      { text: 3 },
    ]) {
      await expect(
        kernel.commands.execute('speech.speak', args as never),
        JSON.stringify(args),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(kernel.composition.text).toBe('secret draft');
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('speech.speak passes voice, rate, pitch, volume, recording and interrupt to the service', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    await kernel.commands.execute('speech.speak', {
      text: 'Help',
      voiceId: 'community.voices/neural/Ava',
      rate: 1.5,
      pitch: 0.8,
      volume: 0.5,
      recording: 'phrases/audio/help.wav',
      interrupt: true,
      log: false,
    });
    expect(speech.speak).toHaveBeenCalledWith('Help', {
      voiceId: 'community.voices/neural/Ava',
      rate: 1.5,
      pitch: 0.8,
      volume: 0.5,
      recording: 'phrases/audio/help.wav',
      interrupt: true,
    });
  });

  it('speech.speak rejects invalid options, including unsafe recording paths', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel } = setup({ speech });
    for (const extra of [
      { rate: 0 },
      { rate: Number.NaN },
      { pitch: 3 },
      { volume: -1 },
      { voiceId: '' },
      { interrupt: 'yes' },
      { log: 1 },
      { colour: 'red' },
      { recording: '../settings.json' },
      { recording: '/etc/passwd' },
      { recording: 'a//b.wav' },
      { recording: 'a\\b.wav' },
      { recording: 'https://example.com/a.wav' },
      { recording: '' },
    ]) {
      await expect(
        kernel.commands.execute('speech.speak', { text: 'hi', ...extra } as never),
        JSON.stringify(extra),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(speech.speak).not.toHaveBeenCalled();
  });

  it('emits speech.unavailable and keeps the text when nothing can speak', async () => {
    const { kernel } = setup();
    const unavailable = vi.fn();
    kernel.bus.on('speech.unavailable', unavailable);
    kernel.composition.insert('hello');
    const result = (await kernel.commands.execute('composition.speak')) as SpeakCommandResult;
    expect(result).toMatchObject({ spoken: false, text: 'hello' });
    expect(kernel.conversation.listRecent(1)).toHaveLength(1);
    expect(unavailable).toHaveBeenCalledWith({
      text: 'hello',
      recordId: result.recordId,
      reason: 'no-service',
    });
    await kernel.commands.execute('composition.undo');
    expect(kernel.composition.text).toBe('hello');
    await expect(kernel.commands.execute('speech.stop')).resolves.toBe(false);

    const voiceless = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
      isAvailable: () => false,
    } satisfies SpeechService;
    const second = setup({ speech: voiceless });
    const events = vi.fn();
    second.kernel.bus.on('speech.unavailable', events);
    await expect(
      second.kernel.commands.execute('speech.speak', { text: 'hi', log: false }),
    ).resolves.toEqual({ spoken: false, text: 'hi', recordId: null });
    expect(voiceless.speak).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith({ text: 'hi', recordId: null, reason: 'no-voice' });
  });

  it('reports speech failures and tells the UI', async () => {
    const failing = {
      speak: () => Promise.reject(new Error('no voice')),
      stop: vi.fn(),
    } satisfies SpeechService;
    const second = setup({ speech: failing });
    const unavailable = vi.fn();
    second.kernel.bus.on('speech.unavailable', unavailable);
    await second.kernel.commands.execute('speech.speak', { text: 'hi' });
    await Promise.resolve();
    await Promise.resolve();
    expect(second.reportError).toHaveBeenCalledWith(expect.any(Error), 'speech.speak');
    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ reason: 'error' }));
    await expect(second.kernel.commands.execute('speech.stop')).resolves.toBe(true);
    expect(failing.stop).toHaveBeenCalled();
  });

  it('gaze commands delegate to the gaze control and emit pause changes', async () => {
    const gaze = { paused: false, pause: vi.fn(), resume: vi.fn() } satisfies GazeControl;
    const { kernel } = setup({ gaze });
    const changes: boolean[] = [];
    kernel.bus.on('gaze.pauseChanged', (e) => changes.push(e.paused));
    await expect(kernel.commands.execute('gaze.pause')).resolves.toBe(true);
    await expect(kernel.commands.execute('gaze.resume')).resolves.toBe(true);
    expect(gaze.pause).toHaveBeenCalled();
    expect(gaze.resume).toHaveBeenCalled();
    expect(changes).toEqual([true, false]);
    const bare = setup().kernel;
    await expect(bare.commands.execute('gaze.pause')).resolves.toBe(false);
  });

  it('runs commit transforms before speaking and word-boundary transforms after typing', async () => {
    const speech = {
      speak: vi.fn(() => Promise.resolve('completed' as const)),
      stop: vi.fn(),
    } satisfies SpeechService;
    const { kernel, reportError } = setup({ speech });
    const expand: TextTransform = {
      id: 'p/abbrev',
      name: 'Abbreviations',
      triggers: ['word-boundary'],
      transform: ({ text }) =>
        text.endsWith('brb ') ? `${text.slice(0, -4)}be right back ` : null,
    };
    const shout: TextTransform = {
      id: 'p/shout',
      name: 'Shout',
      triggers: ['commit'],
      transform: ({ text, locale }) => Promise.resolve(`${text}! (${locale})`),
    };
    const broken: TextTransform = {
      id: 'p/broken',
      name: 'Broken',
      triggers: ['commit', 'word-boundary'],
      transform: () => {
        throw new Error('bad transform');
      },
    };
    kernel.extensions.register('textTransforms', 'p', expand);
    kernel.extensions.register('textTransforms', 'p', broken);
    kernel.extensions.register('textTransforms', 'p', shout);
    await kernel.commands.execute('composition.insert', { text: 'brb' });
    await kernel.commands.execute('composition.insert', { text: ' ' });
    await vi.waitFor(() => expect(kernel.composition.text).toBe('be right back '));
    await kernel.commands.execute('composition.undo');
    expect(kernel.composition.text).toBe('brb ');
    const result = (await kernel.commands.execute('composition.speak')) as SpeakCommandResult;
    expect(result.text).toBe('brb! (en-GB)');
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'textTransform:p/broken');
  });

  it('does not apply a word-boundary transform if the user typed meanwhile', async () => {
    const { kernel } = setup();
    let release: (v: string) => void = () => undefined;
    kernel.extensions.register('textTransforms', 'p', {
      id: 'p/slow',
      name: 'Slow',
      triggers: ['word-boundary'],
      transform: () => new Promise<string>((resolve) => (release = resolve)),
    });
    await kernel.commands.execute('composition.insert', { text: 'a ' });
    await kernel.commands.execute('composition.insert', { text: 'b' });
    release('REPLACED');
    await Promise.resolve();
    await Promise.resolve();
    expect(kernel.composition.text).toBe('a b');
  });

  it('start loads settings, history and restores the composition snapshot', async () => {
    const savedSettings: SettingsSnapshot = { [GENERAL_SETTINGS_NAMESPACE]: { locale: 'fr-FR' } };
    const conv = memoryConversation();
    const snapshots: CompositionSnapshot[] = [];
    const composition: CompositionPersistence = {
      load: () => Promise.resolve({ version: 1, text: 'half typed', savedAt: 0 }),
      save: (s) => {
        snapshots.push(s);
        return Promise.resolve();
      },
    };
    const { kernel } = setup({
      persistence: {
        settings: { load: () => Promise.resolve(savedSettings), save: () => Promise.resolve() },
        conversation: conv.persistence,
        composition,
      },
    });
    const started = vi.fn();
    kernel.bus.on('kernel.started', started);
    await kernel.start();
    expect(kernel.started).toBe(true);
    expect(kernel.locale).toBe('fr-FR');
    expect(kernel.composition.text).toBe('half typed');
    expect(started).toHaveBeenCalledWith({ restoredComposition: true });
    await expect(kernel.start()).rejects.toMatchObject({ code: 'invalid-argument' });

    // every change is persisted; bursts coalesce to the latest state
    kernel.composition.insert('!');
    kernel.composition.insert('?');
    await kernel.flush();
    expect(snapshots.at(-1)?.text).toBe('half typed!?');
  });

  it('start survives broken persistence and reports it', async () => {
    const { kernel, reportError } = setup({
      persistence: {
        settings: { load: () => Promise.reject(new Error('s')), save: () => Promise.resolve() },
        conversation: {
          append: () => Promise.resolve(),
          loadRecent: () => Promise.reject(new Error('c')),
        },
        composition: { load: () => Promise.reject(new Error('x')), save: () => Promise.resolve() },
      },
    });
    await kernel.start();
    expect(reportError).toHaveBeenCalledTimes(3);
    await kernel.commands.execute('composition.insert', { text: 'still works' });
    expect(kernel.composition.text).toBe('still works');
  });

  it('ignores a garbage composition snapshot', async () => {
    const { kernel } = setup({
      persistence: {
        composition: { load: () => Promise.resolve({ nope: true }), save: () => Promise.resolve() },
      },
    });
    const started = vi.fn();
    kernel.bus.on('kernel.started', started);
    await kernel.start();
    expect(started).toHaveBeenCalledWith({ restoredComposition: false });
  });

  it('forwards subsystem events and isolates bad listeners', async () => {
    const { kernel, reportError } = setup();
    const seen: string[] = [];
    kernel.bus.on('composition.changed', () => {
      throw new Error('bad listener');
    });
    kernel.bus.on('composition.changed', () => seen.push('composition'));
    kernel.bus.on('regions.changed', () => seen.push('regions'));
    kernel.bus.on('context.changed', () => seen.push('context'));
    kernel.bus.on('extensions.changed', () => seen.push('extensions'));
    kernel.bus.on('settings.changed', () => seen.push('settings'));
    kernel.bus.on('conversation.appended', () => seen.push('conversation'));
    kernel.bus.on('command.didExecute', () => seen.push('command'));
    await kernel.commands.execute('composition.insert', { text: 'x' });
    kernel.regions.setVisible('side', false);
    kernel.context.set('app', { key: 'a', value: 1 });
    kernel.extensions.register('outputSinks', 'app', {
      id: 's',
      name: 's',
      send: () => Promise.resolve(),
    });
    kernel.settings.set(GENERAL_SETTINGS_NAMESPACE, 'locale', 'de-DE');
    kernel.conversation.append({ body: 'x' });
    expect(seen).toEqual([
      'composition',
      'command',
      'regions',
      'context',
      'extensions',
      'settings',
      'conversation',
    ]);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'event:composition.changed');
  });

  it('dispose tears everything down and is idempotent', async () => {
    const { kernel } = setup();
    const disposing = vi.fn();
    kernel.bus.on('kernel.disposing', disposing);
    kernel.dispose();
    kernel.dispose();
    expect(disposing).toHaveBeenCalledTimes(1);
    expect(kernel.commands.has('composition.insert')).toBe(false);
    await expect(kernel.start()).rejects.toMatchObject({ code: 'disposed' });
  });
});
