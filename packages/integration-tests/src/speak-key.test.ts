/**
 * Speak, as the control bar runs it (`composition.speak`), against a real
 * kernel and speech engine. Keyboards have no Speak key of their own.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, settle } from './harness';

describe('Speak', () => {
  it('speaks the composition, logs it and clears it', async () => {
    const harness = await createHarness();
    const { kernel, appVoice } = harness;

    await kernel.commands.execute('composition.insert', { text: 'I would like tea' }, 'keyboard');
    await kernel.commands.execute('composition.speak', undefined, 'app');
    await settle();

    expect(appVoice.spoken.map((u) => u.text)).toEqual(['I would like tea']);
    expect(kernel.conversation.listRecent(1).map((u) => [u.sender, u.body])).toEqual([
      ['user', 'I would like tea'],
    ]);
    expect(kernel.composition.text).toBe('');
    expect(harness.errors).toEqual([]);
  });
});
