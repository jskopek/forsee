import type {
  CompositionChange,
  CompositionChangeReason,
  CompositionState,
  Disposable,
  InputStep,
  KeyDistribution,
} from '@forsee/plugin-api';
import { EventBus, type EventBusOptions } from './event-bus';
import { lastGraphemeLength } from './graphemes';
import type { Clock } from './platform';

/**
 * Crash-recovery snapshot of the composition (`state/composition.json`).
 * Versioned so a later editable caret can extend it. v1 always has the caret
 * at the end, so only the text is stored.
 */
export interface CompositionSnapshot {
  readonly version: 1;
  readonly text: string;
  /** Wall-clock ms since epoch when the snapshot was taken (0 without a clock). */
  readonly savedAt: number;
}

/** Events emitted by the composition buffer. */
export interface CompositionEventMap {
  changed: CompositionChange;
}

/** Options for `CompositionBuffer`. */
export interface CompositionBufferOptions extends EventBusOptions {
  /** Maximum undo steps kept; older ones are dropped. Default 100. Must be >= 0. */
  readonly historyLimit?: number;
  /** Used for `CompositionSnapshot.savedAt`. */
  readonly clock?: Clock;
  /**
   * When accepting a prediction for a partial word that starts with a capital
   * letter, capitalise the candidate's first letter too. Default true.
   */
  readonly matchCase?: boolean;
}

interface Record_ {
  readonly text: string;
  readonly steps: readonly InputStep[];
  readonly autoSpace: boolean;
}

