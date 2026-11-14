import {
  formatSettingValue,
  normaliseOption,
  safeRange,
  stepSettingValue,
  type SettingRef,
  type SettingsTrialState,
} from '@forsee/core';
import type { SettingField, SettingValue } from '@forsee/plugin-api';
import {
  ChoiceGroup,
  GazeTarget,
  StepperControl,
  ToggleTarget,
  useSetting,
  type Choice,
} from '@forsee/ui';
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ForseeRuntime } from './runtime';

/**
 * Building blocks of the generated settings screen: one control per
 * setting, chosen from its schema, and the "Keep these settings?" banner.
 * Changes to settings marked `danger` go through `runtime.settings.trial`,
 * so they are undone unless confirmed with the new values in effect.
 */

/** One setting as the settings screen lists it. */
export interface SettingEntry {
  readonly namespace: string;
  readonly field: SettingField;
  /** Where it is listed (its `category`, or the plugin's name for plugin settings). */
  readonly category: string;
}

const NOTE = 'text-[clamp(0.85rem,2vh,1.05rem)] text-ink-muted';
const BUTTON = 'h-full min-h-[3.5rem] w-full px-3 text-[clamp(1rem,2.4vh,1.35rem)]';

/** Whether a setting is shown with or without "Show advanced settings". */
export function isVisible(field: SettingField, showAdvanced: boolean): boolean {
  return showAdvanced || (field.audience ?? 'everyone') === 'everyone';
}

/** Whether `enabledWhen` (if any) holds. */
export function isEnabled(runtime: ForseeRuntime, namespace: string, field: SettingField): boolean {
  const condition = field.enabledWhen;
  if (!condition) return true;
  try {
    return runtime.kernel.settings.get(namespace, condition.key) === condition.equals;
  } catch {
    return true;
  }
}

function isRisky(field: SettingField): boolean {
  return (field.danger ?? 'none') !== 'none';
}

/** Sets a value; risky settings go through the timed revert. Errors are reported, not thrown. */
export function writeSetting(
  runtime: ForseeRuntime,
  namespace: string,
  field: SettingField,
  value: SettingValue,
): void {
  try {
    const assignment = { namespace, key: field.key, value };
    if (isRisky(field)) runtime.settings.trial.apply([assignment]);
    else runtime.kernel.settings.setMany([assignment]);
  } catch (error) {
    runtime.reportError(error, `app.settings.${namespace}.${field.key}`);
  }
}

/** Returns settings to their defaults; through the timed revert when any is risky. */
export function resetSettings(runtime: ForseeRuntime, entries: readonly SettingEntry[]): void {
  const refs: SettingRef[] = entries.map(({ namespace, field }) => ({ namespace, key: field.key }));
  try {
    if (entries.some((e) => isRisky(e.field))) runtime.settings.trial.reset(refs);
    else runtime.kernel.settings.resetMany(refs);
  } catch (error) {
    runtime.reportError(error, 'app.settings.reset');
  }
}

/** Re-renders on every committed settings change (for "changed" markers and `enabledWhen`). */
export function useSettingsVersion(runtime: ForseeRuntime): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const subscription = runtime.kernel.settings.events.on('committed', () =>
      setVersion((v) => v + 1),
    );
    return () => subscription.dispose();
  }, [runtime]);
  return version;
}

/**
 * Every setting the screen can list, in category order then `order`.
 * App settings without a category have screens of their own and are left
 * out; plugin settings without one are listed under the plugin's name.
 */
