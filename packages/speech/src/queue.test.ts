import { FakeClock } from '@forsee/core';
import type { SpeechEndReason, SpeechEvent, Utterance } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { defaultWatchdogMs, createUtteranceQueue } from './queue';
import { FakeVoiceProvider } from './testing';

function utterance(id: string, text = id, extra: Partial<Utterance> = {}): Utterance {
  return { id, text, ...extra };
}

function setup(behaviour: 'manual' | 'silent' | 'throw' | 'auto' = 'manual') {
  const clock = new FakeClock();
  const provider = new FakeVoiceProvider({ clock, behaviour });
  const errors: unknown[] = [];
  const queue = createUtteranceQueue({
    clock,
    play: (u, events) => provider.speak(u, events),
    reportError: (error) => errors.push(error),
  });
  const events: SpeechEvent[] = [];
  queue.onEvent((event) => events.push(event));
  const summary = () => events.map((e) => `${e.type}:${e.utteranceId}`);
  return { clock, provider, queue, events, errors, summary };
}

describe('utterance queue ordering', () => {
  it('plays one utterance at a time, in order', async () => {
    const { provider, queue, summary } = setup();
    const a = queue.enqueue(utterance('a'));
    const b = queue.enqueue(utterance('b'));
    expect(provider.spoken.map((u) => u.id)).toEqual(['a']);
    expect(queue.speaking).toBe(true);
    expect(queue.pending).toBe(1);

    provider.completeCurrent();
    expect(await a.done).toBe('completed');
    expect(provider.spoken.map((u) => u.id)).toEqual(['a', 'b']);
    expect(queue.pending).toBe(0);

    provider.completeCurrent();
    expect(await b.done).toBe('completed');
    expect(queue.speaking).toBe(false);
    expect(summary()).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('re-emits boundaries under the queue utterance id', () => {
    const { provider, queue, events } = setup();
    queue.enqueue(utterance('a', 'hello world'));
    provider.boundary(6, 5);
    const boundary = events.find((e) => e.type === 'boundary');
    expect(boundary).toMatchObject({ utteranceId: 'a', charIndex: 6, charLength: 5 });
  });

  it('starts a new utterance enqueued from an end listener', async () => {
    const { provider, queue } = setup();
    let second: Promise<SpeechEndReason> | undefined;
    queue.onEvent((event) => {
      if (event.type === 'end' && event.utteranceId === 'a')
        second = queue.enqueue(utterance('b')).done;
    });
    queue.enqueue(utterance('a'));
    provider.completeCurrent();
    expect(provider.spoken.map((u) => u.id)).toEqual(['a', 'b']);
    provider.completeCurrent();
    expect(await second).toBe('completed');
  });
});

describe('stopAll', () => {
  it('stops the current and pending utterances synchronously', async () => {
    const { provider, queue, summary } = setup();
    const a = queue.enqueue(utterance('a'));
    const b = queue.enqueue(utterance('b'));
    const c = queue.enqueue(utterance('c'));
    queue.stopAll();
    // Synchronous: state is already empty.
    expect(queue.speaking).toBe(false);
    expect(queue.pending).toBe(0);
    expect(summary()).toEqual(['start:a', 'end:a', 'end:b', 'end:c']);
    expect(await Promise.all([a.done, b.done, c.done])).toEqual(['stopped', 'stopped', 'stopped']);
    expect(provider.spoken.map((u) => u.id)).toEqual(['a']);
  });

  it('ignores late events from the stopped provider', () => {
    const { provider, queue, summary } = setup();
    queue.enqueue(utterance('a'));
    queue.stopAll();
    provider.boundary(0, 1);
    provider.completeCurrent();
    expect(summary()).toEqual(['start:a', 'end:a']);
  });

  it('works when nothing is playing and after dispose', async () => {
    const { queue } = setup();
    queue.stopAll();
    queue.dispose();
    expect(await queue.enqueue(utterance('x')).done).toBe('stopped');
  });

  it('lets a listener enqueue new speech while stopping', async () => {
    const { provider, queue } = setup();
    queue.enqueue(utterance('a'));
    queue.enqueue(utterance('b'));
    let replacement: Promise<SpeechEndReason> | undefined;
    queue.onEvent((event) => {
      if (event.type === 'end' && event.utteranceId === 'a') {
        replacement = queue.enqueue(utterance('r')).done;
      }
    });
    queue.stopAll();
    expect(provider.spoken.map((u) => u.id)).toEqual(['a', 'r']);
    expect(queue.pending).toBe(0);
    provider.completeCurrent();
    expect(await replacement).toBe('completed');
  });
});

describe('watchdog', () => {
  it('ends an utterance whose provider never ends it, with error', async () => {
    const { clock, provider, queue, summary, events } = setup('silent');
    const a = queue.enqueue(utterance('a', 'hello'));
    const b = queue.enqueue(utterance('b'));
    const budget = defaultWatchdogMs(utterance('a', 'hello'));
    clock.advance(budget - 1);
    expect(queue.speaking).toBe(true);
    clock.advance(1);
    expect(await a.done).toBe('error');
    expect(summary().slice(0, 2)).toEqual(['error:a', 'end:a']);
    expect(events[0]).toMatchObject({ type: 'error' });
    // The queue moves on to the next utterance.
    expect(provider.spoken.map((u) => u.id)).toEqual(['a', 'b']);
    expect(b.utterance.id).toBe('b');
  });

  it('is generous: grows with text length and slow rates, and is long for recordings', () => {
    expect(defaultWatchdogMs(utterance('a', 'hi'))).toBeGreaterThanOrEqual(10_000);
    expect(defaultWatchdogMs(utterance('a', 'x'.repeat(1000)))).toBeGreaterThan(
      defaultWatchdogMs(utterance('a', 'x'.repeat(10))),
    );
    expect(defaultWatchdogMs(utterance('a', 'hello', { rate: 0.5 }))).toBe(
      2 * defaultWatchdogMs(utterance('a', 'hello')),
    );
    expect(defaultWatchdogMs(utterance('a', 'hello', { recording: 'x.wav' }))).toBe(600_000);
  });

  it('is cancelled when the utterance ends', () => {
    const { clock, provider, queue } = setup();
    queue.enqueue(utterance('a'));
    provider.completeCurrent();
    expect(clock.pendingTimers).toBe(0);
  });

  it('gives a fresh budget once the provider starts', async () => {
    const clock = new FakeClock();
    const slow = new FakeVoiceProvider({ clock, behaviour: 'silent' });
    let providerEvents: Parameters<typeof slow.speak>[1] | undefined;
    const queue = createUtteranceQueue({
      clock,
      watchdogMs: () => 1000,
      play: (u, events) => {
        providerEvents = events;
        return slow.speak(u, events);
      },
    });
    const a = queue.enqueue(utterance('a'));
    clock.advance(900);
    providerEvents?.onStart?.({ type: 'start', utteranceId: 'a', t: 0 });
    clock.advance(900);
    expect(queue.speaking).toBe(true);
    clock.advance(101);
    expect(await a.done).toBe('error');
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('provider error isolation', () => {
  it('turns a throwing provider into an error end and carries on', async () => {
    const { provider, queue, summary, events } = setup('throw');
    const a = queue.enqueue(utterance('a'));
    expect(await a.done).toBe('error');
    expect(summary()).toEqual(['error:a', 'end:a']);
    expect(events[0]).toMatchObject({ message: expect.stringContaining('refuses') as string });

    provider.behaviour = 'manual';
    const b = queue.enqueue(utterance('b'));
    provider.completeCurrent();
    expect(await b.done).toBe('completed');
  });

  it('ends with error when the provider fails, and still starts the next one', async () => {
    const { provider, queue, summary } = setup();
    const a = queue.enqueue(utterance('a'));
    const b = queue.enqueue(utterance('b'));
    provider.failCurrent('device lost');
    expect(await a.done).toBe('error');
    expect(provider.current?.id).toBe('b');
    provider.completeCurrent();
    expect(await b.done).toBe('completed');
    expect(summary()).toEqual(['start:a', 'error:a', 'end:a', 'start:b', 'end:b']);
  });

  it('survives a throwing event listener', async () => {
    const { provider, queue, errors } = setup();
    queue.onEvent(() => {
      throw new Error('listener bug');
    });
    const a = queue.enqueue(utterance('a'));
    provider.completeCurrent();
    expect(await a.done).toBe('completed');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ends an utterance whose provider resolves done without calling onEnd', async () => {
    const clock = new FakeClock();
    const queue = createUtteranceQueue({
      clock,
      play: (u) => ({
        utteranceId: u.id,
        stop: () => undefined,
        done: Promise.resolve('completed'),
      }),
    });
    expect(await queue.enqueue(utterance('a')).done).toBe('completed');
  });

  it('works with a provider that completes synchronously inside speak', async () => {
    const clock = new FakeClock();
    const queue = createUtteranceQueue({
      clock,
      play: (u, events) => {
        events.onStart?.({ type: 'start', utteranceId: u.id, t: 0 });
        events.onEnd?.({ type: 'end', utteranceId: u.id, reason: 'completed', t: 0 });
        return { utteranceId: u.id, stop: () => undefined, done: Promise.resolve('completed') };
      },
    });
    const a = queue.enqueue(utterance('a'));
    const b = queue.enqueue(utterance('b'));
    expect(await Promise.all([a.done, b.done])).toEqual(['completed', 'completed']);
    expect(queue.speaking).toBe(false);
  });

  it('a provider event after end does not double-end', () => {
    const { provider, queue, summary } = setup();
    queue.enqueue(utterance('a'));
    provider.completeCurrent();
    provider.failCurrent('late');
    expect(summary()).toEqual(['start:a', 'end:a']);
  });
});
