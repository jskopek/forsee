import { BUILTIN_LAYOUTS, validateLayout } from '@forsee/layouts';
import { describe, expect, it } from 'vitest';
import { layoutHasSpeakKey } from '../hooks';
import { chromeCommands, withoutKeysFor } from './chrome-keys';

const commandsIn = (layout: (typeof BUILTIN_LAYOUTS)[number]): string[] =>
  layout.pages.flatMap((p) =>
    p.rows.flatMap((r) =>
      r.keys.flatMap((k) => [
        ...('action' in k && k.action ? [k.action.command] : []),
        ...('group' in k && k.group ? k.keys.map((g) => g.action.command) : []),
      ]),
    ),
  );

describe('withoutKeysFor', () => {
  it('leaves the keyboard untouched on the current screen', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      expect(withoutKeysFor(layout, chromeCommands('current'))).toBe(layout);
    }
  });

  it('removes Speak keys for the side-rail screen and Speak and Clear for the top bar', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      const rail = withoutKeysFor(layout, chromeCommands('rail'));
      expect(layoutHasSpeakKey(rail), layout.id).toBe(false);
      expect(commandsIn(rail).includes('composition.clear')).toBe(
        commandsIn(layout).includes('composition.clear'),
      );
      const top = withoutKeysFor(layout, chromeCommands('top'));
      expect(commandsIn(top)).not.toContain('composition.clear');
      expect(commandsIn(top)).not.toContain('composition.speak');
      expect(validateLayout(top).ok, layout.id).toBe(true);
    }
  });
});
