import type {
  DwellClass,
  KeyAction,
  LayoutActionKey,
  LayoutDefinition,
  LayoutFamily,
  LayoutGroupKey,
  LayoutKey,
  LayoutPage,
  Rect,
  ValidationResult,
} from '@forsee/plugin-api';

/**
 * Contracts of the layouts package (B7 implements them; B8, B9 and C1
 * consume them). The layout JSON schema itself (`LayoutDefinition` and
 * friends) is public and lives in `@forsee/plugin-api` (`layout.ts`).
 */

export type {
  KeyAction,
  KeyBehaviour,
  LayoutActionKey,
  LayoutDefinition,
  LayoutFamily,
  LayoutGroupKey,
  LayoutKey,
  LayoutPage,
  LayoutRow,
  LayoutSpacer,
} from '@forsee/plugin-api';
export { LAYOUT_SCHEMA_VERSION } from '@forsee/plugin-api';

/**
 * Commands the layout runtime needs. The keyboard plugin (C1) registers
 * them; layout files bind keys to them. Declared here so `CommandArgs` is
 * typed everywhere that imports `@forsee/layouts`.
 */
declare module '@forsee/plugin-api' {
  interface CommandArgsMap {
    /** Show a page of the active layout. */
    'layout.showPage': { readonly page: string };
    /** Leave an open group (coarse family) or return to the layout's initial page. */
    'layout.back': undefined;
  }
}

/** Validates untrusted JSON into a `LayoutDefinition`, checking every invariant listed on that type. */
export type LayoutValidator = (json: unknown) => ValidationResult<LayoutDefinition>;

/** A key placed on screen. */
export interface KeyRect {
  readonly key: LayoutActionKey | LayoutGroupKey;
  /** App viewport CSS pixels. */
  readonly rect: Rect;
  /** Resolved dwell class (key's own, or the default for its action). */
  readonly dwellClass: DwellClass;
}

/** Options for geometry. */
export interface GeometryOptions {
  /** Gap between keys, CSS pixels. */
  readonly gapPx: number;
  /**
   * Enlarge targets at the screen edges and corners (P1): extra size in CSS
   * pixels for keys touching the bounds. 0 disables.
   */
  readonly edgeGrowthPx: number;
}

/** Turns a page into key rectangles inside `bounds`. Spacers produce no rect. Pure. */
export type LayoutGeometry = (
  page: LayoutPage | { readonly id: string; readonly rows: LayoutPage['rows'] },
  bounds: Rect,
  options: GeometryOptions,
) => readonly KeyRect[];

/** What the runtime shows right now. */
export interface LayoutView {
  readonly layoutId: string;
  readonly pageId: string;
  /** The open group key when step two of a two-step group is showing, else null. */
  readonly openGroup: LayoutGroupKey | null;
  /** Keys to render: the page's rows, or the group's keys arranged in rows plus a back key. */
  readonly rows: readonly { readonly keys: readonly LayoutKey[]; readonly height?: number }[];
}

/**
 * Stateful interpretation of one layout: current page, open group, one-shot
 * pages and key behaviours. It decides *what* a key activation means; the
 * caller executes the returned action through the command registry.
 */
export interface LayoutRuntime {
  readonly definition: LayoutDefinition;
  readonly view: LayoutView;
  /**
   * Handles an activation of `keyId` (`repeatIndex` from the gaze
   * `ActivateEvent`). Returns the action to execute (escalation applied),
   * or null when the activation only changed the view (opening a group,
   * going back). Applies `returnToPage` after action keys.
   */
  activate(keyId: string, repeatIndex: number): KeyAction | null;
  /** Dwell class for an activation, honouring `stepDwellClasses` of escalating keys. */
  dwellClassFor(keyId: string, repeatIndex: number): DwellClass;
  showPage(pageId: string): void;
  back(): void;
  onDidChangeView(listener: (view: LayoutView) => void): { dispose(): void };
}

/** Factory signature B7 provides as `createLayoutRuntime`. */
export type LayoutRuntimeFactory = (definition: LayoutDefinition) => LayoutRuntime;

/** Built-in layouts B7 ships, by family (ids are `forsee/<name>`). */
export interface BuiltinLayoutCatalogue {
  readonly layouts: readonly LayoutDefinition[];
  /** The recommended default for a family and locale, falling back to `en`. */
  defaultFor(family: LayoutFamily, locale: string): LayoutDefinition;
}
