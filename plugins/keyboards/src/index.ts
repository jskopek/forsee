/**
 * `forsee.keyboards` ("Standard keyboards"): the keyboard layouts Forsee
 * ships, as a first-party plugin on the public `ForseeApi`. It only makes
 * keyboards *available*, through the `layouts` extension point; which one
 * is in use is the app's choice (`app.layout/layoutId`, Settings → Keyboard),
 * because only one keyboard is ever active.
 *
 * The app marks this plugin as required (it cannot be turned off), so there
 * is always a keyboard to choose from. If it fails anyway, the app falls back
 * to a built-in emergency keyboard.
 *
 * Settings (namespace `forsee.keyboards`): one switch per layout,
 * `show.<local id>`, all on by default, deciding which layouts are offered.
 * A layout switched off leaves the catalogue; when it was the active one,
 * the app picks the default for the language instead.
 *
 * Layout ids are `forsee.keyboards/<local id>`, for example
 * `forsee.keyboards/en-qwerty`. Permissions: none (layouts are declarative).
 */
import { BUILTIN_LAYOUTS } from '@forsee/layouts';
import type {
  Disposable,
  ForseeApi,
  LayoutDefinition,
  PluginManifest,
  PluginModule,
  SettingField,
} from '@forsee/plugin-api';
import manifestJson from '../manifest.json';

/** The plugin's manifest (validated by the plugin host when it loads). */
export const manifest = manifestJson as PluginManifest;

/** Plugin id. */
export const KEYBOARDS_PLUGIN_ID = 'forsee.keyboards';

/** Prefix of the ids the standard layouts had when they were built into the app. */
export const LEGACY_LAYOUT_PREFIX = 'forsee/';

/** A layout's id without any owner prefix: `forsee/en-qwerty` → `en-qwerty`. */
function localIdOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

/** The standard layouts with local ids (the host prefixes them with the plugin id). */
export const STANDARD_LAYOUTS: readonly LayoutDefinition[] = BUILTIN_LAYOUTS.map((layout) => ({
  ...layout,
  id: localIdOf(layout.id),
}));

/** The registered (global) id of a standard layout: `en-qwerty` → `forsee.keyboards/en-qwerty`. */
export function keyboardLayoutId(localId: string): string {
  return `${KEYBOARDS_PLUGIN_ID}/${localId}`;
}

/**
 * Maps a layout id stored before the layouts became a plugin
 * (`forsee/en-qwerty`) to its id now; other ids are returned unchanged.
 */
export function migrateLayoutId(id: string): string {
  return id.startsWith(LEGACY_LAYOUT_PREFIX) ? keyboardLayoutId(localIdOf(id)) : id;
}

/** Setting key that offers or hides one layout. */
export function showSettingKey(localId: string): string {
  return `show.${localId}`;
}

/** The plugin's settings: one switch per layout, in catalogue order. */
export const KEYBOARDS_SETTING_FIELDS: readonly SettingField[] = STANDARD_LAYOUTS.map((layout) => ({
  key: showSettingKey(layout.id),
  label: layout.name,
  description: `Offer "${layout.name}" in Settings → Keyboard.`,
  type: 'boolean',
  default: true,
}));

/** The layouts switched on in `settings`, in catalogue order. */
export function offeredLayouts(
  settings: Readonly<Record<string, unknown>>,
): readonly LayoutDefinition[] {
  return STANDARD_LAYOUTS.filter((layout) => settings[showSettingKey(layout.id)] !== false);
}

/** The plugin module. */
export const keyboardsModule: PluginModule = {
  async activate(api: ForseeApi) {
    await api.settings.registerSchema(KEYBOARDS_SETTING_FIELDS);

    // Registered layouts by local id. Changes register what is new before
    // removing what is gone, so the active keyboard never disappears in
    // between (the app would briefly fall back).
    const registered = new Map<string, Disposable>();
    const apply = async (): Promise<void> => {
      const wanted = offeredLayouts(await api.settings.getAll());
      const ids = new Set(wanted.map((layout) => layout.id));
      for (const layout of wanted) {
        if (!registered.has(layout.id)) {
          registered.set(layout.id, await api.register.layout(layout));
        }
      }
      for (const [id, registration] of [...registered]) {
        if (ids.has(id)) continue;
        registration.dispose();
        registered.delete(id);
      }
    };
    await apply();

    let sync: Promise<void> = Promise.resolve();
    await api.events.on('settings.changed', () => {
      // One update at a time, in order. The layouts are static and valid, so
      // an update fails only when the plugin stopped meanwhile (the API is
      // disposed), and then there is nothing left to offer.
      sync = sync.then(apply).catch(() => undefined);
    });
  },
};

/** The first-party plugin (manifest plus module). */
export const keyboardsPlugin: { readonly manifest: PluginManifest; readonly module: PluginModule } =
  { manifest, module: keyboardsModule };
