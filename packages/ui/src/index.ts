/**
 * @forsee/ui — the trusted host UI (work package B8): the provider of
 * `HostUiServices` and its hooks, `GazeTarget`, the keyboard view and its
 * activation adapter, composition bar, prediction strip, action bar pieces,
 * pause overlay, app frame, dwell click sound and the Tailwind preset
 * (`@forsee/ui/tailwind-preset`). Contracts are in `contracts.ts`; test
 * helpers are in `@forsee/ui/testing`.
 */
export * from './contracts';
export { createActivationAdapter } from './activation-adapter';
export {
  DwellSpeedControls,
  PauseButton,
  SpeakButton,
  StopSpeakingButton,
  type DwellSpeedControlsProps,
  type PauseButtonProps,
  type SpeakButtonProps,
  type StopSpeakingButtonProps,
} from './action-bar';
export {
  AppFrame,
  appFrameGrid,
  marginRestZones,
  type AppFrameGridOptions,
  type AppFrameProps,
} from './app-frame';
export {
  ChoiceGroup,
  StepperControl,
  ToggleTarget,
  type Choice,
  type ChoiceGroupProps,
  type StepperControlProps,
  type ToggleTargetProps,
} from './choices';
export { useMediaQuery, type MatchMediaLike } from './media-query';
export { NoticeCard, type NoticeAction, type NoticeCardProps } from './notice';
export { PhraseBar, type PhraseBarProps, type PhraseTile } from './phrase-bar';
export { Sheet, type SheetProps } from './sheet';
export {
  browserAudioContextFactory,
  createClickSound,
  useClickSound,
  type AudioContextFactory,
  type AudioContextLike,
  type ClickSound,
  type ClickSoundOptions,
  type UseClickSoundOptions,
} from './click-sound';
export { CompositionBar, type CompositionBarProps } from './composition-bar';
export {
  MeasuredRectStore,
  browserDomEnvironment,
  measureElement,
  observeElement,
  sameRect,
  type UiDomEnvironment,
} from './dom';
export { GazeEventHub } from './gaze-hub';
export { GazeTarget, type GazeTargetComponentProps } from './gaze-target';
export { ICON_NAMES, Icon, hasIcon, type IconProps } from './icons';
export { KeyboardView, fitFontPx, keyAppearance, stepLabel } from './keyboard-view';
export { PauseOverlay, type PauseOverlayProps } from './pause-overlay';
export {
  PredictionFeed,
  type PredictionFeedOptions,
  type PredictionSnapshot,
} from './prediction-feed';
export { PredictionStrip, predictionTargetId, type PredictionStripProps } from './prediction-strip';
export {
  HostUiProvider,
  OcclusionStore,
  OverlayScopeContext,
  useComposition,
  useDwellProgress,
  useEngaged,
  useEngagedTargetId,
  useGazePaused,
  useHostServices,
  useHostUi,
  useOccluded,
  usePrediction,
  useSetting,
  type HostUiContextValue,
  type HostUiProviderProps,
} from './provider';
export { TargetHandles, diffDescriptors, useTargetRegistrations } from './registration';
export { restDescriptor, useRestZone } from './rest-zone';
export { FIRED_FLASH_MS, applyProgress, type TargetAppearance } from './target-face';
export { contrastRatio, relativeLuminance } from './theme/contrast';
export { useMeasuredRect, type MeasureRef } from './use-measured-rect';

/** Package name, for diagnostics. */
export const UI_PACKAGE = '@forsee/ui';
