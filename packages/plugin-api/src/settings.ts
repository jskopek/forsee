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

  // ---- Metadata for the generated settings screen (all optional) ----

  /**
   * Group shown on the settings screen ("Dwell timing", "Speech"). Fields
   * with the same category are listed together, across namespaces. Plugin
   * fields without one are listed under the plugin's name.
   */
  readonly category?: string;
  /** Position within the category (lower first; default 0, then registration order). */
  readonly order?: number;
  /**
   * Unit of a number, shown next to the value. `ms` values of a second or
   * more are shown in seconds ("1.2 s").
   */
  readonly unit?: SettingUnit;
  /**
   * The range offered on the gaze-operated settings screen. `min`/`max`
   * stay the hard validation bounds (a settings file may go further); the
   * screen never steps outside `safeMin`/`safeMax`. Must lie within
   * `min`/`max`, and the default must lie within it.
   */
  readonly safeMin?: number;
  readonly safeMax?: number;
  /** Extra search words ("speed", "jitter", "tired"). */
  readonly tags?: readonly string[];
  /** Who the setting is for. `advanced` and `therapist` are hidden until "Show advanced settings" is on. Default `everyone`. */
  readonly audience?: SettingAudience;
  /**
   * How much a bad value can hurt. `caution` and `lockout` changes made on
   * the settings screen must be confirmed with the new value in effect
   * ("Keep these settings?"), otherwise they are undone. Default `none`.
   */
  readonly danger?: SettingDanger;
  /** The change only takes effect after a restart (shown next to the control). */
  readonly requiresRestart?: boolean;
  /** Only meaningful while another setting of the same namespace has this value (the control is disabled otherwise). */
  readonly enabledWhen?: SettingCondition;
}

/** Units the settings screen knows how to show. */
export type SettingUnit = 'ms' | 'px' | 'Hz' | '%' | 'x' | 's' | 'min';

/** Who a setting is for. */
export type SettingAudience = 'everyone' | 'advanced' | 'therapist';

/** How much a bad value can hurt (see `SettingField.danger`). */
export type SettingDanger = 'none' | 'caution' | 'lockout';

/** `SettingField.enabledWhen`: another key of the same namespace and the value it must have. */
export interface SettingCondition {
  readonly key: string;
  readonly equals: SettingValue;
}

/** Allowed values of the metadata enums (for validators). */
export const SETTING_UNITS: readonly SettingUnit[] = ['ms', 'px', 'Hz', '%', 'x', 's', 'min'];
export const SETTING_AUDIENCES: readonly SettingAudience[] = ['everyone', 'advanced', 'therapist'];
export const SETTING_DANGERS: readonly SettingDanger[] = ['none', 'caution', 'lockout'];

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

/**
 * Payload of the registry's `committed` event: every effective change made
 * by one operation (`set`, `reset`, `setMany`, `resetMany`, `load`), so a
 * listener can reconfigure once for a preset instead of once per key.
 */
export interface SettingsCommit {
  readonly changes: readonly SettingChange[];
}
