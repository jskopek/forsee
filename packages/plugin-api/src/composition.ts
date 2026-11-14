import type { InputStep } from './prediction';

/**
 * Read-only view of the composition (the text being written), as exposed to
 * plugins with `composition.read` and to the predictor.
 *
 * v1 keeps the caret at the end of the text, so `textBeforeCaret === text`
 * and `caret === text.length`. Consumers that want to be ready for an
 * editable caret should use `textBeforeCaret`.
 */
export interface CompositionState {
  readonly text: string;
  /** UTF-16 offset of the caret. Always `text.length` in v1. */
  readonly caret: number;
  readonly textBeforeCaret: string;
  /**
   * The word being typed: the trailing run of letters, marks, digits and
   * in-word apostrophes or hyphens before the caret. Empty after whitespace
   * or punctuation.
   */
  readonly partialWord: string;
  /** How `partialWord` was entered, with selection uncertainty (see `InputStep`). */
  readonly partialWordSteps: readonly InputStep[];
  /** Whether `undo` would change anything. */
  readonly canUndo: boolean;
}

/** Why the composition changed. */
export type CompositionChangeReason =
  | 'insert'
  | 'delete-grapheme'
  | 'delete-word'
  | 'clear'
  | 'accept-prediction'
  | 'replace'
  | 'commit'
  | 'undo'
  | 'restore';

/** Payload of a composition change event. */
export interface CompositionChange {
  readonly reason: CompositionChangeReason;
  readonly state: CompositionState;
  readonly previousText: string;
}
