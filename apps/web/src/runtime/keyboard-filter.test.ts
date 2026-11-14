import { BUILTIN_LAYOUTS, validateLayout } from '@forsee/layouts';
import type { LayoutDefinition } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { withoutKeysFor } from './keyboard-filter';

const commandsIn = (layout: LayoutDefinition): string[] =>
  layout.pages.flatMap((p) =>
    p.rows.flatMap((r) =>
      r.keys.flatMap((k) => [
        ...('action' in k && k.action ? [k.action.command] : []),
        ...('group' in k && k.group ? k.keys.map((g) => g.action.command) : []),
      ]),
    ),
  );

describe('keyboards and the control bar', () => {
  it('built-in keyboards have no Speak or Clear key (Speak is in the control bar)', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      expect(commandsIn(layout), layout.id).not.toContain('composition.speak');
      expect(commandsIn(layout), layout.id).not.toContain('composition.clear');
      expect(withoutKeysFor(layout)).toBe(layout);
    }
  });

  it("removes another keyboard's Speak and Clear keys, in groups too, and empty rows", () => {
    const key = (id: string, command: string) => ({ id, label: id, action: { command } });
    const layout: LayoutDefinition = {
      schemaVersion: 1,
      id: 'test/extra',
      name: 'Extra',
      family: 'precise',
      locale: 'en',
      initialPage: 'main',
      pages: [
        {
          id: 'main',
          name: 'Main',
          rows: [
            {
              keys: [
                key('a', 'composition.insert'),
                {
                  id: 'grp',
                  label: 'grp',
                  group: true,
                  keys: [
                    key('b', 'composition.insert'),
                    key('c', 'composition.insert'),
                    key('s', 'composition.speak'),
                  ],
                },
              ],
            },
            { keys: [key('speak', 'composition.speak'), key('clear', 'composition.clear')] },
          ],
        },
      ],
    };
    const filtered = withoutKeysFor(layout);
    expect(commandsIn(filtered)).toEqual([
      'composition.insert',
      'composition.insert',
      'composition.insert',
    ]);
    expect(filtered.pages[0]?.rows).toHaveLength(1);
    expect(validateLayout(filtered).ok).toBe(true);
  });
});
