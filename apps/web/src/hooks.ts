import { isActionKey, isGroupKey, type LayoutRuntime } from '@forsee/layouts';
import type { LayoutActionKey, LayoutDefinition, LayoutKey, PhraseSet } from '@forsee/plugin-api';
import type { PhraseTile } from '@forsee/ui';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ForseeRuntime, RuntimeError, StartupIssue } from './runtime';

/** The quick-fire plugin's phrase set and its command (ids, not data). */
export const QUICKFIRE_OWNER = 'forsee.quickfire';
export const QUICKFIRE_COMMAND = 'forsee.quickfire.speak';
/** Quick-fire phrases drawn in the alarm colour. */
const EMPHASISED_PHRASES = new Set(['help']);

/** The active layout; re-renders when it is replaced. */
export function useActiveLayout(runtime: ForseeRuntime): {
  readonly definition: LayoutDefinition;
  readonly runtime: LayoutRuntime;
} {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = runtime.layout.onDidChange(onChange);
      return () => subscription.dispose();
    },
    [runtime],
  );
  // The definition changes exactly when the runtime object does.
  const layoutRuntime = useSyncExternalStore(subscribe, () => runtime.layout.runtime);
  const definition = runtime.layout.definition;
  return useMemo(() => ({ definition, runtime: layoutRuntime }), [definition, layoutRuntime]);
}

function actionKeysOf(key: LayoutKey): LayoutActionKey[] {
  if (isGroupKey(key)) return [...key.keys];
  return isActionKey(key) ? [key] : [];
}

/** Whether a layout has its own Speak key (`composition.speak`) on any page. */
export function layoutHasSpeakKey(definition: LayoutDefinition): boolean {
  return definition.pages.some((page) =>
    page.rows.some((row) =>
      row.keys.flatMap(actionKeysOf).some((key) => {
        if (key.action.command === 'composition.speak') return true;
        return (
          key.behaviour?.type === 'escalate' &&
          key.behaviour.steps.some((step) => step.command === 'composition.speak')
        );
      }),
    ),
  );
}

/** True while the speech engine is saying something (from its start and end events). */
export function useSpeaking(runtime: ForseeRuntime): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const active = new Set<string>();
    const subscription = runtime.speech.engine.events.on('speech', (event) => {
      if (event.type === 'start') active.add(event.utteranceId);
      else if (event.type === 'end') active.delete(event.utteranceId);
      else return;
      setSpeaking(active.size > 0);
    });
    return () => subscription.dispose();
  }, [runtime]);
  return speaking;
}

/** Whether the browser is holding speech until a user gesture. */
export function useSpeechLocked(runtime: ForseeRuntime): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = runtime.speech.onLockedChange(onChange);
      return () => subscription.dispose();
    },
    [runtime],
  );
  return useSyncExternalStore(subscribe, () => runtime.speech.locked);
}

function quickfireTiles(runtime: ForseeRuntime): readonly PhraseTile[] {
  const { kernel } = runtime;
  if (!kernel.commands.has(QUICKFIRE_COMMAND)) return [];
  const set: PhraseSet | undefined = kernel.extensions
    .list('phraseSets')
    .find((c) => c.owner === QUICKFIRE_OWNER)?.contribution;
  if (!set) return [];
  return set.categories.flatMap((category) =>
    category.phrases.map((phrase) => ({
      id: phrase.id,
      label: phrase.label ?? phrase.text,
      command: { command: QUICKFIRE_COMMAND, args: { phraseId: phrase.id } },
      emphasis: EMPHASISED_PHRASES.has(phrase.id),
    })),
  );
}

/**
 * The quick-fire replies, read from the kernel's extension registry (the
 * phrase set the `forsee.quickfire` plugin contributed) and bound to the
 * plugin's command. Empty when the plugin is not active.
 */
export function useQuickfireTiles(runtime: ForseeRuntime): readonly PhraseTile[] {
  const [tiles, setTiles] = useState(() => quickfireTiles(runtime));
  useEffect(() => {
    const refresh = (): void => setTiles(quickfireTiles(runtime));
    refresh();
    const a = runtime.kernel.extensions.events.on('changed', (change) => {
      if (change.point === 'phraseSets') refresh();
    });
    const b = runtime.kernel.commands.events.on('changed', (change) => {
      if (change.id === QUICKFIRE_COMMAND) refresh();
    });
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [runtime]);
  return tiles;
}

/** Problems to show behind the indicator: failed startup parts and reported errors. */
export interface Problems {
  readonly issues: readonly StartupIssue[];
  readonly errors: readonly RuntimeError[];
}

export function useProblems(runtime: ForseeRuntime): Problems {
  const [errors, setErrors] = useState(() => runtime.errors.list());
  useEffect(() => {
    setErrors(runtime.errors.list());
    const subscription = runtime.errors.on(() => setErrors(runtime.errors.list()));
    return () => subscription.dispose();
  }, [runtime]);
  return useMemo(() => ({ issues: runtime.startupIssues, errors }), [runtime, errors]);
}
