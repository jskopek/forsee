import { BUILTIN_LAYOUTS } from '@forsee/layouts';
import type { LayoutDefinition } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { layoutHasSpeakKey } from './hooks';
import { physicalKeyCommand } from './input';

const key = (key: string, extra: Partial<Parameters<typeof physicalKeyCommand>[0]> = {}) =>
  physicalKeyCommand({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    ...extra,
  });

describe('physicalKeyCommand', () => {
  it('maps printable keys, Backspace and Enter to kernel commands', () => {
    expect(key('a')).toEqual({ command: 'composition.insert', args: { text: 'a' } });
    expect(key(' ')).toEqual({ command: 'composition.insert', args: { text: ' ' } });
    expect(key('ß')).toEqual({ command: 'composition.insert', args: { text: 'ß' } });
    expect(key('Backspace')).toEqual({ command: 'composition.deleteGrapheme' });
    expect(key('Enter')).toEqual({ command: 'composition.speak' });
  });

  it('leaves shortcuts, named keys and held Enter alone', () => {
    expect(key('c', { ctrlKey: true })).toBeNull();
    expect(key('r', { metaKey: true })).toBeNull();
    expect(key('x', { altKey: true })).toBeNull();
    expect(key('Shift')).toBeNull();
    expect(key('Tab')).toBeNull();
    expect(key('F5')).toBeNull();
    expect(key('Enter', { repeat: true })).toBeNull();
  });
});

describe('layoutHasSpeakKey', () => {
  it('finds the Speak key of every built-in layout', () => {
    for (const layout of BUILTIN_LAYOUTS) expect(layoutHasSpeakKey(layout), layout.id).toBe(true);
  });

  it('is false for a layout without one, so the side bar offers Speak', () => {
    const layout: LayoutDefinition = {
      schemaVersion: 1,
      id: 'test/no-speak',
      name: 'No speak',
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
                {
                  id: 'a',
                  label: 'a',
                  action: { command: 'composition.insert', args: { text: 'a' } },
                },
                {
                  id: 'grp',
                  label: 'BC',
                  group: true,
                  keys: [
                    {
                      id: 'b',
                      label: 'b',
                      action: { command: 'composition.insert', args: { text: 'b' } },
                    },
                    {
                      id: 'c',
                      label: 'c',
                      action: { command: 'composition.insert', args: { text: 'c' } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(layoutHasSpeakKey(layout)).toBe(false);
  });
});
