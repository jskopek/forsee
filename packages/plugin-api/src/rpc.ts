import type { ForseeErrorData } from './common';

/**
 * Envelopes for the sandbox RPC channel (`postMessage` between the host and a
 * plugin frame/worker). Both sides can send requests: the plugin calls
 * `ForseeApi` methods, the host calls back into handler objects the plugin
 * registered (listeners, providers, command handlers).
 *
 * Wire rules:
 * - Every message carries `protocol: 'forsee-rpc'` and `version: RPC_VERSION`;
 *   messages that do not are ignored.
 * - Request ids are positive integers, unique per sender per channel.
 *   Exactly one response (result or error) answers each request, unless it
 *   was cancelled, in which case a response may still arrive and is ignored.
 * - Plugin → host `method` is the `ForseeApi` path, for example
 *   `"composition.insert"` or `"register.predictionProvider"`; `params` are
 *   the positional arguments.
 * - A handler object or function in `params` is replaced by an
 *   `RpcHandleRef`. The receiver builds a proxy whose methods send
 *   `invoke` requests (`method: RPC_INVOKE_METHOD`, `params: [handle,
 *   memberName | null, ...args]`, `null` meaning "call the handle itself").
 *   Non-function properties of a handler object (such as a provider's `id`
 *   and `capabilities`) travel in the ref's `data`.
 * - A returned `Disposable` is sent as an `RpcHandleRef`; disposing it sends
 *   a `release` message.
 * - Event subscriptions deliver `event` messages tagged with the
 *   subscription's handle id, instead of an `invoke` per call, so that hot
 *   paths (gaze samples, composition changes) need no response.
 * - `CancellationToken` arguments are replaced by `{ $cancellation: <id> }`;
 *   the caller sends `cancel` with the request id to cancel.
 */

/** Wire protocol version. */
export const RPC_VERSION = 1;

/** Method name for host → plugin calls into a handle. */
export const RPC_INVOKE_METHOD = '$invoke';

/** Common envelope fields. */
interface RpcEnvelope {
  readonly protocol: 'forsee-rpc';
  readonly version: 1;
}

/** A call. */
export interface RpcRequest extends RpcEnvelope {
  readonly kind: 'request';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** Successful answer to a request. */
export interface RpcResult extends RpcEnvelope {
  readonly kind: 'result';
  /** The request's id. */
  readonly id: number;
  readonly result: unknown;
}

/** Failed answer to a request. */
export interface RpcErrorResponse extends RpcEnvelope {
  readonly kind: 'error';
  readonly id: number;
  readonly error: ForseeErrorData;
}

/** Asks the other side to stop working on a request. */
export interface RpcCancel extends RpcEnvelope {
  readonly kind: 'cancel';
  readonly id: number;
}

/** One event for a subscription. */
export interface RpcEvent extends RpcEnvelope {
  readonly kind: 'event';
  /** Handle id of the subscription (from the `RpcHandleRef` of the listener). */
  readonly subscription: string;
  readonly payload: unknown;
}

/** Releases a handle (a disposable or a handler object) that is no longer needed. */
export interface RpcRelease extends RpcEnvelope {
  readonly kind: 'release';
  readonly handle: string;
}

/** Sent once by the plugin side when it is ready to receive calls, and by the host in reply. */
export interface RpcHello extends RpcEnvelope {
  readonly kind: 'hello';
  /** `"host"` or the plugin id. */
  readonly from: string;
  readonly apiVersion: number;
}

/** Any message on the channel. */
export type RpcMessage =
  RpcRequest | RpcResult | RpcErrorResponse | RpcCancel | RpcEvent | RpcRelease | RpcHello;

/** Placeholder for a function or handler object that stays in the sender's realm. */
export interface RpcHandleRef {
  /** Opaque id, unique per sender per channel. */
  readonly $handle: string;
  /** Member names that are functions (empty for a bare function). */
  readonly members: readonly string[];
  /** Structured-clone-safe non-function properties of the original object. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Placeholder for a `CancellationToken` argument. */
export interface RpcCancellationRef {
  readonly $cancellation: number;
}
