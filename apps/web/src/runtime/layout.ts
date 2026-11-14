import {
  DisposableStore,
  EventBus,
  ForseeError,
  GENERAL_SETTINGS_NAMESPACE,
  type ErrorReporter,
  type Kernel,
} from '@forsee/core';
import {
  BUILTIN_LAYOUTS,
  createLayoutRuntime,
  pickDefaultLayout,
  type LayoutRuntime,
} from '@forsee/layouts';
import type { Disposable, LayoutDefinition, LayoutFamily } from '@forsee/plugin-api';
import { migrateLayoutId } from '@forsee/plugin-keyboards';
import { chromeCommands, withoutKeysFor } from './chrome-keys';
import { LAYOUT_SETTINGS_NAMESPACE, screenLayoutOf, type ScreenLayout } from './settings';
import type { RuntimeLayout } from './types';

interface Active {
  /** The keyboard as offered. */
  readonly source: LayoutDefinition;
  /** The screen layout it was adapted to. */
  readonly screen: ScreenLayout;
  /** `source` without the keys the screen shows as fixed controls (what is rendered). */
  readonly definition: LayoutDefinition;
  readonly runtime: LayoutRuntime;
}

/**
 * The keyboard used when no plugin offers one (the standard keyboards plugin
 * failed to start, or every layout in it is switched off): built in, so a
 * gaze user is never left without a way to type or to reach Settings.
 */
export const FALLBACK_LAYOUT: LayoutDefinition = Object.freeze({
  ...BUILTIN_LAYOUTS[0]!,
  id: 'app/fallback-qwerty',
  name: 'Fallback keyboard (QWERTY)',
});

/** Family whose default is chosen when no keyboard is picked (or the picked one is gone). */
const DEFAULT_FAMILY: LayoutFamily = 'precise';

/**
 * The active keyboard. Plugins make keyboards available (the `layouts`
 * extension point; the standard ones come from `forsee.keyboards`); exactly
 * one is in use: the one named by `app.layout/layoutId` if it is offered,
 * else the default for the language. With none offered, `FALLBACK_LAYOUT`.
 * Ids stored before the standard layouts became a plugin are migrated on
 * read. A new `LayoutRuntime` is made whenever the choice (or the chosen
 * definition) changes. Also registers `layout.showPage` and `layout.back`
 * (declared by `@forsee/layouts`) on the current runtime.
 */
export function createLayoutController(
  kernel: Kernel,
  reportError: ErrorReporter,
): RuntimeLayout & Disposable {
  const subscriptions = new DisposableStore();
  const bus = new EventBus<{ changed: Active }>({ onListenerError: reportError });

  const catalogue = (): readonly LayoutDefinition[] =>
    kernel.extensions.list('layouts').map((c) => c.contribution);
  const choose = (): LayoutDefinition => {
    const layouts = catalogue();
    if (layouts.length === 0) return FALLBACK_LAYOUT;
    const stored = kernel.settings.get(LAYOUT_SETTINGS_NAMESPACE, 'layoutId');
    const id = typeof stored === 'string' ? migrateLayoutId(stored) : '';
    const named = id === '' ? undefined : layouts.find((l) => l.id === id);
    return named ?? pickDefaultLayout(layouts, DEFAULT_FAMILY, kernel.locale);
  };
  const screen = (): ScreenLayout =>
    screenLayoutOf(kernel.settings.get(LAYOUT_SETTINGS_NAMESPACE, 'screenLayout'));
  const make = (source: LayoutDefinition, layout: ScreenLayout): Active => {
    const definition = withoutKeysFor(source, chromeCommands(layout));
    return {
      source,
      screen: layout,
      definition,
      runtime: createLayoutRuntime(definition, { onListenerError: reportError }),
    };
  };

  let active = make(choose(), screen());

  const refresh = (): void => {
    let next: LayoutDefinition;
    let layout: ScreenLayout;
    try {
      next = choose();
      layout = screen();
    } catch (error) {
      reportError(error, 'runtime.layout');
      return;
    }
    if (next === active.source && layout === active.screen) return;
    active = make(next, layout);
    bus.emit('changed', active);
  };

  subscriptions.add(
    kernel.settings.events.on('changed', (change) => {
      if (
        change.namespace === LAYOUT_SETTINGS_NAMESPACE ||
        (change.namespace === GENERAL_SETTINGS_NAMESPACE && change.key === 'locale')
      ) {
        refresh();
      }
    }),
  );
  subscriptions.add(
    kernel.extensions.events.on('changed', (change) => {
      if (change.point === 'layouts') refresh();
    }),
  );
  subscriptions.add(
    kernel.commands.register(
      'layout.showPage',
      (args) => {
        const page = (args as { page?: unknown } | undefined)?.page;
        if (typeof page !== 'string') {
          throw new ForseeError('invalid-argument', 'layout.showPage needs { page: string }');
        }
        active.runtime.showPage(page);
      },
      { title: 'Show keyboard page' },
    ),
  );
  subscriptions.add(
    kernel.commands.register('layout.back', () => active.runtime.back(), { title: 'Back' }),
  );

  return {
    get catalogue() {
      return catalogue();
    },
    get definition() {
      return active.definition;
    },
    get runtime() {
      return active.runtime;
    },
    get fallback() {
      return active.source === FALLBACK_LAYOUT;
    },
    onDidChange: (listener) => bus.on('changed', listener),
    select(layoutId) {
      if (!catalogue().some((l) => l.id === layoutId)) {
        throw new ForseeError('not-found', `There is no keyboard "${layoutId}".`);
      }
      kernel.settings.set(LAYOUT_SETTINGS_NAMESPACE, 'layoutId', layoutId);
    },
    dispose() {
      subscriptions.dispose();
      bus.dispose();
    },
  };
}
