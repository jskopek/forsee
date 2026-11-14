import type {
  ActivateEvent,
  CommandInvocation,
  JsonObject,
  KeyDistribution,
} from '@forsee/plugin-api';

/**
 * Attaching the selection's uncertainty to what an activation executes.
 *
 * Whoever executes an activation (the pipeline for targets with a command,
 * the owner of the target otherwise: the keyboard view's activation adapter
 * for layout keys, a panel host for panel targets) passes the invocation
 * through `withActivationDistribution` first, so every path attaches the
 * key distribution the same way and the predictor always receives it.
 */

/** The distribution as JSON command arguments (`composition.insert`'s `distribution`). */
export function distributionToJson(distribution: KeyDistribution): JsonObject {
  return {
    entries: distribution.entries.map((e) =>
      e.text === undefined
        ? { targetId: e.targetId, probability: e.probability }
        : { targetId: e.targetId, text: e.text, probability: e.probability },
    ),
  };
}

/**
 * Returns `invocation` with the activation's key distribution attached when
 * the command is `composition.insert`, its args carry no `distribution`,
 * and the event's distribution is not empty. Otherwise returns `invocation`
 * itself, unchanged. Never mutates its inputs.
 *
 * ```ts
 * const action = runtime.activate(keyId, event.repeatIndex);
 * if (action) {
 *   const run = withActivationDistribution(action, event);
 *   await execute(run.command, run.args, 'gaze');
 * }
 * ```
 */
export function withActivationDistribution(
  invocation: CommandInvocation,
  event: Pick<ActivateEvent, 'distribution'>,
): CommandInvocation {
  if (invocation.command !== 'composition.insert') return invocation;
  if (invocation.args?.distribution !== undefined) return invocation;
  if (event.distribution.entries.length === 0) return invocation;
  return {
    command: invocation.command,
    args: { ...invocation.args, distribution: distributionToJson(event.distribution) },
  };
}
