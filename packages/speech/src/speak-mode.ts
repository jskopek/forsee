import { defaultErrorReporter, type Disposable, type ErrorReporter } from '@forsee/core';
import type { CompositionChange, SpeakMode } from '@forsee/plugin-api';
import type { SpeakModeController, SpeakModeControllerOptions } from './contracts';

/**
 * Completion rules (the text is always written left to right, with the caret
 * at the end).
 *
 * Word (`each-word`): a word is a run of letters, marks and digits, joined
 * by in-word apostrophes or hyphens (`don't`, `well-known`). It is complete
 * when any other character follows it (space, punctuation, newline), except
 * that a trailing apostrophe or hyphen at the very end of the text keeps the
 * word open (the user may be typing `don't`).
 *
 * Sentence (`each-sentence`): a run of `.`, `!`, `?` or `…`, plus any closing
 * quotes or brackets after it, ends a sentence when it is the end of the text
 * or is followed by whitespace. Not a sentence end: `3.5` (no whitespace
 * after), `5.` at the very end of the text (it may become `5.5`), and a
 * single `.` after a common abbreviation (`Mr.`, `Dr.`, `e.g.`).
 */

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
const TERMINATORS = /[.!?…]+["'”’)\]]*/gu;
const OPEN_WORD_DELIMITER = /['’-]/u;
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'e.g',
  'i.e',
]);

/** A unit (word or sentence) of the text, with its end including any delimiter. */
interface Unit {
  /** Start of the unit's own text. */
  readonly start: number;
  /** End of the unit's own text. */
  readonly end: number;
  /** Position up to which the text counts as spoken once this unit is: after the delimiter for words. */
  readonly settledEnd: number;
  /** Where speaking this unit begins (a sentence starts after the previous one). */
  readonly speakFrom: number;
}

/** Completed words of `text`. */
export function completedWords(text: string): Unit[] {
  const out: Unit[] = [];
  for (const match of text.matchAll(WORD)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end >= text.length) continue; // still being typed
    if (end === text.length - 1 && OPEN_WORD_DELIMITER.test(text.charAt(end))) continue;
    out.push({ start, end, settledEnd: end + 1, speakFrom: start });
  }
  return out;
}

/** Completed sentences of `text`. */
export function completedSentences(text: string): Unit[] {
  const out: Unit[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(TERMINATORS)) {
    const start = match.index;
    const end = start + match[0].length;
    const atEnd = end >= text.length;
    if (!atEnd && !/\s/u.test(text.charAt(end))) continue;
    const run = match[0];
    if (run.startsWith('.') && /^\.["'”’)\]]*$/u.test(run)) {
      if (atEnd && /\p{N}/u.test(text.charAt(start - 1))) continue;
      const word = /([\p{L}.]+)$/u.exec(text.slice(0, start))?.[1]?.toLowerCase();
      if (word !== undefined && ABBREVIATIONS.has(word)) continue;
    }
    out.push({ start: previousEnd, end, settledEnd: end, speakFrom: previousEnd });
    previousEnd = end;
  }
  return out;
}

function unitsOf(text: string, mode: SpeakMode): Unit[] {
  if (mode === 'each-word') return completedWords(text);
  if (mode === 'each-sentence') return completedSentences(text);
  return [];
}

/** The text up to the end of its last completed unit: everything in it counts as already handled. */
export function completedPrefix(text: string, mode: SpeakMode): string {
  const last = unitsOf(text, mode).at(-1);
  return last ? text.slice(0, last.settledEnd) : '';
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * What to speak now that the text is `text`, given `spoken` (the longest
 * text already handled, which is never shortened by deleting). Returns the
 * text to say and the new `spoken`, or `undefined` when nothing new is
 * complete.
 */
export function newSpeech(
  text: string,
  spoken: string,
  mode: SpeakMode,
): { readonly say: string; readonly spoken: string } | undefined {
  const known = commonPrefixLength(text, spoken);
  const fresh = unitsOf(text, mode).filter((unit) => unit.end > known);
  const first = fresh[0];
  const last = fresh.at(-1);
  if (!first || !last) return undefined;
  const say = text.slice(first.speakFrom, last.end).trim();
  return { say, spoken: text.slice(0, last.settledEnd) };
}

/**
 * Creates the speak-mode controller. It listens to composition changes and
 * hands newly completed words or sentences to the speech service (with
 * `log: false`: automatic speech is not history). Only typing (`insert`) and
 * accepting a prediction speak. Deleting, undoing, replacing, restoring,
 * clearing and committing never do, and the controller remembers what it has
 * said, so retyping a deleted word or undoing a delete is not spoken twice.
 * Starting in or switching to a mode never speaks the text already present.
 */
export function createSpeakModeController(
  options: SpeakModeControllerOptions,
): SpeakModeController {
  return new Controller(options);
}

class Controller implements SpeakModeController {
  private currentMode: SpeakMode;
  private spoken: string;
  private readonly subscription: Disposable;
  private disposed = false;
  private readonly reportError: ErrorReporter;

  constructor(private readonly options: SpeakModeControllerOptions) {
    this.currentMode = options.mode;
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.spoken = completedPrefix(options.composition.state.text, this.currentMode);
    this.subscription = options.composition.events.on('changed', (change) => this.onChange(change));
  }

  get mode(): SpeakMode {
    return this.currentMode;
  }

  setMode(mode: SpeakMode): void {
    if (this.disposed) return;
    this.currentMode = mode;
    this.spoken = completedPrefix(this.options.composition.state.text, mode);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
  }

  private onChange(change: CompositionChange): void {
    if (this.disposed || this.currentMode === 'on-demand') return;
    const text = change.state.text;
    switch (change.reason) {
      case 'insert':
      case 'accept-prediction': {
        const next = newSpeech(text, this.spoken, this.currentMode);
        if (!next) return;
        this.spoken = next.spoken;
        if (next.say !== '') this.say(next.say);
        return;
      }
      case 'clear':
      case 'commit':
        this.spoken = '';
        return;
      case 'restore':
        this.spoken = completedPrefix(text, this.currentMode);
        return;
      default:
        // delete-grapheme, delete-word, undo, replace: never speak. Keep the
        // high-water mark while the text is still inside it; otherwise treat
        // what is complete now as handled.
        if (!this.spoken.startsWith(text)) this.spoken = completedPrefix(text, this.currentMode);
    }
  }

  private say(text: string): void {
    try {
      this.options.speech.speak(text, { log: false }).catch((error: unknown) => {
        this.reportError(error, 'speech.speakMode');
      });
    } catch (error) {
      this.reportError(error, 'speech.speakMode');
    }
  }
}
