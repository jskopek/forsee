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

/**
 * A minimal DOM event as the pointer sources see it. A real `PointerEvent`
 * satisfies it structurally; tests build plain objects.
 */
export interface PointerEventLike {
  readonly type: string;
  /** `mouse`, `pen` or `touch`; treated as `mouse` when missing. */
  readonly pointerType?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  /** Button that changed; 0 is the primary button (or touch/pen contact). */
  readonly button?: number;
  /** False for the second and later fingers of a multi-touch gesture. */
  readonly isPrimary?: boolean;
  /** Event time in the page's own time base; only differences between events are used. */
  readonly timeStamp?: number;
  /** For `pointerout`/`pointerleave`: where the pointer went; null or missing means out of the document. */
  readonly relatedTarget?: unknown;
  /** For `click`: 0 for clicks that did not come from a pointer (keyboard, assistive technology). */
  readonly detail?: number;
  /** Intermediate positions of a `pointermove` batch, oldest first, when the browser supports it. */
  getCoalescedEvents?(): readonly PointerEventLike[];
}

/** The part of `EventTarget` (document, window) the sources need. */
export interface InputEventTarget {
  addEventListener(
    type: string,
    listener: (event: PointerEventLike) => void,
    options?: boolean | { readonly capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: PointerEventLike) => void,
    options?: boolean | { readonly capture?: boolean },
  ): void;
}

/**
 * Everything the pointer and tap sources need from the browser, so they run
 * in Node tests. `createBrowserPointerEnvironment` is the real one and the
 * default; `FakePointerEnvironment` (from `@forsee/gaze-web/testing`) the fake.
 */
export interface PointerEnvironment {
  /** Receives pointer events, `click` and `visibilitychange`. */
  readonly document: InputEventTarget;
  /** Receives `blur`. */
  readonly window: InputEventTarget;
  /** False when the browser has no Pointer Events. */
  supportsPointerEvents(): boolean;
  /** App viewport size, CSS pixels; coordinates outside `0..width` x `0..height` are not inside the app. */
  viewport(): { readonly width: number; readonly height: number };
  /** False while the page is hidden (background tab, minimised). */
  isVisible(): boolean;
}

/** Options for `createPointerSource` (B2). */
export interface PointerSourceOptions {
  readonly clock: Clock;
  /** Defaults to the real browser (`createBrowserPointerEnvironment()`). */
  readonly environment?: PointerEnvironment;
  /**
   * Interval of the keep-alive repeat while the pointer rests inside the
   * viewport, ms (default 50). 0 turns it off.
   */
  readonly keepAliveMs?: number;
  /** Movements shorter than this many px from the last emitted position are dropped (default 0). */
  readonly minMovePx?: number;
  /** Treat touch as a moving pointer (default false: touch belongs to the tap source). */
  readonly touch?: boolean;
}

/** Factory signature B2 provides as `createPointerSource`. */
export type PointerSourceFactory = (options: PointerSourceOptions) => GazeSource;

/** Options for `createTapSource` (B2). */
export interface TapSourceOptions {
  readonly clock: Clock;
  /** Defaults to the real browser. */
  readonly environment?: PointerEnvironment;
}

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
