import type { Disposable, SettingValue } from '@forsee/plugin-api';
import { defaultErrorReporter, type ErrorReporter } from './errors';
import { EventBus } from './event-bus';
import type { Clock } from './platform';
import type { SettingAssignment, SettingRef, SettingsRegistry } from './settings';

/** How long a risky change waits for "Keep" before it is undone, ms. */
export const DEFAULT_SETTINGS_TRIAL_MS = 15_000;

/** A risky change waiting to be confirmed. */
export interface SettingsTrialState {
  /** The settings that will be restored. */
  readonly settings: readonly SettingRef[];
  /** `clock.now()` at which the change is undone. */
  readonly deadline: number;
}

export interface SettingsTrialOptions {
  readonly registry: SettingsRegistry;
  readonly clock: Pick<Clock, 'now' | 'setTimeout'>;
  /** Default `DEFAULT_SETTINGS_TRIAL_MS`. */
  readonly timeoutMs?: number;
  readonly reportError?: ErrorReporter;
}

interface Previous {
  readonly namespace: string;
  readonly key: string;
  /** The stored value before the trial, or `undefined` when the default was in effect. */
  readonly stored: SettingValue | undefined;
}

/**
 * Timed revert for risky setting changes (settings research, part 3.5):
 * `apply` makes the change at once and starts a countdown; only `keep`,
 * which the user must select with the new values in effect, makes it
 * stick. A timeout or `revert` restores what was there before (including
 * "not set"). Further changes during a trial join it and restart the
 * countdown; the values restored are those from before the first one.
 *
 * If the app stops during a trial, the new values stay stored; a safe-mode
 * start is the fallback for that case.
 */
export class SettingsTrial implements Disposable {
  readonly events = new EventBus<{ changed: SettingsTrialState | null }>();
  private readonly registry: SettingsRegistry;
  private readonly clock: Pick<Clock, 'now' | 'setTimeout'>;
  private readonly timeoutMs: number;
  private readonly reportError: ErrorReporter;
  private previous: Previous[] = [];
  private timer: Disposable | null = null;
  private state: SettingsTrialState | null = null;

  constructor(options: SettingsTrialOptions) {
    this.registry = options.registry;
    this.clock = options.clock;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SETTINGS_TRIAL_MS;
    this.reportError = options.reportError ?? defaultErrorReporter;
  }

  /** The change waiting for confirmation, or `null`. */
  get pending(): SettingsTrialState | null {
    return this.state;
  }

  /**
   * Applies `assignments` (validated together; throws like `setMany` and
   * then changes nothing) and starts or restarts the countdown.
   */
  apply(assignments: readonly SettingAssignment[]): void {
    const additions = this.record(assignments);
    this.registry.setMany(assignments);
    this.begin(additions);
  }

  /** Like `apply`, but returns the settings to their defaults (`resetMany`). */
  reset(refs: readonly SettingRef[]): void {
    const additions = this.record(refs);
    this.registry.resetMany(refs);
    this.begin(additions);
  }

  /** What to restore for settings not yet part of the trial. Throws `not-found` for unknown keys. */
  private record(refs: readonly SettingRef[]): Previous[] {
    const recorded = new Set(this.previous.map((p) => `${p.namespace}/${p.key}`));
    const additions: Previous[] = [];
    for (const { namespace, key } of refs) {
      const id = `${namespace}/${key}`;
      if (recorded.has(id)) continue;
      recorded.add(id);
      const value = this.registry.get(namespace, key);
      additions.push({
        namespace,
        key,
        stored: this.registry.isSet(namespace, key) ? value : undefined,
      });
    }
    return additions;
  }

  private begin(additions: readonly Previous[]): void {
    if (additions.length === 0 && this.state === null) return;
    this.previous.push(...additions);
    this.timer?.dispose();
    this.timer = this.clock.setTimeout(() => this.revert(), this.timeoutMs);
    this.state = {
      settings: this.previous.map(({ namespace, key }) => ({ namespace, key })),
      deadline: this.clock.now() + this.timeoutMs,
    };
    this.events.emit('changed', this.state);
  }

  /** Confirms the change. */
  keep(): void {
    if (!this.state) return;
    this.finish();
  }

  /** Undoes the change now. */
  revert(): void {
    if (!this.state) return;
    const previous = this.previous;
    this.finish();
    try {
      this.registry.setMany(
        previous.flatMap(({ namespace, key, stored }) =>
          stored === undefined ? [] : [{ namespace, key, value: stored }],
        ),
      );
      this.registry.resetMany(
        previous
          .filter((p) => p.stored === undefined)
          .map(({ namespace, key }) => ({ namespace, key })),
      );
    } catch (error) {
      this.reportError(error, 'settings.trial.revert');
    }
  }

  dispose(): void {
    this.timer?.dispose();
    this.timer = null;
    this.events.dispose();
  }

  private finish(): void {
    this.timer?.dispose();
    this.timer = null;
    this.previous = [];
    this.state = null;
    this.events.emit('changed', null);
  }
}
