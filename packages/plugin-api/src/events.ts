import type { CompositionChange } from './composition';
import type { ContextChange } from './context';
import type { GazeSample } from './gaze';
import type { FixedPermissionScope } from './manifest';
import type { SettingChange } from './settings';
import type { SpeechEvent } from './speech';
import type { UtteranceRecord } from './storage';

/**
 * Events a plugin can subscribe to with `ForseeApi.events.on`. Payloads are
 * structured-clone-safe. Each event requires the permission listed in
 * `PLUGIN_EVENT_PERMISSIONS`; subscribing without it rejects with
 * `permission-denied`.
 */
export interface ForseeEventMap {
  /** The composition changed. */
  'composition.changed': CompositionChange;
  /**
   * Speech progress for any utterance (start, word boundary, end, error).
   * Without `composition.read`, word boundaries are not delivered and error
   * messages are generic, because they reveal what was said.
   */
  'speech.event': SpeechEvent;
  /** Gaze selection was paused or resumed. */
  'gaze.pauseChanged': { readonly paused: boolean };
  /** Raw (corrected, filtered) gaze samples, at the source rate. */
  'gaze.sample': GazeSample;
  /** One of this plugin's own settings changed. */
  'settings.changed': SettingChange;
  /** A context store entry changed. */
  'context.changed': ContextChange;
  /** An utterance was appended to the conversation history. */
  'history.appended': UtteranceRecord;
}

/** Name of a plugin-visible event. */
export type ForseeEventType = keyof ForseeEventMap;

/** Permission needed to subscribe to each event; `null` means none. */
export const PLUGIN_EVENT_PERMISSIONS: Readonly<
  Record<ForseeEventType, FixedPermissionScope | null>
> = {
  'composition.changed': 'composition.read',
  'speech.event': null,
  'gaze.pauseChanged': null,
  'gaze.sample': 'gaze.read',
  'settings.changed': null,
  'context.changed': 'context.read',
  'history.appended': 'history.read',
};
