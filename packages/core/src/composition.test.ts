import type { CompositionChange, KeyDistribution } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { CompositionBuffer, partialWordOf } from './composition';
import { FakeClock } from './testing';

function buffer(text = '', options: ConstructorParameters<typeof CompositionBuffer>[0] = {}) {
  const b = new CompositionBuffer(options);
  if (text !== '') b.insert(text);
  return b;
}

const dist = (text: string): KeyDistribution => ({
  entries: [
    { targetId: `key-${text}`, text, probability: 0.8 },
    { targetId: 'key-x', text: 'x', probability: 0.2 },
  ],
});

describe('partialWordOf', () => {
  it.each([
    ['', ''],
    ['hel', 'hel'],
    ['hello ', ''],
    ['hello wor', 'wor'],
    ['Hello, wor', 'wor'],
    ["don't", "don't"],
    ['well-kn', 'well-kn'],
    ["'quo", 'quo'],
    ['café', 'café'],
    ['café', 'café'],
    ['hi!', ''],
    ['abc123', 'abc123'],
  ])('%j -> %j', (text, expected) => {
    expect(partialWordOf(text)).toBe(expected);
  });
});

describe('CompositionBuffer basics', () => {
  it('inserts and reports derived state', () => {
    const b = buffer('Hello wor');
    expect(b.state).toMatchObject({
      text: 'Hello wor',
      caret: 9,
      textBeforeCaret: 'Hello wor',
      partialWord: 'wor',
      canUndo: true,
    });
  });

  it('ignores empty inserts without events', () => {
    const b = buffer();
    const events: CompositionChange[] = [];
    b.events.on('changed', (e) => events.push(e));
    b.insert('');
    expect(events).toHaveLength(0);
    expect(b.state.canUndo).toBe(false);
  });

  it('emits one change event per change with reason and previous text', () => {
    const b = buffer();
    const events: CompositionChange[] = [];
    b.events.on('changed', (e) => events.push(e));
    b.insert('a');
    b.insert('b');
    b.deleteGrapheme();
    expect(events.map((e) => [e.reason, e.previousText, e.state.text])).toEqual([
      ['insert', '', 'a'],
      ['insert', 'a', 'ab'],
      ['delete-grapheme', 'ab', 'a'],
    ]);
  });

  it('clear empties the text and is undoable', () => {
    const b = buffer('some text');
    expect(b.clear()).toBe(true);
    expect(b.text).toBe('');
    expect(b.clear()).toBe(false);
    expect(b.undo()).toBe(true);
    expect(b.text).toBe('some text');
  });

  it('commit returns trimmed text, clears, and can be undone', () => {
    const b = buffer('  hi there ');
    expect(b.commit()).toBe('hi there');
    expect(b.text).toBe('');
    expect(b.commit()).toBe('');
    b.undo();
    expect(b.text).toBe('  hi there ');
  });

  it('replace swaps the whole text as one undo step', () => {
    const b = buffer('brb');
    b.replace('be right back');
    expect(b.text).toBe('be right back');
    b.undo();
    expect(b.text).toBe('brb');
  });
});

describe('deleteGrapheme', () => {
  it.each([
    ['abc', 'ab'],
    ['a', ''],
    ['👍', ''],
    ['ok👍🏽', 'ok'],
    ['x👨‍👩‍👧', 'x'],
    ['🇬🇧🇺🇸', '🇬🇧'],
    ['café', 'caf'],
    ['ñ́a', 'ñ́'],
    ['1️⃣', ''],
    ['a❤️', 'a'],
    ['line\r\n', 'line'],
  ])('%j -> %j', (text, expected) => {
    const b = buffer(text);
    b.deleteGrapheme();
    expect(b.text).toBe(expected);
  });

  it('returns false on empty text', () => {
    expect(buffer().deleteGrapheme()).toBe(false);
  });
});

describe('deleteWord', () => {
  it.each([
    ['hello', ''],
    ['hello world', 'hello '],
    ['hello world  ', 'hello '],
    ['Hello, world!  ', 'Hello, '],
    ['Hello,', ''],
    ['one two,three', 'one '],
    ['   ', ''],
    ['a\tb', 'a\t'],
    ['first\n second', 'first\n '],
  ])('%j -> %j', (text, expected) => {
    const b = buffer(text);
    expect(b.deleteWord()).toBe(true);
    expect(b.text).toBe(expected);
  });

  it('returns false on empty text', () => {
    expect(buffer().deleteWord()).toBe(false);
  });
});

describe('acceptPrediction', () => {
  it.each([
    ['hel', 'hello', 'hello '],
    ['I am hap', 'happy', 'I am happy '],
    ['Hel', 'hello', 'Hello '],
    ['', 'Hi', 'Hi '],
    ['I am ', 'here', 'I am here '],
    ['Hello,', 'how', 'Hello, how '],
    ['said (', 'yes', 'said (yes '],
    ['hel', 'hello ', 'hello '],
  ])('%j + %j -> %j', (text, word, expected) => {
    const b = buffer(text);
    b.acceptPrediction(word);
    expect(b.text).toBe(expected);
  });

  it('does not change case when matchCase is off', () => {
    const b = buffer('Hel', { matchCase: false });
    b.acceptPrediction('hello');
    expect(b.text).toBe('hello ');
  });

  it('moves the automatic space after attaching punctuation', () => {
    const b = buffer('how ar');
    b.acceptPrediction('are');
    b.insert('?');
    expect(b.text).toBe('how are? ');
    b.insert(' ');
    expect(b.text).toBe('how are? ');
  });

  it('absorbs a manual space right after an automatic one', () => {
    const b = buffer('hel');
    b.acceptPrediction('hello');
    b.insert(' ');
    expect(b.text).toBe('hello ');
    b.insert(' ');
    expect(b.text).toBe('hello  ');
  });

  it('keeps normal insertion after a word typed following the automatic space', () => {
    const b = buffer('hel');
    b.acceptPrediction('hello');
    b.insert('t');
    b.insert('.');
    expect(b.text).toBe('hello t.');
  });

  it('is one undo step and ignores empty words', () => {
    const b = buffer('hel');
    b.acceptPrediction('');
    expect(b.text).toBe('hel');
    b.acceptPrediction('hello');
    b.undo();
    expect(b.text).toBe('hel');
  });
});

