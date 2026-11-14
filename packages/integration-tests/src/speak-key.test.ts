/**
 * The Speak key of the built-in QWERTY layout, resolved by the real layout
 * runtime and executed against a real kernel and speech engine.
 */
import { createLayoutRuntime, getBuiltinLayout, isActionKey } from '@forsee/layouts';
import { describe, expect, it } from 'vitest';
import { createHarness, settle } from './harness';

describe('the Speak key', () => {
  it('speaks the composition, logs it and clears it', async () => {
    const harness = await createHarness();
    const { kernel, appVoice } = harness;
    const layout = getBuiltinLayout('forsee/en-qwerty');
    if (!layout) throw new Error('no QWERTY layout');
    const runtime = createLayoutRuntime(layout);
    const keys = runtime.view.rows.flatMap((row) => row.keys);
    const speakKey = keys.find((key) => isActionKey(key) && key.label === 'Speak');
    if (!speakKey) throw new Error('no Speak key on the first page');

    await kernel.commands.execute('composition.insert', { text: 'I would like tea' }, 'keyboard');
    const action = runtime.activate(speakKey.id, 0);
    if (!action) throw new Error('the Speak key has no action');
    expect(action.command).toBe('composition.speak');
    await kernel.commands.execute(action.command, action.args, 'keyboard');
    await settle();

    expect(appVoice.spoken.map((u) => u.text)).toEqual(['I would like tea']);
    expect(kernel.conversation.listRecent(1).map((u) => [u.sender, u.body])).toEqual([
      ['user', 'I would like tea'],
    ]);
    expect(kernel.composition.text).toBe('');
    expect(harness.errors).toEqual([]);
  });
});
