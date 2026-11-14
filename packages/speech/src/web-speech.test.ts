import { FakeClock } from '@forsee/core';
import type { SpeechEvent, Utterance } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { chunkText, wordLengthAt } from './chunking';
import { createWebSpeechProvider } from './web-speech';
import { FakeSpeechSynthesis, fakeBrowserVoice } from './testing';

const VOICES = [
  fakeBrowserVoice('Samantha', 'en-US', { default: true }),
  fakeBrowserVoice('Daniel', 'en_GB'),
  fakeBrowserVoice('Google US English', 'en-US', { localService: false }),
];

function setup(
  options: {
    voices?: typeof VOICES;
    requireActivation?: boolean;
    requireUnlock?: boolean;
    localOnly?: boolean;
    maxChunkChars?: number;
  } = {},
) {
  const clock = new FakeClock();
  const synthesis = new FakeSpeechSynthesis({
    voices: options.voices ?? VOICES,
    requireActivation: options.requireActivation ?? false,
  });
  const provider = createWebSpeechProvider({
    synthesis,
    createUtterance: synthesis.createUtterance,
    clock,
    ...(options.requireUnlock === undefined ? {} : { requireUnlock: options.requireUnlock }),
    ...(options.localOnly === undefined ? {} : { localOnly: options.localOnly }),
    ...(options.maxChunkChars === undefined ? {} : { maxChunkChars: options.maxChunkChars }),
  });
  const events: SpeechEvent[] = [];
  const speak = (text: string, extra: Partial<Utterance> = {}, id = 'u1') => {
    const handle = provider.speak(
      { id, text, ...extra },
      {
        onStart: (e) => events.push(e),
        onBoundary: (e) => events.push(e),
        onEnd: (e) => events.push(e),
        onError: (e) => events.push(e),
      },
    );
    return handle;
  };
  const types = () => events.map((e) => e.type);
  return { clock, synthesis, provider, events, speak, types };
}