export function useSettingsCatalogue(runtime: ForseeRuntime): readonly SettingEntry[] {
  const build = useCallback((): readonly SettingEntry[] => {
    const registry = runtime.kernel.settings;
    const pluginNames = new Map(
      runtime.pluginHost.list().map((p) => [p.manifest.id, p.manifest.name] as const),
    );
    const entries: (SettingEntry & { readonly index: number })[] = [];
    for (const namespace of registry.listNamespaces()) {
      const app = namespace === 'app' || namespace.startsWith('app.');
      (registry.getSchema(namespace) ?? []).forEach((field, index) => {
        const category = field.category ?? (app ? undefined : pluginNames.get(namespace));
        if (category !== undefined) entries.push({ namespace, field, category, index });
      });
    }
    const firstSeen = new Map<string, number>();
    entries.forEach((e, i) => {
      if (!firstSeen.has(e.category)) firstSeen.set(e.category, i);
    });
    return entries
      .sort(
        (a, b) =>
          (firstSeen.get(a.category) ?? 0) - (firstSeen.get(b.category) ?? 0) ||
          (a.field.order ?? 0) - (b.field.order ?? 0) ||
          a.index - b.index,
      )
      .map(({ namespace, field, category }) => ({ namespace, field, category }));
  }, [runtime]);
  const [entries, setEntries] = useState(build);
  useEffect(() => {
    const subscription = runtime.kernel.settings.events.on('schemaChanged', () =>
      setEntries(build()),
    );
    return () => subscription.dispose();
  }, [runtime, build]);
  return entries;
}

/** The pending risky change, if any. */
export function useSettingsTrial(runtime: ForseeRuntime): SettingsTrialState | null {
  const trial = runtime.settings.trial;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = trial.events.on('changed', onChange);
      return () => subscription.dispose();
    },
    [trial],
  );
  return useSyncExternalStore(subscribe, () => trial.pending);
}

/** The generated control for one setting: a toggle, a set of choices, a stepper, or the value read-only. */
export function SettingControl({
  runtime,
  namespace,
  field,
  className = '',
}: {
  readonly runtime: ForseeRuntime;
  readonly namespace: string;
  readonly field: SettingField;
  readonly className?: string;
}): ReactNode {
  const value = useSetting(namespace, field.key) ?? field.default;
  useSettingsVersion(runtime); // `enabledWhen` depends on another key
  const enabled = isEnabled(runtime, namespace, field);
  const idPrefix = `settings/field/${namespace}/${field.key}`;
  const set = (next: SettingValue): void => writeSetting(runtime, namespace, field, next);

  if (field.type === 'boolean') {
    return (
      <ToggleTarget
        id={idPrefix}
        label={field.label}
        value={value === true}
        disabled={!enabled}
        onChange={set}
        className={className}
      />
    );
  }
  if (field.type === 'select') {
    const options = (field.options ?? []).map(normaliseOption);
    const choices: Choice<string>[] = options.map((o) => ({
      value: String(o.value),
      label: o.label,
    }));
    return (
      <ChoiceGroup
        label={field.label}
        idPrefix={idPrefix}
        choices={choices}
        value={String(value)}
        disabled={!enabled}
        onChoose={(chosen) => {
          const option = options.find((o) => String(o.value) === chosen);
          if (option) set(option.value);
        }}
        columns={Math.min(choices.length, 4)}
        className={className}
      />
    );
  }
  if (field.type === 'number' || field.type === 'range') {
    const n = Number(value);
    const { min, max } = safeRange(field);
    const time = field.unit === 'ms';
    return (
      <StepperControl
        idPrefix={idPrefix}
        label={field.label}
        valueText={formatSettingValue(field, n)}
        downLabel={time ? 'Shorter' : 'Less'}
        upLabel={time ? 'Longer' : 'More'}
        canDown={enabled && n > min + 1e-9}
        canUp={enabled && n < max - 1e-9}
        onStep={(direction) => set(stepSettingValue(field, n, direction))}
        className={className}
      />
    );
  }
  // Text settings need a text entry screen, which the settings sheet does not have yet.
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <h3 className="text-[clamp(0.95rem,2.2vh,1.2rem)] font-semibold text-ink-muted">
        {field.label}
      </h3>
      <p className="rounded-xl bg-surface-overlay px-4 py-3 text-[clamp(1rem,2.4vh,1.25rem)]">
        {formatSettingValue(field, value)}
      </p>
    </div>
  );
}

