import type { SpeechSettings } from './contracts';

/** Valid range and default of a numeric speech setting. */
export interface SettingLimits {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export const SPEECH_LIMITS = {
  rate: { min: 0.1, max: 10, default: 1 },
  pitch: { min: 0, max: 2, default: 1 },
  volume: { min: 0, max: 1, default: 1 },
} as const satisfies Record<'rate' | 'pitch' | 'volume', SettingLimits>;

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = Object.freeze({
  rate: SPEECH_LIMITS.rate.default,
  pitch: SPEECH_LIMITS.pitch.default,
  volume: SPEECH_LIMITS.volume.default,
});

/** Clamps into the limits; anything that is not a finite number gives the default. */
export function clampSetting(value: unknown, limits: SettingLimits): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Result of validating a settings patch. */
export interface SettingsValidation {
  readonly settings: SpeechSettings;
  /** One human-readable line per value that was invalid or had to be clamped. */
  readonly issues: readonly string[];
}

/**
 * Applies `patch` (untrusted) on top of `base`: numbers are clamped into
 * range, non-numbers are ignored (keeping `base`'s value), blank voice ids
 * and locales clear the preference. Never throws.
 */
export function applySpeechSettings(base: SpeechSettings, patch: unknown): SettingsValidation {
  const issues: string[] = [];
  const source: Record<string, unknown> =
    typeof patch === 'object' && patch !== null ? (patch as Record<string, unknown>) : {};

  const numeric = (key: 'rate' | 'pitch' | 'volume'): number => {
    if (!(key in source) || source[key] === undefined) return base[key];
    const raw = source[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      issues.push(`${key} must be a finite number; kept ${base[key]}`);
      return base[key];
    }
    const clamped = clampSetting(raw, SPEECH_LIMITS[key]);
    if (clamped !== raw) issues.push(`${key} ${raw} clamped to ${clamped}`);
    return clamped;
  };

  const text = (key: 'voiceId' | 'locale'): string | undefined => {
    if (!(key in source)) return base[key];
    const raw = source[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') {
      issues.push(`${key} must be a string; kept previous value`);
      return base[key];
    }
    return raw.trim() === '' ? undefined : raw;
  };

  const voiceId = text('voiceId');
  const locale = text('locale');
  const settings: SpeechSettings = {
    ...(voiceId === undefined ? {} : { voiceId }),
    ...(locale === undefined ? {} : { locale }),
    rate: numeric('rate'),
    pitch: numeric('pitch'),
    volume: numeric('volume'),
  };
  return { settings, issues };
}
