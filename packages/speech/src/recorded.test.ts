import { FakeClock } from '@forsee/core';
import type { SpeechEvent } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createRecordedMessageProvider, mimeTypeOf } from './recorded';
import { FakeAudioPlayer } from './testing';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(files: Record<string, Uint8Array | Error> = {}) {
  const clock = new FakeClock();
  const player = new FakeAudioPlayer();
  const reads: string[] = [];
  const provider = createRecordedMessageProvider({
    clock,
    player,
    readFile: (path) => {
      reads.push(path);
      const file = files[path];
      if (file === undefined) return Promise.reject(new Error(`not found: ${path}`));
      return file instanceof Error ? Promise.reject(file) : Promise.resolve(file);
    },
  });
  const events: SpeechEvent[] = [];
  const speak = (recording: string | undefined, id = 'u1') =>
    provider.speak(
      { id, text: 'hello', ...(recording === undefined ? {} : { recording }) },
      {
        onStart: (e) => events.push(e),
        onEnd: (e) => events.push(e),
        onError: (e) => events.push(e),
      },
    );
  return { provider, player, reads, events, speak, types: () => events.map((e) => e.type) };
}

describe('recorded message provider', () => {
  it('reads the file, plays it, and ends when playback ends', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { provider, player, reads, speak, types } = setup({ 'phrases/audio/hello.wav': bytes });
    expect(provider.id).toBe('forsee.recorded');
    const handle = speak('phrases/audio/hello.wav');
    expect(types()).toEqual([]); // still reading
    await flush();
    expect(reads).toEqual(['phrases/audio/hello.wav']);
    expect(player.plays[0]).toMatchObject({ audio: bytes, mimeType: 'audio/wav' });
    expect(types()).toEqual(['start']);
    player.current?.finish();
    expect(await handle.done).toBe('completed');
    expect(types()).toEqual(['start', 'end']);
  });

  it('offers no voices', async () => {
    expect(await setup().provider.listVoices()).toEqual([]);
  });

  it('fails before start when the file is missing, unreadable, or empty', async () => {
    const { speak, types, player } = setup({
      'a.wav': new Uint8Array(),
      'b.wav': new Error('disk error'),
    });
    for (const path of ['missing.wav', 'a.wav', 'b.wav']) {
      const handle = speak(path);
      expect(await handle.done).toBe('error');
    }
    expect(types()).toEqual(['error', 'end', 'error', 'end', 'error', 'end']);
    expect(player.plays).toHaveLength(0);
  });

  it('fails for a missing or invalid recording path, without reading anything', async () => {
    const { speak, reads } = setup();
    expect(await speak(undefined).done).toBe('error');
    expect(await speak('../secrets.wav').done).toBe('error');
    expect(await speak('/etc/passwd').done).toBe('error');
    expect(reads).toEqual([]);
  });

  it('fails when the player throws or its playback fails', async () => {
    const { speak, player, types } = setup({ 'a.wav': new Uint8Array([1]) });
    player.playError = new Error('no device');
    const first = speak('a.wav');
    await flush();
    expect(await first.done).toBe('error');
    player.playError = undefined;
    const second = speak('a.wav', 'u2');
    await flush();
    player.current?.finish('error');
    expect(await second.done).toBe('error');
    expect(types()).toEqual(['error', 'end', 'start', 'end']);
  });

  it('stop during playback stops the player and ends once with stopped', async () => {
    const { speak, provider, player, types } = setup({ 'a.wav': new Uint8Array([1]) });
    const handle = speak('a.wav');
    await flush();
    provider.stop();
    expect(player.current?.stopped).toBe(true);
    expect(await handle.done).toBe('stopped');
    await flush();
    expect(types()).toEqual(['start', 'end']);
  });

  it('stop while still reading means the audio never plays', async () => {
    const { speak, provider, player } = setup({ 'a.wav': new Uint8Array([1]) });
    const handle = speak('a.wav');
    provider.stop();
    await flush();
    expect(await handle.done).toBe('stopped');
    expect(player.plays).toHaveLength(0);
  });

  it('a new utterance stops the one playing', async () => {
    const { speak, player } = setup({ 'a.wav': new Uint8Array([1]), 'b.wav': new Uint8Array([2]) });
    const first = speak('a.wav', 'a');
    await flush();
    const second = speak('b.wav', 'b');
    expect(await first.done).toBe('stopped');
    await flush();
    expect(player.plays).toHaveLength(2);
    player.current?.finish();
    expect(await second.done).toBe('completed');
  });

  it('guesses the MIME type from the extension', () => {
    expect(mimeTypeOf('x/y.MP3')).toBe('audio/mpeg');
    expect(mimeTypeOf('x/y.ogg')).toBe('audio/ogg');
    expect(mimeTypeOf('x/y.m4a')).toBe('audio/mp4');
    expect(mimeTypeOf('x/y')).toBe('application/octet-stream');
  });
});
