import type {
  CapabilityTier,
  InferenceService,
  InferenceStatus,
  ModelDescriptor,
  ModelKind,
} from '@forsee/plugin-api';

/**
 * Contracts of the inference package (B14 implements them; C11 and the
 * shells consume them). The service interface (`InferenceService`) is
 * public and lives in `@forsee/plugin-api` because plugins reach it through
 * `ForseeApi.inference`. Models never run in a web view: implementations
 * live in the desktop shell's utility process (B14) and a Capacitor plugin
 * (D10), exposed through `HostBridge.inference`.
 */

export type {
  CapabilityTier,
  GenerateRequest,
  GenerateResult,
  InferenceService,
  InferenceStatus,
  ModelDescriptor,
  ModelHandle,
  ModelKind,
  ScoreRequest,
  ScoreResult,
  TokenScore,
} from '@forsee/plugin-api';

/** Device facts used to pick a tier. All optional: unknown facts lower the tier. */
export interface DeviceProfile {
  readonly totalMemoryBytes?: number;
  /** Measured keystroke-query latency of the keyboard model on this device, ms (plan: enable only after measurement). */
  readonly measuredLatencyMs?: number;
  readonly thermalState?: 'nominal' | 'fair' | 'serious' | 'critical';
  /** 0..1, and whether charging. */
  readonly battery?: { readonly level: number; readonly charging: boolean };
  readonly os: string;
}

/** Picks the capability tier for a device (plan section 4 table). Pure. */
export type TierDetector = (device: DeviceProfile) => InferenceStatus;

/** A downloadable model as listed in the model catalogue. */
export interface ModelCatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: ModelKind;
  readonly minTier: CapabilityTier;
  /** HTTPS URL of the weights file. */
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly memoryBytes: number;
  /** SPDX id of the weights licence; entries with non-commercial licences are refused by the validator. */
  readonly licence: string;
}

/** Download progress. */
export interface DownloadProgress {
  readonly modelId: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

/**
 * The model registry: what is known, installed and loadable. Weights live
 * outside the profile folder so profiles stay small (plan section 4).
 */
export interface ModelRegistry {
  list(): Promise<readonly ModelDescriptor[]>;
  /** Downloads and verifies (sha256) a model, on the user's request only. */
  install(modelId: string, onProgress?: (progress: DownloadProgress) => void): Promise<void>;
  remove(modelId: string): Promise<void>;
}

/** Signature of the tier-0 stub B14 provides for hosts without native inference. */
export type Tier0InferenceFactory = () => InferenceService;
