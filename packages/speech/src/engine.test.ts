import { ExtensionRegistry, FakeClock, ForseeError, SequentialIdSource } from '@forsee/core';
import type { SpeechEvent } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createSpeechService } from './engine';
import { createRecordedMessageProvider } from './recorded';
import { applySpeechSettings, DEFAULT_SPEECH_SETTINGS } from './settings';
import { FakeAudioPlayer, FakeVoiceProvider, fakeVoice } from './testing';
import { globalVoiceId, isVoiceProviderId, selectVoice, splitVoiceId } from './voices';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(
  options: { policy?: 'queue' | 'interrupt'; extra?: boolean; extensions?: ExtensionRegistry } = {},
) {
  const clock = new FakeClock();
  const ids = new SequentialIdSource();
  const main = new FakeVoiceProvider({
    id: 'main',
    clock,
    voices: [
      fakeVoice('main', 'anna', 'en-US', { isDefault: true }),
      fakeVoice('main', 'bruno', 'de-DE'),
      fakeVoice('main', 'cloud', 'en-GB', { local: false }),
    ],
  });
  const other = new FakeVoiceProvider({
    id: 'other',
    clock,
    voices: [fakeVoice('other', 'fiona', 'en-GB')],
  });
  const errors: unknown[] = [];
  const engine = createSpeechService({
    clock,
    newId: () => ids.uuid(),
    providers: options.extra ? [main, other] : [main],
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    reportError: (e) => errors.push(e),
  });
  const events: SpeechEvent[] = [];
  engine.events.on('speech', (e) => events.push(e));
  return { clock, main, other, engine, events, errors };
}

describe('speech engine: policy', () => {
  it('queues by default', async () => {
    const { engine, main } = setup();
    const a = engine.speak('first');
    const b = engine.speak('second');
    expect(main.spoken.map((u) => u.text)).toEqual(['first']);
    main.completeCurrent();
    expect(await a).toBe('completed');
    expect(main.spoken.map((u) => u.text)).toEqual(['first', 'second']);
    main.completeCurrent();
    expect(await b).toBe('completed');
  });

  it('interrupts when asked, dropping pending speech', async () => {
    const { engine, main } = setup();
    const a = engine.speak('one');
    const b = engine.speak('two');
    const c = engine.speak('urgent', { interrupt: true });
    expect(await a).toBe('stopped');
    expect(await b).toBe('stopped');
    expect(main.spoken.map((u) => u.text)).toEqual(['one', 'urgent']);
    main.completeCurrent();
    expect(await c).toBe('completed');
  });

  it('interrupts by default under the interrupt policy, and can be told to queue', async () => {
    const { engine, main } = setup({ policy: 'interrupt' });
    const a = engine.speak('one');
    const b = engine.speak('two');
    expect(await a).toBe('stopped');
    const c = engine.speak('three', { interrupt: false });
    expect(main.spoken.map((u) => u.text)).toEqual(['one', 'two']);
    main.completeCurrent();
    expect(await b).toBe('completed');
    main.completeCurrent();
    expect(await c).toBe('completed');
  });

  it('stop is synchronous, clears the queue and stops the provider', async () => {
    const { engine, main, events } = setup();
    const a = engine.speak('one');
    const b = engine.speak('two');
    engine.stop();
    expect(engine.queue.speaking).toBe(false);
    expect(engine.queue.pending).toBe(0);
    expect(main.stopCalls).toBeGreaterThan(0);
    expect(await Promise.all([a, b])).toEqual(['stopped', 'stopped']);
    expect(
      events.filter((e) => e.type === 'end').map((e) => (e as { reason: string }).reason),
    ).toEqual(['stopped', 'stopped']);
  });

  it('resolves blank text as completed without speaking', async () => {
    const { engine, main } = setup();
    expect(await engine.speak('   ')).toBe('completed');
    expect(main.spoken).toHaveLength(0);
  });

  it('applies settings and per-call options, clamped', () => {
    const { engine, main } = setup();
    engine.updateSettings({ rate: 50, pitch: -3 });
    void engine.speak('x', { volume: 0.5 });
    expect(main.spoken[0]).toMatchObject({ rate: 10, pitch: 0, volume: 0.5 });
    main.completeCurrent();
    void engine.speak('y', { rate: 0.01 });
    expect(main.spoken[1]?.rate).toBe(0.1);
  });

  it('after dispose, speak resolves stopped', async () => {
    const { engine } = setup();
    engine.dispose();
    expect(await engine.speak('x')).toBe('stopped');
  });
});

