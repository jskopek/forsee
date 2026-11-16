import { describe, expect, it } from 'vitest';
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
