import { defaultErrorReporter, EventBus, toDisposable, type ErrorReporter } from '@forsee/core';
import type { Disposable, PanelActivation, PanelTarget } from '@forsee/plugin-api';
import type { PanelTargetSet, PanelTargetStore } from './contracts';

/**
 * Host-wide registry of custom-UI panel targets. Plugin API sessions write
 * (`set`, `clear`); the UI and B10 read (`get`, `list`, `onDidChange`),
 * translate the panel-relative rectangles into viewport targets for the gaze
 * engine, and report activations back with `activate`.
 *
 * Rectangles are stored as the plugin gave them (within ±100 000 px of the
 * frame). Whoever translates them **must clip each one to the panel's frame**:
 * a target lying over the keyboard would take the user's selections and tell
 * the plugin which keys were chosen, which is the composition.
 */
export class PanelTargets implements PanelTargetStore {
  private readonly sets = new Map<string, PanelTargetSet>();
  private readonly changes: EventBus<{ changed: string }>;
  private readonly listeners = new Map<string, Set<(activation: PanelActivation) => void>>();
  private readonly reportError: ErrorReporter;

  constructor(options: { readonly reportError?: ErrorReporter } = {}) {
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.changes = new EventBus({ onListenerError: this.reportError });
  }

  get(panelId: string): readonly PanelTarget[] {
    return this.sets.get(panelId)?.targets ?? [];
  }

  list(): readonly PanelTargetSet[] {
    return [...this.sets.values()];
  }

  onDidChange(listener: (panelId: string) => void): Disposable {
    return this.changes.on('changed', listener);
  }

  set(pluginId: string, localPanelId: string, targets: readonly PanelTarget[]): void {
    const panelId = `${pluginId}/${localPanelId}`;
    this.sets.set(panelId, { panelId, pluginId, targets });
    this.changes.emit('changed', panelId);
  }

  clear(pluginId: string): void {
    for (const set of [...this.sets.values()]) {
      if (set.pluginId !== pluginId) continue;
      this.sets.delete(set.panelId);
      this.changes.emit('changed', set.panelId);
    }
  }

  onActivate(pluginId: string, listener: (activation: PanelActivation) => void): Disposable {
    let set = this.listeners.get(pluginId);
    if (!set) {
      set = new Set();
      this.listeners.set(pluginId, set);
    }
    const entry = (activation: PanelActivation): void => listener(activation);
    set.add(entry);
    return toDisposable(() => {
      set.delete(entry);
    });
  }

  activate(panelId: string, targetId: string, repeatIndex: number): boolean {
    const set = this.sets.get(panelId);
    const target = set?.targets.find((t) => t.id === targetId);
    if (!set || !target || target.disabled === true) return false;
    if (!Number.isInteger(repeatIndex) || repeatIndex < 0) return false;
    const localPanelId = panelId.slice(set.pluginId.length + 1);
    const activation: PanelActivation = { panelId: localPanelId, targetId, repeatIndex };
    for (const listener of [...(this.listeners.get(set.pluginId) ?? [])]) {
      try {
        listener({ ...activation });
      } catch (error) {
        this.reportError(error, `panel.activate:${panelId}`);
      }
    }
    return true;
  }
}
