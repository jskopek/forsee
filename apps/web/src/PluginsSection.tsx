import type { SettingsContribution } from '@forsee/plugin-api';
import type { PluginStatus } from '@forsee/plugin-host';
import { GazeTarget, Icon } from '@forsee/ui';
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSettingsPosition } from './settings-position';
import type { ForseeRuntime } from './runtime';
import { resetSettings, SettingControl } from './SettingControls';

/** Plugins per page of the list. */
const PLUGINS_PER_PAGE = 3;
/** Setting controls per page of a plugin's options. */
const FIELDS_PER_PAGE = 9;

const BUTTON = 'h-full min-h-[3.5rem] w-full px-3 text-[clamp(1rem,2.4vh,1.35rem)]';
const SECTION = 'flex h-full min-h-0 flex-col gap-[clamp(0.75rem,2.5vh,1.5rem)]';
const NOTE = 'text-[clamp(0.9rem,2.2vh,1.15rem)] text-ink-muted';

/** The plugin host's list, re-rendered whenever any plugin's status changes. */
export function usePlugins(runtime: ForseeRuntime): readonly PluginStatus[] {
  const [plugins, setPlugins] = useState(() => runtime.pluginHost.list());
  useEffect(() => {
    const subscription = runtime.pluginHost.onDidChange(() =>
      setPlugins(runtime.pluginHost.list()),
    );
    return () => subscription.dispose();
  }, [runtime]);
  return plugins;
}

/** The settings section a plugin registered (only while it is active), or `undefined`. */
export function usePluginSettings(
  runtime: ForseeRuntime,
  pluginId: string,
): SettingsContribution | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = runtime.kernel.extensions.events.on('changed', (change) => {
        if (change.point === 'settings') onChange();
      });
      return () => subscription.dispose();
    },
    [runtime],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      runtime.kernel.extensions.list('settings').find((c) => c.owner === pluginId)?.contribution,
  );
}

/** What to say under a plugin's name about its state, or `null` when it simply runs or is off. */
function statusLine(plugin: PluginStatus): string | null {
  switch (plugin.state) {
    case 'loading':
      return 'Starting…';
    case 'deactivating':
      return 'Stopping…';
    case 'failed':
      return `Not working. ${plugin.reason ?? ''}`.trim();
    case 'blocked':
      return `Not running. ${plugin.reason ?? ''}`.trim();
    default:
      return null;
  }
}

/**
 * Settings → Plugins: turn the core plugins on and off, and change each
 * one's options (generated from the settings schema the plugin registers).
 * Like the rest of the sheet, every control is a gaze target.
 */
export function PluginsSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const [open, setOpen] = useSettingsPosition<string | null>('plugins/open', null);
  const plugins = usePlugins(runtime);
  const plugin = open === null ? undefined : plugins.find((p) => p.manifest.id === open);
  if (plugin) {
    return <PluginOptions runtime={runtime} plugin={plugin} onBack={() => setOpen(null)} />;
  }
  return <PluginList runtime={runtime} plugins={plugins} onOpen={setOpen} />;
}

