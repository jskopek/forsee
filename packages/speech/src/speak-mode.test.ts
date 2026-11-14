import { CompositionBuffer, type SpeechService } from '@forsee/core';
import type { SpeakOptions } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { completedSentences, completedWords, createSpeakModeController } from './speak-mode';

function setup(mode: 'on-demand' | 'each-sentence' | 'each-word', initial = '') {
  const composition = new CompositionBuffer();
  if (initial) composition.insert(initial);
  const said: { text: string; options: SpeakOptions | undefined }[] = [];
  const failures: unknown[] = [];
  const speech: SpeechService = {
    speak: (text, options) => {
      said.push({ text, options });
      return Promise.resolve('completed');
    },
    stop: () => undefined,
  };
  const controller = createSpeakModeController({
    composition,
    speech,
    mode,
    reportError: (e) => failures.push(e),
  });
  const type = (text: string): void => {
    for (const ch of text) composition.insert(ch);
  };
  return { composition, controller, said, type, failures, texts: () => said.map((s) => s.text) };
}

describe('completion rules', () => {
  it('words are complete only once something follows them', () => {
    const text = (s: string) => completedWords(s).map((u) => s.slice(u.start, u.end));
    expect(text('Hello wor')).toEqual(['Hello']);
    expect(text('Hello world ')).toEqual(['Hello', 'world']);
    expect(text('Hello,')).toEqual(['Hello']);
    expect(text("don't ")).toEqual(["don't"]);
    expect(text("don'")).toEqual([]); // may become don't
    expect(text('well-')).toEqual([]);
    expect(text('well-known ')).toEqual(['well-known']);
    expect(text('call 911 now')).toEqual(['call', '911']);
    expect(text('…')).toEqual([]);
  });

  it('sentences end at . ! ? followed by whitespace or the end of the text', () => {
    const text = (s: string) => completedSentences(s).map((u) => s.slice(u.start, u.end).trim());
    expect(text('Hello')).toEqual([]);
    expect(text('Hello.')).toEqual(['Hello.']);
    expect(text('Hi! How are you? Fine')).toEqual(['Hi!', 'How are you?']);
    expect(text('He said "stop." Then left.')).toEqual(['He said "stop."', 'Then left.']);
    expect(text('Wait... what')).toEqual(['Wait...']);
    expect(text('Pi is 3.14 ok')).toEqual([]);
    expect(text('It costs 5.')).toEqual([]); // may become 5.50
    expect(text('It costs 5. Really')).toEqual(['It costs 5.']);
    expect(text('Mr. Smith left')).toEqual([]);
    expect(text('See e.g. this one.')).toEqual(['See e.g. this one.']);
  });
});

describe('on-demand', () => {
  it('stays silent', () => {
    const { type, texts } = setup('on-demand');
    type('Hello world. How are you? ');
    expect(texts()).toEqual([]);
  });
});

