import type { SettingField, SpeakMode } from '@forsee/plugin-api';
import { SPEECH_LIMITS } from '@forsee/speech';

/** Speech settings namespace. */
export const SPEECH_SETTINGS_NAMESPACE = 'app.speech';
/** Layout settings namespace. */
export const LAYOUT_SETTINGS_NAMESPACE = 'app.layout';

const SPEAK_MODES: readonly SpeakMode[] = ['on-demand', 'each-sentence', 'each-word'];

/** `app.speech`: voice, rate, pitch, volume and speak mode. */
export const SPEECH_SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'voiceId',
    label: 'Voice',
    description:
      'Voice id (provider/voice). Empty chooses the default offline voice for the language.',
    type: 'string',
    default: '',
  },
  {
    key: 'rate',
    label: 'Speaking rate',
    type: 'number',
    default: SPEECH_LIMITS.rate.default,
    min: SPEECH_LIMITS.rate.min,
    max: SPEECH_LIMITS.rate.max,
    step: 0.1,
  },
  {
    key: 'pitch',
    label: 'Pitch',
    type: 'number',
    default: SPEECH_LIMITS.pitch.default,
    min: SPEECH_LIMITS.pitch.min,
    max: SPEECH_LIMITS.pitch.max,
    step: 0.1,
  },
  {
    key: 'volume',
    label: 'Volume',
    type: 'number',
    default: SPEECH_LIMITS.volume.default,
    min: SPEECH_LIMITS.volume.min,
    max: SPEECH_LIMITS.volume.max,
    step: 0.1,
  },
  {
    key: 'speakMode',
    label: 'When to speak',
    type: 'select',
    default: 'on-demand',
    options: [
      { label: 'When I select Speak', value: 'on-demand' },
      { label: 'After each sentence', value: 'each-sentence' },
      { label: 'After each word', value: 'each-word' },
    ],
  },
];

/** Narrows a stored value to a speak mode. */
export function speakModeOf(value: unknown): SpeakMode {
  return SPEAK_MODES.find((mode) => mode === value) ?? 'on-demand';
}

/** Settings namespace of the screen itself (feedback and extra input). */
export const UI_SETTINGS_NAMESPACE = 'app.ui';

/**
 * Where the control bar (Speak, Pause, Settings) sits. `auto` is right in
 * landscape and top in portrait.
 */
export type ControlBarSetting = 'auto' | 'right' | 'left' | 'top' | 'bottom';

/** Narrows a stored value to a control bar position setting. */
export function controlBarSettingOf(value: unknown): ControlBarSetting {
  return value === 'right' || value === 'left' || value === 'top' || value === 'bottom'
    ? value
    : 'auto';
}

/** `app.ui`: control bar position, dwell click sound and typing on a physical keyboard. */
export const UI_SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'controlBar',
    label: 'Control bar',
    description:
      'Where Speak, Pause and Settings sit. Automatic puts them on the right in landscape and next to the message in portrait.',
    type: 'select',
    default: 'auto',
    options: [
      { label: 'Automatic', value: 'auto' },
      { label: 'Right', value: 'right' },
      { label: 'Left', value: 'left' },
      { label: 'Top, next to the message', value: 'top' },
      { label: 'Bottom', value: 'bottom' },
    ],
  },
  {
    key: 'clickSound',
    label: 'Click sound',
    description: 'A short click when something is selected.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'physicalKeyboard',
    label: 'Type on a physical keyboard',
    description:
      'Letters, space, Backspace and Enter (speak) on a connected keyboard type into the message.',
    type: 'boolean',
    default: true,
  },
];

/**
 * `app.layout`: which keyboard is in use. (Before the standard layouts
 * became a plugin it also held a `family`; a stored value is kept but no
 * longer read.)
 */
export const LAYOUT_SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'layoutId',
    label: 'Keyboard',
    description:
      'Id of the keyboard in use. Empty, or a keyboard no longer on offer, chooses the default for the language.',
    type: 'string',
    default: '',
  },
];
