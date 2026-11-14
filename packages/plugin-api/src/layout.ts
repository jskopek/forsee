import type { LocaleTag } from './common';
import type { CommandInvocation, DwellClass, LayoutFamily } from './gaze';

export type { LayoutFamily } from './gaze';

/**
 * Layout JSON schema (plan sections 3 and 10, B7), as TypeScript types.
 * Layouts are data; the host renders them and owns all interaction.
 *
 * Geometry is relative: a page fills the region it is shown in; rows share
 * the height by their `height` weights and keys share their row's width by
 * their `width` weights. A uniform grid is simply rows of equal-width keys.
 * The layouts package turns a page plus a bounding `Rect` into key rectangles.
 */

/** Current layout schema version. */
export const LAYOUT_SCHEMA_VERSION = 1;

/** What a key does on activation: a command plus JSON arguments. */
export type KeyAction = CommandInvocation;

/**
 * What happens when a key fires repeatedly while gaze stays on it (the gaze
 * engine reports `repeatIndex` 0, 1, 2, ...):
 * - `single` (default): fires once; the user must look away.
 * - `repeat`: fires the key's action again every `intervalMs` (default: the
 *   user's repeat interval). For delete letter, arrows.
 * - `escalate`: fires `steps[min(repeatIndex, steps.length - 1)]`, so the
 *   key's own `action` is ignored. For example delete letter, then delete
 *   word, then clear (the prototype's Backspace: dwell to delete, longer to clear).
 */
export type KeyBehaviour =
  | { readonly type: 'single' }
  | { readonly type: 'repeat'; readonly intervalMs?: number }
  | {
      readonly type: 'escalate';
      /** At least one step. */
      readonly steps: readonly KeyAction[];
      /** Dwell classes per step; defaults to the key's class. Lets later steps be `destructive`. */
      readonly stepDwellClasses?: readonly DwellClass[];
    };

/** Fields shared by every kind of key. */
interface LayoutKeyBase {
  /** Unique within the layout. */
  readonly id: string;
  /** Relative width within the row. Default 1. */
  readonly width?: number;
}

/** A key that runs a command (letters, space, delete, speak, page switches). */
export interface LayoutActionKey extends LayoutKeyBase {
  /** Visible label. May be a single grapheme, a word, or empty with `icon`. */
  readonly label: string;
  /** Optional icon name from the UI's icon set, shown with or instead of the label. */
  readonly icon?: string;
  /**
   * The command. Letter keys use `composition.insert` with `{ "text": "a" }`;
   * page switches use `layout.showPage` with `{ "page": "<page id>" }`.
   */
  readonly action: KeyAction;
  /** Defaults to `letter` for `composition.insert` keys and `function` otherwise. */
  readonly dwellClass?: DwellClass;
  readonly behaviour?: KeyBehaviour;
  /**
   * Page to return to after this key fires (one-shot pages: shift, a symbol
   * page). Absent means stay.
   */
  readonly returnToPage?: string;
  readonly group?: never;
  readonly spacer?: never;
}

/**
 * A two-step group key for the coarse family: the first dwell replaces the
 * page with the group's keys (plus an automatic "back" key), the second dwell
 * picks one, then the page returns.
 */
export interface LayoutGroupKey extends LayoutKeyBase {
  /** Label of the group, for example `"ABCD"`. */
  readonly label: string;
  readonly icon?: string;
  /** The keys shown in step two. At least two; groups do not nest. */
  readonly keys: readonly LayoutActionKey[];
  /** Columns used to lay out step two. Default: as square as possible. */
  readonly columns?: number;
  readonly group: true;
  readonly action?: never;
  readonly spacer?: never;
}

/** Empty space that takes room but is not a target. */
export interface LayoutSpacer extends LayoutKeyBase {
  readonly spacer: true;
  readonly label?: never;
  readonly action?: never;
  readonly group?: never;
}

/** Any entry in a row. Discriminate with `'spacer' in key`, `'group' in key` or `'action' in key`. */
export type LayoutKey = LayoutActionKey | LayoutGroupKey | LayoutSpacer;

/** A row of keys. */
export interface LayoutRow {
  readonly keys: readonly LayoutKey[];
  /** Relative height within the page. Default 1. */
  readonly height?: number;
}

/** One page of a layout (letters, numbers, punctuation, ...). */
export interface LayoutPage {
  /** Unique within the layout. */
  readonly id: string;
  /** Name used in page pickers and for speech feedback. */
  readonly name: string;
  readonly rows: readonly LayoutRow[];
}

/**
 * A complete layout (one JSON file).
 *
 * Invariants checked by the layouts validator:
 * - `schemaVersion` is `LAYOUT_SCHEMA_VERSION`.
 * - Page ids are unique; `initialPage` and every `returnToPage` and
 *   `layout.showPage` target name an existing page.
 * - Key ids are unique across the layout (including keys inside groups).
 * - Every weight (`width`, `height`) is a positive finite number.
 * - `coarse` layouts have at most 12 targets per page (group keys count once).
 */
export interface LayoutDefinition {
  readonly schemaVersion: 1;
  /** Globally unique. Plugins prefix it with their id: `<pluginId>/<name>`. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly family: LayoutFamily;
  readonly locale: LocaleTag;
  readonly initialPage: string;
  readonly pages: readonly LayoutPage[];
}
