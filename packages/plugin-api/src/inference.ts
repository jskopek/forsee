import type { CancellationToken } from './common';

/**
 * The host's inference service (plan sections 4 and 6). Models run in native
 * code, never in a web view or a plugin sandbox; plugins reach this through
 * `ForseeApi.inference` with the `inference` permission.
 */

/**
 * What the device can hold (plan section 4, "Capability tiers"):
 * 0 n-gram only, nothing downloaded; 1 keyboard model + small neural voice;
 * 2 adds a 1B-class model on demand; 3 adds a 3–4B model.
 */
export type CapabilityTier = 0 | 1 | 2 | 3;

/** Kinds of model the service can run. */
export type ModelKind = 'language-model' | 'speech-synthesis' | 'speech-recognition';

/** A model known to the service, installed or downloadable. */
export interface ModelDescriptor {
  /** Stable id from the model registry, for example `"typeling-25m-q8"`. */
  readonly id: string;
  readonly name: string;
  readonly kind: ModelKind;
  /** Download size in bytes. */
  readonly sizeBytes: number;
  /** Approximate resident memory when loaded, bytes. */
  readonly memoryBytes: number;
  /** Lowest tier on which the model may be loaded. */
  readonly minTier: CapabilityTier;
  /** SPDX identifier or short name of the weights licence. */
  readonly licence: string;
  readonly installed: boolean;
  readonly loaded: boolean;
}

/** The device's current capability, which can drop (heat, battery). */
export interface InferenceStatus {
  readonly tier: CapabilityTier;
  /** Why the tier is lower than the device's maximum, if it is. */
  readonly reason?: 'thermal' | 'battery' | 'memory' | 'not-measured' | 'unsupported';
}

/** A loaded model. Several clients may share one; it is unloaded when every handle is released. */
export interface ModelHandle {
  /** Opaque, unique per load call. */
  readonly handleId: string;
  readonly modelId: string;
}

/** Request for the next-token distribution after a prompt. */
export interface ScoreRequest {
  readonly handleId: string;
  readonly prompt: string;
  /** Number of most likely tokens to return. */
  readonly topK: number;
  /** Only tokens whose text starts with (or is a prefix of) this string are considered. */
  readonly constraintPrefix?: string;
}

/** One scored token. */
export interface TokenScore {
  /** Decoded token text (may begin with a space). */
  readonly text: string;
  /** Natural-log probability. */
  readonly logProb: number;
}

/** Result of `scoreNextTokens`, sorted by descending `logProb`. */
export interface ScoreResult {
  readonly tokens: readonly TokenScore[];
}

/** Request for free generation. */
export interface GenerateRequest {
  readonly handleId: string;
  readonly prompt: string;
  readonly maxTokens: number;
  /** 0 means greedy. Default 0.7. */
  readonly temperature?: number;
  /** Generation stops before any of these strings. */
  readonly stop?: readonly string[];
}

/** Result of `generate`. */
export interface GenerateResult {
  readonly text: string;
  readonly finishReason: 'stop' | 'length' | 'cancelled';
}

/**
 * The inference service. Every method is asynchronous. Errors reject with a
 * `ForseeErrorData`-shaped error: `unavailable` (tier too low, model not
 * installed), `not-found` (unknown handle), `cancelled`.
 */
export interface InferenceService {
  getStatus(): Promise<InferenceStatus>;
  listModels(): Promise<readonly ModelDescriptor[]>;
  loadModel(modelId: string): Promise<ModelHandle>;
  /** Releases a handle. Unknown or already released handles are ignored. */
  unloadModel(handleId: string): Promise<void>;
  scoreNextTokens(request: ScoreRequest, cancellation?: CancellationToken): Promise<ScoreResult>;
  /** `onToken` receives each piece of text as it is generated. */
  generate(
    request: GenerateRequest,
    onToken?: (text: string) => void,
    cancellation?: CancellationToken,
  ): Promise<GenerateResult>;
}