function PluginList({
  runtime,
  plugins,
  onOpen,
}: {
  readonly runtime: ForseeRuntime;
  readonly plugins: readonly PluginStatus[];
  readonly onOpen: (pluginId: string) => void;
}): ReactNode {
  const core = plugins.filter((p) => p.origin === 'first-party');
  const [page, setPage] = useSettingsPosition('plugins/page', 0);
  const pages = Math.max(1, Math.ceil(core.length / PLUGINS_PER_PAGE));
  // A remembered page can be past the end if plugins went away since.
  const current = Math.min(page, pages - 1);
  const shown = core.slice(current * PLUGINS_PER_PAGE, (current + 1) * PLUGINS_PER_PAGE);

  const setEnabled = (pluginId: string, enabled: boolean): void => {
    const change = enabled
      ? runtime.pluginHost.enable(pluginId)
      : runtime.pluginHost.disable(pluginId);
    change.catch((error: unknown) =>
      runtime.reportError(error, `app.settings.plugins.${pluginId}`),
    );
  };

  return (
    <div className={SECTION}>
      <div className="flex flex-col gap-1">
        <h3 className="text-[clamp(0.95rem,2.2vh,1.2rem)] font-semibold text-ink-muted">
          {pages > 1 ? `Core plugins (page ${current + 1} of ${pages})` : 'Core plugins'}
        </h3>
        <p className={NOTE}>
          Core plugins come with Forsee. Turn off what you do not use. Community plugins are not
          available yet.
        </p>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-[clamp(0.75rem,2vh,1.25rem)]">
        {shown.map((plugin) => (
          <PluginRow
            key={plugin.manifest.id}
            runtime={runtime}
            plugin={plugin}
            onToggle={(enabled) => setEnabled(plugin.manifest.id, enabled)}
            onOpen={() => onOpen(plugin.manifest.id)}
          />
        ))}
      </ul>
      {pages > 1 && (
        <div className="grid min-h-[3.5rem] grid-cols-2 gap-[clamp(0.75rem,2vh,1.25rem)]">
          <GazeTarget
            id="settings/plugins-page/previous"
            dwellClass="function"
            label="Previous plugins"
            appearance="neutral"
            disabled={current === 0}
            onActivate={() => setPage(Math.max(0, current - 1))}
            className={BUTTON}
          >
            <Icon name="previous" size={26} />
            <span>Previous</span>
          </GazeTarget>
          <GazeTarget
            id="settings/plugins-page/next"
            dwellClass="function"
            label="More plugins"
            appearance="neutral"
            disabled={current >= pages - 1}
            onActivate={() => setPage(Math.min(pages - 1, current + 1))}
            className={BUTTON}
          >
            <Icon name="next" size={26} />
            <span>More</span>
          </GazeTarget>
        </div>
      )}
    </div>
  );
}

function PluginRow({
  runtime,
  plugin,
  onToggle,
  onOpen,
}: {
  readonly runtime: ForseeRuntime;
  readonly plugin: PluginStatus;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpen: () => void;
}): ReactNode {
  const { id, name, description } = plugin.manifest;
  const settings = usePluginSettings(runtime, id);
  const status = statusLine(plugin);
  const busy = plugin.state === 'loading' || plugin.state === 'deactivating';
  return (
    <li
      className="grid max-h-[16rem] min-h-0 flex-1 grid-cols-[minmax(0,1fr)_clamp(7rem,16vw,11rem)_clamp(7rem,16vw,11rem)] items-stretch gap-[clamp(0.75rem,2vh,1.25rem)] rounded-xl bg-surface-overlay p-[clamp(0.5rem,1.5vh,1rem)]"
      data-plugin-id={id}
    >
      <div className="flex min-w-0 flex-col justify-center gap-1">
        <p className="truncate text-[clamp(1rem,2.6vh,1.4rem)] font-semibold">{name}</p>
        <p className={`line-clamp-2 ${NOTE}`}>{description}</p>
        {status !== null && (
          <p className="flex items-start gap-2 text-[clamp(0.85rem,2vh,1.05rem)] font-semibold">
            {(plugin.state === 'failed' || plugin.state === 'blocked') && (
              <Icon name="alert" size={20} className="mt-0.5 shrink-0" />
            )}
            <span className="line-clamp-2">{status}</span>
          </p>
        )}
      </div>
      <GazeTarget
        id={`settings/plugins/${id}/enabled`}
        dwellClass="function"
        label={name}
        appearance={plugin.enabled ? 'function' : 'neutral'}
        pressed={plugin.enabled}
        disabled={busy || plugin.required}
        onActivate={() => onToggle(!plugin.enabled)}
        className={BUTTON}
      >
        <span className="text-[0.85em]">
          {plugin.required ? 'Required' : plugin.enabled ? 'Enabled' : 'Disabled'}
        </span>
        <span className="font-bold">
          {plugin.required ? 'Always on' : plugin.enabled ? 'On' : 'Off'}
        </span>
      </GazeTarget>
      <GazeTarget
        id={`settings/plugins/${id}/options`}
        dwellClass="function"
        label={`${name} options`}
        appearance="neutral"
        disabled={settings === undefined || settings.fields.length === 0}
        onActivate={onOpen}
        className={BUTTON}
      >
        <Icon name="settings" size={26} />
        <span>Options</span>
      </GazeTarget>
    </li>
  );
}