describe('each-word', () => {
  it('speaks each word when it is finished, logging nothing', () => {
    const { type, texts, said } = setup('each-word');
    type('Hel');
    expect(texts()).toEqual([]);
    type('lo');
    expect(texts()).toEqual([]);
    type(' ');
    expect(texts()).toEqual(['Hello']);
    type('wor');
    type('ld,');
    expect(texts()).toEqual(['Hello', 'world']);
    expect(said[0]?.options).toEqual({ log: false });
  });

  it('does not speak again when the delimiter is deleted and retyped', () => {
    const { composition, type, texts } = setup('each-word');
    type('cat ');
    composition.deleteGrapheme();
    type(' ');
    expect(texts()).toEqual(['cat']);
  });

  it('does not speak when deleting, nor after undo', () => {
    const { composition, type, texts } = setup('each-word');
    type('one two ');
    expect(texts()).toEqual(['one', 'two']);
    composition.deleteWord();
    composition.undo();
    composition.deleteGrapheme();
    composition.deleteGrapheme();
    expect(texts()).toEqual(['one', 'two']);
    type('o ');
    expect(texts()).toEqual(['one', 'two']); // "two " was already said
  });

  it('speaks an edited word, not the unchanged ones before it', () => {
    const { composition, type, texts } = setup('each-word');
    type('one two ');
    composition.deleteWord(); // "one "
    type('three ');
    expect(texts()).toEqual(['one', 'two', 'three']);
  });

  it('speaks an accepted prediction once, and the words typed before it only once', () => {
    const { composition, type, texts } = setup('each-word');
    type('good ');
    type('mor');
    composition.acceptPrediction('morning'); // "good morning "
    expect(texts()).toEqual(['good', 'morning']);
    type('.');
    expect(composition.text).toBe('good morning. ');
    expect(texts()).toEqual(['good', 'morning']); // the moved space does not repeat "morning"
  });

  it('speaks a prediction accepted with no partial word', () => {
    const { composition, texts } = setup('each-word', 'I want ');
    composition.acceptPrediction('coffee');
    expect(texts()).toEqual(['coffee']);
  });

  it('speaks several words inserted at once as one utterance', () => {
    const { composition, texts } = setup('each-word');
    composition.insert('how are you ');
    expect(texts()).toEqual(['how are you']);
  });

  it('does not speak the existing text when started or switched on', () => {
    const { controller, composition, texts } = setup('each-word', 'already here ');
    expect(texts()).toEqual([]);
    composition.insert('x ');
    expect(texts()).toEqual(['x']);
    controller.setMode('on-demand');
    composition.insert('quiet words ');
    expect(texts()).toEqual(['x']);
    controller.setMode('each-word');
    composition.insert('loud ');
    expect(texts()).toEqual(['x', 'loud']);
  });

  it('speaks again after clear and commit (a new message)', () => {
    const { composition, type, texts } = setup('each-word');
    type('yes ');
    composition.clear();
    type('yes ');
    expect(texts()).toEqual(['yes', 'yes']);
    composition.commit();
    type('yes ');
    expect(texts()).toEqual(['yes', 'yes', 'yes']);
  });

  it('does not speak text restored from a crash snapshot, nor an undone commit', () => {
    const { composition, type, texts } = setup('each-word');
    type('see you soon ');
    expect(texts()).toHaveLength(3);
    composition.commit();
    composition.undo(); // text is back
    expect(texts()).toHaveLength(3);
    composition.restore({ version: 1, text: 'from last time ', savedAt: 0 });
    expect(texts()).toHaveLength(3);
    type('ok ');
    expect(texts().at(-1)).toBe('ok');
  });

  it('does not re-speak text changed by a text transform (replace)', () => {
    const { composition, type, texts } = setup('each-word');
    type('i ');
    composition.replace('I ');
    expect(texts()).toEqual(['i']);
    type('am ');
    expect(texts()).toEqual(['i', 'am']);
  });

  it('stops listening when disposed', () => {
    const { controller, type, texts } = setup('each-word');
    controller.dispose();
    type('hello ');
    expect(texts()).toEqual([]);
  });

  it('reports a failing speech service instead of throwing', async () => {
    const composition = new CompositionBuffer();
    const failures: unknown[] = [];
    createSpeakModeController({
      composition,
      mode: 'each-word',
      reportError: (e) => failures.push(e),
      speech: { speak: () => Promise.reject(new Error('no voice')), stop: () => undefined },
    });
    composition.insert('hello ');
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    const throwing = new CompositionBuffer();
    createSpeakModeController({
      composition: throwing,
      mode: 'each-word',
      reportError: (e) => failures.push(e),
      speech: {
        speak: () => {
          throw new Error('sync failure');
        },
        stop: () => undefined,
      },
    });
    throwing.insert('hello ');
    expect(failures).toHaveLength(2);
  });
});

describe('each-sentence', () => {
  it('speaks a sentence as soon as its terminator is typed', () => {
    const { type, texts } = setup('each-sentence');
    type('Hello there');
    expect(texts()).toEqual([]);
    type('.');
    expect(texts()).toEqual(['Hello there.']);
    type(' How are you');
    expect(texts()).toEqual(['Hello there.']);
    type('?');
    expect(texts()).toEqual(['Hello there.', 'How are you?']);
  });

  it('does not speak abbreviations, decimals or unfinished sentences', () => {
    const { type, texts } = setup('each-sentence');
    type('Dr. Smith costs 3.50 euros');
    expect(texts()).toEqual([]);
    type('!');
    expect(texts()).toEqual(['Dr. Smith costs 3.50 euros!']);
  });

  it('does not double-speak after delete and retype of the terminator, or after undo', () => {
    const { composition, type, texts } = setup('each-sentence');
    type('Yes.');
    composition.deleteGrapheme();
    type('.');
    composition.undo();
    composition.undo();
    expect(texts()).toEqual(['Yes.']);
  });

  it('speaks the changed sentence after the text before it was edited', () => {
    const { composition, type, texts } = setup('each-sentence');
    type('Hi. Bye.');
    expect(texts()).toEqual(['Hi.', 'Bye.']);
    composition.deleteWord(); // "Hi. "
    type('See you.');
    expect(texts()).toEqual(['Hi.', 'Bye.', 'See you.']);
  });

  it('speaks a sentence completed by accepting a prediction followed by a terminator', () => {
    const { composition, type, texts } = setup('each-sentence');
    type('I like ');
    type('te');
    composition.acceptPrediction('tea');
    expect(texts()).toEqual([]);
    type('.');
    expect(composition.text).toBe('I like tea. ');
    expect(texts()).toEqual(['I like tea.']);
  });

  it('switching mode starts from the current text', () => {
    const { controller, type, texts } = setup('each-word');
    type('one two ');
    controller.setMode('each-sentence');
    expect(controller.mode).toBe('each-sentence');
    type('three.');
    expect(texts()).toEqual(['one', 'two', 'one two three.']);
  });
});
