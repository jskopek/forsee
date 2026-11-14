import { defaultErrorReporter } from '@forsee/core';
import { withActivationDistribution, type ActivationOutcome } from '@forsee/gaze';
import type { LayoutView } from '@forsee/layouts';
import type { ActivateEvent } from '@forsee/plugin-api';
import type {
  ActivationAdapter,
  ActivationAdapterFactory,
  ActivationAdapterOptions,
  ActivationAdapterResult,
} from './contracts';

const IGNORED: ActivationAdapterResult = Object.freeze({ kind: 'ignored' });
const VIEW_CHANGED: ActivationAdapterResult = Object.freeze({ kind: 'view-changed' });

function isVisible(view: LayoutView, keyId: string): boolean {
  for (const row of view.rows) {
    for (const key of row.keys) if (key.id === keyId && key.spacer !== true) return true;
  }
  return false;
}

/**
 * The keyboard view's activation adapter (see `ActivationAdapter`): turns an
 * owner activation of a layout key into exactly one command execution.
 *
 * For each `handle(event, outcome)`:
 * 1. `ignored` unless `outcome.executedBy` is `owner`, the adapter is not
 *    disposed, the same event object has not been handled before,
 *    `keyIdOf(event.targetId)` maps to a key and that key is visible in the
 *    runtime's current view (a stale activation from a previous page or a
 *    closed group is dropped here, before the runtime sees it).
 * 2. `runtime.activate(keyId, event.repeatIndex)` resolves escalation,
 *    groups, page changes and `returnToPage`. `null` with a changed view
 *    gives `view-changed`; `null` with the same view (a `single` key asked
 *    to repeat) gives `ignored`.
 * 3. The action gets the selection's distribution with
 *    `withActivationDistribution`, and is executed once, synchronously
 *    inside `handle`, as `execute(command, args, 'gaze')`.
 *
 * A runtime that throws (a layout pointing at a missing page) reports the
 * error and gives `ignored`.
 */
export const createActivationAdapter: ActivationAdapterFactory = (
  options: ActivationAdapterOptions,
): ActivationAdapter => {
  const { runtime, keyIdOf, execute } = options;
  const reportError = options.reportError ?? defaultErrorReporter;
  const handled = new WeakSet<ActivateEvent>();
  let disposed = false;

  async function handle(
    event: ActivateEvent,
    outcome: ActivationOutcome,
  ): Promise<ActivationAdapterResult> {
    if (disposed || outcome.executedBy !== 'owner') return IGNORED;
    if (handled.has(event)) return IGNORED;
    const keyId = keyIdOf(event.targetId);
    if (keyId === undefined) return IGNORED;
    const before = runtime.view;
    if (!isVisible(before, keyId)) return IGNORED;
    handled.add(event);

    let action;
    try {
      action = runtime.activate(keyId, event.repeatIndex);
    } catch (error) {
      reportError(error, `ui.keyboard.activate:${keyId}`);
      return IGNORED;
    }
    if (action === null) return runtime.view === before ? IGNORED : VIEW_CHANGED;

    const invocation = withActivationDistribution(action, event);
    let pending: Promise<unknown>;
    try {
      pending = execute(invocation.command, invocation.args, 'gaze');
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await pending;
      return { kind: 'executed', invocation };
    } catch (error) {
      reportError(error, `ui.keyboard.command:${invocation.command}`);
      return { kind: 'failed', invocation, error };
    }
  }

  return {
    handle,
    dispose: () => {
      disposed = true;
    },
  };
};
