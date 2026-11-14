import { defaultErrorReporter, type ErrorReporter } from '@forsee/core';
import type { CompositionState, SettingValue } from '@forsee/plugin-api';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { HostUiServices } from './contracts';
import { browserDomEnvironment, type UiDomEnvironment } from './dom';
import { GazeEventHub } from './gaze-hub';
import { PredictionFeed, type PredictionSnapshot } from './prediction-feed';

/**
 * Hides every registered target except the ones inside an overlay (the
 * pause overlay), so that a full-screen overlay's targets win every hit
 * test. While occluded, `GazeTarget`s and the keyboard unregister their
 * targets and register them again when the overlay goes away.
 */
export class OcclusionStore {
  private count = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): boolean => this.count > 0;

  /** Occludes until the returned function is called. */
  acquire(): () => void {
    this.count += 1;
    if (this.count === 1) this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count -= 1;
      if (this.count === 0) this.notify();
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Everything the host UI components share, provided by `HostUiProvider`. */
export interface HostUiContextValue {
  readonly services: HostUiServices;
  readonly hub: GazeEventHub;
  /** Null without a prediction engine. */
  readonly feed: PredictionFeed | null;
  readonly dom: UiDomEnvironment;
  readonly occlusion: OcclusionStore;
  readonly reportError: ErrorReporter;
}

const HostUiContext = createContext<HostUiContextValue | null>(null);

/** True inside an overlay that stays registered while the rest is occluded. */
export const OverlayScopeContext = createContext(false);

/** Props of `HostUiProvider`. */
export interface HostUiProviderProps {
  readonly services: HostUiServices;
  /** How elements are measured and observed. Default: the browser (`getBoundingClientRect`, `ResizeObserver`). */
  readonly dom?: UiDomEnvironment;
  /** Where UI errors go (failed commands from clicks, throwing listeners). Default: core's reporter. */
  readonly reportError?: ErrorReporter;
  /** Candidates requested per prediction list. Default 6. */
  readonly maxCandidates?: number;
  readonly children?: ReactNode;
}

/**
 * Provides `HostUiServices` (kernel, gaze pipeline, prediction engine) to
 * the trusted host UI below it, plus the shared per-target gaze event hub
 * and the single prediction session. Feature panels never read it: they get
 * their plugin's `ForseeApi`.
 */
export function HostUiProvider({
  services,
  dom = browserDomEnvironment,
  reportError = defaultErrorReporter,
  maxCandidates = 6,
  children,
}: HostUiProviderProps): ReactNode {
  const [hub] = useState(() => new GazeEventHub(reportError));
  const [occlusion] = useState(() => new OcclusionStore());
  const { kernel, prediction, gaze } = services;
  const feed = useMemo(
    () =>
      prediction ? new PredictionFeed(kernel, prediction, { maxCandidates, reportError }) : null,
    [kernel, prediction, maxCandidates, reportError],
  );

  useEffect(() => {
    if (!gaze) return undefined;
    const attachment = hub.attach(gaze);
    return () => attachment.dispose();
  }, [hub, gaze]);

  useEffect(() => {
    if (!feed) return undefined;
    const running = feed.start();
    return () => running.dispose();
  }, [feed]);

  const value = useMemo<HostUiContextValue>(
    () => ({ services, hub, feed, dom, occlusion, reportError }),
    [services, hub, feed, dom, occlusion, reportError],
  );
  return <HostUiContext.Provider value={value}>{children}</HostUiContext.Provider>;
}

/** The host UI context. Throws outside `HostUiProvider`. */
export function useHostUi(): HostUiContextValue {
  const value = useContext(HostUiContext);
  if (!value)
    throw new Error('Forsee host UI components must be rendered inside <HostUiProvider>.');
  return value;
}

/** The `HostUiServices` given to the provider. */
export function useHostServices(): HostUiServices {
  return useHostUi().services;
}

/** The composition state; re-renders on every composition change. */
export function useComposition(): CompositionState {
  const composition = useHostServices().kernel.composition;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = composition.events.on('changed', onChange);
      return () => subscription.dispose();
    },
    [composition],
  );
  return useSyncExternalStore(subscribe, () => composition.state);
}

/** Whether gaze selection is paused (from the kernel's `gaze.pauseChanged` events). */
export function useGazePaused(): boolean {
  const { kernel } = useHostServices();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = kernel.bus.on('gaze.pauseChanged', onChange);
      return () => subscription.dispose();
    },
    [kernel],
  );
  return useSyncExternalStore(subscribe, () => kernel.gaze?.paused ?? false);
}

/**
 * Dwell progress (0..1) of one target. Re-renders the caller on every
 * progress event of that target, so use it for small indicators only;
 * `GazeTarget` itself writes progress straight to the DOM.
 */
export function useDwellProgress(targetId: string): number {
  const { hub } = useHostUi();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = hub.onProgress(targetId, onChange);
      return () => subscription.dispose();
    },
    [hub, targetId],
  );
  return useSyncExternalStore(subscribe, () => hub.progressOf(targetId)?.progress ?? 0);
}

/** Whether gaze is engaged with (highlighting) one target. */
export function useEngaged(targetId: string): boolean {
  const { hub } = useHostUi();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = hub.onEngagedChange(targetId, onChange);
      return () => subscription.dispose();
    },
    [hub, targetId],
  );
  return useSyncExternalStore(subscribe, () => hub.engagedId === targetId);
}

/** The engaged target id (any target), or null. Re-renders on every engage change. */
export function useEngagedTargetId(): string | null {
  const { hub } = useHostUi();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = hub.onAnyEngage(onChange);
      return () => subscription.dispose();
    },
    [hub],
  );
  return useSyncExternalStore(subscribe, () => hub.engagedId);
}

/**
 * A setting's current value, or undefined while its namespace (or key) has
 * no schema. Re-renders when it changes or its schema is registered.
 */
export function useSetting(namespace: string, key: string): SettingValue | undefined {
  const settings = useHostServices().kernel.settings;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const changed = settings.events.on('changed', (change) => {
        if (change.namespace === namespace && change.key === key) onChange();
      });
      const schema = settings.events.on('schemaChanged', (change) => {
        if (change.namespace === namespace) onChange();
      });
      return () => {
        changed.dispose();
        schema.dispose();
      };
    },
    [settings, namespace, key],
  );
  return useSyncExternalStore(subscribe, () => {
    if (!settings.getSchema(namespace)?.some((field) => field.key === key)) return undefined;
    return settings.get(namespace, key);
  });
}

const NO_PREDICTION: PredictionSnapshot = Object.freeze({
  session: null,
  result: null,
  partialWord: '',
});

const noSubscription = (): (() => void) => () => undefined;

/** The shared prediction session and its latest result (empty without an engine). */
export function usePrediction(): PredictionSnapshot {
  const { feed } = useHostUi();
  return useSyncExternalStore(feed ? feed.subscribe : noSubscription, () =>
    feed ? feed.get() : NO_PREDICTION,
  );
}

/** Whether targets outside overlays should be unregistered right now. */
export function useOccluded(): boolean {
  const { occlusion } = useHostUi();
  const insideOverlay = useContext(OverlayScopeContext);
  const occluded = useSyncExternalStore(occlusion.subscribe, occlusion.get);
  return occluded && !insideOverlay;
}
