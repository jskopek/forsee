/**
 * Speech through the real plugin API: voice providers registered with
 * `ForseeApi.register.voiceProvider` reach the real speech engine, and
 * `ForseeApi.speech.speak` options reach the provider.
 */
import { FakeClock } from '@forsee/core';
import { formatVoiceId, type ForseeApi, type SpeechEvent } from '@forsee/plugin-api';
import { FakeVoiceProvider, fakeVoice } from '@forsee/speech/testing';
import { describe, expect, it } from 'vitest';
import { createHarness, firstParty, settle } from './harness';

const VOICE_SCOPES = ['speech.output', 'composition.read'] as const;

describe('speech through the plugin API', () => {
  it('lists, selects and speaks with voices of two plugin providers, options and interrupt included', async () => {
    let apiA: ForseeApi | undefined;
    let providerA: FakeVoiceProvider | undefined;
    let providerB: FakeVoiceProvider | undefined;
    // The fake providers stand for plugin code, which has its own clock.
    const pluginClock = new FakeClock();
    const harness = await createHarness({
      firstParty: [
        firstParty('forsee.voices-a', VOICE_SCOPES, {
          async activate(api) {
            apiA = api;
            providerA = new FakeVoiceProvider({
              id: 'neural',
              clock: pluginClock,
              voices: [fakeVoice('neural', 'ava', 'en-GB')],
            });
            await api.register.voiceProvider(providerA);
          },
        }),
        firstParty('forsee.voices-b', VOICE_SCOPES, {
          async activate(api) {
            providerB = new FakeVoiceProvider({
              id: 'neural',
              clock: pluginClock,
              // A voice id with a slash, as browser voice URIs have.
              voices: [fakeVoice('neural', 'en/bob', 'en-US')],
            });
            await api.register.voiceProvider(providerB);
          },
        }),
      ],
    });
    if (!apiA || !providerA || !providerB) throw new Error('plugins did not activate');
    const { speech, kernel } = harness;

    // Both providers became available under their plugin-prefixed ids.
    const ava = formatVoiceId('forsee.voices-a/neural', 'ava');
    const bob = formatVoiceId('forsee.voices-b/neural', 'en/bob');
    const listed = await apiA.speech.listVoices();
    expect(listed.map((v) => formatVoiceId(v.providerId, v.id))).toEqual(
      expect.arrayContaining([ava, bob]),
    );
    expect((await speech.listVoices()).map((v) => formatVoiceId(v.providerId, v.id))).toEqual(
      expect.arrayContaining([ava, bob]),
    );

    // The user selects B's voice; the next utterance goes to B and keeps talking.
    speech.setVoice(bob);
    const events: SpeechEvent[] = [];
    speech.events.on('speech', (event) => events.push(event));
    await kernel.commands.execute('speech.speak', { text: 'first', log: false });
    await settle();
    expect(providerB.spoken.map((u) => [u.text, u.voiceId])).toEqual([['first', bob]]);
    const first = providerB.spoken[0];
    expect(providerB.current?.text).toBe('first');

    // A plugin interrupts with its own voice, rate and interrupt.
    await apiA.speech.speak('help', { voiceId: ava, rate: 1.5, interrupt: true, log: false });
    await settle();
    expect(providerA.spoken).toHaveLength(1);
    expect(providerA.spoken[0]).toMatchObject({ text: 'help', voiceId: ava, rate: 1.5 });
    // The interrupt stopped the previous utterance.
    expect(providerB.current).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'end', utteranceId: first?.id, reason: 'stopped' }),
    );
    expect(harness.errors).toEqual([]);
  });
});
