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
import { LAYOUT_SETTINGS_NAMESPACE } from './settings';
import type { RuntimeLayout } from './types';

interface Active {
  readonly definition: LayoutDefinition;
  readonly runtime: LayoutRuntime;
}

function familyOf(value: unknown): LayoutFamily {
  return value === 'coarse' ? 'coarse' : 'precise';
}

/**
 * The active keyboard layout: built-ins plus layouts contributed through the
 * extension registry; the one named by `app.layout/layoutId` if it exists,
 * else `pickDefaultLayout` for `app.layout/family` and the locale. A new
 * `LayoutRuntime` is made whenever the choice (or the chosen definition)
 * changes. Also registers `layout.showPage` and `layout.back` (declared by
 * `@forsee/layouts`) on the current runtime.
 */
export function createLayoutController(
  kernel: Kernel,
  reportError: ErrorReporter,
): RuntimeLayout & Disposable {
  const subscriptions = new DisposableStore();
  const bus = new EventBus<{ changed: Active }>({ onListenerError: reportError });

  const catalogue = (): readonly LayoutDefinition[] => [
    ...BUILTIN_LAYOUTS,
    ...kernel.extensions.list('layouts').map((c) => c.contribution),
  ];
  const family = (): LayoutFamily =>
    familyOf(kernel.settings.get(LAYOUT_SETTINGS_NAMESPACE, 'family'));
  const choose = (): LayoutDefinition => {
    const layouts = catalogue();
    const id = kernel.settings.get(LAYOUT_SETTINGS_NAMESPACE, 'layoutId');
    const named =
      typeof id === 'string' && id !== '' ? layouts.find((l) => l.id === id) : undefined;
    return named ?? pickDefaultLayout(layouts, family(), kernel.locale);
  };
  const make = (definition: LayoutDefinition): Active => ({
    definition,
    runtime: createLayoutRuntime(definition, { onListenerError: reportError }),
  });

  let active = make(choose());

  const refresh = (): void => {
    let next: LayoutDefinition;
    try {
      next = choose();
    } catch (error) {
      reportError(error, 'runtime.layout');
      return;
    }
    if (next === active.definition) return;
    active = make(next);
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
    get family() {
      return family();
    },
    onDidChange: (listener) => bus.on('changed', listener),
    select(layoutId) {
      const chosen = catalogue().find((l) => l.id === layoutId);
      if (!chosen) {
        throw new ForseeError('not-found', `There is no layout "${layoutId}".`);
      }
      kernel.settings.set(LAYOUT_SETTINGS_NAMESPACE, 'layoutId', layoutId);
      // Keep the family in step, so `family` describes the active layout and
      // the family's default is right if this layout later disappears.
      kernel.settings.set(LAYOUT_SETTINGS_NAMESPACE, 'family', chosen.family);
    },
    setFamily(next) {
      kernel.settings.set(LAYOUT_SETTINGS_NAMESPACE, 'layoutId', '');
      kernel.settings.set(LAYOUT_SETTINGS_NAMESPACE, 'family', familyOf(next));
    },
    dispose() {
      subscriptions.dispose();
      bus.dispose();
    },
  };
}