describe('speech engine: providers and routing', () => {
  it('lists only local voices by default, all with includeNetwork', async () => {
    const { engine } = setup({ extra: true });
    const local = await engine.listVoices();
    expect(local.map((v) => `${v.providerId}/${v.id}`)).toEqual([
      'main/anna',
      'main/bruno',
      'other/fiona',
    ]);
    const all = await engine.listVoices({ includeNetwork: true });
    expect(all).toHaveLength(4);
  });

  it('routes by the provider part of the voice id', () => {
    const { engine, main, other } = setup({ extra: true });
    void engine.speak('hi', { voiceId: 'other/fiona' });
    expect(other.spoken).toHaveLength(1);
    expect(main.spoken).toHaveLength(0);
  });

  it('sends unknown providers to the default provider and drops the bad voice id', () => {
    const { engine, main } = setup({ extra: true });
    void engine.speak('hi', { voiceId: 'nobody/x' });
    expect(main.spoken[0]?.text).toBe('hi');
    expect(main.spoken[0]?.voiceId).toBeUndefined();
  });

  it('ends with error when there is no provider at all', async () => {
    const clock = new FakeClock();
    const errors: unknown[] = [];
    const engine = createSpeechService({
      clock,
      newId: () => 'u1',
      reportError: (e) => errors.push(e),
    });
    expect(await engine.speak('hello')).toBe('error');
  });

  it('isolates a throwing provider and keeps working', async () => {
    const { engine, main } = setup();
    main.behaviour = 'throw';
    expect(await engine.speak('boom')).toBe('error');
    main.behaviour = 'manual';
    const ok = engine.speak('fine');
    main.completeCurrent();
    expect(await ok).toBe('completed');
  });

  it('picks up providers contributed through the extension registry and drops them on unload', async () => {
    const extensions = new ExtensionRegistry();
    const clock = new FakeClock();
    const plugin = new FakeVoiceProvider({
      id: 'community.voices',
      clock,
      voices: [fakeVoice('community.voices', 'zed', 'fr-FR')],
    });
    const { engine } = setup({ extensions });
    expect(await engine.listVoices()).toHaveLength(2);
    extensions.register('voiceProviders', 'community.voices', plugin);
    expect((await engine.listVoices()).map((v) => v.id)).toContain('zed');
    extensions.disposeOwner('community.voices');
    expect((await engine.listVoices()).map((v) => v.id)).not.toContain('zed');
  });

  it('routes to plugin providers, whose ids contain a slash, even for voice ids with slashes', async () => {
    const extensions = new ExtensionRegistry();
    const clock = new FakeClock();
    const plugin = new FakeVoiceProvider({
      id: 'community.voices/neural',
      clock,
      voices: [fakeVoice('community.voices/neural', 'en/ava', 'en-GB')],
    });
    const { engine, main, errors } = setup({ extensions });
    extensions.register('voiceProviders', 'community.voices', plugin);
    const voices = await engine.listVoices();
    const ava = voices.find((v) => v.providerId === 'community.voices/neural');
    expect(ava).toBeDefined();
    const voiceId = globalVoiceId('community.voices/neural', 'en/ava');
    void engine.speak('hello', { voiceId });
    expect(plugin.spoken.map((u) => [u.text, u.voiceId])).toEqual([['hello', voiceId]]);
    expect(main.spoken).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports whether a synthesis provider is available', () => {
    const { engine } = setup();
    expect(engine.isAvailable()).toBe(true);
    const clock = new FakeClock();
    const empty = createSpeechService({ clock, newId: () => 'u1' });
    expect(empty.isAvailable()).toBe(false);
    const recordedOnly = createSpeechService({
      clock,
      newId: () => 'u1',
      providers: [
        createRecordedMessageProvider({
          clock,
          readFile: () => Promise.resolve(new Uint8Array([1])),
          player: new FakeAudioPlayer(),
        }),
      ],
    });
    expect(recordedOnly.isAvailable()).toBe(false);
    engine.dispose();
    expect(engine.isAvailable()).toBe(false);
  });

  it('rejects a duplicate provider id and skips failing listVoices', async () => {
    const { engine, main, errors } = setup();
    expect(() => engine.registerProvider(main)).toThrow(ForseeError);
    main.listVoicesError = new Error('no voices today');
    expect(await engine.listVoices()).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('speech engine: voice selection', () => {
  it('selectVoice: by id, else locale, else default', () => {
    const voices = [
      fakeVoice('p', 'a', 'en-US'),
      fakeVoice('p', 'b', 'en-GB', { isDefault: true }),
      fakeVoice('p', 'c', 'de-DE'),
      fakeVoice('p', 'd', 'de_AT'),
    ];
    expect(selectVoice(voices, { voiceId: 'p/c' })?.id).toBe('c');
    expect(selectVoice(voices, { voiceId: 'p/zzz', locale: 'de-DE' })?.id).toBe('c');
    expect(selectVoice(voices, { locale: 'de-at' })?.id).toBe('d');
    expect(selectVoice(voices, { locale: 'en' })?.id).toBe('b'); // same language, default preferred
    expect(selectVoice(voices, { locale: 'ja-JP' })?.id).toBe('b'); // no match: the default
    expect(selectVoice(voices, {})?.id).toBe('b');
    expect(selectVoice([fakeVoice('p', 'x')], { voiceId: 'q/y' })?.id).toBe('x');
    expect(selectVoice([], { voiceId: 'p/a' })).toBeUndefined();
  });

  it('resolveVoice never returns a network voice by default', async () => {
    const { engine } = setup();
    expect((await engine.resolveVoice({ voiceId: 'main/cloud' }))?.id).toBe('anna');
    expect((await engine.resolveVoice({ voiceId: 'main/bruno' }))?.id).toBe('bruno');
    expect((await engine.resolveVoice({ locale: 'de' }))?.id).toBe('bruno');
  });

  it('speak uses the chosen voice, and falls back by locale when it is not offered', async () => {
    const { engine, main } = setup();
    await engine.listVoices(); // fill the cache
    engine.setVoice('main/bruno');
    void engine.speak('a');
    expect(main.spoken[0]?.voiceId).toBe('main/bruno');
    main.completeCurrent();

    engine.updateSettings({ voiceId: 'main/cloud', locale: 'de-DE' }); // network voice: not offered
    void engine.speak('b');
    expect(main.spoken[1]?.voiceId).toBe('main/bruno');
    main.completeCurrent();

    engine.updateSettings({ voiceId: undefined, locale: undefined });
    void engine.speak('c');
    expect(main.spoken[2]?.voiceId).toBeUndefined(); // the provider's own default
  });

  it('setVoice rejects blank ids', () => {
    const { engine } = setup();
    expect(() => engine.setVoice('  ')).toThrow(ForseeError);
  });

  it('splits global voice ids at the last slash and escapes slashes in voice ids', () => {
    expect(globalVoiceId('web', 'a/b')).toBe('web/a%2Fb');
    expect(splitVoiceId('web/a%2Fb')).toEqual({ providerId: 'web', voiceId: 'a/b' });
    expect(splitVoiceId('community.voices/neural/a%2Fb')).toEqual({
      providerId: 'community.voices/neural',
      voiceId: 'a/b',
    });
    expect(splitVoiceId('nope')).toBeUndefined();
  });

  it('accepts app and plugin provider ids, nothing else', () => {
    for (const id of ['forsee.web-speech', 'community.voices/neural', 'a/b']) {
      expect(isVoiceProviderId(id), id).toBe(true);
    }
    for (const id of ['', '/a', 'a/', 'a//b', 'a/b/c', 'a b', 'a%2F', 3]) {
      expect(isVoiceProviderId(id), String(id)).toBe(false);
    }
  });
});

describe('speech settings', () => {
  it('clamps numbers and ignores junk', () => {
    const result = applySpeechSettings(DEFAULT_SPEECH_SETTINGS, {
      rate: 99,
      pitch: Number.NaN,
      volume: -1,
    });
    expect(result.settings).toMatchObject({ rate: 10, pitch: 1, volume: 0 });
    expect(result.issues).toHaveLength(3);
    const text = applySpeechSettings(DEFAULT_SPEECH_SETTINGS, 'garbage');
    expect(text.settings).toEqual(DEFAULT_SPEECH_SETTINGS);
    expect(text.issues).toEqual([]);
  });

  it('keeps unrelated values when patching, and clears voice with blank or undefined', () => {
    const base = applySpeechSettings(DEFAULT_SPEECH_SETTINGS, {
      voiceId: 'a/b',
      locale: 'en',
      rate: 2,
    }).settings;
    const patched = applySpeechSettings(base, { pitch: 1.5 }).settings;
    expect(patched).toEqual({ voiceId: 'a/b', locale: 'en', rate: 2, pitch: 1.5, volume: 1 });
    expect(applySpeechSettings(base, { voiceId: ' ' }).settings.voiceId).toBeUndefined();
    expect(applySpeechSettings(base, { locale: undefined }).settings.locale).toBeUndefined();
    expect(applySpeechSettings(base, { voiceId: 42 }).issues).toHaveLength(1);
  });

  it('emits settingsChanged', () => {
    const { engine } = setup();
    const seen: number[] = [];
    engine.events.on('settingsChanged', (s) => seen.push(s.rate));
    engine.updateSettings({ rate: 1.5 });
    expect(seen).toEqual([1.5]);
    expect(engine.settings.rate).toBe(1.5);
  });
});

describe('speech engine: recorded messages', () => {
  function withRecorded(files: Record<string, Uint8Array>) {
    const base = setup();
    const player = new FakeAudioPlayer();
    const recorded = createRecordedMessageProvider({
      clock: base.clock,
      player,
      readFile: (path) => {
        const bytes = files[path];
        return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`missing ${path}`));
      },
    });
    base.engine.registerProvider(recorded);
    const fallbacks: unknown[] = [];
    base.engine.events.on('fallback', (f) => fallbacks.push(f));
    return { ...base, player, fallbacks };
  }

  it('plays the recording instead of synthesising', async () => {
    const { engine, main, player, events } = withRecorded({
      'phrases/audio/hello.wav': new Uint8Array([1, 2]),
    });
    const done = engine.speak('Hello', { recording: 'phrases/audio/hello.wav' });
    await flush();
    expect(player.plays).toHaveLength(1);
    expect(player.plays[0]?.mimeType).toBe('audio/wav');
    expect(main.spoken).toHaveLength(0);
    player.current?.finish();
    expect(await done).toBe('completed');
    expect(events.map((e) => e.type)).toEqual(['start', 'end']);
  });

  it('falls back to synthesising the text when the recording is missing, and reports it', async () => {
    const { engine, main, fallbacks, events } = withRecorded({});
    const done = engine.speak('Hello there', { recording: 'phrases/audio/gone.wav' });
    await flush();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ recording: 'phrases/audio/gone.wav' });
    expect(main.spoken.map((u) => u.text)).toEqual(['Hello there']);
    expect(main.spoken[0]?.recording).toBeUndefined();
    main.completeCurrent();
    expect(await done).toBe('completed');
    // No error event leaked to listeners: the user heard the message.
    expect(events.map((e) => e.type)).toEqual(['start', 'end']);
  });

  it('falls back when the player throws', async () => {
    const { engine, main, player, fallbacks } = withRecorded({ 'a.wav': new Uint8Array([1]) });
    player.playError = new Error('no audio device');
    const done = engine.speak('Hi', { recording: 'a.wav' });
    await flush();
    expect(fallbacks).toHaveLength(1);
    main.completeCurrent();
    expect(await done).toBe('completed');
  });

  it('does not fall back after audio has started', async () => {
    const { engine, main, player, fallbacks } = withRecorded({ 'a.wav': new Uint8Array([1]) });
    const done = engine.speak('Hi', { recording: 'a.wav' });
    await flush();
    player.current?.finish('error');
    expect(await done).toBe('error');
    expect(fallbacks).toHaveLength(0);
    expect(main.spoken).toHaveLength(0);
  });

  it('falls back when no recorded provider is registered', async () => {
    const { engine, main } = setup();
    const seen: unknown[] = [];
    engine.events.on('fallback', (f) => seen.push(f));
    const done = engine.speak('Hi', { recording: 'a.wav' });
    main.completeCurrent();
    expect(await done).toBe('completed');
    expect(seen).toHaveLength(1);
  });

  it('stop cancels a recording in flight, including while it is still loading', async () => {
    const { engine, player } = withRecorded({ 'a.wav': new Uint8Array([1]) });
    const early = engine.speak('Hi', { recording: 'a.wav' });
    engine.stop();
    expect(await early).toBe('stopped');
    await flush();
    expect(player.plays).toHaveLength(0);

    const playing = engine.speak('Hi', { recording: 'a.wav' });
    await flush();
    engine.stop();
    expect(await playing).toBe('stopped');
    expect(player.current?.stopped).toBe(true);
  });
});
