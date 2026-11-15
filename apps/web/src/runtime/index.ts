/**
 * The Forsee application runtime: one call boots everything behind the
 * screen (storage, kernel, speech, prediction, plugins, gaze, layout) and
 * returns what the UI layer needs. No React here.
 *
 * ```ts
 * const runtime = await createForseeRuntime();
 * root.render(<ForseeProvider services={runtime.hostUi}>…</ForseeProvider>);
 * ```
 */
export { browserAudioPlayer, browserLifecycle, browserSpeechSynthesis } from './browser';
export { createForseeRuntime, DWELL_FASTER_COMMAND, DWELL_SLOWER_COMMAND } from './create-runtime';
export { defaultFirstPartyPlugins } from './first-party';
export { BUNDLED_ENGLISH_MODEL_URL, fetchLanguageModel } from './language-model';
export { PLUGIN_CONSENT_PATH, PLUGIN_INSTALL_PATH } from './profile-storage';
export {
  LAYOUT_SETTING_FIELDS,
  LAYOUT_SETTINGS_NAMESPACE,
  SPEECH_SETTING_FIELDS,
  SPEECH_SETTINGS_NAMESPACE,
  UI_SETTING_FIELDS,
  UI_SETTINGS_NAMESPACE,
} from './settings';
export type * from './types';