/** One row of a settings list: the control, a line of help, and "Default" when changed. */
export function SettingRow({
  runtime,
  entry,
}: {
  readonly runtime: ForseeRuntime;
  readonly entry: SettingEntry;
}): ReactNode {
  const { namespace, field } = entry;
  useSettingsVersion(runtime);
  let modified = false;
  try {
    modified = runtime.kernel.settings.isModified(namespace, field.key);
  } catch {
    // schema removed while shown
  }
  const enabled = isEnabled(runtime, namespace, field);
  const notes = [
    field.description,
    !enabled && field.enabledWhen ? 'Not used with the current settings.' : undefined,
    field.requiresRestart ? 'Takes effect after a restart.' : undefined,
  ].filter((n): n is string => n !== undefined);
  return (
    <li
      className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_clamp(6.5rem,14vw,9rem)] gap-[clamp(0.75rem,2vh,1.25rem)] rounded-xl bg-surface-overlay p-[clamp(0.5rem,1.5vh,1rem)]"
      data-setting={`${namespace}/${field.key}`}
    >
      <div className="flex min-h-0 flex-col gap-1">
        <SettingControl
          runtime={runtime}
          namespace={namespace}
          field={field}
          className="min-h-0 flex-1"
        />
        {notes.length > 0 && <p className={`line-clamp-1 shrink-0 ${NOTE}`}>{notes.join(' ')}</p>}
      </div>
      <GazeTarget
        id={`settings/field/${namespace}/${field.key}/reset`}
        dwellClass="function"
        label={`Reset ${field.label} to ${formatSettingValue(field, field.default)}`}
        appearance="neutral"
        disabled={!modified}
        onActivate={() => resetSettings(runtime, [entry])}
        className={BUTTON}
      >
        <span>Default</span>
        <span className="text-[0.8em] font-normal">{formatSettingValue(field, field.default)}</span>
      </GazeTarget>
    </li>
  );
}

/**
 * "Keep these settings?" with a countdown. Selecting Keep (with the new
 * settings in effect) confirms; Undo or the timeout restores the old values.
 */
export function SettingsTrialBanner({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const pending = useSettingsTrial(runtime);
  const clock = runtime.kernel.clock;
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    if (!pending) return undefined;
    const first = clock.setTimeout(() => setNow(clock.now()), 0);
    const tick = clock.setInterval(() => setNow(clock.now()), 250);
    return () => {
      first.dispose();
      tick.dispose();
    };
  }, [pending, clock]);
  if (!pending) return null;
  const seconds = Math.max(0, Math.ceil((pending.deadline - now) / 1000));
  const count = pending.settings.length;
  return (
    <div
      role="alertdialog"
      aria-label="Keep these settings?"
      className="grid h-[clamp(3.5rem,10vh,5rem)] grid-cols-[minmax(0,1fr)_clamp(8rem,22vw,14rem)_clamp(7rem,16vw,10rem)] items-stretch gap-[clamp(0.75rem,2vh,1.25rem)] rounded-xl bg-surface-overlay py-1 pl-4 pr-1 ring-4 ring-inset ring-ink"
    >
      <div className="flex min-w-0 flex-col justify-center">
        <p className="truncate text-[clamp(1.05rem,2.8vh,1.5rem)] font-semibold">
          Keep these settings?
        </p>
        <p className={`line-clamp-1 ${NOTE}`}>
          Undone in {seconds} s ({count === 1 ? '1 change' : `${count} changes`})
        </p>
      </div>
      <GazeTarget
        id="settings/trial/keep"
        dwellClass="function"
        label="Keep these settings"
        appearance="function"
        onActivate={() => runtime.settings.trial.keep()}
        className={BUTTON}
      >
        <span className="font-bold">Keep</span>
      </GazeTarget>
      <GazeTarget
        id="settings/trial/undo"
        dwellClass="function"
        label="Undo these settings"
        appearance="neutral"
        onActivate={() => runtime.settings.trial.revert()}
        className={BUTTON}
      >
        <span>Undo</span>
      </GazeTarget>
    </div>
  );
}