describe('web speech: voices', () => {
  it('lists only local voices, mapped to the provider id', async () => {
    const { provider } = setup();
    const voices = await provider.listVoices();
    expect(voices.map((v) => v.id)).toEqual(['Samantha', 'Daniel']);
    expect(voices[0]).toMatchObject({
      providerId: 'forsee.web-speech',
      local: true,
      isDefault: true,
      locale: 'en-US',
    });
    expect(voices[1]?.locale).toBe('en-GB'); // underscore normalised
  });

  it('offers network voices when localOnly is off, flagged as not local', async () => {
    const { provider } = setup({ localOnly: false });
    const voices = await provider.listVoices();
    expect(voices).toHaveLength(3);
    expect(voices.find((v) => v.id === 'Google US English')?.local).toBe(false);
  });

  it('waits for a late voiceschanged', async () => {
    const { provider, synthesis } = setup({ voices: [] });
    let result: readonly unknown[] | undefined;
    const pending = provider.listVoices().then((v) => (result = v));
    await Promise.resolve();
    expect(result).toBeUndefined();
    expect(synthesis.voicesListenerCount).toBe(1);
    synthesis.loadVoices(VOICES);
    await pending;
    expect(result).toHaveLength(2);
    expect(synthesis.voicesListenerCount).toBe(0);
  });

  it('shares one wait between concurrent calls and gives up after the timeout', async () => {
    const { provider, synthesis, clock } = setup({ voices: [] });
    const a = provider.listVoices();
    const b = provider.listVoices();
    expect(synthesis.voicesListenerCount).toBe(1);
    clock.advance(2000);
    expect(await a).toEqual([]);
    expect(await b).toEqual([]);
    expect(synthesis.voicesListenerCount).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('cleans the timer up when voices arrive', async () => {
    const { provider, synthesis, clock } = setup({ voices: [] });
    const pending = provider.listVoices();
    synthesis.loadVoices(VOICES);
    await pending;
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('web speech: speaking', () => {
  it('speaks with the requested local voice and settings', () => {
    const { synthesis, speak, events, types } = setup();
    const handle = speak('Hello world', {
      voiceId: 'forsee.web-speech/Daniel',
      rate: 1.5,
      pitch: 0.8,
      volume: 0.4,
    });
    const u = synthesis.queue[0];
    expect(u).toMatchObject({
      text: 'Hello world',
      rate: 1.5,
      pitch: 0.8,
      volume: 0.4,
      lang: 'en_GB',
    });
    expect(u?.voice?.name).toBe('Daniel');
    synthesis.start();
    synthesis.boundary(6, 5);
    synthesis.end();
    expect(types()).toEqual(['start', 'boundary', 'end']);
    expect(events[1]).toMatchObject({ charIndex: 6, charLength: 5 });
    return handle.done.then((reason) => expect(reason).toBe('completed'));
  });

  it('uses the default local voice, never a network one, when none is requested or found', () => {
    const { synthesis, speak } = setup();
    speak('a');
    expect(synthesis.queue[0]?.voice?.name).toBe('Samantha');
    synthesis.end();
    speak('b', { voiceId: 'forsee.web-speech/Google US English' }, 'u2');
    expect(synthesis.queue[0]?.voice?.name).toBe('Samantha');
  });

  it('fails when only network voices exist (offline speech is impossible)', async () => {
    const { speak, types, synthesis } = setup({
      voices: [fakeBrowserVoice('Cloud', 'en-US', { localService: false })],
    });
    const handle = speak('hello');
    expect(await handle.done).toBe('error');
    expect(types()).toEqual(['error', 'end']);
    expect(synthesis.spoken).toHaveLength(0);
  });

  it('speaks with the browser default when it reports no voices at all', () => {
    const { synthesis, speak } = setup({ voices: [] });
    speak('hello');
    expect(synthesis.queue[0]?.voice).toBeNull();
  });

  it('derives the word length when the platform sends no charLength, and ignores sentence boundaries', () => {
    const { synthesis, speak, events } = setup();
    speak('say hello now');
    synthesis.start();
    synthesis.boundary(4);
    synthesis.boundary(0, 3, 'sentence');
    synthesis.boundary(10, undefined, undefined);
    expect(events.filter((e) => e.type === 'boundary')).toMatchObject([
      { charIndex: 4, charLength: 5 },
      { charIndex: 10, charLength: 3 },
    ]);
  });

  it('works when the platform sends no boundary events at all', async () => {
    const { synthesis, speak, types } = setup();
    const handle = speak('quiet platform');
    synthesis.start();
    synthesis.end();
    expect(await handle.done).toBe('completed');
    expect(types()).toEqual(['start', 'end']);
  });

  it('completes immediately for blank text', async () => {
    const { synthesis, speak } = setup();
    expect(await speak('   ').done).toBe('completed');
    expect(synthesis.spoken).toHaveLength(0);
  });

  it('reports a synthesis error', async () => {
    const { synthesis, speak, types } = setup();
    const handle = speak('hello');
    synthesis.start();
    synthesis.error('synthesis-failed');
    expect(await handle.done).toBe('error');
    expect(types()).toEqual(['start', 'error', 'end']);
  });

  it('reports a speak() that throws', async () => {
    const { synthesis, speak } = setup();
    synthesis.speakError = new Error('boom');
    expect(await speak('hello').done).toBe('error');
  });
});

describe('web speech: chunking', () => {
  const LONG =
    'This is the first sentence of a long message. Here comes the second one, which is a little longer than the first. ' +
    'And a third. The fourth sentence closes the whole thing off nicely.';

  it('splits long text at sentence ends, speaking the pieces in turn as one utterance', async () => {
    const { synthesis, speak, events } = setup({ maxChunkChars: 60 });
    const handle = speak(LONG);
    const spokenTexts: string[] = [];
    for (let i = 0; i < 20 && synthesis.queue.length > 0; i += 1) {
      expect(synthesis.queue).toHaveLength(1); // one at a time
      spokenTexts.push(synthesis.queue[0]?.text ?? '');
      synthesis.start();
      synthesis.end();
    }
    expect(spokenTexts.length).toBeGreaterThan(2);
    expect(spokenTexts.join('')).toBe(LONG);
    expect(spokenTexts.every((t) => t.length <= 60)).toBe(true);
    expect(await handle.done).toBe('completed');
    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'end')).toHaveLength(1);
  });

  it('maps boundary offsets back to the whole text', () => {
    const { synthesis, speak, events } = setup({ maxChunkChars: 60 });
    speak(LONG);
    synthesis.start();
    synthesis.end(); // first chunk done
    const second = synthesis.queue[0]?.text ?? '';
    synthesis.start();
    synthesis.boundary(0, 4);
    const boundary = events.find((e) => e.type === 'boundary');
    const index = boundary && 'charIndex' in boundary ? boundary.charIndex : -1;
    expect(LONG.startsWith(second, index)).toBe(true);
    expect(index).toBeGreaterThan(0);
  });

  it('chunkText: concatenates back, respects the limit, prefers sentence ends, handles unbroken text', () => {
    const chunks = chunkText(LONG, 60);
    expect(chunks.map((c) => c.text).join('')).toBe(LONG);
    expect(chunks.every((c) => c.text.length <= 60)).toBe(true);
    expect(chunks[0]?.text.endsWith('sentence of a long message.')).toBe(true);
    for (const chunk of chunks)
      expect(LONG.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);

    const unbroken = 'a'.repeat(100);
    expect(chunkText(unbroken, 30).map((c) => c.text.length)).toEqual([30, 30, 30, 10]);
    expect(chunkText('hi', 30)).toEqual([{ start: 0, text: 'hi' }]);
    expect(chunkText('  \n ', 30)).toEqual([]);
    // Never between the halves of a surrogate pair.
    const emoji = '😀'.repeat(30);
    for (const chunk of chunkText(emoji, 25)) {
      expect(chunk.text).not.toMatch(/^[\udc00-\udfff]/u);
      expect(chunk.text).not.toMatch(/[\ud800-\udbff]$/u);
    }
    expect(wordLengthAt('say hello now', 4)).toBe(5);
  });
});

describe('web speech: stop and cancel races', () => {
  it('stop ends the handle synchronously, cancelling the browser', async () => {
    const { synthesis, speak, types, provider } = setup();
    const handle = speak('hello');
    synthesis.start();
    provider.stop();
    expect(synthesis.cancelCalls).toBe(1);
    expect(types()).toEqual(['start', 'end']);
    expect(await handle.done).toBe('stopped');
  });

  it('ignores the late canceled error after stop', () => {
    const { synthesis, speak, types, provider } = setup();
    synthesis.deferCancelEvents = true;
    speak('hello');
    synthesis.start();
    provider.stop();
    synthesis.flushCancelEvents();
    expect(types()).toEqual(['start', 'end']);
  });

  it('a new utterance right after a cancel is not killed by the old one cancel event', async () => {
    const { synthesis, speak, events, provider } = setup();
    synthesis.deferCancelEvents = true;
    speak('first', {}, 'a');
    synthesis.start();
    const second = speak('second', {}, 'b'); // stops "a" and speaks "b"
    expect(synthesis.cancelCalls).toBe(1);
    expect(events.map((e) => `${e.type}:${e.utteranceId}`)).toEqual(['start:a', 'end:a']);
    synthesis.flushCancelEvents(); // the old canceled error finally arrives
    expect(synthesis.queue.map((u) => u.text)).toEqual(['second']);
    synthesis.start();
    synthesis.end();
    expect(await second.done).toBe('completed');
    provider.stop();
  });

  it('handle.stop() works like provider.stop(), and stop on an ended handle is a no-op', async () => {
    const { synthesis, speak } = setup();
    const handle = speak('hello');
    synthesis.start();
    synthesis.end();
    handle.stop();
    expect(synthesis.cancelCalls).toBe(0);
    expect(await handle.done).toBe('completed');
  });

  it('treats a cancel from outside as stopped, not as an error', async () => {
    const { synthesis, speak, types } = setup();
    const handle = speak('hello');
    synthesis.start();
    synthesis.error('interrupted');
    expect(await handle.done).toBe('stopped');
    expect(types()).toEqual(['start', 'end']);
  });

  it('stopping mid-chunks ends once and does not speak the remaining chunks', async () => {
    const { synthesis, speak, provider } = setup({ maxChunkChars: 30 });
    const handle = speak('One two three four. Five six seven eight. Nine ten eleven twelve.');
    synthesis.start();
    provider.stop();
    expect(await handle.done).toBe('stopped');
    expect(synthesis.spoken).toHaveLength(1);
  });
});

describe('web speech: user gesture lock', () => {
  it('locks on not-allowed, holds the utterance, and speaks it after unlock()', async () => {
    const { synthesis, provider, speak, types } = setup({ requireActivation: true });
    const changes: boolean[] = [];
    provider.onLockedChange((l) => changes.push(l));
    expect(provider.locked).toBe(false); // optimistic, as in the prototype
    const handle = speak('hello');
    synthesis.start(); // browser refuses: not-allowed
    expect(provider.locked).toBe(true);
    expect(types()).toEqual([]); // no end, no error: the text is preserved
    expect(synthesis.spoken).toHaveLength(1);

    synthesis.activate(); // the user clicked
    provider.unlock();
    expect(provider.locked).toBe(false);
    expect(synthesis.spoken).toHaveLength(2);
    expect(synthesis.spoken[1]?.text).toBe('hello');
    synthesis.start();
    synthesis.end();
    expect(await handle.done).toBe('completed');
    expect(types()).toEqual(['start', 'end']);
    expect(changes).toEqual([true, false]);
  });

  it('requireUnlock holds speech before the first gesture without touching the browser', async () => {
    const { synthesis, provider, speak } = setup({ requireUnlock: true });
    expect(provider.locked).toBe(true);
    const handle = speak('hello');
    expect(synthesis.spoken).toHaveLength(0);
    provider.unlock();
    expect(synthesis.queue.map((u) => u.text)).toEqual(['hello']);
    synthesis.start();
    synthesis.end();
    expect(await handle.done).toBe('completed');
  });

  it('a newer utterance replaces the held one, which ends stopped', async () => {
    const { synthesis, provider, speak } = setup({ requireUnlock: true });
    const first = speak('first', {}, 'a');
    const second = speak('second', {}, 'b');
    expect(await first.done).toBe('stopped');
    provider.unlock();
    expect(synthesis.queue.map((u) => u.text)).toEqual(['second']);
    synthesis.start();
    synthesis.end();
    expect(await second.done).toBe('completed');
  });

  it('stopping a held utterance ends it without calling cancel', async () => {
    const { synthesis, provider, speak } = setup({ requireUnlock: true });
    const handle = speak('hello');
    provider.stop();
    expect(await handle.done).toBe('stopped');
    expect(synthesis.cancelCalls).toBe(0);
  });

  it('unlock() with nothing held primes speech with a silent utterance, as the legacy prototype did', () => {
    const { synthesis, provider, clock } = setup({ requireUnlock: true });
    provider.unlock();
    const primer = synthesis.spoken[0];
    expect(primer).toMatchObject({ text: '', volume: 0, rate: 10 });
    expect(provider.locked).toBe(false);
    clock.advance(20);
    expect(synthesis.cancelCalls).toBe(1);
  });

  it('priming does not cancel real speech started in the meantime', () => {
    const { synthesis, provider, clock, speak } = setup({ requireUnlock: true });
    provider.unlock();
    speak('real');
    clock.advance(20);
    expect(synthesis.cancelCalls).toBe(0);
  });

  it('priming that is refused leaves the provider locked', () => {
    const { synthesis, provider } = setup({ requireUnlock: true, requireActivation: true });
    provider.unlock();
    synthesis.start();
    expect(provider.locked).toBe(true);
  });

  it('a throwing speak during priming keeps it locked', () => {
    const { synthesis, provider } = setup({ requireUnlock: true });
    synthesis.speakError = new Error('nope');
    provider.unlock();
    expect(provider.locked).toBe(true);
  });
});
