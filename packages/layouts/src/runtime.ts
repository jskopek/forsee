import { EventBus, ForseeError } from '@forsee/core';
import type {
  DwellClass,
  KeyAction,
  LayoutActionKey,
  LayoutDefinition,
  LayoutGroupKey,
  LayoutKey,
  LayoutPage,
  LayoutRow,
} from '@forsee/plugin-api';
import type {
  LayoutRuntime,
  LayoutRuntimeFactory,
  LayoutRuntimeOptions,
  LayoutView,
} from './contracts';
import { actionForRepeat, dwellClassForRepeat } from './dwell';
import { isActionKey, isGroupKey } from './keys';
import { GROUP_BACK_KEY_ID } from './validator';

/** The automatic key shown last while a group is open. */
export const GROUP_BACK_KEY: LayoutActionKey = {
  id: GROUP_BACK_KEY_ID,
  label: 'Back',
  icon: 'back',
  action: { command: 'layout.back' },
  dwellClass: 'function',
};

/**
 * Arranges an open group's keys plus the back key into rows. Columns default
 * to the smallest number that makes the grid as square as possible; the last
 * row is padded with spacers so every cell has the same width.
 */
export function groupRows(group: LayoutGroupKey): LayoutRow[] {
  const items: LayoutKey[] = [...group.keys, GROUP_BACK_KEY];
  const columns = Math.min(
    items.length,
    Math.max(1, group.columns ?? Math.ceil(Math.sqrt(items.length))),
  );
  const rows: LayoutRow[] = [];
  for (let start = 0; start < items.length; start += columns) {
    const keys = items.slice(start, start + columns);
    for (let pad = 1; keys.length < columns; pad++) {
      keys.push({ id: `$pad${rows.length}-${pad}`, spacer: true });
    }
    rows.push({ keys });
  }
  return rows;
}

function indexKeys(definition: LayoutDefinition): Map<string, LayoutKey> {
  const index = new Map<string, LayoutKey>([[GROUP_BACK_KEY_ID, GROUP_BACK_KEY]]);
  for (const page of definition.pages) {
    for (const row of page.rows) {
      for (const key of row.keys) {
        index.set(key.id, key);
        if (isGroupKey(key)) for (const sub of key.keys) index.set(sub.id, sub);
      }
    }
  }
  return index;
}

/**
 * Creates the runtime for a (validated) layout. See `LayoutRuntime`.
 *
 * Rules
 * - Starts on `initialPage` with no group open.
 * - Activating a group key opens it (view changes, returns null). Activating
 *   one of its keys returns that key's action, closes the group and then
 *   applies the key's `returnToPage`, if any, so the page returns after a
 *   letter. The automatic back key (id `$back`) only closes the group.
 * - `layout.showPage` and `layout.back` actions are applied by the runtime
 *   itself and return null, so the caller never executes them. (C1 still
 *   registers both commands so that other code can run them; their handlers
 *   call `showPage` and `back`.)
 * - `single` keys fire only for `repeatIndex` 0; `repeat` keys fire their
 *   action every time; `escalate` keys fire `steps[min(repeatIndex, last)]`.
 * - Activating a key that is not visible right now (a stale event after the
 *   view changed) does nothing and returns null.
 * - Change events fire only when the page or open group actually changes,
 *   once per activation.
 */
export const createLayoutRuntime: LayoutRuntimeFactory = (
  definition: LayoutDefinition,
  options: LayoutRuntimeOptions = {},
): LayoutRuntime => {
  const pages = new Map<string, LayoutPage>(definition.pages.map((p) => [p.id, p]));
  const keyIndex = indexKeys(definition);
  const bus = new EventBus<{ change: LayoutView }>(
    options.onListenerError === undefined ? {} : { onListenerError: options.onListenerError },
  );

  const initial = pages.get(definition.initialPage);
  if (!initial) {
    throw new ForseeError(
      'invalid-argument',
      `Layout "${definition.id}" has no initial page "${definition.initialPage}".`,
    );
  }

  let pageId = initial.id;
  let openGroup: LayoutGroupKey | null = null;
  let view = makeView();

  function makeView(): LayoutView {
    const page = pages.get(pageId);
    return {
      layoutId: definition.id,
      pageId,
      openGroup,
      rows: openGroup ? groupRows(openGroup) : (page?.rows ?? []),
    };
  }

  function setState(nextPage: string, nextGroup: LayoutGroupKey | null): void {
    if (nextPage === pageId && nextGroup === openGroup) return;
    pageId = nextPage;
    openGroup = nextGroup;
    view = makeView();
    bus.emit('change', view);
  }

  function requirePage(id: string): void {
    if (!pages.has(id)) {
      throw new ForseeError('invalid-argument', `Layout "${definition.id}" has no page "${id}".`);
    }
  }

  function findVisibleKey(keyId: string): LayoutKey | undefined {
    for (const row of view.rows) {
      for (const key of row.keys) if (key.id === keyId) return key;
    }
    return undefined;
  }

  function showPage(id: string): void {
    requirePage(id);
    setState(id, null);
  }

  function back(): void {
    if (openGroup) setState(pageId, null);
    else setState(definition.initialPage, null);
  }

  function activate(keyId: string, repeatIndex: number): KeyAction | null {
    const key = findVisibleKey(keyId);
    if (!key) return null;
    if (key.spacer === true) return null;
    if (key.id === GROUP_BACK_KEY_ID) {
      back();
      return null;
    }
    if (isGroupKey(key)) {
      if (repeatIndex > 0) return null;
      setState(pageId, key);
      return null;
    }
    if (!isActionKey(key)) return null;

    const behaviour = key.behaviour;
    if ((behaviour === undefined || behaviour.type === 'single') && repeatIndex > 0) return null;

    const action = actionForRepeat(key, repeatIndex);
    if (action.command === 'layout.showPage') {
      const page = action.args?.page;
      if (typeof page !== 'string') {
        throw new ForseeError('invalid-argument', 'layout.showPage needs a string "page".');
      }
      showPage(page);
      return null;
    }
    if (action.command === 'layout.back') {
      back();
      return null;
    }
    const target = key.returnToPage ?? pageId;
    if (key.returnToPage !== undefined) requirePage(key.returnToPage);
    setState(target, null);
    return action;
  }

  function dwellClassFor(keyId: string, repeatIndex: number): DwellClass {
    const key = keyIndex.get(keyId);
    if (!key) {
      throw new ForseeError('invalid-argument', `Layout "${definition.id}" has no key "${keyId}".`);
    }
    return dwellClassForRepeat(key, repeatIndex);
  }

  return {
    definition,
    get view() {
      return view;
    },
    activate,
    dwellClassFor,
    showPage,
    back,
    onDidChangeView: (listener) => bus.on('change', listener),
  };
};
