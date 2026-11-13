/**
 * Setting schemas. Shape carried over from the prototype's `SettingField`
 * (`keyboard-ui/src/plugins/plugin-types.js`) so the settings screen can be
 * generated and operated by gaze.
 */

/** A value a setting can hold. Settings are always JSON primitives. */
export type SettingValue = string | number | boolean;

/** Field kinds the generated settings screen knows how to render. */
export type SettingType = 'string' | 'number' | 'boolean' | 'select' | 'range';

/** One choice of a `select` setting. */
export interface SettingOption {
  readonly label: string;
  readonly value: SettingValue;
}

/**
 * Schema of one setting.
 *
 * Validation rules (enforced by the core settings registry):
 * - `string`: value is a string.
 * - `number`: finite number, within `min`/`max` when given.
 * - `range`: finite number, `min` and `max` required, and when `step` is given
 *   `(value - min)` is a whole multiple of `step` (tolerance 1e-9).
 * - `boolean`: value is a boolean.
 * - `select`: value equals one option's value. A bare string option `"x"` is
 *   shorthand for `{ label: "x", value: "x" }` (the plan's manifest example uses it).
 * - `default` must itself be valid.
 */
export interface SettingField {
  /** Identifier, unique within its namespace. `[A-Za-z0-9_.-]+`. */
  readonly key: string;
  /** Display label. Required: the generated gaze UI reads it aloud and shows it. */
  readonly label: string;
  readonly type: SettingType;
  /** Help text. */
  readonly description?: string;
  readonly default: SettingValue;
  /** Choices for `select`. */
  readonly options?: readonly (SettingOption | string)[];
  /** Lower bound for `number` / `range` (inclusive). */
  readonly min?: number;
  /** Upper bound for `number` / `range` (inclusive). */
  readonly max?: number;
  /** Step for `range` (and the increment the gaze UI uses for `number`). */
  readonly step?: number;
}

/**
 * Namespace prefix reserved for the app's own settings. Each first-party
 * area registers its own namespace `app.<area>` (`app.general`, `app.gaze`,
 * `app.speech`, `app.prediction`, `app.ui`), because a namespace has exactly
 * one schema. Plugins use their plugin id, which can never start with `app`.
 */
export const APP_SETTINGS_NAMESPACE = 'app';

/** All setting values, grouped by namespace then key. The persisted form of `settings.json`. */
export type SettingsSnapshot = Readonly<Record<string, Readonly<Record<string, SettingValue>>>>;

/** Payload of a settings change event. */
export interface SettingChange {
  readonly namespace: string;
  readonly key: string;
  readonly value: SettingValue;
  /** Value before the change (the default if never set). */
  readonly previous: SettingValue;
}
