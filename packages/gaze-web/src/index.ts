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
export {
  browserPhoneGazeConnector,
  browserViewportPlacement,
  createPhoneGazeSource,
  EngineClockMapper,
  isLoopbackGazeUrl,
  PHONE_GAZE_DEFAULT_URL,
  PHONE_GAZE_PROTOCOL_VERSION,
  phoneGazeUrlFromSearch,
  placementFromWindow,
  reportSelections,
  screenToViewport,
  viewportToScreen,
  type CompositionChangeFeed,
  type LookPointDetails,
  type PhoneGazeConnection,
  type PhoneGazeConnector,
  type PhoneGazeScreen,
  type PhoneGazeSocketHandlers,
  type PhoneGazeSource,
  type PhoneGazeSourceOptions,
  type PhoneGazeStatus,
  type ReportSelectionsOptions,
  type SelectionFeed,
  type TargetLookup,
  type ViewportPlacement,
  type ViewportPlacementProvider,
  type WindowGeometry,
} from './phone-gaze-source';

/** Package name, for diagnostics. */
export const GAZE_WEB_PACKAGE = '@forsee/gaze-web';
