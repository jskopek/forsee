/**
 * The conversation path on the real engines: pointer dwell on the built-in
 * QWERTY layout, prediction from the plugin-registered n-gram provider, the
 * Speak key, the fake speech synthesis.
 */
import { NGRAM_PLUGIN_ID } from '@forsee/plugin-prediction-ngram';
import { describe, expect, it } from 'vitest';
import { createTestBrowser, dwellOn, lookAway, mountTestKeyboard, settle } from './testing';

describe('the conversation path', () => {
  it('dwells letters, predicts, accepts, speaks with the chosen voice and logs', async () => {
    const browser = createTestBrowser();
    const runtime = await browser.boot();
    const { kernel } = runtime;
    expect(runtime.startupIssues).toEqual([]);
    expect(runtime.layout.definition.id).toBe('forsee/en-qwerty');
    expect(runtime.profile).toMatchObject({ storage: 'opfs', persistent: true, created: true });

    runtime.speech.updateSettings({ voiceId: 'forsee.web-speech/Serena' });
    const keyboard = mountTestKeyboard(runtime);

    dwellOn(browser, keyboard, 'k-h');
    expect(kernel.composition.text).toBe('h');
    dwellOn(browser, keyboard, 'k-e');
    lookAway(browser);
    expect(kernel.composition.text).toBe('he');
    // Each dwell carried its key distribution to the composition.
    expect(kernel.composition.state.partialWordSteps).toHaveLength(2);
    expect(keyboard.executed.map((e) => e.command)).toEqual([
      'composition.insert',
      'composition.insert',
    ]);

    // Prediction comes from the plugin's provider, through the plugin host.
    const providers = kernel.extensions.list('predictionProviders');
    expect(providers.map((p) => [p.id, p.owner])).toEqual([
      [`${NGRAM_PLUGIN_ID}/ngram`, NGRAM_PLUGIN_ID],
    ]);
    const state = kernel.composition.state;
    const session = runtime.prediction.predict({
      textBefore: state.textBeforeCaret,
      partialWord: state.partialWord,
      partialWordSteps: state.partialWordSteps,
      locale: kernel.locale,
      maxCandidates: 5,
      kinds: ['completions', 'letters'],
    });
    const completions = session.instant.completions.map((c) => c.text);
    expect(completions.length).toBeGreaterThan(0);
    const word = completions.find((c) => c.toLowerCase().startsWith('he')) ?? completions[0]!;
    await kernel.commands.execute('composition.acceptPrediction', { text: word }, 'app');
    expect(kernel.composition.text).toBe(`${word} `);

    dwellOn(browser, keyboard, 'k-speak', 1600);
    lookAway(browser);
    await settle();

    const spoken = browser.synthesis.spoken;
    expect(spoken.map((u) => u.text)).toEqual([word]);
    expect(spoken[0]?.voice?.name).toBe('Serena');
    browser.synthesis.start();
    browser.synthesis.end();
    await settle();

    expect(kernel.composition.text).toBe('');
    expect(kernel.conversation.listRecent(10).map((u) => [u.sender, u.body])).toEqual([
      ['user', word],
    ]);
    expect(browser.errors).toEqual([]);

    keyboard.dispose();
    await runtime.dispose();
  });
});