describe('partial word steps', () => {
  it('tracks per-insert distributions for the current word', () => {
    const b = buffer();
    b.insert('h', dist('h'));
    b.insert('i', dist('i'));
    expect(b.state.partialWordSteps).toEqual([
      { text: 'h', distribution: dist('h') },
      { text: 'i', distribution: dist('i') },
    ]);
  });

  it('resets at a word boundary and keeps the new word only', () => {
    const b = buffer();
    b.insert('a', dist('a'));
    b.insert(' ');
    expect(b.state.partialWordSteps).toEqual([]);
    b.insert('b', dist('b'));
    expect(b.state.partialWordSteps).toEqual([{ text: 'b', distribution: dist('b') }]);
  });

  it('trims steps on deletion and falls back to certain text when unknown', () => {
    const b = buffer();
    b.insert('a', dist('a'));
    b.insert('b', dist('b'));
    b.deleteGrapheme();
    expect(b.state.partialWordSteps).toEqual([{ text: 'a', distribution: dist('a') }]);
    b.insert(' ');
    b.deleteGrapheme();
    expect(b.state.partialWord).toBe('a');
    expect(b.state.partialWordSteps.map((s) => s.text).join('')).toBe('a');
  });

  it('always concatenates to the partial word', () => {
    const b = buffer();
    for (const t of ['he', 'l', 'lo wo', 'r', 'ld']) b.insert(t, dist(t));
    b.deleteGrapheme();
    const s = b.state;
    expect(s.partialWordSteps.map((x) => x.text).join('')).toBe(s.partialWord);
    expect(s.partialWord).toBe('worl');
  });

  it('restores steps on undo', () => {
    const b = buffer();
    b.insert('a', dist('a'));
    b.deleteGrapheme();
    b.undo();
    expect(b.state.partialWordSteps).toEqual([{ text: 'a', distribution: dist('a') }]);
  });
});

describe('undo', () => {
  it('returns false with nothing to undo', () => {
    expect(buffer().undo()).toBe(false);
  });

  it('is bounded by historyLimit, dropping the oldest steps', () => {
    const b = buffer('', { historyLimit: 3 });
    for (const c of 'abcde') b.insert(c);
    expect(b.undoDepth).toBe(3);
    expect(b.undo()).toBe(true);
    expect(b.undo()).toBe(true);
    expect(b.undo()).toBe(true);
    expect(b.undo()).toBe(false);
    expect(b.text).toBe('ab');
  });

  it('historyLimit 0 disables undo', () => {
    const b = buffer('abc', { historyLimit: 0 });
    expect(b.state.canUndo).toBe(false);
    expect(b.undo()).toBe(false);
  });

  it('rejects an invalid historyLimit', () => {
    expect(() => new CompositionBuffer({ historyLimit: -1 })).toThrow(RangeError);
  });

  it('emits an undo change event', () => {
    const b = buffer('a');
    const reasons: string[] = [];
    b.events.on('changed', (e) => reasons.push(e.reason));
    b.undo();
    expect(reasons).toEqual(['undo']);
  });
});

describe('snapshot and restore', () => {
  it('round-trips the text with a version and wall time', () => {
    const clock = new FakeClock({ wall: 1_000_000 });
    const b = buffer('half a sentence', { clock });
    const snap = b.snapshot();
    expect(snap).toEqual({ version: 1, text: 'half a sentence', savedAt: 1_000_000 });
    const c = new CompositionBuffer();
    expect(c.restore(JSON.parse(JSON.stringify(snap)))).toBe(true);
    expect(c.text).toBe('half a sentence');
    expect(c.state.canUndo).toBe(false);
    expect(c.state.partialWord).toBe('sentence');
  });

  it.each([null, undefined, 'text', { version: 2, text: 'x' }, { version: 1 }, { text: 'x' }])(
    'rejects %j',
    (bad) => {
      const b = buffer('keep');
      expect(b.restore(bad)).toBe(false);
      expect(b.text).toBe('keep');
    },
  );
});

describe('nextUndoReason', () => {
  it('names the change the next undo reverts', () => {
    const b = buffer();
    expect(b.nextUndoReason).toBeUndefined();
    b.insert('hello');
    expect(b.nextUndoReason).toBe('insert');
    b.commit();
    expect(b.nextUndoReason).toBe('commit');
    b.insert('x');
    b.deleteGrapheme();
    expect(b.nextUndoReason).toBe('delete-grapheme');
    b.undo();
    b.undo();
    expect(b.nextUndoReason).toBe('commit');
    b.undo();
    expect(b.text).toBe('hello');
    expect(b.nextUndoReason).toBe('insert');
  });
});
