import type { Clock } from '@forsee/core';
import type { CalibrationModel, CalibrationSample } from '@forsee/gaze';
import type { Disposable, GazeSource, Point } from '@forsee/plugin-api';

/**
 * Contracts of the browser-side gaze sources (B2: pointer, tap-only and
 * WebSocket driver sources; B3: webcam). Every source implements
 * `GazeSource` from `@forsee/plugin-api`. This package may use the DOM.
 */

export type { GazeSource } from '@forsee/plugin-api';

// ------------------------------------------------------------------ pointer and tap

/** Options for `createPointerSource` (B2). */
export interface PointerSourceOptions {
  /** Element whose pointer events are observed; coordinates are converted to app viewport CSS pixels. */
  readonly target: EventTarget;
  readonly clock: Clock;
  /**
   * `hover`: continuous pointer movement plus `press` on click (mouse, OS eye
   * control, tracker mouse emulation). `tap`: only `press` samples, for
   * touch and iPad system dwell (plan section 8, tap-only mode).
   */
  readonly mode: 'hover' | 'tap';
}

/** Factory signature B2 provides as `createPointerSource`. */
export type PointerSourceFactory = (options: PointerSourceOptions) => GazeSource;

// ------------------------------------------------------------------ WebSocket driver

/**
 * Options for the WebSocket driver source (B2). Drivers are separate
 * processes speaking a small JSON protocol (documented by B2 in
 * `sidecars/PROTOCOL.md`); this source is the app side of it.
 */
export interface WebSocketSourceOptions {
  /** For example `ws://127.0.0.1:47800`. Only loopback hosts are allowed. */
  readonly url: string;
  readonly clock: Clock;
  /** Source id reported in `GazeSource.id`. */
  readonly id: string;
  /** Reconnect delay after a drop, ms. */
  readonly reconnectMs?: number;
}

/** Factory signature B2 provides as `createWebSocketSource`. */
export type WebSocketSourceFactory = (options: WebSocketSourceOptions) => GazeSource;

// ------------------------------------------------------------------ webcam (B3)

/** One frame's face landmarks, normalised to 0..1 of the video frame. */
export interface FaceLandmarks {
  /** Monotonic ms of the video frame. */
  readonly t: number;
  /** Landmark points (MediaPipe Face Landmarker topology), x/y in 0..1, z relative depth. */
  readonly points: readonly { readonly x: number; readonly y: number; readonly z: number }[];
  /** 4x4 facial transformation matrix (column-major), when the model provides one. */
  readonly transform?: readonly number[];
}

/**
 * Wraps the landmark model (MediaPipe Face Landmarker, Apache-2.0) so the
 * maths can be tested without a camera.
 */
export interface FaceLandmarkEstimator extends Disposable {
  /** Loads the model (WASM, optionally WebGPU). */
  init(): Promise<void>;
  /** Landmarks for one frame, or null when no face is found. */
  estimate(frame: CanvasImageSource, t: number): FaceLandmarks | null;
}

/** Feature vector derived from one frame's landmarks (eye-region geometry, head pose). */
export interface GazeFeatures {
  readonly t: number;
  readonly values: readonly number[];
  /** Head pose in radians, for movement compensation. */
  readonly headPose: { readonly yaw: number; readonly pitch: number; readonly roll: number };
}

/** Turns landmarks into features. Pure. */
export type GazeFeatureExtractor = (landmarks: FaceLandmarks) => GazeFeatures | null;

/** Per-user regression from features to screen position (fitted from calibration). */
export interface GazeRegressor {
  predict(features: GazeFeatures): Point | null;
  fit(
    data: readonly { readonly features: readonly GazeFeatures[]; readonly target: Point }[],
  ): void;
  serialise(): unknown;
  load(data: unknown): boolean;
}

/** Options for `createWebcamSource` (B3). */
export interface WebcamSourceOptions {
  readonly clock: Clock;
  readonly estimator: FaceLandmarkEstimator;
  readonly extractor: GazeFeatureExtractor;
  readonly regressor: GazeRegressor;
  /** Optional post-correction shared with other raw-gaze sources. */
  readonly calibration?: CalibrationModel;
}

/** Factory signature B3 provides as `createWebcamSource`. */
export type WebcamSourceFactory = (options: WebcamSourceOptions) => GazeSource;

export type { CalibrationSample };
