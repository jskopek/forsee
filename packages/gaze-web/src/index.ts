/**
 * @forsee/gaze-web — browser gaze sources: pointer, tap-only, WebSocket
 * driver (work package B2) and webcam (B3). Contracts are in `contracts.ts`.
 * Test doubles for the pointer sources are in `@forsee/gaze-web/testing`.
 */
export * from './contracts';
export { createBrowserPointerEnvironment } from './environment';
export { createPointerSource, DEFAULT_KEEP_ALIVE_MS } from './pointer-source';
export { createTapSource } from './tap-source';
export {
  createAutoPointerSource,
  selectionMethodForMode,
  type AutoPointerSource,
  type AutoPointerSourceOptions,
  type InputMode,
} from './auto-source';

/** Package name, for diagnostics. */
export const GAZE_WEB_PACKAGE = '@forsee/gaze-web';