function PluginOptions({
  runtime,
  plugin,
  onBack,
}: {
  readonly runtime: ForseeRuntime;
  readonly plugin: PluginStatus;
  readonly onBack: () => void;
}): ReactNode {
  const { id, name } = plugin.manifest;
  const settings = usePluginSettings(runtime, id);
  const fields = settings?.fields ?? [];
  const [page, setPage] = useSettingsPosition(`plugins/${id}/page`, 0);
  const pages = Math.max(1, Math.ceil(fields.length / FIELDS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = fields.slice(current * FIELDS_PER_PAGE, (current + 1) * FIELDS_PER_PAGE);
  const toggles = shown.filter((f) => f.type === 'boolean');
  const others = shown.filter((f) => f.type !== 'boolean');

  const resetAll = (): void =>
    resetSettings(
      runtime,
      fields.map((field) => ({ namespace: id, field, category: name })),
    );

  return (
    <div className={SECTION}>
      <div className="grid min-h-[3.5rem] grid-cols-[clamp(8rem,20vw,13rem)_minmax(0,1fr)_clamp(8rem,20vw,13rem)] items-center gap-[clamp(0.75rem,2vh,1.25rem)]">
        <GazeTarget
          id="settings/plugin-options/back"
          dwellClass="function"
          label="Back to plugins"
          appearance="neutral"
          onActivate={onBack}
          className={BUTTON}
        >
          <Icon name="back" size={26} />
          <span>Plugins</span>
        </GazeTarget>
        <h3 className="truncate text-center text-[clamp(1.05rem,2.8vh,1.5rem)] font-semibold">
          {pages > 1 ? `${name} (page ${current + 1} of ${pages})` : name}
        </h3>
        <GazeTarget
          id="settings/plugin-options/reset"
          dwellClass="destructive"
          label={`Reset ${name} options`}
          appearance="neutral"
          disabled={fields.length === 0}
          onActivate={resetAll}
          className={BUTTON}
        >
          <span>Reset</span>
        </GazeTarget>
      </div>
      {fields.length === 0 ? (
        <p className={NOTE}>
          {plugin.enabled
            ? `${name} has no options right now.`
            : `${name} is off. Turn it on to change its options.`}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-[clamp(0.75rem,2.5vh,1.5rem)]">
          {toggles.length > 0 && (
            <div
              className="grid min-h-0 flex-1 auto-rows-fr gap-[clamp(0.75rem,2vh,1.25rem)]"
              style={{
                gridTemplateColumns: `repeat(${toggles.length > 4 ? 3 : 2}, minmax(0, 1fr))`,
              }}
            >
              {toggles.map((field) => (
                <SettingControl key={field.key} runtime={runtime} namespace={id} field={field} />
              ))}
            </div>
          )}
          {others.map((field) => (
            <SettingControl
              key={field.key}
              runtime={runtime}
              namespace={id}
              field={field}
              className="max-h-[10rem] flex-1"
            />
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="grid min-h-[3.5rem] grid-cols-2 gap-[clamp(0.75rem,2vh,1.25rem)]">
          <GazeTarget
            id="settings/plugin-options-page/previous"
            dwellClass="function"
            label="Previous options"
            appearance="neutral"
            disabled={current === 0}
            onActivate={() => setPage(Math.max(0, current - 1))}
            className={BUTTON}
          >
            <Icon name="previous" size={26} />
            <span>Previous</span>
          </GazeTarget>
          <GazeTarget
            id="settings/plugin-options-page/next"
            dwellClass="function"
            label="More options"
            appearance="neutral"
            disabled={current >= pages - 1}
            onActivate={() => setPage(Math.min(pages - 1, current + 1))}
            className={BUTTON}
          >
            <Icon name="next" size={26} />
            <span>More</span>
          </GazeTarget>
        </div>
      )}
    </div>
  );
}
