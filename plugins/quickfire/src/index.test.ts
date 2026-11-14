import type { SpeechService } from '@forsee/core';
import type { PluginManifest, SpeakOptions } from '@forsee/plugin-api';
import { validateManifest } from '@forsee/plugin-host';
import { createTestPluginApi } from '@forsee/plugin-host/testing';
import { describe, expect, it } from 'vitest';
import manifestJson from '../manifest.json';
import {
  manifest,
  QUICKFIRE_PHRASE_SET_ID,
  QUICKFIRE_PHRASES,
  QUICKFIRE_PLUGIN_ID,
  QUICKFIRE_SPEAK_COMMAND,
  quickfireModule,
} from './index';

function recordingSpeech(): SpeechService & { calls: [string, SpeakOptions | undefined][] } {
  const calls: [string, SpeakOptions | undefined][] = [];
  return {
    calls,
    speak(text, options) {
      calls.push([text, options]);
      return Promise.resolve('completed');
    },
    stop: () => undefined,
  };
}

async function activate(m: PluginManifest = manifest) {
  const speech = recordingSpeech();
  const test = await createTestPluginApi({
    manifest: m,
    origin: 'first-party',
    kernelOptions: { speech },
  });
  await quickfireModule.activate(test.api);
  return { ...test, speech };
}

describe('forsee.quickfire', () => {
  it('has a manifest the real validator accepts as first-party', () => {
    const result = validateManifest(manifestJson, { firstParty: true });
    expect(result.ok).toBe(true);
    expect(manifest.permissions).toEqual(['speech.output']);
  });

  it('contributes the interjections as a phrase set', async () => {
    const { kernel } = await activate();
    const sets = kernel.extensions.list('phraseSets');
    expect(sets.map((s) => [s.id, s.owner])).toEqual([
      [QUICKFIRE_PHRASE_SET_ID, QUICKFIRE_PLUGIN_ID],
    ]);
    const texts = sets[0]!.contribution.categories.flatMap((c) => c.phrases.map((p) => p.text));
    expect(texts).toEqual([
      'Yes',
      'No',
      'Thank you',
      'Please wait',
      "I'm not finished",
      'Can you repeat that?',
      'Help',
    ]);
    expect(kernel.extensions.list('commands').map((c) => c.id)).toEqual([QUICKFIRE_SPEAK_COMMAND]);
  });

  it('speaks a phrase with interrupt, logs it and leaves the composition alone', async () => {
    const { kernel, speech } = await activate();
    await kernel.commands.execute('composition.insert', { text: 'half a sent' });
    const result = await kernel.commands.execute(
      QUICKFIRE_SPEAK_COMMAND,
      { phraseId: 'please-wait' },
      'app',
    );
    expect(result).toEqual({ phraseId: 'please-wait', text: 'Please wait' });
    expect(speech.calls).toEqual([['Please wait', { interrupt: true }]]);
    expect(kernel.composition.text).toBe('half a sent');
    expect(kernel.conversation.listRecent(1).map((u) => u.body)).toEqual(['Please wait']);
    expect(QUICKFIRE_PHRASES).toHaveLength(7);
  });

  it('rejects unknown phrases', async () => {
    const { kernel } = await activate();
    await expect(
      kernel.commands.execute(QUICKFIRE_SPEAK_COMMAND, { phraseId: 'nope' }, 'app'),
    ).rejects.toMatchObject({ code: 'handler-error' });
  });

  it('cannot speak without speech.output', async () => {
    const { kernel, speech } = await activate({ ...manifest, permissions: [] });
    await expect(
      kernel.commands.execute(QUICKFIRE_SPEAK_COMMAND, { phraseId: 'yes' }, 'app'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(speech.calls).toEqual([]);
  });
});