/** Trailing run of word characters; leading apostrophes or hyphens are trimmed off afterwards. */
const PARTIAL_WORD = /[\p{L}\p{M}\p{N}'’-]+$/u;
const LEADING_JOINERS = /^['’-]+/u;
/** Punctuation that attaches to the previous word, swallowing an automatic space. */
const ATTACHING_PUNCTUATION = /^[.,!?;:]/u;
/** Characters after which an accepted next word needs no separating space. */
const OPENERS = /[\s([{“‘¿¡]$/u;

/** The current partial word of `text` (see `CompositionState.partialWord`). */
export function partialWordOf(text: string): string {
  const match = PARTIAL_WORD.exec(text);
  if (!match) return '';
  return match[0].replace(LEADING_JOINERS, '');
}

function joinSteps(steps: readonly InputStep[]): string {
  return steps.map((s) => s.text).join('');
}

/** Keeps the steps consistent with a new partial word (see `InputStep`). */
function reconcileSteps(steps: readonly InputStep[], partial: string): readonly InputStep[] {
  if (partial === '') return [];
  const joined = joinSteps(steps);
  if (joined === partial) return steps;
  if (joined.startsWith(partial)) {
    const out: InputStep[] = [];
    let remaining = partial.length;
    for (const step of steps) {
      if (remaining <= 0) break;
      if (step.text.length <= remaining) {
        out.push(step);
        remaining -= step.text.length;
      } else {
        out.push({ text: step.text.slice(0, remaining), distribution: null });
        remaining = 0;
      }
    }
    return out;
  }
  if (joined.endsWith(partial)) {
    const out: InputStep[] = [];
    let remaining = partial.length;
    for (let i = steps.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const step = steps[i]!;
      if (step.text.length <= remaining) {
        out.unshift(step);
        remaining -= step.text.length;
      } else {
        out.unshift({ text: step.text.slice(step.text.length - remaining), distribution: null });
        remaining = 0;
      }
    }
    return out;
  }
  return [{ text: partial, distribution: null }];
}

/** Upper-cases the first character of `word` if `model` starts with an upper-case letter. */
function matchLeadingCase(word: string, model: string): string {
  const first = model.charAt(0);
  if (first === '' || first === first.toLowerCase() || first !== first.toUpperCase()) return word;
  const head = Array.from(word)[0] ?? '';
  return head.toUpperCase() + word.slice(head.length);
}

/**
 * The composition buffer: the text being written (plan section 4).
 *
 * The caret is always at the end in v1. Every mutating call that changes the
 * text is one undo step and emits one `changed` event; calls that change
 * nothing emit nothing and return `false` where they return a boolean.
 *
 * Automatic spacing: `acceptPrediction` adds a trailing space and marks it as
 * automatic. While it is automatic, inserting `.` `,` `!` `?` `;` `:`
 * moves the space after the punctuation (`"how "` + `"."` → `"how. "`), and
 * inserting plain whitespace is absorbed (no double space).
 */
export class CompositionBuffer implements Disposable {
  readonly events: EventBus<CompositionEventMap>;
  private current: Record_ = { text: '', steps: [], autoSpace: false };
  private history: Record_[] = [];
  private readonly historyLimit: number;
  private readonly clock: Clock | undefined;
  private readonly matchCase: boolean;
  private cachedState: CompositionState | null = null;

  constructor(options: CompositionBufferOptions = {}) {
    this.events = new EventBus(options);
    const limit = options.historyLimit ?? 100;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError('historyLimit must be an integer >= 0');
    }
    this.historyLimit = limit;
    this.clock = options.clock;
    this.matchCase = options.matchCase ?? true;
  }

  get text(): string {
    return this.current.text;
  }

  /** Derived state for the UI, predictor and plugins. */
  get state(): CompositionState {
    if (!this.cachedState) {
      const { text, steps } = this.current;
      this.cachedState = {
        text,
        caret: text.length,
        textBeforeCaret: text,
        partialWord: partialWordOf(text),
        partialWordSteps: steps,
        canUndo: this.history.length > 0,
      };
    }
    return this.cachedState;
  }

  /** Text before the caret (the whole text in v1). */
  get textBeforeCaret(): string {
    return this.current.text;
  }

  /** The word being typed. */
  get partialWord(): string {
    return this.state.partialWord;
  }

  /**
   * Appends `text`. `distribution` is the selection uncertainty of the key
   * that produced it, kept for the predictor while the word is being typed.
   */
  insert(text: string, distribution?: KeyDistribution): void {
    if (text === '') return;
    const { text: before, steps, autoSpace } = this.current;
    if (autoSpace && before.endsWith(' ')) {
      if (/^\s+$/u.test(text)) {
        this.current = { ...this.current, autoSpace: false };
        return;
      }
      if (ATTACHING_PUNCTUATION.test(text)) {
        const next = before.slice(0, -1) + text + (/\s$/u.test(text) ? '' : ' ');
        this.apply('insert', { text: next, steps: [], autoSpace: true });
        return;
      }
    }
    const next = before + text;
    const appended: InputStep[] = [...steps, { text, distribution: distribution ?? null }];
    this.apply('insert', {
      text: next,
      steps: reconcileSteps(appended, partialWordOf(next)),
      autoSpace: false,
    });
  }

  /** Deletes the last grapheme cluster. Returns false if the text was empty. */
  deleteGrapheme(): boolean {
    const { text, steps } = this.current;
    if (text === '') return false;
    const next = text.slice(0, text.length - lastGraphemeLength(text));
    this.apply('delete-grapheme', {
      text: next,
      steps: reconcileSteps(steps, partialWordOf(next)),
      autoSpace: false,
    });
    return true;
  }

  /**
   * Deletes trailing whitespace and then the last whitespace-delimited token,
   * punctuation included: `"Hello, world!  "` → `"Hello, "`. Whitespace-only
   * text is cleared. Returns false if the text was empty.
   */
  deleteWord(): boolean {
    const { text } = this.current;
    if (text === '') return false;
    const next = text.replace(/\S*\s*$/u, '');
    this.apply('delete-word', {
      text: next,
      steps: reconcileSteps([], partialWordOf(next)),
      autoSpace: false,
    });
    return true;
  }

  /** Clears the text (undoable). Returns false if already empty. */
  clear(): boolean {
    if (this.current.text === '') return false;
    this.apply('clear', { text: '', steps: [], autoSpace: false });
    return true;
  }

  /**
   * Accepts a prediction: replaces the current partial word with `word` (or,
   * when there is no partial word, appends it as the next word, adding a
   * separating space after anything but whitespace or an opening bracket or
   * quote), then appends an automatic trailing space. Empty `word` is ignored.
   */
  acceptPrediction(word: string): void {
    if (word === '') return;
    const { text } = this.current;
    const partial = partialWordOf(text);
    let base = text.slice(0, text.length - partial.length);
    let accepted = word;
    if (partial === '') {
      if (base !== '' && !OPENERS.test(base)) base += ' ';
    } else if (this.matchCase) {
      accepted = matchLeadingCase(word, partial);
    }
    const trailing = /\s$/u.test(accepted) ? '' : ' ';
    this.apply('accept-prediction', {
      text: base + accepted + trailing,
      steps: [],
      autoSpace: true,
    });
  }

  /** Replaces the whole text as one undo step (text transforms, plugins). */
  replace(text: string): void {
    if (text === this.current.text) return;
    this.apply('replace', {
      text,
      steps: reconcileSteps([], partialWordOf(text)),
      autoSpace: false,
    });
  }

  /**
   * Takes the text for speaking: returns it with surrounding whitespace
   * trimmed and clears the buffer (undo brings it back). Returns `""` and
   * changes nothing when the text is empty.
   */
  commit(): string {
    const { text } = this.current;
    if (text === '') return '';
    this.apply('commit', { text: '', steps: [], autoSpace: false });
    return text.trim();
  }

  /** Reverts the last change. Returns false when there is nothing to undo. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.apply('undo', previous, false);
    return true;
  }

  /** Number of undo steps available. */
  get undoDepth(): number {
    return this.history.length;
  }

  /** Snapshot for crash recovery. */
  snapshot(): CompositionSnapshot {
    return { version: 1, text: this.current.text, savedAt: this.clock?.wallNow() ?? 0 };
  }

  /**
   * Restores a snapshot (as read from disk, so untrusted). Unknown versions
   * or malformed data are rejected by returning false and changing nothing.
   * A successful restore clears the undo history.
   */
  restore(snapshot: unknown): boolean {
    if (!isSnapshot(snapshot)) return false;
    this.history = [];
    const text = snapshot.text;
    this.apply(
      'restore',
      { text, steps: reconcileSteps([], partialWordOf(text)), autoSpace: false },
      false,
    );
    return true;
  }

  dispose(): void {
    this.events.dispose();
  }

  private apply(reason: CompositionChangeReason, next: Record_, recordUndo = true): void {
    const previous = this.current;
    if (recordUndo && this.historyLimit > 0) {
      this.history.push(previous);
      if (this.history.length > this.historyLimit) this.history.shift();
    }
    this.current = next;
    this.cachedState = null;
    if (previous.text !== next.text || reason === 'undo' || reason === 'restore') {
      this.events.emit('changed', { reason, state: this.state, previousText: previous.text });
    }
  }
}

function isSnapshot(value: unknown): value is CompositionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; text?: unknown };
  return v.version === 1 && typeof v.text === 'string';
}
